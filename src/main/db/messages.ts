import { chatPreviewBodyText } from "@shared/chat-preview";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL,
  MAX_USER_ATTACHMENTS,
} from "@shared/constants/attachments";
import type {
  AppendMessageOptions,
  ImageGenStatus,
  Message,
  MessageAttachment,
  MessageChangedPayload,
  MessageKind,
  MessageSearchResult,
  MessageStep,
} from "@shared/types";
import { sendToRenderer } from "../notifications";
import { bumpUnread, createChatTitleResolver, getChat } from "./chats";
import { getDB } from "./index";
import {
  MAX_ATTACH_PATH_LENGTH,
  parseAttachmentTotal,
  parseAttachments,
  parseGroupChatId,
  parseImageStatus,
  parseSteps,
  STEP_STATUSES,
} from "./message-payload";
import { escapeLike, toFtsPhrase } from "./text-search";

interface MessageRow {
  id: number;
  chat_id: number;
  sender_employee_id: number | null;
  kind: string;
  content: string;
  steps: string | null;
  attachments: string | null;
  image_status: string | null;
  image_model: string | null;
  created_at: number;
}

const MAX_CONTENT_LENGTH = 100_000;
const MAX_KIND_LENGTH = 64;
const MAX_STEPS = 64;
const MAX_ATTACHMENTS = MAX_USER_ATTACHMENTS;
const MAX_STEP_NAME_LENGTH = 256;
const MAX_STEP_TASK_LENGTH = 256;
const MAX_ATTACH_NAME_LENGTH = 256;
const MAX_ATTACH_TYPE_LENGTH = 128;
const MAX_ATTACH_SIZE = MAX_ATTACHMENT_BYTES; // metadata only

/**
 * Pictures kept on one image message. A re-roll appends, so the row doubles as
 * the history of its attempts; the cap keeps a long re-roll session from
 * growing the row (and the disk) without bound.
 */
const MAX_IMAGE_GENERATIONS = 6;

/** Cap for the `image_model` reference (`"<provider>/<modelId>"`). */
const MAX_IMAGE_MODEL_LENGTH = 256;

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
 * Distinct conversation ids referenced by a `chat` attachment on any
 * null-sender (user) message of a chat. Used by `imb_read_chat` to authorize a
 * `full` read: it is only allowed for a conversation the user attached to this
 * chat at some point in its history.
 */
