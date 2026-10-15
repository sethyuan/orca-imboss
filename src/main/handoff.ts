import { ASSISTANT_ID } from "@shared/constants/employees";
import {
  buildHandoffDocument,
  handoffFileName,
  type HandoffResult,
} from "@shared/chat-handoff";
import type { Chat, MessageAttachment } from "@shared/types";
import { deliver } from "./agent/session-queue";
import { savePastedFile } from "./attachments";
import * as dbChats from "./db/chats";
import * as dbEmployees from "./db/employees";
import * as dbMessages from "./db/messages";

/**
 * Chat handoff: the boss hands a conversation to another conversation as
 * reference, background or a follow-up.
 *
 * The mechanism deliberately reuses what already exists instead of inventing a
 * transport:
 * 1. the transcript becomes a JSON document (`@shared/chat-handoff`);
 * 2. the document is stored as an ordinary attachment of the target
 *    conversation (`savePastedFile`, so it lives under the app's attachments
 *    dir, is written atomically and is removed with the conversation);
 * 3. the target conversation gets a `kind="chat"` card message — the same card
 *    the assistant already posts when it opens a task chat, so it renders with
 *    no new UI and links straight back to the source conversation;
 * 4. the target assistant is woken with a prompt naming the attachment's
 *    absolute path, which is all the agent's file tooling needs to read the
 *    transcript.
 *
 * Only root (boss ↔ assistant) conversations are accepted on either end: the
 * assistant runs its root-chat session for those, while a task group chat is
 * read by the assistant from its root session and is not a delivery target.
 */

/**
 * Hand `sourceChatId` to `targetChatId`. Synchronous up to the (fire-and-forget)
 * agent delivery, so the caller can report the appended message immediately.
 */
export function handoffToChat(
  sourceChatId: number,
  targetChatId: number,
): HandoffResult {
  if (sourceChatId === targetChatId) {
    throw new Error("A conversation cannot be handed to itself.");
  }
  const source = requireRootChat(sourceChatId, "source");
  requireRootChat(targetChatId, "target");

  const messages = dbMessages.listMessages(sourceChatId);
  if (messages.length === 0) {
    throw new Error("This conversation has nothing to hand off yet.");
  }

  const sharedAt = Math.floor(Date.now() / 1000);
  const document = buildHandoffDocument({
    chat: source,
    messages,
    employees: dbEmployees
      .listEmployees()
      .map(({ id, name, role }) => ({ id, name, role })),
    sharedAt,
  });

  const attachment = savePastedFile(
    targetChatId,
    handoffFileName(sourceChatId, sharedAt),
    "application/json",
    Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8"),
  );

  // The card's content is the linked chat id — the same contract `ChatCard`
  // renders for the assistant's own `imb_create_chat` notices.
  const card = dbMessages.appendMessage(
    targetChatId,
    null,
    String(sourceChatId),
    {
      kind: "chat",
      attachments: [attachment],
    },
  );

  void deliver(
    ASSISTANT_ID,
    targetChatId,
    handoffPrompt(source, document.messages.length, attachment),
    { mode: "steer" },
  );

  return {
    sourceChatId,
    targetChatId,
    messageId: card.id,
    attachment,
  };
}

/** Resolve a chat that must exist and be a root (boss ↔ assistant) chat. */
function requireRootChat(chatId: number, which: string): Chat {
  const chat = dbChats.getChat(chatId);
  if (!chat) throw new Error(`The ${which} conversation does not exist.`);
  if (chat.fromChatId !== null) {
    throw new Error(
      `The ${which} conversation is a task group; hand off to a root conversation instead.`,
    );
  }
  return chat;
}

/**
 * Prompt delivered to the target assistant. Mirrors the `[Attachments]` block
 * the composer's own sends use, so the model sees the same shape: the absolute
 * path is the only thing it needs to read the transcript.
 */
function handoffPrompt(
  source: Chat,
  messageCount: number,
  attachment: MessageAttachment,
): string {
  const title =
    source.title.trim().length > 0 ? source.title.trim() : "Untitled";
  return (
    `The boss handed this conversation a reference: "${title}" ` +
    `(${messageCount} messages). Read the attached transcript when it is ` +
    `relevant to the work here.\n\n` +
    `[Attachments]\n- ${attachment.name} (${attachment.type}, ` +
    `${formatSize(attachment.size)}): ${attachment.path ?? ""}`
  );
}

/** Human-readable byte size, matching the composer's attachment block. */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
