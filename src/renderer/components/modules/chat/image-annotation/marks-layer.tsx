/**
 * The marks drawn *on top of* a picture: one numbered badge per annotation, plus
 * the outline that shows what it covers.
 *
 * Pure presentation over an absolutely-positioned layer that fills the picture's
 * box: positions are percentages (so the layer scales with whatever box it is
 * given — a zoomed lightbox frame, a 380px bubble picture, a 40px thumbnail),
 * while the badge/outline sizes are resolved from the box's *measured* pixels by
 * the same `markGeometry()` the bake uses.
 *
 * Two visual registers, and they never mix:
 * - **live** (`historical` unset): the red mark color, a numbered badge — these
 *   are the annotations of the batch being written, or the ones already sent in
 *   *this* conversation;
 * - **historical**: grey, dashed, no number. A mark of an earlier batch appears
 *   this way inside a lightbox so that two annotations of the same picture can
 *   never both claim to be `#1` (decision ③).
 */
import type { ImageMark } from "@shared/types";
import { useLayoutEffect, useState, type CSSProperties } from "react";
import { cls } from "reactutils";
import { markGeometry } from "./geometry";
import "./index.css";

/** One mark to draw, whoever wrote it. */
export interface MarkView {
  /** Stable identity (a pending comment id, or a sent record's key). */
  key: string;
  mark: ImageMark;
  /** The `#n` the model will answer; absent on a historical mark. */
  ordinal?: number;
  /** The annotation's note, for the badge's accessible name. */
  note: string;
  /** Draw as an earlier batch's mark: grey, dashed, no number, no interaction. */
  historical?: boolean;
  /**
   * Already delivered (a sent annotation). The viewer's side list is about the batch
   * being written, so it filters on this instead of trying to parse keys.
   */
  sent?: boolean;
}

export interface MarkLayerProps {
  marks: readonly MarkView[];
  /** Smallest badge diameter in px — the medium's floor. */
  minBadgePx: number;
  /** Key of the mark to emphasize (hover from a card or the side list). */
  focusKey?: string | null;
  /** Key of the mark being edited (its panel is open). */
  editingKey?: string | null;
  /** Other marks fade while one is focused/edited. */
  onSelect?: (key: string) => void;
  /** Render without taking pointer events (thumbnails, inactive mode). */
  inert?: boolean;
  className?: string;
}

/**
 * Measure an element's box, re-measuring on resize.
 *
 * Keyed on the **element**, not on a ref object: a layer that mounts empty (no marks
 * yet) returns `null` and owns no element, so an effect keyed on the ref never re-runs
 * when the element finally appears — its marks would then be drawn against a 0×0 box
 * (zero-size badges) until something else happened to resize them. A callback ref
 * hands back the element itself, which is what the effect has to depend on.
 */
function useBoxSize(element: HTMLElement | null): {
  width: number;
  height: number;
} {
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (element === null) return;
    const measure = (): void => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      setBox((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return box;
}

export function MarkLayer({
  marks,
  minBadgePx,
  focusKey = null,
  editingKey = null,
  onSelect,
  inert = false,
  className,
}: MarkLayerProps): React.JSX.Element | null {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const box = useBoxSize(element);
  if (marks.length === 0) return null;
  const focused = focusKey ?? editingKey;
  return (
    <div
      ref={setElement}
      className={cls(
        "imb-mark-layer",
        inert && "imb-mark-layer-inert",
        focused !== null && "imb-mark-layer-focused",
        className,
      )}
    >
      {marks.map((view) => {
        const geometry = markGeometry(view.mark, box, minBadgePx);
        const dim = focused !== null && focused !== view.key;
        const focus = focused === view.key;
        const isRegion = view.mark.kind === "region";
        // The mark's origin: the marked point, or the rectangle's top-left. A
        // zero-size box — every child is then placed in **pixels** from here, so no
        // size is ever resolved against a percentage of nothing.
        const origin: CSSProperties = {
          left: `${(geometry.originX / Math.max(box.width, 1)) * 100}%`,
          top: `${(geometry.originY / Math.max(box.height, 1)) * 100}%`,
        };
        const badgeOffset = {
          left: `${geometry.badgeBox.left - geometry.originX}px`,
          top: `${geometry.badgeBox.top - geometry.originY}px`,
        };
        const target =
          view.historical === true
            ? "history"
            : view.mark.kind === "region"
              ? "region"
              : "point";
        return (
          <div
            key={view.key}
            className={cls(
              "imb-mark",
              `imb-mark-${target}`,
              dim && "imb-mark-dim",
              focus && "imb-mark-focus",
              editingKey === view.key && "imb-mark-editing",
            )}
            style={origin}
          >
            {isRegion && (
              <span
                className="imb-mark-region-box"
                style={
                  {
                    width: `${geometry.width}px`,
                    height: `${geometry.height}px`,
                    borderWidth: `${geometry.stroke}px`,
                    borderRadius: `${geometry.radius}px`,
                    "--imb-mark-fill": String(geometry.fill),
                  } as CSSProperties
                }
                // A very small area has a badge too small to aim at, so the rectangle
                // itself opens the editor (the mark must stay reachable at every size).
                onClick={
                  onSelect === undefined || inert
                    ? undefined
                    : (event) => {
                        event.stopPropagation();
                        onSelect(view.key);
                      }
                }
              />
            )}
            {!isRegion && (
              <span
                className="imb-mark-ring"
                style={{
                  // Centred on the origin by construction (no transform).
                  left: `${-geometry.pointRadius}px`,
                  top: `${-geometry.pointRadius}px`,
                  width: `${geometry.pointRadius * 2}px`,
                  height: `${geometry.pointRadius * 2}px`,
                  borderWidth: `${geometry.stroke}px`,
                }}
              />
            )}
            {view.historical !== true && (
              <span
                className="imb-mark-badge"
                style={{
                  left: badgeOffset.left,
                  top: badgeOffset.top,
                  width: `${geometry.badge}px`,
                  height: `${geometry.badge}px`,
                  fontSize: `${geometry.font}px`,
                  borderWidth: `${geometry.badgeRing}px`,
                }}
                // Inside this branch the mark is live (red, numbered); a historical
                // mark renders no badge at all, so it can never be pressed.
                role={inert || onSelect === undefined ? undefined : "button"}
                // Only the parts that exist, joined by ": " — a mark drawn but not
                // yet written has no note, and "1: " makes a screen reader say
                // "one colon". It reads as "1".
                aria-label={[
                  view.ordinal === undefined ? "" : String(view.ordinal),
                  view.note,
                ]
                  .filter((part) => part.length > 0)
                  .join(": ")}
                onPointerDown={
                  onSelect === undefined || inert
                    ? undefined
                    : (event) => {
                        // Keep the press from also starting a new mark underneath.
                        event.stopPropagation();
                      }
                }
                onClick={
                  onSelect === undefined || inert
                    ? undefined
                    : (event) => {
                        event.stopPropagation();
                        onSelect(view.key);
                      }
                }
              >
                {/* A badge smaller than a digit carries no number: two pixels of
                    glyph is noise, and the mark is still the badge + its box. */}
                {geometry.showNumber ? (view.ordinal ?? "") : ""}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
