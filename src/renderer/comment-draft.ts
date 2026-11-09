import type { CommentAnchor, MessageComment } from "@shared/types";

/**
 * Composer-local comments: a comment annotates a passage of an **earlier**
 * message and waits in the composer until the boss sends something, at which
 * point it is frozen onto that message (`messages.comments`) and into its agent
 * prompt (`[Comments]` block — see `src/main/comment-prompt.ts`).
 *
 * Stored per surface in `appStore.chatComments` (per chat, both the chat thread
 * and an employee direct chat) and `appStore.sessionComments` (per
 * `(employee, chat)` session key, the agent-session view), so switching chats or
 * modules never loses an unsent comment — exactly like a draft's text and
 * attachments (`chat-draft.ts`). Session-only on purpose: an unsent comment is a
 * draft, and drafts do not survive an app restart in this app.
 */
export interface PendingComment {
  /** Local id: React key and store addressing (`nextCommentId()`). */
  id: number;
  /** Where the comment sits (target + quote + offsets). */
  anchor: CommentAnchor;
  /** What the boss wrote (multi-line, verbatim). */
  note: string;
}

/** How a thread exposes its comments to the comment layer and to its composer. */
export interface CommentSurface {
  /**
   * `"chat"` for a stored conversation thread (anchors name `messages` rows),
   * `"session"` for a rendered agent-session transcript (anchors name Pi session
   * entries). It only decides how a target id is read off a row; everything else
   * is shared.
   */
  kind: "chat" | "session";
  /** Comments waiting in the composer of this surface. */
  pending: readonly PendingComment[];
  /** Comments already sent, flattened out of the rows that carry them. */
  sent: readonly MessageComment[];
  /** Add one annotation of a passage (mints the local id). */
  add(anchor: CommentAnchor, note: string): void;
  /** Drop one pending comment. */
  remove(id: number): void;
}

/** Shared immutable fallback for a surface without pending comments. */
export const EMPTY_COMMENTS: readonly PendingComment[] = [];

/**
 * Monotonic id source for pending comments.
 *
 * Module-scoped (not per mount), like `nextAttachmentId()`: a draft restored
 * after a module switch can never collide with ids minted by a later mount,
 * including a StrictMode double-mount cycle.
 */
let commentSeq = 0;

/** Mint a fresh id for a pending comment. */
export function nextCommentId(): number {
  return commentSeq++;
}

/**
 * Rebuild one pending comment as a plain object.
 *
 * The composer reads its comments out of a valtio snapshot, where every nested
 * object is a `proxy-compare` proxy, and proxies cannot cross the Electron IPC
 * boundary. Rebuilding the known fields also pins the shape the main process
 * validates (`validateCommentsPayload`).
 */
export function toPlainComment(comment: PendingComment): MessageComment {
  const anchor: CommentAnchor = {
    target:
      comment.anchor.target.kind === "message"
        ? {
            kind: "message",
            messageId: comment.anchor.target.messageId,
          }
        : { kind: "entry", entryId: comment.anchor.target.entryId },
    quote: comment.anchor.quote,
    start: comment.anchor.start,
    end: comment.anchor.end,
    occurrence: comment.anchor.occurrence,
    textLength: comment.anchor.textLength,
  };
  return { anchor, note: comment.note };
}

/** Plain copies of a whole batch (`undefined` when there is nothing to send). */
export function toPlainComments(
  comments: readonly PendingComment[],
): MessageComment[] | undefined {
  if (comments.length === 0) return undefined;
  return comments.map(toPlainComment);
}
