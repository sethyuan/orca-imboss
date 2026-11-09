/**
 * Free-form message kind. The UI only special-cases `progress`; other kinds
 * (e.g. `text`, `report`, `chat`, `join_notice`) are routed through the generic
 * bubble. `report` is a free-form result summary (employee → assigner, or
 * assistant → boss for the final summary). `ack` is the app-generated receipt
 * acknowledgement posted immediately after a user message; its display text is
 * localized at render time and its stored content is empty. `interrupted` records
 * that the boss halted a task group; `error` is the app-generated notice that an
 * agent run failed (its `content` carries the raw technical detail, while the
 * renderer shows a localized label). Both system kinds are written with a `null`
 * sender, so they never bump unread and are never forwarded to an IM platform.
 */
export type MessageKind = string;

/** Lifecycle of an image-generation message (`kind === "image"`). */
export type ImageGenStatus = "generating" | "done" | "error";

export type StepStatus = "done" | "busy" | "pending";

/** One row of a progress card payload (kind = `progress`). */
export interface MessageStep {
  name: string;
  /**
   * What this employee does on this step, as a short phrase (e.g. "write the
   * migration"). Written by the assistant when it publishes the card; it says
   * nothing about the employee's role/title.
   */
  task: string;
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
   * path. Used to reveal the file in the OS file manager and to tell the model
   * where to read the attachment.
   */
  path?: string;
  /**
   * `"folder"` for a directory attachment, `"chat"` for a reference to an
   * existing conversation; absent means a regular file. When a folder is chosen
   * from the picker, `size` is `0` and `type` is `"folder"`; a chat attachment
   * carries `size` `0`, `type` `"chat"` and a `chatId` (no `path`).
   */
  kind?: "file" | "folder" | "chat";
  /**
   * Referenced conversation id; only set when `kind` is `"chat"`. The agent
   * reads it in full with `imb_read_chat` (`full: true`); it is never a
   * filesystem path.
   */
  chatId?: number;
}

/**
 * Which earlier rendered block a comment points at.
 *
 * Two shapes, because the two surfaces that offer commenting address their rows
 * differently:
 * - `message`: a stored chat message, by its row id (the chat thread);
 * - `entry`: a Pi session entry, by its (string) entry id (the agent-session
 *   view and an employee direct chat, which render the session transcript).
 *   Those prompts are never written to `messages`, so there is no row to point
 *   at.
 */
export type CommentTarget =
  { kind: "message"; messageId: number } | { kind: "entry"; entryId: string };

/**
 * Where one comment sits inside the message it annotates.
 *
 * The anchor is **two anchors in one**: character offsets into the message's
 * *rendered* plain text (cheap, exact, and what the inline highlight uses), plus
 * the quoted text itself (the fallback when the rendering drifted, and the part
 * the model reads). Consumers must try the offsets, fall back to
 * `quote` + `occurrence`, and give up on the highlight rather than guess wrong —
 * see `renderer/components/modules/chat/comment-layer/anchor-text.ts`.
 *
 * **Quote-only anchors:** `start === -1`, `end === -1`, `occurrence === 0` and
 * `textLength === -1` together mean "no offsets known" — the state of an anchor
 * recovered from a prompt's `[Comments]` block (`promptCommentToMessageComment`),
 * which carries the quote but not the offsets. Such an anchor is always resolved
 * by searching the quote inside the named target. Partial sentinels are invalid.
 */
export interface CommentAnchor {
  /** The annotated block. */
  target: CommentTarget;
  /**
   * The selected passage, as rendered (whitespace-normalized, trimmed, capped
   * at `MAX_COMMENT_QUOTE_LENGTH`).
   */
  quote: string;
  /** Start offset in the target's rendered plain text (inclusive). */
  start: number;
  /** End offset in the target's rendered plain text (exclusive). */
  end: number;
  /**
   * Which occurrence of `quote` inside the target this is (0-based). Only used
   * when the offsets no longer line up; 0 for the common case.
   */
  occurrence: number;
  /**
   * Length of the target's rendered plain text when the comment was written: a
   * mismatch means the rendering changed, so the offsets are not trusted and
   * the quote fallback takes over.
   */
  textLength: number;
}

/**
 * One comment attached to a message: a passage of an earlier message plus what
 * the boss wrote about it.
 *
 * Ids are **not** stored: a comment is addressed by its position in the list
 * (`#1`, `#2`, … within the prompt block that carried it), which is what the
 * agent quotes back when it answers it. See `src/main/comment-prompt.ts`.
 */
