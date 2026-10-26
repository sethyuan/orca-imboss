import { BrowserWindow, Notification } from "electron";
import { getMainWindow, showMainWindow } from "../main-window";
import type { OsNotification, OsNotifier } from "../platform";

/**
 * Desktop OS notifications — the host half of `notifyUnread`.
 *
 * Policy kept exactly as it was inline in `notifications.ts` before the
 * platform split:
 * - only notify when the app is not genuinely in the foreground (a focused main
 *   window means the user is already looking at the conversation),
 * - never notify when the platform cannot show notifications,
 * - a click brings the window back (whatever state it is in) and jumps to the
 *   chat.
 *
 * On Windows / Linux a notification only exists while the app keeps a window, so
 * the "no window at all" case stays silent too — same as before.
 */
export const desktopOsNotifier: OsNotifier = {
  notify(notification: OsNotification): void {
    const target = getMainWindow();
    const focused = BrowserWindow.getFocusedWindow();
    if (target && focused && focused === target) return;
    if (!target || !Notification.isSupported()) return;

    const shown = new Notification({
      title: notification.title,
      body: notification.body,
    });
    shown.on("click", () => {
      // The window may be hidden (or minimized) when the notification is
      // clicked: `showMainWindow()` covers every state, plain `show()` does not.
      showMainWindow();
      getMainWindow()?.webContents.send("chat:focus", notification.chatId);
    });
    shown.show();
  },
};
