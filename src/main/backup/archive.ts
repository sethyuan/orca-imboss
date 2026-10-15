import DB from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { t } from "@shared/l10n";
import type { BackupManifest } from "@shared/types";

/**
 * A backup archive is itself a SQLite database: one `meta` row carries the
 * manifest, one `files` row carries each stored file. Reusing the storage
 * engine the app already links keeps the format free of new dependencies and
 * lets any file name or size travel inside a single, verifiable container.
 *
 * Layout:
 *   meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)   — `manifest` holds JSON
 *   files(path TEXT PRIMARY KEY, size, mtime, data BLOB) — `path` is relative
 *                                                          to the data root
 */
export const BACKUP_FORMAT = "imboss-backup";
/** Bumped only when the archive layout changes incompatibly. */
export const BACKUP_FORMAT_VERSION = 1;
/** Extension used by the save/open dialogs. */
export const BACKUP_EXTENSION = "imboss-backup";

const META_MANIFEST = "manifest";
const FILE_TABLE = "files";

/** Create a fresh archive at `path`, replacing any file already there. */
export function createArchive(path: string): DB.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DB(path);
  // Plain rollback journal, not WAL: an archive is handed to the user as a
  // single file, and WAL would leave `-wal`/`-shm` sidecars behind.
  db.pragma("journal_mode = delete");
  db.exec(`
    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE ${FILE_TABLE} (
      path  TEXT PRIMARY KEY,
      size  INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      data  BLOB NOT NULL
    );
  `);
  db.pragma(`user_version = ${BACKUP_FORMAT_VERSION}`);
  return db;
}

/** Store the manifest (the archive's identity and summary). */
export function writeArchiveManifest(
  db: DB.Database,
  manifest: BackupManifest,
): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    META_MANIFEST,
    JSON.stringify(manifest),
  );
}

/**
 * Store the file at `abs` under the archive-relative path `rel` (always
 * `/`-separated). Returns the number of bytes stored.
 */
export function writeArchiveFile(
  db: DB.Database,
  rel: string,
  abs: string,
): number {
  const stat = statSync(abs);
  const data = readFileSync(abs);
  db.prepare(
    `INSERT OR REPLACE INTO ${FILE_TABLE} (path, size, mtime, data)
     VALUES (?, ?, ?, ?)`,
  ).run(rel, data.byteLength, Math.floor(stat.mtimeMs), data);
  return data.byteLength;
}

/**
 * Open an archive read-only after checking that it really is one this build
 * understands. Throws a user-facing message otherwise.
 */
export function openArchive(path: string): DB.Database {
  if (!existsSync(path)) {
    throw new Error(t("Backup file not found."));
  }
  let db: DB.Database;
  let version: number;
  try {
    db = new DB(path, { readonly: true, fileMustExist: true });
    // Opening is lazy: the first statement is what actually reads the file, so
    // a foreign SQLite database (or a file that is not one at all) fails here.
    version = db.pragma("user_version", { simple: true }) as number;
    if (!hasManifest(db)) throw new Error("not an imboss backup");
  } catch {
    throw new Error(t("This file is not an imboss backup."));
  }
  if (version > BACKUP_FORMAT_VERSION) {
    db.close();
    throw new Error(
      t("This backup was created by a newer version of imboss."),
    );
  }
  return db;
}

/** Read and validate the manifest of an opened archive. */
export function readArchiveManifest(db: DB.Database): BackupManifest {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(META_MANIFEST) as { value: string } | undefined;
  if (!row) throw new Error(t("This file is not an imboss backup."));
  let parsed: BackupManifest;
  try {
    parsed = JSON.parse(row.value) as BackupManifest;
  } catch {
    throw new Error(t("This backup file is damaged and cannot be read."));
  }
  if (parsed.format !== BACKUP_FORMAT) {
    throw new Error(t("This file is not an imboss backup."));
  }
  return parsed;
}

/** Files stored in the archive, smallest metadata only (no blobs). */
export function listArchiveFiles(
  db: DB.Database,
): Array<{ path: string; size: number; mtime: number }> {
  return db
    .prepare(`SELECT path, size, mtime FROM ${FILE_TABLE} ORDER BY path`)
    .all() as Array<{ path: string; size: number; mtime: number }>;
}

/**
 * Write every file of the archive under `destRoot`, recreating directories and
 * modification times. Returns the number of files written.
 */
export function extractArchive(db: DB.Database, destRoot: string): number {
  const rows = db.prepare(
    `SELECT path, mtime, data FROM ${FILE_TABLE} ORDER BY path`,
  );
  let count = 0;
  // `iterate` streams rows so a large archive never loads all blobs at once.
  for (const row of rows.iterate() as IterableIterator<{
    path: string;
    mtime: number;
    data: Buffer;
  }>) {
    const abs = join(destRoot, ...row.path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, row.data);
    try {
      const secs = row.mtime / 1000;
      utimesSync(abs, secs, secs);
    } catch {
      // Modification times are cosmetic; a filesystem that rejects them is
      // not a reason to fail a restore.
    }
    count += 1;
  }
  return count;
}

/** True when the archive carries our manifest row (guards foreign SQLite files). */
function hasManifest(db: DB.Database): boolean {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("meta") as { name: string } | undefined;
  if (!table) return false;
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(META_MANIFEST) as { value: string } | undefined;
  return row !== undefined;
}
