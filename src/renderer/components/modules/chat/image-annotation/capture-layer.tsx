/**
 * The drawing surface of the lightbox's annotation mode: a transparent layer over
 * the picture that turns a click into a point and a drag into a region.
 *
 * It only *captures* geometry. The note is written afterwards, in the panel, and
 * the mark is committed (or dropped) from there — so an abandoned mark never
 * enters the batch and never takes an ordinal.
 *
 * The one gesture it must not steal is panning, which used to be a plain drag.
 * In this mode panning is `Space` + drag, which the lightbox checks and then lets
 * through to its own pan handling; everything else is drawing.
 */
import { CLICK_JITTER_PX } from "@shared/constants/image-annotation";
import { roundCoord } from "@shared/image-annotation";
import type { ImageMark } from "@shared/types";
import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./index.css";

/** Keep a point this far inside the picture (fraction of each edge). */
const EDGE_INSET = 0.005;

export interface CaptureLayerProps {
  /** Pixel size of the picture being annotated (drift + slop). */
  naturalWidth: number;
  naturalHeight: number;
  /** `Space` is held: this press belongs to panning, not to drawing. */
  panning: boolean;
  /** A finished mark: a point, or a region with canonical corners. */
  onCommit: (mark: ImageMark) => void;
}

interface DragState {
  /** Normalized start point. */
  x: number;
  y: number;
  /** Current pointer position, normalized. */
  cx: number;
  cy: number;
  /** Where the press started, in client px — the click/drag decision uses this. */
  startClientX: number;
  startClientY: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Keep a point inside the picture (a mark on the frame is a bug, not a mark). */
const inset = (value: number): number =>
  Math.min(1 - EDGE_INSET, Math.max(EDGE_INSET, value));

export function CaptureLayer({
  naturalWidth,
  naturalHeight,
  panning,
  onCommit,
}: CaptureLayerProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  /** Pointer position as normalized coordinates of the picture. */
  const at = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): { x: number; y: number } | null => {
    const element = ref.current;
    if (element === null) return null;
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    return {
      x: clamp01((event.clientX - box.left) / box.width),
      y: clamp01((event.clientY - box.top) / box.height),
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (panning) return;
    // A non-primary press belongs to the viewer's pan (right-drag, macOS ctrl+click):
    // fall through **without** stopping propagation, so the frame's handler gets it.
    // Otherwise "I want to pan while annotating" would paint a mark instead.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.ctrlKey) return;
    const point = at(event);
    if (point === null) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Best-effort; drawing still works without pointer capture.
    }
    setDrag({
      x: point.x,
      y: point.y,
      cx: point.x,
      cy: point.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
    });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag === null || panning) return;
    const point = at(event);
    if (point === null) return;
    event.stopPropagation();
    setDrag({ ...drag, cx: point.x, cy: point.y });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag === null || panning) return;
    const point = at(event) ?? { x: drag.cx, y: drag.cy };
    event.stopPropagation();
    setDrag(null);
    // Click vs drag is decided by **pointer travel in screen px**: a click jitters by
    // a pixel or two, and anything past that is a deliberate drag. Basing it on image
    // pixels made the same gesture mean different things at different zoom levels, and
    // it silently turned small areas into points — the boss draws it, so it is an area.
    const travel = Math.hypot(
      event.clientX - drag.startClientX,
      event.clientY - drag.startClientY,
    );
    if (travel <= CLICK_JITTER_PX) {
      // A click: the point is where the finger let go (dragging away and back
      // means the boss settled on the release spot).
      onCommit({
        kind: "point",
        x: roundCoord(inset(point.x)),
        y: roundCoord(inset(point.y)),
        imageWidth: naturalWidth,
        imageHeight: naturalHeight,
      });
      return;
    }
    onCommit({
      kind: "region",
      x: roundCoord(Math.min(drag.x, point.x)),
      y: roundCoord(Math.min(drag.y, point.y)),
      x2: roundCoord(Math.max(drag.x, point.x)),
      y2: roundCoord(Math.max(drag.y, point.y)),
      imageWidth: naturalWidth,
      imageHeight: naturalHeight,
    });
  };

  const preview =
    drag === null
      ? null
      : {
          left: `${Math.min(drag.x, drag.cx) * 100}%`,
          top: `${Math.min(drag.y, drag.cy) * 100}%`,
          width: `${Math.abs(drag.cx - drag.x) * 100}%`,
          height: `${Math.abs(drag.cy - drag.y) * 100}%`,
        };

  return (
    <div
      ref={ref}
      className="imb-annot-capture"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      {preview !== null && (
        <span className="imb-annot-capture-rect" style={preview} />
      )}
    </div>
  );
}
