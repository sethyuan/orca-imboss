import type { Binder, Handler } from "./types";

/**
 * Electron-free binders.
 *
 * `createMapBinder` is how a backend serves the channel table over gRPC;
 * `createCollectBinder` is how a client learns the very same table without a
 * hand-maintained list — it runs the *same* registration functions and records
 * the channel names, so the two sides can never drift apart.
 */

/** Record `channel → handler` (the remote backend's table). */
export function createMapBinder(target: Map<string, Handler>): Binder {
  return (channel, handler) => {
    if (target.has(channel)) {
      // Two registrations for one channel means a refactor bug: the second would
      // silently shadow the first, and the client would get an unpredictable
      // implementation. Fail loudly at startup instead.
      throw new Error(`Duplicate channel registration: ${channel}`);
    }
    target.set(channel, handler);
  };
}

/** Record the channel names only (the client's proxy table). */
export function createCollectBinder(target: Set<string>): Binder {
  return (channel) => {
    if (target.has(channel)) {
      throw new Error(`Duplicate channel registration: ${channel}`);
    }
    target.add(channel);
  };
}
