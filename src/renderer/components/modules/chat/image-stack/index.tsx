import { BADGE_MIN_THREAD_PX } from "@shared/constants/image-annotation";
import { t } from "@shared/l10n";
import type { ImageTargetSource } from "@shared/types";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cls } from "reactutils";
import { IconOpen } from "../../../icons";
import {
  decorateForLightbox,
  lightboxAnnotation,
  stackPictures,
  useImageAnnotation,
} from "../image-annotation/context";
import { MarkLayer } from "../image-annotation/marks-layer";
import { ImageLightbox } from "../image-lightbox";
import "./index.css";

export interface ImageStackImage {
  /** Attachment index within the message; also the stable React key. */
  index: number;
  name: string;
  /** `imb-file:` URL to the original file on disk. */
  src: string;
}

/**
 * Master switch for in-chat image previews (thumbnail, card stack, viewer).
 *
 * The whole feature is self-contained under `image-stack/` +
 * `image-lightbox/` + the `imb-file:` protocol (`src/main/imb-file-protocol.ts`);
 * this constant is its single integration point in the message bubble, so it can
 * be introduced in whichever form suits the project:
 *
 * - leave it `true` to ship the feature on;
 * - set it `false` to fall back to the plain file chip (the behaviour before
 *   the feature — nothing else needs to change);
 * - replace it with a stored setting read (`SettingKeys` + `imb.settings`) to
 *   expose it as a user option, e.g. `getSetting(SettingKeys.X) !== "off"`;
 * - or drop the commit to leave no trace.
 */
export const IMAGE_PREVIEW_ENABLED = true;

export interface ImageStackProps {
  images: ImageStackImage[];
  /**
   * Which message / session entry these pictures belong to, so an annotation can
   * address one of them ("image 2 of message #1201"). Omit it and the pictures are
   * not annotatable — which is also what a caller that has no identity to give
   * (a generated picture) relies on.
   */
  source?: ImageTargetSource;
  /** Message side; the deck leans away from the bubble's outer edge. */
  self: boolean;
  /**
   * Called with an image's attachment index when its thumbnail fails to load
   * (file moved/deleted, undecodable bytes). The caller drops it from the stack
   * and falls back to a file chip.
   */
  onImageError?: (index: number) => void;
  /**
   * Reveal a picture's file in the OS file manager, called with its attachment
   * index from the full-screen viewer. Omitted (e.g. for a picture with no
   * stored record yet) the viewer renders no reveal button — the callback is
   * what tells it a trustworthy on-disk location exists.
   */
  onRevealImage?: (index: number) => void | Promise<void>;
  /**
   * Deck edge length in px. Defaults to `DEFAULT_STACK_SIZE` (the bubble's
   * thumbnail); the fan geometry scales with it, so a larger frame (a generated
   * picture) still reads as a stack.
   */
  size?: number;
  /**
   * Contents of a card drawn in front of the deck, for a picture that is still
   * being produced. The deck behind stays visible but is held still until the
   * card goes away — the arriving picture takes the front.
   */
  pending?: ReactNode;
}

/** Deck edge length the fan geometry is authored for. */
export const DEFAULT_STACK_SIZE = 130;

/** Pointer travel (px) past which a drag counts as "swipe to next". */
const SWIPE_THRESHOLD = 60;

/**
 * Visual layer for each card behind the front one: the deck fans upward, with
 * alternating tilt and shrinking scale so the stack reads as depth.
 */
const CARD_LAYERS = [
  { x: 0, y: 0, rotate: 0, scale: 1 },
  { x: 5, y: -14, rotate: -4, scale: 0.95 },
  { x: -5, y: -28, rotate: 4, scale: 0.9 },
  { x: 8, y: -42, rotate: -6, scale: 0.85 },
  { x: -8, y: -56, rotate: 6, scale: 0.8 },
];

/** Stacking order of the cards; only their order matters, so keep it low. */
const CARD_Z_BASE = 10;

interface DragState {
  dx: number;
  dy: number;
  active: boolean;
}

/**
 * In-bubble preview for one or more image attachments. A single image is a
 * plain thumbnail; several images become a card stack — drag the front card
 * past the threshold to send it to the back, click any card to bring it to the
 * front, or click the front card to open the full-screen viewer.
 *
 * Clicking (rather than only handling pointer gestures) keeps the cards usable
 * from the keyboard and assistive tech; a swipe swallows the click it would
 * otherwise also fire.
 *
 * The deck deliberately leaves the wheel alone: a listener over the cards would
 * have to swallow the gesture to own it, which stops the thread from scrolling
 * while the pointer happens to rest on a picture. Browsing the deck therefore
 * has exactly three entries — swipe, click a card behind, click the front card
 * to open the viewer (which holds every image and pages with ←/→).
 */
