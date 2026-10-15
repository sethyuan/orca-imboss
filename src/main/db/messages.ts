import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL,
  MAX_USER_ATTACHMENTS,
} from "@shared/constants/attachments";
import type {
  AppendMessageOptions,
  Message,
  MessageAttachment,
  MessageKind,
  MessageSearchResult,
  MessageStep,
  StepStatus,
} from "@shared/types";
import { sendToRenderer } from "../notifications";
import { bumpUnread } from "./chats";
import { getDB } from "./index";
import { parseJsonObject } from "./json";
import { escapeLike, toFtsPhrase } from "./text-search";

interface MessageRow {
  id: number;
  chat_id: number;
  sender_employee_id: number | null;
  kind: string;
  content: string;
  steps: string | null;
  attachments: string | null;
  created_at: number;
}

const MAX_CONTENT_LENGTH = 100_000;
const MAX_KIND_LENGTH = 64;
const MAX_STEPS = 64;
const MAX_ATTACHMENTS = MAX_USER_ATTACHMENTS;
const MAX_STEP_NAME_LENGTH = 256;
const MAX_STEP_ROLE_LENGTH = 256;
const MAX_ATTACH_NAME_LENGTH = 256;
const MAX_ATTACH_TYPE_LENGTH = 128;
const MAX_ATTACH_PATH_LENGTH = 4096;
const MAX_ATTACH_SIZE = MAX_ATTACHMENT_BYTES; // metadata only

/**
 * Synchronous observers notified after every successful `appendMessage`.
 * Used by the IM integrations manager to forward agent output to a linked
 * platform. Listeners must never throw and must not block the insert path —
 * asynchronous work is the listener's responsibility (fire-and-forget).
 */
type MessageAppendedListener = (message: Message) => void;
const appendedListeners = new Set<MessageAppendedListener>();

/** Register an append observer; returns an unsubscribe function. */
export function onMessageAppended(
  listener: MessageAppendedListener,
): () => void {
  appendedListeners.add(listener);
  return () => {
    appendedListeners.delete(listener);
  };
}

