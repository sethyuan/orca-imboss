import { ASSISTANT_ID } from "@shared/constants/employees";
import { MAX_TAGS_PER_CHAT, normalizeTag } from "@shared/constants/tags";
import type { ChatParticipantUpdate, MessageAttachment } from "@shared/types";
import { ipcMain } from "electron";
import { isAbsolute } from "path";
import { deliver, disposeForChat } from "../agent/session-queue";
import { deletePastedFilesForChat } from "../attachments";
import { integrationManager } from "../integrations";
import { maybeGenerateChatTitle } from "../agent/title-gen";
import * as cron from "../cron";
import * as dbChats from "../db/chats";
import * as dbMessages from "../db/messages";
import * as dbTags from "../db/tags";
import { listByChat, unlinkSessionFile } from "../db/sessions";
import { sendToRenderer } from "../notifications";
import { assertInteger, assertString, parsePageQuery } from "./helpers";

export function registerChatHandlers(): void {
  ipcMain.handle("chats:list", () => dbChats.listChats());

  ipcMain.handle("chats:summaries", () => dbChats.listChatSummaries());

  // Pin/unpin one conversation (sorts above the rest of the list).
  ipcMain.handle("chats:setPinned", (_event, id: unknown, pinned: unknown) => {
    const safeId = assertInteger(id, "chat id");
    const updated = dbChats.setPinned(safeId, pinned === true);
    if (updated !== null) {
      sendToRenderer("chats:changed", { chatId: safeId });
    }
    return updated;
  });

  // Mute/unmute one conversation (silences its notifications; the unread
  // counter and the list order are unaffected).
  ipcMain.handle("chats:setMuted", (_event, id: unknown, muted: unknown) => {
    const safeId = assertInteger(id, "chat id");
    const updated = dbChats.setMuted(safeId, muted === true);
    if (updated !== null) {
      sendToRenderer("chats:changed", { chatId: safeId });
    }
    return updated;
  });

  ipcMain.handle("chats:summariesPage", (_event, page: unknown) =>
    dbChats.listChatSummariesPage(parsePageQuery(page)),
  );

  // Single chat summary (live per-chat refresh by the renderer).
  ipcMain.handle("chats:summary", (_event, id: unknown) =>
    dbChats.getChatSummary(assertInteger(id, "chat id")),
  );

  // Root (user) chat of a chat, resolved by walking `from_chat_id` upward.
  // Used by the session view to redirect the assistant from a task group chat
  // to the root-chat session it actually runs in.
  ipcMain.handle("chats:rootId", (_event, id: unknown) =>
    dbChats.getRootChatId(assertInteger(id, "chat id")),
  );

  ipcMain.handle("chats:markRead", (_event, id: unknown) => {
    const safeId = assertInteger(id, "chat id");
    dbChats.markRead(safeId);
    // Keep the renderer unread mirror in sync (cleared on open).
    sendToRenderer("chats:unreadChanged", { chatId: safeId, unread: 0 });
  });

  ipcMain.handle(
    "chats:create",
    (_event, title: unknown, participants: unknown[]) => {
      if (!Array.isArray(participants)) {
        throw new Error("participants must be an array.");
      }
      const ids = participants.map((p) => assertInteger(p, "participant id"));
      // The assistant is always a participant of a root (assistant ↔ user)
      // chat so it can post replies with `imb_send_message`.
      const withAssistant = [...new Set([ASSISTANT_ID, ...ids])];
      return dbChats.createChat(assertString(title, "title"), withAssistant);
    },
  );

  ipcMain.handle("chats:update", (_event, id: unknown, title: unknown) => {
    const safeId = assertInteger(id, "chat id");
    const updated = dbChats.updateChatTitle(
      safeId,
      assertString(title, "title"),
    );
    if (updated !== null) {
      // Manual rename: keep every window's chat cache (list + header) in sync,
      // mirroring the auto title-generation notification in `title-gen`.
      sendToRenderer("chats:changed", { chatId: safeId });
    }
    return updated;
  });

  ipcMain.handle(
    "chats:updateParticipants",
    (_event, id: unknown, changes: ChatParticipantUpdate) => {
      const safeId = assertInteger(id, "chat id");
      return dbChats.updateChatParticipants(safeId, changes);
    },
  );

  // Replace one conversation's tags (normalized, deduped, capped). Broadcasts
  // `chats:changed` so every window's cached summary picks the new tags up.
  ipcMain.handle("chats:setTags", (_event, id: unknown, tags: unknown) => {
    const safeId = assertInteger(id, "chat id");
    if (!Array.isArray(tags)) throw new Error("tags must be an array.");
    // Tags live on root (user) conversations only; task group chats roll up to
    // their root everywhere (chat list, statistics).
    const chat = dbChats.getChat(safeId);
    if (chat === null || chat.fromChatId !== null) return null;
    const normalized: string[] = [];
    for (const entry of tags) {
      if (typeof entry !== "string") {
        throw new Error("each tag must be a string.");
      }
      const tag = normalizeTag(entry);
      if (tag.length === 0 || normalized.includes(tag)) continue;
      normalized.push(tag);
    }
    if (normalized.length > MAX_TAGS_PER_CHAT) {
      throw new Error(`at most ${MAX_TAGS_PER_CHAT} tags per conversation.`);
    }
    dbTags.setChatTags(safeId, normalized);
    sendToRenderer("chats:changed", { chatId: safeId });
    return dbChats.getChatSummary(safeId);
  });

  // Merge tags into a conversation's existing ones (union, normalized, deduped,
  // capped). Used by the composer's "Common projects" action so the renderer
  // never has to read-modify-write `chats:setTags`. Root (user) conversations
  // only, mirroring `chats:setTags`.
  ipcMain.handle("chats:addTags", (_event, id: unknown, tags: unknown) => {
    const safeId = assertInteger(id, "chat id");
    if (!Array.isArray(tags)) throw new Error("tags must be an array.");
    const chat = dbChats.getChat(safeId);
    if (chat === null || chat.fromChatId !== null) return null;
    const merged: string[] = [];
    for (const entry of [...dbTags.tagsForChat(safeId), ...tags]) {
      if (typeof entry !== "string") {
        throw new Error("each tag must be a string.");
      }
      const tag = normalizeTag(entry);
      if (tag.length === 0 || merged.includes(tag)) continue;
      merged.push(tag);
      if (merged.length >= MAX_TAGS_PER_CHAT) break;
    }
    dbTags.setChatTags(safeId, merged);
    sendToRenderer("chats:changed", { chatId: safeId });
    return dbChats.getChatSummary(safeId);
  });

  ipcMain.handle("chats:delete", async (_event, id: unknown) => {
    const safeId = assertInteger(id, "chat id");
    // Chats spawned from this one (`from_chat_id`) go with it, and those may
    // spawn further chats, so delete the whole descendant tree.
    const chatIds = dbChats.listChatTreeIds(safeId);
    if (chatIds.length === 0) return false;
    // Stop the live timers first: the FK cascade removes the `cron_jobs` rows
    // when the chats are deleted, but the in-process Cron handles would
    // otherwise keep firing into a now-deleted chat.
    cron.stopJobsForChats(chatIds);
    // Capture disk session file paths BEFORE the FK cascade wipes the rows.
    const records = chatIds.flatMap((chatId) => listByChat(chatId));
    // Tear down any warm agent sessions for these chats before files go away.
    await Promise.all(chatIds.map((chatId) => disposeForChat(chatId)));
    const removed = dbChats.deleteChats(chatIds) > 0;
    if (removed) {
      await Promise.all(records.map((r) => unlinkSessionFile(r.session)));
      // Drop platform media downloaded for these bridged chats and files
      // pasted into their composers.
      await Promise.all(
        chatIds.flatMap((chatId) => [
          integrationManager.deleteChatMedia(chatId),
          deletePastedFilesForChat(chatId),
        ]),
      );
      // Keep every window in sync: chat caches + opened group-chat entries.
      sendToRenderer("chats:deleted", { chatIds });
    }
    return removed;
  });

  /**
   * Chat pipeline: append the user message → run the assistant's agent turn
   * (serialized per session queue).
   */
  ipcMain.handle(
    "chat:send",
    async (_event, chatId: unknown, content: unknown, attachments: unknown) => {
      const safeChatId = assertInteger(chatId, "chat id");
      const safeContent = assertString(content, "content");
      const safeAttachments = validateAttachmentsPayload(attachments);

      const userMessage = dbMessages.appendMessage(
        safeChatId,
        null,
        userMessageContent(safeContent, safeAttachments),
        !!safeAttachments?.length ? { attachments: safeAttachments } : {},
      );

      // Immediate, app-generated receipt so the user sees an acknowledgement
      // before the (slow) agent turn produces anything. Defensive: a failure
      // here must never break the send — the user message is already stored.
      try {
        dbMessages.appendMessage(safeChatId, ASSISTANT_ID, "", {
          kind: "ack",
          silent: true,
        });
      } catch (err) {
        console.error(
          "[chat:send] failed to append receipt ack:",
          err instanceof Error ? err.message : err,
        );
      }

      // Serialized run; the agent posts its own reply via `imb_send_message`.
      // Deliver the text plus the attachment locations so the model can read
      // the files (a file-only send would otherwise be an empty prompt).
      // A human send that lands mid-turn steers the live run instead of
      // waiting for it to settle.
      void deliver(
        ASSISTANT_ID,
        safeChatId,
        agentPrompt(safeContent, safeAttachments),
        { mode: "steer" },
      );

      // First message of an untitled chat → generate a title from it
      // (fire-and-forget; retries on the next message when it fails).
      maybeGenerateChatTitle(safeChatId, safeContent);

      return userMessage;
    },
  );
}

