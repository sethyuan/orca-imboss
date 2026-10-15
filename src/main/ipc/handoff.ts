import { ipcMain } from "electron";
import { handoffToChat } from "../handoff";
import { assertInteger } from "./helpers";

/**
 * Chat handoff — registered only while `CHAT_HANDOFF_ENABLED` is set (see
 * `src/main/ipc/index.ts`).
 *
 * The renderer picks the two conversations; main owns the payload, the stored
 * file and the delivery, so the transcript never crosses IPC.
 */
export function registerHandoffHandlers(): void {
  ipcMain.handle(
    "handoff:toChat",
    (_event, sourceChatId: unknown, targetChatId: unknown) =>
      handoffToChat(
        assertInteger(sourceChatId, "source chat id"),
        assertInteger(targetChatId, "target chat id"),
      ),
  );
}
