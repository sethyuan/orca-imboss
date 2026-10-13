/**
 * Free-form message kind. The UI only special-cases `progress`; other kinds
 * (e.g. `text`, `report`, `chat`, `join_notice`) are routed through the generic
 * bubble. `report` is a free-form result summary (employee → assigner, or
 * assistant → boss for the final summary). `ack` is the app-generated receipt
 * acknowledgement posted immediately after a user message; its display text is
 * localized at render time and its stored content is empty.
 */
export type MessageKind = string;

export type StepStatus = "done" | "busy" | "pending";

/** One row of a progress card payload (kind = `progress`). */
export interface MessageStep {
  name: string;
  role: string;
  status: StepStatus;
  /**
   * The employee this step tracks, so the card can link to their agent
   * session. `null` for steps stored before the field existed (or written by
   * a producer that did not supply one); such rows render non-clickable.
   */
  employeeId: number | null;
}

/** Attachment metadata attached to a (user) message. */
export interface MessageAttachment {
  name: string;
  size: number;
  type: string;
  /**
   * Absolute on-disk path of the original file, when known. Captured from the
   * file picker (`webUtils.getPathForFile`) or resolved from a tool-supplied
   * path. Used to reveal the file in the OS file manager; never shown to the
   * model.
   */
  path?: string;
}

/** Row of the `messages` table, ordered per chat by `created_at`. */
export interface Message {
  /** Global row id (monotonic; breaks same-second ties on ordering). */
  id: number;
  chatId: number;
  /** `null` when sent by the user or by the system. */
  senderEmployeeId: number | null;
  kind: MessageKind;
  content: string;
  /** Present when `kind` is `progress`. */
  steps: MessageStep[] | null;
  /**
   * The task group chat this `progress` card reports on; the UI links the card
   * (and its steps) to that conversation. `null` for messages stored before
   * the field existed or when the producer supplied no link.
   */
  groupChatId: number | null;
  /** Present when the message carries attachments. */
  attachments: MessageAttachment[] | null;
  /**
   * True number of attachments the sender produced. May exceed
   * `attachments.length` when an agent only forwarded the first few; `null`
   * when the message has no attachments.
   */
  attachmentsTotal: number | null;
  /** UNIX timestamp in seconds. */
  createdAt: number;
}

/** One hit from `messages:search` (FTS index or LIKE fallback). */
export interface MessageSearchResult {
  chatId: number;
  messageId: number;
  chatTitle: string;
  /** Content excerpt with the match wrapped in `«`/`»` markers. */
  snippet: string;
  /** UNIX timestamp in seconds. */
  createdAt: number;
}

/** Optional payload for `appendMessage` (all fields validated by the service). */
export interface AppendMessageOptions {
  kind?: MessageKind;
  steps?: MessageStep[];
  /**
   * Task group a `progress` card links to (stored alongside `steps` in the
   * `steps` column). Required for `kind === "progress"`.
   */
  groupChatId?: number;
  attachments?: MessageAttachment[];
  /**
   * True attachment count when it exceeds `attachments.length` (agent tools
   * that forward only the first `MAX_MESSAGE_ATTACHMENTS` paths). Defaults to
   * `attachments.length`.
   */
  attachmentTotal?: number;
  /**
   * Suppress the unread bump and the renderer's notification beep for this
   * message (app-generated acks are silent receipts). The `messages:changed`
   * event carries the flag so the renderer can skip the sound.
   */
  silent?: boolean;
}

/** Payload of the `chat:send` IPC (user → assistant placeholder pipeline). */
export interface SendChatPayload {
  chatId: number;
  content: string;
  attachments?: MessageAttachment[];
}
