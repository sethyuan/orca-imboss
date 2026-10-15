import DB from "better-sqlite3";
import { app } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { t } from "@shared/l10n";
import type {
  BackupInfo,
  BackupManifest,
  BackupStatus,
  PendingRestore,
  StagedRestore,
} from "@shared/types";
import { getDataRoot } from "../data-dir";
import { getDB } from "../db";
import {
  BACKUP_EXTENSION,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  createArchive,
  extractArchive,
  openArchive,
  readArchiveManifest,
  writeArchiveFile,
  writeArchiveManifest,
} from "./archive";
import {
  DB_ARCHIVE_PATH,
  collectBackupEntries,
  countMiniApps,
  countUserSkills,
} from "./entries";

export { BACKUP_EXTENSION, BACKUP_FORMAT, BACKUP_FORMAT_VERSION };

/** Folder an archive is unpacked into, next to (never inside) the data folder. */
export function getRestoreStagingDir(): string {
  return join(homedir(), ".imboss.restore-staging");
}

/** Marker recording that a staged restore waits for the next launch. */
export function getRestoreMarkerPath(): string {
  return join(homedir(), ".imboss.restore-pending.json");
}

/** Name prefix of the data folders previous restores kept aside. */
export const KEPT_DATA_DIR_PREFIX = ".imboss.before-restore-";

/** Outcome of a swap performed by `applyPendingRestore`. */
export interface RestoreOutcome {
  /** Archive the restore came from. */
  restoredFrom: string;
  /** Where the replaced data folder was moved, when there was one. */
  keptAt: string | null;
}

/**
 * Write a complete backup of the local dataset to `destination`.
 *
 * The database travels as an online snapshot (taken while the app keeps
 * running), the rest as plain files. The archive is built under a `.partial`
 * name and only renamed into place once it is complete, so an interrupted
 * export never leaves a half-written file behind under the chosen name.
 */
export async function createBackup(options: {
  includeCredentials: boolean;
  destination: string;
}): Promise<BackupInfo> {
  const { destination } = options;
  const partial = `${destination}.partial`;
  rmSync(partial, { force: true });

  const live = getDB();
  const snapshotPath = join(
    tmpdir(),
    `imboss-backup-snapshot-${Date.now()}-${process.pid}.db`,
  );
  // Online backup: a consistent copy without pausing writers, unlike copying
  // the file (which could miss WAL contents).
  await live.backup(snapshotPath);

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: live.pragma("user_version", { simple: true }) as number,
    appVersion: app.getVersion(),
    createdAt: Date.now(),
    platform: process.platform,
    includeCredentials: options.includeCredentials,
    counts: {
      chats: countRows(live, "chats"),
      messages: countRows(live, "messages"),
      employees: countRows(live, "employees"),
      skills: countUserSkills(),
      miniApps: countMiniApps(),
    },
    files: 0,
    bytes: 0,
  };

  const archive = createArchive(partial);
  try {
    let files = 0;
    let bytes = 0;
    bytes += writeArchiveFile(archive, DB_ARCHIVE_PATH, snapshotPath);
    files += 1;
    for (const entry of collectBackupEntries(options.includeCredentials)) {
      bytes += writeArchiveFile(archive, entry.rel, entry.abs);
      files += 1;
    }
    manifest.files = files;
    manifest.bytes = bytes;
    writeArchiveManifest(archive, manifest);
  } finally {
    archive.close();
    rmSync(snapshotPath, { force: true });
  }

  renameSync(partial, destination);
  return {
    path: destination,
    sizeBytes: statSync(destination).size,
    manifest,
  };
}

/** Read the manifest and size of an archive without unpacking it. */
export function inspectBackup(path: string): BackupInfo {
  const archive = openArchive(path);
  try {
    return {
      path,
      sizeBytes: statSync(path).size,
      manifest: readArchiveManifest(archive),
    };
  } finally {
    archive.close();
  }
}

/**
 * Unpack an archive next to the data folder and record that it should be
 * swapped in on the next launch. Nothing in the running app's data folder is
 * touched here — that only happens in `applyPendingRestore`, at startup.
 */