export interface MessageComment {
  anchor: CommentAnchor;
  /** What the boss wrote (multi-line; stored verbatim, capped). */
  note: string;
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
   * Comments the sender attached to this message (`null` when it carries none).
   *
   * A comment annotates a passage of an *earlier* message and rides along with
   * this one: the row is where the annotation is stored, and the same list is
   * written into the agent prompt's `[Comments]` block. Only a user message ever
   * carries comments (an agent has no UI to write one).
   */
  comments: MessageComment[] | null;
  /**
   * True number of attachments the sender produced. May exceed
   * `attachments.length` when an agent only forwarded the first few; `null`
   * when the message has no attachments.
   */
  attachmentsTotal: number | null;
  /**
   * Present for `kind === "image"` messages: whether the picture is still being
   * generated, finished, or failed. `null` for every other kind.
   */
  imageStatus: ImageGenStatus | null;
  /**
   * `"<provider>/<modelId>"` that produced (or is producing) the picture, so a
   * re-roll can report and reuse it. `null` for every other kind.
   */
  imageModel: string | null;
  /** UNIX timestamp in seconds. */
  createdAt: number;
}

/**
 * Payload of the `messages:changed` broadcast (`src/main/db/messages.ts`): one
 * message was appended, or an image message was updated. It carries just enough
 * for the renderer to refresh that chat's summary and gate the notification
 * beep without another IPC read.
 */
export interface MessageChangedPayload {
  chatId: number;
  senderEmployeeId: number | null;
  /**
   * Kind of the message. Optional so a payload written before it was added
   * still type-checks; `progress` is the one the beep rule treats specially.
   */
  kind?: MessageKind;
  /** App-generated (no beep, no unread bump — unread is main-side anyway). */
  silent?: boolean;
  /** Root chat (a task group chat never beeps). */
  root: boolean;
  /** The chat is muted: unread is kept, notifications are dropped. */
  muted: boolean;
}

/** One hit from `messages:search` (FTS index or LIKE fallback). */
export interface MessageSearchResult {
  chatId: number;
  messageId: number;
  /** Kind of the matching message, so a caller can label the hit per card type. */
  kind: MessageKind;
  chatTitle: string;
  /**
   * Readable excerpt of the message with the match wrapped in `«`/`»` markers.
   * Derived from the same per-kind extraction the chat list uses, so a card
   * payload (e.g. an `ask` JSON) never shows up as raw JSON here either.
   */
  snippet: string;
  /** UNIX timestamp in seconds. */
  createdAt: number;
}

/**
 * One-line description of a message, as shown under a chat's title in the chat
 * list (and in the composer's conversation picker).
 *
 * The payload is **extracted** in the main process (`buildChatPreview`, no
 * localization, no formatting) and **presented** by the renderer
 * (`preview-text.ts`: labels via `t()`, Markdown flattening, mentions,
 * truncation). Keeping the two apart is what makes a live language switch take
 * effect immediately, exactly like every other renderer string.
 *
 * Optional fields are only present for the kind that defines them; consumers
 * must treat a missing field as "not applicable" and stay defensive about
 * unknown kinds (a preview is only a teaser and must never break the list).
 */
export interface ChatPreview {
  /** Message kind; the extractor falls back to `text` for unknown values. */
  kind: MessageKind;
  /**
   * Primary human-readable text of the message (plain body, report, progress
   * card title, image prompt, …), clamped to a preview-sized length.
   *
   * Empty when the kind is described by something else: `ask`/`answer` cards by
   * their counters, a `chat` link card by its linked conversation. It is also
   * the *only* place a card's raw payload survives — an `ask`/`answer` payload
   * that cannot be parsed keeps its stored bytes here so the list still shows
   * something instead of an empty line.
   */
  text: string;
  /** `ask`: number of questions in the card (>= 1). */
  questionCount?: number;
  /** `answer`: number of answered items (>= 1). */
  answerCount?: number;
  /**
   * Comments this message was sent with (>= 1). A send that carried only
   * comments has no text at all, so this is what the list renders instead (the
   * label is localized by the renderer).
   */
  commentCount?: number;
  /** `progress`: how many of the card's steps are `done`. */
  stepsDone?: number;
  /** `progress`: number of steps on the card. */
  stepsTotal?: number;
  /**
   * `chat`: the linked conversation. `linkChatTitle` is `null` when that
   * conversation no longer exists and `""` when it exists without a title.
   */
  linkChatId?: number;
  linkChatTitle?: string | null;
  /** `image`: picture lifecycle, drives the label prefix. */
  imageStatus?: ImageGenStatus;
  /** Attachments on the message (the true total, not the forwarded subset). */
  attachmentCount?: number;
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
  /**
   * Comments this message carries (see `Message.comments`). Anchors are
   * resolved against the same chat, so a target that does not exist there is
   * rejected rather than stored as a dead reference.
   */
  comments?: MessageComment[];
  attachments?: MessageAttachment[];
  /**
   * True attachment count when it exceeds `attachments.length` (agent tools
   * that forward only the first `MAX_TOOL_ATTACHMENTS` paths). Defaults to
   * `attachments.length`.
   */
  attachmentTotal?: number;
  /**
   * Mark this message as an image generation (`kind: "image"`): `"generating"`
   * while the model runs, then updated through `updateImageGeneration`.
   */
  imageStatus?: ImageGenStatus;
  /** `"<provider>/<modelId>"` producing the picture (image messages only). */
  imageModel?: string;
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
  /** Comments that ride along with this send (delivered in the same prompt). */
  comments?: MessageComment[];
}
