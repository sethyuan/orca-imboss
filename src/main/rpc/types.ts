/**
 * The transport contract shared by every IPC channel.
 *
 * The app has exactly one implementation per channel and two transports over it
 * (see `.pi/facts/grpc-remote-backend-research.md`):
 *
 * - **in-process IPC** — the desktop window talks to the same process
 *   (`ipcMain.handle`),
 * - **gRPC** — a remote backend serves the channel table and the desktop
 *   process forwards to it.
 *
 * A channel is identified by its existing string (`"messages:append"`), which is
 * also the RPC method name, and its payload is the positional argument array.
 * Keeping both unchanged is what lets the preload/renderer stay untouched.
 */

/**
 * One event sink the main process can push to: today an Electron `WebContents`,
 * on a remote backend the client's event stream.
 */
export interface Subscriber {
  /** Stable identity used to route point-to-point events. */
  readonly id: string;
  /** False once the other end is gone; senders must skip it. */
  readonly alive: boolean;
  /** Push one event channel (never throws, never breaks the queue). */
  send(channel: string, payload: unknown): void;
  /**
   * Run `callback` once when the subscriber disappears.
   * Returns a disposer that cancels the registration.
   */
  onClose(callback: () => void): () => void;
}

/**
 * Per-call context handed to a channel handler.
 *
 * `subscriber` replaces the raw `event.sender` the handlers used to receive:
 * only three channels need it (`agentSession:bind/unbind`, `providers:login`),
 * and expressing it as a Subscriber is what makes them transport-independent.
 * `signal` aborts when the caller cancels (gRPC deadline/cancel); it is absent
 * for in-process IPC, where an invoke cannot be cancelled anyway.
 */
export interface CallContext {
  readonly subscriber: Subscriber;
  readonly signal?: AbortSignal;
}

/**
 * One channel implementation. `args` are already the raw, untrusted values.
 *
 * The rest parameter is `any[]` on purpose: this is the single place where the
 * transport is untyped (IPC and JSON have no schema). Every handler narrows its
 * arguments immediately — the `assert*` helpers, or the DB service it forwards
 * to — so the looseness never escapes this boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (
  ctx: CallContext,
  ...args: any[]
) => unknown | Promise<unknown>;

/** How a channel implementation is registered with a transport. */
export type Binder = (channel: string, handler: Handler) => void;