export function ImageStack({
  images,
  source,
  self,
  onImageError,
  onRevealImage,
  size = DEFAULT_STACK_SIZE,
  pending,
}: ImageStackProps): React.JSX.Element {
  const annotationApi = useImageAnnotation();
  /** The pictures in the annotation dialect (`[]` without an owner). */
  const pictures = useMemo(
    () => stackPictures(source, images),
    [source, images],
  );
  const count = images.length;
  const single = count === 1;
  // The fan is authored for the default deck; scale it with the frame so a
  // larger deck still shows the layers behind the front card.
  const fan = size / DEFAULT_STACK_SIZE;
  // A lone image has nothing to flip, and a deck with a card being produced in
  // front is held still until that card gives way.
  const rotatable = !single && pending === undefined;
  const [front, setFront] = useState(0);
  const [drag, setDrag] = useState<DragState>({ dx: 0, dy: 0, active: false });
  const [lightbox, setLightbox] = useState<number | null>(null);
  /** Screen rect of the card the viewer opened from, for the open animation. */
  const [origin, setOrigin] = useState<DOMRect | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  // An image can be dropped from the deck at runtime (its `<img>` failed to
  // load), shrinking `count` under a stale `front`/`lightbox` position.
  useEffect(() => {
    setFront((value) => (count > 0 ? Math.min(value, count - 1) : 0));
    setLightbox((value) => (value === null || value < count ? value : null));
  }, [count]);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!rotatable || event.button !== 0) return;
    start.current = { x: event.clientX, y: event.clientY };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; dragging still works without it.
    }
    setDrag({ dx: 0, dy: 0, active: true });
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!start.current) return;
    setDrag({
      dx: event.clientX - start.current.x,
      dy: event.clientY - start.current.y,
      active: true,
    });
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!start.current) return;
    const dx = event.clientX - start.current.x;
    const dy = event.clientY - start.current.y;
    start.current = null;
    setDrag({ dx: 0, dy: 0, active: false });
    if (Math.hypot(dx, dy) < SWIPE_THRESHOLD) return;
    // A swipe still fires a click on release; swallow it so the gesture does
    // not also open the viewer (or re-front the card that just went back).
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    setFront((value) => (value + 1) % count);
  };

  const onCardClick = (
    position: number,
    event: React.MouseEvent<HTMLButtonElement>,
  ): void => {
    // Nothing to bring forward while a card is being produced in front.
    if (pending !== undefined) return;
    if (suppressClick.current) return;
    if (position === front) {
      setOrigin(event.currentTarget.getBoundingClientRect());
      setLightbox(front);
    } else {
      setFront(position);
    }
  };

  // The deck leans the same way regardless of which card is on top, so a
  // self (right-aligned) bubble mirrors the fan.
  const lean = self ? -1 : 1;

  return (
    <div
      className={cls("imb-image-stack", single && "imb-image-stack-single")}
      style={{ "--imb-stack-size": `${size}px` } as CSSProperties}
    >
      {pending !== undefined && (
        // The card being produced. It is the element that gives way when the
        // picture arrives, so it is also where the swap transition belongs.
        <div
          className="imb-image-card imb-image-card-pending"
          style={{ zIndex: CARD_Z_BASE + 1 }}
          aria-hidden="true"
        >
          {pending}
        </div>
      )}
      {images.map((image, position) => {
        // With a card in front, every picture sits one layer further back.
        const rel =
          ((position - front + count) % count) +
          (pending !== undefined ? 1 : 0);
        const isFront = rel === 0;
        const layer = CARD_LAYERS[Math.min(rel, CARD_LAYERS.length - 1)];
        const rotation =
          layer.rotate * lean + (isFront && drag.active ? drag.dx * 0.06 : 0);
        const style: CSSProperties = {
          transform: `translate3d(${
            layer.x * fan + (isFront ? drag.dx : 0)
          }px, ${layer.y * fan + (isFront ? drag.dy : 0)}px, 0) rotate(${rotation}deg) scale(${layer.scale})`,
          zIndex: CARD_Z_BASE - rel,
          transition: isFront && drag.active ? "none" : undefined,
        };
        return (
          <button
            key={image.index}
            type="button"
            className={cls("imb-image-card", isFront && "imb-image-card-front")}
            style={style}
            tabIndex={isFront ? 0 : -1}
            aria-label={t("Enlarge image")}
            title={
              isFront && !single
                ? t("Click to enlarge, drag to switch")
                : t("Enlarge image")
            }
            onPointerDown={isFront ? onPointerDown : undefined}
            onPointerMove={isFront ? onPointerMove : undefined}
            onPointerUp={isFront ? onPointerUp : undefined}
            onPointerCancel={isFront ? onPointerUp : undefined}
            onClick={(event) => onCardClick(position, event)}
          >
            <img
              src={image.src}
              alt={image.name}
              draggable={false}
              onError={() => onImageError?.(image.index)}
            />
            {isFront && (
              <span className="imb-image-card-hint" aria-hidden="true">
                <IconOpen />
              </span>
            )}
            {isFront &&
              annotationApi !== null &&
              pictures[position] !== undefined && (
                <MarkLayer
                  marks={[
                    ...annotationApi.sentMarks(pictures[position]),
                    ...(annotationApi.pending?.viewsFor(pictures[position]) ??
                      []),
                  ]}
                  minBadgePx={BADGE_MIN_THREAD_PX}
                  focusKey={annotationApi.focusKey}
                  inert
                />
              )}
          </button>
        );
      })}

      {count > 1 && pending === undefined && (
        <span className="imb-image-stack-count" aria-hidden="true">
          {`${front + 1} / ${count}`}
        </span>
      )}

      {lightbox !== null && (
        <ImageLightbox
          images={decorateForLightbox(annotationApi, pictures, images)}
          annotation={lightboxAnnotation(annotationApi, pictures)}
          index={lightbox}
          origin={origin}
          onIndexChange={setLightbox}
          onClose={() => setLightbox(null)}
          onReveal={
            onRevealImage === undefined
              ? undefined
              : () => onRevealImage(images[lightbox].index)
          }
        />
      )}
    </div>
  );
}
