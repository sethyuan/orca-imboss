import type {
  AgentSessionSteerPhase,
  AgentSessionSteerState,
} from "@shared/types";

/**
 * Bookkeeping for one interjection: a text this app handed to a **live** Pi run
 * as a native steering message.
 *
 * ## Why the app keeps its own records
 *
 * Pi's steering queue is a plain `string[]` of texts (no ids, no timestamps) and
 * its only mutation is `clearQueue()`, which empties *everything*. To let the
 * boss withdraw one specific interjection (and only that one) the app has to
 * remember which texts it handed over, in which order, and — crucially — the
 * **exact text that ended up in the queue**: Pi expands `/skill:` commands and
 * prompt templates before queueing, so the queued text is not necessarily what
 * the boss typed. `text` is what the view shows, `effectiveText` is what the
 * queue contains and therefore the only safe withdrawal key.
 *
 * ## Phases (see `AgentSessionSteerPhase`)
 *
 * `pending` is the only withdrawable one. The transition into `injected` is
 * observed from Pi itself: when a user message starts, Pi removes the first
 * queue entry with that exact text — `claimInjected()` mirrors that exact rule
 * so the app's view of "what is still pending" matches Pi's.
 *
 * This module is pure (no Electron, no I/O) so it can be unit tested directly.
 */
export interface SteerRecord {
  /** Opaque handle handed to the renderer (`agentSession:send` → `steerId`). */
  id: string;
  /** What the boss typed. Never mutated into the expanded form. */
  text: string;
  /**
   * The text Pi actually queued (after skill / prompt-template expansion), read
   * back from the queue right after the hand-over. Falls back to `text` when the
   * queue could not be observed.
   */
  effectiveText: string;
  phase: AgentSessionSteerPhase;
}

/**
 * Pi's two pending queues, as returned by its only mutation API
 * (`clearQueue()`).
 */
export interface PendingQueues {
  steering: readonly string[];
  followUp: readonly string[];
}

/** What to hand back to Pi after a withdrawal. */
export interface SteerRevokePlan {
  /** `true` when one steering entry was dropped. */
  removed: boolean;
  /** Steering texts to re-queue, in their original order. */
  steering: string[];
  /** Follow-up texts to re-queue (never a withdrawal target, always kept). */
  followUp: string[];
}

/**
 * Compute what Pi's queues must look like after withdrawing one text.
 *
 * Pi can only clear a queue wholesale, so a withdrawal is "clear, then hand back
 * everything except the target". This function owns the non-trivial half — which
 * entry goes and in what order the rest is restored — so the risky part is pure
 * and testable; the caller only performs the SDK calls.
 *
 * A target that is not there changes nothing (`removed: false`, both lists
 * returned untouched): a withdrawal must never drop a message it did not
 * recognise.
 */
export function planQueueRevoke(
  queues: PendingQueues,
  target: string,
  occurrence: number,
): SteerRevokePlan {
  const index = planSteerRevoke(queues.steering, target, occurrence);
  if (index === null) {
    return {
      removed: false,
      steering: [...queues.steering],
      followUp: [...queues.followUp],
    };
  }
  return {
    removed: true,
    steering: [
      ...queues.steering.slice(0, index),
      ...queues.steering.slice(index + 1),
    ],
    followUp: [...queues.followUp],
  };
}

/** Renderer-facing projection of one record. */
export function steerStateOf(record: SteerRecord): AgentSessionSteerState {
  return { id: record.id, text: record.text, phase: record.phase };
}

/**
 * Index of the `occurrence`-th (0-based) entry equal to `target`, or `null`.
 *
 * Text identity is **exact** (no trimming, no case folding): that is how Pi
 * itself decides which queue entry a starting user message consumes
 * (`indexOf(messageText)`), and being stricter here can only turn a withdrawal
 * into a no-op — never remove somebody else's message (an employee @-mention
 * wake, an IM bridge message) that happens to look similar.
 */
export function planSteerRevoke(
  texts: readonly string[],
  target: string,
  occurrence: number,
): number | null {
  if (!Number.isSafeInteger(occurrence) || occurrence < 0) return null;
  let seen = 0;
  for (let index = 0; index < texts.length; index += 1) {
    if (texts[index] !== target) continue;
    if (seen === occurrence) return index;
    seen += 1;
  }
  return null;
}

/**
 * Texts that are still waiting in Pi's queue, in hand-over order.
 *
 * This is the app's side of the interrupt ledger (see `steer-ledger.ts`): a
 * withdrawn record is *not* pending, so an interrupt can never re-queue a text
 * the boss already took back.
 */
export function pendingSteerTexts(records: readonly SteerRecord[]): string[] {
  return records
    .filter((record) => record.phase === "pending")
    .map((record) => record.effectiveText);
}

/**
 * How many **still pending** records of the same text come before `record`.
 *
 * Pi's queue only holds texts, so a duplicate interjection can only be addressed
 * by its ordinal among the equal texts. Withdrawn/injected records are skipped —
 * they no longer occupy a queue slot.
 */
export function pendingOccurrenceOf(
  records: readonly SteerRecord[],
  record: SteerRecord,
): number {
  let occurrence = 0;
  for (const candidate of records) {
    if (candidate === record) return occurrence;
    if (
      candidate.phase === "pending" &&
      candidate.effectiveText === record.effectiveText
    ) {
      occurrence += 1;
    }
  }
  return occurrence;
}

/**
 * Mark the record Pi just injected and return it (or `undefined`).
 *
 * Pi removes the first queue entry whose text equals the starting user
 * message's text, so the same rule applies here: exact `effectiveText` first,
 * then the raw text as a fallback (an interjection whose queued form could not
 * be observed). Only `pending` records are candidates — an already injected or
 * withdrawn one is history.
 */
export function claimInjected(
  records: readonly SteerRecord[],
  text: string,
): SteerRecord | undefined {
  const match = (predicate: (record: SteerRecord) => boolean) =>
    records.find((record) => record.phase === "pending" && predicate(record));
  const injected =
    match((record) => record.effectiveText === text) ??
    match((record) => record.text === text);
  if (injected) injected.phase = "injected";
  return injected;
}

/**
 * Give up on every still-pending record (the run ended, the session was
 * interrupted, the queue was cleared): they may never be delivered, and they are
 * certainly not withdrawable anymore.
 *
 * Returns the records it changed so the caller can notify the bound windows.
 */
export function losePendingSteers(
  records: readonly SteerRecord[],
  phase: "lost" | "unknown" = "lost",
): SteerRecord[] {
  const changed: SteerRecord[] = [];
  for (const record of records) {
    if (record.phase !== "pending") continue;
    record.phase = phase;
    changed.push(record);
  }
  return changed;
}
