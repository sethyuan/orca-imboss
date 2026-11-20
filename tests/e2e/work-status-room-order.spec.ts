import { expect, test } from "@playwright/test";
import {
  orderByFirstSeen,
  type RoomOrderState,
} from "../../src/renderer/components/modules/work-status/room-order";
import type { WorkRoom } from "../../src/shared/types/work_status";

/**
 * The board's order, asserted on the pure function: a room takes its place the first
 * time it is shown, nothing that happens later moves it, and a room that shows up
 * afterwards — whatever its age or activity — is appended at the end.
 *
 * Pure and state-in/state-out, so the whole rule is checked without a renderer; the
 * E2E only proves the visible consequence (the board's list does not re-sort when a
 * message arrives).
 */

function room(chatId: number, lastActiveAt = 100): WorkRoom {
  return {
    chatId,
    title: `Room ${chatId}`,
    lastActiveAt,
    members: [],
  } as unknown as WorkRoom;
}

function apply(
  order: RoomOrderState | undefined,
  chatIds: number[],
): { order: RoomOrderState; ids: number[] } {
  const result = orderByFirstSeen(
    order,
    chatIds.map((chatId) => room(chatId)),
  );
  return {
    order: result.order,
    ids: result.rooms.map((entry) => entry.chatId),
  };
}

test("rooms keep the order they appeared in", () => {
  const first = apply(undefined, [40, 12, 7]);
  expect(first.ids).toEqual([40, 12, 7]);
  expect(first.order.next).toBe(3);
});

test("a newer room is appended, an older one too — the snapshot order starts it", () => {
  const seed = apply(undefined, [12, 40]);

  // A group created after them: last.
  const grown = apply(seed.order, [12, 40, 55]);
  expect(grown.ids).toEqual([12, 40, 55]);

  // A group that was created *before* both but only starts working now: it was never
  // on the board, so it is a new room and goes to the end, not to the front.
  const late = apply(grown.order, [5, 12, 40, 55]);
  expect(late.ids).toEqual([12, 40, 55, 5]);
});

test("activity does not move a room", () => {
  const seed = apply(undefined, [12, 40, 55]);
  // Same rooms, re-read with different activity times and in a different incoming
  // order (a snapshot may list them differently): the board must not change.
  const refreshed = orderByFirstSeen(seed.order, [
    room(55, 9_999),
    room(12, 5_000),
    room(40, 7_000),
  ]);
  expect(refreshed.rooms.map((entry) => entry.chatId)).toEqual([12, 40, 55]);
});

test("a room that left and comes back is a new room and is appended", () => {
  const seed = apply(undefined, [12, 40, 55]);

  // Room 12 finishes and its window closes: it is gone from the board.
  const without = apply(seed.order, [40, 55]);
  expect(without.ids).toEqual([40, 55]);

  // It starts working again later. It has no place any more, so it goes last —
  // the rooms that are on the board keep their relative order.
  const back = apply(without.order, [12, 40, 55]);
  expect(back.ids).toEqual([40, 55, 12]);
});

test("the state only holds the rooms that are on the board", () => {
  const seed = apply(undefined, [12, 40]);
  const without = apply(seed.order, [40]);
  // Room 12's place is forgotten, not just hidden (that is what makes "came back"
  // mean "new room"), so the map cannot grow for the life of the session.
  expect([...without.order.seq.keys()]).toEqual([40]);
  expect(without.order.next).toBe(2);
});
