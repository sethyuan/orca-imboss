/**
 * What one employee is *doing* in a room — the small state machine behind the
 * bubbles and the rest animations.
 *
 * Two rules from the boss shape the whole thing:
 *
 * 1. `resting` is **not interruptible**. A rest animation plays to its end; any
 *    change that arrives meanwhile (the employee started working, or a message
 *    they sent needs a bubble) is remembered and applied when the animation
 *    finishes. Cutting an animation mid-way reads as a glitch, not as liveliness.
 * 2. A message bubble is a *notification*, not a label: it shows for
 *    `BUBBLE_DISMISS_MS` and then falls back to the employee's real state
 *    (`working` if they are still running, otherwise idle / a rest animation). A
 *    newer message from the same employee replaces it and restarts that clock —
 *    messages are never queued one after another.
 *
 * The module is pure and clock-free (every function takes `now`) so the rules can
 * be reasoned about — and tested — without a renderer, a canvas or a timer.
 */

export type RestKind = "coffee" | "swivel" | "exercise";

/** How long each rest animation runs (ms). */
export const REST_DURATION_MS: Readonly<Record<RestKind, number>> = {
  coffee: 3200,
  swivel: 2600,
  exercise: 3000,
};

/**
 * Idle window before an idle employee starts a rest animation (ms). Random in
 * this range, so a room full of idle employees does not move in lockstep.
 */
export const REST_IDLE_MIN_MS = 6000;
export const REST_IDLE_MAX_MS = 14000;

export const REST_KINDS: readonly RestKind[] = ["coffee", "swivel", "exercise"];

/**
 * How long a message bubble stays on the wall before falling back to the
 * employee's real state. A character limit, not a layout constant: it lives here
 * next to the rules that use it, so the timing can be tuned in one place.
 */
export const BUBBLE_DISMISS_MS = 8_000;

/** A message the employee posted while waking someone (bubble content). */
export interface BubbleMessage {
  messageId: number;
  content: string;
}

/** What is on the employee's head right now. */
export type BubbleKind = "working" | "message";

export interface EmployeeView {
  readonly chatId: number;
  readonly employeeId: number;
  readonly running: boolean;
  readonly phase: "idle" | "working" | "message" | "resting";
  readonly message: BubbleMessage | null;
  /**
   * The message bubble this employee already had on the wall and lost (it timed
   * out). Snapshots are re-read constantly, so the same message keeps arriving;
   * without this the bubble would pop back a moment after it was dismissed.
   */
  readonly dismissedMessageId: number | null;
  /**
   * When the bubble currently on the wall goes away. Set when it is *shown* (so a
   * message queued behind a rest animation gets its full window, and a newer
   * message restarts it).
   */
  readonly messageExpiresAt: number;
  /** The rest animation being played (only while `phase === "resting"`). */
  readonly rest: RestKind | null;
  /**
   * The last rest animation this employee played, kept after the animation ends
   * so the next one can be a *different* kind (see `pickRest`).
   */
  readonly lastRest: RestKind | null;
  readonly restStartedAt: number;
  readonly restEndsAt: number;
  /** When the next rest animation may start (only meaningful while idle). */
  readonly nextRestAt: number;
}

export type Random = () => number;

function randomBetween(random: Random, min: number, max: number): number {
  return min + Math.floor(random() * (max - min));
}

function pickRest(random: Random, previous: RestKind | null): RestKind {
  const candidates = REST_KINDS.filter((kind) => kind !== previous);
  const pool = candidates.length > 0 ? candidates : REST_KINDS;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
}

/** `message` outranks `working` outranks `idle` — see the module doc. */
function settledPhase(
  running: boolean,
  message: BubbleMessage | null,
): EmployeeView["phase"] {
  if (message !== null) return "message";
  return running ? "working" : "idle";
}

function withSchedule(
  view: EmployeeView,
  now: number,
  random: Random,
): EmployeeView {
  if (view.phase !== "idle") return view;
  return {
    ...view,
    rest: null,
    nextRestAt: now + randomBetween(random, REST_IDLE_MIN_MS, REST_IDLE_MAX_MS),
  };
}

export function createView(
  chatId: number,
  employeeId: number,
  running: boolean,
  message: BubbleMessage | null,
  now: number,
  random: Random = Math.random,
): EmployeeView {
  const phase = settledPhase(running, message);
  return withSchedule(
    {
      chatId,
      employeeId,
      running,
      phase,
      message,
      dismissedMessageId: null,
      messageExpiresAt: phase === "message" ? now + BUBBLE_DISMISS_MS : 0,
      rest: null,
      lastRest: null,
      restStartedAt: 0,
      restEndsAt: 0,
      nextRestAt: Number.POSITIVE_INFINITY,
    },
    now,
    random,
  );
}

