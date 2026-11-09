import { t } from "@shared/l10n";
import { useEffect, useRef, useState } from "react";
import { MAX_COMMENT_NOTE_LENGTH } from "@shared/constants/comments";
import { cls } from "reactutils";
import { IconTrash } from "../../../icons";
import { IconButton } from "../../../icon-button";
import type { PendingComment } from "../../../../comment-draft";
import "./index.css";

export interface PendingCommentsProps {
  /** Comments waiting to be sent with the next message, in the order written. */
  comments: readonly PendingComment[];
  /** Replace one comment's note (its anchor and quote are never touched). */
  onEdit: (id: number, note: string) => void;
  /** Drop one of them (the boss changed their mind before sending). */
  onRemove: (id: number) => void;
}

/** The row being edited, with the text the boss is typing (not yet committed). */
interface EditState {
  id: number;
  text: string;
}

/**
 * The comments queued for the next send, inside the composer card above the
 * textarea — the same slot the attachment chips use, because a pending comment is
 * the same kind of thing: part of the draft that has not been sent yet.
 *
 * One row per comment, in the order the agent will answer them (`#1`, `#2`, …).
 * The ordinals are real text (not decoration): they are the ids the agent replies
 * with, so a row reads as "`#1` — this passage — this note".
 *
 * **Clicking anywhere in a row** — the quoted passage, the note, the blank space
 * between them — edits that comment in place. The remove button is the one
 * exception: it only deletes (`stopPropagation`). Keyboard users reach the same
 * action through the note, which stays a real button, so the row never becomes a
 * click-only target and `Tab` order is unchanged (note → remove, in DOM order).
 *
 * Only the note is editable — the anchor and the quoted passage stay exactly as
 * recorded, which is what keeps the inline highlight and the ordinal stable.
 *
 * The editor is keyboard-driven, like the rest of the app's composers: `Enter`
 * saves, `Shift+Enter` breaks the line, an Enter that belongs to an IME candidate
 * never saves, and `Esc` discards the edit (the stored note is untouched until
 * save, so "cancel" is just dropping the draft text). Leaving the field also
 * saves — a comment must not be lost because the boss clicked somewhere else.
 * The row therefore grows by two lines (editor + key hint) and needs no
 * Save/Cancel buttons of its own.
 */
export function PendingComments({
  comments,
  onEdit,
  onRemove,
}: PendingCommentsProps): React.JSX.Element | null {
  const [edit, setEdit] = useState<EditState | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  // Set right before an `Esc` cancel so the resulting blur does not save the text
  // the boss just discarded.
  const skipBlurCommitRef = useRef(false);

  // Focus the editor once it exists. It is inside an always-visible composer (no
  // measured/hidden first pass like the floating panel), so the element is
  // visible here and `focus()` works; the caret goes to the end.
  useEffect(() => {
    const field = editorRef.current;
    if (field === null) return;
    field.focus({ preventScroll: true });
    const end = field.value.length;
    field.setSelectionRange(end, end);
  }, [edit?.id]);

  if (comments.length === 0) return null;

  /** Save the edit. An empty note is refused (the stored text stays). */
  const commit = (allowEmpty = false): void => {
    if (edit === null) return;
    const value = edit.text.trim();
    // An empty comment is not a comment: on `Enter` the editor stays open so the
    // boss can keep typing; on blur the edit is simply dropped.
    if (value.length === 0) {
      if (!allowEmpty) return;
      setEdit(null);
      return;
    }
    onEdit(edit.id, value);
    setEdit(null);
  };

  /** Discard the edit; the stored note is never touched before `commit`. */
  const cancel = (): void => {
    skipBlurCommitRef.current = true;
    setEdit(null);
  };

  return (
    <ul className="imb-comment-pending" aria-label={t("Comments to send")}>
      {comments.map((comment, index) => {
        const editing = edit !== null && edit.id === comment.id;
        return (
          <li
            className={cls(
              "imb-comment-pending-row",
              editing && "imb-comment-pending-row-editing",
            )}
            key={comment.id}
            onClick={() => {
              // Anywhere in the row starts editing — except while it already is
              // (a click that lands in the textarea must keep its caret and its
              // drag-selection instead of re-entering the editor).
              if (editing) return;
              skipBlurCommitRef.current = false;
              setEdit({ id: comment.id, text: comment.note });
            }}
          >
            <span className="imb-comment-pending-ordinal">{`#${index + 1}`}</span>
            {/* No `title`: the native tooltip is not this app's design language,
                and the full passage stays readable where it was selected (it is
                only ellipsized visually — assistive tech reads it in full). */}
            <span className="imb-comment-pending-quote">
              {comment.anchor.quote}
            </span>
            {editing ? (
              <>
                <textarea
                  ref={editorRef}
                  className="imb-comment-pending-editor"
                  value={edit.text}
                  maxLength={MAX_COMMENT_NOTE_LENGTH}
                  rows={2}
                  aria-label={t("Edit comment")}
                  onChange={(event) =>
                    setEdit({ id: comment.id, text: event.target.value })
                  }
                  onBlur={() => {
                    // Clicking away keeps the edit; `Esc` is the only discard.
                    // (`skipBlurCommitRef` is set by `cancel`.)
                    if (skipBlurCommitRef.current) {
                      skipBlurCommitRef.current = false;
                      return;
                    }
                    commit(true);
                  }}
                  onKeyDown={(event) => {
                    // Same key contract as the chat composer and the comment
                    // panel: `Enter` saves, `Shift+Enter` breaks the line, Enter
                    // never takes an IME candidate away from the input method,
                    // and `Esc` discards.
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancel();
                      return;
                    }
                    if (event.key !== "Enter" || event.shiftKey) return;
                    if (event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    commit();
                  }}
                />
                <span className="imb-comment-pending-keyhint">
                  {t("Enter to save · Esc to cancel")}
                </span>
              </>
            ) : (
              <button
                type="button"
                className="imb-comment-pending-note"
                // The click bubbles to the row handler, which is what actually
                // starts editing (mouse anywhere in the row, keyboard here). The
                // label names the action without a native tooltip, and keeps the
                // note text inside the accessible name.
                aria-label={t("Edit comment: ${note}", { note: comment.note })}
              >
                {comment.note}
              </button>
            )}
            <IconButton
              className="imb-comment-pending-remove"
              label={t("Remove comment")}
              size={14}
              boxSize={22}
              onClick={(event) => {
                // Delete only: the press must not also open the editor through
                // the row's click handler.
                event.stopPropagation();
                onRemove(comment.id);
              }}
            >
              <IconTrash />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}
