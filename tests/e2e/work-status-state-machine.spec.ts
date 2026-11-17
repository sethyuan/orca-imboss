import { expect, test } from "@playwright/test";
import { hoverChipPlacement } from "../../src/renderer/components/modules/work-status/scene/hud";
import {
  BUBBLE_DISMISS_MS,
  REST_DURATION_MS,
  REST_IDLE_MAX_MS,
  REST_IDLE_MIN_MS,
  bubbleOf,
  createView,
  restProgress,
  setBubble,
  setRunning,
  tick,
  type EmployeeView,
} from "../../src/renderer/components/modules/work-status/state-machine";

/**
 * The bubble / rest-animation rules, asserted directly on the pure state machine.
 *
 * No Electron, no canvas, no clock: every step takes its `now`, and `random` is
 * pinned, so a failure names the rule that broke. This is the coverage the boss
 * asked for after the acceptance run pointed out that the module's head comment
 * claimed these rules were "covered separately" while nothing covered them —
 * neither the bubbles (which only appear while an agent is really streaming) nor
 * the "a rest animation is never cut short" rule can be driven from the E2E app
 * without a model provider.
 */

/** Deterministic `random`: 0.5 lands mid-range for idle delays and rest picks. */
const random = (): number => 0.5;

function idle(now = 0): EmployeeView {
  return createView(7, 3, false, null, now, random);
}

/** Drive `view` to the first frame of a rest animation. */
function resting(now = 0): { view: EmployeeView; startedAt: number } {
  const start = idle(now);
  const startedAt = Math.round(now + (REST_IDLE_MIN_MS + REST_IDLE_MAX_MS) / 2);
  const view = tick(start, startedAt, random);
  expect(view.phase).toBe("resting");
  return { view, startedAt };
}

test("a running employee shows the working bubble", () => {
  const view = createView(7, 3, true, null, 0, random);
  expect(view.phase).toBe("working");
  expect(bubbleOf(view)).toEqual({ kind: "working" });
  expect(bubbleOf(setRunning(view, false, 0, random))).toBeNull();
});

test("a message bubble falls back after its window (no real waiting)", () => {
  const message = { messageId: 41, content: "the migration is in" };
  let view = createView(7, 3, true, message, 0, random);
  expect(bubbleOf(view)).toEqual({ kind: "message", content: message.content });

  // One millisecond short of the window it is still up…
  view = tick(view, BUBBLE_DISMISS_MS - 1, random);
  expect(bubbleOf(view)).toEqual({ kind: "message", content: message.content });

  // …and at the window it falls back to the *current* state, which is "working"
  // because this employee is still running.
  view = tick(view, BUBBLE_DISMISS_MS, random);
  expect(view.message).toBeNull();
  expect(bubbleOf(view)).toEqual({ kind: "working" });

  // The same message keeps arriving from every snapshot re-read; it must not
  // resurrect the bubble that already had its window.
  const again = setBubble(view, message, BUBBLE_DISMISS_MS + 10, random);
  expect(bubbleOf(again)).toEqual({ kind: "working" });
});

test("after its window the bubble falls back to idle when the employee is not running", () => {
  const message = { messageId: 42, content: "done for now" };
  const view = createView(7, 3, false, message, 0, random);
  const expired = tick(view, BUBBLE_DISMISS_MS, random);
  expect(expired.phase).toBe("idle");
  expect(bubbleOf(expired)).toBeNull();
});

test("only the newest message is shown, and it restarts the window", () => {
  const first = { messageId: 41, content: "first" };
  const second = { messageId: 42, content: "second" };
  let view = createView(7, 3, false, first, 0, random);

  // A second message arrives 5s in: it replaces the first instead of queueing.
  view = setBubble(view, second, 5_000, random);
  expect(bubbleOf(view)).toEqual({ kind: "message", content: "second" });

  // The first message's original deadline has passed, the new one has not.
  view = tick(view, BUBBLE_DISMISS_MS + 1, random);
  expect(bubbleOf(view)).toEqual({ kind: "message", content: "second" });

  // 8s after it appeared, the second one goes.
  view = tick(view, 5_000 + BUBBLE_DISMISS_MS, random);
  expect(bubbleOf(view)).toBeNull();
});

test("a message that arrives during a rest animation waits, then gets its full window", () => {
  const { view, startedAt } = resting();
  const message = { messageId: 43, content: "woke someone" };
  const queued = setBubble(view, message, startedAt + 100, random);

  // Nothing on the head while the animation plays.
  expect(queued.phase).toBe("resting");
  expect(bubbleOf(queued)).toBeNull();

  // It appears when the animation ends…
  const endsAt = queued.restEndsAt;
  const shown = tick(queued, endsAt, random);
  expect(bubbleOf(shown)).toEqual({
    kind: "message",
    content: message.content,
  });

  // …and its clock starts *then*, not when it arrived.
  expect(tick(shown, endsAt + BUBBLE_DISMISS_MS - 1, random).phase).toBe(
    "message",
  );
  expect(tick(shown, endsAt + BUBBLE_DISMISS_MS, random).message).toBeNull();
});

