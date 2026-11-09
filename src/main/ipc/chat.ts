import { ASSISTANT_ID } from "@shared/constants/employees";
import { MAX_TAGS_PER_CHAT, normalizeTag } from "@shared/constants/tags";
import type { ChatParticipantUpdate } from "@shared/types";
import { deliver, disposeForChat } from "../agent/session-queue";
import { deletePastedFilesForChat } from "../attachments";
import { integrationManager } from "../integrations";
import { maybeGenerateChatTitle } from "../agent/title-gen";
import * as cron from "../cron";
import * as dbChats from "../db/chats";
import * as dbEmployees from "../db/employees";
import * as dbMessages from "../db/messages";
import * as dbTags from "../db/tags";
import { listByChat, unlinkSessionFile } from "../db/sessions";
import { sendToRenderer } from "../notifications";
import {
  agentPrompt,
  userMessageContent,
  validateAttachmentsPayload,
} from "../attachment-prompt";
import { validateCommentsPayload, withComments } from "../comment-prompt";
import { assertInteger, assertString, parsePageQuery } from "./helpers";
import type { Binder } from "../rpc/types";

export function registerChatHandlers(bind: Binder): void {
  bind("chats:list", () => dbChats.listChats());

  bind("chats:summaries", () => dbChats.listChatSummaries());

  // Task groups spawned by one conversation: the composer's `#` reference
  // candidates. Explicitly not part of `chats:summaries` (root-only) so the
  // Chat module's list can never pick a group up.
  bind("chats:taskGroups", (_ctx, parentChatId: unknown) =>
    dbChats.listTaskGroupsOf(assertInteger(parentChatId, "chat id")),
  );

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
   * Create an **employee direct chat**: a root chat the boss talks to one
   * employee in (see `Chat.directEmployeeId`).
   *
   * Deliberately its own channel instead of a `chats:create` option: the two
   * differ in more than a flag — a direct chat must NOT force the assistant in
   * (it has no role in a one-to-one conversation), and `chats:create` keeps
   * that behavior for every other chat. The employee is validated here so a
   * stale/disabled id never produces a conversation nobody can answer in.
   */
  bind("chats:createDirect", (_ctx, employeeId: unknown) => {
    const safeId = assertInteger(employeeId, "employee id");
    if (safeId === ASSISTANT_ID) {
      throw new Error(
        "The assistant has no direct conversation: it already talks to the boss in " +
          "every chat it runs in.",
      );
    }
    const employee = dbEmployees.getEmployee(safeId);
    if (!employee || employee.disabled) {
      throw new Error("Employee not found.");
    }
    // Untitled on purpose: the first message generates the title (see
    // `maybeGenerateChatTitle`), exactly like the chat module's own new chat.
    return dbChats.createChat("", [safeId], { directEmployeeId: safeId });
  });

  /**
   * Chat pipeline: append the user message → run the agent turn that answers it
   * (serialized per session queue).
   *
   * The answering session is the conversation's own: the assistant for a normal
   * chat, the conversation's employee for an employee direct chat
   * (`chats.direct_employee_id`). Everything else about the send is shared.
   *
   * `comments` are the boss's annotations of earlier messages. They are part of
   * **this** message: stored on its row (`messages.comments`, which is what the
   * thread renders) and written into the same prompt as a `[Comments]` block, so
   * the agent sees them in the turn they were sent in. A comment-only send (no
   * text, no files) is legitimate.
   */
  bind(
    "chat:send",
    async (
      _ctx,
      chatId: unknown,
      content: unknown,
      attachments: unknown,
      comments: unknown,
    ) => {
      const safeChatId = assertInteger(chatId, "chat id");
      const safeContent = assertString(content, "content");
      const safeAttachments = validateAttachmentsPayload(attachments);
      // Shape-only validation; `appendMessage` re-checks with the target-is-in-
      // this-chat rule (the only place that knows the chat to check against).
      const safeComments = validateCommentsPayload(comments);

      const chat = dbChats.getChat(safeChatId);
      if (chat === null) throw new Error("Conversation not found.");
      // A direct chat the boss is typing into: the employee answers, and it must
      // still be able to (a soft-deleted employee stays a participant but never
      // runs again, so the message would silently reach nobody).
      const directEmployeeId = chat.directEmployeeId;
      if (directEmployeeId !== null) {
        const employee = dbEmployees.getEmployee(directEmployeeId);
        if (!employee || employee.disabled) {
          throw new Error(
            "This employee is no longer available, so the message was not sent.",
          );
        }
      }

      const userMessage = dbMessages.appendMessage(
        safeChatId,
        null,
        userMessageContent(
          safeContent,
          safeAttachments,
          (safeComments?.length ?? 0) > 0,
        ),
        {
          ...(safeAttachments?.length ? { attachments: safeAttachments } : {}),
          ...(safeComments?.length ? { comments: safeComments } : {}),
        },
      );

      if (directEmployeeId === null) {
        // Immediate, app-generated receipt so the user sees an acknowledgement
        // before the (slow) agent turn produces anything. Defensive: a failure
        // here must never break the send — the user message is already stored.
        //
        // A direct chat skips it: its thread is the agent session (the ack row
        // would never be rendered), and the session view's own pending row is
        // the "sent, not yet visible" feedback there.
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
      }

      // Serialized run. In a normal chat the agent posts its own reply via
      // `imb_send_message`; in a direct chat the employee's final text IS the
      // reply and main mirrors it into `messages` when the run settles (see
      // `session-queue.recordDirectChatReply`).
      // Deliver the text plus the attachment locations so the model can read
      // the files (a file-only send would otherwise be an empty prompt).
      // A human send that lands mid-turn steers the live run instead of
      // waiting for it to settle.
      void deliver(
        directEmployeeId ?? ASSISTANT_ID,
        safeChatId,
        // The comment block goes before the attachment block: `[Attachments]`
        // must stay the prompt's trailing suffix (see `comment-prompt.ts`).
        agentPrompt(withComments(safeContent, safeComments), safeAttachments),
        { mode: "steer" },
      );

      // First message of an untitled chat → generate a title from it
      // (fire-and-forget; retries on the next message when it fails).
      maybeGenerateChatTitle(safeChatId, safeContent);

      return userMessage;
    },
  );
}
