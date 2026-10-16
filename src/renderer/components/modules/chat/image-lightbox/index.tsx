import { t } from "@shared/l10n";
import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cls } from "reactutils";
import { useWheelStep } from "../../../../hooks/use-wheel-step";
import { IconChevronDown, IconX } from "../../../icons";
import { useImageZoom } from "./use-image-zoom";
import "./index.css";

export interface LightboxImage {
  name: string;
  src: string;
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
}

/** Duration of the open transform animation (the backdrop fades via CSS). */
const OPEN_MS = 280;

/**
 * Zoom and pan in the full-screen viewer.
 *
 * The viewer's original behaviour is wheel/arrow stepping between pictures;
 * this constant is the only integration point for the extra gestures, so it can
 * be introduced in whichever form suits the project:
 *
 * - leave it `true` to ship zoom and pan on;
 * - set it `false` to keep the viewer exactly as it was (stepping only, no
 *   zoom, no pan — nothing else needs to change);
 * - replace it with a stored setting read (`SettingKeys` + `imb.settings`) to
 *   expose it as a user option;
 * - or drop the commit to leave no trace.
 */
export const IMAGE_ZOOM_ENABLED = true;

/**
 * Full-screen image viewer for the in-chat attachment previews. Rendered into
 * `document.body` so it escapes the thread's stacking context. Esc closes,
 * arrow keys / on-screen arrows / the wheel step between images, and a click on
 * the backdrop (never the image) closes. Cmd/Ctrl + wheel (or a trackpad pinch)
 * zooms at the pointer, dragging a zoomed picture moves it around, double
 * clicking jumps in and back out, and `+` / `-` / `0` zoom in, out and reset.
 */
export function ImageLightbox({
  images,
  index,
  origin,
  onIndexChange,
  onClose,
}: ImageLightboxProps): React.JSX.Element | null {
  const count = images.length;
  const closeRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const zoom = useImageZoom(zoomRef, IMAGE_ZOOM_ENABLED);
  const { zoomIn, zoomOut, reset } = zoom;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // Every picture opens fitted; the pan of the one before it would be wrong.
  useEffect(() => {
    reset();
  }, [index, reset]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      } else if (count > 1 && event.key === "ArrowLeft") {
        event.stopPropagation();
        onIndexChange((index - 1 + count) % count);
      } else if (count > 1 && event.key === "ArrowRight") {
        event.stopPropagation();
        onIndexChange((index + 1) % count);
      } else if (
        IMAGE_ZOOM_ENABLED &&
        (event.key === "+" || event.key === "=")
      ) {
        event.preventDefault();
        event.stopPropagation();
        zoomIn();
      } else if (
        IMAGE_ZOOM_ENABLED &&
        (event.key === "-" || event.key === "_")
      ) {
        event.preventDefault();
        event.stopPropagation();
        zoomOut();
      } else if (IMAGE_ZOOM_ENABLED && event.key === "0") {
        event.preventDefault();
        event.stopPropagation();
        reset();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [count, index, onIndexChange, onClose, reset, zoomIn, zoomOut]);

  useWheelStep(
    overlayRef,
    (direction) => {
      if (count > 1) onIndexChange((index + direction + count) % count);
    },
    count > 1 || IMAGE_ZOOM_ENABLED,
    IMAGE_ZOOM_ENABLED ? zoom.interceptWheel : undefined,
  );

  // FLIP the image out of the thumbnail: place it at the thumbnail's box for
  // the first paint, then release it to its natural size on the next frame so
  // the transform transitions.
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!image || !origin) return;
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
    return () => cancelAnimationFrame(frame);
  }, [origin]);

  const current = images[index];
  if (!current) return null;

  return createPortal(
    <div
      ref={overlayRef}
      className="imb-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
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
          onClick={() => onIndexChange((index - 1 + count) % count)}
          aria-label={t("Previous image")}
          title={t("Previous image")}
        >
          <IconChevronDown />
        </button>
      )}

      <figure className="imb-lightbox-figure">
        <div
          ref={zoomRef}
          className={cls(
            "imb-lightbox-zoom",
            zoom.scale > 1 && "imb-lightbox-zoom-zoomed",
            zoom.dragging && "imb-lightbox-zoom-dragging",
          )}
          style={{
            transform: `translate(${zoom.offset.x}px, ${zoom.offset.y}px) scale(${zoom.scale})`,
          }}
          onPointerDown={zoom.onPointerDown}
          onPointerMove={zoom.onPointerMove}
          onPointerUp={zoom.onPointerUp}
          onPointerCancel={zoom.onPointerUp}
          onDoubleClick={zoom.onDoubleClick}
        >
          <img
            key={index}
            ref={imageRef}
            className="imb-lightbox-image"
            src={current.src}
            alt={current.name}
            draggable={false}
          />
        </div>
        <figcaption className="imb-lightbox-caption">
          <span className="imb-lightbox-name">{current.name}</span>
          {count > 1 && (
            <span className="imb-lightbox-count">{`${index + 1} / ${count}`}</span>
          )}
          {IMAGE_ZOOM_ENABLED && zoom.scale > 1 && (
            <button
              type="button"
              className="imb-lightbox-zoom-reset"
              onClick={reset}
              aria-label={t("Reset zoom")}
              title={t("Reset zoom")}
            >
              {`${Math.round(zoom.scale * 100)}%`}
            </button>
          )}
        </figcaption>
      </figure>

      {count > 1 && (
        <button
          type="button"
          className="imb-lightbox-nav imb-lightbox-next"
          onClick={() => onIndexChange((index + 1) % count)}
          aria-label={t("Next image")}
          title={t("Next image")}
        >
          <IconChevronDown />
        </button>
      )}
    </div>,
    document.body,
  );
}
