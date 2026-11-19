import type {
  AgentSessionAttachment,
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
 * Rows start as one of two kinds and a chat send can move from the first to the
 * second:
 * - **waiting** send: no handle yet, so it is matched against the projection by
 *   text and marked `unconfirmed` when a run ends after it was sent (a text that
 *   really waited in the app queue is guaranteed to run, so only a steer gets
 *   that report);
 * - **interjection** (`mode: "steer"`, `steerId` set): the main process tracks
 *   the text as a `SteerRecord` and streams its phase (`steer_state`), so the row
 *   never guesses — it mirrors `phase`, and it is the one the boss can withdraw.
 *
 * ## One send, one row
 *
 * A row is identified by whatever the main process can repeat back: `steerId`
 * for an interjection, and the sender's own `sendId` for a **chat send** (stored
 * *and* steered, so the view had already drawn its pending row before main could
 * answer). **Every** entry point upserts on that identity — the composer's own
 * send result, the `steer_state` event and the mount-time snapshot all address
 * the same record. This is not cosmetic: main pushes `steer_state` *before* a
 * send returns, so "event first, reply second" is a normal ordering, and
 * appending blindly used to render one send twice (two identical bubbles, two
 * withdrawal buttons).
 *
 * The same upsert is what makes a **chat** send withdrawable: its row starts as
 * a plain queued placeholder (no handle), and the first `steer_state` carrying
 * its `sendId` upgrades it in place into the interjection it always was.
 *
 * Kept free of React and localization so it can be unit tested directly.
 */
export interface PendingSend {
  /** Stable React key (local to the view, never the main-process identity). */
  id: number;
  /** What the boss typed; empty for a file-only send. */
  text: string;
  /**
   * Attachments the send carried, in the same display shape the transcript uses
   * (the composer already has them). Rendered as chips instead of text, and what
   * makes a file-only row match its projection (both sides key on `""`).
   */
  attachments?: AgentSessionAttachment[];
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
  /**
   * Correlation id the sender chose for this send, echoed by main in
   * `steer_state` (see `AgentSessionSteerState.sendId`).
   *
   * It is the row's identity *before* main has answered: a chat send is stored
   * first and steered second, so its placeholder exists while no `steerId` does
   * yet. When the `steer_state` for that `sendId` arrives, the placeholder is
   * upgraded to the interjection instead of being joined by a second row.
   */
  sendId?: string;
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
  /** What the boss typed; empty for a file-only send. */
  text: string;
  /** Attachments the send carried (see `PendingSend.attachments`). */
  attachments?: AgentSessionAttachment[];
  mode: AgentSessionDeliveryMode;
  /** Present for an interjection: the row identity from here on. */
  steerId?: string;
  /** The sending window's own correlation id (see `PendingSend.sendId`). */
  sendId?: string;
  /** `runEndSeq` at send time (queued rows use it to detect a lost send). */
  runEndSeq: number;
}

/**
 * Index of the row a send or a `steer_state` addresses, or `-1`.
 *
 * `steerId` wins when known; otherwise the sender's `sendId` is the only
 * identity both sides share (a chat send is already on screen when main reports
 * the steer it turned into).
 */
function rowIndexOf(
  rows: readonly PendingSend[],
  identity: { steerId?: string; sendId?: string },
): number {
  if (identity.steerId !== undefined) {
    const index = rows.findIndex((row) => row.steerId === identity.steerId);
    if (index !== -1) return index;
  }
  if (identity.sendId !== undefined) {
    return rows.findIndex((row) => row.sendId === identity.sendId);
  }
  return -1;
}

/**
 * Record (or refresh) the row of a send.
 *
 * The row **upserts on its identity** (`steerId`, else `sendId`): the main
 * process normally reported the interjection before this runs, and that row is
 * the same send — keeping it avoids a second bubble and a second 「撤回」.
 */
export function addSentRow(
  rows: readonly PendingSend[],
  input: SentRowInput,
): PendingSend[] {
  const attachmentField =
    input.attachments !== undefined && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {};
  const index = rowIndexOf(rows, input);
  if (index === -1) {
    return [
      ...rows,
      {
        ...input,
        runEndSeqAtSend: input.runEndSeq,
        id: input.id,
        ...(input.steerId !== undefined ? { phase: "pending" } : {}),
        ...attachmentField,
      },
    ];
  }
  const existing = rows[index];
  const next = [...rows];
  next[index] = {
    // Keep the row's own React identity and whatever phase it already has.
    ...existing,
    text: input.text,
    // A row that main already made an interjection stays one: the send result
    // only knows how it *asked*, and it arrived second.
    mode: existing.steerId !== undefined ? "steer" : input.mode,
    runEndSeqAtSend: input.runEndSeq,
    ...(input.steerId !== undefined ? { steerId: input.steerId } : {}),
    ...(existing.phase === undefined && input.steerId !== undefined
      ? { phase: "pending" as const }
      : {}),
    ...attachmentField,
  };
  return next;
}

/**
 * Apply one `steer_state` update.
 *
 * - `pending`: create the row if this view does not have it yet (another window
 *   sent it, or the view mounted late), otherwise keep it as is — and, when the
 *   row was this view's own **chat** placeholder (matched by `sendId`), upgrade
 *   it here: it is the same send, and main has just made it an interjection;
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
  const index = rowIndexOf(rows, {
    steerId: steer.id,
    sendId: steer.sendId,
  });
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
        ...(steer.sendId !== undefined ? { sendId: steer.sendId } : {}),
      },
    ];
  }
  const next = [...rows];
  if (steer.phase === "injected" || steer.phase === "revoked") {
    next.splice(index, 1);
    return next;
  }
  next[index] = {
    // The row becomes the interjection: main is the authority on its text (what
    // the boss typed, never the composed prompt) and on its handle.
    ...rows[index],
    steerId: steer.id,
    text: steer.text,
    mode: "steer",
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
 * Per-renderer-lifetime salt, so ids minted after a reload cannot collide with
 * the rows main still holds from before it (those are restored with their own
 * `sendId`).
 */
const SEND_ID_SALT = Math.random().toString(36).slice(2, 8);
let sendIdSeq = 0;

/**
 * Mint a correlation id for one send (`chat:send`'s `sendId`).
 *
 * Only this window ever sees these values (main echoes one back untouched), so
 * they carry no meaning beyond "this row and that `steer_state` are the same
 * send".
 */
export function nextSendId(): string {
  sendIdSeq += 1;
  return `s${SEND_ID_SALT}-${sendIdSeq}`;
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
