import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { ASSISTANT_ID } from "@shared/constants/employees";
import { readChatPrompt } from "@shared/constants/prompts";
import type {
  AgentProgressKind,
  AgentSessionRunState,
  AgentSessionSendResult,
  AgentSessionSteerPhase,
  AgentSessionSteerRevokeResult,
} from "@shared/types";
import type { Subscriber } from "../rpc/types";
import * as dbChats from "../db/chats";
import * as dbMessages from "../db/messages";
import { errorEvent, sendEventTo, toStreamEvent } from "./agent-events";
import { getAgentEnvironment } from "./environment";
import { recordRunFailure } from "./run-failure";
import type { AgentSession as AppAgentSession } from "./session";
import { ensureSessionFile } from "./session-files";
import {
  toolCallNames,
  type AgentSessionActivity,
  type LiveAgentOutput,
  type LiveProgress,
  type OpenToolCall,
} from "./session-stat";
import { extractTextContent, projectLiveAssistant } from "./session-view";
import { takeUndelivered, userMessageText } from "./steer-ledger";
import {
  claimInjected,
  losePendingSteers,
  pendingOccurrenceOf,
  pendingSteerTexts,
  steerStateOf,
  type SteerRecord,
} from "./steer-records";

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
 * waiting for the run to settle. Each such hand-over is tracked as a
 * `SteerRecord` (see `steer-records.ts`) so the boss can withdraw one specific
 * interjection while it is still queued —
 * `revokeSteer()` is the other half of `deliver()`.
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
  /** Pending message texts, in arrival order. */
  queue: string[];
  idleTimer?: NodeJS.Timeout;
  /** Windows that bound this key (receive its streamed events). */
  boundSenders: Set<Subscriber>;
  /**
   * Interjections this app successfully handed to the **current** run, in
   * hand-over order. Reset at the start of every run, so it only ever describes
   * the in-flight one. See `steer-records.ts` for why it exists (withdrawal
   * needs a per-copy handle, the interrupt ledger needs the pending texts).
   */
  steers: SteerRecord[];
  /** Monotonic source of `SteerRecord.id` (never reused within a state). */
  steerSeq: number;
  /**
   * Serializes the operations that mutate Pi's steering queue as a whole —
   * `revokeSteer()` (clear + re-queue) and the two interrupt flavors (clear +
   * abort). Interleaving them would clear a queue the other side is rebuilding
   * and silently drop the boss's messages; the hand-over in `deliver()` takes
   * the same lock so a steer can never land inside someone else's clear window.
   */
  ops: Promise<void>;
  /**
   * Texts of the current run's `user` messages that Pi actually persisted
   * (observed through `message_end`). Reset with `steers`; the difference
   * between the two is what an interrupt re-queues.
   */
  deliveredSteers: string[];
  /**
   * True when the last event forwarded to the bound windows was a
   * `message_end`, i.e. the last assistant message is already persisted and Pi
   * state may still hold it as `streamingMessage`.
   *
   * A window binding at that moment must **not** receive it as a live seed: the
   * projection already contains it, so the seed would render it twice.
   */
  lastForwardedWasMessageEnd: boolean;
  /**
   * Wall-clock ms when the current run started, recorded by `drain()` right
   * before `prompt()`. The basis for `imb_get_employee_stat`'s
   * `progress.runAgeSeconds` — Pi's own state carries no timestamps, so the app
   * records event arrival times here. Reset at every run start.
   */
  runStartedAt?: number;
  /**
   * Wall-clock ms of the last **observable** progress of the current run: a
   * streamed delta, a message/turn boundary, a tool start/update/end, a retry
   * note. Silence here is what "looks stuck" means from the outside.
   */
  lastProgressAt?: number;
  /** Which event that last progress was (see `AgentProgressKind`). */
  lastProgressKind?: AgentProgressKind;
  /**
   * Tool calls of the current run that have not finished yet, keyed by tool-call
   * id. A long-running tool (a download, a slow command) sits here for minutes
   * while no other event arrives — which is exactly what the status probe
   * reports as `progress.activeTool`.
   *
   * Nested calls (`parentToolCallId`) and a call whose `tool_execution_end`
   * never arrived (an abort mid-call) both live here; the map is cleared at
   * every run start and dies with the queue state, so it cannot grow unbounded.
   * The raw `args` are kept for open calls only (they can be large); they are
   * serialized and truncated at read time, never stored formatted.
   */
  openTools: Map<string, OpenToolCall>;
  /** Tool calls started in the current run (including nested ones). */
  toolCallsThisRun: number;
  /**
   * `stopReason` / `errorMessage` of the **last** assistant message of the run
   * in flight. Pi retries a failed turn internally and then ends the run
   * normally (no rejection), so this is the only way to tell "this run failed"
   * apart from "it finished": the last assistant message is `error` only when
   * every retry was used up (or the error was never retryable). Reset at every
   * run start.
   */
  lastAssistantStop?: { stopReason: string; errorMessage?: string };
  /** Automatic retries Pi announced during the run in flight (for the notice). */
  retryAttempts: number;
  /**
   * Set right before an interrupt aborts the run. An aborted run also ends with
   * an `error`-stopped assistant message and a cancelled retry, so this flag is
   * what keeps an intentional interrupt from being reported as a failure.
   */
  abortRequested: boolean;
  /** Set by lifecycle teardown so an in-flight drain stops cleanly. */
  disposed: boolean;
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
 * Returns once the routing decision is made (never waits for the run): the
 * result tells the caller how the text was handed over — `mode: "steer"` when
 * it went into the live Pi run (with the interjection's `steerId`, so the caller
 * can withdraw it), `mode: "queued"` when it joined the serialized queue.
 * With `opts.mode === "steer"` a message that arrives while the run is actively
 * streaming is injected into that run instead of queued.
 */
