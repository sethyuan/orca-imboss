import { getDB } from "./index";

/**
 * Durable bookkeeping for **startup recovery** — the pass that retries a human
 * turn whose agent run never finished because the app quit, crashed or was
 * killed mid-run.
 *
 * Two responsibilities, both deliberately narrow:
 *
 * 1. **Find** the pending turns. A turn is pending when a root chat's *last*
 *    human message (`sender_employee_id IS NULL`, kind `text` / `answer`) is
 *    followed by nothing that settles it — no employee reply and no terminal
 *    marker (`error` notice, `interrupted` notice). The pending turn is derived
 *    from `messages` on every scan, never stored: that keeps this table from
 *    drifting out of sync with the transcript.
 *
 * 2. **Bound** the retries. `run_recovery` holds one row per chat with the
 *    anchor message it last attempted, how many times, and when. `attempts`
 *    resets whenever the anchor changes (a newer human turn = a fresh episode),
 *    which is what makes a restart storm impossible: a boot that crashes while
 *    recovering cannot retry the same turn more than `attempts` allows, and the
 *    caller additionally skips anything attempted within a cooldown window.
 *
 * Only the **assistant** (`ASSISTANT_ID`) is recovered: a root chat's replayer
 * is the assistant, and cron wake-ups (which write no message row at all) are
 * therefore out of scope by construction — see `agent/run-recovery.ts`.
 */

/** One root chat whose last human turn has not been settled. */
export interface UnansweredRootChat {
  chatId: number;
  /** Row id of that last human message; the identity of this pending turn. */
  anchorMessageId: number;
  /** UNIX seconds when that message was written. */
  createdAt: number;
}

/** What `run_recovery` remembers about one chat. */
export interface RecoveryState {
  anchorMessageId: number;
  attempts: number;
  /** UNIX seconds of the last recovery attempt. */
  lastAttemptAt: number;
}

interface UnansweredRow {
  chatId: number;
  anchorId: number;
  createdAt: number;
}

interface RecoveryRow {
  anchor_message_id: number;
  attempts: number;
  last_attempt_at: number;
}

/**
 * The `WHERE` body of the "this later row settles the pending turn" probe, used
 * as `NOT EXISTS (SELECT 1 FROM messages r WHERE …)`. Kept in one place so the
 * scan cannot drift from the documented whitelist above.
 */
const SETTLED_PREDICATE =
  "r.chat_id = lh.chatId AND r.id > lh.anchorId " +
  "AND ( " +
  // The employee answered or reported (or answered by asking / by opening the
  // conversation it was asked to create).
  "  ( r.sender_employee_id IS NOT NULL AND r.kind IN ('text', 'report', 'ask', 'chat') ) " +
  // A picture that finished (or failed) generation is an answer; a placeholder
  // still marked `generating` is not — that is the crashed turn.
  "  OR ( r.kind = 'image' AND ( r.image_status IS NULL OR r.image_status <> 'generating' ) ) " +
  // Terminal markers the app writes on purpose.
  "  OR r.kind IN ('error', 'interrupted') " +
  ")";

/**
 * Root chats whose **last** human message is still unanswered, newest first.
 *
 * "Last human message" is the newest row with `sender_employee_id IS NULL` and
 * kind `text` / `answer` (composer sends, IM inbound messages and ask answers).
 * It counts as settled only by an explicit **whitelist** of later rows —
 * deliberately not "any employee message" (see `SETTLED_PREDICATE` below):
 *
 * - `text`, `report` — the employee answered.
 * - `ask` — the employee answered by asking the boss a question; the boss's
 *   `answer` is itself a new human turn (and wakes the employee again), so
 *   re-running the turn on boot would just duplicate the question.
 * - `chat` — the "I opened this conversation" card is the deliverable of a
 *   request like "organise this into a task"; treating it as unanswered would
 *   re-create the task group.
 * - `image` **unless** `image_status = 'generating'` — a finished/failed picture
 *   is an answer, a placeholder that never resolved is exactly the crashed turn.
 * - `error` / `interrupted` — terminal markers the app writes on purpose (the
 *   run failed and was reported; the boss halted it).
 *
 * Everything else does **not** settle a turn: `ack` means "accepted, not
 * finished", and `progress` cards / `image(generating)` placeholders are
 * *process artifacts*, not replies — an assistant that published a progress
 * card and then lost its process must still be recovered.
 *
 * `sinceSeconds` bounds the scan to recent turns; `limit` caps one boot.
 */
