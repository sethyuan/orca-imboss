import {
  BADGE_MIN_BAKE_PX,
  BADGE_MIN_SCREEN_PX,
  CLICK_JITTER_PX,
} from "@shared/constants/image-annotation";
import { t } from "@shared/l10n";
import type { ImageMark } from "@shared/types";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { cls } from "reactutils";
import { IconChevronDown, IconFolder, IconX } from "../../../icons";
import { CaptureLayer } from "../image-annotation/capture-layer";
import { AnnotationBanner, AnnotationList } from "../image-annotation/chrome";
import { markGeometry } from "../image-annotation/geometry";
import { MarkLayer, type MarkView } from "../image-annotation/marks-layer";
import { AnnotationPanel } from "../image-annotation/panel";
import "./index.css";

export interface LightboxImage {
  name: string;
  src: string;
  /**
   * Marks to draw on this picture (already resolved by the caller). Present only
   * for a picture that can be annotated — see {@link LightboxAnnotation}.
   */
  marks?: readonly MarkView[];
}

/**
 * Annotation, as the viewer needs it. Absent ⇒ the viewer offers no annotation at
 * all (a generated picture, a picture whose owner cannot take one).
 *
 * The viewer owns the *interaction* (mode, gestures, editor, list); the caller
 * owns the *data* — where a mark is stored, and what a new one becomes. That split
 * keeps the draft batch (composer chips) and the already-sent pictures on the same
 * UI while their storage differs.
 */
export interface LightboxAnnotation {
  /** Annotations waiting in the composer, text ones included (banner total). */
  batchCount: number;
  /**
   * Whether the picture at `imageIndex` takes new marks right now.
   *
   * Per picture, not per viewer: a stack can hold a copy this app already baked
   * (which takes none — its marks are pixels) next to a picture that does. The
   * action is simply absent for the former.
   */
  canAnnotate: (imageIndex: number) => boolean;
  /** Why not, shown on the disabled action. */
  unavailableReason?: string;
  /**
   * Open with annotation mode already on. Used by the composer chip's hover action:
   * annotating the picture you are about to send is the hot path, so it must not cost
   * "open the viewer, then find the button" (decision ①).
   */
  autoStart?: boolean;
  /** Commit a new mark (the note is required; it arrives with the save). */
  onCreate: (imageIndex: number, mark: ImageMark, note: string) => void;
  /** Replace one existing mark's note (its geometry never moves). */
  onEditNote: (imageIndex: number, key: string, note: string) => void;
  /** Drop one mark of this batch. */
  onRemove: (imageIndex: number, key: string) => void;
  /**
   * Called when a mark is clicked on the picture: the caller may open the thread
   * context it belongs to. Omitted in the lightbox (the list does that job).
   */
  onOpenMark?: (imageIndex: number, key: string) => void;
}

export interface ImageLightboxProps {
  images: LightboxImage[];
  /** Index of the shown image within `images`. */
  index: number;
  /**
   * Screen rect of the thumbnail this viewer opened from. Drives the open
   * animation, which grows the image out of that box. Omitted (e.g. opened
   * without a thumbnail) the viewer just fades in.
   */
  origin?: DOMRect | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /**
   * Reveal the shown picture in the OS file manager. The callback *is* the
   * caller's proof that a trustworthy on-disk location exists for it (main
   * resolves the path from the stored record), so omitting it — the composer's
   * draft previews, which have no stored message behind them — simply hides the
   * button.
   */
  onReveal?: () => void | Promise<void>;
  /** Annotation support; omitted ⇒ no annotation UI at all. */
  annotation?: LightboxAnnotation;
}

/** Duration of the open transform animation (the backdrop fades via CSS). */
const OPEN_MS = 280;

/**
 * Beat between the end of the open animation and the hand-over to the
 * full-resolution copy, so the two never overlap.
 */
const CRISP_DELAY_MS = 80;

/**
 * How long a picture is shown before its original pixels may be handed over:
 * the open animation plus a small margin. Deliberately a fixed beat rather than
 * "the FLIP has finished", so the hand-over keeps its own beat even when the
 * open animation could not run at all (the picture was still decoding when the
 * viewer mounted) — that case used to hand over *inside* the entrance fade,
 * which read as the picture flashing twice.
 */
const HAND_OVER_DELAY_MS = OPEN_MS + CRISP_DELAY_MS;

/**
 * Fade-in duration of the full-resolution copy. Must stay equal to the CSS
 * `--imb-motion-fast` that `.imb-lightbox-image-full` transitions on: the fitted
 * copy is dropped right after it, and dropping it early would expose the
 * backdrop for a frame.
 */
const FADE_MS = 100;

/** Fitted (neutral) state: the picture at `1×`, fully visible and centred. */
interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

const FIT: ZoomState = { scale: 1, x: 0, y: 0 };

/**
 * The fitted baseline (`1×`, the picture exactly as the layout fits it).
 * `FIT`, `0`, the Esc step-back and "double-click to reset" all return here —
 * it is the *neutral* scale, not the smallest one.
 */
const FIT_ZOOM = 1;

/**
 * Zoom range, both ends expressed on top of the fitted baseline: `0.5×` shrinks
 * so more can be taken in at once, and the upper end is derived from
 * {@link MAX_ABS_ZOOM} below.
 */
const MIN_ZOOM = 0.5;

/**
 * Largest *absolute* magnification: `1` is the picture's own pixels (one image
 * pixel per CSS pixel), `4` is 400%. The fitted baseline is usually far below
 * `1` (a 5000px-wide screenshot fits at ~0.26), so the relative upper bound has
 * to be derived from the fitted scale — a fixed `4× fit` cap would stop well
 * short of the original pixels and look blurry for exactly the pictures the
 * boss zooms into.
 */
const MAX_ABS_ZOOM = 4;

/**
 * Relative upper bound while the picture is painted from a *downsampled* copy
 * (over the pixel budget): magnifying that copy further only shows mush, so the
 * cap stays where it was before full-resolution rendering existed.
 */
const DEGRADED_MAX_ZOOM = 4;

