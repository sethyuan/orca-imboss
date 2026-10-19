import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ASSISTANT_ID } from "@shared/constants/employees";
import { readChatPrompt } from "@shared/constants/prompts";
import type { WebContents } from "electron";
import * as dbChats from "../db/chats";
import * as dbMessages from "../db/messages";
import { errorEvent, sendEventTo, toStreamEvent } from "./agent-events";
import { getAgentEnvironment } from "./environment";
import type { AgentSession as AppAgentSession } from "./session";
import { ensureSessionFile } from "./session-files";

/**
 * App-level serialized queue per `{employeeId}/{chatId}`.
 *
 * This is the single serialization point for ALL agent runs. Unlike the old
 * per-message session, the app `AgentSession` wrapper is **persistent per
 * key**: one live Pi session is reused for every message in the queue and is
 * only rebuilt when its composition signature changes (the wrapper checks
 * that on every `prepare()`). It is disposed after a 5-minute idle period.
 *
 * Messages are plain text — no reply is captured or persisted; the agent
 * posts its own output through `imb_*` tools. A failed run is reported to the
 * windows bound to the key as an `error` event and never loses the caller's
 * already-persisted message.
 *
 * A human message that arrives while the key's run is streaming can be handed
 * to that live run as a Pi **steering** message (`deliver(..., { mode:
 * "steer" })`) so it is seen after the current assistant turn instead of
 * waiting for the run to settle.
 *
 * This module also owns the session bindings: a renderer window "binds" a
 * `(employee, chat)` key to receive that session's streamed events.
 */

const IDLE_MS = 5 * 60 * 1000;

/**
 * Stored `content` of the app-generated `interrupted` notice. Fixed English so
 * the model and IM bridges can read it; the renderer shows a localized label
 * instead, and the task group rides in the message's `groupChatId`.
 */
const INTERRUPTED_NOTICE_CONTENT =
  "Boss interrupted all employee sessions in this task group chat.";

interface QueueState {
  employeeId: number;
  chatId: number;
  /** App wrapper, persistent across queued messages until idle disposal. */
  session?: AppAgentSession;
  busy: boolean;
  /** Pending turns, in arrival order. */
  queue: QueueItem[];
  idleTimer?: NodeJS.Timeout;
  /** Windows that bound this key (receive its streamed events). */
  boundSenders: Set<WebContents>;
  /** Set by lifecycle teardown so an in-flight drain stops cleanly. */
  disposed: boolean;
}

/** One queued turn, plus the promise hooks when a caller awaits it. */
interface QueueItem {
  text: string;
  /**
   * Present only for `deliverAndAwait` callers (inbound A2A requests, which
   * must answer the caller). A fire-and-forget turn has no hooks.
   */
  settle?: { resolve: () => void; reject: (err: unknown) => void };
}

const states = new Map<string, QueueState>();

/** Routing options for `deliver`. */
export interface DeliverOptions {
  /**
   * `"steer"`: if the target session is mid-run, hand the text to the live run
   * as a native Pi steering message (seen after the current assistant turn)
   * instead of queueing it. Falls back to the queue when the session is not
   * streaming. Defaults to `"queue"` (the classic serialized behavior).
   *
   * Used for human-triggered ingress: composer send, inbound integrations,
   * @-mention notify wakes and ask answers. Non-human wakes (cron ticks,
   * manual `runNow`) keep the default queue.
   */
  mode?: "steer" | "queue";
}

/**
 * Schedule a message for an agent session, serialized per (employee, chat).
 *
 * Returns immediately (fire-and-forget): if a run for the key is already in
 * flight the message is queued, otherwise a run is started and the queue is
 * drained in order. With `opts.mode === "steer"` a message that arrives while
 * the run is actively streaming is injected into that run instead of queued.
 */