function emitMessageAppended(message: Message): void {
  for (const listener of appendedListeners) {
    try {
      listener(message);
    } catch (err) {
      console.error(
        "[messages] append listener failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

const STEP_STATUSES: StepStatus[] = ["done", "busy", "pending"];

/**
 * Kinds whose payload may carry the `steps` blob's `chatId` link to a task
 * group: the progress card (reports on a group) and the app-generated
 * `interrupted` notice (records that the boss halted a group).
 */
const GROUP_LINK_KINDS = new Set<string>(["progress", "interrupted"]);

const MAX_SEARCH_QUERY_LENGTH = 200;
const MAX_SEARCH_RESULTS = 50;

/** List a chat's messages in conversation order (`created_at` ascending; `id` breaks same-second ties). */
export function listMessages(chatId: number): Message[] {
  return (
    getDB()
      .prepare(
        "SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(chatId) as MessageRow[]
  ).map(toMessage);
}

/**
 * List new messages after a read cursor (`id > afterId`), in conversation
 * order, with an optional page cap the caller re-invokes with to page through.
 */
export function listMessagesAfter(
  chatId: number,
  afterId: number,
  limit = 100,
): Message[] {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  return (
    getDB()
      .prepare(
        "SELECT * FROM messages WHERE chat_id = ? AND id > ? " +
          "ORDER BY created_at ASC, id ASC LIMIT ?",
      )
      .all(chatId, afterId, safeLimit) as MessageRow[]
  ).map(toMessage);
}

/** Fetch a single message by its global row id, or null when absent. */
export function getMessageById(id: number): Message | null {
  const row = getDB().prepare("SELECT * FROM messages WHERE id = ?").get(id) as
    MessageRow | undefined;
  return row ? toMessage(row) : null;
}

/**
 * Append one message at the end of the chat. The row id is global and
 * monotonically increasing, so per-chat conversation order is simply
 * `created_at ASC, id ASC` (id breaks same-second ties); writes are already
 * serialized on the main-process event loop (synchronous driver).
 *
 * Messages from employees (sender_employee_id != NULL) also bump the chat's
 * unread counter (root chats only — task group chats never record unread);
 * opening a chat clears it via `chats:markRead`.
 */
export function appendMessage(
  chatId: number,
  senderEmployeeId: number | null,
  content: string,
  options: AppendMessageOptions = {},
): Message {
  const db = getDB();
  // Resolve the kind first: the app-generated receipt ack is the one kind that
  // legitimately stores empty content (its text is localized at render time).
  const kind: MessageKind = options.kind ?? "text";
  if (
    typeof kind !== "string" ||
    kind.length === 0 ||
    kind.length > MAX_KIND_LENGTH
  ) {
    throw new Error("Message kind is invalid.");
  }
  if (typeof content !== "string") {
    throw new Error("Message content must be a string.");
  }
  if (content.length === 0 && kind !== "ack") {
    throw new Error("Message content must be a non-empty string.");
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error("Message is too long.");
  }
  // Resolve the owning chat's root/group nature and mute flag while validating
  // it: the renderer gates the notification beep on root, unmuted chats, and
  // this is the synchronous place that knows both (no extra IPC round-trip).
  const chatRow = db
    .prepare("SELECT from_chat_id AS fromChatId, muted FROM chats WHERE id = ?")
    .get(chatId) as { fromChatId: number | null; muted: number } | undefined;
  if (!chatRow) {
    throw new Error("Chat does not exist.");
  }
  if (
    senderEmployeeId != null &&
    !db.prepare("SELECT 1 FROM employees WHERE id = ?").get(senderEmployeeId)
  ) {
    throw new Error("Sender employee does not exist.");
  }
  const steps = validateSteps(options.steps);
  if (kind === "progress" && (steps === undefined || steps.length === 0)) {
    throw new Error("Progress messages need at least one step.");
  }
  const groupChatId = validateGroupChatId(options.groupChatId);
  if (kind === "progress" && groupChatId === undefined) {
    throw new Error("Progress messages need a linked group chat.");
  }
  if (!GROUP_LINK_KINDS.has(kind) && groupChatId !== undefined) {
    // Only kinds whose payload links to a task group may carry one; reject
    // rather than silently drop a link the caller explicitly supplied.
    throw new Error("This message kind cannot carry a linked group chat.");
  }
  if (groupChatId !== undefined) {
    const linked = db
      .prepare("SELECT 1 FROM chats WHERE id = ?")
      .get(groupChatId);
    if (!linked) throw new Error("Linked group chat does not exist.");
  }
  const attachments = validateAttachments(options.attachments);
  const attachmentTotal = validateAttachmentTotal(
    options.attachmentTotal,
    attachments,
  );

  const createdAt = Math.floor(Date.now() / 1000);
  const attachmentsJson = serializeAttachments(attachments, attachmentTotal);
  // The `steps` column also carries the task-group link; write the blob when
  // either is present (an `interrupted` notice has the link but no steps).
  const stepsJson =
    steps !== undefined || groupChatId !== undefined
      ? serializeSteps(steps, groupChatId)
      : null;
  const result = db
    .prepare(
      "INSERT INTO messages (chat_id, sender_employee_id, kind, content, steps, attachments, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      chatId,
      senderEmployeeId,
      kind,
      content,
      stepsJson,
      attachmentsJson,
      createdAt,
    );

  // Unread bump lives here (single append write path): assistant/employee
  // messages mark the chat as unread; user messages do not. Silent messages
  // (the app-generated receipt ack) never bump the counter. Task group chats
  // (fromChatId !== null) never record unread — the badge is root-chat only
  // and group chats track reads via read_cursors.
  if (
    senderEmployeeId != null &&
    options.silent !== true &&
    chatRow.fromChatId === null
  ) {
    bumpUnread(chatId);
  }

  // Bump the chat's last-message timestamp so the list order reflects the
  // write, then notify the renderer centrally (the single append path). The
  // sender and the mute flag are carried so the renderer can gate a beep on
  // non-user sends from unmuted chats.
  db.prepare("UPDATE chats SET last_message_at = ? WHERE id = ?").run(
    createdAt,
    chatId,
  );
  sendToRenderer("messages:changed", {
    chatId,
    senderEmployeeId,
    silent: options.silent === true,
    root: chatRow.fromChatId === null,
    muted: (chatRow.muted ?? 0) === 1,
  });

  const message = toMessage({
    id: Number(result.lastInsertRowid),
    chat_id: chatId,
    sender_employee_id: senderEmployeeId,
    kind,
    content,
    steps: stepsJson,
    attachments: attachmentsJson,
    created_at: createdAt,
  });
  emitMessageAppended(message);
  return message;
}

/**
 * Search messages by content. Queries of 3+ characters use the FTS5 trigram
 * index (ranked, highlighted snippet); shorter queries fall back to a LIKE
 * substring scan so Chinese 1-2 char queries still work. Returns up to
 * `MAX_SEARCH_RESULTS` matches, newest first in the LIKE path.
 */
export function searchMessages(query: string): MessageSearchResult[] {
  const needle = query.trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
  if (needle.length === 0) return [];

  const db = getDB();
  if (needle.length < 3) {
    const pattern = `%${escapeLike(needle)}%`;
    const rows = db
      .prepare(
        `SELECT m.chat_id AS chatId, m.id AS messageId, m.created_at AS createdAt,
                m.content AS content, c.title AS chatTitle
         FROM messages m JOIN chats c ON c.id = m.chat_id
         WHERE m.content LIKE ? ESCAPE '\\' AND m.kind <> 'ack'
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ?`,
      )
      .all(pattern, MAX_SEARCH_RESULTS) as Array<{
      chatId: number;
      messageId: number;
      createdAt: number;
      content: string;
      chatTitle: string;
    }>;
    return rows.map((row) => ({
      chatId: row.chatId,
      messageId: row.messageId,
      chatTitle: row.chatTitle,
      snippet: likeSnippet(row.content, needle),
      createdAt: row.createdAt,
    }));
  }

  // Treat user input as a literal phrase: quote it and escape inner quotes.
  const phrase = toFtsPhrase(needle);
  const rows = db
    .prepare(
      `SELECT m.chat_id AS chatId, m.id AS messageId, m.created_at AS createdAt,
              c.title AS chatTitle,
              snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN chats c ON c.id = m.chat_id
       WHERE messages_fts MATCH ? AND m.kind <> 'ack'
       ORDER BY rank
       LIMIT ?`,
    )
    .all(phrase, MAX_SEARCH_RESULTS) as MessageSearchResult[];
  return rows;
}

function toMessage(row: MessageRow): Message {
  const attachments = parseAttachments(row.attachments);
  return {
    id: row.id,
    chatId: row.chat_id,
    senderEmployeeId: row.sender_employee_id,
    kind: row.kind || "text",
    content: row.content,
    steps: parseSteps(row.steps),
    groupChatId: parseGroupChatId(row.steps),
    attachments,
    attachmentsTotal:
      attachments === null
        ? null
        : Math.max(
            parseAttachmentTotal(row.attachments) ?? attachments.length,
            attachments.length,
          ),
    createdAt: row.created_at,
  };
}

/**
 * Serialize a linked payload: an optional step list (progress cards) plus the
 * task group it links to. Stored as one object so the link rides along without
 * a schema change — the same shape the `attachments` column uses for its
 * `total`. An `interrupted` notice carries only the `chatId` link (no steps).
 */
function serializeSteps(
  steps: MessageStep[] | undefined,
  groupChatId: number | undefined,
): string {
  const payload: { steps?: MessageStep[]; chatId?: number } = {};
  if (steps !== undefined) payload.steps = steps;
  if (groupChatId !== undefined) payload.chatId = groupChatId;
  return JSON.stringify(payload);
}

/**
 * Read the optional linked group chat id stored alongside the step list.
 * Stored values are never trusted: only a safe positive integer surfaces,
 * anything else (including absence) becomes `null`.
 */
function parseGroupChatId(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = parseJsonObject(raw);
  const id = parsed["chatId"];
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

function parseSteps(raw: string | null): MessageStep[] | null {
  if (!raw) return null;
  const parsed = parseJsonObject(raw);
  const steps = parsed["steps"];
  if (!Array.isArray(steps)) return null;
  const result: MessageStep[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const record = step as Record<string, unknown>;
    if (
      typeof record["name"] !== "string" ||
      typeof record["role"] !== "string" ||
      !STEP_STATUSES.includes(record["status"] as StepStatus)
    ) {
      continue;
    }
    result.push({
      name: record["name"],
      role: record["role"],
      status: record["status"] as StepStatus,
      employeeId:
        typeof record["employeeId"] === "number" &&
        Number.isSafeInteger(record["employeeId"]) &&
        record["employeeId"] >= 0
          ? record["employeeId"]
          : null,
    });
  }
  return result;
}

/**
 * Parse a stored attachments JSON. Stored values are never trusted: entries
 * are validated field by field and invalid ones dropped; `null` is stored as
 * null and only ever surfaces as `[]` when the column held a valid array.
 */
function parseAttachments(raw: string | null): MessageAttachment[] | null {
  if (!raw) return null;
  const parsed = parseJsonObject(raw);
  const list = parsed["attachments"];
  if (!Array.isArray(list)) return null;
  const result: MessageAttachment[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record["name"] !== "string" || record["name"].length === 0) {
      continue;
    }
    const path = record["path"];
    const kind = record["kind"];
    result.push({
      name: record["name"],
      size: typeof record["size"] === "number" ? record["size"] : 0,
      type: typeof record["type"] === "string" ? record["type"] : "",
      ...(typeof path === "string" &&
      path.length > 0 &&
      path.length <= MAX_ATTACH_PATH_LENGTH
        ? { path }
        : {}),
      ...(kind === "file" || kind === "folder" ? { kind } : {}),
    });
  }
  return result;
}

/**
 * Read the optional true attachment `total` stored alongside an attachments
 * payload. Returns `null` when absent or invalid; the caller falls back to the
 * number of rows actually stored.
 */
function parseAttachmentTotal(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = parseJsonObject(raw);
  const total = parsed["total"];
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    return null;
  }
  return total;
}

/**
 * Serialize attachment metadata (and the true total when it exceeds the rows
 * actually stored) into the single `attachments` column.
 */
function serializeAttachments(
  attachments: MessageAttachment[] | undefined,
  total: number | undefined,
): string | null {
  if (attachments === undefined) return null;
  const payload: { attachments: MessageAttachment[]; total?: number } = {
    attachments,
  };
  if (total !== undefined && total > attachments.length) payload.total = total;
  return JSON.stringify(payload);
}

/**
 * Validate the linked group chat id of a progress payload: a safe positive
 * integer. Existence is checked by the caller (which has the `db` handle);
 * `undefined` means "no link supplied" and is an error only where required.
 */
function validateGroupChatId(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Linked group chat id is invalid.");
  }
  return value;
}

function validateSteps(
  steps: MessageStep[] | undefined,
): MessageStep[] | undefined {
  if (steps === undefined) return undefined;
  if (!Array.isArray(steps)) throw new Error("steps must be an array.");
  if (steps.length > MAX_STEPS) throw new Error("Too many progress steps.");
  const result: MessageStep[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) {
      throw new Error("Invalid progress step.");
    }
    const name = String(step.name ?? "");
    const role = String(step.role ?? "");
    if (name.length === 0 || name.length > MAX_STEP_NAME_LENGTH) {
      throw new Error("Progress step name has invalid length.");
    }
    if (role.length > MAX_STEP_ROLE_LENGTH) {
      throw new Error("Progress step role is too long.");
    }
    if (!STEP_STATUSES.includes(step.status)) {
      throw new Error("Progress step status must be done, busy, or pending.");
    }
    // Steps link to an agent session, so the employee must be resolvable at
    // write time; a dangling id would render a dead click target forever.
    const employeeId = step.employeeId;
    if (
      typeof employeeId !== "number" ||
      !Number.isSafeInteger(employeeId) ||
      employeeId < 0
    ) {
      throw new Error("Progress step needs a valid employeeId.");
    }
    if (
      !getDB().prepare("SELECT 1 FROM employees WHERE id = ?").get(employeeId)
    ) {
      throw new Error("Progress step employee does not exist.");
    }
    result.push({ name, role, status: step.status, employeeId });
  }
  return result;
}

function validateAttachments(
  attachments: MessageAttachment[] | undefined,
): MessageAttachment[] | undefined {
  if (attachments === undefined) return undefined;
  if (!Array.isArray(attachments)) {
    throw new Error("attachments must be an array.");
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error("Too many attachments.");
  }
  const result: MessageAttachment[] = [];
  for (const item of attachments) {
    if (typeof item !== "object" || item === null) {
      throw new Error("Invalid attachment.");
    }
    const name = String(item.name ?? "");
    if (name.length === 0 || name.length > MAX_ATTACH_NAME_LENGTH) {
      throw new Error("Attachment name has invalid length.");
    }
    if (
      typeof item.size !== "number" ||
      !Number.isFinite(item.size) ||
      item.size < 0 ||
      item.size > MAX_ATTACH_SIZE
    ) {
      throw new Error("Attachment size is out of range.");
    }
    const type = String(item.type ?? "");
    if (type.length > MAX_ATTACH_TYPE_LENGTH) {
      throw new Error("Attachment type is too long.");
    }
    const attachment: MessageAttachment = { name, size: item.size, type };
    if (item.kind !== undefined) {
      if (item.kind !== "file" && item.kind !== "folder") {
        throw new Error("Attachment kind is invalid.");
      }
      attachment.kind = item.kind;
    }
    if (item.path !== undefined) {
      if (
        typeof item.path !== "string" ||
        item.path.length === 0 ||
        item.path.length > MAX_ATTACH_PATH_LENGTH
      ) {
        throw new Error("Attachment path has invalid length.");
      }
      attachment.path = item.path;
    }
    result.push(attachment);
  }
  return result;
}

/**
 * Validate the tool-supplied true attachment count. It must be an integer
 * between the number of rows actually stored and `MAX_ATTACHMENT_TOTAL`; when
 * omitted it defaults to the number of stored rows. The total is only
 * meaningful alongside attachments.
 */
function validateAttachmentTotal(
  total: number | undefined,
  attachments: MessageAttachment[] | undefined,
): number | undefined {
  if (attachments === undefined) {
    if (total !== undefined) {
      throw new Error("attachmentTotal requires attachments.");
    }
    return undefined;
  }
  if (total === undefined) return attachments.length;
  if (
    !Number.isSafeInteger(total) ||
    total < attachments.length ||
    total > MAX_ATTACHMENT_TOTAL
  ) {
    throw new Error("Attachment total is out of range.");
  }
  return total;
}

/** Wrap the first (case-insensitive) match in the same markers FTS uses. */
function likeSnippet(content: string, needle: string): string {
  const lower = content.toLowerCase();
  const at = lower.indexOf(needle.toLowerCase());
  if (at < 0) {
    return content.length > 80 ? `${content.slice(0, 80)}…` : content;
  }
  const start = Math.max(0, at - 24);
  const end = Math.min(content.length, at + needle.length + 40);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, at)}«${content.slice(at, at + needle.length)}»${content.slice(at + needle.length, end)}${suffix}`;
}
