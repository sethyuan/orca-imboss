import DB from "better-sqlite3";
import { ensureDataDir, getDbPath } from "../data-dir";
import { migrate } from "./migrations";

let _db: DB.Database | null = null;

/**
 * Open (once) the app's SQLite database in WAL mode and run migrations.
 * The database lives at `~/.imboss/db/imboss.db` (created on demand).
 */
export function initDatabase(): DB.Database {
  if (_db) return _db;
  ensureDataDir();
  _db = new DB(getDbPath());
  _db.pragma("journal_mode = WAL");
  // Enforce declared foreign keys (required for ON DELETE CASCADE behavior).
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

export function getDB(): DB.Database {
  if (!_db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return _db;
}

/**
 * True once {@link initDatabase} has opened the database.
 *
 * Only the desktop shell's *local* concerns ask this: window bounds, the global
 * shortcut and the theme are read at startup, before a remote shell has any
 * backend to ask, and a remote shell never opens the database at all (the data
 * folder belongs to the backend). Business code must keep calling `getDB()` and
 * fail loudly instead of silently degrading.
 */
export function isDatabaseReady(): boolean {
  return _db !== null;
}
