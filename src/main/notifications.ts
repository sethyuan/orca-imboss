import * as dbChats from "./db/chats";
import { getOsNotifier } from "./platform";

/**
 * The "there is something new" nudge the boss actually sees.
 *
 * Transport- and host-independent on purpose: *showing* an OS notification is a
 * host capability delegated to {@link getOsNotifier}. The desktop host installs
 * a notifier backed by Electron's `Notification` (see
 * `src/main/desktop/os-notifications.ts`); a remote backend installs nothing, so
 * alerting degrades to a silent no-op there (the unread badge is pushed to the
 * renderer by `db/messages.ts` on the same append).
 *
 * The unread counter itself is *not* bumped here: every message an employee or
 * the assistant appends to a root chat already bumps it exactly once in
 * `db/messages.ts` (`bumpUnread`), and this module must never add a second one.
 *
 * Re-exported here because every existing caller imports `sendToRenderer` from
 * this module; the implementation itself lives in `rpc/broadcast` so that
 * Electron-free business modules can use it without the notifier.
 */
export { sendToRenderer } from "./rpc/broadcast";

/**
 * Raise the OS notification that alerts the boss to a message which was just
 * posted into one of his chats: when the app window is not focused a system
 * notification pops up, and clicking it focuses the app and opens that chat.
 *
 * Called by the send pipeline (`performSendMessage`) right after the message is
 * stored, so the alert can never be forgotten by the model — every caller of
 * this module is a deliberately *alerting* path:
 * - `kind: "report"` and `imb_ask` alert by default (their text is derived from
 *   the message when the caller gave no `alert`),
 * - any other message alerts only when the caller passed an explicit `alert`.
 *
 * Root chats only: task group chats (`fromChatId !== null`) never raise a
 * notification — their activity reaches the boss through the assistant's
 * progress cards and reports in the boss's own chat.
 *
 * A muted chat stays silent too (it still counts unread; that bump happened in
 * `db/messages.ts`). Blank text is a no-op rather than an empty banner.
 */
export function notifyAlert(
  chatId: number,
  text: string,
  options: NotifyAlertOptions = {},
): void {
  const body = typeof text === "string" ? text.trim() : "";
  if (body.length === 0) return;
  const chat = dbChats.getChat(chatId);
  if (!chat) return;
  if (chat.fromChatId !== null) return;
  if (chat.muted) return;

  // Whether the user is actually reachable is host knowledge (window focus, OS
  // notification support); a headless backend has nobody to interrupt.
  getOsNotifier().notify({
    chatId,
    title: options.title?.trim() || chatTitle(chatId),
    body,
  });
}

/** Optional copy overrides; the gating is not configurable on purpose. */
export interface NotifyAlertOptions {
  /**
   * Notification title instead of the chat title.
   *
   * Used where the sender identifies the message better than the conversation
   * does — an employee's reply in its **direct chat** is announced as that
   * employee ("Ada"), because the conversation title there is usually the boss's
   * own first message.
   */
  title?: string;
}

/** Notification title — the chat title when resolvable, otherwise the app name. */
function chatTitle(chatId: number): string {
  const chat = dbChats.getChat(chatId);
  const name = chat?.title?.trim();
  return name && name.length > 0 ? name : "Imboss";
}