/**
 * The employee started or stopped working.
 *
 * A running change does **not** cut a message bubble short: the bubble is a
 * notification with its own clock, and when that clock runs out the view falls
 * back to whatever the employee is doing *then* — which is why `running` is
 * simply recorded here. (Superiority itself is unchanged: `message` still shows
 * over `working` while it is up.)
 */
export function setRunning(
  view: EmployeeView,
  running: boolean,
  now: number,
  random: Random = Math.random,
): EmployeeView {
  if (view.running === running) return view;
  const next: EmployeeView = { ...view, running };
  if (view.phase === "resting" || view.phase === "message") return next;
  return withSchedule(
    { ...next, phase: settledPhase(running, view.message) },
    now,
    random,
  );
}

/**
 * A newer message from this employee (or `null` when they have no bubble any
 * more).
 *
 * Only the newest one is shown — a burst of messages does not queue up — and each
 * new one restarts the dismissal clock. While a rest animation is playing the
 * message waits for it (rule 1) and its clock starts when it actually appears.
 */
export function setBubble(
  view: EmployeeView,
  message: BubbleMessage | null,
  now: number,
  random: Random = Math.random,
): EmployeeView {
  if (message === null || message.messageId === view.dismissedMessageId) {
    if (view.message === null) return view;
    const next: EmployeeView = { ...view, message: null, messageExpiresAt: 0 };
    if (view.phase === "resting") return next;
    return withSchedule(
      { ...next, phase: settledPhase(view.running, null) },
      now,
      random,
    );
  }
  if (view.message !== null && view.message.messageId === message.messageId) {
    // Same message, possibly a different body (it should not happen, but the
    // snapshot is re-read constantly — never restart the clock for it).
    return view.message.content === message.content
      ? view
      : { ...view, message };
  }
  // A new message replaces the current one and restarts the clock; during a rest
  // animation it is held until the animation ends (the clock starts then).
  const next: EmployeeView = { ...view, message };
  if (view.phase === "resting") return next;
  return {
    ...next,
    phase: "message",
    messageExpiresAt: now + BUBBLE_DISMISS_MS,
  };
}

/**
 * Advance the animation clock: finish a running rest animation, or start a new
 * one when the employee has been idle long enough.
 */
export function tick(
  view: EmployeeView,
  now: number,
  random: Random = Math.random,
): EmployeeView {
  if (view.phase === "resting") {
    if (now < view.restEndsAt) return view;
    // Animation over: apply whatever arrived while it was playing. A message that
    // waited gets its clock started now — when it actually becomes visible.
    const phase = settledPhase(view.running, view.message);
    return withSchedule(
      {
        ...view,
        phase,
        rest: null,
        restStartedAt: 0,
        restEndsAt: 0,
        messageExpiresAt: phase === "message" ? now + BUBBLE_DISMISS_MS : 0,
      },
      now,
      random,
    );
  }
  if (view.phase === "message") {
    if (now < view.messageExpiresAt) return view;
    // The bubble had its window: fall back to what the employee is doing now, and
    // remember this message so the constant snapshot re-read cannot bring it back.
    const dismissed = view.message?.messageId ?? view.dismissedMessageId;
    return withSchedule(
      {
        ...view,
        phase: settledPhase(view.running, null),
        message: null,
        messageExpiresAt: 0,
        dismissedMessageId: dismissed,
      },
      now,
      random,
    );
  }
  if (view.phase !== "idle") return view;
  if (now < view.nextRestAt) return view;
  // A different animation than last time: the same one twice in a row reads as a
  // loop rather than as a person taking a break.
  const rest = pickRest(random, view.lastRest);
  return {
    ...view,
    phase: "resting",
    rest,
    lastRest: rest,
    restStartedAt: now,
    restEndsAt: now + REST_DURATION_MS[rest],
  };
}

/** 0 → 1 progress of the rest animation in flight (0 when not resting). */
export function restProgress(view: EmployeeView, now: number): number {
  if (view.phase !== "resting") return 0;
  const span = view.restEndsAt - view.restStartedAt;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now - view.restStartedAt) / span));
}

/** The bubble this employee shows, or `null` for "nothing on the head". */
export function bubbleOf(
  view: EmployeeView,
): { kind: BubbleKind; content?: string } | null {
  if (view.phase === "resting") return null;
  if (view.phase === "message" && view.message !== null) {
    return { kind: "message", content: view.message.content };
  }
  if (view.phase === "working") return { kind: "working" };
  return null;
}

/** Stable key of one person in one room (the scene's map key). */
export function viewKey(chatId: number, employeeId: number): string {
  return `${chatId}:${employeeId}`;
}
