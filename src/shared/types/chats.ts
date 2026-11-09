import type { IntegrationPlatform } from "./integrations";
import type { ChatPreview } from "./messages";

/** Summary view of a chat row (includes unread count). */
export interface Chat {
  id: number;
  title: string;
  participants: number[];
  unread: number;
  /** UNIX timestamp in seconds (all date-kind fields are INTEGER seconds). */
  createdAt: number;
  /** Id of the user chat that spawned this group chat, or null for a root chat. */
  fromChatId: number | null;
  /**
   * Employee this root chat is a **direct conversation** with
   * (`chats.direct_employee_id`), or null for any other conversation (the
   * boss ↔ assistant chat, a bridged chat, a task group chat). Its presence —
   * not the `participants` shape — is what makes the UI render that employee's
   * agent session instead of the chat's `messages`, and what routes
   * `chat:send` to that employee.
   */
  directEmployeeId: number | null;
  /**
   * Platform this conversation is bridged to (`null` for local-only chats).
   * Doubles as the conversation's platform label in the UI.
   */
  source: IntegrationPlatform | null;
  /** Pinned conversations sort above the rest of the list. */
  pinned: boolean;
  /**
   * Muted conversations still record unread, but their messages raise no OS
   * notification and no notification sound.
   */
  muted: boolean;
}

/** List item of the chat module: chat + derived last-message preview. */
export interface ChatSummary extends Chat {
  /**
   * One-line description of the chat's latest real message, extracted per
   * message kind (null when the chat has no message yet, or only app-generated
   * notices). The renderer turns it into the displayed line — see
   * `ChatPreview` for why extraction and presentation are split.
   */
  preview: ChatPreview | null;
  /** UNIX timestamp in seconds of the last message (null when the chat has no messages). */
  lastAt: number | null;
  /**
   * UNIX timestamp in seconds of the chat's last message (the recency sort
   * key). For a chat with no messages this falls back to its creation time.
   */
  lastMessageAt: number;
  /** User-assigned tags, normalized; empty when the chat has none. */
  tags: string[];
}

/** Participant edits applied in one call (additive/removal merge). */
export interface ChatParticipantUpdate {
  add?: number[];
  remove?: number[];
}

export interface ChatRow {
  id: number;
  title: string;
  participants: string;
  unread: number;
  created_at: number;
  from_chat_id: number | null;
  direct_employee_id: number | null;
  source: string | null;
  pinned: number;
  muted: number;
}

/**
 * Raw row behind a `ChatSummary`: the chat plus the payload columns of its
 * latest real message (all `null` when the chat has none). Keeping the payload
 * rather than a pre-built string is what lets the preview be derived per kind.
 */
export interface ChatSummaryRow extends ChatRow {
  last_kind: string | null;
  last_content: string | null;
  last_steps: string | null;
  last_attachments: string | null;
  last_comments: string | null;
  last_image_status: string | null;
  last_at: number | null;
  last_message_at: number;
}
