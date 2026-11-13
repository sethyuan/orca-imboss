/**
 * Where a mark's pieces go, in the pixels of whatever box it is drawn in.
 *
 * One function serves the two very different renderers — the DOM layer (screen
 * px, CSS) and the canvas bake (image px) — because the *ratios* are the same in
 * both (see `shared/constants/image-annotation.ts`). The only thing that differs
 * is the floor on the badge diameter, which exists for a reason that belongs to
 * the medium: a screen badge must stay clickable, a baked one must stay legible.
 * Sharing the math is what keeps "what I saw" and "what the model got" the same
 * picture.
 */
import {
  BADGE_FONT_RATIO,
  BADGE_MAX_SHORT_RATIO,
  BADGE_RATIO,
  BADGE_RING_MIN_PX,
  BADGE_RING_RATIO,
  REGION_FILL_OPACITY,
  RECT_RADIUS_PX,
  STROKE_MAX_PX,
  STROKE_MIN_PX,
  STROKE_RATIO,
} from "@shared/constants/image-annotation";
import type { ImageMark } from "@shared/types";

/** Size of the box a mark is drawn in, in the medium's own pixels. */
export interface MarkBox {
  width: number;
  height: number;
}

/** Everything one mark needs, resolved to pixels of {@link MarkBox}. */
export interface MarkGeometry {
  /**
   * The anchor the layer puts its origin on, in picture pixels: the marked point
   * for a point, the rectangle's top-left corner for a region.
   */
  originX: number;
  originY: number;
  /** The region's rectangle, in px (`0` for a point, and for a region drawn as one). */
  width: number;
  height: number;
  /** Badge diameter. */
  badge: number;
  /** White outline around the badge. */
  badgeRing: number;
  /**
   * Radius of the thin ring that marks a point.
   *
   * Half a badge diameter, i.e. the ring is as wide as the badge (fact §3.6:
   * "半径 ≈ 徽标直径的 0.5"). Deliberately *not* a full badge diameter: with the
   * spec's quadrant construction the ring was twice the badge, and five marks in a
   * column then merged into one blob at 1200px — the exact readability the ring
   * exists for.
   */
  pointRadius: number;
  /** Badge digit size. */
  font: number;
  /** Region outline width (and the point ring's width). */
  stroke: number;
  /** Corner radius of a region outline. */
  radius: number;
  /** Region fill opacity (`0` for a point). */
  fill: number;
  /**
   * The badge is too small for a digit. The badge itself is still drawn (it is the
   * anchor and the click target); only the number is dropped, because two pixels of
   * glyph is noise rather than an ordinal.
   */
  showNumber: boolean;
  /**
   * The badge's box, in picture pixels — the one thing every renderer needs and
   * the one thing that must never be derived twice.
   *
   * For a point (and for a too-small region) its bottom-right corner sits on the
   * anchor, which is what "pressed onto the target" means geometrically (fact
   * §2.5: a badge *outside* the target shifted the model's answer onto the
   * neighbouring element). For a region it is pinned inside the rectangle's
   * top-left corner.
   */
  badgeBox: { left: number; top: number; width: number; height: number };
}

/**
 * Smallest badge worth drawing at all, in px. Below this a badge is a dot — which is
 * still the anchor and the click target, just without a digit.
 */
const MIN_BADGE_PX = 2;

/** Smallest badge that can carry a readable digit, in px. */
const MIN_NUMBERED_BADGE_PX = 10;

/**
 * Resolve one mark into pixels for a box of `box` size.
 *
 * `minBadgePx` is the medium's floor (screen: clickable; bake: legible); the badge
 * ratios and the short-edge cap are shared, so the two media cannot disagree about
 * proportions.
 *
 * The anchors are absolute (picture px), never relative to a parent box: the layer
 * that draws marks is a zero-size origin, and every child is placed by adding to it
 * in pixels. Deriving a child's size from a *percentage* of a zero-size parent is
 * exactly how a region once collapsed into a 4×4px sliver on screen while the baked
 * one was right (`docs`-style bug that a "looks fine in the bake" check cannot see).
 */
export function markGeometry(
  mark: ImageMark,
  box: MarkBox,
  minBadgePx: number,
): MarkGeometry {
  const width = Math.max(box.width, 0);
  const height = Math.max(box.height, 0);
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const stroke = Math.min(
    Math.max(STROKE_RATIO * longEdge, STROKE_MIN_PX),
    STROKE_MAX_PX,
  );
  const badge = Math.min(
    Math.max(BADGE_RATIO * longEdge, minBadgePx),
    BADGE_MAX_SHORT_RATIO * shortEdge,
  );
  const badgeRing = Math.max(BADGE_RING_MIN_PX, BADGE_RING_RATIO * badge);
  const font = badge * BADGE_FONT_RATIO;
  const radius = Math.min(RECT_RADIUS_PX, stroke * 1.5);
  const pointRadius = badge / 2;

  /** The badge's box with `corner` sitting on (x, y). */
  const badgeAt = (
    x: number,
    y: number,
    corner: "bottomRight" | "topLeft",
  ): MarkGeometry["badgeBox"] =>
    corner === "bottomRight"
      ? { left: x - badge, top: y - badge, width: badge, height: badge }
      : { left: x, top: y, width: badge, height: badge };

  if (mark.kind !== "region") {
    // A point (or the whole picture, which has no geometry and is never drawn):
    // ring centred on the marked pixel, badge's bottom-right corner on it.
    const x = (mark.x ?? 0) * width;
    const y = (mark.y ?? 0) * height;
    return {
      originX: x,
      originY: y,
      width: 0,
      height: 0,
      badge,
      badgeRing,
      pointRadius,
      font,
      stroke,
      radius,
      fill: 0,
      showNumber: badge >= MIN_NUMBERED_BADGE_PX,
      badgeBox: badgeAt(x, y, "bottomRight"),
    };
  }
  const left = Math.min(mark.x ?? 0, mark.x2 ?? 0) * width;
  const top = Math.min(mark.y ?? 0, mark.y2 ?? 0) * height;
  const rectWidth = Math.abs((mark.x2 ?? 0) - (mark.x ?? 0)) * width;
  const rectHeight = Math.abs((mark.y2 ?? 0) - (mark.y ?? 0)) * height;
  // A region keeps its rectangle **as drawn**, however small. The badge is what
  // gives way: it is capped to the box's inner size so it can never smother the area
  // it marks (the rule "the badge sits pressed onto the target" is about *where* it
  // is, not about it being big enough to hide the target).
  const innerMin = Math.max(Math.min(rectWidth, rectHeight) - stroke * 2, 0);
  const regionBadge = Math.min(badge, Math.max(innerMin, MIN_BADGE_PX));
  return {
    originX: left,
    originY: top,
    width: rectWidth,
    height: rectHeight,
    badge: regionBadge,
    badgeRing: Math.max(BADGE_RING_MIN_PX, BADGE_RING_RATIO * regionBadge),
    pointRadius,
    font: regionBadge * BADGE_FONT_RATIO,
    stroke,
    radius: Math.min(radius, rectWidth / 2, rectHeight / 2),
    fill: REGION_FILL_OPACITY,
    showNumber: regionBadge >= MIN_NUMBERED_BADGE_PX,
    badgeBox: badgeAt(left + stroke, top + stroke, "topLeft"),
  };
}
