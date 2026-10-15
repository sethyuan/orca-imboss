import type { Database } from "better-sqlite3";

/**
 * Ordered list of migrations. Each entry runs inside its own transaction and
 * the `user_version` pragma tracks the latest applied migration index.
 */
const MIGRATIONS: Array<(db: Database) => void> = [
  // 0 — initial schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS employees (
        id            INTEGER PRIMARY KEY,
        name          TEXT NOT NULL DEFAULT '',
        role          TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        mcp           TEXT NOT NULL DEFAULT '[]',
        skills        TEXT NOT NULL DEFAULT '[]',
        model_id        TEXT,
        thinking_level  TEXT,
        avatar          TEXT,
        disabled      INTEGER NOT NULL DEFAULT 0
      );
    `);

    // The assistant always exists, under the reserved id 0.
    db.prepare(
      "INSERT OR IGNORE INTO employees (id, name, role, system_prompt, mcp, skills, model_id, thinking_level, avatar) " +
        "VALUES (0, 'Assistant', 'Assistant', '', '[]', '[]', NULL, NULL, NULL)",
    ).run();

    db.exec(`
      -- AUTOINCREMENT keeps ids monotonic. Renderer state keyed by chat id.
      CREATE TABLE IF NOT EXISTS chats (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        title           TEXT NOT NULL DEFAULT '',
        participants    TEXT NOT NULL DEFAULT '[]',
        unread          INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
        last_message_at INTEGER NOT NULL DEFAULT 0,
        from_chat_id    INTEGER,
        -- IM integration binding: which platform this conversation came from,
        -- its stable platform conversation id, and the per-conversation reply
        -- credential (e.g. the iLink context_token). All NULL for local chats.
        source          TEXT,
        source_session  TEXT,
        source_context  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_chats_created_id
        ON chats(created_at, id);

      -- Link a group chat to the user chat that spawned it (from chat link).
      CREATE INDEX IF NOT EXISTS idx_chats_from
        ON chats(from_chat_id);

      -- One app chat per (platform, session). NULL (local) chats are exempt.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_source_session
        ON chats(source, source_session)
        WHERE source IS NOT NULL AND source_session IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_chats_source
        ON chats(source);

      CREATE TABLE IF NOT EXISTS messages (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id            INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        sender_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        kind               TEXT NOT NULL DEFAULT 'text',
        content            TEXT NOT NULL,
        steps              TEXT,
        attachments        TEXT,
        created_at         INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_created
        ON messages(chat_id, created_at);

      -- Full-text index over message content (external content + trigram,
      -- which supports Chinese substring search; queries need >= 3 chars).
      -- Sync triggers keep the index in lockstep with the content table;
      -- SQLite fires triggers on ON DELETE CASCADE row removal as well.
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='id',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TABLE IF NOT EXISTS sessions (
        employee_id         INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        chat_id             INTEGER NOT NULL REFERENCES chats(id)     ON DELETE CASCADE,
        session             TEXT NOT NULL,
        PRIMARY KEY (employee_id, chat_id)
      );

      -- Per-(employee, chat) read cursor, independent of whether an agent
      -- session exists there. The assistant reads task group chats from its
      -- root-chat session, so it needs a cursor in chats where it has no
      -- session row of its own.
      CREATE TABLE IF NOT EXISTS read_cursors (
        employee_id          INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        chat_id              INTEGER NOT NULL REFERENCES chats(id)     ON DELETE CASCADE,
        last_read_message_id INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (employee_id, chat_id)
      );

      CREATE TABLE IF NOT EXISTS cron_jobs (
        id           TEXT PRIMARY KEY,
        chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        schedule     TEXT NOT NULL,
        content      TEXT NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
        last_run_at  INTEGER,
        next_run_at  INTEGER
      );
    `);
  },
  // 1 — task group chats (from_chat_id IS NOT NULL) never surface their
  // `unread` counter (the chat list is root-only and group chats track reads
  // via the separate read_cursors table), so zero out any stale values left
  // behind before the write paths were guarded.
  (db) => {
    db.exec(`
      UPDATE chats SET unread = 0 WHERE from_chat_id IS NOT NULL;
    `);
  },
  // 2 — pinned conversations (sort above the rest of the chat list)
  (db) => {
    db.exec(`
      ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    `);
  },
  // 3 — conversation tags. One row per (chat, tag); cascades with the chat.
  // The candidate list is derived from the distinct tags in use, so there is
  // no separate tag dictionary table.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_tags (
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        tag     TEXT    NOT NULL,
        PRIMARY KEY (chat_id, tag)
      );

      CREATE INDEX IF NOT EXISTS idx_chat_tags_tag
        ON chat_tags(tag);
    `);
  },
  // 4 — muted conversations: the chat still records unread, but its messages
  // raise no OS notification and no notification sound.
  (db) => {
    db.exec(`
      ALTER TABLE chats ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
    `);
  },
];

export function migrate(db: Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let index = current; index < MIGRATIONS.length; index += 1) {
    const apply = db.transaction(() => {
      MIGRATIONS[index](db);
      db.pragma(`user_version = ${index + 1}`);
    });
    apply();
  }
}
