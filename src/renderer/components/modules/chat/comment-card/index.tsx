import { t } from "@shared/l10n";
import type { ImageTargetSource, MessageComment } from "@shared/types";
import { cls } from "reactutils";
import { markKeyAt, useImageAnnotation } from "../image-annotation/context";
import { MarkThumb } from "../image-annotation/thumbs";
import "./index.css";

export interface CommentCardsProps {
  comments: readonly MessageComment[];
  /**
   * Which row carried these comments. Used to address the marks they point at, so
   * hovering a card can light up the mark on the picture it talks about — and the
   * other direction — across bubbles.
   */
  carrier?: ImageTargetSource;
  /**
   * Where the cards are drawn. `"chat"` is the bubble of a stored message,
   * `"session"` a rendered agent-session prompt row. Only the class suffix
   * differs; the content is the same (a quote plus what the boss wrote).
   */
  surface?: "chat" | "session";
}

/**
 * The comments a message was sent with, above its own content.
 *
 * Two card shapes share the list and the numbering, because the agent answers
 * `#1:`, `#2:`, … over both kinds in one pass:
 * - a **passage**: the quote plus the note;
 * - a **picture**: a thumbnail framed to the picture's aspect ratio with the mark
 *   on it (no pixels: the annotated picture belongs to an earlier message, whose
 *   attachments this row does not carry) plus the note.
 *
 * Reads top-down as "this is an excerpt of an earlier message, and this is what
 * the boss said about it" — the same order the agent gets in the `[Comments]`
 * block, so the boss can match a reply back to the card it answers. The quote is
 * capped to two lines: the passage itself stays highlighted in the message it
 * came from, so the card only has to say *which* one.
 *
 * Rendering is deliberately passive: a sent comment is part of the message's
 * context (it was delivered to the agent) and is never editable, exactly like
 * the message itself.
 */
export function CommentCards({
  comments,
  carrier,
  surface = "chat",
}: CommentCardsProps): React.JSX.Element | null {
  const annotation = useImageAnnotation();
  if (comments.length === 0) return null;
  return (
    <div className={`imb-comment-cards imb-comment-cards-${surface}`}>
      {comments.map((comment, index) => {
        const isImage = comment.anchor.mark !== undefined;
        const cardKey = carrier === undefined ? "" : markKeyAt(carrier, index);
        return (
          <div
            className={cls(
              "imb-comment-card",
              isImage &&
                annotation !== null &&
                annotation.focusKey === cardKey &&
                "imb-comment-card-focus",
            )}
            key={`${index}-${comment.anchor.start}-${comment.note.length}`}
            onMouseEnter={
              isImage && carrier !== undefined && annotation !== null
                ? () => annotation.setFocusKey(cardKey)
                : undefined
            }
            onMouseLeave={
              isImage && annotation !== null
                ? () => annotation.setFocusKey(null)
                : undefined
            }
            // The id the agent answers (`#1`, `#2`, …): the same ordinal the
            // `[Comments]` block carried, so a reply that starts with `#2:`
            // points at the second card.
            data-comment-ordinal={index + 1}
            title={t("Comment #${n} of this message", {
              n: String(index + 1),
            })}
          >
            <span className="imb-comment-card-ordinal" aria-hidden="true">
              {`#${index + 1}`}
            </span>
            <div className="imb-comment-card-body">
              {comment.anchor.mark === undefined ? (
                <p className="imb-comment-card-quote">{comment.anchor.quote}</p>
              ) : (
                <div className="imb-comment-card-image">
                  <MarkThumb
                    mark={comment.anchor.mark}
                    ordinal={index + 1}
                    note={comment.note}
                    width={64}
                    height={40}
                  />
                  <span className="imb-comment-card-image-name">
                    {comment.anchor.target.kind === "image"
                      ? comment.anchor.target.attachmentName
                      : ""}
                  </span>
                </div>
              )}
              <p className="imb-comment-card-note">{comment.note}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
