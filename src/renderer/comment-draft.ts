import type {
  CommentAnchor,
  ImageTargetSource,
  MessageComment,
} from "@shared/types";
import type { PendingAttachment } from "./chat-draft";

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
  /**
   * Where the annotation sits: the quoted passage (with its offsets), or a
   * picture plus its geometry.
   */
  anchor: CommentAnchor;
  /** What the boss wrote (multi-line, verbatim). */
  note: string;
  /**
   * Draft-only source of the annotated picture, for a picture that already belongs
   * to an earlier message: the composer has to be able to bake a marked copy from
   * the original pixels at send time, and the annotation record itself only keeps
   * *where* the picture is, not how to read it.
   */
  imageSource?: { path?: string; url?: string };
  /**
   * Draft-only binding for an image annotation: the composer **chip** whose
   * picture it annotates.
   *
   * A chip is addressed by id while it is still a draft, because its position in
   * the list changes whenever an earlier chip is removed — an index recorded at
   * annotate time would silently start pointing at the neighbouring picture. The
   * index is therefore resolved from this id at send time
   * ({@link freezeComments}), which is also where an annotation whose chip is
   * gone gets dropped.
   */
  attachmentId?: number;
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
 * Rebuild one pending comment as a plain object, or `null` when it cannot be
 * sent as it stands (an image annotation whose chip is gone).
 *
 * The composer reads its comments out of a valtio snapshot, where every nested
 * object is a `proxy-compare` proxy, and proxies cannot cross the Electron IPC
 * boundary. Rebuilding the known fields also pins the shape the main process
 * validates (`validateCommentsPayload`).
 *
 * `attachments` is the draft the image annotations belong to; it is what turns a
 * chip id into the attachment index the record stores.
 */
export function toPlainComment(
  comment: PendingComment,
  attachments: readonly PendingAttachment[] = EMPTY_ATTACHMENTS,
): MessageComment | null {
  const target = comment.anchor.target;
  if (target.kind === "image") {
    const index = resolveImageTargetIndex(comment, attachments);
    if (index === null) return null;
    const mark = comment.anchor.mark;
    if (mark === undefined) return null;
    // A picture of *this* message is named after the attachment that carries it —
    // which, after a bake, is the marked copy, and the drift check compares against
    // exactly that. A picture of an earlier message keeps the name it had there.
    const attachmentName =
      target.source === null
        ? (attachments[index]?.attachment.name ?? target.attachmentName)
        : target.attachmentName;
    return {
      anchor: {
        target: {
          kind: "image",
          attachmentIndex: index,
          attachmentName,
          // Rebuilt field by field, never passed through: the source comes from a
          // valtio snapshot, and a proxy cannot cross the IPC boundary ("An object
          // could not be cloned.") — which killed the send *and* the batch.
          source: plainSource(target.source),
        },
        mark: {
          kind: mark.kind,
          ...(mark.x === undefined ? {} : { x: mark.x }),
          ...(mark.y === undefined ? {} : { y: mark.y }),
          ...(mark.x2 === undefined ? {} : { x2: mark.x2 }),
          ...(mark.y2 === undefined ? {} : { y2: mark.y2 }),
          imageWidth: mark.imageWidth,
          imageHeight: mark.imageHeight,
        },
      },
      note: comment.note,
    };
  }
  const anchor: CommentAnchor = {
    target:
      target.kind === "message"
        ? { kind: "message", messageId: target.messageId }
        : { kind: "entry", entryId: target.entryId },
    quote: comment.anchor.quote ?? "",
    start: comment.anchor.start,
    end: comment.anchor.end,
    occurrence: comment.anchor.occurrence,
    textLength: comment.anchor.textLength,
  };
  return { anchor, note: comment.note };
}

/** A plain copy of an image target's owner (`null` stays `null`). */
function plainSource(
  source: ImageTargetSource | null,
): ImageTargetSource | null {
  if (source === null) return null;
  return source.kind === "message"
    ? { kind: "message", messageId: source.messageId }
    : { kind: "entry", entryId: source.entryId };
}

/** Shared immutable fallback for "no draft attachments". */
const EMPTY_ATTACHMENTS: readonly PendingAttachment[] = [];

/**
 * The attachment index an image annotation refers to, in the draft's current
 * chip order, or `null` when its picture is no longer attached.
 *
 * A draft annotation (`attachmentId` set) is resolved against the chips; one
 * already frozen to an index keeps that index.
 */
export function resolveImageTargetIndex(
  comment: PendingComment,
  attachments: readonly PendingAttachment[],
): number | null {
  const target = comment.anchor.target;
  if (target.kind !== "image") return null;
  if (comment.attachmentId === undefined) {
    return target.attachmentIndex >= 0 ? target.attachmentIndex : null;
  }
  const index = attachments.findIndex(
    (item) => item.id === comment.attachmentId,
  );
  return index >= 0 ? index : null;
}

/**
 * Plain copies of a whole batch (`undefined` when there is nothing to send).
 *
 * Annotations of a picture that is no longer attached are dropped here, so a
 * batch can never name an attachment the message does not carry.
 */
export function toPlainComments(
  comments: readonly PendingComment[],
  attachments: readonly PendingAttachment[] = EMPTY_ATTACHMENTS,
): MessageComment[] | undefined {
  if (comments.length === 0) return undefined;
  const plain: MessageComment[] = [];
  for (const comment of comments) {
    const item = toPlainComment(comment, attachments);
    if (item !== null) plain.push(item);
  }
  return plain.length === 0 ? undefined : plain;
}
