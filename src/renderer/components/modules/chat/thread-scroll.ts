/**
 * Thread scroll + landing-flash helpers shared by the interactive chat module,
 * the read-only group-chat module and in-thread find.
 *
 * Everything here is imperative DOM work on the thread's scroll container: the
 * owning module keeps its own "pinned to the bottom" flag and scroll store, and
 * wires them in through `beforeScroll` — a programmatic scroll emits `scroll`,
 * which re-syncs those from the resulting position anyway.
 */

/** Distance from the bottom (px) still considered "pinned" for auto-scroll. */
export const PIN_THRESHOLD = 32;

/** Landing-flash duration (ms); mirrors the `imb-quote-flash` keyframe. */
export const FLASH_MS = 700;

/** True when the user asked the OS for reduced motion. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

let flashSeq = 0;

/**
 * Briefly outline the row a jump landed on. Pure DOM (a `data-`attribute read by
 * `thread.css`) so nothing re-renders and nothing shifts; skipped entirely when
 * the user asked for reduced motion.
 */
export function flashRow(row: HTMLElement): void {
  if (prefersReducedMotion()) return;
  const token = String(++flashSeq);
  let timer = 0;
  const clear = (): void => {
    window.clearTimeout(timer);
    row.removeEventListener("animationend", clear);
    // A newer flash may own the attribute by now.
    if (row.dataset.quoteTarget === token) delete row.dataset.quoteTarget;
  };
  // Drop and re-add the attribute (with a reflow) so a repeated jump restarts
  // the keyframe instead of continuing a finished one.
  delete row.dataset.quoteTarget;
  void row.offsetWidth;
  row.dataset.quoteTarget = token;
  row.addEventListener("animationend", clear);
  // Defensive: `animationend` never fires if the row is detached mid-animation.
  timer = window.setTimeout(clear, FLASH_MS + 300);
}

/**
 * Where a jump lands: the target's top line under `topGap`, or the target
 * vertically centered in the thread.
 */
export type ThreadAlign = "top" | "center";

/** A viewport rect to land on: a row's, or a text range's. */
export interface ThreadRect {
  top: number;
  height: number;
}

export interface ThreadScrollOptions {
  /**
   * Distance (px) between the thread's top edge and the landing line. Only used
   * by `align: "top"` (the default); centering ignores it.
   */
  topGap?: number;
  /**
   * Landing line (default `"top"`). `"center"` puts the target's middle on the
   * thread's middle, so a slice of the older context above it stays visible —
   * used by the new-messages jump, which is meant to be read forwards from
   * there. A target taller than the thread degrades to `"top"`: centering it
   * would push its beginning above the fold.
   */
  align?: ThreadAlign;
  /**
   * Called with the computed `scrollTop` right before scrolling, so the owning
   * module can drop its "pinned to the bottom" state and record the position.
   * Never called when the target is already showing (nothing scrolls then).
   */
  beforeScroll?: (targetTop: number) => void;
  /** Row to flash once the scroll settles; omit for a silent jump. */
  flash?: HTMLElement | null;
  /**
   * Scroll without animating. Used for a burst of jumps (a held Enter / ⌘G):
   * each new smooth scroll would restart from the current, still-moving
   * position, so the view would fall behind the cursor by several matches.
   * The landing row flashes immediately (it is already in place).
   */
  instant?: boolean;
}

/**
 * Scroll the thread so `rect` lands on the landing line — `topGap` px below the
 * thread's own top edge, or (with `align: "center"`) vertically centered
 * (clamped to the scrollable range). `rect` is a viewport rect — a row's or a
 * text range's, so a match inside a very long message still lands on the right
 * line.
 *
 * The thread itself is scrolled (`scrollTo`, never `scrollIntoView`, which can
 * scroll ancestors as well).
 */
export function scrollThreadToRect(
  thread: HTMLElement,
  rect: ThreadRect,
  options: ThreadScrollOptions,
): void {
  const maxScroll = Math.max(thread.scrollHeight - thread.clientHeight, 0);
  // Target's top edge in scroll coordinates.
  const rowTop =
    rect.top - thread.getBoundingClientRect().top + thread.scrollTop;
  const topGap = options.topGap ?? 0;
  const desired =
    options.align === "center" && rect.height < thread.clientHeight
      ? rowTop - (thread.clientHeight - rect.height) / 2
      : rowTop - topGap;
  const target = Math.min(Math.max(desired, 0), maxScroll);

  if (Math.abs(target - thread.scrollTop) <= 1) {
    // Nothing to scroll (already there): still show where it is.
    if (options.flash != null) flashRow(options.flash);
    return;
  }

  options.beforeScroll?.(target);
  const animated = !prefersReducedMotion() && options.instant !== true;
  thread.scrollTo({ top: target, behavior: animated ? "smooth" : "auto" });
  const flash = options.flash ?? null;
  if (flash === null) return;
  if (!animated) {
    // Already there: nothing to wait for (`flashRow` no-ops under reduced
    // motion by itself).
    flashRow(flash);
    return;
  }
  // Flash on arrival rather than on click, otherwise the ring can finish before
  // the target is on screen. `scrollend` is the accurate signal; the timer is
  // the fallback for the (rare) case it never fires.
  let done = false;
  let timer = 0;
  const flashOnArrival = (): void => {
    if (done) return;
    done = true;
    thread.removeEventListener("scrollend", flashOnArrival);
    window.clearTimeout(timer);
    flashRow(flash);
  };
  thread.addEventListener("scrollend", flashOnArrival);
  timer = window.setTimeout(flashOnArrival, FLASH_MS);
}

/** Convenience wrapper: land on a message row (a `.imb-msg` element). */
export function scrollThreadToRow(
  thread: HTMLElement,
  row: HTMLElement,
  options: ThreadScrollOptions,
): void {
  scrollThreadToRect(thread, row.getBoundingClientRect(), options);
}
