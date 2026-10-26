import { app, ipcMain } from "electron";
import { registerUpdaterHandlers } from "./updater";
import { registerWindowHandlers } from "./window";

/**
 * Channels that only make sense in the desktop shell and therefore stay in this
 * process in **both** modes: window controls, the app's own updater and the app
 * version the user is looking at.
 *
 * Split from `./index` on purpose — `./index` is the backend's channel table and
 * must never reach Electron, while these are Electron by definition
 * (`BrowserWindow`, `electron-updater`, `app.getVersion`).
 */
export function registerLocalHandlers(): void {
  registerWindowHandlers();
  registerUpdaterHandlers();
  registerAppInfoHandlers();
}

/**
 * The version of the app the user is looking at.
 *
 * Deliberately **local**, not remote: Settings › About reports the desktop shell
 * the window belongs to, while the backend's own version arrives through the gRPC
 * `Info` call.
 */
export function registerAppInfoHandlers(): void {
  ipcMain.handle("app:getVersion", () => app.getVersion());
}
