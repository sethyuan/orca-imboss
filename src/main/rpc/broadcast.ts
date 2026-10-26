/**
 * Main → renderer event fan-out, independent of where the renderer lives.
 *
 * Business modules push events through `sendToRenderer` (unchanged signature and
 * call sites). Which sinks receive them is decided once at startup:
 *
 * - desktop (local mode *and* the desktop shell of a remote setup): the main
 *   window's `webContents` (see `src/main/desktop/broadcast.ts`),
 * - remote backend: every subscribed gRPC client (see
 *   `src/main/server/subscribers.ts`).
 *
 * This module is Electron-free on purpose: `src/main/db/**` and
 * `src/main/agent/**` broadcast, and the server bundle must not pull Electron
 * in. The default broadcaster is a no-op, so an event emitted before the host
 * installed its sink is silently dropped — exactly like today's pre-window
 * `sendToRenderer`.
 */

export type EventBroadcaster = (channel: string, payload: unknown) => void;

let broadcaster: EventBroadcaster = () => {
  // No host installed yet (or none at all): drop the event.
};

/** Install the host's sink. Called once per process at startup. */
export function setEventBroadcaster(next: EventBroadcaster): void {
  broadcaster = next;
}

/**
 * Send a payload to every live sink. `payload` is optional for channels that
 * only signal "something changed" (e.g. `skills:changed`), whose listeners take
 * no argument.
 */
export function sendToRenderer(channel: string, payload?: unknown): void {
  broadcaster(channel, payload);
}
