import type { WorkRoom } from "../../../../shared/types/work_status";

/**
 * The board's room order: the order the rooms **first appeared** on it.
 *
 * Not the creation order of the task groups and not their activity: both move a room
 * the boss is already looking at (a group that was created earlier but only starts
 * working now would jump to the front, and every message would re-sort the grid, see
 * `stage.ts`'s `layoutGrid`, which turns the array index into a position).
 *
 * So a room takes the next free number the first time it is shown and keeps it. New
 * rooms land at the end, an existing room never moves, and activity changes nothing.
 * A room that left the board and comes back counts as new (it is a fresh first
 * presentation, same rule as the bubble baseline in `stage.ts`) — that is why the
 * kept numbers are rebuilt from the rooms present on every call: forgetting is the
 * default and needs no expiry.
 *
 * Pure and state-in/state-out so the rule can be asserted without a renderer; the
 * caller owns the state across snapshots (`use-work-rooms.ts`).
 */

/** A room's fixed place: `seq.get(chatId)` is the number it was first shown with. */
export interface RoomOrderState {
  seq: Map<number, number>;
  /** The next number to hand out. */
  next: number;
}

export interface RoomOrderResult {
  /** State to pass to the next call (carries the places of the rooms returned). */
  order: RoomOrderState;
  /** The same rooms, first appearance first. */
  rooms: WorkRoom[];
}

export function orderByFirstSeen(
  /** The previous call's `order`; `undefined` for the first snapshot. */
  previous: RoomOrderState | undefined,
  rooms: readonly WorkRoom[],
): RoomOrderResult {
  const seq = new Map<number, number>();
  let next = previous?.next ?? 0;
  const placed = rooms.map((room) => {
    const known = previous?.seq.get(room.chatId);
    // Unknown rooms take their numbers in the order they arrived: the caller hands in
    // the running rooms first (creation order, straight from the snapshot), so a batch
    // of newcomers still starts out old-to-new.
    const place = known ?? next++;
    seq.set(room.chatId, place);
    return { room, place };
  });
  placed.sort((a, b) => a.place - b.place);
  return { order: { seq, next }, rooms: placed.map((entry) => entry.room) };
}
