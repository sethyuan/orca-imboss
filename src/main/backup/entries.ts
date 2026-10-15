import { existsSync, lstatSync, readdirSync } from "fs";
import { join } from "path";
import { getAgentSkillsDir, getDataRoot, getMiniAppsDir } from "../data-dir";

/**
 * What a backup contains, expressed as an allow-list: everything below is
 * copied, everything else under the data folder is left out. That keeps
 * regenerated artifacts (the code-shipped built-in skills, the model-catalog
 * cache, the database's WAL sidecars, the dev CSV export folder) out by
 * construction instead of by a list of exceptions that can drift.
 */
const DIRECTORIES = [
  "avatars",
  "attachments",
  "mini-apps",
  "workdir",
  "agent/skills",
  "agent/sessions",
  "integrations/media",
] as const;

/**
 * Files holding credentials. They are only included when the user explicitly
 * opts in: `agent/auth.json` holds provider API keys, `agent/models.json` may
 * carry a key for a custom provider, `integrations.json` holds IM bot tokens.
 */
const CREDENTIAL_FILES = [
  "agent/auth.json",
  "agent/models.json",
  "integrations.json",
] as const;

/** Archive path of the database snapshot (written from a live backup, not the file). */
export const DB_ARCHIVE_PATH = "db/imboss.db";

/** One file to store: `rel` is its `/`-separated path inside the archive. */
export interface BackupEntry {
  rel: string;
  abs: string;
  /** True when the file is a credential file (see `CREDENTIAL_FILES`). */
  credentials: boolean;
}

/**
 * Enumerate the files a backup should carry, in a stable order. Credential
 * files are only listed when `includeCredentials` is set.
 */
export function collectBackupEntries(
  includeCredentials: boolean,
): BackupEntry[] {
  const root = getDataRoot();
  const entries: BackupEntry[] = [];

  for (const rel of DIRECTORIES) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    walk(abs, rel, entries, false);
  }

  if (includeCredentials) {
    for (const rel of CREDENTIAL_FILES) {
      const abs = join(root, rel);
      if (existsSync(abs)) entries.push({ rel, abs, credentials: true });
    }
  }

  return entries;
}

/**
 * Number of sub-folders directly inside `dir` (0 when it does not exist).
 * Folders are what the app enumerates: one per skill (`SKILL.md` inside) and
 * one per Mini App (`metadata.json` inside), so a stray file such as the
 * Mini Apps `index.json` ordering file is not counted as content.
 */
export function countDirectories(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    ).length;
  } catch {
    return 0;
  }
}

/** Skills and Mini Apps are counted as directories on disk, not table rows. */
export function countUserSkills(): number {
  return countDirectories(getAgentSkillsDir());
}

export function countMiniApps(): number {
  return countDirectories(getMiniAppsDir());
}

/**
 * Recurse into `absDir`, appending regular files. Symbolic links are skipped:
 * a link pointing outside the data folder (or back into it) would otherwise
 * duplicate data or loop.
 */
function walk(
  absDir: string,
  relDir: string,
  out: BackupEntry[],
  credentials: boolean,
): void {
  let names: string[];
  try {
    names = readdirSync(absDir);
  } catch {
    return;
  }
  for (const name of names) {
    const abs = join(absDir, name);
    const rel = `${relDir}/${name}`;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(abs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walk(abs, rel, out, credentials);
    } else if (stat.isFile()) {
      out.push({ rel, abs, credentials });
    }
  }
}