export function listUnansweredRootChats(
  limit: number,
  sinceSeconds: number,
): UnansweredRootChat[] {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  if (!Number.isFinite(sinceSeconds)) return [];
  // Two stages on purpose (cheap + bounded): one pass finds each root chat's
  // last human message (no per-row subqueries), then at most one indexed
  // "is it settled?" probe per chat. The previous single query re-evaluated two
  // correlated subqueries for every message row (~2 s on a 200k-message DB).
  const rows = getDB()
    .prepare(
      "WITH last_human AS ( " +
        "  SELECT chat_id AS chatId, MAX(id) AS anchorId FROM messages " +
        "  WHERE sender_employee_id IS NULL AND kind IN ('text', 'answer') " +
        "  GROUP BY chat_id " +
        ") " +
        "SELECT lh.chatId AS chatId, lh.anchorId AS anchorId, m.created_at AS createdAt " +
        "FROM last_human lh " +
        "JOIN chats c ON c.id = lh.chatId " +
        "JOIN messages m ON m.id = lh.anchorId " +
        "WHERE c.from_chat_id IS NULL " +
        // An employee direct chat is not an assistant conversation: waking the
        // assistant there would build a session in a chat it has no role in (see
        // `agent/run-recovery.ts`).
        "  AND c.direct_employee_id IS NULL " +
        "  AND m.created_at >= ? " +
        `  AND NOT EXISTS ( SELECT 1 FROM messages r WHERE ${SETTLED_PREDICATE} ) ` +
        "ORDER BY lh.anchorId DESC LIMIT ?",
    )
    .all(Math.trunc(sinceSeconds), safeLimit) as UnansweredRow[];
  return rows.map((row) => ({
    chatId: row.chatId,
    anchorMessageId: row.anchorId,
    createdAt: row.createdAt,
  }));
}

/** Recovery bookkeeping for one chat, or `null` when it was never attempted. */
export function getRecoveryState(chatId: number): RecoveryState | null {
  const row = getDB()
    .prepare("SELECT * FROM run_recovery WHERE chat_id = ?")
    .get(chatId) as RecoveryRow | undefined;
  if (!row) return null;
  return {
    anchorMessageId: row.anchor_message_id,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
  };
}

/**
 * Count one recovery attempt for `anchorMessageId` and start its cooldown.
 *
 * Called **before** the wake so a crash in the middle of a recovery can never
 * turn into an unbounded loop. The increment is conditional in SQL: a different
 * anchor means a new pending turn, so its attempt budget starts over.
 */
export function recordRecoveryAttempt(
  chatId: number,
  anchorMessageId: number,
): void {
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    throw new Error("Chat id must be a positive integer.");
  }
  if (!Number.isSafeInteger(anchorMessageId) || anchorMessageId <= 0) {
    throw new Error("Anchor message id must be a positive integer.");
  }
  getDB()
    .prepare(
      "INSERT INTO run_recovery (chat_id, anchor_message_id, attempts, last_attempt_at) " +
        "VALUES (?, ?, 1, ?) " +
        "ON CONFLICT(chat_id) DO UPDATE SET " +
        "  attempts = CASE " +
        "    WHEN run_recovery.anchor_message_id = excluded.anchor_message_id " +
        "    THEN run_recovery.attempts + 1 ELSE 1 END, " +
        "  anchor_message_id = excluded.anchor_message_id, " +
        "  last_attempt_at = excluded.last_attempt_at",
    )
    .run(chatId, anchorMessageId, Math.floor(Date.now() / 1000));
}
