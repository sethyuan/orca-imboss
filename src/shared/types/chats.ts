import type { IntegrationPlatform } from "./integrations";

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
  /** Last message content, truncated (null when the chat has no messages). */
  preview: string | null;
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
  source: string | null;
  pinned: number;
  muted: number;
}

export interface ChatSummaryRow extends ChatRow {
  preview: string | null;
  last_at: number | null;
  last_message_at: number;
}
