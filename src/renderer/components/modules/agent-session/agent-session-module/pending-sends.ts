import type {
  AgentSessionDeliveryMode,
  AgentSessionSteerPhase,
  AgentSessionSteerState,
  AgentSessionViewEntry,
} from "@shared/types";

/**
 * The agent-session view's "sent, not yet visible" rows, as pure functions.
 *
 * A message sent from the view's composer is not in the transcript yet: nothing
 * is written to the conversation (by design) and Pi persists a steer only at the
 * next turn boundary. The row is therefore the only feedback that the text
 * exists, and its lifecycle is what the boss acts on (「撤回」).
 *
 * Two kinds of rows live here:
 * - **interjection** (`mode: "steer"`, `steerId` set): the main process tracks
 *   the text as a `SteerRecord` and streams its phase (`steer_state`), so the row
 *   never guesses — it mirrors `phase`;
 * - **queued** send: no handle (v1 does not withdraw those), so it is matched
 *   against the projection by text and marked `unconfirmed` when a run ends
 *   after it was sent.
 *
 * ## One interjection, one row
 *
 * `steerId` is the identity of an interjection row, and **every** entry point
 * upserts on it: the composer's own send result, the `steer_state` event and the
 * mount-time snapshot all address the same record. This is not cosmetic — the
 * main process pushes `steer_state` *before* `agentSession:send` returns, so
 * "event first, reply second" is the normal ordering, and appending blindly on
 * the reply used to render one interjection twice (two identical bubbles, two
 * withdrawal buttons).
 *
 * Kept free of React and localization so it can be unit tested directly
 * (`scripts/tests/pending-sends.test.ts`).
 */
export interface PendingSend {
  /** Stable React key (local to the view, never the main-process identity). */
  id: number;
  text: string;
  /** How the main process routed it (copy only). */
  mode: AgentSessionDeliveryMode;
  /** `runEndSeq` when it was sent; a later run end without a match = lost. */
  runEndSeqAtSend: number;
  /** No longer expected to arrive: shown as unconfirmed, dismissable. */
  unconfirmed?: boolean;
  /**
   * Main-process handle of the interjection (`mode === "steer"` only) — the
   * **identity** of the row, and what a withdrawal addresses.
   */
  steerId?: string;
  /**
   * Main-process phase of an interjection row. Present iff `steerId` is set:
   * these rows never guess, they follow `steer_state`. `revoked`/`injected` rows
   * are removed instead of rendered, so a rendered interjection row can only be
   * `pending`, `lost` or `unknown`.
   */
  phase?: AgentSessionSteerPhase;
  /** Withdrawal in flight (disables the affordance). */
  busy?: boolean;
  /**
   * One-shot reason, replacing the affordance until the row removes itself.
   * The wording lives in the view (`pendingFeedbackLabel`) — this module only
   * carries the cause, so it stays localization-free.
   */
  feedback?: PendingFeedback;
}

/** Why a row reports an outcome instead of offering an action. */
export type PendingFeedback =
  /** The text is already in the transcript / the model has seen it. */
  | "delivered"
  /** Nothing left to withdraw (run ended, session disposed, queue cleared). */
  | "gone"
  /** A withdrawal attempt failed and the queue state is undetermined. */
  | "unknown"
  /** The run ended while the text was still queued: it may never arrive. */
  | "lost";

/** What the composer's send produced, as far as a row is concerned. */
export interface SentRowInput {
  /** Fresh local id, supplied by the view (React key). */
  id: number;
  text: string;
  mode: AgentSessionDeliveryMode;
  /** Present for an interjection: the row identity from here on. */
  steerId?: string;
  /** `runEndSeq` at send time (queued rows use it to detect a lost send). */
  runEndSeq: number;
}

/**
 * Record (or refresh) the row of a send.
 *
 * An interjection **upserts on `steerId`**: the main process normally emitted
 * `steer_state` (pending) before this runs, and that row is the same
 * interjection — keeping it avoids a second bubble and a second 「撤回」.
 */
export function addSentRow(
  rows: readonly PendingSend[],
  input: SentRowInput,
): PendingSend[] {
  if (input.steerId === undefined) {
    return [
      ...rows,
      { ...input, runEndSeqAtSend: input.runEndSeq, id: input.id },
    ];
  }
  const index = rows.findIndex((row) => row.steerId === input.steerId);
  if (index === -1) {
    return [
      ...rows,
      {
        id: input.id,
        text: input.text,
        mode: input.mode,
        runEndSeqAtSend: input.runEndSeq,
        steerId: input.steerId,
        phase: "pending",
      },
    ];
  }
  const next = [...rows];
  next[index] = {
    // Keep the row's own React identity and whatever phase it already has.
    ...rows[index],
    text: input.text,
    mode: input.mode,
    runEndSeqAtSend: input.runEndSeq,
  };
  return next;
}

