import { SKILL_ARCHIVE_MAX_BYTES } from "@shared/constants/skills";
import type { SkillFileInfo, SkillPreview } from "@shared/types";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "path";
import { isBuiltinSkillName } from "./agent/builtin-skills";
import {
  isValidSkillName,
  parseSkillMetadata,
  SKILL_FILE,
} from "./agent/skills";
import { getAgentSkillsDir } from "./data-dir";
import { readZipEntries, type ZipEntry } from "./zip";

/**
 * Importing a skill from a link or an archive.
 *
 * Nothing is written to `~/.imboss/agent/skills` until the boss has seen what
 * arrived: a link is downloaded, unpacked, and held in memory as a *preview*
 * (name, description, every file, its size, and whether anything in it looks
 * executable). `commitSkillInstall` is the only function that touches the
 * skills folder, so cancelling the dialog leaves no trace on disk.
 *
 * Links may point at a `.zip`, a `SKILL.md`, or a GitHub repository / folder
 * (rewritten to the zipball codeload serves). Local folders keep using the
 * plain copy path in `src/main/agent/skills.ts`.
 */

const FETCH_TIMEOUT_MS = 60_000;
const MAX_SKILLS_PER_IMPORT = 20;

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".command",
  ".py",
  ".pyw",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".rb",
  ".pl",
  ".php",
  ".ps1",
  ".bat",
  ".cmd",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".jar",
]);

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".csv",
  ".tsv",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".svg",
  ".tex",
]);

/** Where a link points, after GitHub URLs are translated. */
export interface SkillSource {
  /** The link as typed (for display). */
  label: string;
  /** What is actually fetched. */
  archiveUrl: string;
  /** Folder inside the archive to look in (`owner/repo/tree/<ref>/<path>`). */
  subpath: string | null;
}

/** A skill held in memory between `inspect` and `commit`. */
interface StagedSkill {
  name: string;
  description: string | null;
  source: string;
  files: { path: string; data: Buffer }[];
}

/** The one batch waiting for review; a new import replaces it. */
let staged = new Map<string, StagedSkill>();

/**
 * Translate a link into something fetchable. GitHub repository and folder
 * links become the zipball codeload serves (including the `HEAD` ref, so the
 * default branch needs no lookup), `blob` links become the raw file, and
 * anything else is fetched as given.
 */
export function resolveSkillSource(raw: string): SkillSource {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("A link is required.");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("That is not a valid link.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https links can be imported.");
  }

  if (GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) {
    const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/, "");
      const marker = parts[2];
      const rest = parts.slice(3);
      const ref = rest[0] ?? "HEAD";
      if (marker === "blob" && rest.length >= 2) {
        return {
          label: trimmed,
          archiveUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}`,
          subpath: null,
        };
      }
      return {
        label: trimmed,
        archiveUrl: `https://codeload.github.com/${owner}/${repo}/zip/${marker === "tree" ? ref : "HEAD"}`,
        subpath:
          marker === "tree" && rest.length > 1 ? rest.slice(1).join("/") : null,
      };
    }
  }

  return { label: trimmed, archiveUrl: trimmed, subpath: null };
}

/** Fetch a link, unpack whatever came back, and stage the skills found. */
export async function fetchSkillUrl(raw: string): Promise<SkillPreview[]> {
  const source = resolveSkillSource(raw);
  const { bytes, contentType } = await download(source.archiveUrl);

  if (looksLikeZip(bytes, contentType)) {
    return stageArchive(bytes, source.subpath, source.label);
  }

  const text = bytes.toString("utf8");
  const named = basename(new URL(source.archiveUrl).pathname).toLowerCase();
  if (named === SKILL_FILE.toLowerCase() || /^---\s*\r?\n/.test(text)) {
    return stageSingleFile(text, source.label);
  }
  throw new Error("That link is not a zip archive or a SKILL.md.");
}

/** Read a picked `.zip` and stage the skills in it. */
export async function previewSkillArchiveFile(
  path: string,
): Promise<SkillPreview[]> {
  const source = resolve(path);
  let bytes: Buffer;
  try {
    bytes = await readFile(source);
  } catch {
    throw new Error(`Could not read ${source}.`);
  }
  return stageArchive(bytes, null, source);
}

/**
 * Install the staged skills the boss approved. Only names that are still
 * staged are installed; an existing skill of the same name is replaced.
 */
export async function commitSkillInstall(ids: string[]): Promise<string[]> {
  const installed: string[] = [];
  const root = resolve(getAgentSkillsDir());
  for (const id of ids) {
    const skill = staged.get(id);
    if (!skill) continue;
    if (!isValidSkillName(skill.name)) {
      throw new Error("Invalid skill name.");
    }
    if (isBuiltinSkillName(skill.name)) {
      throw new Error("Built-in skills cannot be replaced.");
    }
    // `name` has no separators (SAFE_NAME_RE), so this stays inside the root.
    const dest = resolve(root, skill.name);
    if (dest !== join(root, skill.name)) {
      throw new Error("Refusing to write outside the skills folder.");
    }
    mkdirSync(root, { recursive: true });
    if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
    for (const file of skill.files) {
      const target = join(dest, file.path);
      if (!resolve(target).startsWith(dest + sep)) {
        throw new Error(
          `Refusing to write outside the skill folder: ${file.path}`,
        );
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.data);
    }
    staged.delete(id);
    installed.push(skill.name);
  }
  return installed;
}

/** Forget a staged skill (the boss cancelled, or the app is closing). */
export function discardSkillInstall(ids?: string[]): void {
  if (ids === undefined) {
    staged = new Map();
    return;
  }
  for (const id of ids) staged.delete(id);
}