export async function deliver(
  employeeId: number,
  chatId: number,
  text: string,
  opts?: DeliverOptions,
): Promise<AgentSessionSendResult> {
  const state = getOrCreateState(employeeId, chatId);
  clearIdleTimer(state);
  // Mid-run user message: steer the live Pi run so it is seen at the next turn
  // boundary rather than after the whole run settles. `isStreaming` (not just
  // `busy`) gates this: `busy` also covers the between-turns gap inside one
  // awaited `prompt()`, where a steer has no active run to be delivered into.
  //
  // The hand-over runs under the queue lock: it must not land inside a
  // withdrawal's clear→re-queue window or an interrupt's clear→abort window,
  // where Pi would drop it without the app noticing. The decision is re-made
  // inside the lock for the same reason.
  if (opts?.mode === "steer") {
    let steered: string | null = null;
    try {
      steered = await runExclusive(state, async (): Promise<string | null> => {
        if (state.disposed) return null;
        clearIdleTimer(state);
        if (!state.busy || !state.session?.isStreaming) return null;
        try {
          // `steer()` reports the text Pi actually queued (skill/template
          // expansion happens inside Pi), which is the only safe withdrawal
          // key.
          const effectiveText = await state.session.steer(text);
          state.steerSeq += 1;
          const record: SteerRecord = {
            id: `st${state.steerSeq}`,
            text,
            effectiveText,
            phase: "pending",
          };
          // Recorded *before* returning so an interrupt or a withdrawal that
          // starts next always sees it, and so an interrupt can re-queue
          // exactly the texts that were still pending (see
          // `steer-ledger.ts`).
          state.steers.push(record);
          emitSteerState(state, record);
          return record.id;
        } catch (err) {
          // A rejected steer must never lose the already-persisted message:
          // fall back to the serialized queue.
          console.error(
            `[session-queue] failed to steer ${employeeId} in chat ${chatId}; queueing instead:`,
            err instanceof Error ? err.message : err,
          );
          return null;
        }
      });
    } catch (err) {
      // The lock itself failed (a bug, not a delivery outcome): the text must
      // still reach the agent, so fall back to the serialized queue.
      console.error(
        `[session-queue] failed to run the steer hand-over for ${employeeId} in chat ${chatId}; queueing instead:`,
        err instanceof Error ? err.message : err,
      );
      steered = null;
    }
    if (steered !== null) return { mode: "steer", steerId: steered };
  }
  state.queue.push(text);
  if (state.busy) return { mode: "queued" };
  state.busy = true;
  void drain(state);
  return { mode: "queued" };
}

/**
 * Withdraw one interjection — remove the text from Pi's steering queue so the
 * model never sees it.
 *
 * Only a **pending** interjection can be withdrawn (Pi has not turned it into a
 * transcript user message yet). Everything else is a normal, non-exceptional
 * outcome, reported through `AgentSessionSteerRevokeResult.reason`:
 *
 * - `delivered`: already injected — the model has read it, and taking it back
 *   would mean rolling back the turn, not withdrawing a queue entry;
 * - `gone`: no longer pending (run ended, session disposed, queue cleared);
 * - `unknown`: the attempt failed, the queue state could not be determined.
 *
 * Correctness rules (see `steer-records.ts` and `AgentSession.removeQueuedSteer`):
 * - the target is addressed by its **queued** text plus its ordinal among equal
 *   pending copies — two identical interjections are two records, and Pi's
 *   queue holds texts only;
 * - a text that cannot be located is **not** touched: the same Pi queue also
 *   carries employee @-mention wakes and IM bridge texts, which must survive;
 * - whatever happens, the record leaves the interrupt ledger, so an interrupt
 *   can never re-deliver a message the boss already took back.
 */
