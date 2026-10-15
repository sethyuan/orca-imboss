/** Record counts carried by a backup, shown in the export/restore UI. */
export interface BackupCounts {
  chats: number;
  messages: number;
  employees: number;
  skills: number;
  miniApps: number;
}

/**
 * Metadata stored inside a backup archive and read back when the user picks
 * one. It is the archive's identity: `format`/`formatVersion` decide whether
 * this build can read it at all, `schemaVersion` whether the embedded database
 * is older than (or equal to) the running app's schema.
 */
export interface BackupManifest {
  format: "imboss-backup";
  /** Bumped only when the archive layout changes incompatibly. */
  formatVersion: number;
  /** `PRAGMA user_version` of the embedded database. */
  schemaVersion: number;
  appVersion: string;
  createdAt: number;
  platform: string;
  /** True when provider/integration credentials are inside the archive. */
  includeCredentials: boolean;
  counts: BackupCounts;
  /** Number of files stored in the archive (including the database). */
  files: number;
  /** Sum of the stored files' bytes, before archive overhead. */
  bytes: number;
}

/** A backup archive on disk, with its manifest and current size. */
export interface BackupInfo {
  path: string;
  sizeBytes: number;
  manifest: BackupManifest;
}

/**
 * A restore that has been unpacked next to the data folder and is waiting for
 * the next launch to be swapped in. `error` is set when a launch attempted the
 * swap and failed, so the UI can explain why it is still pending.
 */
export interface PendingRestore {
  /** Archive the restore came from. */
  source: string;
  stagedAt: number;
  error?: string;
}

/** State of the Backup settings section. */
export interface BackupStatus {
  /** Set while a staged restore is waiting for a restart. */
  pending: PendingRestore | null;
  /** Data folders kept aside by earlier restores, newest first. */
  keptDataDirs: string[];
}

/** What `backup:restore` staged, echoed back for the confirmation UI. */
export interface StagedRestore {
  manifest: BackupManifest;
  source: string;
  stagedAt: number;
}
