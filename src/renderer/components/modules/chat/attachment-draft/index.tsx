import { MAX_COMMENTS_PER_MESSAGE } from "@shared/constants/comments";
import { isAnnotatedCopyName } from "@shared/constants/image-annotation";
import { t } from "@shared/l10n";
import type { ImageMark } from "@shared/types";
import { useEffect, useMemo, useState } from "react";
import { cls } from "reactutils";
import type { PendingAttachment } from "../../../../chat-draft";
import type { PendingComment } from "../../../../comment-draft";
import { draftMarkViews } from "../../../../image-annotation-draft";
import { IconChat, IconComment, IconFile, IconFolder } from "../../../icons";
import { Tooltip } from "../../../tooltip";
import type { MarkView } from "../image-annotation/marks-layer";
import type { LightboxAnnotation, LightboxImage } from "../image-lightbox";
import { ImageLightbox } from "../image-lightbox";
import "./index.css";

/**
 * Annotation of a **draft** picture, as the composer offers it.
 *
 * A draft picture is addressed by its chip id (`attachmentId`), so the marks are
 * resolved through that id and the marked copy replaces this very chip when the
 * message is sent — no second attachment, no duplicate picture.
 */
export interface DraftAnnotationProps {
  /** The whole pending batch (`#n` ordinals and the cap are the batch's). */
  comments: readonly PendingComment[];
  /** Commit a new mark on one chip (note first: it is required). */
  add: (
    attachmentId: number,
    attachmentName: string,
    mark: ImageMark,
    note: string,
  ) => void;
  /** Replace one pending annotation's note. */
  updateNote: (key: string, note: string) => void;
  /** Drop one pending annotation. */
  remove: (key: string) => void;
}

export interface DraftAttachmentChipsProps {
  /** Draft chips, in the order the boss attached them. */
  items: readonly PendingAttachment[];
  /** Drop one chip (index is its position in `items`). */
  onRemove: (item: PendingAttachment, index: number) => void;
  /**
   * Called after the full-screen image viewer closes. The composer uses it to
   * hand the caret back to its textarea; a card without a caret can omit it.
   */
  onViewerClose?: () => void;
  /** Extra class on the chip row (context-specific spacing). */
  className?: string;
  /** Annotation of the draft's pictures; omitted ⇒ chips are not annotatable. */
  annotation?: DraftAnnotationProps;
}

/**
 * The chips of an unsent draft: a thumbnail per image (press to open it full
 * screen), a kind icon for files/folders/conversations, the on-disk path as a
 * tooltip and a corner `×` to remove one.
 *
 * Shared by the chat composer and the ask card's answer, so "what an attached
 * file looks like before you send it" is one component rather than two that
 * slowly drift apart. Extracted verbatim from the composer — same markup, same
 * class names, same CSS.
 */