export async function deliver(
  employeeId: number,
  chatId: number,
  text: string,
  opts?: DeliverOptions,
): Promise<void> {
  // Mid-run user message: steer the live Pi run so it is seen at the next turn
  // boundary rather than after the whole run settles. `isStreaming` (not just
  // `busy`) gates this: `busy` also covers the between-turns gap inside one
  // awaited `prompt()`, where a steer has no active run to be delivered into.
  const state = getOrCreateState(employeeId, chatId);
  clearIdleTimer(state);
  if (opts?.mode === "steer" && state.busy && state.session?.isStreaming) {
    try {
      await state.session.steer(text);
      return;
    } catch (err) {
      // A rejected steer must never lose the already-persisted message: fall
      // back to the serialized queue.
      console.error(
        `[session-queue] failed to steer ${employeeId} in chat ${chatId}; queueing instead:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  enqueue(employeeId, chatId, { text });
}

/**
 * Schedule a turn and resolve once it has finished.
 *
 * Used where the caller has to *answer* someone — an inbound A2A request must
 * report what the agent produced, so it cannot be fire-and-forget. Rejects when
 * the run failed (or the state was torn down), which is how the caller tells a
 * completed turn from a broken one.
 */
export function deliverAndAwait(
  employeeId: number,
  chatId: number,
  text: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    enqueue(employeeId, chatId, { text, settle: { resolve, reject } });
  });
}

function enqueue(employeeId: number, chatId: number, item: QueueItem): void {
  const state = getOrCreateState(employeeId, chatId);
  clearIdleTimer(state);
  state.queue.push(item);
  if (state.busy) return;
  state.busy = true;
  void drain(state);
}

/**
 * Wake an employee's session for a chat. The assistant deliberately has no
 * session in task group chats: it is woken in its root-chat session instead,
 * with a prompt that names the group chat to read.
 *
 * `opts` is forwarded to `deliver` — human-triggered wakes (@-mention notify,
 * ask answers) pass `{ mode: "steer" }`; cron wakes use the default queue.
 */
export async function wakeAgent(
  employeeId: number,
  chatId: number,
  fallbackText: string,
  opts?: DeliverOptions,
): Promise<void> {
  // Guard: a cron tick can race with chat deletion. If the chat is already
  // gone, drop the wake instead of materializing an orphan session for it.
  if (!dbChats.getChat(chatId)) return;
  let targetChatId = chatId;
  let text = fallbackText;
  if (employeeId === ASSISTANT_ID) {
    const rootId = dbChats.getRootChatId(chatId);
    if (rootId !== chatId) {
      targetChatId = rootId;
      text = readChatPrompt(chatId);
    }
  }
  await ensureSessionFile(employeeId, targetChatId);
  await deliver(employeeId, targetChatId, text, opts);
}

/**
 * Register a renderer window to receive a key's streamed events.
 *
 * The agent session is NOT built here: it is created lazily by `deliver()`
 * (via `ensureSession`) on the first message. Selecting a chat is therefore
 * cheap, and a run already in flight (cron / other entries) is still observed
 * because events are forwarded to `boundSenders`, independent of whether this
 * call created the session.
 */
export function bind(
  employeeId: number,
  chatId: number,
  sender: WebContents,
): void {
  const state = getOrCreateState(employeeId, chatId);
  clearIdleTimer(state);
  if (state.boundSenders.has(sender)) return;
  state.boundSenders.add(sender);
  const onDestroyed = (): void => {
    sender.removeListener("destroyed", onDestroyed);
    unbind(employeeId, chatId, sender);
  };
  sender.once("destroyed", onDestroyed);
}

/** Remove a window's binding; drop the entry once fully idle. */
export function unbind(
  employeeId: number,
  chatId: number,
  sender: WebContents,
): void {
  const key = keyFor(employeeId, chatId);
  const state = states.get(key);
  if (!state) return;
  state.boundSenders.delete(sender);
  if (state.boundSenders.size > 0 || state.busy || state.disposed) return;
  if (state.session) {
    scheduleIdleDispose(state);
  } else if (state.queue.length === 0) {
    states.delete(key);
  }
}

/** Dispose every session for one chat (chat deleted). */
export async function disposeForChat(chatId: number): Promise<void> {
  await disposeMatching((state) => state.chatId === chatId);
}

/**
 * Interrupt every agent session that belongs to a chat (the Halt button on a
 * `chat` / `progress` card).
 *
 * Targets:
 * - every non-assistant employee session keyed by `chatId` (the task group's
 *   participants); and
 * - the assistant's orchestration session for the chat's **root** chat. The
 *   assistant is deliberately never keyed by a task group (it reads groups
 *   from its root-chat session — see `wakeAgent`), so it must be resolved via
 *   `getRootChatId`. Aborting that root session also stops whatever else the
 *   assistant is orchestrating from the same root chat; that is intended.
 *
 * For each target the pending app-level queue is dropped first (so `drain()`
 * cannot immediately start the next turn once the abort resolves) and, while
 * the session is streaming, Pi's internal steering / follow-up queue is cleared
 * before the in-flight turn is aborted (clear_queue precedes abort). All
 * messages are already persisted in the DB; only their pending processing is
 * dropped.
 *
 * Best-effort: a per-session failure is logged and never aborts the sweep.
 * Returns the number of sessions actually interrupted (a live run aborted or a
 * pending queue dropped); 0 when nothing was running.
 */
export async function interruptChat(chatId: number): Promise<number> {
  // Dedupe by key so a root chat (whose id equals its own root) never signals
  // the assistant's root session twice.
  const targets = new Map<string, QueueState>();
  for (const state of states.values()) {
    if (!state.disposed && state.chatId === chatId) {
      targets.set(keyFor(state.employeeId, state.chatId), state);
    }
  }
  const rootId = dbChats.getRootChatId(chatId);
  const assistantState = states.get(keyFor(ASSISTANT_ID, rootId));
  if (assistantState && !assistantState.disposed) {
    targets.set(keyFor(ASSISTANT_ID, rootId), assistantState);
  }

  const results = await Promise.all(
    [...targets.values()].map((state) => interruptState(state)),
  );
  const interrupted = results.filter(Boolean).length;
  if (interrupted > 0) recordInterruption(chatId);
  return interrupted;
}

/**
 * Append an `interrupted` notice into the task group's root chat after a Halt,
 * so the assistant can later know the boss halted the group. System message
 * (no unread bump, no beep) and **never wakes any agent** — the boss stopped
 * these sessions on purpose; the assistant sees it on its next root-chat read.
 * Best-effort: a failure only logs and never affects the interrupt itself.
 */
function recordInterruption(groupChatId: number): void {
  try {
    const rootId = dbChats.getRootChatId(groupChatId);
    // Only a task group has a distinct root chat to record into; a root chat
    // (or an unknown id, which resolves to itself) has nothing to record.
    if (rootId === groupChatId) return;
    dbMessages.appendMessage(rootId, null, INTERRUPTED_NOTICE_CONTENT, {
      kind: "interrupted",
      groupChatId,
      silent: true,
    });
  } catch (err) {
    console.error(
      `[session-queue] failed to record interruption for chat ${groupChatId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Drop one state's pending queue and abort its in-flight run. Never throws.
 * Returns whether anything was actually interrupted (a run or a pending queue).
 */
async function interruptState(state: QueueState): Promise<boolean> {
  const hadPending = state.queue.length > 0;
  // Clear before awaiting the abort so the drain loop, unblocked by the abort,
  // cannot pick up the next queued message.
  state.queue.length = 0;
  const session = state.session;
  if (!session?.isStreaming) return hadPending;
  try {
    // RPC semantics: clear Pi's internal queues before aborting, otherwise the
    // interrupted turn would immediately continue with queued steer/follow-up
    // messages.
    session.clearQueue();
    await session.abort();
    return true;
  } catch (err) {
    console.error(
      `[session-queue] failed to interrupt ${state.employeeId} in chat ${state.chatId}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Dispose every session for one employee (employee deleted). */
export async function disposeForEmployee(employeeId: number): Promise<void> {
  await disposeMatching((state) => state.employeeId === employeeId);
}

/** Dispose every session (app quit). */
export async function disposeAll(): Promise<void> {
  await disposeMatching(() => true);
}

async function drain(state: QueueState): Promise<void> {
  try {
    while (!state.disposed) {
      const item = state.queue.shift();
      if (item === undefined) break;
      try {
        await ensureSession(state);
        if (state.disposed) {
          await disposeSessionOf(state);
          item.settle?.reject(disposedError());
          break;
        }
        await state.session?.prompt(item.text);
        item.settle?.resolve();
      } catch (err) {
        emitError(state, err);
        item.settle?.reject(err);
      }
    }
  } finally {
    // A teardown mid-queue must never leave an awaiting caller hanging.
    if (state.disposed) rejectQueued(state);
    state.busy = false;
    if (state.disposed) return;
    if (state.queue.length > 0) {
      state.busy = true;
      void drain(state);
    } else {
      scheduleIdleDispose(state);
    }
  }
}

/** Fail every queued turn (the state is going away). */
function rejectQueued(state: QueueState): void {
  for (const pending of state.queue.splice(0)) {
    pending.settle?.reject(disposedError());
  }
}

function disposedError(): Error {
  return new Error("Agent session state has been disposed.");
}

/**
 * Ensure the wrapper exists and is prepared. The wrapper itself compares the
 * composition signature and rebuilds only when needed.
 */
async function ensureSession(state: QueueState): Promise<void> {
  if (state.disposed) {
    throw new Error("Agent session state has been disposed.");
  }
  // Persist the (employee, chat) session file before building the Pi session,
  // so even a root chat (assistant ↔ user) resumes from disk instead of
  // starting in-memory. Idempotent: a recorded row is a no-op.
  await ensureSessionFile(state.employeeId, state.chatId);
  if (!state.session) {
    // Lazy import avoids a module-load cycle (session.ts imports builtin-tools,
    // which imports this module).
    const { AgentSession } = await import("./session");
    const env = getAgentEnvironment();
    state.session = new AgentSession(
      env,
      { employeeId: state.employeeId, chatId: state.chatId },
      (event) => forwardEvent(state, event),
    );
  }
  await state.session.prepare();
}

async function disposeMatching(
  predicate: (state: QueueState) => boolean,
): Promise<void> {
  const matching = [...states.values()].filter(predicate);
  await Promise.all(matching.map((state) => disposeState(state, true)));
}

function getOrCreateState(employeeId: number, chatId: number): QueueState {
  const key = keyFor(employeeId, chatId);
  let state = states.get(key);
  if (!state) {
    state = {
      employeeId,
      chatId,
      busy: false,
      queue: [],
      boundSenders: new Set(),
      disposed: false,
    };
    states.set(key, state);
  }
  return state;
}

function keyFor(employeeId: number, chatId: number): string {
  return `${employeeId}/${chatId}`;
}

function clearIdleTimer(state: QueueState): void {
  if (state.idleTimer !== undefined) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
}

function scheduleIdleDispose(state: QueueState): void {
  if (state.disposed) return;
  clearIdleTimer(state);
  state.idleTimer = setTimeout(() => {
    state.idleTimer = undefined;
    void disposeState(state, false);
  }, IDLE_MS);
}

/**
 * Tear down the state's session. `forceRemove` marks the state disposed and
 * drops it from the registry (lifecycle teardown); otherwise the entry is
 * removed only when nothing is bound and the queue is empty.
 */
async function disposeState(
  state: QueueState,
  forceRemove: boolean,
): Promise<void> {
  clearIdleTimer(state);
  if (forceRemove) {
    state.disposed = true;
    states.delete(keyFor(state.employeeId, state.chatId));
    // The drain loop will not pick these up again; fail them explicitly.
    rejectQueued(state);
  }

  await disposeSessionOf(state);

  if (state.disposed || state.busy) return;
  if (state.queue.length > 0) {
    state.busy = true;
    void drain(state);
    return;
  }
  if (state.boundSenders.size === 0) {
    states.delete(keyFor(state.employeeId, state.chatId));
  }
}

/** Dispose the wrapper (if any) and clear the reference; never throws. */
async function disposeSessionOf(state: QueueState): Promise<void> {
  const session = state.session;
  state.session = undefined;
  if (!session) return;
  try {
    await session.dispose();
  } catch (err) {
    console.error(
      `[session-queue] failed to dispose session for ${state.employeeId} in chat ${state.chatId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Forward a raw Pi event to this key's bound windows (whitelisted DTOs). */
function forwardEvent(state: QueueState, event: AgentSessionEvent): void {
  const dto = toStreamEvent(event);
  if (dto) {
    sendEventTo(state.boundSenders, state.employeeId, state.chatId, dto);
  }
}

/** Report a failed run to the bound windows and the log. */
function emitError(state: QueueState, err: unknown): void {
  console.error(
    `[session-queue] run for ${state.employeeId} in chat ${state.chatId} failed:`,
    err instanceof Error ? err.message : err,
  );
  sendEventTo(
    state.boundSenders,
    state.employeeId,
    state.chatId,
    errorEvent(err),
  );
}