/**
 * Pixel budget for rendering the picture at its natural size. A copy this large
 * still decodes to a sane RGBA bitmap (~256 MB at 64 MP); past it the viewer
 * keeps the fitted-size decode and says so, instead of risking an out-of-memory
 * on a panorama.
 */
const MAX_CRISP_PIXELS = 64 * 1024 * 1024;

/** Double-click target (on top of the fitted baseline), and the `+` / `-` step. */
const DOUBLE_CLICK_ZOOM = 2;
const KEY_ZOOM_FACTOR = 1.25;

/**
 * Wheel → zoom sensitivity. `Math.exp(-delta * k)` makes one mouse notch
 * (~100px) about ±20% and keeps trackpad pinches (many small deltas) smooth.
 */
const WHEEL_ZOOM_SPEED = 0.002;

/** A live pan (one pointer) or pinch (two pointers) gesture. */
type Gesture =
  | {
      kind: "pan";
      pointerId: number;
      startX: number;
      startY: number;
      originX: number;
      originY: number;
    }
  | {
      kind: "pinch";
      ids: [number, number];
      startDistance: number;
      startScale: number;
      startMidX: number;
      startMidY: number;
      startX: number;
      startY: number;
    };

/**
 * Intrinsic size of one picture plus the fitted box measured for it.
 *
 * The viewer used to lay the picture out at the fitted size, which also pinned
 * Chromium's *decode* to that size — magnifying it then scaled an already
 * downsampled bitmap, so the boss never got to the real pixels. Now the fitted
 * box is a fixed frame and the picture inside it is laid out at its natural
 * size and scaled down (`scale`): the decode is the original, and `1×` on the
 * zoom axis above the fitted baseline is a real 1 image px : 1 CSS px.
 */
interface FitBox {
  /** `images` index the measurement belongs to. */
  index: number;
  naturalWidth: number;
  naturalHeight: number;
  /** Natural size → fitted box. `1` when the picture already fits as-is. */
  scale: number;
  /** The fitted box in CSS px — the box the zoom/pan transform lives on. */
  width: number;
  height: number;
  /** Natural pixel count over `MAX_CRISP_PIXELS`: keep the fitted decode. */
  overBudget: boolean;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * The viewer's motion is token-driven (`--imb-dur-*` collapse to `1ms` under
 * `prefers-reduced-motion`), but the open animation's transform transition and
 * the hand-over beat are JS timers. This is the one place the JS side asks the
 * same question, so a reduced-motion user gets a single, instant reveal instead
 * of "instant picture, then a swap 360ms later".
 */
const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Is the key event going to a text field? Space is annotation mode's pan modifier,
 * and swallowing it globally would make a space impossible to type in the note
 * editor that mode opens.
 */
/**
 * How much of the picture must stay inside the window after a **zoom**.
 *
 * Free panning is the boss's call, so this is deliberately tiny: it only fires when a
 * zoom would leave the picture entirely outside the picture area (which can only happen
 * after panning it out), and it moves it back by the smallest amount that puts this many
 * pixels back on screen. Panning never calls it.
 */
const KEEP_IN_REACH_PX = 24;

/**
 * Is this press the "pan" one? The right button, or macOS's ctrl+click (which the OS
 * reports as a primary press with `ctrlKey` — treating it as a draw press is what made
 * "ctrl+click to pan" paint a mark instead).
 */
function isPanPress(event: {
  button: number;
  ctrlKey: boolean;
  pointerType: string;
}): boolean {
  if (event.button === 2 || event.button === 1) return true;
  return event.button === 0 && event.ctrlKey;
}

function isEditingText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable === true
  );
}

/**
 * True at the neutral framing: `1×` and centred (so a *shrunk* picture is not
 * fitted — Esc steps it back up to `1×` instead of closing).
 */
const isFitted = (zoom: ZoomState): boolean =>
  zoom.scale === FIT_ZOOM && zoom.x === 0 && zoom.y === 0;

/**
 * Full-screen image viewer shared by the in-chat attachment previews
 * (`image-stack/`) and the composer's attachment thumbnails
 * (`chat-input-bar/`). Rendered into `document.body` so it escapes any
 * stacking context.
 *
 * Resolution: the picture is painted twice. A fitted-size copy appears first
 * (cheap decode, and the element the open animation grows out of the
 * thumbnail); once that has loaded, the fitted box is measured and a second copy
 * laid out at the picture's natural size fades in *on top of* it (the fitted copy
 * never fades out — see `HAND_OVER_DELAY_MS`), after which the fitted one is
 * dropped. Zooming therefore magnifies the original pixels, not a resized
 * preview. A picture over `MAX_CRISP_PIXELS` skips the second copy (memory) and
 * says it is downsampled.
 *
 * Gestures: the wheel zooms about the pointer (a trackpad pinch arrives as the
 * same wheel path) within `0.5×` of the fitted size up to 400% of the original
 * pixels, double-click toggles the neutral framing / `2×`, `+` `-` `0` zoom in
 * place and reset, and a drag pans the picture at *any* scale.
 *
 * Panning is **free** (no bounds): the picture may be pushed past the window's edges,
 * which is how a detail near its border gets to the middle of the screen. `0` and the
 * Esc ladder's "step back to the fitted framing" remain the way home. A mouse pans with
 * the **right button** as well as a left drag — in annotation mode the left button draws,
 * so the right one is that mode's pan (and macOS's ctrl+click, which arrives as a primary
 * press with `ctrlKey`, counts as the right button; the frame suppresses the native
 * context menu so releasing a right-drag opens nothing). Arrow keys / the on-screen arrows (with the `n / m` counter) step
 * between images — the wheel no longer does. A click on the backdrop closes;
 * Esc undoes a zoom/pan first and closes on the second press. Switching images
 * always resets the framing, so one picture's zoom can never leak into another's.
 */
