import { ASSISTANT_ID } from "@shared/constants/employees";
import {
  getRecoveryState,
  listUnansweredRootChats,
  recordRecoveryAttempt,
  type UnansweredRootChat,
} from "../db/recovery";
import * as dbEmployees from "../db/employees";
import { getReadCursor, setReadCursor } from "../db/read-cursors";
import { getModelRuntime, resolveModel } from "./model-runtime";

/**
 * Startup recovery: retry a human turn whose agent run never finished because
 * the app quit, crashed or was killed mid-run.
 *
 * ## What is recovered
 *
 * Only a **root chat's last human message** that is still unsettled
 * (`db/recovery.ts` `listUnansweredRootChats` decides that from `messages`).
 * The recovery does *not* replay any text: it wakes the assistant
 * (`ASSISTANT_ID`) so it re-reads that chat and decides what to do — exactly
 * how an ask answer or an `imb_interrupt` instruction wakes it. Employees are
 * never woken here; a failed agent run is reported through `run-failure.ts`
 * instead, which the assistant reacts to.
 *
 * ## Cron is out of scope by construction — not by a heuristic
 *
 * The boss's rule: a cron time point that was missed while the app was closed
 * must never be made up. This pass satisfies that structurally, not by guessing:
 *
 * - a cron tick calls `wakeAgent(job.employeeId, job.chatId, job.content)` →
 *   `deliver()` → the in-memory queue. It writes **no `messages` row**, and
 *   `cron_jobs` keeps only `schedule` / `content` / `last_run_at` /
 *   `next_run_at` — a missed time point leaves **no durable artifact at all**;
 * - this module is anchored on `messages` rows, so a cron wake cannot enter it;
 * - this module deliberately never touches cron: no `cron_jobs` read or write,
 *   no `initCron()` / `runNow()`, no `next_run_at` change, and no cron `content`
 *   is ever replayed. The only thing it sends is `readChatPrompt()`.
 *
 * ## Employee direct chats are out of scope too
 *
 * A direct chat (`chats.direct_employee_id`, see `Chat.directEmployeeId`) is not
 * an assistant conversation: recovering one would wake the assistant into a chat
 * it has no role in. The scan therefore skips them (`listUnansweredRootChats`),
 * so a turn that died there simply has no reply — the boss sees the missing
 * answer in the session view and can send again. (Recovering the *employee*
 * instead would need a per-chat wake target; deliberately not done.)
 *
 * ## Why the read cursor has to be rewound
 *
 * `imb_read_chat` persists the assistant's cursor *when it reads* — and the run
 * that died had almost certainly already read the boss's message. A bare wake
 * would then be a no-op (`messages: []`). So before waking, the assistant's
 * cursor for that chat is moved back to just before the anchor message, when it
 * had already passed it.
 *
 * ## Storm safety
 *
 * One delayed pass per process (no timer loop, no polling), at most
 * `MAX_CHATS_PER_BOOT` chats, at most `MAX_ATTEMPTS` per pending turn, a
 * `COOLDOWN_SECONDS` gap between attempts (so a boot that crashes mid-recovery
 * cannot loop), and attempts are persisted **before** the wake. The single
 * instance lock (`index.ts`) makes sure two processes never both recover.
 */

/** Only turns from this window are recovered. */
const RECOVERY_WINDOW_SECONDS = 24 * 60 * 60;
/** Attempts allowed per pending turn (the anchor message identifies the turn). */
const MAX_ATTEMPTS = 2;
/** Minimum gap between two attempts for the same chat. */
const COOLDOWN_SECONDS = 10 * 60;
/** Chats recovered per boot. */
const MAX_CHATS_PER_BOOT = 5;
/** Delay before the pass, so startup is never blocked by it. */
const START_DELAY_MS = 3_000;

/**
 * The two live-process facts this pass needs. Injected by `index.ts` so this
 * module stays free of the session queue (which owns both) and can be verified
 * without booting an agent.
 */
export interface RunRecoveryDeps {
  /** Whether the assistant is streaming in that chat right now (side-effect free). */
  isStreaming(chatId: number): boolean;
  /** Wake the assistant for one chat (resolves once the wake is queued). */
  wake(chatId: number): Promise<void>;
  /**
   * Whether the assistant has a model to run with. Defaults to the real model
   * store; only overridden by the startup-pass verification, which must not
   * boot a provider.
   */
  hasModel?(): Promise<boolean>;
}

/** What one pass did; used by the startup log and by the verifications. */
export interface RunRecoveryResult {
  /** Pending turns found. */
  scanned: number;
  /** Chats the assistant was woken for. */
  woken: number;
  /** Chats skipped (attempt budget, cooldown, live run, …). */
  skipped: number;
}

/** The scheduled pass, so `cancelRunRecovery()` can drop it on quit. */
let pendingTimer: NodeJS.Timeout | null = null;

/**
 * Schedule the one and only recovery pass of this process. Idempotent; never
 * blocks startup (the pass starts after `START_DELAY_MS`).
 */
export function initRunRecovery(deps: RunRecoveryDeps): void {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void runRecoveryPass(deps);
  }, START_DELAY_MS);
  // Never keep the process alive just for this.
  pendingTimer.unref?.();
}

