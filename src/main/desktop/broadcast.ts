import { getMainWindow } from "../main-window";
import { setEventBroadcaster } from "../rpc/broadcast";

/**
 * Push events to this window (no-op before creation / after destruction).
 *
 * The desktop counterpart of the remote backend's subscriber fan-out; installed
 * by both desktop bootstraps (local mode and the remote shell), because in both
 * cases the renderer lives in this process.
 */
export function installDesktopBroadcaster(): void {
  setEventBroadcaster((channel, payload) => {
    const win = getMainWindow();
    if (win) win.webContents.send(channel, payload);
  });
}
