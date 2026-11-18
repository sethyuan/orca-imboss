import type { WorkRoom } from "../../../../shared/types/work_status";

/**
 * The "the room stays for a while after the work ended" rule, as one pure
 * function.
 *
 * The snapshot from main is honest: it only contains groups where someone is
 * working *right now*. The board, though, must not make a room vanish the instant
 * its last run settles — so the renderer keeps a room around for `lingerMs` after
 * it was last seen running. That is a presentation rule, not a change to the
 * "in progress" definition, which is why it lives here instead of in the snapshot.
 *
 * Behaviour that follows from it:
 * - a run that starts inside the window keeps the room (its own window then
 *   restarts when that run ends);
 * - a lingering room is shown with every member **not** running (nobody works in
 *   it any more — the bubbles and rest animations must not claim otherwise);
 * - once the window is over the room is dropped, which is also what resets the
 *   bubble baseline: a group that comes back later is a fresh first presentation.
 */

export interface LingeringRoom {
  room: WorkRoom;
  /** When the room's work ended: the moment it was first seen *not* running. */
  lastRunningAt: number;
  /** Whether the previous merge still saw someone working in it. */
  running: boolean;
}

export interface LingerMerge {
  /** What the board shows: running rooms first, then lingering ones. */
  rooms: WorkRoom[];
  /** State to carry into the next merge. */
  lingering: Map<number, LingeringRoom>;
  /**
   * How long until the next room expires (`null` when nothing is lingering), so
   * the caller can schedule exactly one timer instead of polling.
   */
  nextExpiryInMs: number | null;
}

/** A lingering room with nobody working in it any more. */
function staleCopy(room: WorkRoom): WorkRoom {
  return {
    ...room,
    members: room.members.map((member) =>
      member.running ? { ...member, running: false } : member,
    ),
  };
}

export function mergeRoomsWithLinger(
  previous: ReadonlyMap<number, LingeringRoom>,
  incoming: readonly WorkRoom[],
  now: number,
  lingerMs: number,
  /**
   * When the snapshot used here was actually read. Normally `now`; after the module
   * was hidden it stays at the last read *before* hiding, so the time spent hidden
   * counts against the window — a room whose window already elapsed while the user
   * was elsewhere is dropped instead of getting a fresh 30 s.
   */
  snapshotAt: number = now,
): LingerMerge {
  const next = new Map<number, LingeringRoom>();
  const running = new Map<number, WorkRoom>();

  for (const room of incoming) {
    running.set(room.chatId, room);
    next.set(room.chatId, { room, lastRunningAt: snapshotAt, running: true });
  }

  const rooms: WorkRoom[] = [...incoming];
  let nextExpiryInMs: number | null = null;

  for (const [chatId, entry] of previous) {
    if (running.has(chatId)) continue;
    // Not in the snapshot any more: nobody works here. The window is measured from
    // the moment the work *ended* — i.e. the first merge that no longer saw the
    // room running — so a run that started inside the window gets its own full
    // window after it settles.
    const ended = entry.running
      ? { room: entry.room, lastRunningAt: snapshotAt, running: false }
      : entry;
    const age = now - ended.lastRunningAt;
    if (age >= lingerMs) continue;
    rooms.push(staleCopy(ended.room));
    next.set(chatId, ended);
    const remaining = lingerMs - age;
    nextExpiryInMs =
      nextExpiryInMs === null ? remaining : Math.min(nextExpiryInMs, remaining);
  }

  rooms.sort((a, b) => b.lastActiveAt - a.lastActiveAt || b.chatId - a.chatId);
  return { rooms, lingering: next, nextExpiryInMs };
}
