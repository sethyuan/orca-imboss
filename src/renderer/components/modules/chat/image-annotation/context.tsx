/**
 * How a picture deep inside a thread finds out what it is annotated with, and how
 * a new annotation gets into the composer's batch.
 *
 * A thread picture is rendered by `ImageStack` ← `MessageAttachments` ← a bubble
 * or a structured card, none of which knows which conversation it is in (a card
 * may be rendered by three different row types). Carrying the annotation surface
 * down as props would mean touching every one of them; a context lets the thread
 * own it instead — the thread is the only place that has both the conversation's
 * messages (for the marks already sent) and the composer's batch.
 *
 * The context is `null` where annotation does not apply (a generated picture, a
 * module with no composer in reach), and the picture then offers no entry at all —
 * which is the approved rule, not a degradation.
 */
import { isAnnotatedCopyName } from "@shared/constants/image-annotation";
import type { ImageMark, ImageTargetSource } from "@shared/types";
import { createContext, useContext } from "react";
import type { LightboxAnnotation, LightboxImage } from "../image-lightbox";
import type { MarkView } from "./marks-layer";

/** The pictures one thread renders, addressed the way an annotation addresses them. */
export interface PictureLocation {
  source: ImageTargetSource;
  attachmentIndex: number;
  attachmentName: string;
  /** Readable location of the picture, when the host knows one (a bake needs it). */
  src?: string;
  /**
   * Whether the picture accepts **new** marks. False for a copy this app already
   * baked (its marks are pixels; a second batch would stack badges). Its existing
   * marks still render — this only removes the way *in*.
   */
  annotatable: boolean;
}

/** The composer batch, as the pictures need it. */
export interface PendingImageAnnotations {
  /** Annotations waiting in the composer, text ones included. */
  count: number;
  /** Whether a new mark may be added right now (batch cap). */
  canAnnotate: boolean;
  /** Why not, for the disabled action. */
  unavailableReason?: string;
  /** Marks of this batch on one picture, numbered by batch position. */
  viewsFor(picture: PictureLocation): MarkView[];
  add(picture: PictureLocation, mark: ImageMark, note: string): void;
  /** Replace one pending annotation's note (its key is the pending id). */
  updateNote(key: string, note: string): void;
  remove(key: string): void;
}

export interface ImageAnnotationApi {
  /** Marks an earlier batch left on this picture (read-only, no ordinals). */
  sentMarks(picture: PictureLocation): MarkView[];
  /** The batch being written; absent when this surface cannot take one. */
  pending: PendingImageAnnotations | null;
  /**
   * The mark a comment card is pointing at, as `MarkView.key` (`<batch>:<index>`).
   *
   * One string is enough because the two ends live in different rows: the card is on
   * the message that *carried* the annotation, the mark is on the message that owns
   * the picture. Both sides read the same context, so hovering a card lights up a
   * mark in another bubble and vice versa.
   */
  focusKey: string | null;
  setFocusKey(key: string | null): void;
}

/** `MarkView.key` of the `index`-th mark of one annotating batch. */
export function markKeyAt(carrier: ImageTargetSource, index: number): string {
  return `${
    carrier.kind === "message" ? `m${carrier.messageId}` : `e${carrier.entryId}`
  }:${index}`;
}

export const ImageAnnotationContext = createContext<ImageAnnotationApi | null>(
  null,
);

/** The surface for the current subtree, or `null` when pictures there are inert. */
export function useImageAnnotation(): ImageAnnotationApi | null {
  return useContext(ImageAnnotationContext);
}

/** The pictures of one image stack, in the annotation dialect. */
export function stackPictures(
  source: ImageTargetSource | undefined,
  images: readonly { index: number; name: string; src: string }[],
): PictureLocation[] {
  if (source === undefined) return [];
  return images.map((image) => ({
    source,
    attachmentIndex: image.index,
    attachmentName: image.name,
    src: image.src,
    // A baked copy is recognised by the name the app itself minted for it — see
    // `isAnnotatedCopyName`. A picture that only *failed* to bake keeps its original
    // name, so it stays annotatable (the degradation must not lock it out).
    annotatable: !isAnnotatedCopyName(image.name),
  }));
}

/** `true` when this picture can be annotated at all (an owner is known). */
export function isAnnotatable(api: ImageAnnotationApi | null): boolean {
  return api !== null && api.pending !== null;
}

/** One picture a lightbox shows, with its resolved marks. */
export function decorateForLightbox(
  api: ImageAnnotationApi | null,
  pictures: readonly PictureLocation[],
  images: readonly { name: string; src: string }[],
): LightboxImage[] {
  return images.map((image, at) => {
    const picture = pictures[at];
    if (picture === undefined) return image;
    const marks =
      api === null
        ? []
        : [...api.sentMarks(picture), ...batchViews(api, picture)];
    return marks.length === 0 ? image : { ...image, marks };
  });
}

/** Marks of the pending batch on one picture (`[]` without a batch). */
function batchViews(
  api: ImageAnnotationApi,
  picture: PictureLocation,
): MarkView[] {
  return api.pending === null ? [] : api.pending.viewsFor(picture);
}

/**
 * The lightbox's annotation props for a stack of pictures, or `undefined` when the
 * pictures there are inert.
 *
 * The lightbox addresses pictures by their position in its `images` list, so every
 * callback translates that position back to the location the storage uses.
 */
export function lightboxAnnotation(
  api: ImageAnnotationApi | null,
  pictures: readonly PictureLocation[],
): LightboxAnnotation | undefined {
  // No owner for these pictures ⇒ no annotation at all. That is what keeps a
  // generated picture (`kind:"image"`, whose files are replaced and deleted on every
  // re-roll) from offering an entry the plan forbids.
  if (api === null || pictures.length === 0) return undefined;
  const pending = api.pending;
  const at = (index: number): PictureLocation | undefined => pictures[index];
  /** Marks may only be added to a picture that takes them and a batch with room. */
  const openAt = (index: number): boolean => {
    const picture = at(index);
    return (
      picture !== undefined &&
      picture.annotatable &&
      (pending?.canAnnotate ?? false)
    );
  };
  return {
    batchCount: pending?.count ?? 0,
    // Per picture: one stack can hold a baked copy next to an annotatable picture,
    // and the action has to disappear only for the former.
    canAnnotate: openAt,
    ...(pending?.unavailableReason === undefined
      ? {}
      : { unavailableReason: pending.unavailableReason }),
    onCreate: (index, mark, note) => {
      const picture = at(index);
      if (picture === undefined || !openAt(index)) return;
      pending?.add(picture, mark, note);
    },
    onEditNote: (index, key, note) => {
      // `key` is the pending annotation's own id, so the picture is not needed;
      // the images list is still validated so a stale index cannot write.
      if (at(index) === undefined) return;
      pending?.updateNote(key, note);
    },
    onRemove: (index, key) => {
      if (at(index) === undefined) return;
      pending?.remove(key);
    },
  };
}
