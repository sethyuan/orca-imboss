import { ASSISTANT_ID } from "@shared/constants/employees";
import { readChatPrompt } from "@shared/constants/prompts";
import * as dbChats from "../db/chats";
import * as dbEmployees from "../db/employees";
import * as dbMessages from "../db/messages";

/**
 * "A run failed" made durable — the app-level side effect of a failed agent
 * run (see `session-queue.ts`: an error-stopped assistant message, or a thrown
 * `prompt()`).
 *
 * Why it exists: a failed run used to end silently — Pi's automatic retry
 * exhausts itself and `prompt()` resolves normally, so nothing was persisted,
 * nobody was notified and the task simply stopped mid-way. Two things happen
 * here instead:
 *
 * 1. **A chat record** is appended to the chat the run belonged to, as an
 *    `error` notice: `sender_employee_id = NULL` (so it is *not* forwarded to a
 *    linked IM conversation and does not bump unread — `integrations/manager.ts`
 *    only forwards employee messages; `db/messages.ts` only bumps unread for
 *    them) and `silent: true` (no renderer beep). The content is fixed English
 *    like the `interrupted` notice, because the model reads it back through
 *    `imb_read_chat`; the renderer shows a localized label instead.
 * 2. **The assistant is woken** (unless the failed run *was* the assistant) so
 *    it can decide whether to re-dispatch the work or report to the boss —
 *    `readChatPrompt` tells it which chat to read, and `wakeAgent` redirects an
 *    assistant wake from a task group to the root chat it orchestrates from.
 *
 * Loop safety (the reason for all the counters below — a wake that fails could
 * otherwise wake itself forever):
 *
 * - the failing employee is never re-woken, and the assistant is never woken
 *   for its own failure (that is the one edge that could self-perpetuate);
 * - at most one wake per chat per `WAKE_COOLDOWN_MS`;
 * - at most `MAX_WAKES_PER_CHAT` wakes per chat for the lifetime of the process;
 * - identical failures inside `DEDUPE_MS` produce a single record, so a queue
 *   of messages failing for the same reason (e.g. no model configured) cannot
 *   flood the transcript.
 *
 * Everything is best-effort: recording a failure must never break the queue, so
 * no path here throws.
 */

/** Raw facts about one failed run. */
export interface RunFailure {
  /** Employee whose session failed (0 = the assistant). */
  employeeId: number;
  /** Chat the failed run belonged to. */
  chatId: number;
  /** Raw technical error text; sanitized and capped before it is stored. */
  errorMessage: string;
  /** Automatic retries Pi performed before giving up (0 = none). */
  retryAttempts: number;
}

/**
 * Wakes one agent session with a prompt. Provided by the caller so this module
 * stays free of the session queue (which imports it — a direct import would be
 * a cycle) and stays testable.
 */
export type FailureWake = (
  employeeId: number,
  chatId: number,
  text: string,
) => void;

export interface RunFailureOutcome {
  /** True when an `error` notice was appended to the chat. */
  recorded: boolean;
  /** True when the assistant was woken about it. */
  woken: boolean;
}

/** Cap for the stored technical error text (the prefix is added on top). */
export const MAX_ERROR_CHARS = 2_000;
/** Identical failures inside this window produce one record. */
const DEDUPE_MS = 60_000;
/** Minimum gap between two failure wakes for the same chat. */
const WAKE_COOLDOWN_MS = 5 * 60_000;
/** Hard cap on failure wakes per chat, for the lifetime of the process. */
const MAX_WAKES_PER_CHAT = 3;

/** `dedupeKey` → time of the last record written for it. */
const recentRecords = new Map<string, number>();
/** chatId → time of the last failure wake. */
const lastWakeAt = new Map<number, number>();
/** chatId → failure wakes already sent in this process. */
const wakeCounts = new Map<number, number>();

/**
 * Record one failed run: append the `error` notice and (when allowed) wake the
 * assistant. Returns what actually happened; never throws.
 */
