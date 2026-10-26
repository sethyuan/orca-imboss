import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve, sep } from "path";
import { getDataRoot, getWorkDir } from "./data-dir";

/**
 * Minimal server-side directory browsing, for the one thing a remote client
 * genuinely cannot do for itself: pick a path on the *backend* machine.
 *
 * Deliberately not a file manager — the remote counterpart of the native
 * "choose a folder" dialog, and nothing more:
 * - lists **directories only** (every flow that needs a path needs a folder:
 *   working directory, skill folders, an attached folder for the agent),
 * - returns absolute paths, so the caller never builds a path from parts,
 * - creates one folder when the user asks for it.
 *
 * There is no confinement: a backend user is root over their own machine and the
 * local dialog has exactly the same reach. What is enforced is shape — absolute
 * paths only, single-segment names only.
 */

export interface DirectoryEntry {
  name: string;
  /** Absolute path of the directory. */
  path: string;
}

export interface DirectoryListing {
  /** Absolute path of the listed directory. */
  path: string;
  /** Parent directory, or `null` at the filesystem root. */
  parent: string | null;
  /** Sub-directories, sorted case-insensitively. */
  entries: DirectoryEntry[];
  /** Handy starting points (only filled in for the initial call). */
  roots: DirectoryEntry[];
}

/** Bound on how many entries one listing returns (a home folder can be huge). */
const MAX_ENTRIES = 500;

/** The starting points offered when no path is given. */
export function listRoots(): DirectoryEntry[] {
  const roots: DirectoryEntry[] = [{ name: "Home", path: homedir() }];
  const data = getDataRoot();
  if (data !== homedir()) roots.push({ name: "imboss data", path: data });
  const workdir = getWorkDir();
  if (workdir !== data)
    roots.push({ name: "Agent working folder", path: workdir });
  return roots;
}

/** List the directories under `path` (or the roots when it is empty). */
export function listDirectories(path: string | undefined): DirectoryListing {
  if (path === undefined || path === null || path.trim().length === 0) {
    return { path: homedir(), parent: null, entries: [], roots: listRoots() };
  }
  if (!isAbsolute(path)) {
    throw new Error("The directory path must be absolute.");
  }
  const dir = resolve(path);
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new Error(`The directory does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }

  const entries: DirectoryEntry[] = [];
  try {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory() && !isSymlinkToDirectory(dir, item.name))
        continue;
      // Hidden folders stay visible: `~/.imboss`, `.config`-style skill and MCP
      // folders are exactly what a user comes here to pick. But an unbounded
      // `readdir` of a huge folder must not freeze the request.
      if (entries.length >= MAX_ENTRIES) break;
      entries.push({ name: item.name, path: join(dir, item.name) });
    }
  } catch (error) {
    throw new Error(
      `The directory could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  const parent = dir === resolve(dir, "..") ? null : resolve(dir, "..");

  return { path: dir, parent, entries, roots: [] };
}

/** Create `<parent>/<name>` and return its absolute path. */
export function createDirectory(parent: string, name: string): string {
  if (!isAbsolute(parent)) {
    throw new Error("The parent directory must be absolute.");
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("A folder name is required.");
  }
  if (trimmed.length > 120) {
    throw new Error("The folder name is too long.");
  }
  // One segment only: no separators, no traversal, no drive letters.
  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes(sep) ||
    trimmed.includes("\u0000")
  ) {
    throw new Error("The folder name must be a single path segment.");
  }

  const target = join(resolve(parent), trimmed);
  if (existsSync(target)) {
    throw new Error(`Already exists: ${target}`);
  }
  mkdirSync(target);
  return target;
}

/** Root for files the backend writes for a client to pull down. */
export function getTransferTempRoot(): string {
  return join(getDataRoot(), "tmp");
}

/**
 * Mint a path the backend may write an export to, for the client to download.
 *
 * One directory per request so two concurrent exports (or a retry) can never
 * overwrite each other, and the name is sanitized to a single segment because it
 * comes from a dialog default (which the user may have edited).
 */
export function createTransferTempPath(name: string, token: string): string {
  const safe = sanitizeSegment(name);
  const dir = join(getTransferTempRoot(), token);
  mkdirSync(dir, { recursive: true });
  return join(dir, safe);
}

/** How long a transfer temp entry is kept before the startup sweep removes it. */
export const TRANSFER_TEMP_RETENTION_DAYS = 7;
/** An abandoned `.partial` upload is junk the moment its stream died. */
export const PARTIAL_UPLOAD_RETENTION_MS = 60 * 60 * 1000;

/**
 * Sweep leftover transfer files (called once at backend startup).
 *
 * Two kinds accumulate, both harmless in size but not free:
 * - `tmp/<uuid>/…` export staging — kept for a few days so a client that
 *   downloaded but never opened the file still has it, then removed;
 * - `tmp/uploads/*.partial` — an upload whose stream died (crash, cancelled
 *   import). Nothing will ever complete them, so they go after an hour.
 *
 * Never throws: a cleanup problem must not keep the backend from starting.
 */
export function sweepTransferTempRoot(now = Date.now()): {
  removedDirs: number;
  removedPartials: number;
} {
  const root = getTransferTempRoot();
  let removedDirs = 0;
  let removedPartials = 0;
  if (!existsSync(root)) return { removedDirs, removedPartials };

  const olderThan = (path: string, ms: number): boolean => {
    try {
      return now - statSync(path).mtimeMs > ms;
    } catch {
      return false;
    }
  };

  try {
    for (const item of readdirSync(root, { withFileTypes: true })) {
      const full = join(root, item.name);
      if (item.isDirectory()) {
        if (item.name === "uploads") {
          for (const file of readdirSync(full, { withFileTypes: true })) {
            const path = join(full, file.name);
            if (file.isFile() && olderThan(path, PARTIAL_UPLOAD_RETENTION_MS)) {
              rmSync(path, { force: true });
              removedPartials += 1;
            }
          }
          continue;
        }
        if (
          olderThan(full, TRANSFER_TEMP_RETENTION_DAYS * 24 * 60 * 60 * 1000)
        ) {
          rmSync(full, { recursive: true, force: true });
          removedDirs += 1;
        }
      }
    }
  } catch (error) {
    console.warn(
      "[files] transfer temp sweep failed:",
      error instanceof Error ? error.message : error,
    );
  }
  return { removedDirs, removedPartials };
}

/** Remove one transfer directory (after a download, or when it goes stale). */
export function removeTransferTempDir(token: string): void {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(token)) return;
  rmSync(join(getTransferTempRoot(), token), { recursive: true, force: true });
}

/** Reduce a name to a single safe path segment. */
function sanitizeSegment(name: string): string {
  const base = (name.trim() || "export")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "");
  return base.slice(0, 120) || "export";
}

function isSymlinkToDirectory(dir: string, name: string): boolean {
  try {
    return statSync(join(dir, name)).isDirectory();
  } catch {
    return false;
  }
}
