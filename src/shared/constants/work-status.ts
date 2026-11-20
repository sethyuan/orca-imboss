/**
 * Limits of the work-status (3D room) view.
 *
 * The view renders every in-progress task group as a room; these caps bound
 * both the IPC payload and the scene so a long-running app (dozens of task
 * groups) cannot turn one module switch into an expensive snapshot, and a
 * chatty employee cannot push a book-sized bubble onto the scene.
 */

/**
 * Rooms returned in one snapshot.
 *
 * Twelve, not twenty-four: the board is read at a glance, and half the rooms is
 * half the geometry the GPU has to hold (the bird's-eye view is static on top of
 * that, see `stage.ts`).
 *
 * The snapshot is creation-ordered (a room's place on the board is fixed once it
 * appeared, see `room-order.ts`), and the cap keeps the **newest** groups: a group
 * that just started working must never be the one that does not fit.
 */
export const MAX_WORK_ROOMS = 12;

/**
 * Rooms the renderer keeps on the board after their work ended (`linger.ts`).
 *
 * The linger window is long (30 min, see `ROOM_LINGER_MS`), so without a cap a busy
 * half hour would pile up every task group that ever finished — each one is real
 * geometry, a screen texture and a name plate. Twelve keeps the worst case at
 * `MAX_WORK_ROOMS + 12` = the 24 rooms the board used to be sized for; beyond it the
 * rooms that ended longest ago are dropped (they are the least likely to be missed).
 */
export const MAX_LINGERING_ROOMS = 12;

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
 * (12 rooms × 20 bubbles) stays around 60 KB.
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
 *
 * Half an hour, not half a minute: the rooms are laid out in the order they first
 * appeared (`room-order.ts`), so a room vanishing moves every room behind it. A
 * group the boss only glances at ten minutes later must still be where it was, and
 * a returned room re-appends at the end — which is only bearable when the board is
 * not reshuffled every few minutes.
 */
export const ROOM_LINGER_MS = 30 * 60_000;
