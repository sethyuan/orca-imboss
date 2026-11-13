/**
 * Building and reading the **draft** half of an image annotation: the composer
 * batch, before it becomes a message.
 *
 * A pending annotation is an ordinary {@link PendingComment} whose anchor carries
 * a {@link ImageMark} instead of a quote, so it shares the batch's numbering, its
 * storage (`appStore.chatComments` / `sessionComments`) and its send path with text
 * annotations. Two details are specific to pictures:
 *
 * - a picture of a **draft attachment** is addressed by the chip's id
 *   (`attachmentId`), never by its position — positions move when a chip is
 *   removed, ids do not (the index is resolved once, at send time);
 * - a picture of an **already-sent** message is addressed by that message's
 *   identity (`source`), plus the attachment index inside it.
 */
import { parseImbFilePath } from "@shared/imb-file";
import type {
  CommentAnchor,
  ImageMark,
  ImageTargetSource,
} from "@shared/types";
import { nextCommentId, type PendingComment } from "./comment-draft";
import type { MarkView } from "./components/modules/chat/image-annotation/marks-layer";

/** One picture an annotation can point at, as the renderer addresses it. */
export type PictureRef =
  | {
      /** A chip of the composer draft. */
      kind: "draft";
      attachmentId: number;
      attachmentName: string;
    }
  | {
      /** A picture that is already part of a message / session entry. */
      kind: "sent";
      source: ImageTargetSource;
      attachmentIndex: number;
      attachmentName: string;
      /** How to read the original pixels (an `imb-file:` URL, usually). */
      src?: string;
    };

/** Stable identity of one picture, for looking its marks up in a map. */
export function pictureKey(picture: PictureRef): string {
  if (picture.kind === "draft") {
    return `draft:${picture.attachmentId}`;
  }
  const owner =
    picture.source.kind === "message"
      ? `m${picture.source.messageId}`
      : `e${picture.source.entryId}`;
  return `sent:${owner}:${picture.attachmentIndex}`;
}

/** The name the record keeps (a picture is only trusted when the name matches). */
export function pictureName(picture: PictureRef): string {
  return picture.attachmentName;
}

/**
 * A new pending annotation of one picture.
 *
 * The note is required (an empty annotation is not an annotation): callers only
 * create one after the boss hit save.
 */
export function newImageAnnotation(
  picture: PictureRef,
  mark: ImageMark,
  note: string,
): PendingComment {
  if (picture.kind === "draft") {
    const anchor: CommentAnchor = {
      target: {
        kind: "image",
        // Resolved from `attachmentId` when the batch is frozen; `-1` is the
        // draft's "not yet placed" value.
        attachmentIndex: -1,
        attachmentName: picture.attachmentName,
        source: null,
      },
      mark,
    };
    return {
      id: nextCommentId(),
      anchor,
      note,
      attachmentId: picture.attachmentId,
    };
  }
  const anchor: CommentAnchor = {
    target: {
      kind: "image",
      attachmentIndex: picture.attachmentIndex,
      attachmentName: picture.attachmentName,
      source: picture.source,
    },
    mark,
  };
  // The composer keeps the readable location of an earlier message's picture so
  // the send can bake a marked copy of it; it is never stored (the annotation
  // record only has to say *which* picture, not how to read it).
  const imageSource = pictureSource(picture.src);
  return {
    id: nextCommentId(),
    anchor,
    note,
    ...(imageSource === undefined ? {} : { imageSource }),
  };
}

/**
 * Readable location of a picture URL: an on-disk path when the URL is `imb-file:`,
 * otherwise the URL itself (`blob:` for a chip's preview).
 */
function pictureSource(
  src: string | undefined,
): { path?: string; url?: string } | undefined {
  if (src === undefined || src.length === 0) return undefined;
  const path = parseImbFilePath(src);
  return path === null ? { url: src } : { path };
}

/** The picture a pending annotation points at, or `null` when it is not one. */
export function pendingPicture(comment: PendingComment): PictureRef | null {
  const target = comment.anchor.target;
  if (target.kind !== "image") return null;
  if (comment.attachmentId !== undefined) {
    return {
      kind: "draft",
      attachmentId: comment.attachmentId,
      attachmentName: target.attachmentName,
    };
  }
  if (target.source === null) return null;
  return {
    kind: "sent",
    source: target.source,
    attachmentIndex: target.attachmentIndex,
    attachmentName: target.attachmentName,
  };
}

/**
 * The marks a pending batch draws on one picture.
 *
 * Ordinals are the batch's own positions (`#1`, `#2`, … over text and picture
 * annotations alike), which is exactly the number the model will answer — so what
 * the badge says now is what the reply says later.
 */
export function pendingMarkViews(
  comments: readonly PendingComment[],
  picture: PictureRef,
): MarkView[] {
  const key = pictureKey(picture);
  const views: MarkView[] = [];
  comments.forEach((comment, index) => {
    const at = pendingPicture(comment);
    if (at === null || pictureKey(at) !== key) return;
    const mark = comment.anchor.mark;
    if (mark === undefined) return;
    views.push({
      key: String(comment.id),
      mark,
      ordinal: index + 1,
      note: comment.note,
    });
  });
  return views;
}

/**
 * The marks of one picture **as it appears in a draft chip**: pending annotations
 * only, addressed through the chip id.
 */
export function draftMarkViews(
  comments: readonly PendingComment[],
  attachmentId: number,
): MarkView[] {
  return pendingMarkViews(comments, {
    kind: "draft",
    attachmentId,
    attachmentName: "",
  });
}
