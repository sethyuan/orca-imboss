import { existsSync } from "fs";
import { isAbsolute } from "path";
import { splitAttachmentPrompt } from "../attachment-prompt";
import {
  extractTextContent,
  readSessionEntries,
  readSessionView,
} from "../agent/session-view";
import { deleteSession, getSession, setSession } from "../db/sessions";
import { getRevealer } from "../platform";
import { assertInteger, assertString } from "./helpers";
import type { Binder } from "../rpc/types";

export function registerSessionHandlers(bind: Binder): void {
  // Projected, read-only view of a persistent `(employee, chat)` agent
  // session. Never exposes system prompts / tool args / tool results.
  bind("sessions:entries", (_ctx, employeeId: unknown, chatId: unknown) => {
    const safeEmployee = assertInteger(employeeId, "employee id");
    const safeChat = assertInteger(chatId, "chat id");
    return readSessionView(safeEmployee, safeChat);
  });

  bind("sessions:get", (_ctx, employeeId: unknown, chatId: unknown) => {
    const safeEmployee = assertInteger(employeeId, "employee id");
    const safeChat = assertInteger(chatId, "chat id");
    return getSession(safeEmployee, safeChat);
  });

  bind(
    "sessions:set",
    (_ctx, employeeId: unknown, chatId: unknown, sessionPath: unknown) => {
      const safeEmployee = assertInteger(employeeId, "employee id");
      const safeChat = assertInteger(chatId, "chat id");
      setSession(
        safeEmployee,
        safeChat,
        assertString(sessionPath, "session path"),
      );
    },
  );

  bind("sessions:delete", (_ctx, employeeId: unknown, chatId: unknown) => {
    const safeEmployee = assertInteger(employeeId, "employee id");
    const safeChat = assertInteger(chatId, "chat id");
    return deleteSession(safeEmployee, safeChat);
  });

  /**
   * Reveal one attachment of a user prompt in the OS file manager.
   *
   * Trust model (same as `messages:revealAttachment`): the renderer supplies a
   * session identity, the **entry id** and an index — never a path. Main re-reads
   * the persisted prompt, splits its `[Attachments]` block itself and reveals
   * what *its own* text says, so a compromised renderer cannot hand it an
   * arbitrary path. A block that no longer parses simply has no attachment at
   * that index (the view still shows the prompt as raw text).
   */
  bind(
    "sessions:revealAttachment",
    async (
      _ctx,
      employeeId: unknown,
      chatId: unknown,
      entryId: unknown,
      index: unknown,
    ) => {
      const safeEmployee = assertInteger(employeeId, "employee id");
      const safeChat = assertInteger(chatId, "chat id");
      const safeEntryId = assertString(entryId, "session entry id");
      const safeIndex = assertInteger(index, "attachment index");
      if (safeIndex < 0) {
        throw new Error("Attachment index must be non-negative.");
      }
      const entries = await readSessionEntries(safeEmployee, safeChat);
      const entry = entries.find((candidate) => candidate.id === safeEntryId);
      if (entry === undefined || entry.type !== "message") {
        throw new Error("Session entry does not exist.");
      }
      const message = entry.message as { role?: unknown; content?: unknown };
      if (message.role !== "user") {
        throw new Error("Session entry is not a user prompt.");
      }
      const { attachments } = splitAttachmentPrompt(
        extractTextContent(message.content),
      );
      const attachment = attachments[safeIndex];
      if (attachment === undefined) {
        throw new Error("Attachment does not exist.");
      }
      const path = attachment.path;
      if (path === undefined || path.length === 0) {
        throw new Error("Attachment location is unavailable.");
      }
      if (!isAbsolute(path)) {
        throw new Error("Attachment location is invalid.");
      }
      if (!existsSync(path)) {
        throw new Error("Attachment file no longer exists.");
      }
      if (attachment.kind === "folder") {
        // Open the folder itself; `showItemInFolder` would only select it in its
        // parent. `openPath` resolves to an error string ("" on success).
        const error = await getRevealer().openPath(path);
        if (error) throw new Error(error);
        return;
      }
      getRevealer().showItemInFolder(path);
    },
  );
}
