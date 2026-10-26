import * as dbChats from "./db/chats";
import { getOsNotifier } from "./platform";
import { sendToRenderer } from "./rpc/broadcast";

/**
 * Unread bookkeeping and the "there is something new" nudge.
 *
 * Transport- and host-independent on purpose: the unread counter is persisted
 * data (so this runs where the database is), while *showing* an OS notification
 * is a host capability delegated to {@link getOsNotifier}. The desktop host
 * installs a notifier backed by Electron's `Notification` (see
 * `src/main/desktop/os-notifications.ts`); a remote backend installs nothing,
 * and its clients still receive the `chats:unreadChanged` event below.
 *
 * Re-exported here because every existing caller imports `sendToRenderer` from
 * this module; the implementation itself lives in `rpc/broadcast` so that
 * Electron-free business modules can use it without the notifier.
 */
export { sendToRenderer } from "./rpc/broadcast";

/**
 * Bump a chat's unread counter by `delta` (clamped >= 0), mirror the new count
 * to the renderer, and — when the host decides the user needs to be told — raise
 * an OS notification that, when clicked, focuses the app and jumps to the chat.
 *
 * Root chats only: task group chats (fromChatId !== null) never record unread
 * (the badge is root-chat only and group chats track reads via read_cursors),
 * so a group chat id is rejected rather than silently ignored.
 *
 * A muted chat keeps counting unread (the badge stays honest) but raises no OS
 * notification.
 *
 * Returns the new unread count.
 */
export function notifyUnread(
  chatId: number,
  delta: number,
  text: string,
): number {
  const chat = dbChats.getChat(chatId);
  if (!chat) return 0;
  if (chat.fromChatId !== null) return 0;

  const newUnread = dbChats.addUnread(chatId, delta);
  sendToRenderer("chats:unreadChanged", { chatId, unread: newUnread });

  // A muted conversation still counts unread, but never notifies.
  if (chat.muted) return newUnread;

  // Whether the user is actually reachable is host knowledge (window focus, OS
  // notification support); a headless backend has nobody to interrupt.
  getOsNotifier().notify({
    chatId,
    title: chatTitle(chatId),
    body: text,
  });
  return newUnread;
}

/** Notification title — the chat title when resolvable, otherwise the app name. */
function chatTitle(chatId: number): string {
  const chat = dbChats.getChat(chatId);
  const name = chat?.title?.trim();
  return name && name.length > 0 ? name : "Imboss";
}
