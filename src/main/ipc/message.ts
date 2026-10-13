import { READ_CHAT_PROMPT } from "@shared/constants/prompts";
import { ipcMain, shell } from "electron";
import { wakeAgent } from "../agent/session-queue";
import { resolveAssetPath } from "../assets";
import * as dbMessages from "../db/messages";
import { assertInteger, assertObject, assertString } from "./helpers";

export function registerMessageHandlers(): void {
  ipcMain.handle("messages:list", (_event, chatId: unknown) =>
    dbMessages.listMessages(assertInteger(chatId, "chat id")),
  );

  ipcMain.handle("messages:search", (_event, query: unknown) =>
    dbMessages.searchMessages(assertString(query, "query")),
  );

  ipcMain.handle(
    "messages:append",
    (_event, chatId: unknown, senderEmployeeId: unknown, content: unknown) => {
      const safeChatId = assertInteger(chatId, "chat id");
      const safeSender =
        senderEmployeeId === null
          ? null
          : assertInteger(senderEmployeeId, "sender id");
      return dbMessages.appendMessage(
        safeChatId,
        safeSender,
        assertString(content, "content"),
      );
    },
  );

  // Human (or any renderer) answers an ask message: append a kind=`answer`
  // system message and wake the ask's sender agent so it can react.
  ipcMain.handle(
    "messages:answer",
    (_event, chatId: unknown, askMessageId: unknown, answers: unknown) => {
      const safeChatId = assertInteger(chatId, "chat id");
      const safeAskId = assertInteger(askMessageId, "ask message id");
      const ask = dbMessages.getMessageById(safeAskId);
      if (!ask || ask.chatId !== safeChatId || ask.kind !== "ask") {
        throw new Error("Ask message does not exist.");
      }
      // Stamp the answer with the ask it replies to so the card can rehydrate
      // its retained options/text after a reload. Set after the spread so a
      // renderer-supplied `askMessageId` can never override it.
      const payload = {
        ...assertObject(answers, "answers"),
        askMessageId: safeAskId,
      };
      const message = dbMessages.appendMessage(
        safeChatId,
        null,
        JSON.stringify(payload),
        { kind: "answer" },
      );
      if (ask.senderEmployeeId != null) {
        // `wakeAgent` redirects the assistant (id 0) from a task group chat to
        // its root-chat session.
        void wakeAgent(ask.senderEmployeeId, safeChatId, READ_CHAT_PROMPT);
      }
      return message;
    },
  );

  // Reveal a message attachment in the OS file manager. The renderer only
  // passes the message id + index; the path is read from the trusted stored
  // record so a compromised renderer can never reveal arbitrary paths.
  ipcMain.handle(
    "messages:revealAttachment",
    (_event, messageId: unknown, index: unknown) => {
      const safeId = assertInteger(messageId, "message id");
      const safeIndex = assertInteger(index, "attachment index");
      shell.showItemInFolder(resolveAssetPath(safeId, safeIndex));
    },
  );
}