export function ImageLightbox({
  images,
  index,
  origin,
  onIndexChange,
  onClose,
  onReveal,
  annotation,
}: ImageLightboxProps): React.JSX.Element | null {
  const count = images.length;
  const closeRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  /** The fitted box the zoom/pan transform lives on (measured, never scaled). */
  const frameRef = useRef<HTMLDivElement>(null);
  /** The fitted-size copy, and the element the open animation drives. */
  const fittedRef = useRef<HTMLImageElement>(null);
  /** The full-resolution copy painted from the picture's own pixels. */
  const fullRef = useRef<HTMLImageElement>(null);

  const [zoom, setZoomState] = useState<ZoomState>(FIT);
  /** Mirrors `zoom` for listeners and gestures (never re-bound per frame). */
  const zoomRef = useRef<ZoomState>(FIT);
  /** A pan/pinch is running (drives the cursor). */
  const [grabbing, setGrabbing] = useState(false);
  /** Live pointers, keyed by `pointerId` (one = pan, two = pinch). */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);

  /** Intrinsic size of the loaded fitted copy, keyed by image. */
  const [loaded, setLoaded] = useState<{
    index: number;
    width: number;
    height: number;
  } | null>(null);
  /** Measured fitted box, keyed by image (a switch invalidates it). */
  const [fitState, setFitState] = useState<FitBox | null>(null);
  const fit = fitState !== null && fitState.index === index ? fitState : null;
  /** The full-resolution copy has finished loading. */
  const [hiLoaded, setHiLoaded] = useState<{ index: number } | null>(null);
  /**
   * The shown picture has had its own beat (open animation, entrance fade)
   * before the original pixels may fade in over it. Handing over earlier would
   * fade a half-transparent copy over a half-transparent copy, which composites
   * to a *dimmer* picture for the length of the fade — the "blink" this viewer
   * used to show when it opened. Reduced motion has nothing to wait for.
   */
  const [handOverReady, setHandOverReady] = useState(prefersReducedMotion);
  /** The fitted copy can be dropped once the original pixels are fully up. */
  const [fittedGone, setFittedGone] = useState<{ index: number } | null>(null);

  /** A reveal request is in flight (the button is disabled meanwhile). */
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<{
    index: number;
    message: string;
  } | null>(null);

  /** Annotation mode: click marks a point, drag marks a region. */
  /** Where a press on the backdrop started (a release without travel closes). */
  const backdropPress = useRef<{ x: number; y: number } | null>(null);
  const [annotating, setAnnotating] = useState(annotation?.autoStart === true);
  /** "Model view": the marks as they will be baked, no editing, no side list. */
  const [modelView, setModelView] = useState(false);
  /** `Space` held: the press pans instead of drawing. */
  const [spaceHeld, setSpaceHeld] = useState(false);
  /** A fresh mark waiting for its note (not yet in the batch). */
  const [draft, setDraft] = useState<ImageMark | null>(null);
  /** Key of an existing mark whose note is being edited. */
  const [editingKey, setEditingKey] = useState<string | null>(null);
  /** Key of the mark hovered from the side list. */
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const fitScale = fit?.scale ?? 1;
  const degraded = fit?.overBudget ?? false;
  const crisp = fit !== null && hiLoaded?.index === index && handOverReady;
  // The fitted copy is dropped once the original pixels are up — but it is also
  // what the fitted box is measured from, so it comes back whenever the shown
  // picture has no measurement of its own (e.g. flipping back to a picture whose
  // measurement was replaced by the one in between).
  const showFitted = fit === null || fittedGone?.index !== index || annotating;
  const maxZoom = degraded
    ? DEGRADED_MAX_ZOOM
    : Math.max(DEGRADED_MAX_ZOOM, MAX_ABS_ZOOM / fitScale);
  /** Absolute magnification, in the same unit Preview.app uses for "100%". */
  const percent = Math.round(zoom.scale * fitScale * 100);
  const error = revealError?.index === index ? revealError.message : null;
  /** The boss may add marks to the picture on screen (and the batch has room). */
  const canAnnotate =
    annotation === undefined ? false : annotation.canAnnotate(index);

  const current = images[index];
  /**
   * Next ordinal for a fresh mark: the batch is numbered by position, so a mark
   * being written is the one *after* the last stored one.
   */
  const nextOrdinal = (annotation?.batchCount ?? 0) + 1;
  /**
   * Marks of the shown picture, in the register the mode dictates: live red with
   * their ordinals, as the batch has them. (`historical` marks are prepared by the
   * caller — they carry no ordinal and draw grey.)
   */
  const marks = useMemo<readonly MarkView[]>(
    () => (annotation === undefined ? [] : (current?.marks ?? [])),
    [annotation, current],
  );
  /**
   * What is painted: the batch's marks, plus the one just drawn.
   *
   * The draft mark is drawn immediately (with the ordinal it is about to take) so
   * the boss sees the geometry they made while writing the note — the note is what
   * turns it into an annotation, the position is already theirs.
   */
  const liveMarks = useMemo<readonly MarkView[]>(() => {
    if (draft === null) return marks;
    return [
      ...marks,
      { key: "draft", mark: draft, ordinal: nextOrdinal, note: "" },
    ];
  }, [draft, marks, nextOrdinal]);
  /**
   * The badge floor, in the box's CSS px.
   *
   * Screen: a badge smaller than this cannot be clicked. Model view: the floor the
   * **bake** uses, converted to the displayed scale — which is exactly the point
   * of that view: it shows the delivered picture's proportions rather than the
   * screen's minimums.
   */
  const minBadgePx =
    modelView && fit !== null
      ? BADGE_MIN_BAKE_PX * fitScale
      : BADGE_MIN_SCREEN_PX;
  /** The mark whose editor is open (a draft one has no key yet). */
  const editingMark =
    editingKey === null
      ? null
      : (marks.find((view) => view.key === editingKey) ?? null);
  const showPanel =
    annotation !== undefined && (draft !== null || editingMark !== null);
  const panelMark = draft ?? editingMark?.mark ?? null;
  /**
   * Where the editor card hangs from: the mark's **screen** box, measured from the
   * zoom frame (which is transformed, so its rect is the displayed one). The card
   * then places itself to the right/left/below/above of that box and never covers
   * the mark.
   */
  const panelAnchor = (() => {
    if (panelMark === null) return null;
    const frame = frameRef.current;
    if (frame === null) return null;
    const box = frame.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    const geometry = markGeometry(
      panelMark,
      { width: box.width, height: box.height },
      minBadgePx,
    );
    // The badge's own box is the anchor: it is never bigger than the mark and it is
    // where the boss's eye already is.
    return {
      left: box.left + geometry.badgeBox.left,
      top: box.top + geometry.badgeBox.top,
      width: Math.max(geometry.badgeBox.width, 1),
      height: Math.max(geometry.badgeBox.height, 1),
    };
  })();
  const panelOrdinal =
    draft !== null ? nextOrdinal : (editingMark?.ordinal ?? 0);

  // Leaving the picture (or the mode) drops an unfinished mark: it was never in
  // the batch, so there is nothing to keep.
  useEffect(() => {
    setDraft(null);
    setEditingKey(null);
    setHoverKey(null);
  }, [index, annotating, modelView]);

  const commitZoom = useCallback((next: ZoomState): void => {
    zoomRef.current = next;
    setZoomState(next);
  }, []);

  /**
   * Layout-space centre of the picture, in client coordinates. Read from
   * `offset*` (layout, unaffected by the transform) so it stays correct while
   * the picture is zoomed/panned and while the FLIP open animation runs. The
   * caption sits under the picture, so this is *not* the window centre — the
   * clamp and the zoom anchor must use the picture's own box.
   */
  const imageCenter = useCallback((): { x: number; y: number } | null => {
    const frame = frameRef.current;
    const overlay = overlayRef.current;
    if (!frame || !overlay) return null;
    const box = overlay.getBoundingClientRect();
    if (frame.offsetParent !== overlay) {
      // Defensive: offset* would be relative to something else.
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    return {
      x: box.left + frame.offsetLeft + frame.offsetWidth / 2,
      y: box.top + frame.offsetTop + frame.offsetHeight / 2,
    };
  }, []);

  /**
   * Clamp a pan offset so the picture can always be dragged (at any scale)
   * without ever being lost:
   *
   * - smaller than the window → it may be nudged anywhere that keeps it *fully
   *   visible*, i.e. up to a corner but never past an edge;
   * - larger than the window → it may be moved as far as it can go while still
   *   covering the window, so no blank gap ever shows through.
   *
   * Both regimes are the same pair of bounds once solved against the picture's
   * own centre (they just swap which one is the minimum), which is also why
   * panning works at 1× — and why a shrunk picture (scale < 1) stays fully
   * visible and yet freely movable: the same formula covers every scale in
   * `[MIN_ZOOM, maxZoom]`.
   *
   * `offsetWidth/Height` is the *fitted* box, which is what the transform
   * scales, so the formula is unchanged by rendering the picture at its natural
   * size inside it.
   */

  /**
   * Zoom to `nextScale`, keeping whatever sits under `(clientX, clientY)` in
   * place — the picture grows away from the pointer instead of the centre.
   */
  /**
   * Nudge a zoom result so the picture cannot end up completely off screen.
   *
   * Only ever called from {@link zoomAt}: panning is free (the boss drags a border
   * detail to the middle), but a zoom must not be able to lose the picture — `0`/`Esc`
   * is the only way home and it should not be the *only* thing keeping it findable.
   */
  const keepInReach = useCallback(
    (scale: number, x: number, y: number): { x: number; y: number } => {
      const frame = frameRef.current;
      const overlay = overlayRef.current;
      if (!frame || !overlay) return { x, y };
      const width = frame.offsetWidth * scale;
      const height = frame.offsetHeight * scale;
      if (width <= 0 || height <= 0) return { x, y };
      const center = imageCenter();
      if (!center) return { x, y };
      const box = overlay.getBoundingClientRect();
      // Where the picture's box sits, relative to the window.
      const left = center.x + x - width / 2 - box.left;
      const top = center.y + y - height / 2 - box.top;
      const right = left + width;
      const bottom = top + height;
      const reach = Math.min(KEEP_IN_REACH_PX, width, height);
      let dx = 0;
      let dy = 0;
      if (right < reach) dx = reach - right;
      else if (left > overlay.clientWidth - reach) {
        dx = overlay.clientWidth - reach - left;
      }
      if (bottom < reach) dy = reach - bottom;
      else if (top > overlay.clientHeight - reach) {
        dy = overlay.clientHeight - reach - top;
      }
      return { x: x + dx, y: y + dy };
    },
    [imageCenter],
  );

  const zoomAt = useCallback(
    (nextScale: number, clientX: number, clientY: number): void => {
      const current = zoomRef.current;
      const scale = clamp(nextScale, MIN_ZOOM, maxZoom);
      if (Math.abs(scale - current.scale) < 0.001) return;
      const center = imageCenter();
      if (!center) return;
      const ratio = scale / current.scale;
      const centerX = center.x + current.x;
      const centerY = center.y + current.y;
      // Panning itself has **no bounds** (see the class doc): the picture may be pushed
      // past the window's edges so a detail near its border can be brought to the middle.
      // Zooming, though, never strands it: with the anchor at the viewport centre, zooming
      // a picture that is already off screen would push it further away, and the boss's
      // only way back is `0`/Esc — so a zoom that would leave *nothing* visible is nudged
      // just enough to keep a sliver in reach.
      const next = keepInReach(
        scale,
        clientX - (clientX - centerX) * ratio - center.x,
        clientY - (clientY - centerY) * ratio - center.y,
      );
      commitZoom({ scale, ...next });
    },
    [commitZoom, imageCenter, keepInReach, maxZoom],
  );

  /**
   * Zoom in/out (`+` / `-` keys) anchored on the picture's own centre, so the
   * keyboard zooms in place instead of dragging the picture towards the window
   * centre — which matters once it has been panned.
   */
  const zoomFromCenter = useCallback(
    (nextScale: number): void => {
      // Anchored on the **viewport**, not on the picture: with a free pan the picture's
      // own centre can be off screen, and `+`/`-` must act on what is visible.
      const overlay = overlayRef.current;
      if (!overlay) return;
      const box = overlay.getBoundingClientRect();
      zoomAt(nextScale, box.left + box.width / 2, box.top + box.height / 2);
    },
    [zoomAt],
  );

  const resetZoom = useCallback((): void => {
    if (isFitted(zoomRef.current)) return;
    commitZoom(FIT);
  }, [commitZoom]);

  /**
   * Show another image *and* fit it. The reset happens in the same update as
   * the index change (both are batched), so the arriving picture never paints
   * for one frame with the previous picture's framing.
   */
  const goTo = useCallback(
    (next: number): void => {
      commitZoom(FIT);
      onIndexChange(next);
    },
    [commitZoom, onIndexChange],
  );

  // Opening focuses the close button so Esc/Enter work without a mouse.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  /**
   * Release everything a held key or a live drag could have left behind.
   *
   * Called on the main process's window-blur (focus lost, hidden, minimized) — which is
   * the only reliable signal in Electron — and the in-renderer `blur` /
   * `visibilitychange` listeners below stay as a second line of defence.
   */
  const releaseTransientInput = useCallback((): void => {
    setSpaceHeld(false);
    pointers.current.clear();
    gesture.current = null;
    setGrabbing(false);
  }, []);

  useEffect(() => {
    return imb.windowControls.onBlur(releaseTransientInput);
  }, [releaseTransientInput]);

  // A new picture starts fitted. `goTo` already does this; this effect is the
  // guard for an index changed from outside (the parent clamping a stale one).
  useEffect(() => {
    resetZoom();
  }, [index, resetZoom]);

  // Measure the fitted box while the fitted copy is still the one laid out at
  // that size — the natural-size copy is scaled into exactly this box, so the
  // two never differ by a pixel. `useLayoutEffect` so the hand-over is set up
  // before the frame paints (no flash at the old size).
  useLayoutEffect(() => {
    const image = fittedRef.current;
    if (!loaded || loaded.index !== index || !image) return;
    const width = image.offsetWidth;
    const height = image.offsetHeight;
    if (width === 0 || height === 0) return;
    if (loaded.width === 0 || loaded.height === 0) return;
    setFitState({
      index,
      naturalWidth: loaded.width,
      naturalHeight: loaded.height,
      scale: Math.min(1, width / loaded.width),
      width,
      height,
      overBudget: loaded.width * loaded.height > MAX_CRISP_PIXELS,
    });
    // `annotating` is a dependency because entering the mode narrows the box the
    // picture may use (the side list takes ~290px on the right), and the zoom/pan
    // maths is stated against the measured box.
  }, [loaded, index, annotating]);

  // A window resize invalidates the measured box: the picture's fitted size, and every
  // zoom/pan bound derived from it, belonged to the old window. The reliable way to
  // get a fresh measurement is to forget the old one — the fitted copy then re-mounts,
  // is measured again, and the hand-over to the original pixels replays (the same path
  // as a fresh open). Without this a window resized while a picture was open left the
  // picture stuck at the previous size, overflowing the new window.
  useEffect(() => {
    let frame = 0;
    const onResize = (): void => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        commitZoom(FIT);
        setFitState(null);
        setLoaded(null);
        setHiLoaded(null);
        setFittedGone(null);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [commitZoom]);

  // A picture served from the cache can finish before React attaches `onLoad`
  // (the deck thumbnail has usually fetched the same `imb-file:` URL already),
  // so read the sizes off the elements as well: neither the measurement nor the
  // hand-over to the original pixels may depend on catching the event.
  useEffect(() => {
    const fitted = fittedRef.current;
    if (
      fitted !== null &&
      loaded?.index !== index &&
      fitted.complete &&
      fitted.naturalWidth > 0
    ) {
      setLoaded({
        index,
        width: fitted.naturalWidth,
        height: fitted.naturalHeight,
      });
    }
    const full = fullRef.current;
    if (full !== null && hiLoaded?.index !== index && full.complete) {
      if (full.naturalWidth > 0) setHiLoaded({ index });
    }
  });

  // The hand-over gate. A plain timer (not a side effect of the FLIP) so the
  // beat is the same whether or not the open animation ran, and it restarts per
  // shown picture: flipping to another image replays that picture's entrance
  // fade, and its original pixels must not fade in on top of a half-faded copy
  // either. Reduced motion collapses the beat to nothing — the reveal is then a
  // single step, which is what that setting asks for.
  useEffect(() => {
    if (prefersReducedMotion()) {
      setHandOverReady(true);
      return;
    }
    setHandOverReady(false);
    const timer = window.setTimeout(
      () => setHandOverReady(true),
      HAND_OVER_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [index]);

  // Drop the fitted copy once the full-resolution one has faded in: two
  // decoded bitmaps of the same picture is pure memory.
  useEffect(() => {
    if (!crisp) return;
    const timer = window.setTimeout(
      () => setFittedGone({ index }),
      FADE_MS + 40,
    );
    return () => window.clearTimeout(timer);
  }, [crisp, index]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // A key pressed in a text field belongs to that field. The annotation editor is
      // opened *by* this viewer, so without this guard typing "3x5 = 15" zooms the
      // picture (`=`/`+`/`-`/`0` are the viewer's zoom keys), and `←`/`→` would flip
      // to another picture mid-sentence. `Escape` never reaches here from the editor —
      // the editor handles it and stops propagation — so nothing is lost by returning
      // early for every other key.
      if (isEditingText(event.target)) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        // One level per press, in the order the boss built them up: the mark
        // being written, then the annotation mode, then the framing, and only
        // then the viewer itself. (The editor card handles its own Esc and stops
        // the event before it gets here.)
        if (draft !== null || editingKey !== null) {
          setDraft(null);
          setEditingKey(null);
        } else if (modelView) setModelView(false);
        else if (annotating) setAnnotating(false);
        else if (!isFitted(zoomRef.current)) resetZoom();
        else onClose();
      } else if (annotating && event.code === "Space") {
        // Panning moved to `Space`+drag because a plain drag now draws. Held
        // (not toggled) so the gesture never sticks.
        event.preventDefault();
        setSpaceHeld(true);
      } else if (count > 1 && event.key === "ArrowLeft") {
        event.stopPropagation();
        goTo((index - 1 + count) % count);
      } else if (count > 1 && event.key === "ArrowRight") {
        event.stopPropagation();
        goTo((index + 1) % count);
      } else if (event.key === "+" || event.key === "=") {
        event.stopPropagation();
        zoomFromCenter(zoomRef.current.scale * KEY_ZOOM_FACTOR);
      } else if (event.key === "-" || event.key === "_") {
        event.stopPropagation();
        zoomFromCenter(zoomRef.current.scale / KEY_ZOOM_FACTOR);
      } else if (event.key === "0") {
        event.stopPropagation();
        resetZoom();
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    // A keyup outside the window (or while the window is hidden) never arrives, so the
    // "ready to pan" cursor would stick. Reset on anything that means "the press is over".
    const releaseSpace = releaseTransientInput;
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") releaseSpace();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", releaseSpace);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", releaseSpace);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [
    annotating,
    count,
    draft,
    editingKey,
    goTo,
    index,
    modelView,
    onClose,
    releaseTransientInput,
    resetZoom,
    zoomFromCenter,
  ]);

  // Wheel: a plain wheel zooms about the pointer at any scale — no modifier
  // needed. A trackpad pinch arrives as `wheel` with `ctrlKey` set, so it takes
  // the exact same path. The listener is native (React's is passive) so the
  // gesture can be owned outright: no page zoom, no scroll behind the viewer.
  // Switching images is deliberately *not* on the wheel: ←/→, the on-screen
  // arrows and the `n / m` counter are the (always visible) ways to flip.
  useEffect(() => {
    const element = overlayRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      // The same rule as the keyboard: what is typed or scrolled *in* a text field
      // belongs to the field. The note editor lives inside this overlay, and a wheel
      // there has to scroll the note, not zoom the picture.
      if (isEditingText(event.target)) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      const delta = event.deltaY * unit;
      event.preventDefault();
      if (delta === 0) return;
      zoomAt(
        zoomRef.current.scale * Math.exp(-delta * WHEEL_ZOOM_SPEED),
        event.clientX,
        event.clientY,
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // FLIP the fitted copy out of the thumbnail: place it at the thumbnail's box
  // for the first paint, then release it to its natural size on the next frame
  // so the transform transitions. Zoom/pan live on the wrapper, so they never
  // fight this animation; the full-resolution copy waits for it to finish
  // (`HAND_OVER_DELAY_MS`).
  useLayoutEffect(() => {
    const image = fittedRef.current;
    if (!image || !origin) return;
    // Reduced motion: the picture simply appears where it ends up. Growing it out
    // of the thumbnail is exactly the movement that setting is about, and the
    // hand-over is already immediate in that mode.
    if (prefersReducedMotion()) return;
    if (!image.complete || image.naturalWidth === 0) return;
    const target = image.getBoundingClientRect();
    if (target.width === 0 || target.height === 0) return;
    const scale = origin.width / target.width;
    const dx =
      origin.left + origin.width / 2 - (target.left + target.width / 2);
    const dy =
      origin.top + origin.height / 2 - (target.top + target.height / 2);
    image.style.transition = "none";
    image.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    const frame = requestAnimationFrame(() => {
      image.style.transition = `transform ${OPEN_MS}ms var(--imb-ease-standard)`;
      image.style.transform = "translate(0, 0) scale(1)";
    });
    const timer = window.setTimeout(() => {
      // Hand the element back to CSS: the inline transform would otherwise
      // outlive the animation and shadow any later styling.
      image.style.transition = "";
      image.style.transform = "";
    }, HAND_OVER_DELAY_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [origin]);

  const capturePointer = (element: HTMLElement, pointerId: number): void => {
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // Pointer capture is best-effort; dragging still works without it.
    }
  };

  const onZoomPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    forcePan = false,
  ): void => {
    // Two kinds of press reach the picture: a **primary** one (the left button, or a
    // finger) and a **pan** one (right button, middle button, macOS ctrl+click — see
    // `isPanPress`), which pans in every mode. The primary press pans too, *except* where
    // it draws: annotation mode owns it (the drawing surface is what actually receives
    // it; this is the guard for a press the surface did not take), and there `Space` gives
    // it back to panning. Deciding on "does the primary press draw here" — rather than on
    // "is this a pan button" — is what keeps a plain left-drag panning in browsing and
    // model view, which is the gesture everyone tries first.
    // `forcePan` is used for the backdrop: it is not a drawing surface, so a press
    // there pans in every mode (the viewer's whole area shares one cursor, and that
    // cursor says "grabbable").
    const drawsPrimary = !forcePan && annotating && !modelView && !spaceHeld;
    if (!isPanPress(event) && drawsPrimary) return;
    if (isPanPress(event)) event.preventDefault();
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointers.current.size > 2) return;
    capturePointer(event.currentTarget, event.pointerId);
    if (pointers.current.size === 1) {
      // One pointer pans the picture at *any* scale (a fitted picture can be
      // nudged to a corner too); a second pointer turns the gesture into a
      // pinch.
      gesture.current = {
        kind: "pan",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: zoomRef.current.x,
        originY: zoomRef.current.y,
      };
      setGrabbing(true);
      return;
    }
    const ids = Array.from(pointers.current.keys()).slice(0, 2) as [
      number,
      number,
    ];
    const [a, b] = ids.map((pointerId) => pointers.current.get(pointerId));
    if (!a || !b) return;
    gesture.current = {
      kind: "pinch",
      ids,
      startDistance: Math.hypot(a.x - b.x, a.y - b.y),
      startScale: zoomRef.current.scale,
      startMidX: (a.x + b.x) / 2,
      startMidY: (a.y + b.y) / 2,
      startX: zoomRef.current.x,
      startY: zoomRef.current.y,
    };
    setGrabbing(true);
  };

  const onZoomPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const tracked = pointers.current.get(event.pointerId);
    if (!tracked) return;
    tracked.x = event.clientX;
    tracked.y = event.clientY;
    const current = gesture.current;
    if (!current) return;
    if (current.kind === "pan") {
      if (!pointers.current.has(current.pointerId)) return;
      // Free pan: no clamping to the window (the boss drags a border detail to the
      // middle; `0` / Esc bring the picture back).
      commitZoom({
        scale: zoomRef.current.scale,
        x: current.originX + (event.clientX - current.startX),
        y: current.originY + (event.clientY - current.startY),
      });
      return;
    }
    const [a, b] = current.ids.map((pointerId) =>
      pointers.current.get(pointerId),
    );
    if (!a || !b || current.startDistance <= 0) return;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const scale = clamp(
      (current.startScale * distance) / current.startDistance,
      MIN_ZOOM,
      maxZoom,
    );
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const center = imageCenter();
    if (!center) return;
    // Keep the picture under the fingers: the pinch also follows the midpoint.
    const ratio = scale / current.startScale;
    commitZoom({
      scale,
      x:
        midX -
        (current.startMidX - center.x - current.startX) * ratio -
        center.x,
      y:
        midY -
        (current.startMidY - center.y - current.startY) * ratio -
        center.y,
    });
  };

  const onZoomPointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0) {
      gesture.current = null;
      setGrabbing(false);
      return;
    }
    // Pinch → pan: the remaining finger keeps moving the picture, so lifting
    // one finger never makes it jump back to the centred framing.
    if (pointers.current.size === 1) {
      const [pointerId, point] = Array.from(pointers.current.entries())[0];
      gesture.current = {
        kind: "pan",
        pointerId,
        startX: point.x,
        startY: point.y,
        originX: zoomRef.current.x,
        originY: zoomRef.current.y,
      };
      return;
    }
    gesture.current = null;
  };

  const onZoomDoubleClick = (event: {
    clientX: number;
    clientY: number;
  }): void => {
    // Double-click toggles between the neutral framing and 2×: any state that
    // is not fitted (zoomed out to 0.5×, zoomed in, or merely panned) resets
    // first. Jumping 0.5× → 2× directly would be a 4× leap and skip the state
    // the boss most likely wants to get back to.
    if (!isFitted(zoomRef.current)) resetZoom();
    else zoomAt(DOUBLE_CLICK_ZOOM, event.clientX, event.clientY);
  };

  const reveal = useCallback(async (): Promise<void> => {
    if (!onReveal || revealing) return;
    setRevealError(null);
    setRevealing(true);
    try {
      await onReveal();
    } catch (err) {
      setRevealError({
        index,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRevealing(false);
    }
  }, [index, onReveal, revealing]);

  if (!current) return null;

  return createPortal(
    <div
      ref={overlayRef}
      className={cls(
        "imb-lightbox",
        annotating && "imb-lightbox-annotating",
        modelView && "imb-lightbox-model-view",
        // One cursor for the whole view (see the CSS block): grabbing beats grab beats
        // crosshair, and only annotation mode at rest draws.
        grabbing
          ? "imb-lightbox-cursor-grabbing"
          : spaceHeld || !annotating || modelView
            ? "imb-lightbox-cursor-grab"
            : "imb-lightbox-cursor-crosshair",
      )}
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
      // A press on the black backdrop: **drag pans, click closes**.
      //
      // Closing on `mousedown` alone was wrong twice over — a drag starts with a press
      // too (so "drag the picture back" from the empty area closed the viewer instead),
      // and the viewer's cursor says that area is grabbable. So the close waits for the
      // release and only fires when the pointer did not travel; a drag pans the picture,
      // which is what the cursor promised.
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return;
        backdropPress.current = { x: event.clientX, y: event.clientY };
        onZoomPointerDown(event, true);
      }}
      onPointerMove={onZoomPointerMove}
      onPointerUp={(event) => {
        const start = backdropPress.current;
        backdropPress.current = null;
        onZoomPointerEnd(event);
        if (start === null) return;
        const travel = Math.hypot(
          event.clientX - start.x,
          event.clientY - start.y,
        );
        if (travel > CLICK_JITTER_PX) return;
        // A click on the backdrop still only dismisses while merely *viewing*: in
        // annotation mode a stray click outside the picture must not throw away the
        // batch and the mark being written.
        if (annotating || modelView) return;
        onClose();
      }}
      onPointerCancel={(event) => {
        backdropPress.current = null;
        onZoomPointerEnd(event);
      }}
    >
      <button
        type="button"
        ref={closeRef}
        className="imb-lightbox-close"
        onClick={onClose}
        aria-label={t("Close")}
        title={t("Close")}
      >
        <IconX />
      </button>

      {count > 1 && (
        <button
          type="button"
          className="imb-lightbox-nav imb-lightbox-prev"
          onClick={() => goTo((index - 1 + count) % count)}
          aria-label={t("Previous image")}
          title={t("Previous image")}
        >
          <IconChevronDown />
        </button>
      )}

      <figure className="imb-lightbox-figure">
        <div
          ref={frameRef}
          className={cls(
            "imb-lightbox-zoom",
            grabbing && "imb-lightbox-grabbing",
            annotating && !spaceHeld && "imb-lightbox-drawing",
          )}
          style={
            {
              width: fit ? `${fit.width}px` : undefined,
              height: fit ? `${fit.height}px` : undefined,
              ...(fit ? { "--imb-lightbox-fit": String(fit.scale) } : {}),
              // A plain 2D transform on purpose: `translate3d` promotes the layer,
              // and a promoted layer can be painted from a raster computed at the
              // pre-zoom scale — which is what makes a magnified picture look
              // like a preview instead of its own pixels.
              transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
            } as CSSProperties
          }
          onPointerDown={onZoomPointerDown}
          onPointerMove={onZoomPointerMove}
          onPointerUp={onZoomPointerEnd}
          onPointerCancel={onZoomPointerEnd}
          // A pan whose pointer capture is lost (released outside the window, the
          // window losing focus mid-drag) must not leave the view stuck in `grabbing`.
          onLostPointerCapture={onZoomPointerEnd}
          // Right-drag pans, so the native menu must not appear when the button is
          // released (nor on a right press that does not move). Scoped to the picture:
          // a text field's own context menu (copy/paste in the note editor) stays.
          onContextMenu={(event) => event.preventDefault()}
          // Double-click is off in annotation mode: it would be read as two
          // marks, and "zoom by accident instead of marking" is not a trade the
          // boss should have to learn.
          onDoubleClick={annotating ? undefined : onZoomDoubleClick}
        >
          {/* The fitted-size copy: what the viewer opens with, and the element
              the thumbnail grows into. It stays fully opaque underneath while
              the real pixels fade in over it, then it is dropped — never faded
              out (that would dim the picture mid-fade). */}
          {showFitted && (
            <img
              key={`fitted-${index}`}
              ref={fittedRef}
              className={cls("imb-lightbox-image", "imb-lightbox-image-fitted")}
              src={current.src}
              alt={crisp ? "" : current.name}
              draggable={false}
              onLoad={(event) => {
                const image = event.currentTarget;
                setLoaded({
                  index,
                  width: image.naturalWidth,
                  height: image.naturalHeight,
                });
              }}
            />
          )}
          {/* The original pixels: laid out at the natural size and scaled down
              into the fitted box, so `1×` of absolute zoom is 1 image px. */}
          {fit !== null && !degraded && (
            <img
              key={`full-${index}`}
              ref={fullRef}
              className={cls(
                "imb-lightbox-image",
                "imb-lightbox-image-full",
                crisp && "imb-lightbox-image-in",
              )}
              style={{
                width: `${fit.naturalWidth}px`,
                height: `${fit.naturalHeight}px`,
              }}
              src={current.src}
              alt={crisp ? current.name : ""}
              aria-hidden={crisp ? undefined : "true"}
              draggable={false}
              onLoad={() => setHiLoaded({ index })}
            />
          )}
          {liveMarks.length > 0 && (
            <MarkLayer
              marks={liveMarks}
              minBadgePx={minBadgePx}
              focusKey={hoverKey}
              editingKey={editingKey}
              inert={!annotating || modelView}
              onSelect={
                annotating && !modelView
                  ? (key) => setEditingKey(key)
                  : undefined
              }
            />
          )}
          {annotating && canAnnotate && !modelView && fit !== null && (
            <CaptureLayer
              naturalWidth={fit.naturalWidth}
              naturalHeight={fit.naturalHeight}
              panning={spaceHeld}
              onCommit={(mark) => setDraft(mark)}
            />
          )}
        </div>
        <figcaption className="imb-lightbox-caption">
          <span className="imb-lightbox-name">{current.name}</span>
          {count > 1 && (
            <span className="imb-lightbox-count">{`${index + 1} / ${count}`}</span>
          )}
          <span className="imb-lightbox-zoom-level">{`${percent}%`}</span>
          {degraded && (
            <span
              className="imb-lightbox-note"
              title={t("Downscaled preview (very large image)")}
            >
              {t("Downscaled preview (very large image)")}
            </span>
          )}
          {annotation !== undefined &&
            !modelView &&
            (canAnnotate || annotating) && (
              <button
                type="button"
                className={cls(
                  "imb-lightbox-action",
                  annotating && "imb-lightbox-action-on",
                )}
                onClick={() => {
                  setDraft(null);
                  setEditingKey(null);
                  setAnnotating(!annotating);
                }}
                title={canAnnotate ? undefined : annotation.unavailableReason}
                aria-pressed={annotating}
              >
                {t("Annotate")}
              </button>
            )}
          {(annotating || modelView) && (
            <button
              type="button"
              className={cls(
                "imb-lightbox-action",
                modelView && "imb-lightbox-action-on",
              )}
              onClick={() => {
                setModelView(!modelView);
                setEditingKey(null);
                setDraft(null);
              }}
              title={t("What the model will see")}
              aria-pressed={modelView}
            >
              {t("Model view")}
            </button>
          )}
          {onReveal !== undefined && (
            <button
              type="button"
              className="imb-lightbox-reveal"
              onClick={() => void reveal()}
              disabled={revealing}
              aria-label={t("Show in folder")}
              title={t("Show in folder")}
            >
              <IconFolder />
              <span>{t("Show in folder")}</span>
            </button>
          )}
        </figcaption>
        {error !== null && <p className="imb-lightbox-error">{error}</p>}
      </figure>

      {annotating && modelView && (
        <div className="imb-annot-model-view-badge" role="status">
          {t("Model view — read-only")}
        </div>
      )}

      {annotating && !modelView && annotation !== undefined && (
        <>
          <AnnotationBanner
            batchCount={annotation.batchCount}
            onDone={() => {
              setDraft(null);
              setEditingKey(null);
              setAnnotating(false);
            }}
          />
          <AnnotationList
            // Everything on this picture: the header's number must match what the
            // boss can see on it (delivered marks are listed read-only).
            marks={marks}
            editingKey={editingKey}
            hoverKey={hoverKey}
            onSelect={(key) => setEditingKey(key)}
            onHover={setHoverKey}
            onRemove={(key) => {
              if (editingKey === key) setEditingKey(null);
              annotation.onRemove(index, key);
            }}
          />
        </>
      )}

      {count > 1 && (
        <button
          type="button"
          className="imb-lightbox-nav imb-lightbox-next"
          onClick={() => goTo((index + 1) % count)}
          aria-label={t("Next image")}
          title={t("Next image")}
        >
          <IconChevronDown />
        </button>
      )}

      {annotation !== undefined &&
        showPanel &&
        panelMark !== null &&
        panelAnchor !== null && (
          <AnnotationPanel
            // A fresh editor per mark: the field's draft text belongs to the mark
            // it was opened for, never to whatever was selected before.
            key={draft !== null ? "draft" : (editingKey ?? "none")}
            ordinal={panelOrdinal}
            mark={panelMark}
            note={editingMark?.note ?? ""}
            anchor={panelAnchor}
            saved={draft === null}
            onSave={(note) => {
              if (draft !== null) {
                annotation.onCreate(index, draft, note);
                setDraft(null);
                return;
              }
              if (editingKey !== null) {
                annotation.onEditNote(index, editingKey, note);
                setEditingKey(null);
              }
            }}
            onCancel={() => {
              setDraft(null);
              setEditingKey(null);
            }}
            onDelete={() => {
              if (editingKey !== null) annotation.onRemove(index, editingKey);
              setEditingKey(null);
              setDraft(null);
            }}
          />
        )}
    </div>,
    document.body,
  );
}