export function DraftAttachmentChips({
  items,
  onRemove,
  onViewerClose,
  className,
  annotation,
}: DraftAttachmentChipsProps): React.JSX.Element | null {
  // Full-screen viewer for the image chips: index within `previewables` (the
  // draft's image attachments), plus the chip rect the viewer grows out of.
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [lightboxOrigin, setLightboxOrigin] = useState<DOMRect | null>(null);
  /** Open the viewer straight into annotation mode (the chip's hover action). */
  const [lightboxAnnotating, setLightboxAnnotating] = useState(false);
  /** Chips whose thumbnail failed to decode — they fall back to the file icon. */
  const [failedPreviews, setFailedPreviews] = useState<ReadonlySet<number>>(
    () => new Set(),
  );

  /**
   * Image chips in draft order. A chip shows a thumbnail (and so can be opened
   * full screen) exactly when `toPendingAttachment` minted a `previewUrl` for
   * it: folders and conversation references never have one, and neither do
   * plain files. The viewer's index is a position in *this* list, not an
   * attachment index, so lookups always go through the chip's stable `id`.
   */
  const previewables = useMemo(
    () =>
      items.flatMap((item) =>
        item.previewUrl && !failedPreviews.has(item.id)
          ? [{ id: item.id, name: item.attachment.name, src: item.previewUrl }]
          : [],
      ),
    [items, failedPreviews],
  );

  // The draft's image chips can shrink under an open viewer (a sent draft has
  // its object URLs revoked), so drop a viewer whose position no longer exists
  // rather than leaving it pointing at a dead `blob:` URL.
  const previewCount = previewables.length;
  useEffect(() => {
    setLightbox((value) =>
      value === null || value < previewCount ? value : null,
    );
  }, [previewCount]);

  /**
   * Marks of the chip the viewer is showing: pending annotations bound to that
   * chip, numbered by their position in the batch (the number the model answers).
   */
  const marksOf = (attachmentId: number): MarkView[] =>
    annotation === undefined
      ? []
      : draftMarkViews(annotation.comments, attachmentId);
  const countOf = (attachmentId: number): number =>
    marksOf(attachmentId).length;
  const viewerImages: LightboxImage[] = previewables.map((preview) => ({
    name: preview.name,
    src: preview.src,
    ...(marksOf(preview.id).length === 0 ? {} : { marks: marksOf(preview.id) }),
  }));
  const viewerAnnotation: LightboxAnnotation | undefined =
    annotation === undefined
      ? undefined
      : {
          batchCount: annotation.comments.length,
          // A chip is always the original file (a marked copy only ever replaces it
          // at send time), but the guard stays: the naming rule is what decides, not
          // who is asking.
          canAnnotate: (index) => {
            const preview = previewables[index];
            return (
              preview !== undefined &&
              !isAnnotatedCopyName(preview.name) &&
              annotation.comments.length < MAX_COMMENTS_PER_MESSAGE
            );
          },
          autoStart: lightboxAnnotating,
          unavailableReason: t("Already ${count} annotations in this batch.", {
            count: String(MAX_COMMENTS_PER_MESSAGE),
          }),
          onCreate: (index, mark, note) => {
            const preview = previewables[index];
            if (preview === undefined) return;
            annotation.add(preview.id, preview.name, mark, note);
          },
          onEditNote: (_index, key, note) => annotation.updateNote(key, note),
          onRemove: (_index, key) => annotation.remove(key),
        };

  if (items.length === 0) return null;

  return (
    <>
      <div className={cls("imb-attached-files", className)}>
        {items.map((item, index) => {
          // Show the on-disk location so identical-looking chips (and nameless
          // thumbnails) can be told apart. Fall back to the name when no path is
          // available (e.g. a JS-constructed file).
          const location =
            item.attachment.path && item.attachment.path.length > 0
              ? item.attachment.path
              : item.attachment.name;
          return (
            <Tooltip
              key={item.id}
              placement="top"
              content={
                <span className="imb-attach-tooltip-path">{location}</span>
              }
            >
              <div className="imb-attached-file-thumb">
                {item.previewUrl && !failedPreviews.has(item.id) ? (
                  // The thumbnail is the viewer's affordance: press it to open
                  // the picture full screen. The remove button stays a sibling
                  // (absolutely positioned over the corner), so a remove never
                  // reaches this click handler.
                  <button
                    type="button"
                    className="imb-attached-file-open"
                    aria-label={t("Enlarge image")}
                    title={t("Enlarge image")}
                    onClick={(event) => {
                      // The viewer indexes `previewables`, which excludes
                      // non-image chips — map through the stable chip id.
                      const at = previewables.findIndex(
                        (preview) => preview.id === item.id,
                      );
                      if (at < 0) return;
                      setLightboxOrigin(
                        event.currentTarget.getBoundingClientRect(),
                      );
                      setLightboxAnnotating(false);
                      setLightbox(at);
                    }}
                  >
                    <img
                      src={item.previewUrl}
                      alt={item.attachment.name}
                      draggable={false}
                      onError={() =>
                        setFailedPreviews((prev) => {
                          const next = new Set(prev);
                          next.add(item.id);
                          return next;
                        })
                      }
                    />
                  </button>
                ) : (
                  <div className="imb-file-icon-placeholder">
                    {item.attachment.kind === "chat" ? (
                      <IconChat />
                    ) : item.attachment.kind === "folder" ? (
                      <IconFolder />
                    ) : (
                      <IconFile />
                    )}
                  </div>
                )}
                {annotation !== undefined &&
                  !isAnnotatedCopyName(item.attachment.name) && (
                    // The hot path: one click from "the picture I am about to send" to
                    // a mark on it, without hunting for the viewer's own button.
                    <button
                      type="button"
                      className="imb-attached-file-annotate"
                      aria-label={t("Annotate")}
                      title={t("Annotate")}
                      onClick={(event) => {
                        const at = previewables.findIndex(
                          (preview) => preview.id === item.id,
                        );
                        if (at < 0) return;
                        setLightboxOrigin(
                          event.currentTarget
                            .closest<HTMLElement>(".imb-attached-file-thumb")
                            ?.getBoundingClientRect() ?? null,
                        );
                        setLightboxAnnotating(true);
                        setLightbox(at);
                      }}
                    >
                      <IconComment className="imb-icon" />
                    </button>
                  )}
                {annotation !== undefined && countOf(item.id) > 0 && (
                  <span
                    className="imb-attached-file-marks"
                    aria-label={t("${count} annotations", {
                      count: String(countOf(item.id)),
                    })}
                  >
                    {countOf(item.id)}
                  </span>
                )}
                <button
                  type="button"
                  className="imb-attached-file-remove"
                  aria-label={`${t("Remove")} ${item.attachment.name}`}
                  onClick={() => onRemove(item, index)}
                >
                  ×
                </button>
              </div>
            </Tooltip>
          );
        })}
      </div>
      {lightbox !== null && (
        <ImageLightbox
          images={viewerImages}
          annotation={viewerAnnotation}
          index={lightbox}
          origin={lightboxOrigin}
          onIndexChange={setLightbox}
          onClose={() => {
            setLightbox(null);
            setLightboxOrigin(null);
            setLightboxAnnotating(false);
            onViewerClose?.();
          }}
        />
      )}
    </>
  );
}