export function listAttachedChatIds(chatId: number): number[] {
  const rows = getDB()
    .prepare(
      "SELECT attachments FROM messages WHERE chat_id = ? AND sender_employee_id IS NULL " +
        "AND attachments IS NOT NULL",
    )
    .all(chatId) as { attachments: string | null }[];
  const ids = new Set<number>();
  for (const row of rows) {
    for (const attachment of parseAttachments(row.attachments) ?? []) {
      if (
        attachment.kind === "chat" &&
        typeof attachment.chatId === "number" &&
        attachment.chatId > 0
      ) {
        ids.add(attachment.chatId);
      }
    }
  }
  return [...ids];
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
  // Image messages carry a lifecycle status; nothing else may set one.
  const imageStatus = options.imageStatus ?? null;
  if (imageStatus !== null) {
    if (kind !== "image") {
      throw new Error("Image status is only valid for image messages.");
    }
    if (
      imageStatus !== "generating" &&
      imageStatus !== "done" &&
      imageStatus !== "error"
    ) {
      throw new Error("Image status is invalid.");
    }
  }
  const imageModel = imageStatus === null ? null : (options.imageModel ?? null);
  if (imageModel !== null && imageModel.length > MAX_IMAGE_MODEL_LENGTH) {
    throw new Error("Image model reference is too long.");
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
  const attachments = validateMessageAttachments(options.attachments);
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
      "INSERT INTO messages (chat_id, sender_employee_id, kind, content, steps, attachments, image_status, image_model, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      chatId,
      senderEmployeeId,
      kind,
      content,
      stepsJson,
      attachmentsJson,
      imageStatus,
      imageModel,
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
  const changed: MessageChangedPayload = {
    chatId,
    senderEmployeeId,
    kind,
    silent: options.silent === true,
    root: chatRow.fromChatId === null,
    muted: (chatRow.muted ?? 0) === 1,
  };
  sendToRenderer("messages:changed", changed);

  const message = toMessage({
    id: Number(result.lastInsertRowid),
    chat_id: chatId,
    sender_employee_id: senderEmployeeId,
    kind,
    content,
    steps: stepsJson,
    attachments: attachmentsJson,
    image_status: imageStatus,
    image_model: imageModel,
    created_at: createdAt,
  });
  emitMessageAppended(message);
  return message;
}

/**
 * Finish an image-generation message: record the outcome — and the picture,
 * once it exists — without touching `content`, so the full-text index (whose
 * trigger only fires on a content change) is left alone.
 *
 * The renderer is told through the same `messages:changed` event every append
 * uses, so an open thread swaps its placeholder for the picture with no extra
 * channel. `silent` keeps the completion quiet: the placeholder already
 * announced the work, and one request should not beep twice.
 *
 * Returns the updated message, or `null` when the row no longer exists.
 */
export function updateImageGeneration(
  messageId: number,
  patch: {
    status: ImageGenStatus;
    /** The generated picture; omitted when the generation failed. */
    attachment?: MessageAttachment;
    /** Replaces the stored model ref (a re-roll may use a different one). */
    imageModel?: string;
  },
): Message | null {
  const db = getDB();
  const row = db
    .prepare("SELECT kind, attachments FROM messages WHERE id = ?")
    .get(messageId) as { kind: string; attachments: string | null } | undefined;
  if (!row) return null;
  if (row.kind !== "image") {
    throw new Error("Only image messages can be updated this way.");
  }

  // A new picture is appended, never substituted: re-drawing keeps the ones
  // before it, so the message becomes a stack the boss can flip through. Past
  // the cap the oldest are dropped — their files are the caller's to delete,
  // which it does by diffing the row before and after this call.
  const attachmentsJson = patch.attachment
    ? serializeAttachments(
        [...(parseAttachments(row.attachments) ?? []), patch.attachment].slice(
          -MAX_IMAGE_GENERATIONS,
        ),
        undefined,
      )
    : null;
  db.prepare(
    "UPDATE messages SET image_status = ?, " +
      "image_model = COALESCE(?, image_model), " +
      "attachments = COALESCE(?, attachments) " +
      "WHERE id = ?",
  ).run(patch.status, patch.imageModel ?? null, attachmentsJson, messageId);

  const updated = getMessageById(messageId);
  if (updated !== null) {
    const chat = getChat(updated.chatId);
    const changed: MessageChangedPayload = {
      chatId: updated.chatId,
      senderEmployeeId: updated.senderEmployeeId,
      kind: updated.kind,
      silent: true,
      root: chat === null || chat.fromChatId === null,
      muted: chat?.muted === true,
    };
    sendToRenderer("messages:changed", changed);
  }
  return updated;
}

/**
 * One search hit: the stored row's payload columns, before the excerpt is
 * derived. Kept private to this module.
 */
interface SearchRow {
  chatId: number;
  messageId: number;
  kind: string;
  content: string;
  steps: string | null;
  attachments: string | null;
  imageStatus: string | null;
  chatTitle: string;
  createdAt: number;
}

/** Columns read by both search paths — they must stay in sync. */
const SEARCH_COLUMNS =
  "m.chat_id AS chatId, m.id AS messageId, m.kind AS kind, m.content AS content, " +
  "m.steps AS steps, m.attachments AS attachments, " +
  "m.image_status AS imageStatus, c.title AS chatTitle, " +
  "m.created_at AS createdAt";

/**
 * Search messages by content. Queries of 3+ characters use the FTS5 trigram
 * index (ranked); shorter queries fall back to a LIKE substring scan so Chinese
 * 1-2 char queries still work. Returns up to `MAX_SEARCH_RESULTS` matches,
 * newest first in the LIKE path.
 *
 * The excerpt is derived from the **readable** text of the message (the same
 * per-kind extraction the chat list uses), not from the raw `content`: a hit
 * inside an `ask`/`answer`/`chat` card must never surface as a JSON or id
 * fragment. Both paths therefore share `toSearchResult`, and FTS still decides
 * *which* rows match and in what order.
 */
export function searchMessages(query: string): MessageSearchResult[] {
  const needle = query.trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
  if (needle.length === 0) return [];

  const db = getDB();
  // `chat` link cards are described by the linked conversation's title, which
  // needs a lookup; one resolver per search keeps it to one query per chat.
  const resolveChatTitle = createChatTitleResolver();
  if (needle.length < 3) {
    const pattern = `%${escapeLike(needle)}%`;
    const rows = db
      .prepare(
        `SELECT ${SEARCH_COLUMNS}
         FROM messages m JOIN chats c ON c.id = m.chat_id
         WHERE m.content LIKE ? ESCAPE '\\' AND m.kind <> 'ack'
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT ?`,
      )
      .all(pattern, MAX_SEARCH_RESULTS) as SearchRow[];
    return rows.map((row) => toSearchResult(row, needle, resolveChatTitle));
  }

  // Treat user input as a literal phrase: quote it and escape inner quotes.
  const phrase = toFtsPhrase(needle);
  const rows = db
    .prepare(
      `SELECT ${SEARCH_COLUMNS}
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN chats c ON c.id = m.chat_id
       WHERE messages_fts MATCH ? AND m.kind <> 'ack'
       ORDER BY rank
       LIMIT ?`,
    )
    .all(phrase, MAX_SEARCH_RESULTS) as SearchRow[];
  return rows.map((row) => toSearchResult(row, needle, resolveChatTitle));
}

function toSearchResult(
  row: SearchRow,
  needle: string,
  resolveChatTitle: (chatId: number) => string | null,
): MessageSearchResult {
  const kind = row.kind || "text";
  const body = chatPreviewBodyText({
    kind,
    content: row.content,
    steps: parseSteps(row.steps),
    attachments: parseAttachments(row.attachments),
    attachmentsTotal: parseAttachmentTotal(row.attachments),
    imageStatus: parseImageStatus(row.imageStatus),
    resolveChatTitle,
  });
  return {
    chatId: row.chatId,
    messageId: row.messageId,
    kind,
    chatTitle: row.chatTitle,
    snippet: excerpt(body.length > 0 ? body : row.content, needle),
    createdAt: row.createdAt,
  };
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
    imageStatus: parseImageStatus(row.image_status),
    imageModel: row.image_model ?? null,
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
    const task = String(step.task ?? "");
    if (name.length === 0 || name.length > MAX_STEP_NAME_LENGTH) {
      throw new Error("Progress step name has invalid length.");
    }
    if (task.length === 0 || task.length > MAX_STEP_TASK_LENGTH) {
      throw new Error("Progress step task has invalid length.");
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
    result.push({ name, task, status: step.status, employeeId });
  }
  return result;
}

/**
 * Validate a renderer-supplied attachment list and rebuild it field by field.
 *
 * The single source of truth for "what an attachment may contain": the
 * composer's `chat:send` path calls it before storing the message, and
 * `agentSession:send` calls it before handing the list to the model — a session
 * prompt is never stored, but the same trust boundary applies to what reaches
 * the agent (cap, name/type lengths, size, kind, an absolute-ish path, and a
 * conversation reference that still exists).
 */
export function validateMessageAttachments(
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
      if (
        item.kind !== "file" &&
        item.kind !== "folder" &&
        item.kind !== "chat"
      ) {
        throw new Error("Attachment kind is invalid.");
      }
      attachment.kind = item.kind;
    }
    if (item.path !== undefined) {
      if (attachment.kind === "chat") {
        throw new Error("A conversation attachment cannot have a path.");
      }
      if (
        typeof item.path !== "string" ||
        item.path.length === 0 ||
        item.path.length > MAX_ATTACH_PATH_LENGTH
      ) {
        throw new Error("Attachment path has invalid length.");
      }
      attachment.path = item.path;
    }
    if (attachment.kind === "chat") {
      // A conversation attachment is a reference, not a file: it must carry a
      // valid chat id that still exists at write time (deleting the referenced
      // chat later only degrades the chip; there is no cascade).
      const chatId = item.chatId;
      if (
        typeof chatId !== "number" ||
        !Number.isSafeInteger(chatId) ||
        chatId <= 0
      ) {
        throw new Error("Conversation attachment needs a valid chat id.");
      }
      if (!getChat(chatId)) {
        throw new Error("Conversation attachment references a missing chat.");
      }
      attachment.chatId = chatId;
    } else if (item.chatId !== undefined) {
      throw new Error("Only a conversation attachment may carry a chat id.");
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

/**
 * Excerpt of `content` around the first (case-insensitive) match, with the
 * match wrapped in the markers the search UI highlights (`«`/`»`). Without a
 * match (the needle only appeared in a payload part that is not part of the
 * readable text) it degrades to a plain head of the text.
 */
function excerpt(content: string, needle: string): string {
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
