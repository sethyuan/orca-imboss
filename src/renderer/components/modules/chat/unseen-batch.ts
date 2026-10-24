import type { Message } from "@shared/types";
import type { ProgressRun } from "./progress-runs";

/**
 * A batch of messages that arrived while the boss was reading history — what
 * the floating "new messages" pill stands for (see `./new-messages-jump`).
 *
 * The unit is a **rendered row**, not a stored message: message ids are globally
 * monotonic (`db/messages` appends one row at a time), so "newer than the id the
 * boss last saw at the tail" is a simple comparison, and a progress run — which
 * renders once, at its anchor, no matter how many snapshots it holds — is *one*
 * target. Counting snapshots would tell the boss "12 new messages" for a single
 * card that is already on screen.
 */
export interface UnseenBatch {
  /** Message id the jump lands on, and the id the landing row carries. */
  targetId: number;
  /**
   * Whether the target is a progress run's row (anchored by
   * `data-progress-run`) rather than a single message row. A run renders one
   * row for all of its snapshots, so the row has to be addressed by the run's
   * anchor rather than by whichever card is currently shown.
   */
  isRun: boolean;
  /** Jump targets in the batch (a run counts once — it is a single row). */
  count: number;
}

/**
 * Build the marker for everything in `rows` that is newer than `seenId`.
 *
 * Returns `null` when nothing is unseen (so the caller keeps its current, empty
 * state) and returns `previous` **unchanged** when the batch is identical to it,
 * which lets the caller skip a state update (the thread re-renders the whole
 * transcript, so an unnecessary `setState` is worth avoiding).
 *
 * `previous` is the batch already on screen, if any: its starting target is kept
 * even though the batch has grown, because the pill promises a *place* to start
 * reading — sliding that place down as messages keep arriving would move the
 * target under the boss's finger.
 *
 * Rows written by the app itself (`ack`, the transient "thinking" receipt) are
 * skipped: they are chrome, not something to read, and the receipt is hidden by
 * CSS the moment a real message follows it.
 *
 * Pure: the caller supplies the rendered rows and the run index it already
 * computed for the thread.
 */
export function buildUnseenBatch(
  rows: readonly Message[],
  seenId: number,
  runByMessageId: ReadonlyMap<number, ProgressRun>,
  previous: UnseenBatch | null,
): UnseenBatch | null {
  // Defensive: a non-finite baseline would make every comparison false and
  // silently hide an entire batch.
  if (!Number.isFinite(seenId)) return null;
  const targets: { id: number; isRun: boolean }[] = [];
  const targetIds = new Set<number>();
  for (const message of rows) {
    if (!Number.isSafeInteger(message.id) || message.id <= seenId) continue;
    if (message.kind === "ack") continue;
    const run = runByMessageId.get(message.id);
    // A run's snapshots all land on the run's single row.
    const id = run === undefined ? message.id : run.anchorId;
    if (targetIds.has(id)) continue;
    targetIds.add(id);
    targets.push({ id, isRun: run !== undefined });
  }
  if (targets.length === 0) return null;
  // Keep the place already promised, as long as it is still part of the batch.
  const start =
    previous !== null && targetIds.has(previous.targetId)
      ? { id: previous.targetId, isRun: previous.isRun }
      : targets[0];
  const count = targets.length;
  if (
    previous !== null &&
    previous.targetId === start.id &&
    previous.isRun === start.isRun &&
    previous.count === count
  ) {
    return previous;
  }
  return { targetId: start.id, isRun: start.isRun, count };
}