export function recordRunFailure(
  failure: RunFailure,
  wake: FailureWake,
): RunFailureOutcome {
  const outcome: RunFailureOutcome = { recorded: false, woken: false };
  try {
    const { employeeId, chatId } = failure;
    if (!Number.isSafeInteger(employeeId) || employeeId < 0) return outcome;
    if (!Number.isSafeInteger(chatId) || chatId <= 0) return outcome;

    const error = sanitizeError(failure.errorMessage);
    const name = employeeName(employeeId);
    const text = noticeText(employeeId, name, error, failure.retryAttempts);

    const key = `${chatId}/${employeeId}/${error}`;
    const now = Date.now();
    pruneDedupe(now);
    const previous = recentRecords.get(key);
    if (previous !== undefined && now - previous < DEDUPE_MS) {
      // Same failure, already reported a moment ago: keep the transcript (and
      // the assistant) out of it.
      return outcome;
    }

    try {
      dbMessages.appendMessage(chatId, null, text, {
        kind: "error",
        silent: true,
      });
      recentRecords.set(key, now);
      outcome.recorded = true;
    } catch (err) {
      // A deleted chat or a validation failure must not escape: the caller is
      // the queue's run loop.
      console.error(
        `[run-failure] failed to append the error notice for ${employeeId} in chat ${chatId}:`,
        err instanceof Error ? err.message : err,
      );
      return outcome;
    }

    try {
      const chatRow = dbChats.getChat(chatId);
      // An employee direct chat is the boss's own conversation with one
      // employee: waking the assistant there would materialize a session in a
      // chat it has no role in (and post a message the UI never renders). The
      // `error` notice stays — the session view shows the run error to the boss.
      if (chatRow === null || chatRow.directEmployeeId !== null) {
        return outcome;
      }
    } catch {
      // A lookup failure must not suppress the record: fall through and wake.
    }
    outcome.woken = wakeAssistant(failure, wake, now);

    console.error(
      `[run-failure] recorded a failed run of ${employeeId} in chat ${chatId} ` +
        `(retries: ${failure.retryAttempts}, assistant woken: ${outcome.woken}): ${error}`,
    );
    return outcome;
  } catch (err) {
    console.error(
      "[run-failure] unexpected failure while recording a failed run:",
      err instanceof Error ? err.message : err,
    );
    return outcome;
  }
}

/**
 * Wake the assistant about a failed run, honouring the loop guards above.
 * Returns whether a wake was actually delivered.
 */
function wakeAssistant(
  failure: RunFailure,
  wake: FailureWake,
  now: number,
): boolean {
  // 1. The assistant's own failure is the one case that could self-perpetuate:
  //    waking it would re-run the same session that just failed.
  if (failure.employeeId === ASSISTANT_ID) return false;
  // 2. Cooldown + hard cap per chat.
  const last = lastWakeAt.get(failure.chatId);
  if (last !== undefined && now - last < WAKE_COOLDOWN_MS) return false;
  const count = wakeCounts.get(failure.chatId) ?? 0;
  if (count >= MAX_WAKES_PER_CHAT) return false;
  try {
    wake(
      ASSISTANT_ID,
      failure.chatId,
      // `wakeAgent` replaces this with the chat prompt for a redirect target
      // (an assistant woken from a task group reads it from its root chat).
      readChatPrompt(failure.chatId),
    );
    lastWakeAt.set(failure.chatId, now);
    wakeCounts.set(failure.chatId, count + 1);
    return true;
  } catch (err) {
    console.error(
      `[run-failure] failed to wake the assistant about chat ${failure.chatId}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Employee display name for the notice, or `null` when it no longer exists. */
function employeeName(employeeId: number): string | null {
  try {
    const employee = dbEmployees.getEmployee(employeeId);
    const name = employee?.name.trim() ?? "";
    return name.length > 0 ? name : null;
  } catch {
    // The notice must still be written when the employee lookup fails.
    return null;
  }
}

/**
 * The stored notice. Fixed English for the same reason as
 * `INTERRUPTED_NOTICE_CONTENT`: the model and the IM bridges read it verbatim,
 * while the renderer swaps in a localized label.
 */
function noticeText(
  employeeId: number,
  name: string | null,
  error: string,
  retryAttempts: number,
): string {
  const who = name
    ? `employee ${employeeId} (${name})`
    : `employee ${employeeId}`;
  const retries =
    retryAttempts > 0
      ? ` after ${retryAttempts} automatic retr${retryAttempts === 1 ? "y" : "ies"}`
      : "";
  return `Agent run failed for ${who} in this chat${retries}: ${error}`;
}

/**
 * One-line, length-capped error text. Control characters (newlines included)
 * collapse to spaces: the notice is a single-line system entry, and provider
 * errors are often multi-line.
 */
function sanitizeError(raw: string): string {
  const collapsed =
    typeof raw === "string"
      ? raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
      : "";
  if (collapsed.length === 0) return "Unknown error";
  if (collapsed.length <= MAX_ERROR_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_ERROR_CHARS)}…`;
}

/** Drop dedupe entries that can no longer suppress anything. */
function pruneDedupe(now: number): void {
  for (const [key, at] of recentRecords) {
    if (now - at >= DEDUPE_MS) recentRecords.delete(key);
  }
}