export async function revokeSteer(
  employeeId: number,
  chatId: number,
  steerId: string,
): Promise<AgentSessionSteerRevokeResult> {
  const state = states.get(keyFor(employeeId, chatId));
  if (!state || state.disposed) return { withdrawn: false, reason: "gone" };
  const record = state.steers.find((candidate) => candidate.id === steerId);
  if (!record) return { withdrawn: false, reason: "gone" };
  if (record.phase === "revoked") return { withdrawn: true };
  if (record.phase === "injected")
    return { withdrawn: false, reason: "delivered" };
  if (record.phase !== "pending") return { withdrawn: false, reason: "gone" };

  return runExclusive(
    state,
    async (): Promise<AgentSessionSteerRevokeResult> => {
      const session = state.session;
      // No live run means no queue entry can still be pending: Pi only keeps
      // steering messages for a run in flight, and the state is torn down with it.
      if (state.disposed || !session || !session.isStreaming) {
        settleSteer(state, record, "lost");
        return { withdrawn: false, reason: "gone" };
      }
      try {
        const removed = await session.removeQueuedSteer(
          record.effectiveText,
          pendingOccurrenceOf(state.steers, record),
        );
        if (!removed) {
          // Still streaming but the text is no longer queued: Pi injected it while
          // the withdrawal was on its way. Decide conservatively — report it as
          // delivered rather than pretend the boss got his way.
          settleSteer(state, record, "injected");
          return { withdrawn: false, reason: "delivered" };
        }
        settleSteer(state, record, "revoked");
        return { withdrawn: true };
      } catch (err) {
        console.error(
          `[session-queue] failed to withdraw the interjection ${steerId} of ${employeeId} in chat ${chatId}:`,
          err instanceof Error ? err.message : err,
        );
        // The queue may hold half of the old contents: report the state as
        // undetermined and keep the text out of the interrupt ledger (a message the
        // boss wanted back must never be re-delivered by an interrupt).
        settleSteer(state, record, "unknown");
        return { withdrawn: false, reason: "unknown" };
      }
    },
  );
}

/**
 * Serialize one queue-wide mutation per session state (see `QueueState.ops`).
 *
 * A failure of one operation never blocks the next: the chain is reset to a
 * resolved promise either way, and the caller gets its own rejection.
 */
