import { type RefObject, useEffect, useRef } from "react";

/** Accumulated wheel travel (px) that counts as one step. */
const STEP_PX = 50;

/**
 * Minimum gap (ms) between two steps. Trackpads emit a burst of events (plus
 * momentum) for a single gesture; the gap keeps one flick from racing through
 * every item.
 */
const COOLDOWN_MS = 200;

/**
 * Turn wheel gestures over `ref`'s element into discrete steps. React registers
 * `onWheel` passively, so the listener is attached natively to be able to stop
 * the surrounding scroll container from scrolling underneath. `onStep` is
 * called with `1` for wheel-down and `-1` for wheel-up, at most once per
 * cooldown; the latest callback is always used without re-binding.
 *
 * `intercept`, when given, is asked first and can claim a gesture (e.g. the
 * image viewer's zoom): returning true swallows it, so it neither steps nor
 * reaches the page behind. The latest callback is used here too.
 */
export function useWheelStep(
  ref: RefObject<HTMLElement | null>,
  onStep: (direction: 1 | -1) => void,
  enabled = true,
  intercept?: (event: WheelEvent) => boolean,
): void {
  const handler = useRef(onStep);
  handler.current = onStep;
  const interceptor = useRef(intercept);
  interceptor.current = intercept;

  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    let accum = 0;
    let last = 0;
    const onWheel = (event: WheelEvent): void => {
      if (interceptor.current?.(event)) {
        event.preventDefault();
        return;
      }
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      const delta = event.deltaY * unit;
      if (delta === 0) return;
      // Own the gesture while the pointer is over the element.
      event.preventDefault();
      const now = Date.now();
      if (now - last < COOLDOWN_MS) return;
      accum += delta;
      if (Math.abs(accum) < STEP_PX) return;
      const direction = accum > 0 ? 1 : -1;
      accum = 0;
      last = now;
      handler.current(direction);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [ref, enabled]);
}
