import type { RemoteAgent, RemoteAgentStatus } from "@shared/types";
import { ASSISTANT_ID } from "@shared/constants/employees";
import { getDB } from "./index";
import { stringifyArray } from "./json";

/**
 * Persistence for remote A2A peers.
 *
 * One peer spans three tables, kept in lockstep by the transactions below:
 *
 * - `remote_agents` — the transport record (URL, cached agent card, status);
 * - `employees`      — a hidden identity row flagged by `remote_agent_id`,
 *                      used as the message author so avatars, unread badges
 *                      and notifications work like any local employee's;
 * - `chats`          — one conversation per peer, bound through
 *                      `source = 'a2a'` + `source_session = <peer id>`.
 *
 * Deleting a peer removes all three; the `sessions` / `read_cursors` rows go
 * with the employee and chat through their FK cascades.
 */

/** Raw row of `remote_agents`. */
interface RemoteAgentRow {
  id: number;
  url: string;
  card: string | null;
  status: string;
  status_detail: string | null;
  created_at: number;
  context_id: string | null;
  last_task_id: string | null;
  run_state: string;
  employee_id: number | null;
  chat_id: number | null;
}

/** Whether the peer's last task is still running (from our side). */
export type RemoteRunState = "idle" | "working";

/** A peer joined with its hidden employee row and its conversation. */
export interface RemoteAgentRecord {
  id: number;
  url: string;
  /** Parsed cached agent card, or null when it could not be resolved. */
  card: unknown;
  status: RemoteAgentStatus;
  statusDetail: string | null;
  createdAt: number;
  /** A2A conversation id, echoed back on the next turn for multi-turn context. */
  contextId: string | null;
  /** Id of the peer's most recent task, used to re-attach after a drop. */
  lastTaskId: string | null;
  /** 'working' means a task is running (or was orphaned by a restart). */
  runState: RemoteRunState;
  /** Hidden employee row used as the message author. */
  employeeId: number;
  /** The conversation bridged to this peer. */
  chatId: number;
}

/** The chat-source kind peers bind through (`chats.source`). */
export const REMOTE_AGENT_SOURCE = "a2a";

const SELECT = `
  SELECT ra.*,
    (SELECT e.id FROM employees e WHERE e.remote_agent_id = ra.id) AS employee_id,
    (SELECT c.id FROM chats c
      WHERE c.source = '${REMOTE_AGENT_SOURCE}'
        AND c.source_session = CAST(ra.id AS TEXT)) AS chat_id
  FROM remote_agents ra
`;

function toRecord(row: RemoteAgentRow): RemoteAgentRecord | null {
  // A peer without its employee row or conversation is mid-teardown (or was
  // half-created by an older build); treat it as absent so callers cannot act
  // on a dangling peer.
  if (row.employee_id === null || row.chat_id === null) return null;
  return {
    id: row.id,
    url: row.url,
    card: parseCard(row.card),
    status: row.status === "ok" ? "ok" : "error",
    statusDetail: row.status_detail,
    createdAt: row.created_at,
    contextId: row.context_id,
    lastTaskId: row.last_task_id,
    runState: row.run_state === "working" ? "working" : "idle",
    employeeId: row.employee_id,
    chatId: row.chat_id,
  };
}

