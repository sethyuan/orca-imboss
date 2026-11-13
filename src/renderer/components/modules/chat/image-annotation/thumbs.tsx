/**
 * The 40×25 thumbnail that stands in for a picture inside a list row: the picture
 * (when its pixels are addressable) with the annotation's mark drawn on it.
 *
 * Its purpose is to answer "which part of which picture is this?" at a glance, so
 * the box keeps the picture's own aspect ratio even when the pixels are not
 * available (a draft chip's bytes are a `blob:` URL the lightbox already holds; a
 * sent picture's are an `imb-file:` URL the caller can always build). With the
 * right ratio the mark's position still reads correctly on an empty frame, which is
 * why the thumbnail never guesses a 16:10 box.
 */
import { BADGE_MIN_THREAD_PX } from "@shared/constants/image-annotation";
import type { ImageMark } from "@shared/types";
import { cls } from "reactutils";
import { MarkLayer } from "./marks-layer";
import "./index.css";

export interface MarkThumbProps {
  mark: ImageMark;
  /** Ordinal to draw on the badge (`undefined` ⇒ no number). */
  ordinal?: number;
  note: string;
  /** Picture URL, when the caller has one. */
  src?: string | null;
  /** Box the thumbnail must fit in, in px. */
  width?: number;
  height?: number;
  className?: string;
}

/** The picture's aspect ratio, bounded so a panorama is not a hairline. */
function thumbBox(
  mark: ImageMark,
  width: number,
  height: number,
): { width: number; height: number } {
  const ratio =
    mark.imageWidth > 0 && mark.imageHeight > 0
      ? mark.imageWidth / mark.imageHeight
      : width / height;
  const byWidth = { width, height: width / ratio };
  if (byWidth.height <= height) return byWidth;
  return { width: height * ratio, height };
}

export function MarkThumb({
  mark,
  ordinal,
  note,
  src = null,
  width = 40,
  height = 25,
  className,
}: MarkThumbProps): React.JSX.Element {
  const box = thumbBox(mark, width, height);
  return (
    <span
      className={cls("imb-mark-thumb", className)}
      style={{ width: `${box.width}px`, height: `${box.height}px` }}
      aria-hidden="true"
    >
      {src !== null && <img src={src} alt="" draggable={false} />}
      <MarkLayer
        marks={[{ key: "thumb", mark, ordinal, note }]}
        minBadgePx={Math.max(8, BADGE_MIN_THREAD_PX * 0.7)}
        inert
      />
    </span>
  );
}
