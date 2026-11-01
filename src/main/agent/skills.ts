import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@shared/constants/paged";
import { t } from "@shared/l10n";
import type {
  InstalledSkill,
  InstalledSkillSource,
  PageQuery,
  PageResult,
} from "@shared/types";
import { cpSync, existsSync, mkdirSync, statSync } from "fs";
import { readdir, readFile, rm } from "fs/promises";
import { join, resolve } from "path";
import { getAgentSkillsDir, getAgentsSkillsDir } from "../data-dir";
import { isBuiltinSkillName } from "./builtin-skills";
import { parseSkillFrontmatter } from "./skill-metadata";

/**
 * Skill discovery for `~/.imboss/agent/skills/<name>/` (the app's own folder,
 * install/uninstall target) plus `~/.agents/skills/<name>/` (a shared, external
 * folder owned by other agent tools, read-only here).
 *
 * The two roots are **unioned by name**, the app's own copy winning — which is
 * exactly the order the Pi SDK loads them in, so the name a session resolves is
 * always the name the UI showed. A valid skill folder contains a `SKILL.md`
 * (Agent Skills standard). Local-folder import only this iteration (confirmed
 * scope).
 */

const SKILL_FILE = "SKILL.md";

const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Skills roots in priority order (the app's own folder always wins). */
function skillRoots(): Array<{ root: string; source: InstalledSkillSource }> {
  return [
    { root: getAgentSkillsDir(), source: "imboss" },
    { root: getAgentsSkillsDir(), source: "agents" },
  ];
}

export async function listSkills(): Promise<InstalledSkill[]> {
  const byName = new Map<string, InstalledSkill>();
  // Roots are scanned in priority order and the first copy of a name wins, so
  // an external skill can never shadow one the app owns.
  for (const { root, source } of skillRoots()) {
    for (const skill of await scanSkillsRoot(root, source)) {
      if (byName.has(skill.name)) continue;
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every skill folder directly under `root` that contains a `SKILL.md`.
 *
 * Best-effort by design: a missing/unreadable root yields `[]` (the external
 * root usually does not exist), and an invalid/vanishing entry is skipped
 * rather than failing the whole listing.
 */
async function scanSkillsRoot(
  root: string,
  source: InstalledSkillSource,
): Promise<InstalledSkill[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const found: InstalledSkill[] = [];
  for (const name of entries) {
    if (!SAFE_NAME_RE.test(name)) continue;
    // Built-in skills are app-owned (own folder, own generated prompt) and must
    // never be listed as user skills nor shadowed by a same-named folder.
    if (isBuiltinSkillName(name)) continue;
    const dir = resolve(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const skillFile = join(dir, SKILL_FILE);
      if (!existsSync(skillFile)) continue;
      found.push({
        name,
        description: (await readSkillMetadata(skillFile)).description,
        source,
      });
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * Absolute folder of an installed skill, or `null` when no root provides it.
 *
 * Roots are searched in the same priority order as `listSkills`, so the result
 * is the copy that a session actually loads. Shared with the capability-
 * reference oracle and the employee transfer code, which must agree with the
 * list the UI shows.
 */
export function resolveSkillDir(name: string): string | null {
  // `SAFE_NAME_RE` accepts `.`/`..`, which must never probe outside a root.
  if (!isValidSkillName(name) || name === "." || name === "..") return null;
  for (const { root } of skillRoots()) {
    const dir = join(root, name);
    if (existsSync(join(dir, SKILL_FILE))) return dir;
  }
  return null;
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
 * missing/invalid `name` in the SKILL.md frontmatter, is already installed in
 * the app's own folder, or fails to copy — never throws for a single invalid
 * folder.
 *
 * The installed skill name comes from the SKILL.md `name` frontmatter (the
 * Agent Skills standard); a folder is skipped rather than falling back to
 * its folder name when that field is missing/invalid.
 *
 * Only the app's own folder is a target: a same-named skill that exists solely
 * in the read-only external folder is not an obstacle, the new copy in the
 * app's folder simply takes precedence over it (same rule as `listSkills`).
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

/**
 * Remove a skill from the app's own folder.
 *
 * Throws when the name is only provided by the read-only external folder: the
 * app must not delete another tool's skill, and silently doing nothing would
 * look like a broken button.
 */
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
  if (!existsSync(join(dest, SKILL_FILE)) && resolveSkillDir(name) !== null) {
    throw new Error(
      t(
        "“${name}” is read from ~/.agents/skills; it can only be edited there.",
        { name },
      ),
    );
  }
  await rm(dest, { recursive: true, force: true });
}

/**
 * True when `name` is a legal user skill folder name (`SAFE_NAME_RE`). Shared
 * with the employee import/export code, which must apply the same rule to
 * archive members and destination folders.
 */
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
    const head = (await readFile(skillFilePath, "utf8")).slice(0, 4096);
    return parseSkillFrontmatter(head);
  } catch {
    return { name: null, description: null };
  }
}
