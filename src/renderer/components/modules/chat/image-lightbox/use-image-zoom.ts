import { type RefObject, useCallback, useRef, useState } from "react";

/** Scale change of one zoom notch (a wheel tick or a key press). */
const ZOOM_STEP = 1.25;

/** `MIN_ZOOM` is "fitted to the viewer", the state the viewer opens in. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

/** Scale a double click jumps to; double clicking again goes back to fit. */
const DOUBLE_CLICK_ZOOM = 2.5;

export interface ZoomOffset {
  x: number;
  y: number;
}

export interface ImageZoom {
  /** Current scale; `1` while fitted. */
  scale: number;
  /** Pan offset in CSS pixels; zero while fitted. */
  offset: ZoomOffset;
  /** True while the picture is being dragged. */
  dragging: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Back to fitted and centred. */
  reset: () => void;
  /**
   * For `useWheelStep`: returns true when the gesture belongs to the zoom
   * (modifier held, or the picture is zoomed in and being moved around), so the
   * wheel only steps between pictures while the viewer is at its fit scale.
   */
  interceptWheel: (event: WheelEvent) => boolean;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onDoubleClick: (event: React.MouseEvent<HTMLElement>) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The element's layout box in viewport coordinates, with its own zoom taken
 * back out, so every calculation below works in unscaled space. The transform
 * scales about the element's centre, which therefore only moves by the pan
 * offset — the transformed rect alone cannot tell us where the box was.
 */
function layoutBox(
  element: HTMLElement,
  scale: number,
  offset: ZoomOffset,
): { width: number; height: number; centerX: number; centerY: number } {
  const rect = element.getBoundingClientRect();
  return {
    width: rect.width / scale,
    height: rect.height / scale,
    centerX: rect.left + rect.width / 2 - offset.x,
    centerY: rect.top + rect.height / 2 - offset.y,
  };
}

/** Stop the picture being dragged past its own edge. */
function clampOffset(
  box: { width: number; height: number },
  scale: number,
  offset: ZoomOffset,
): ZoomOffset {
  const maxX = (box.width * (scale - 1)) / 2;
  const maxY = (box.height * (scale - 1)) / 2;
  return {
    x: clamp(offset.x, -maxX, maxX),
    y: clamp(offset.y, -maxY, maxY),
  };
}

/**
 * The pan offset that keeps whatever sits under `focus` (viewport coordinates)
 * under it while the scale changes, so the wheel zooms at the pointer rather
 * than at the centre.
 */
function offsetFor(
  box: { centerX: number; centerY: number },
  scale: number,
  offset: ZoomOffset,
  next: number,
  focus: ZoomOffset,
): ZoomOffset {
  const ratio = next / scale;
  return {
    x: focus.x - box.centerX - (focus.x - box.centerX - offset.x) * ratio,
    y: focus.y - box.centerY - (focus.y - box.centerY - offset.y) * ratio,
  };
}

/**
 * Zoom and pan for the full-screen image viewer. The returned transform is
 * applied by the caller to the element `ref` points at (the picture's wrapper,
 * so the open animation on the image itself is left alone).
 *
 * Gestures: a modifier (Cmd/Ctrl, which is also how a trackpad pinch arrives)
 * with the wheel zooms at the pointer, a plain wheel moves around the picture
 * once it is zoomed in, dragging it does the same, double clicking jumps in and
 * out, and `+`/`-`/`0` are handled by the viewer's key handler.
 *
 * Disabled, every entry point does nothing and the element stays at its fit
 * scale, so a caller can keep the viewer's original switch-only behaviour.
 */
export function useImageZoom(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): ImageZoom {
  // The live values live in a ref as well: a burst of wheel events is handled
  // before React re-renders, and each one has to build on the last.
  const live = useRef<{ scale: number; offset: ZoomOffset }>({
    scale: MIN_ZOOM,
    offset: { x: 0, y: 0 },
  });
  const [view, setView] = useState(live.current);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    offset: ZoomOffset;
  } | null>(null);

  const apply = useCallback((scale: number, offset: ZoomOffset): void => {
    live.current = { scale, offset };
    setView(live.current);
  }, []);

  const zoomTo = useCallback(
    (next: number, focus?: ZoomOffset): void => {
      const element = ref.current;
      if (!enabled || !element) return;
      const { scale, offset } = live.current;
      const target = clamp(next, MIN_ZOOM, MAX_ZOOM);
      const box = layoutBox(element, scale, offset);
      const at = focus ?? { x: box.centerX, y: box.centerY };
      const moved = offsetFor(box, scale, offset, target, at);
      apply(
        target,
        target === MIN_ZOOM ? { x: 0, y: 0 } : clampOffset(box, target, moved),
      );
    },
    [apply, enabled, ref],
  );

  const zoomBy = useCallback(
    (factor: number, focus?: ZoomOffset): void => {
      zoomTo(live.current.scale * factor, focus);
    },
    [zoomTo],
  );

  const reset = useCallback((): void => {
    apply(MIN_ZOOM, { x: 0, y: 0 });
  }, [apply]);

  const zoomIn = useCallback((): void => zoomBy(ZOOM_STEP), [zoomBy]);
  const zoomOut = useCallback((): void => zoomBy(1 / ZOOM_STEP), [zoomBy]);

  const panBy = useCallback(
    (dx: number, dy: number): void => {
      const element = ref.current;
      if (!enabled || !element) return;
      const { scale, offset } = live.current;
      if (scale <= MIN_ZOOM) return;
      const box = layoutBox(element, scale, offset);
      apply(
        scale,
        clampOffset(box, scale, { x: offset.x + dx, y: offset.y + dy }),
      );
    },
    [apply, enabled, ref],
  );

  const interceptWheel = useCallback(
    (event: WheelEvent): boolean => {
      if (!enabled) return false;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      const delta = event.deltaY * unit;
      if (delta === 0) return false;
      if (event.ctrlKey || event.metaKey) {
        zoomBy(delta < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, {
          x: event.clientX,
          y: event.clientY,
        });
        return true;
      }
      if (live.current.scale > MIN_ZOOM) {
        if (event.shiftKey) panBy(-delta, 0);
        else panBy(0, -delta);
        return true;
      }
      return false;
    },
    [enabled, panBy, zoomBy],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      const element = ref.current;
      if (!enabled || !element || event.button !== 0) return;
      if (live.current.scale <= MIN_ZOOM) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      drag.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        offset: live.current.offset,
      };
      setDragging(true);
    },
    [enabled, ref],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      const start = drag.current;
      const element = ref.current;
      if (!start || start.pointerId !== event.pointerId || !element) return;
      const { scale } = live.current;
      const box = layoutBox(element, scale, live.current.offset);
      apply(
        scale,
        clampOffset(box, scale, {
          x: start.offset.x + (event.clientX - start.x),
          y: start.offset.y + (event.clientY - start.y),
        }),
      );
    },
    [apply, ref],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>): void => {
      const element = ref.current;
      if (!drag.current || drag.current.pointerId !== event.pointerId) return;
      drag.current = null;
      setDragging(false);
      if (element?.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
    },
    [ref],
  );

  const onDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>): void => {
      if (!enabled) return;
      if (live.current.scale > MIN_ZOOM) reset();
      else zoomTo(DOUBLE_CLICK_ZOOM, { x: event.clientX, y: event.clientY });
    },
    [enabled, reset, zoomTo],
  );

  return {
    scale: view.scale,
    offset: view.offset,
    dragging,
    zoomIn,
    zoomOut,
    reset,
    interceptWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
  };
}
