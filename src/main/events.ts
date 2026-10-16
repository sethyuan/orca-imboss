/**
 * Transport-agnostic event bus.
 *
 * The core (db, agent, integrations, cron) must not depend on Electron just to
 * push UI updates. It emits named events here instead; the sinks decide how to
 * deliver them:
 *
 * - the Electron main process registers a sink that forwards to the window's
 *   `webContents` (`src/main/notifications.ts`),
 * - the headless daemon registers a log sink (`src/daemon/index.ts`),
 * - a future gateway registers a WebSocket sink.
 *
 * Listeners are isolated: a throwing sink never breaks the emitter.
 */

type Listener = (channel: string, payload: unknown) => void;

const listeners = new Set<Listener>();

/** Register a sink; returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Emit one event to every registered sink. Never throws. */
export function emit(channel: string, payload: unknown): void {
  for (const listener of [...listeners]) {
    try {
      listener(channel, payload);
    } catch (err) {
      console.error(
        `[events] sink failed for "${channel}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Legacy name kept so existing call sites stay unchanged: it is exactly `emit`.
 * New code should call `emit` directly.
 */
export function sendToRenderer(channel: string, payload: unknown): void {
  emit(channel, payload);
}
