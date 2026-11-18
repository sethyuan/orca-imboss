/**
 * Limits of the work-status (3D room) view.
 *
 * The view renders every in-progress task group as a room; these caps bound
 * both the IPC payload and the scene so a long-running app (dozens of task
 * groups) cannot turn one module switch into an expensive snapshot, and a
 * chatty employee cannot push a book-sized bubble onto the scene.
 */

/** Rooms returned in one snapshot (most recently active first). */
export const MAX_WORK_ROOMS = 24;

/** Employees drawn in one room (the meeting table seats this many). */
export const MAX_ROOM_MEMBERS = 20;

/** Progress steps kept on a room's screen (mirrors the card's own cap). */
export const MAX_ROOM_STEPS = 64;

/**
 * Characters of a message kept for a bubble preview.
 *
 * The bubble shows 2–3 lines and the reading view reads the full message on
 * demand (`messages:list`), so this only has to cover the preview — but it must
 * not be so tight that the cut lands inside the Markdown block the preview is
 * showing (see `bubbleLabel`: cuts happen on a paragraph/line/sentence/word
 * boundary). 200 characters keeps a heading plus a table header (or a couple of
 * prose lines) while keeping the whole snapshot's payload bounded: the worst case
 * (24 rooms × 20 bubbles) goes from ~293 KB to ~120 KB.
 */
export const MAX_BUBBLE_LENGTH = 200;

/** Bubbles (one per employee) kept per room. */
export const MAX_ROOM_BUBBLES = 20;

/**
 * How long a room stays on the board after the task group's last run ended.
 *
 * "In progress" still means "someone is working in it" — this only defers the
 * *removal* of the room, so a group that just finished does not vanish the instant
 * its run settles. A run that starts inside the window keeps the room (and starts
 * a fresh window when it ends again).
 */
export const ROOM_LINGER_MS = 30_000;