/**
 * Apply one `steer_state` update.
 *
 * - `pending`: create the row if this view does not have it yet (another window
 *   sent it, or the view mounted late), otherwise keep it as is;
 * - `injected` / `revoked`: the row is done — the transcript holds the text, or
 *   it will never run;
 * - `lost` / `unknown`: not withdrawable and possibly never delivered, so the row
 *   stays for one report and removes itself.
 *
 * `newRowId` is only consumed when a row must be created.
 */
export function applySteerStateRow(
  rows: readonly PendingSend[],
  steer: AgentSessionSteerState,
  newRowId: number,
): PendingSend[] {
  const index = rows.findIndex((row) => row.steerId === steer.id);
  if (index === -1) {
    if (steer.phase !== "pending") return rows as PendingSend[];
    return [
      ...rows,
      {
        id: newRowId,
        text: steer.text,
        mode: "steer",
        // A row created from an event belongs to the run that is streaming now;
        // the queued-row heuristic never applies to it (its `phase` is set).
        runEndSeqAtSend: 0,
        steerId: steer.id,
        phase: steer.phase,
      },
    ];
  }
  const next = [...rows];
  if (steer.phase === "injected" || steer.phase === "revoked") {
    next.splice(index, 1);
    return next;
  }
  next[index] = {
    ...rows[index],
    phase: steer.phase,
    busy: false,
    ...(steer.phase === "pending"
      ? {}
      : { feedback: rows[index].feedback ?? steer.phase }),
  };
  return next;
}

/** Mark one row's withdrawal as in flight (disables its button). */
export function markRowBusy(
  rows: readonly PendingSend[],
  id: number,
): PendingSend[] {
  const index = rows.findIndex((row) => row.id === id);
  if (index === -1) return rows as PendingSend[];
  const next = [...rows];
  next[index] = { ...rows[index], busy: true };
  return next;
}

/**
 * Report the outcome of a withdrawal that did **not** happen.
 *
 * The row keeps its bubble and swaps the button for the reason; it then removes
 * itself (`FEEDBACK_MS`). The app never silently pretends a withdrawal worked,
 * and never leaves a dead 「撤回」 on a text the model already read.
 */
export function settleWithdrawFailure(
  rows: readonly PendingSend[],
  steerId: string,
  reason: PendingFeedback,
): PendingSend[] {
  const index = rows.findIndex((row) => row.steerId === steerId);
  if (index === -1) return rows as PendingSend[];
  const next = [...rows];
  next[index] = {
    ...rows[index],
    busy: false,
    phase:
      reason === "delivered"
        ? "injected"
        : reason === "unknown"
          ? "unknown"
          : "lost",
    feedback: reason,
  };
  return next;
}

/** Drop one row by its local id (dismissed, withdrawn, or its report expired). */
export function removeRow(
  rows: readonly PendingSend[],
  id: number,
): PendingSend[] {
  if (!rows.some((row) => row.id === id)) return rows as PendingSend[];
  return rows.filter((row) => row.id !== id);
}

/**
 * Text prefix used to match a pending row against a projected user entry.
 *
 * Not a truncation of anything the view displays: both sides are compared on a
 * bounded prefix so a very long prompt is neither copied in full nor compared
 * character by character. Derived from the same text on both sides, so it is
 * correct.
 */
export const PENDING_MATCH_LENGTH = 32_000;

/** Comparison key for matching a sent text against a projected user entry. */
function pendingKey(text: string): string {
  return text.trim().slice(0, PENDING_MATCH_LENGTH);
}

/**
 * Reconcile the "sent, not yet visible" rows against a freshly loaded
 * projection.
 *
 * Matching is by trimmed text and **count-based**: sending the same text twice
 * is legitimately two entries, so each pending copy consumes one projection
 * entry (and copies beyond the available count stay pending).
 *
 * Two kinds of rows behave differently on a miss:
 * - an **interjection** row (main-driven, `steerId` set) is only dropped here as
 *   a safety net (its `injected`/`lost` phases normally settle it first) — it is
 *   never marked `unconfirmed`, because the main process already knows whether
 *   Pi took it;
 * - a **queued** row is marked `unconfirmed` once a run has ended after it was
 *   sent; it is never auto-removed, so a genuinely lost message cannot silently
 *   look delivered.
 */
export function reconcilePending(
  pending: readonly PendingSend[],
  entries: readonly AgentSessionViewEntry[],
  runEndSeq: number,
): PendingSend[] {
  if (pending.length === 0) return pending as PendingSend[];
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== "user") continue;
    const key = pendingKey(entry.text);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let changed = false;
  const next: PendingSend[] = [];
  for (const item of pending) {
    const key = pendingKey(item.text);
    const seen = counts.get(key) ?? 0;
    if (seen > 0) {
      // This copy is in the transcript now: drop the placeholder.
      counts.set(key, seen - 1);
      changed = true;
      continue;
    }
    if (item.phase !== undefined) {
      next.push(item);
      continue;
    }
    if (
      item.mode === "steer" &&
      item.unconfirmed !== true &&
      runEndSeq > item.runEndSeqAtSend
    ) {
      changed = true;
      next.push({ ...item, unconfirmed: true });
      continue;
    }
    next.push(item);
  }
  return changed ? next : (pending as PendingSend[]);
}
