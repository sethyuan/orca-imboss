import { ASSISTANT_ID } from "@shared/constants/employees";
import { MAX_TAGS_PER_CHAT, normalizeTag } from "@shared/constants/tags";
import type { ChatParticipantUpdate } from "@shared/types";
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
import {
  agentPrompt,
  userMessageContent,
  validateAttachmentsPayload,
} from "./attachment-prompt";
import { assertInteger, assertString, parsePageQuery } from "./helpers";
import type { Binder } from "../rpc/types";

export function registerChatHandlers(bind: Binder): void {
  bind("chats:list", () => dbChats.listChats());

  bind("chats:summaries", () => dbChats.listChatSummaries());

  // Pin/unpin one conversation (sorts above the rest of the list).
  bind("chats:setPinned", (_ctx, id: unknown, pinned: unknown) => {
    const safeId = assertInteger(id, "chat id");
    const updated = dbChats.setPinned(safeId, pinned === true);
    if (updated !== null) {
      sendToRenderer("chats:changed", { chatId: safeId });
    }
    return updated;
  });

  // Mute/unmute one conversation (silences its notifications; the unread
  // counter and the list order are unaffected).
  bind("chats:setMuted", (_ctx, id: unknown, muted: unknown) => {
    const safeId = assertInteger(id, "chat id");
    const updated = dbChats.setMuted(safeId, muted === true);
    if (updated !== null) {
      sendToRenderer("chats:changed", { chatId: safeId });
    }
    return updated;
  });

  bind("chats:summariesPage", (_ctx, page: unknown) =>
    dbChats.listChatSummariesPage(parsePageQuery(page)),
  );

  // Single chat summary (live per-chat refresh by the renderer).
  bind("chats:summary", (_ctx, id: unknown) =>
    dbChats.getChatSummary(assertInteger(id, "chat id")),
  );

  // Root (user) chat of a chat, resolved by walking `from_chat_id` upward.
  // Used by the session view to redirect the assistant from a task group chat
  // to the root-chat session it actually runs in.
  bind("chats:rootId", (_ctx, id: unknown) =>
    dbChats.getRootChatId(assertInteger(id, "chat id")),
  );

  bind("chats:markRead", (_ctx, id: unknown) => {
    const safeId = assertInteger(id, "chat id");
    dbChats.markRead(safeId);
    // Keep the renderer unread mirror in sync (cleared on open).
    sendToRenderer("chats:unreadChanged", { chatId: safeId, unread: 0 });
  });

  bind("chats:create", (_ctx, title: unknown, participants: unknown[]) => {
    if (!Array.isArray(participants)) {
      throw new Error("participants must be an array.");
    }
    const ids = participants.map((p) => assertInteger(p, "participant id"));
    // The assistant is always a participant of a root (assistant ↔ user)
    // chat so it can post replies with `imb_send_message`.
    const withAssistant = [...new Set([ASSISTANT_ID, ...ids])];
    return dbChats.createChat(assertString(title, "title"), withAssistant);
  });

  bind("chats:update", (_ctx, id: unknown, title: unknown) => {
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

  bind(
    "chats:updateParticipants",
    (_ctx, id: unknown, changes: ChatParticipantUpdate) => {
      const safeId = assertInteger(id, "chat id");
      const updated = dbChats.updateChatParticipants(safeId, changes);
      if (updated !== null) {
        // A member edit changes the chat's composite avatar everywhere (chat
        // list, Nav opened entries, link cards). Broadcast it like every other
        // chat mutation; the renderer re-reads one summary and fans it out.
        sendToRenderer("chats:changed", { chatId: safeId });
      }
      return updated;
    },
  );

  // Replace one conversation's tags (normalized, deduped, capped). Broadcasts
  // `chats:changed` so every window's cached summary picks the new tags up.
  bind("chats:setTags", (_ctx, id: unknown, tags: unknown) => {
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
  bind("chats:addTags", (_ctx, id: unknown, tags: unknown) => {
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

  bind("chats:delete", async (_ctx, id: unknown) => {
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
  bind(
    "chat:send",
    async (_ctx, chatId: unknown, content: unknown, attachments: unknown) => {
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