/** Drop the scheduled pass (app quit). Safe to call when nothing is pending. */
export function cancelRunRecovery(): void {
  if (!pendingTimer) return;
  clearTimeout(pendingTimer);
  pendingTimer = null;
}

/**
 * Run one recovery pass. Never throws: every failure is logged and the pass
 * either continues with the next chat or ends.
 */
export async function runRecoveryPass(
  deps: RunRecoveryDeps,
): Promise<RunRecoveryResult> {
  const result: RunRecoveryResult = { scanned: 0, woken: 0, skipped: 0 };

  // Without a usable model every recovery run would fail immediately and leave
  // an `error` notice behind in each chat — skip the whole pass instead.
  const hasModel = deps.hasModel ?? hasUsableModel;
  if (!(await hasModel())) {
    console.log(
      "[run-recovery] skipped: no model is configured, so a recovered run could not succeed.",
    );
    return result;
  }

  let candidates: UnansweredRootChat[];
  try {
    candidates = listUnansweredRootChats(
      MAX_CHATS_PER_BOOT,
      nowSeconds() - RECOVERY_WINDOW_SECONDS,
    );
  } catch (err) {
    console.error(
      "[run-recovery] could not scan for unanswered turns:",
      err instanceof Error ? err.message : err,
    );
    return result;
  }
  result.scanned = candidates.length;

  // Serial on purpose: each recovery starts an agent run, and a handful of
  // chats is not worth a concurrent burst of model requests.
  for (const candidate of candidates) {
    let woken = false;
    try {
      woken = await recoverOne(candidate, deps);
    } catch (err) {
      console.error(
        `[run-recovery] failed to recover chat ${candidate.chatId}:`,
        err instanceof Error ? err.message : err,
      );
    }
    if (woken) result.woken += 1;
    else result.skipped += 1;
  }

  if (result.scanned > 0) {
    console.log(
      `[run-recovery] scanned ${result.scanned} unanswered turn(s): ` +
        `${result.woken} recovered, ${result.skipped} skipped.`,
    );
  }
  return result;
}

/**
 * Recover one pending turn: check its budget, count the attempt, rewind the
 * read cursor and wake the assistant. Returns whether the assistant was woken.
 */
async function recoverOne(
  candidate: UnansweredRootChat,
  deps: RunRecoveryDeps,
): Promise<boolean> {
  const { chatId, anchorMessageId } = candidate;
  const previous = getRecoveryState(chatId);
  // A different anchor means a newer human turn: it gets its own budget.
  const sameTurn = previous?.anchorMessageId === anchorMessageId;
  const attempts = sameTurn ? (previous?.attempts ?? 0) : 0;
  if (attempts >= MAX_ATTEMPTS) {
    console.log(
      `[run-recovery] skipped chat ${chatId}: ${anchorMessageId} was already recovered ` +
        `${attempts} time(s).`,
    );
    return false;
  }

  const now = nowSeconds();
  if (
    sameTurn &&
    previous !== null &&
    now - previous.lastAttemptAt < COOLDOWN_SECONDS
  ) {
    console.log(
      `[run-recovery] skipped chat ${chatId}: last attempt was ` +
        `${now - previous.lastAttemptAt}s ago (cooldown ${COOLDOWN_SECONDS}s).`,
    );
    return false;
  }

  // The boss may have just typed, and that run will read the chat by itself.
  if (deps.isStreaming(chatId)) {
    console.log(
      `[run-recovery] skipped chat ${chatId}: the assistant is already running there.`,
    );
    return false;
  }

  // Count the attempt *before* waking: a crash inside the recovery itself must
  // not buy another attempt at the next boot.
  recordRecoveryAttempt(chatId, anchorMessageId);
  rewindAssistantCursor(chatId, anchorMessageId);

  await deps.wake(chatId);
  console.log(
    `[run-recovery] recovered chat ${chatId} (pending turn: message ${anchorMessageId}, ` +
      `attempt ${attempts + 1}/${MAX_ATTEMPTS}).`,
  );
  return true;
}

/**
 * Move the assistant's read cursor back to just before the pending turn so the
 * wake actually shows it (`imb_read_chat` advances the cursor when it reads).
 * Only moved when it had already passed the anchor; a never-read message is
 * visible without any rollback.
 */
function rewindAssistantCursor(chatId: number, anchorMessageId: number): void {
  try {
    const cursor = getReadCursor(ASSISTANT_ID, chatId);
    if (cursor < anchorMessageId) return;
    setReadCursor(ASSISTANT_ID, chatId, anchorMessageId - 1);
    console.log(
      `[run-recovery] rewound the assistant read cursor for chat ${chatId}: ` +
        `${cursor} → ${anchorMessageId - 1}.`,
    );
  } catch (err) {
    // Without the rollback the wake is useless, so log loudly and still wake:
    // the assistant may have other unread traffic in that chat.
    console.error(
      `[run-recovery] failed to rewind the read cursor for chat ${chatId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Whether the assistant has a model to run with (mirrors `session.ts`). */
async function hasUsableModel(): Promise<boolean> {
  try {
    const runtime = await getModelRuntime();
    const assistant = dbEmployees.getEmployee(ASSISTANT_ID);
    return resolveModel(runtime, assistant?.modelId) !== undefined;
  } catch (err) {
    console.error(
      "[run-recovery] could not resolve a model:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** UNIX seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