/**
 * Unpack an archive, find every skill folder in it (a folder holding a
 * `SKILL.md`), and stage each one for review.
 */
function stageArchive(
  bytes: Buffer,
  subpath: string | null,
  label: string,
): SkillPreview[] {
  const all = readZipEntries(bytes);

  let entries = all;
  if (subpath !== null) {
    const prefix = `${subpath.replace(/\/+$/, "")}/`;
    entries = all
      .filter((entry) => entry.path.startsWith(prefix))
      .map((entry) => ({
        path: entry.path.slice(prefix.length),
        data: entry.data,
      }));
    if (entries.length === 0) {
      throw new Error(`That folder is not in the archive: ${subpath}`);
    }
  }

  const roots = skillRoots(entries);
  if (roots.length === 0) {
    throw new Error("That archive does not contain a SKILL.md.");
  }
  if (roots.length > MAX_SKILLS_PER_IMPORT) {
    throw new Error(
      `That archive holds ${roots.length} skills; import a folder instead.`,
    );
  }

  staged = new Map();
  const previews: SkillPreview[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const files = entries
      .filter((entry) =>
        root.length === 0
          ? true
          : entry.path.startsWith(`${root}/`) &&
            entry.path.length > root.length + 1,
      )
      .map((entry) => ({
        path:
          root.length === 0 ? entry.path : entry.path.slice(root.length + 1),
        data: entry.data,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    previews.push(stageOne(files, label, seen));
  }
  return previews;
}

/** Stage a lone SKILL.md fetched from a link. */
function stageSingleFile(text: string, label: string): SkillPreview[] {
  staged = new Map();
  return [
    stageOne(
      [{ path: SKILL_FILE, data: Buffer.from(text, "utf8") }],
      label,
      new Set(),
    ),
  ];
}

/**
 * Turn one skill folder into a preview and (when it is installable) into a
 * staged skill. `seen` carries the names already staged in this batch so a
 * clash is reported rather than silently replacing.
 */
function stageOne(
  files: { path: string; data: Buffer }[],
  source: string,
  seen: Set<string>,
): SkillPreview {
  const skillFile = files.find(
    (file) => file.path.toLowerCase() === SKILL_FILE.toLowerCase(),
  );
  const metadata = parseSkillMetadata(
    skillFile ? skillFile.data.toString("utf8") : "",
  );
  const name = metadata.name;
  const info: SkillFileInfo[] = files.map((file) => ({
    path: file.path,
    size: file.data.length,
    kind: fileKind(file.path, file.data),
  }));
  const totalBytes = info.reduce((sum, file) => sum + file.size, 0);
  const scripts = info
    .filter((file) => file.kind === "script")
    .map((file) => file.path);

  let problem: string | null = null;
  if (!name || !isValidSkillName(name)) {
    problem = "The SKILL.md has no usable name.";
  } else if (isBuiltinSkillName(name)) {
    problem = "That name belongs to a built-in skill.";
  } else if (seen.has(name)) {
    problem = "Two skills in this import use the same name.";
  }

  const replaces = name !== null && existsSync(join(getAgentSkillsDir(), name));
  const preview: SkillPreview = {
    id: problem === null ? randomUUID() : "",
    name: name ?? "—",
    description: metadata.description,
    source,
    files: info,
    totalBytes,
    scripts,
    replaces,
    problem,
  };
  if (problem === null && name !== null) {
    seen.add(name);
    staged.set(preview.id, {
      name,
      description: metadata.description,
      source,
      files,
    });
  }
  return preview;
}

/**
 * The folders that hold a `SKILL.md`, shallowest first and never nested in
 * one another: a repo whose root is itself a skill yields one skill, not one
 * per subfolder.
 */
function skillRoots(entries: ZipEntry[]): string[] {
  const roots: string[] = [];
  for (const entry of entries) {
    if (basename(entry.path).toLowerCase() !== SKILL_FILE.toLowerCase())
      continue;
    const root = dirname(entry.path);
    roots.push(root === "." ? "" : root);
  }
  const unique = [...new Set(roots)].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const root of unique) {
    if (
      kept.some((parent) => root === parent || root.startsWith(`${parent}/`))
    ) {
      continue;
    }
    kept.push(root);
  }
  return kept.sort((a, b) => a.localeCompare(b));
}

function fileKind(path: string, data: Buffer): SkillFileInfo["kind"] {
  const extension = extname(path).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(extension)) return "script";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (extension.length === 0 && data.subarray(0, 2).toString("utf8") === "#!") {
    return "script";
  }
  return "other";
}

function looksLikeZip(bytes: Buffer, contentType: string): boolean {
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) return true;
  return (
    /application\/(zip|x-zip-compressed|octet-stream)/.test(contentType) &&
    bytes.length >= 4
  );
}

/** Fetch a link with the app's proxy-aware `fetch`, capped and timed out. */
async function download(
  url: string,
): Promise<{ bytes: Buffer; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new Error("The download timed out.");
      }
      throw new Error("Could not reach that link.");
    }
    if (!response.ok) {
      throw new Error(`The download failed (HTTP ${response.status}).`);
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > SKILL_ARCHIVE_MAX_BYTES) {
      throw new Error(tooBigMessage());
    }
    const bytes = await readCapped(response, SKILL_ARCHIVE_MAX_BYTES);
    return {
      bytes,
      contentType: response.headers.get("content-type") ?? "",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(tooBigMessage());
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function tooBigMessage(): string {
  const mb = Math.round(SKILL_ARCHIVE_MAX_BYTES / (1024 * 1024));
  return `That file is larger than ${mb} MB.`;
}
