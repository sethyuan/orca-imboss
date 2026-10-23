import type { Message } from "@shared/types";

/** One ordinary row, with the message that sits above it in the transcript. */
export interface SingleThreadEntry {
  kind: "message";
  message: Message;
  previous: Message | undefined;
}

/**
 * Two or more progress cards for one task group, with no other message
 * between them. `previous` is the message above the run, if any.
 */
export interface ProgressRunEntry {
  kind: "progress-run";
  messages: Message[];
  previous: Message | undefined;
}

export type ThreadEntry = SingleThreadEntry | ProgressRunEntry;

/**
 * Task group a progress card belongs to. Cards stored before the link existed
 * have no group and never join a run.
 */
function progressGroupId(message: Message): number | null {
  if (message.kind !== "progress") return null;
  const id = message.groupChatId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    return null;
  }
  return id;
}

/**
 * Fold a contiguous run of progress cards that share a task group into one
 * entry. A single card, a card with no task group, or any other kind of
 * message stays on its own, and a different group starts a new run.
 */
export function groupProgressRuns(messages: readonly Message[]): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  let previous: Message | undefined;
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message === undefined) break;
    const groupId = progressGroupId(message);
    if (groupId === null) {
      entries.push({ kind: "message", message, previous });
      previous = message;
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < messages.length) {
      const next = messages[end];
      if (next === undefined || progressGroupId(next) !== groupId) break;
      end += 1;
    }
    const run = messages.slice(index, end);
    const first = run[0];
    if (first === undefined || run.length === 1) {
      if (first !== undefined) {
        entries.push({ kind: "message", message: first, previous });
        previous = first;
      }
    } else {
      entries.push({ kind: "progress-run", messages: run, previous });
      const last = run[run.length - 1];
      if (last !== undefined) previous = last;
    }
    index = end;
  }
  return entries;
}