function validateAttachmentsPayload(
  value: unknown,
): MessageAttachment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("attachments must be an array.");
  // Field-level validation happens in the messages service; pass through and
  // let it throw on malformed entries.
  return value as MessageAttachment[];
}

/** Cap for a name/type/path embedded in the agent prompt (matches the DB limits). */
const MAX_PROMPT_ATTACH_NAME_LENGTH = 256;
const MAX_PROMPT_ATTACH_TYPE_LENGTH = 128;
const MAX_PROMPT_ATTACH_PATH_LENGTH = 4096;

/**
 * Collapse control characters (notably newlines) and cap length so an
 * attachment name/path can never forge extra lines in the agent prompt.
 */
function sanitizePromptField(value: string, maxLength: number): string {
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength
    ? `${cleaned.slice(0, maxLength)}…`
    : cleaned;
}

/** Human-readable byte size for the agent prompt (mirrors the bubble chip). */
function formatPromptSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Agent-facing description of the user's attachments. Only absolute paths are
 * embedded (a relative path is useless outside the agent's workdir, mirroring
 * the reveal IPC's `isAbsolute` guard); the rest degrade to name/type/size.
 */
function formatAttachmentBlock(
  attachments: MessageAttachment[] | undefined,
): string {
  if (!attachments || attachments.length === 0) return "";
  const lines = attachments.map((attachment) => {
    const name =
      sanitizePromptField(attachment.name, MAX_PROMPT_ATTACH_NAME_LENGTH) ||
      "file";
    const type =
      sanitizePromptField(attachment.type, MAX_PROMPT_ATTACH_TYPE_LENGTH) ||
      "unknown type";
    const base = `- ${name} (${type}, ${formatPromptSize(attachment.size)})`;
    const path =
      typeof attachment.path === "string" &&
      attachment.path.length > 0 &&
      isAbsolute(attachment.path)
        ? sanitizePromptField(attachment.path, MAX_PROMPT_ATTACH_PATH_LENGTH)
        : "";
    return path.length > 0 ? `${base}: ${path}` : base;
  });
  return `[Attachments]\n${lines.join("\n")}`;
}

/**
 * Prompt delivered to the agent for a user send: the raw text plus a compact
 * attachment list, so the model immediately knows where the files live.
 */
function agentPrompt(
  content: string,
  attachments: MessageAttachment[] | undefined,
): string {
  const block = formatAttachmentBlock(attachments);
  if (block.length === 0) return content;
  return content.length > 0 ? `${content}\n\n${block}` : block;
}

/**
 * Stored content for the user message. Attachments without text get a neutral
 * file-name list instead of the former hardcoded `"[附件]"`; `appendMessage`
 * rejects empty content.
 */
function userMessageContent(
  content: string,
  attachments: MessageAttachment[] | undefined,
): string {
  if (content.length > 0) return content;
  const names = (attachments ?? [])
    .map((attachment) =>
      sanitizePromptField(attachment.name, MAX_PROMPT_ATTACH_NAME_LENGTH),
    )
    .filter((name) => name.length > 0);
  return names.length > 0 ? `Attached: ${names.join(", ")}` : "Attached files";
}