async function runExclusive<T>(
  state: QueueState,
  operation: () => Promise<T>,
): Promise<T> {
  const run = state.ops.then(operation, operation);
  state.ops = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Set one record's phase and tell the bound windows about it. */
function settleSteer(
  state: QueueState,
  record: SteerRecord,
  phase: AgentSessionSteerPhase,
): void {
  record.phase = phase;
  emitSteerState(state, record);
}

/** Push one record's new phase to this key's bound windows (same channel as the stream). */
function emitSteerState(state: QueueState, record: SteerRecord): void {
  sendEventTo(state.boundSenders, state.employeeId, state.chatId, {
    type: "steer_state",
    steer: steerStateOf(record),
  });
}

/**
 * Snapshot of one session's run state for the agent-session view's labels
 * (`Send` vs `Interject`, interrupt chip enabled/disabled) and for restoring its
 * interjection placeholders after a remount.
 *
 * Read-only and side-effect free: it never creates a queue state or a Pi
 * session, because opening/labelling the view must not build anything. Purely
 * cosmetic — `deliver()` re-checks the live session before steering,
 * `revokeSteer()` re-validates the record before touching the queue, and
 * `interruptTurn()` has the exact same `isStreaming` gate.
 */
export function readRunState(
  employeeId: number,
  chatId: number,
): AgentSessionRunState {
  const state = states.get(keyFor(employeeId, chatId));
  if (!state || state.disposed) return { streaming: false };
  return {
    streaming: state.session?.isStreaming ?? false,
    // Copied into plain DTOs: the renderer must never hold a live record.
    steers: state.steers.map(steerStateOf),
  };
}

/**
 * Live run snapshot of one session for the assistant's status probe
 * (`imb_get_employee_stat`).
 *
 * Side-effect free in exactly the same way as `readRunState`: it only reads
 * entries that already exist, so asking about a session never creates a queue
 * state or a Pi session for it.
 *
 * `live` carries the **in-flight** assistant message (the part that is not
 * persisted yet) and uses the same three guards as `sendLiveSeed`, because the
 * live Pi state is the same source:
 * - not streaming → there is no in-flight message;
 * - `lastForwardedWasMessageEnd` → the message Pi still holds as
 *   `streamingMessage` is already in the transcript, so reporting it as "live"
 *   would double-report it;
 * - nothing readable yet (run between turns, e.g. a tool is executing, or no
 *   token streamed yet) → `live` stays absent rather than empty.
 *
 * `queued` is the app-level backlog — future work, never part of "what is it
 * doing now". `progress` carries the timing of the run in flight (see
 * `LiveProgress`), which is the only way to tell a slow tool from a wedged one:
 * a message that is not persisted yet has no timestamp of its own.
 */
export function readSessionActivity(
  employeeId: number,
  chatId: number,
): AgentSessionActivity {
  const state = states.get(keyFor(employeeId, chatId));
  if (!state || state.disposed) return { streaming: false, queued: 0 };
  const streaming = state.session?.isStreaming ?? false;
  const queued = state.queue.length;
  // Timing is only meaningful for a run in flight, and only when this app
  // observed its start (a start time is never invented).
  const progress =
    streaming && state.runStartedAt !== undefined
      ? readLiveProgress(state)
      : undefined;
  const withProgress = (
    activity: AgentSessionActivity,
  ): AgentSessionActivity => (progress ? { ...activity, progress } : activity);
  if (!streaming || !state.busy || state.lastForwardedWasMessageEnd) {
    return withProgress({ streaming, queued });
  }
  try {
    const partial = state.session?.streamingAssistant;
    if (!partial) return withProgress({ streaming, queued });
    const live: LiveAgentOutput = {
      text: extractTextContent(partial.content),
      toolCalls: toolCallNames(partial.content),
    };
    if (live.text.length === 0 && live.toolCalls.length === 0) {
      return withProgress({ streaming, queued });
    }
    return withProgress({ streaming, queued, live });
  } catch (err) {
    // A status probe must never break because live Pi state was unexpected.
    console.error(
      `[session-queue] failed to read the live output of ${employeeId} in chat ${chatId}:`,
      err instanceof Error ? err.message : err,
    );
    return withProgress({ streaming, queued });
  }
}

/**
 * Snapshot the timing bookkeeping of the run in flight (see `LiveProgress`).
 *
 * Read-only: it copies the values `drain()` / `forwardEvent()` maintain, so the
 * caller gets a frozen view that later events cannot mutate (the `openTools` map
 * is copied because the live one keeps changing).
 */
function readLiveProgress(state: QueueState): LiveProgress {
  const runStartedAt = state.runStartedAt ?? Date.now();
  return {
    runStartedAt,
    lastProgressAt: state.lastProgressAt ?? runStartedAt,
    lastProgressKind: state.lastProgressKind ?? "run_start",
    openTools: new Map(state.openTools),
    toolCallsThisRun: state.toolCallsThisRun,
  };
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
 *
 * A window that binds **mid-run** also receives one `live_seed`: the in-flight
 * assistant message as it looks right now. Without it, everything that streamed
 * before the bind (e.g. while the user was on another page — the view unbinds
 * on unmount) could never be rendered again, because the token-level stream
 * only carries deltas and the message is not persisted until `message_end`.
 * The seed is computed synchronously here, from live Pi state, so it is exactly
 * the state at bind time; every later event is strictly newer.
 */
export function bind(
  employeeId: number,
  chatId: number,
  sender: Subscriber,
): void {
  const state = getOrCreateState(employeeId, chatId);
  clearIdleTimer(state);
  sendLiveSeed(state, sender);
  if (state.boundSenders.has(sender)) return;
  state.boundSenders.add(sender);
  // `onClose` fires once; the returned disposer is unused on purpose (the
  // registration is as short-lived as the subscriber).
  sender.onClose(() => {
    unbind(employeeId, chatId, sender);
  });
}

/**
 * Push the currently streaming assistant message to one window (best effort).
 *
 * Skipped when nothing is streaming, when the in-flight message is already
 * persisted, or when Pi exposes no partial message. A failure only logs: a lost
 * seed degrades to the previous behaviour (the tail arrives with the next
 * delta), it must never break `bind`.
 */
function sendLiveSeed(state: QueueState, sender: Subscriber): void {
  const session = state.session;
  if (!state.busy || state.disposed || !session?.isStreaming) return;
  if (state.lastForwardedWasMessageEnd) return;
  try {
    const partial = session.streamingAssistant;
    if (!partial) return;
    const blocks = projectLiveAssistant(
      partial.content,
      partial.pendingToolCalls,
    );
    sendEventTo(new Set([sender]), state.employeeId, state.chatId, {
      type: "live_seed",
      blocks,
    });
  } catch (err) {
    console.error(
      `[session-queue] failed to build the live seed for ${state.employeeId} in chat ${state.chatId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Remove a window's binding; drop the entry once fully idle. */
export function unbind(
  employeeId: number,
  chatId: number,
  sender: Subscriber,
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
    [...targets.values()].map((state) =>
      runExclusive(state, () => interruptState(state)),
    ),
  );
  const interrupted = results.filter(Boolean).length;
  if (interrupted > 0) recordInterruption(chatId);
  return interrupted;
}

/**
 * Interrupt the **current turn** of one `(employee, chat)` session — the
 * per-session counterpart of `interruptChat`, used by the read-only
 * agent-session view.
 *
 * Deliberately different from `interruptChat`:
 * - only this one session is touched (no whole-chat sweep and no redirect to
 *   the assistant's root orchestration session);
 * - the session is **not** torn down and its pending work is **kept**: the app
 *   queue is left intact, only Pi's internal steering / follow-up queue is
 *   drained — and its texts are **re-queued** rather than thrown away (see
 *   below). Everything already queued still runs once the aborted turn settles.
 *   This is the default flavor; `imb_interrupt` uses the `dropQueue` redirect
 *   mode described further down, which discards that pending work instead;
 * - the aborted turn itself is **not** rolled back: whatever the model already
 *   produced and read stays in its context (the boss's explicit decision), so
 *   the `read_cursors` bookkeeping of `imb_read_chat` keeps matching what the
 *   model has actually seen;
 * - nothing is written into any chat. The only record is a marker entry in the
 *   session transcript (`session.markInterrupted()`), drawn by the read-only
 *   view as the「已中断」separator.
 *
 * ## Why the steer handling is not just `abort()`
 *
 * A steer handed over before the interrupt can be in three states (full reasoning
 * in `steer-ledger.ts`); one of them — handed to Pi, not yet persisted, run
 * aborted — loses the boss's message silently. So:
 *
 * 1. snapshot the app's ledger of texts handed to this run,
 * 2. `clearQueue()` **before** `abort()`: that is Pi's own record of the texts
 *    not yet injected (its RPC contract is to clear before aborting, otherwise
 *    the aborted turn would immediately continue with them),
 * 3. abort, then wait (bounded) for the run to settle — Pi still emits
 *    `message_end` during teardown, and those events are what mark a steer as
 *    already persisted,
 * 4. re-queue only `handedOver - delivered`, keeping their original order, and
 *    let `drain()` run them next (identical texts are counted per copy, never
 *    merged).
 * 5. append the「已中断」marker **after** all of that, so it lands at the exact
 *    cut point and never becomes part of an earlier position.
 *
 * Why the queue keeps draining afterwards: `drain()` awaits `session.prompt()`,
 * which awaits the whole Pi run. Aborting settles that run (the agent loop closes
 * the assistant message with `stopReason: "aborted"` and the run lifecycle
 * resolves instead of rethrowing), so the `while` loop in `drain()` simply picks
 * up the next queued text — the re-queued steers included. Only when the drain
 * loop already finished (the abort landed after the run ended) does the interrupt
 * have to start it itself.
 *
 * ## `dropQueue` — the redirect mode of `imb_interrupt`
 *
 * `imb_interrupt` must leave the employee with **only** the new instruction, so
 * it calls `interruptTurnDiscardingQueue()`, which passes `dropQueue: true`:
 * the app-level queue is emptied (instead of being kept) and the undelivered
 * steered texts are discarded (instead of being re-queued). The plain
 * `interruptTurn()` — the read-only view's chip, `agentSession:interruptTurn` —
 * is unchanged: it keeps pending work and re-queues steers.
 *
 * Exact guarantee of the redirect mode, and its honest limits:
 * - the app queue is emptied **before the first `await`**, so `drain()` can no
 *   longer pick up another pending text from it;
 * - a text `drain()` has **already shifted** cannot be revoked — if its run is
 *   streaming it is aborted like any other turn, but one that had not reached
 *   `prompt()` yet may still run once. This is the conservative side: we clear
 *   everything removable and let the employee re-read the chat afterwards (the
 *   instruction is in the chat either way), rather than leave half of the old
 *   work queued;
 * - `deliver()` calls that arrive *after* the clear (a teammate's @-mention, a
 *   cron tick) are of course not affected — the guarantee is "empty at the
 *   moment of the interrupt", not "stays empty";
 * - the queue is cleared again **after** the run settles, because `drain()`'s
 *   `while` loop resumes once the abort resolves, and a text pushed during that
 *   window must not survive either.
 *
 * Returns `false` (harmless no-op) when the key has no live session or is not
 * streaming, i.e. clicking the button on an idle session does nothing at all — no
 * marker, no re-queue.
 */
export async function interruptTurn(
  employeeId: number,
  chatId: number,
): Promise<boolean> {
  const state = states.get(keyFor(employeeId, chatId));
  if (!state || state.disposed) return false;
  return runExclusive(state, () =>
    interruptSession(state, { dropQueue: false }),
  );
}

/**
 * Interrupt one `(employee, chat)` session **and discard everything pending**
 * in it — the redirect semantics of `imb_interrupt` (see `interruptTurn`'s
 * `dropQueue` section).
 *
 * A session that is not streaming is not an error: the pending queue is still
 * dropped (that is the point), nothing is aborted, and the caller delivers its
 * new instruction afterwards. Returns whether a streaming run was aborted, like
 * `interruptTurn`; how much pending work was thrown away is only logged, never
 * part of a public result.
 */
export async function interruptTurnDiscardingQueue(
  employeeId: number,
  chatId: number,
): Promise<boolean> {
  const state = states.get(keyFor(employeeId, chatId));
  if (!state || state.disposed) return false;
  return runExclusive(state, () =>
    interruptSession(state, { dropQueue: true }),
  );
}

/**
 * Shared implementation of the two interrupt flavors. `dropQueue` switches
 * between "keep and re-queue pending work" (the view's chip) and "discard it"
 * (the assistant's redirect). Returns whether a streaming run was aborted; the
 * discarded amounts are logged here and nowhere else.
 */
async function interruptSession(
  state: QueueState,
  options: { dropQueue: boolean },
): Promise<boolean> {
  const { dropQueue } = options;
  let droppedQueued = 0;
  let droppedSteers = 0;

  // Clearing happens before the first `await` so the drain loop cannot start
  // another queued text while the abort is still being set up. This is the
  // conservative order: clear first, then stop the running turn.
  if (dropQueue) {
    droppedQueued = state.queue.length;
    state.queue.length = 0;
  }

  const session = state.session;
  if (!session?.isStreaming) {
    if (dropQueue) {
      // Pi's own steering / follow-up queues should be empty while idle, but a
      // stale text there is exactly what this mode promises not to run.
      const cleared = session?.clearQueue() ?? { steering: [], followUp: [] };
      droppedSteers = cleared.steering.length + cleared.followUp.length;
      losePendingSteers(state.steers).forEach((record) =>
        emitSteerState(state, record),
      );
      state.steers.length = 0;
      state.deliveredSteers.length = 0;
      console.log(
        `[session-queue] discarded the pending work of ${state.employeeId} in chat ${state.chatId} ` +
          `(nothing was running): ${droppedQueued} queued message${droppedQueued === 1 ? "" : "s"}, ` +
          `${droppedSteers} steered message${droppedSteers === 1 ? "" : "s"}`,
      );
    }
    return false;
  }

  // Hold the *array*, not a copy: a steer handed over while the abort is still
  // in flight would be dropped by the dying run, so it must be accounted for
  // too. `drain()` replaces it when a new run starts, which is exactly the point
  // where a late steer stops belonging to this run.
  const records = state.steers;
  const delivered = state.deliveredSteers;
  try {
    const cleared = session.clearQueue();
    // An interrupt must not be reported as a failed run: the abort leaves an
    // `error`-stopped assistant message and a cancelled retry behind.
    state.abortRequested = true;
    await session.abort();
    await session.waitForRunSettled();
    // Only the records still marked `pending` are handed over: a withdrawn one
    // must never be re-delivered by the interrupt (see `steer-records.ts`).
    const requeue = takeUndelivered(
      [pendingSteerTexts(records), cleared.steering, cleared.followUp],
      delivered,
    );
    // This run is over; nothing may be counted twice for a later interrupt. The
    // records are settled before the array is dropped, so the view learns that
    // these interjections are no longer withdrawable (and their text may be
    // re-queued below, which no longer carries an interjection identity).
    losePendingSteers(records).forEach((record) =>
      emitSteerState(state, record),
    );
    records.length = 0;
    delivered.length = 0;
    // Marker last: it must sit at the exact cut point of the transcript.
    session.markInterrupted();
    if (dropQueue) {
      // The drain loop resumes as soon as the abort resolves; take out anything
      // that slipped in during the abort window (a concurrent `deliver()`), and
      // never re-insert the undelivered steers.
      droppedQueued += state.queue.length;
      state.queue.length = 0;
      droppedSteers = requeue.length;
      console.log(
        `[session-queue] interrupted the current turn of ${state.employeeId} in chat ${state.chatId} ` +
          `and discarded its pending work: ${droppedQueued} queued message${droppedQueued === 1 ? "" : "s"}, ` +
          `${droppedSteers} steered message${droppedSteers === 1 ? "" : "s"}`,
      );
    } else {
      prependToQueue(state, requeue);
      console.log(
        `[session-queue] interrupted the current turn of ${state.employeeId} in chat ${state.chatId}: ` +
          `re-queued ${requeue.length} steered message${requeue.length === 1 ? "" : "s"}`,
      );
    }
    return true;
  } catch (err) {
    console.error(
      `[session-queue] failed to interrupt the current turn of ${state.employeeId} in chat ${state.chatId}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Put texts at the **front** of the app queue and make sure they get drained.
 *
 * Re-queued steers keep their relative order and run before anything that was
 * already waiting, matching the order the boss sent them in. A drain already in
 * flight picks them up on its next iteration; otherwise one is started here
 * (the interrupt may land after the run it stopped had already finished).
 */
function prependToQueue(state: QueueState, texts: string[]): void {
  if (texts.length === 0) return;
  state.queue.unshift(...texts);
  clearIdleTimer(state);
  if (state.busy) return;
  state.busy = true;
  void drain(state);
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
  // A Halt throws the whole pending work away, interjections included: settle
  // the records so the bound views stop offering a withdrawal for them.
  losePendingSteers(state.steers).forEach((record) =>
    emitSteerState(state, record),
  );
  state.steers.length = 0;
  if (!session?.isStreaming) return hadPending;
  try {
    // RPC semantics: clear Pi's internal queues before aborting, otherwise the
    // interrupted turn would immediately continue with queued steer/follow-up
    // messages.
    session.clearQueue();
    state.abortRequested = true;
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
      const text = state.queue.shift();
      if (text === undefined) break;
      try {
        await ensureSession(state);
        if (state.disposed) {
          await disposeSessionOf(state);
          break;
        }
        // A new run starts: the steer records and the progress bookkeeping
        // describe exactly this run only.
        state.steers = [];
        state.deliveredSteers = [];
        state.runStartedAt = Date.now();
        state.lastProgressAt = state.runStartedAt;
        state.lastProgressKind = "run_start";
        state.openTools.clear();
        state.toolCallsThisRun = 0;
        state.lastAssistantStop = undefined;
        state.retryAttempts = 0;
        state.abortRequested = false;
        await state.session?.prompt(text);
        // A failed run does not reject: Pi retries the turn itself and then ends
        // the run with an `error`-stopped assistant message. Read that off the
        // event stream and make the failure durable (chat notice + assistant).
        const failure = runFailureOf(state);
        if (failure !== null) reportRunFailure(state, failure);
      } catch (err) {
        emitError(state, err);
      }
    }
  } finally {
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
      steers: [],
      steerSeq: 0,
      ops: Promise.resolve(),
      deliveredSteers: [],
      lastForwardedWasMessageEnd: false,
      openTools: new Map(),
      toolCallsThisRun: 0,
      retryAttempts: 0,
      abortRequested: false,
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
  // The steering queue dies with the Pi session: whatever was still pending can
  // never be delivered (and can never be withdrawn anymore).
  losePendingSteers(state.steers).forEach((record) =>
    emitSteerState(state, record),
  );
  state.steers.length = 0;
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

/**
 * Forward a raw Pi event to this key's bound windows (whitelisted DTOs).
 *
 * Also the one place that observes **which steered messages Pi persisted**: every
 * `message_end` for a `user` message means that text is now part of the
 * transcript (and was therefore seen by the model). Recorded only while a run is
 * in flight — the ledger is per run.
 *
 * And the place where an interjection becomes irreversible: Pi removes the first
 * queue entry matching a **starting user message**, so the same rule settles the
 * corresponding `SteerRecord` as `injected` (see `steer-records.ts`). This is
 * what makes the view's 「撤回」button disappear exactly when withdrawal stops
 * being possible.
 */
function forwardEvent(state: QueueState, event: AgentSessionEvent): void {
  if (event.type === "message_end") {
    const message = event.message as {
      role?: unknown;
      content?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
    };
    if (message?.role === "user") {
      const text = userMessageText(message.content);
      if (state.steers.some((record) => record.phase === "pending")) {
        state.deliveredSteers.push(text);
        // Fallback for a hand-over whose queued form could not be observed: the
        // text is in the transcript now, so it is no longer withdrawable either
        // way. A record already claimed on `message_start` is simply not found.
        const claimed = claimInjected(state.steers, text);
        if (claimed) emitSteerState(state, claimed);
      }
    }
    if (message?.role === "assistant") {
      // Remembered so `drain()` can tell a finished run from a failed one. The
      // last assistant message of a run is the meaningful one: an earlier
      // retryable failure is superseded by a successful retry.
      const stopReason =
        typeof message.stopReason === "string" ? message.stopReason : "unknown";
      const errorMessage =
        typeof message.errorMessage === "string"
          ? message.errorMessage
          : undefined;
      state.lastAssistantStop = { stopReason, errorMessage };
    }
    // Only an assistant `message_end` means the last streamed message is now
    // part of the transcript (a user message is persisted before its answer) —
    // see `QueueState.lastForwardedWasMessageEnd`.
    state.lastForwardedWasMessageEnd = message?.role !== "user";
  } else if (
    event.type === "message_start" ||
    event.type === "message_update"
  ) {
    state.lastForwardedWasMessageEnd = false;
    if (event.type === "message_start") {
      const message = event.message as { role?: unknown; content?: unknown };
      if (message?.role === "user") {
        const claimed = claimInjected(
          state.steers,
          userMessageText(message.content),
        );
        if (claimed) emitSteerState(state, claimed);
      }
    }
  } else if (event.type === "agent_settled") {
    // The run is fully over: nothing is queued anymore, and an interjection that
    // is still `pending` here was never injected. It is not withdrawable
    // anymore, so tell the view instead of leaving a dead 「撤回」button behind.
    losePendingSteers(state.steers).forEach((record) =>
      emitSteerState(state, record),
    );
  }
  noteProgress(state, event);
  const dto = toStreamEvent(event);
  if (dto) {
    sendEventTo(state.boundSenders, state.employeeId, state.chatId, dto);
  }
}

/**
 * Record the timing of the run in flight from the raw event stream.
 *
 * Pi's own state exposes no timestamps (`isStreaming`, `streamingMessage`,
 * `pendingToolCalls` ids only), so the app's only source for "how long has this
 * been going" is the arrival time of the events it already receives — this is
 * the write half of `imb_get_employee_stat`'s `progress` block. No new
 * subscription and no timer: every event of this session already lands here.
 *
 * Only the events that mean *observable progress* refresh `lastProgressAt`. A
 * `tool_execution_start` without a matching end is what a wedged tool looks
 * like, and it stays visible through `openTools` (reported as `activeTool`).
 * Events that are not progress (compaction bookkeeping, `entry_appended`,
 * `queue_update`, an incoming steer, …) are deliberately ignored so that a
 * steer arriving mid-run cannot fake activity.
 */
function noteProgress(state: QueueState, event: AgentSessionEvent): void {
  switch (event.type) {
    case "agent_start":
      markProgress(state, "run_start");
      break;
    case "turn_start":
      markProgress(state, "turn_start");
      break;
    case "message_start":
      markProgress(state, "message_start");
      break;
    case "message_update":
      // Per-token/thinking/tool-call deltas: the assistant is actively writing.
      markProgress(state, "token");
      break;
    case "message_end":
      markProgress(state, "message_end");
      break;
    case "tool_execution_start": {
      const startedAt = Date.now();
      state.openTools.set(event.toolCallId, {
        name: event.toolName,
        args: event.args,
        startedAt,
      });
      state.toolCallsThisRun += 1;
      markProgress(state, "tool_start", startedAt);
      break;
    }
    case "tool_execution_update":
      // Only tools that report partial results emit this; it proves the call is
      // still making progress. `activeTool.ageSeconds` keeps counting from the
      // call's own start, so the two values diverge exactly when a tool is
      // quietly working versus completely silent.
      markProgress(state, "tool_update");
      break;
    case "tool_execution_end":
      state.openTools.delete(event.toolCallId);
      markProgress(state, "tool_end");
      break;
    case "auto_retry_start":
      // Waiting for an automatic retry: the app is alive but no model output
      // will arrive for `delayMs`. Counted so a failure notice can say how many
      // retries Pi already spent on this turn.
      state.retryAttempts += 1;
      markProgress(state, "retry_wait");
      break;
    default:
      break;
  }
}

/** Stamp the last observable progress of the current run. */
function markProgress(
  state: QueueState,
  kind: AgentProgressKind,
  at = Date.now(),
): void {
  state.lastProgressAt = at;
  state.lastProgressKind = kind;
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
  // A thrown run is a failure too (no model configured, prepare/auth errors, …):
  // it gets the same durable record and assistant wake as an error-stopped run.
  reportRunFailure(state, err instanceof Error ? err.message : String(err));
}

/**
 * The failure of the run that just finished, or `null` when it finished cleanly
 * (or was aborted on purpose).
 */
function runFailureOf(state: QueueState): string | null {
  // An interrupt aborts the run: Pi then closes the attempt with an `error`
  // message and emits a cancelled retry. That is a decision, not a failure.
  if (state.abortRequested) return null;
  const stop = state.lastAssistantStop;
  if (stop?.stopReason !== "error") return null;
  const message = (stop.errorMessage ?? "").trim();
  return message.length > 0 ? message : "Unknown error";
}

/**
 * Make one failed run durable: an `error` notice in the chat plus (guarded by
 * `run-failure.ts`) one assistant wake. Never throws — the queue's bookkeeping
 * must not depend on it.
 */
function reportRunFailure(state: QueueState, errorMessage: string): void {
  if (state.disposed) return;
  recordRunFailure(
    {
      employeeId: state.employeeId,
      chatId: state.chatId,
      errorMessage,
      retryAttempts: state.retryAttempts,
    },
    (employeeId, chatId, text) => {
      void wakeAgent(employeeId, chatId, text, { mode: "queue" }).catch(
        (err: unknown) => {
          console.error(
            `[session-queue] failed to wake the assistant about a failed run in chat ${chatId}:`,
            err instanceof Error ? err.message : err,
          );
        },
      );
    },
  );
}