test("a running change does not cut a message bubble short", () => {
  const message = { messageId: 41, content: "the migration is in" };
  const view = createView(7, 3, false, message, 0, random);

  // The employee starts working 100ms later: the bubble keeps its window (a
  // notification is not a state label) …
  const running = setRunning(view, true, 100, random);
  expect(bubbleOf(running)).toEqual({
    kind: "message",
    content: message.content,
  });

  // … and only when the window ends does the view show the real state.
  expect(bubbleOf(tick(running, BUBBLE_DISMISS_MS, random))).toEqual({
    kind: "working",
  });
});

test("a rest animation is never cut short by new state", () => {
  const { view, startedAt } = resting();
  expect(view.rest).not.toBeNull();
  const endsAt = view.restEndsAt;
  const rest = view.rest;

  // The employee starts working and sends a message mid-animation.
  let current = setRunning(view, true, startedAt + 100, random);
  current = setBubble(
    current,
    { messageId: 9, content: "woke someone" },
    startedAt + 200,
    random,
  );

  // Still the same animation, still nothing on the head.
  expect(current.phase).toBe("resting");
  expect(current.rest).toBe(rest);
  expect(current.restStartedAt).toBe(startedAt);
  expect(current.restEndsAt).toBe(endsAt);
  expect(bubbleOf(current)).toBeNull();

  // Ticking inside the animation changes nothing either.
  const midway = tick(current, startedAt + 50, random);
  expect(midway.phase).toBe("resting");
  expect(midway.restEndsAt).toBe(endsAt);

  // …and only when it ends does the queued state take over: the message outranks
  // "working" (see the module doc), so that is what appears.
  const after = tick(current, endsAt, random);
  expect(after.phase).toBe("message");
  expect(bubbleOf(after)).toEqual({ kind: "message", content: "woke someone" });
  // The window starts when the bubble appears, not when the message arrived.
  expect(tick(after, endsAt + BUBBLE_DISMISS_MS - 1, random).phase).toBe(
    "message",
  );
  expect(tick(after, endsAt + BUBBLE_DISMISS_MS, random).phase).toBe("working");
});

test("work that starts during a rest animation appears right after it", () => {
  const { view, startedAt } = resting();
  const working = setRunning(view, true, startedAt + 100, random);
  expect(bubbleOf(working)).toBeNull();

  const after = tick(working, working.restEndsAt, random);
  expect(after.phase).toBe("working");
  expect(bubbleOf(after)).toEqual({ kind: "working" });
});

test("an idle employee starts a rest animation only when the delay is over", () => {
  const view = idle();
  const startsAt = view.nextRestAt;
  expect(startsAt).toBeGreaterThanOrEqual(REST_IDLE_MIN_MS);
  expect(startsAt).toBeLessThanOrEqual(REST_IDLE_MAX_MS);
  expect(tick(view, startsAt - 1, random).phase).toBe("idle");
  expect(tick(view, startsAt, random).phase).toBe("resting");
});

test("consecutive rest animations are different kinds", () => {
  const seen: string[] = [];
  let view = idle();
  let now = 0;
  for (let round = 0; round < 4; round += 1) {
    now = view.nextRestAt;
    view = tick(view, now, random);
    expect(view.rest).not.toBeNull();
    seen.push(view.rest as string);
    now = view.restEndsAt;
    view = tick(view, now, random);
    expect(view.phase).toBe("idle");
  }
  for (let index = 1; index < seen.length; index += 1) {
    expect(seen[index]).not.toBe(seen[index - 1]);
  }
});

test("rest progress runs from 0 to 1 across the animation", () => {
  const { view, startedAt } = resting();
  const span = REST_DURATION_MS[view.rest as keyof typeof REST_DURATION_MS];
  expect(restProgress(view, startedAt)).toBe(0);
  expect(restProgress(view, startedAt + span / 2)).toBeCloseTo(0.5, 5);
  expect(restProgress(view, startedAt + span)).toBe(1);
  // Not resting → no progress, whatever the clock says.
  expect(restProgress(idle(), 5000)).toBe(0);
});

test("the hover chip sits to the employee's left, and flips at the edge", () => {
  const chip = 96;
  // Roomy: left of the head, right-aligned to it.
  const normal = hoverChipPlacement(400, chip);
  expect(normal.side).toBe("left");
  expect(normal.x).toBeLessThan(400);
  expect(normal.x - chip).toBeGreaterThanOrEqual(0);

  // Near the left edge: the strip is too narrow, so it flips to the right.
  const flipped = hoverChipPlacement(80, chip);
  expect(flipped.side).toBe("right");
  expect(flipped.x).toBeGreaterThan(80);

  // Exactly on the boundary it still fits on the left (>= 0), one pixel less flips.
  expect(hoverChipPlacement(chip + 10, chip).side).toBe("left");
  expect(hoverChipPlacement(chip + 9, chip).side).toBe("right");
});
