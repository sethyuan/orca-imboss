import type { Message, MessageAttachment } from "./types";

/**
 * Portable description of a conversation handed from one chat to another.
 *
 * The document is written as a JSON attachment on the handoff message, so the
 * agents in the receiving conversation can read the whole transcript with their
 * ordinary file tools — the delivered prompt carries the attachment's absolute
 * path, which is all the built-in file tooling needs.
 *
 * The schema is versioned and self-describing: a reader should reject a
 * `schema` it does not recognise rather than guess, and tolerate unknown fields
 * within a version it does know.
 */

export const HANDOFF_SCHEMA = "imboss.chat-handoff";
export const HANDOFF_SCHEMA_VERSION = 1;

/**
 * Newest messages kept in one handoff. A long-running conversation should not
 * produce a payload no agent can read in one go; `source.messageCount` still
 * reports the true total, so a reader can tell that it was truncated.
 */
export const MAX_HANDOFF_MESSAGES = 1000;

/** Name recorded for a message the boss sent (`senderEmployeeId === null`). */
export const HANDOFF_BOSS_NAME = "User";

/** Who sent one shared message. */
export interface HandoffSender {
  /** Employee id, or `null` for the boss. */
  id: number | null;
  name: string;
}

export interface HandoffAttachment {
  name: string;
  type: string;
  size: number;
}

export interface HandoffStep {
  name: string;
  role: string;
  status: string;
}

/** One shared message, flattened for reading (no internal ids beyond `id`). */
export interface HandoffMessage {
  id: number;
  /** UNIX timestamp in seconds. */
  at: number;
  from: HandoffSender;
  kind: string;
  text: string;
  attachments?: HandoffAttachment[];
  steps?: HandoffStep[];
}

export interface HandoffParticipant {
  id: number;
  name: string;
  role: string;
}

export interface HandoffSource {
  chatId: number;
  title: string;
  participants: HandoffParticipant[];
  /** Every message in the conversation, including any left out below. */
  messageCount: number;
  /** UNIX seconds of the oldest and newest shared message. */
  from: number;
  to: number;
}

export interface HandoffDocument {
  schema: string;
  schemaVersion: number;
  /** UNIX timestamp in seconds. */
  sharedAt: number;
  source: HandoffSource;
  messages: HandoffMessage[];
}

export interface HandoffInput {
  chat: { id: number; title: string; participants: number[] };
  /** Every message of the conversation, oldest first (acks are dropped here). */
  messages: Message[];
  employees: Array<{ id: number; name: string; role: string }>;
  /** UNIX timestamp in seconds. */
  sharedAt: number;
}

/**
 * Build the handoff document for one conversation.
 *
 * Pure: everything it needs is passed in, so both processes (and a future
 * preview UI) can produce exactly the same payload. App-generated receipt acks
 * are dropped — they are noise for a reader, and their text is localized at
 * render time anyway.
 */
export function buildHandoffDocument(input: HandoffInput): HandoffDocument {
  const { chat, messages, employees, sharedAt } = input;
  const byId = new Map(employees.map((employee) => [employee.id, employee]));

  const kept = messages
    .filter((message) => message.kind !== "ack")
    .slice(-MAX_HANDOFF_MESSAGES);

  const sender = (id: number | null): HandoffSender => {
    if (id === null) return { id: null, name: HANDOFF_BOSS_NAME };
    const employee = byId.get(id);
    return { id, name: employee?.name ?? `#${id}` };
  };

  const document: HandoffDocument = {
    schema: HANDOFF_SCHEMA,
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    sharedAt,
    source: {
      chatId: chat.id,
      title: chat.title,
      participants: chat.participants.map((id) => {
        const employee = byId.get(id);
        return {
          id,
          name: employee?.name ?? `#${id}`,
          role: employee?.role ?? "",
        };
      }),
      messageCount: messages.filter((message) => message.kind !== "ack").length,
      from: kept.length > 0 ? kept[0].createdAt : sharedAt,
      to: kept.length > 0 ? kept[kept.length - 1].createdAt : sharedAt,
    },
    messages: kept.map((message) => ({
      id: message.id,
      at: message.createdAt,
      from: sender(message.senderEmployeeId),
      kind: message.kind,
      text: message.content,
      ...(message.attachments && message.attachments.length > 0
        ? {
            attachments: message.attachments.map(
              (attachment: MessageAttachment) => ({
                name: attachment.name,
                type: attachment.type,
                size: attachment.size,
              }),
            ),
          }
        : {}),
      ...(message.steps && message.steps.length > 0
        ? {
            steps: message.steps.map((step) => ({
              name: step.name,
              role: step.role,
              status: step.status,
            })),
          }
        : {}),
    })),
  };
  return document;
}

/** Attachment file name for a handoff of `sourceChatId` at `sharedAt`. */
export function handoffFileName(
  sourceChatId: number,
  sharedAt: number,
): string {
  return `imboss-handoff-chat${sourceChatId}-${sharedAt}.json`;
}

/** Result of a handoff (`handoff:toChat`). */
export interface HandoffResult {
  sourceChatId: number;
  targetChatId: number;
  /** The card message appended to the target conversation. */
  messageId: number;
  attachment: MessageAttachment;
}
