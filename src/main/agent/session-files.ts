import { mkdir, readdir, rmdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { getAgentSessionsDir } from "../data-dir";
import * as dbChats from "../db/chats";
import * as dbSessions from "../db/sessions";
import { loadPiSdk } from "./pi-sdk";
import { resolveWorkDir } from "./workdir";

/**
 * Persistent per-`(employee, chat)` Pi session files.
 *
 * A session file is materialized deterministically at
 * `<sessionsDir>/chats/<chatId>/<employeeId>.jsonl` and recorded in the
 * `sessions` table so `AgentSession` resumes it instead of starting in-memory.
 * Shared by the built-in team tools (group chats) and the session queue
 * (every run, including the assistant's root chat).
 */

/** Directory holding the per-chat session folders. */
function chatSessionsDir(): string {
  return join(getAgentSessionsDir(), "chats");
}

/** Path of a persistent per-(employee, chat) Pi session file. */
export function sessionPathFor(chatId: number, employeeId: number): string {
  return join(chatSessionsDir(), String(chatId), `${employeeId}.jsonl`);
}

/**
 * Materialize an empty Pi session file at `path` so it can be resumed later.
 *
 * `SessionManager.open` on a zero-byte file immediately writes a valid session
 * header, which is exactly the deterministic file we want on disk from the
 * start. Best-effort: a materialization failure is logged and never thrown, so
 * a file problem can never roll back a committed DB transaction.
 */
export async function materializeSessionFile(path: string): Promise<void> {
  const pi = await loadPiSdk();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path, "", { flag: "wx" });
  } catch {
    // File already exists (valid or empty) — opening below handles it.
  }
  try {
    // Empty file => open writes a valid header; existing session => loads.
    pi.SessionManager.open(path, dir, resolveWorkDir());
  } catch (err) {
    console.error(
      `[session-files] Failed to materialize session ${path}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Ensure a session row (and its on-disk file) exists for (employee, chat).
 *
 * Idempotent: returns immediately when a row is already recorded. The row is
 * written even when the file materialization failed — a later resume re-opens
 * (and re-creates the header) from the empty file.
 */
export async function ensureSessionFile(
  employeeId: number,
  chatId: number,
): Promise<void> {
  if (dbSessions.getSession(employeeId, chatId)) return;
  // Guard: never materialize a session (and its directory) for a chat that no
  // longer exists. A racing cron tick after chat deletion would otherwise
  // re-create the orphan session files that `chats:delete` just removed.
  if (!dbChats.getChat(chatId)) {
    throw new Error("Chat does not exist.");
  }
  const path = sessionPathFor(chatId, employeeId);
  try {
    await materializeSessionFile(path);
  } catch (err) {
    console.error(
      `[session-files] Failed to materialize session for ${employeeId} in chat ${chatId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  dbSessions.setSession(employeeId, chatId, path);
}

/**
 * Drop a chat's session folder once nothing is left in it.
 *
 * Called by the delete paths (`chats:delete`, `employees:delete`) so an empty
 * folder never accumulates in the first place; `pruneEmptyChatSessionDirs` is
 * the startup fallback for whatever earlier versions or a failed
 * materialization left behind.
 */
export async function removeChatSessionDir(chatId: number): Promise<void> {
  if (!Number.isSafeInteger(chatId)) return;
  try {
    // Non-recursive on purpose: a session materialized meanwhile (or another
    // employee's file) makes this fail instead of being deleted along with it.
    await rmdir(join(chatSessionsDir(), String(chatId)));
  } catch {
    // Still in use, already gone — nothing to do.
  }
}

/**
 * Delete every empty per-chat session folder, returning how many were removed.
 *
 * Only the direct children of `chats/` whose name is a chat id are considered:
 * never recursive (the layout has no nesting), never following a symlink, and
 * never a folder that gained a file between the listing and the `rmdir`.
 * Underlying assumption: an empty folder carries nothing — the `.jsonl` files
 * are the only payload, so removing one costs no session state. Never throws.
 */
export async function pruneEmptyChatSessionDirs(): Promise<number> {
  const chatsDir = chatSessionsDir();
  const entries = await readdir(chatsDir, { withFileTypes: true }).catch(
    () => null,
  );
  if (entries === null) return 0;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{1,19}$/.test(entry.name)) continue;
    try {
      await rmdir(join(chatsDir, entry.name));
      removed += 1;
    } catch {
      // ENOTEMPTY (a session appeared meanwhile) or ENOENT: leave it alone.
    }
  }
  return removed;
}

/**
 * Startup entry point: run the prune and log the outcome.
 *
 * Deliberately awaited by nothing in the startup sequence (callers `void` it) —
 * it is plain async filesystem work over a handful of folders, and a cleanup
 * problem must never affect a launch.
 */
export async function pruneEmptyChatSessionDirsOnStartup(): Promise<void> {
  try {
    const removed = await pruneEmptyChatSessionDirs();
    if (removed > 0) {
      console.log(
        `[session-files] pruned ${removed} empty chat session dir(s)`,
      );
    }
  } catch (err) {
    console.warn(
      "[session-files] pruning empty chat session dirs failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
