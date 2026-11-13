/**
 * Geometry constants for image annotations (a point or a rectangle drawn on a
 * picture, plus the numbered badge that names it).
 *
 * Two coordinate systems meet here and must never be mixed up:
 * - **image space** — what gets baked into the derived copy the model reads, and
 *   what the stored `ImageMark` describes (normalized `0..1`, top-left origin, so
 *   it survives the ≤2000px resize the model profile may apply);
 * - **screen space** — what the renderer draws (CSS px, zoomable, themed).
 *
 * Every ratio below is expressed against the *image* (or, for the screen, the
 * displayed box, which is the same fraction of it), so one set of numbers keeps
 * the two in step: a badge that is 2.2% of the long edge on screen is 2.2% of the
 * long edge in the baked copy. Only the pixel floors differ, because they exist
 * for two different reasons — {@link BADGE_MIN_SCREEN_PX} keeps the badge
 * clickable, {@link BADGE_MIN_BAKE_PX} keeps the digit legible in the delivered
 * file. See `.pi/facts/image-annotation.md` §3.6 (approved rendering spec).
 */

/**
 * Decimals kept for a normalized coordinate (1e-5 of the image). The model's own
 * localization error was measured at 0.3%–4% of the image (fact §2.4), i.e. 2–4
 * orders of magnitude coarser, so anything finer is noise — but the value is
 * cheap and stays exact enough for a pixel-perfect re-bake.
 */
export const MARK_COORD_DECIMALS = 5;

/** Decimals the prompt's `at:` line keeps (0.1% of the image). */
export const MARK_PROMPT_DECIMALS = 1;

/** Badge diameter / longest image edge. */
export const BADGE_RATIO = 0.022;

/** Badge diameter / shortest image edge — a badge never swallows a small picture. */
export const BADGE_MAX_SHORT_RATIO = 0.12;

/** Badge digit size / badge diameter. */
export const BADGE_FONT_RATIO = 0.55;

/** White ring around a badge, as a fraction of the badge diameter. */
export const BADGE_RING_RATIO = 0.09;

/** White ring around a badge, in px (floor). */
export const BADGE_RING_MIN_PX = 1.5;

/** Region outline width / longest image edge. */
export const STROKE_RATIO = 0.004;

/** Region outline width bounds, in px. */
export const STROKE_MIN_PX = 2;
export const STROKE_MAX_PX = 4;

/** Corner radius of a region outline, in screen px (scaled with the picture). */
export const RECT_RADIUS_PX = 3;

/** Region fill opacity — dims the area without hiding the pixels being judged. */
export const REGION_FILL_OPACITY = 0.14;

/**
 * Smallest badge diameter in **screen** px (at the fitted, 1× framing): below
 * this the badge stops being a comfortable click target.
 */
export const BADGE_MIN_SCREEN_PX = 16;

/**
 * Smallest badge diameter on a picture inside the thread (a 380px bubble picture,
 * or smaller in a channel with narrow bubbles): the number only has to be
 * *visible* there — reading it is the cards' job.
 */
export const BADGE_MIN_THREAD_PX = 12;

/** Smallest badge diameter in **baked image** px (legibility in the delivery). */
export const BADGE_MIN_BAKE_PX = 20;

/**
 * Largest long edge of a baked copy. The model profile resizes to 2000px anyway
 * (`image-resize-core.js`), so anything bigger only makes the badge shrink.
 */
export const BAKE_MAX_LONG_EDGE = 2000;

/**
 * Pointer travel (in **screen** px) up to which a press counts as a click.
 *
 * Screen px, not image px, because this is about the hand: a click wobbles by a
 * pixel or two of cursor/finger jitter regardless of how large the picture is or how
 * far it is zoomed. Anything beyond this is a **drag**, and a drag is an area — even a
 * 5px one. There is deliberately no "small area becomes a point" conversion: what the
 * boss drew is what gets stored, and the editor's shape label says which it is.
 */
export const CLICK_JITTER_PX = 3;

/** Longest attachment name written into one `[Comments]` header line. */
export const MAX_PROMPT_IMAGE_NAME_LENGTH = 120;

/**
 * Longest attachment name a stored image-annotation target may carry. A file
 * name is a single path segment, so this is a sanity cap rather than a real
 * limit; it mirrors the attachment payload's own bound.
 */
export const MAX_COMMENT_ATTACHMENT_NAME_LENGTH = 260;

/**
 * Largest image file the renderer may pull bytes for in order to bake a marked
 * copy. Generous for a screenshot, bounded so a huge panorama cannot be dragged
 * through IPC (and, in remote mode, through the transport's message cap).
 */
export const MAX_ANNOTATION_SOURCE_BYTES = 24 * 1024 * 1024;

/**
 * The mark's ink, as a literal: a canvas cannot use a CSS token, and the bake has
 * to draw exactly the color the screen shows. Kept in step with `--imb-mark` in
 * `renderer/styles/tokens.css` (5.06:1 against white digits — the reason it is
 * darker than the theme's danger red).
 */
export const MARK_INK = "#c93a3a";

/**
 * Prefix of a baked (marked) copy's file name.
 *
 * The prefix is the **only** marker a marked copy carries: `MessageAttachment` has
 * no field for "this is a derived picture" (adding one changes a stored contract, and
 * the boss ruled against it). It is safe because the app mints these names itself
 * (`savePastedFile` resolves collisions as `annotated-<name>-2.png`, still prefixed),
 * while a picture the boss picked or pasted keeps its own name (`pasted-*`,
 * `Screenshot ….png`).
 *
 * A marked copy takes **no new annotations** (its marks are already pixels, and
 * baking another batch on top of it would stack badges — the boss's ruling). See
 * {@link isAnnotatedCopyName}.
 */
export const ANNOTATED_FILE_PREFIX = "annotated-";

/**
 * Is this attachment a copy this app already baked marks into?
 *
 * Case-insensitive and trimmed: the value comes from a file name that may have gone
 * through a user-visible round trip (a rename on disk, a Windows path). Only the
 * *name* is available on both sides of the IPC boundary, which is why this is a naming
 * convention rather than a flag.
 */
export function isAnnotatedCopyName(name: string): boolean {
  return name.trim().toLowerCase().startsWith(ANNOTATED_FILE_PREFIX);
}
