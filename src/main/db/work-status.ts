import type { MessageStep } from "@shared/types";
import { getDB } from "./index";
import { parseNumberArray } from "./json";
import { parseGroupChatId, parseSteps } from "./message-payload";

/**
 * Reads behind the work-status view (one task group = one room).
 *
 * Only the queries live here — the room snapshot also needs employee rows and
 * live run state, which belong to other layers; `main/work-status.ts` composes
 * the three.
 *
 * The candidate query is the one that keeps the board's promise ("every
 * in-progress task group"): the caller passes the chat ids that *can* be in
 * progress (an unfinished progress card, or a live run), so a busy history of
 * finished groups can never crowd a still-running one out of the snapshot. The
 * limits below only bound the transient payload, and whatever they drop is
 * reported as `truncated`.
 */

/** SQLite's default limit on host parameters per statement is well above this. */
const CHUNK = 400;

/** Rows fetched per chunk; far more than one board can show, so ordering is safe. */
const ROW_LIMIT = 200;

/** Bare chat row of a task group. */
export interface RoomChatRow {
  chatId: number;
  title: string;
  participants: number[];
  /** UNIX seconds of the group's last message (or its creation, if none). */
  lastMessageAt: number;
  /** The conversation that spawned this group (its orchestration chat). */
  fromChatId: number | null;
}

/** Latest progress card observed for one task group. */
export interface RoomProgressRow {
  chatId: number;
  messageId: number;
  title: string;
  steps: MessageStep[];
  at: number;
}

/** Latest message one employee posted in a room while waking someone. */
export interface RoomBubbleRow {
  chatId: number;
  employeeId: number;
  messageId: number;
  kind: string;
  content: string;
  at: number;
}

interface RoomChatRaw {
  id: number;
  title: string;
  participants: string;
  last_message_at: number;
  created_at: number;
  from_chat_id: number | null;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function toRoomChatRow(row: RoomChatRaw): RoomChatRow {
  return {
    chatId: row.id,
    title: row.title,
    participants: parseNumberArray(row.participants),
    lastMessageAt: row.last_message_at || row.created_at,
    fromChatId: row.from_chat_id,
  };
}

/**
 * Task groups that may be in progress, most recently active first.
 *
 * - `candidateIds`: groups with an unfinished progress card, plus every chat
 *   with a live employee run in it;
 * - `parentIds`: root chats with a live run — their groups are candidates too,
 *   because the assistant's own run happens in the root chat, not in the group.
 */
export function listRoomChatCandidates(
  candidateIds: readonly number[],
  parentIds: readonly number[],
): RoomChatRow[] {
  const ids = [
    ...new Set(candidateIds.filter((id) => Number.isSafeInteger(id) && id > 0)),
  ];
  const parents = [
    ...new Set(parentIds.filter((id) => Number.isSafeInteger(id) && id > 0)),
  ];
  if (ids.length === 0 && parents.length === 0) return [];

  const idChunks = chunk(ids, CHUNK);
  const parentChunks = chunk(parents, CHUNK);
  const batches = Math.max(idChunks.length, parentChunks.length);
  const rows = new Map<number, RoomChatRaw>();

  for (let index = 0; index < batches; index += 1) {
    const idPart = idChunks[index] ?? [];
    const parentPart = parentChunks[index] ?? [];
    const conditions: string[] = [];
    const params: number[] = [];
    if (idPart.length > 0) {
      conditions.push(`id IN (${idPart.map(() => "?").join(",")})`);
      params.push(...idPart);
    }
    if (parentPart.length > 0) {
      conditions.push(
        `from_chat_id IN (${parentPart.map(() => "?").join(",")})`,
      );
      params.push(...parentPart);
    }
    const fetched = getDB()
      .prepare(
        "SELECT id, title, participants, last_message_at, created_at, from_chat_id " +
          "FROM chats WHERE from_chat_id IS NOT NULL " +
          `AND (${conditions.join(" OR ")}) ` +
          "ORDER BY last_message_at DESC, id DESC LIMIT ?",
      )
      .all(...params, ROW_LIMIT) as RoomChatRaw[];
    for (const row of fetched) rows.set(row.id, row);
  }

  return [...rows.values()]
    .sort(
      (a, b) =>
        (b.last_message_at || b.created_at) -
          (a.last_message_at || a.created_at) || b.id - a.id,
    )
    .slice(0, ROW_LIMIT)
    .map(toRoomChatRow);
}

/**
 * The newest progress card of every task group, keyed by the group it reports
 * on, walking the cards newest-first and keeping the first hit.
 *
 * Bounded by `idx_messages_progress` (partial index over `kind = 'progress'`) so
 * this scans cards, never the whole message table. It is also what decides which
 * groups can be in progress at all, so it must not be limited.
 */
export function listLatestProgressByGroup(): Map<number, RoomProgressRow> {
  const rows = getDB()
    .prepare(
      "SELECT id, content, steps, created_at FROM messages " +
        "WHERE kind = 'progress' ORDER BY id DESC",
    )
    .all() as Array<{
    id: number;
    content: string;
    steps: string | null;
    created_at: number;
  }>;
  const result = new Map<number, RoomProgressRow>();
  for (const row of rows) {
    const chatId = parseGroupChatId(row.steps);
    if (chatId === null || result.has(chatId)) continue;
    const steps = parseSteps(row.steps);
    if (steps === null || steps.length === 0) continue;
    result.set(chatId, {
      chatId,
      messageId: row.id,
      title: row.content,
      steps,
      at: row.created_at,
    });
  }
  return result;
}

/**
 * The newest notifying message of every sender, for the given task groups.
 *
 * "Notifying" = the message woke at least one participant, which is what the
 * room's message bubble is about. One grouped query rather than a newest-first
 * scan: a long-lived database accumulates notifying messages forever, and the
 * board only ever wants the last one per `(chat, sender)`. Bounded by
 * `idx_messages_notify` (partial index over `notify IS NOT NULL`).
 */
export function listLatestNotifyBySender(
  chatIds: readonly number[],
): RoomBubbleRow[] {
  const result: RoomBubbleRow[] = [];
  const ids = chatIds.filter((id) => Number.isSafeInteger(id) && id > 0);
  for (const part of chunk(ids, CHUNK)) {
    if (part.length === 0) continue;
    const rows = getDB()
      .prepare(
        `SELECT m.id, m.chat_id, m.sender_employee_id, m.kind, m.content, m.notify, m.created_at
           FROM messages m
           JOIN (
             SELECT chat_id, sender_employee_id, MAX(id) AS max_id
               FROM messages
              WHERE notify IS NOT NULL AND sender_employee_id IS NOT NULL
                AND chat_id IN (${part.map(() => "?").join(",")})
              GROUP BY chat_id, sender_employee_id
           ) latest ON latest.max_id = m.id`,
      )
      .all(...part) as Array<{
      id: number;
      chat_id: number;
      sender_employee_id: number | null;
      kind: string;
      content: string;
      notify: string | null;
      created_at: number;
    }>;
    for (const row of rows) {
      if (row.sender_employee_id === null) continue;
      if ((row.notify ?? "") === "") continue;
      result.push({
        chatId: row.chat_id,
        employeeId: row.sender_employee_id,
        messageId: row.id,
        kind: row.kind || "text",
        content: row.content,
        at: row.created_at,
      });
    }
  }
  return result;
}
