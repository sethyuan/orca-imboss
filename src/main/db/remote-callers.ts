import { ASSISTANT_ID } from "@shared/constants/employees";
import { createChat } from "./chats";
import { getDB } from "./index";

/**
 * Persistence for inbound A2A callers (other companies calling us).
 *
 * A caller spans two tables, kept in lockstep by the transactions below:
 *
 * - `remote_callers` — the partner record (name);
 * - `employees`      — a hidden identity row flagged by `remote_caller_id`,
 *                      used as the message author so an inbound request has a
 *                      name and an avatar, and the boss can reply in the same
 *                      conversation.
 *
 * Conversations are not one-per-caller but one-per-(caller, A2A contextId),
 * because a contextId *is* a conversation in A2A terms: a partner that keeps
 * two conversations going at once must not see them merged into one chat.
 * They are bound through `source = 'a2a-in'` + `source_session = '<caller>:<context>'`,
 * a different source from the outbound `'a2a'` so the two directions can never
 * be confused.
 */

/** Raw row of `remote_callers`. */
interface RemoteCallerRow {
  id: number;
  name: string;
  created_at: number;
  employee_id: number | null;
}

/** A caller joined with its hidden employee row. */
export interface RemoteCallerRecord {
  id: number;
  name: string;
  createdAt: number;
  /** Hidden employee row used as the author of inbound messages. */
  employeeId: number;
}

/** The chat-source kind inbound callers bind through (`chats.source`). */
export const REMOTE_CALLER_SOURCE = "a2a-in";

const SELECT = `
  SELECT rc.*,
    (SELECT e.id FROM employees e WHERE e.remote_caller_id = rc.id) AS employee_id
  FROM remote_callers rc
`;

function toRecord(row: RemoteCallerRow): RemoteCallerRecord | null {
  // A caller without its employee row is mid-teardown; treat it as absent so
  // callers cannot act on a dangling partner.
  if (row.employee_id === null) return null;
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    employeeId: row.employee_id,
  };
}

export function listRemoteCallers(): RemoteCallerRecord[] {
  const rows = getDB()
    .prepare(`${SELECT} ORDER BY rc.id ASC`)
    .all() as RemoteCallerRow[];
  return rows
    .map(toRecord)
    .filter((record): record is RemoteCallerRecord => record !== null);
}

export function getRemoteCaller(id: number): RemoteCallerRecord | null {
  const row = getDB().prepare(`${SELECT} WHERE rc.id = ?`).get(id) as
    RemoteCallerRow | undefined;
  return row ? toRecord(row) : null;
}

/**
 * Create a caller together with its hidden employee row. Returns null when the
 * employee could not be created (the whole transaction rolls back).
 */
export function createRemoteCaller(name: string): RemoteCallerRecord | null {
  const db = getDB();
  const createdAt = Math.floor(Date.now() / 1000);
  const id = db.transaction(() => {
    const result = db
      .prepare("INSERT INTO remote_callers (name, created_at) VALUES (?, ?)")
      .run(name, createdAt);
    const callerId = Number(result.lastInsertRowid);

    // The caller's identity row: no model, tools or prompt — it never runs
    // locally. `remote_caller_id` is what keeps it out of the Employees module.
    db.prepare(
      "INSERT INTO employees (name, role, system_prompt, mcp, skills, model_id, thinking_level, remote_caller_id) " +
        "VALUES (?, '', '', '[]', '[]', NULL, NULL, ?)",
    ).run(name, callerId);

    return callerId;
  })();
  return getRemoteCaller(id);
}

/** Rename a caller and the hidden employee row that authors its messages. */
export function renameRemoteCaller(id: number, name: string): void {
  const db = getDB();
  db.transaction(() => {
    db.prepare("UPDATE remote_callers SET name = ? WHERE id = ?").run(name, id);
    db.prepare("UPDATE employees SET name = ? WHERE remote_caller_id = ?").run(
      name,
      id,
    );
  })();
}

/**
 * Delete a caller, its hidden employee row and every conversation it opened.
 * Returns false when the caller did not exist.
 */
export function deleteRemoteCaller(id: number): boolean {
  const db = getDB();
  return db.transaction(() => {
    db.prepare("DELETE FROM employees WHERE remote_caller_id = ?").run(id);
    // The chat cascade removes the messages, sessions and read cursors.
    db.prepare(
      "DELETE FROM chats WHERE source = ? AND source_session LIKE ?",
    ).run(REMOTE_CALLER_SOURCE, `${id}:%`);
    return (
      db.prepare("DELETE FROM remote_callers WHERE id = ?").run(id).changes > 0
    );
  })();
}

/** The conversation one caller opened under one A2A contextId, if any. */
export function findCallerChat(
  callerId: number,
  contextId: string,
): number | null {
  const row = getDB()
    .prepare("SELECT id FROM chats WHERE source = ? AND source_session = ?")
    .get(REMOTE_CALLER_SOURCE, sessionKey(callerId, contextId)) as
    { id: number } | undefined;
  return row ? row.id : null;
}

/**
 * Open the conversation for one (caller, contextId) pair. The caller and the
 * assistant are the participants, so the chat behaves like any other root chat
 * (title generation, read state) while its author is the partner.
 */
export function createCallerChat(
  callerId: number,
  contextId: string,
  callerEmployeeId: number,
  title: string,
): number {
  const chat = createChat(title, [ASSISTANT_ID, callerEmployeeId], {
    source: REMOTE_CALLER_SOURCE,
    sourceSession: sessionKey(callerId, contextId),
    sourceContext: contextId,
  });
  return chat.id;
}

/** The conversations a caller has open. */
export function listCallerChats(callerId: number): number[] {
  const rows = getDB()
    .prepare(
      "SELECT id FROM chats WHERE source = ? AND source_session LIKE ? ORDER BY id ASC",
    )
    .all(REMOTE_CALLER_SOURCE, `${callerId}:%`) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

/** How many conversations a caller has open. */
export function countCallerChats(callerId: number): number {
  const row = getDB()
    .prepare(
      "SELECT COUNT(*) AS count FROM chats WHERE source = ? AND source_session LIKE ?",
    )
    .get(REMOTE_CALLER_SOURCE, `${callerId}:%`) as { count: number };
  return row.count;
}

/** Ids of the callers that own the given conversations (for chat deletion). */
export function callerIdsForChats(chatIds: number[]): number[] {
  const ids = new Set<number>();
  for (const chatId of chatIds) {
    const row = getDB()
      .prepare(
        "SELECT source_session FROM chats WHERE id = ? AND source = ? AND source_session IS NOT NULL",
      )
      .get(chatId, REMOTE_CALLER_SOURCE) as
      { source_session: string } | undefined;
    if (!row) continue;
    const id = Number(row.source_session.split(":", 1)[0]);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

/** The stable key a caller's conversation is bound by. */
function sessionKey(callerId: number, contextId: string): string {
  return `${callerId}:${contextId}`;
}