export function stageRestore(path: string): StagedRestore {
  const archive = openArchive(path);
  let manifest: BackupManifest;
  try {
    manifest = readArchiveManifest(archive);
    const schema = getDB().pragma("user_version", { simple: true }) as number;
    if (manifest.schemaVersion > schema) {
      throw new Error(
        t("This backup comes from a newer version of imboss and cannot be restored."),
      );
    }
    const staging = getRestoreStagingDir();
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    extractArchive(archive, staging);
  } finally {
    archive.close();
  }

  // Fail here — where the user can still pick another file — rather than after
  // the swap, if the unpacked database is unusable.
  assertStagedDatabase();

  const pending: PendingRestore = { source: path, stagedAt: Date.now() };
  writeMarker(pending);
  return { manifest, source: path, stagedAt: pending.stagedAt };
}

/** State shown by Settings › Backup. */
export function getBackupStatus(): BackupStatus {
  return { pending: readPendingRestore(), keptDataDirs: listKeptDataDirs() };
}

/** The staged restore waiting for a restart, if any. */
export function readPendingRestore(): PendingRestore | null {
  const marker = getRestoreMarkerPath();
  if (!existsSync(marker)) return null;
  try {
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as PendingRestore;
    if (typeof parsed?.source !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Forget a staged restore and delete its unpacked copy. */
export function cancelPendingRestore(): void {
  rmSync(getRestoreMarkerPath(), { force: true });
  rmSync(getRestoreStagingDir(), { recursive: true, force: true });
}

/** Data folders kept aside by earlier restores, newest first. */
export function listKeptDataDirs(): string[] {
  try {
    return readdirSync(homedir())
      .filter((name) => name.startsWith(KEPT_DATA_DIR_PREFIX))
      .map((name) => join(homedir(), name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Swap a staged restore into place.
 *
 * Runs synchronously at startup, before anything reads or creates the data
 * folder, and never throws: a failure is recorded on the marker (so the UI can
 * explain it and the user can retry or cancel) and the original data folder is
 * put back, leaving the app running exactly as it was.
 */
export function applyPendingRestore(): RestoreOutcome | null {
  const pending = readPendingRestore();
  if (!pending) return null;

  const staging = getRestoreStagingDir();
  const stagedDb = join(staging, ...DB_ARCHIVE_PATH.split("/"));
  if (!existsSync(stagedDb)) {
    // The unpacked copy went missing (removed outside the app). Drop the
    // marker instead of blocking startup forever.
    rmSync(getRestoreMarkerPath(), { force: true });
    return null;
  }

  const root = getDataRoot();
  const keptAt = join(homedir(), `${KEPT_DATA_DIR_PREFIX}${stamp()}`);
  let movedAside = false;
  try {
    if (existsSync(root)) {
      renameSync(root, keptAt);
      movedAside = true;
    }
    renameSync(staging, root);
  } catch (err) {
    if (movedAside && !existsSync(root)) {
      try {
        renameSync(keptAt, root);
      } catch (rollbackError) {
        console.error(
          `[backup] restore failed and the previous data folder could not be moved back; it is at ${keptAt}`,
          rollbackError,
        );
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[backup] restore failed:", message);
    writeMarker({ ...pending, error: message });
    return null;
  }

  rmSync(getRestoreMarkerPath(), { force: true });
  return { restoredFrom: pending.source, keptAt: movedAside ? keptAt : null };
}

/** Suggested file name for a new export (`imboss-backup-YYYYMMDD-HHmm.imboss-backup`). */
export function defaultBackupFileName(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `imboss-backup-${date}-${time}.${BACKUP_EXTENSION}`;
}

function writeMarker(pending: PendingRestore): void {
  writeFileSync(getRestoreMarkerPath(), JSON.stringify(pending), {
    mode: 0o600,
  });
}

function countRows(db: DB.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
    n: number;
  };
  return row.n;
}

/** The unpacked copy must carry a readable database, or the swap is pointless. */
function assertStagedDatabase(): void {
  const dbPath = join(getRestoreStagingDir(), ...DB_ARCHIVE_PATH.split("/"));
  if (!existsSync(dbPath)) {
    throw new Error(
      t("This backup has no database inside and cannot be restored."),
    );
  }
  let db: DB.Database | null = null;
  try {
    db = new DB(dbPath, { readonly: true, fileMustExist: true });
    db.prepare("SELECT COUNT(*) AS n FROM chats").get();
  } catch {
    throw new Error(t("The database inside this backup is damaged."));
  } finally {
    db?.close();
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
