import { expect, test } from "@playwright/test";
import {
  type LingeringRoom,
  mergeRoomsWithLinger,
} from "../../src/renderer/components/modules/work-status/linger";
import type { WorkRoom } from "../../src/shared/types/work_status";

/**
 * The linger rule, asserted on the pure merge function: a room stays for
 * `ROOM_LINGER_MS` after its last run ended, then disappears.
 *
 * Pure and clock-injected so the 30 s window costs no wall-clock time here; the
 * E2E only proves the visible consequence (the room does *not* vanish the moment
 * the run settles).
 */

const LINGER = 30_000;

function room(chatId: number, lastActiveAt = 100): WorkRoom {
  return {
    chatId,
    title: `Room ${chatId}`,
    accentSeed: chatId,
    lastActiveAt,
    members: [
      {
        employeeId: 1,
        name: "Anna",
        avatar: null,
        avatarVersion: null,
        running: true,
        orchestrator: false,
      },
      {
        employeeId: 2,
        name: "Ben",
        avatar: null,
        avatarVersion: null,
        running: false,
        orchestrator: false,
      },
    ],
    progress: null,
  } as unknown as WorkRoom;
}

function merge(
  previous: Map<number, LingeringRoom>,
  incoming: WorkRoom[],
  now: number,
): ReturnType<typeof mergeRoomsWithLinger> {
  return mergeRoomsWithLinger(previous, incoming, now, LINGER);
}

test("a room stays for the whole window after its last run and then goes", () => {
  const first = merge(new Map(), [room(7)], 1_000);
  expect(first.rooms.map((entry) => entry.chatId)).toEqual([7]);
  expect(first.nextExpiryInMs).toBeNull();

  // The run settles at t=1.5s: nobody works here any more, but the room stays and
  // is shown as such (no stale running flag, the bubble is kept as the last word).
  const ended = merge(first.lingering, [], 1_500);
  expect(ended.rooms.map((entry) => entry.chatId)).toEqual([7]);
  expect(ended.rooms[0]!.members.every((member) => !member.running)).toBe(true);
  expect(ended.rooms[0]!.members[1]!.running).toBe(false);
  expect(ended.nextExpiryInMs).toBe(LINGER);

  // The countdown runs from the end of the work, not from the last tick.
  const late = merge(ended.lingering, [], 1_500 + LINGER - 1);
  expect(late.rooms).toHaveLength(1);
  expect(late.nextExpiryInMs).toBe(1);

  // One millisecond later the window is over.
  const gone = merge(late.lingering, [], 1_500 + LINGER);
  expect(gone.rooms).toEqual([]);
  expect(gone.lingering.size).toBe(0);
  expect(gone.nextExpiryInMs).toBeNull();
});

test("a run inside the window keeps the room, and its own end restarts the window", () => {
  const first = merge(new Map(), [room(7)], 0);
  const stillThere = merge(first.lingering, [], 20_000);
  expect(stillThere.rooms).toHaveLength(1);

  // Someone starts again at t=20s: the room is running again…
  const running = merge(stillThere.lingering, [room(7)], 20_000);
  expect(running.rooms[0]!.members[0]!.running).toBe(true);
  // …and when *that* run ends the window starts over from t=25s.
  const ended = merge(running.lingering, [], 25_000);
  expect(merge(ended.lingering, [], 25_000 + LINGER - 1).rooms).toHaveLength(1);
  expect(merge(ended.lingering, [], 25_000 + LINGER).rooms).toHaveLength(0);
});

test("several lingering rooms expire on their own windows, running rooms first", () => {
  const seed = merge(new Map(), [room(7, 500), room(9, 900)], 0);
  expect(seed.rooms.map((entry) => entry.chatId)).toEqual([9, 7]);
  expect(seed.nextExpiryInMs).toBeNull();

  // Both stop at t=1s: two windows, both 30 s long.
  const ended = merge(seed.lingering, [], 1_000);
  expect(ended.rooms.map((entry) => entry.chatId)).toEqual([9, 7]);
  expect(ended.nextExpiryInMs).toBe(LINGER);

  // Room 9 works again at t=10s; room 7 (stopped at t=1s) keeps its own countdown.
  const mixed = merge(ended.lingering, [room(9, 1_000)], 10_000);
  expect(mixed.rooms[0]!.chatId).toBe(9);
  expect(mixed.rooms[0]!.members[0]!.running).toBe(true);
  expect(mixed.rooms[1]!.chatId).toBe(7);
  expect(mixed.rooms[1]!.members[0]!.running).toBe(false);
  expect(mixed.nextExpiryInMs).toBe(LINGER - 9_000);

  // At t=31s room 7 is dropped; room 9 stopped at that moment, so *its* window
  // starts over instead of inheriting the old one.
  const partial = merge(mixed.lingering, [], 31_000);
  expect(partial.rooms.map((entry) => entry.chatId)).toEqual([9]);
  expect(partial.rooms[0]!.members[0]!.running).toBe(false);
  expect(partial.nextExpiryInMs).toBe(LINGER);
});

test("time spent with the module hidden counts against the window", () => {
  const live = merge(new Map(), [room(7)], 0);

  // The user leaves the board; the run settles; they come back at t=60s. The
  // snapshot read on return no longer lists the room, and the merge is told that
  // snapshot is from t=0, so the window elapsed while they were away: the room is
  // dropped instead of being granted a fresh 30 s.
  const back = mergeRoomsWithLinger(live.lingering, [], 60_000, LINGER, 0);
  expect(back.rooms).toEqual([]);

  // Away for only 5s: the window keeps running, 25s left.
  const soon = mergeRoomsWithLinger(live.lingering, [], 5_000, LINGER, 0);
  expect(soon.rooms).toHaveLength(1);
  expect(soon.nextExpiryInMs).toBe(LINGER - 5_000);
});
