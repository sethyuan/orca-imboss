import { t } from "@shared/l10n";
import type { MessageComment } from "@shared/types";
import "./index.css";

export interface CommentCardsProps {
  comments: readonly MessageComment[];
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
  surface = "chat",
}: CommentCardsProps): React.JSX.Element | null {
  if (comments.length === 0) return null;
  return (
    <div className={`imb-comment-cards imb-comment-cards-${surface}`}>
      {comments.map((comment, index) => (
        <div
          className="imb-comment-card"
          key={`${index}-${comment.anchor.start}-${comment.note.length}`}
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
            <p className="imb-comment-card-quote">{comment.anchor.quote}</p>
            <p className="imb-comment-card-note">{comment.note}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
