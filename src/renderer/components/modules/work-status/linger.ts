import { MAX_LINGERING_ROOMS } from "../../../../shared/constants/work-status";
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
 *   bubble baseline: a group that comes back later is a fresh first presentation;
 * - at most `MAX_LINGERING_ROOMS` rooms linger at once (the window is half an hour),
 *   and the ones that ended longest ago are the ones dropped.
 *
 * This function decides *which* rooms are on the board, never their order: that is
 * `room-order.ts`, so a merge cannot move a room.
 */

export interface LingeringRoom {
  room: WorkRoom;
  /** When the room's work ended: the moment it was first seen *not* running. */
  lastRunningAt: number;
  /** Whether the previous merge still saw someone working in it. */
  running: boolean;
}

export interface LingerMerge {
  /**
   * What the board holds: running rooms first, then lingering ones. Order is not
   * the board's order — `room-order.ts` decides that.
   */
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
   * was elsewhere is dropped instead of getting a fresh one.
   */
  snapshotAt: number = now,
): LingerMerge {
  const next = new Map<number, LingeringRoom>();
  const running = new Map<number, WorkRoom>();

  for (const room of incoming) {
    running.set(room.chatId, room);
    next.set(room.chatId, { room, lastRunningAt: snapshotAt, running: true });
  }

  const stale: LingeringRoom[] = [];
  for (const [chatId, entry] of previous) {
    if (running.has(chatId)) continue;
    // Not in the snapshot any more: nobody works here. The window is measured from
    // the moment the work *ended* — i.e. the first merge that no longer saw the
    // room running — so a run that started inside the window gets its own full
    // window after it settles.
    const ended = entry.running
      ? { room: entry.room, lastRunningAt: snapshotAt, running: false }
      : entry;
    if (now - ended.lastRunningAt >= lingerMs) continue;
    stale.push(ended);
  }
  // The window is long enough for finished groups to pile up, so the lingering set is
  // capped: the ones idle longest go first (`chatId` only to make ties stable).
  stale.sort(
    (a, b) =>
      b.lastRunningAt - a.lastRunningAt || a.room.chatId - b.room.chatId,
  );
  const kept = stale.slice(0, MAX_LINGERING_ROOMS);

  const rooms: WorkRoom[] = [...incoming];
  let nextExpiryInMs: number | null = null;
  for (const entry of kept) {
    rooms.push(staleCopy(entry.room));
    next.set(entry.room.chatId, entry);
    const remaining = lingerMs - (now - entry.lastRunningAt);
    nextExpiryInMs =
      nextExpiryInMs === null ? remaining : Math.min(nextExpiryInMs, remaining);
  }

  return { rooms, lingering: next, nextExpiryInMs };
}