function parseCard(value: string | null): unknown {
  if (value === null || value.length === 0) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function listRemoteAgents(): RemoteAgentRecord[] {
  const rows = getDB()
    .prepare(`${SELECT} ORDER BY ra.id ASC`)
    .all() as RemoteAgentRow[];
  return rows
    .map(toRecord)
    .filter((record): record is RemoteAgentRecord => record !== null);
}

export function getRemoteAgent(id: number): RemoteAgentRecord | null {
  const row = getDB().prepare(`${SELECT} WHERE ra.id = ?`).get(id) as
    RemoteAgentRow | undefined;
  return row ? toRecord(row) : null;
}

/** The peer bridged to a conversation, or null for a non-peer chat. */
export function getRemoteAgentByChat(chatId: number): RemoteAgentRecord | null {
  const row = getDB()
    .prepare(
      `${SELECT} WHERE ra.id = (
        SELECT CAST(c.source_session AS INTEGER) FROM chats c
         WHERE c.id = ? AND c.source = '${REMOTE_AGENT_SOURCE}'
      )`,
    )
    .get(chatId) as RemoteAgentRow | undefined;
  return row ? toRecord(row) : null;
}

export interface CreateRemoteAgentInput {
  url: string;
  /** Normalized agent card (stored as JSON). */
  card: unknown;
  /** Peer display name (the employee row's name). */
  name: string;
  /** Peer description (the employee row's role). */
  role: string;
  /** Initial resolve outcome. */
  status: RemoteAgentStatus;
  statusDetail: string | null;
}

/**
 * Create a peer together with its hidden employee row and its conversation.
 * Returns null when the employee or chat could not be created (the whole
 * transaction rolls back).
 */
export function createRemoteAgent(
  input: CreateRemoteAgentInput,
): RemoteAgentRecord | null {
  const db = getDB();
  const createdAt = Math.floor(Date.now() / 1000);
  const id = db.transaction(() => {
    const agentResult = db
      .prepare(
        "INSERT INTO remote_agents (url, card, status, status_detail, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        input.url,
        input.card === null ? null : JSON.stringify(input.card),
        input.status,
        input.statusDetail,
        createdAt,
      );
    const agentId = Number(agentResult.lastInsertRowid);

    // The peer's identity row: no model, tools or prompt — it never runs
    // locally. `remote_agent_id` is what keeps it out of the Employees module.
    const employeeResult = db
      .prepare(
        "INSERT INTO employees (name, role, system_prompt, mcp, skills, model_id, thinking_level, remote_agent_id) " +
          "VALUES (?, ?, '', '[]', '[]', NULL, NULL, ?)",
      )
      .run(input.name, input.role, agentId);
    const employeeId = Number(employeeResult.lastInsertRowid);

    // The peer's conversation. The assistant is a participant so the chat
    // behaves like any other root chat (title generation, read state).
    db.prepare(
      "INSERT INTO chats (title, participants, from_chat_id, source, source_session, source_context, created_at, last_message_at) " +
        "VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)",
    ).run(
      input.name,
      stringifyArray([ASSISTANT_ID, employeeId]),
      REMOTE_AGENT_SOURCE,
      String(agentId),
      createdAt,
      createdAt,
    );

    return agentId;
  })();
  return getRemoteAgent(id);
}

/** Replace the cached card and the resolve outcome of one peer. */
export function updateRemoteAgentCard(
  id: number,
  card: unknown,
  status: RemoteAgentStatus,
  statusDetail: string | null,
): void {
  getDB()
    .prepare(
      "UPDATE remote_agents SET card = ?, status = ?, status_detail = ? WHERE id = ?",
    )
    .run(card === null ? null : JSON.stringify(card), status, statusDetail, id);
}

/** Remember the peer's A2A conversation id for the next turn. */
export function setRemoteAgentContextId(
  id: number,
  contextId: string | null,
): void {
  getDB()
    .prepare("UPDATE remote_agents SET context_id = ? WHERE id = ?")
    .run(contextId, id);
}

/**
 * Record whether a task is running, and which task it is.
 *
 * `run_started_at` is only meaningful while a task runs; it is cleared when the
 * run settles so a resumed run can report how long it has been going.
 */
export function setRemoteAgentRun(
  id: number,
  state: RemoteRunState,
  taskId: string | null,
): void {
  getDB()
    .prepare(
      "UPDATE remote_agents SET run_state = ?, last_task_id = ?, run_started_at = ? WHERE id = ?",
    )
    .run(
      state,
      taskId,
      state === "working" ? Math.floor(Date.now() / 1000) : null,
      id,
    );
}

/** Peers whose last run never settled (a dropped stream or an app restart). */
export function listOrphanedRemoteAgentRuns(): RemoteAgentRecord[] {
  return listRemoteAgents().filter(
    (record) => record.runState === "working" && record.lastTaskId !== null,
  );
}

/** Rename the hidden employee row (keeps the chat title in step). */
export function renameRemoteAgentEmployee(
  employeeId: number,
  name: string,
  role: string,
): void {
  getDB()
    .prepare("UPDATE employees SET name = ?, role = ? WHERE id = ?")
    .run(name, role, employeeId);
}

/** Delete a peer, its hidden employee row and its conversation. */
export function deleteRemoteAgent(id: number): boolean {
  const db = getDB();
  return db.transaction(() => {
    const record = getRemoteAgent(id);
    // The employee row is removed by its `remote_agent_id` link rather than by
    // the joined record, so a peer whose conversation was deleted first still
    // leaves nothing behind.
    db.prepare("DELETE FROM employees WHERE remote_agent_id = ?").run(id);
    if (record) {
      // The chat cascade removes its messages, sessions and read cursors.
      db.prepare("DELETE FROM chats WHERE id = ?").run(record.chatId);
    }
    return (
      db.prepare("DELETE FROM remote_agents WHERE id = ?").run(id).changes > 0
    );
  })();
}

/** Ids of the peers bound to the given conversations (for chat deletion). */
export function remoteAgentIdsForChats(chatIds: number[]): number[] {
  const ids = new Set<number>();
  for (const chatId of chatIds) {
    const row = getDB()
      .prepare(
        "SELECT CAST(source_session AS INTEGER) AS id FROM chats " +
          "WHERE id = ? AND source = ? AND source_session IS NOT NULL",
      )
      .get(chatId, REMOTE_AGENT_SOURCE) as { id: number | null } | undefined;
    if (row && typeof row.id === "number" && row.id > 0) ids.add(row.id);
  }
  return [...ids];
}

/** Renderer view of one peer (no card internals, no token). */
export function toRemoteAgentView(record: RemoteAgentRecord): RemoteAgent {
  const card = record.card as {
    name?: unknown;
    description?: unknown;
    skills?: unknown;
  } | null;
  const skills = Array.isArray(card?.skills)
    ? (card.skills as Array<{ name?: unknown }>)
        .map((skill) => (typeof skill?.name === "string" ? skill.name : ""))
        .filter((name) => name.length > 0)
    : [];
  return {
    id: record.id,
    name: typeof card?.name === "string" ? card.name : "",
    description: typeof card?.description === "string" ? card.description : "",
    url: record.url,
    status: record.status,
    statusDetail: record.statusDetail,
    skills,
    employeeId: record.employeeId,
    chatId: record.chatId,
    createdAt: record.createdAt,
  };
}
