import { BrowserWindow, Notification } from "electron";
import * as dbChats from "./db/chats";

let mainWindow: BrowserWindow | null = null;

/**
 * Register the main window so notification click handlers can focus + jump to
 * a chat. Called from `createWindow()`.
 */
export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

/** Send a payload to the registered main window (no-op before creation). */
export function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** Restore, show and focus the main window (used by notification clicks). */
export function focusMainWindow(): void {
  const target = resolveTargetWindow();
  if (!target) return;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
}

/**
 * Bump a chat's unread counter by `delta` (clamped >= 0), mirror the new count
 * to the renderer, and — when the app window is not focused — show an OS
 * notification that, when clicked, focuses the app and jumps to the chat.
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

  const target = resolveTargetWindow();
  const focused = BrowserWindow.getFocusedWindow();
  // Only send an OS notification when the app is genuinely in the background.
  if (target && focused && focused === target) return newUnread;

  if (target && Notification.isSupported()) {
    const notification = new Notification({
      title: chatTitle(chatId),
      body: text,
    });
    notification.on("click", () => {
      if (target.isDestroyed()) return;
      target.show();
      target.focus();
      target.webContents.send("chat:focus", chatId);
    });
    notification.show();
  }
  return newUnread;
}

/** Resolve the main window (fall back to the first live window). */
function resolveTargetWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return BrowserWindow.getAllWindows()[0] ?? null;
}

/** Notification title — the chat title when resolvable, otherwise the app name. */
function chatTitle(chatId: number): string {
  const chat = dbChats.getChat(chatId);
  const name = chat?.title?.trim();
  return name && name.length > 0 ? name : "Imboss";
}
