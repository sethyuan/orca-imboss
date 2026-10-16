import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@shared/constants/paged";
import type { InstalledSkill, PageQuery, PageResult } from "@shared/types";
import { cpSync, existsSync, mkdirSync, statSync } from "fs";
import { readdir, readFile, rm } from "fs/promises";
import { join, resolve } from "path";
import { getAgentSkillsDir } from "../data-dir";
import { isBuiltinSkillName } from "./builtin-skills";

/**
 * Install / uninstall of skills under `~/.imboss/agent/skills/<name>/`.
 * A valid skill folder contains a `SKILL.md` (Agent Skills standard).
 * Local-folder import is handled here; archives and links go through
 * `src/main/skill-import.ts`, which stages them for review first.
 */

export const SKILL_FILE = "SKILL.md";

const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export async function listSkills(): Promise<InstalledSkill[]> {
  let entries: string[];
  try {
    entries = await readdir(getAgentSkillsDir());
  } catch {
    return [];
  }
  const installed: InstalledSkill[] = [];
  for (const name of entries) {
    if (!SAFE_NAME_RE.test(name)) continue;
    const dir = resolve(getAgentSkillsDir(), name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const skillFile = join(dir, SKILL_FILE);
      if (!existsSync(skillFile)) continue;
      installed.push({
        name,
        description: (await readSkillMetadata(skillFile)).description,
      });
    } catch {
      continue;
    }
  }
  return installed.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One page of installed skills, ordered `name ASC` (unchanged from the full
 * list). Source is the SKILL.md folder (not SQLite), so the page is derived
 * from the in-memory array: filter (`LIKE`-style substring on `name OR
 * description`), seek past the cursor name, then slice. Cursor = the last
 * row's `name` (skill names are `[A-Za-z0-9._-]+`, so raw embedding is safe).
 */
export async function listSkillsPage(
  page: PageQuery = {},
): Promise<PageResult<InstalledSkill>> {
  const limit = Math.min(
    Math.max(Math.trunc(page.limit ?? DEFAULT_PAGE_SIZE), 1),
    MAX_PAGE_SIZE,
  );
  const needle = (page.query ?? "").trim().toLowerCase();
  const all = await listSkills();

  let start = 0;
  if (page.cursor) {
    // `localeCompare` mirrors the sort order of `listSkills`.
    const cursor = page.cursor;
    start = all.findIndex((skill) => skill.name.localeCompare(cursor) > 0);
    if (start < 0) start = all.length;
  }

  const selected =
    needle.length === 0
      ? all.slice(start)
      : all
          .slice(start)
          .filter(
            (skill) =>
              skill.name.toLowerCase().includes(needle) ||
              (skill.description ?? "").toLowerCase().includes(needle),
          );

  const hasMore = selected.length > limit;
  const items = selected.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? last.name : null,
    hasMore,
  };
}

/**
 * Import one local folder as a skill. Best-effort: the folder is skipped
 * (returns `null`) when it is not a directory, has no `SKILL.md`, has a
 * missing/invalid `name` in the SKILL.md frontmatter, is already installed,
 * or fails to copy — never throws for a single invalid folder.
 *
 * The installed skill name comes from the SKILL.md `name` frontmatter (the
 * Agent Skills standard); a folder is skipped rather than falling back to
 * its folder name when that field is missing/invalid.
 */
export async function installSkillFromFolder(
  sourcePath: string,
): Promise<string | null> {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) return null;
  const src = resolve(sourcePath);
  try {
    if (!statSync(src).isDirectory()) return null;
  } catch {
    return null;
  }

  const skillFile = join(src, SKILL_FILE);
  if (!existsSync(skillFile)) return null;

  const metadata = await readSkillMetadata(skillFile);
  const name = metadata.name;
  if (!name || !isValidSkillName(name)) return null;

  const root = getAgentSkillsDir();
  mkdirSync(root, { recursive: true });
  // `name` has no separators (SAFE_NAME_RE), so join() stays inside the root.
  const dest = join(resolve(root), name);
  if (existsSync(dest)) return null;

  try {
    cpSync(src, dest, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } catch {
    return null;
  }
  return name;
}

/**
 * Import several local folders in one pass (best-effort). Returns the names
 * of the skills that were actually installed; invalid/already-installed
 * folders are silently skipped.
 */
export async function installSkillsFromFolders(
  paths: string[],
): Promise<string[]> {
  const installed: string[] = [];
  for (const path of paths) {
    const name = await installSkillFromFolder(path);
    if (name) installed.push(name);
  }
  return installed;
}

export async function uninstallSkill(name: string): Promise<void> {
  if (!isValidSkillName(name)) {
    throw new Error("Invalid skill name.");
  }
  if (isBuiltinSkillName(name)) {
    throw new Error("Built-in skills cannot be removed.");
  }
  const root = resolve(getAgentSkillsDir());
  const dest = resolve(root, name);
  // Containment: only ever delete direct children of the skills root.
  if (dest !== join(root, name)) {
    throw new Error("Refusing to delete outside the skills folder.");
  }
  await rm(dest, { recursive: true, force: true });
}

export function isValidSkillName(name: string): boolean {
  return SAFE_NAME_RE.test(name);
}

/**
 * Best-effort extraction of `name:` and `description:` from SKILL.md YAML
 * frontmatter. Purely informational (list UI); malformed files simply yield
 * `null` rather than failing.
 */
async function readSkillMetadata(skillFilePath: string): Promise<{
  name: string | null;
  description: string | null;
}> {
  try {
    return parseSkillMetadata(
      (await readFile(skillFilePath, "utf8")).slice(0, 4096),
    );
  } catch {
    return { name: null, description: null };
  }
}

/** Same parse as `readSkillMetadata`, for SKILL.md text already in hand. */
export function parseSkillMetadata(text: string): {
  name: string | null;
  description: string | null;
} {
  const head = text.slice(0, 4096);
  const nameMatch = /^name:\s*(.+)$/m.exec(head);
  const descMatch = /^description:\s*(.+)$/m.exec(head);
  const clean = (raw: string | undefined): string | null =>
    raw ? raw.trim().replace(/^["']|["']$/g, "") : null;
  const name = clean(nameMatch?.[1]);
  const description = clean(descMatch?.[1]);
  return {
    name: name && name.length > 0 ? name : null,
    description:
      description && description.length > 0 ? description.slice(0, 500) : null,
  };
}
