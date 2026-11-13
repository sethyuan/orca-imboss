/**
 * Image-annotation geometry, shared by the three sides that must agree on it:
 *
 * - the renderer captures a mark and draws it on screen,
 * - the main process writes/reads it in the `[Comments]` block and in
 *   `messages.comments`,
 * - the bake path replays it onto the derived copy the model reads.
 *
 * The `at:` line is the model-facing form and is **lossy on purpose** (0.1% of
 * the image, matching the ceiling of what a model can localize anyway — see
 * `.pi/facts/image-annotation.md` §2.4). Lossiness is safe because the formatter
 * is canonical: `formatMarkAt()` of a value that came out of `parseMarkAt()` is
 * byte-identical to the line it was parsed from, which is what keeps
 * `splitCommentPrompt()`'s round-trip guard intact.
 */
import {
  MARK_COORD_DECIMALS,
  MARK_PROMPT_DECIMALS,
} from "./constants/image-annotation";
import type { ImageMark } from "./types";

/** Round a normalized coordinate to the precision the record keeps. */
export function roundCoord(value: number): number {
  const factor = 10 ** MARK_COORD_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** Clamp to `0..1` (defensive: a coordinate outside the picture is meaningless). */
function clampCoord(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** `true` for a finite number inside `0..1`. */
function isCoord(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

/** `true` for a non-negative integer (an image's pixel size; `0` = unknown). */
function isPixelSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The two values above as one normalized coordinate pair, or `null`. */
function coordPair(x: unknown, y: unknown): { x: number; y: number } | null {
  if (!isCoord(x) || !isCoord(y)) return null;
  return { x: roundCoord(clampCoord(x)), y: roundCoord(clampCoord(y)) };
}

/**
 * Validate and canonicalize one mark read from an untrusted source (the
 * renderer's IPC payload, or a stored JSON column).
 *
 * Returns `null` when the shape is unusable. A region's corners come back sorted
 * (`x ≤ x2`, `y ≤ y2`) so every reader — drawing, baking, drift checks — sees the
 * same rectangle no matter which way the boss dragged. Values are rounded to
 * `MARK_COORD_DECIMALS`, which also keeps a stored record byte-stable across a
 * write → read → write cycle.
 */
export function normalizeImageMark(value: unknown): ImageMark | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const kind = raw["kind"];
  if (kind !== "image" && kind !== "point" && kind !== "region") return null;
  const imageWidth = raw["imageWidth"];
  const imageHeight = raw["imageHeight"];
  if (!isPixelSize(imageWidth) || !isPixelSize(imageHeight)) return null;
  if (kind === "image") return { kind, imageWidth, imageHeight };
  const first = coordPair(raw["x"], raw["y"]);
  if (first === null) return null;
  if (kind === "point") {
    return { kind, ...first, imageWidth, imageHeight };
  }
  const second = coordPair(raw["x2"], raw["y2"]);
  if (second === null) return null;
  return {
    kind,
    x: Math.min(first.x, second.x),
    y: Math.min(first.y, second.y),
    x2: Math.max(first.x, second.x),
    y2: Math.max(first.y, second.y),
    imageWidth,
    imageHeight,
  };
}

/**
 * One coordinate as the prompt writes it: a percentage with
 * `MARK_PROMPT_DECIMALS` decimals (`88.0`, `6.0`, `41.8`).
 *
 * `toFixed` is the canonical form the parser reads back, so formatting is
 * idempotent — that is the whole round-trip argument above.
 */
function formatPercent(value: number): string {
  return (clampCoord(value) * 100).toFixed(MARK_PROMPT_DECIMALS);
}

/**
 * The prompt's `at:` payload for one mark (`point 88.0%, 6.0%` /
 * `region 41.8%, 17.5% → 54.1%, 23.6%` / `whole image`).
 *
 * The two corner points are the whole geometry: the rectangle is axis-aligned by
 * construction, so two opposite corners are complete, and asking for four would
 * only introduce an ordering to get wrong (fact §2.4).
 */
export function formatMarkAt(mark: ImageMark): string {
  if (mark.kind === "image") return "whole image";
  const x = mark.x ?? 0;
  const y = mark.y ?? 0;
  if (mark.kind === "point") {
    return `point ${formatPercent(x)}%, ${formatPercent(y)}%`;
  }
  // Corners are canonicalized (min → max) here as well as on read: a region is
  // the same rectangle whichever way it was dragged, and the round-trip check
  // compares bytes, so writer and reader must agree on the order.
  const x2 = mark.x2 ?? 0;
  const y2 = mark.y2 ?? 0;
  return `region ${formatPercent(Math.min(x, x2))}%, ${formatPercent(
    Math.min(y, y2),
  )}% → ${formatPercent(Math.max(x, x2))}%, ${formatPercent(Math.max(y, y2))}%`;
}

/** One percentage with up to `MARK_PROMPT_DECIMALS` decimals, as a fraction. */
const PERCENT = /^(\d{1,3}(?:\.\d{1,2})?)%$/;

/** Parse one `NN.N%` token into a normalized coordinate, or `null`. */
function parsePercent(token: string | undefined): number | null {
  if (token === undefined) return null;
  const match = PERCENT.exec(token.trim());
  if (match === null) return null;
  const value = Number(match[1]) / 100;
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return roundCoord(value);
}

/**
 * Parse an `at:` payload back into a mark (the inverse of {@link formatMarkAt}).
 *
 * The prompt carries geometry only, so the pixel size is `0` ("unknown"): a
 * prompt-recovered mark is used for display and validation, never for a bake
 * (a bake always starts from the original file, so it measures the size itself).
 */
export function parseMarkAt(text: string): ImageMark | null {
  const value = text.trim();
  if (value === "whole image")
    return { kind: "image", imageWidth: 0, imageHeight: 0 };
  const point = /^point (\S+), (\S+)$/.exec(value);
  if (point !== null) {
    const x = parsePercent(point[1]);
    const y = parsePercent(point[2]);
    if (x === null || y === null) return null;
    return { kind: "point", x, y, imageWidth: 0, imageHeight: 0 };
  }
  const region = /^region (\S+), (\S+) → (\S+), (\S+)$/.exec(value);
  if (region !== null) {
    const x = parsePercent(region[1]);
    const y = parsePercent(region[2]);
    const x2 = parsePercent(region[3]);
    const y2 = parsePercent(region[4]);
    if (x === null || y === null || x2 === null || y2 === null) return null;
    return normalizeImageMark({
      kind: "region",
      x,
      y,
      x2,
      y2,
      imageWidth: 0,
      imageHeight: 0,
    });
  }
  return null;
}

/**
 * The stored size a mark claims, as a drift check: `true` when the picture the
 * caller is looking at is still the one that was annotated.
 *
 * A `0` size is "unknown" (a mark recovered from a prompt block, or written
 * before the size existed) and never counts as drift — refusing to draw a mark is
 * a last resort, not a default.
 */
export function markSizeMatches(
  mark: ImageMark,
  width: number,
  height: number,
): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (mark.imageWidth === 0 || mark.imageHeight === 0) return true;
  return (
    mark.imageWidth === Math.round(width) &&
    mark.imageHeight === Math.round(height)
  );
}
