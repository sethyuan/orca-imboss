import { ipcMain, type WebContents } from "electron";
import type { Binder, Subscriber } from "../rpc/types";

/**
 * The desktop transport: channel implementations served over Electron IPC.
 *
 * Behaviour is identical to the pre-refactor `ipcMain.handle(...)` calls — same
 * channel names, same positional arguments, same thrown errors — the only change
 * is that a handler now receives a {@link Subscriber} instead of the raw
 * `IpcMainInvokeEvent`.
 */

/**
 * One Subscriber per `WebContents`, cached: `agentSession:unbind` must find the
 * exact object `bind` stored, and Electron hands out a stable `WebContents`
 * instance per window, so a WeakMap keeps identity stable without leaking.
 */
const subscribers = new WeakMap<WebContents, Subscriber>();

export function webContentsSubscriber(sender: WebContents): Subscriber {
  const existing = subscribers.get(sender);
  if (existing) return existing;

  const subscriber: Subscriber = {
    id: `wc:${sender.id}`,
    get alive(): boolean {
      return !sender.isDestroyed();
    },
    send(channel: string, payload: unknown): void {
      if (sender.isDestroyed()) return;
      try {
        sender.send(channel, payload);
      } catch {
        // A renderer tear-down race must never abort the caller (mirrors
        // `sendEventTo`).
      }
    },
    onClose(callback: () => void): () => void {
      if (sender.isDestroyed()) {
        callback();
        return () => {
          // Nothing was registered.
        };
      }
      sender.once("destroyed", callback);
      return () => {
        sender.removeListener("destroyed", callback);
      };
    },
  };
  subscribers.set(sender, subscriber);
  return subscriber;
}

/** Register channel implementations on Electron's IPC bus. */
export function createIpcBinder(): Binder {
  return (channel, handler) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) =>
      handler({ subscriber: webContentsSubscriber(event.sender) }, ...args),
    );
  };
}
