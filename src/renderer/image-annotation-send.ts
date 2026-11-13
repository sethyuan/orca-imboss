/**
 * What a send does with image annotations: bake a marked copy for every picture that
 * carries one, then freeze the batch into the stored records.
 *
 * Both composers (a chat message, an agent-session prompt) go through this, so the
 * two paths cannot drift on the details that matter:
 *
 * - a picture of a **draft chip** is replaced **in place** by its marked copy, so the
 *   message carries one picture, not two, and the `[Attachments]` path the model
 *   reads is the picture the bubble shows (the invariant this feature must not
 *   break);
 * - a picture of an **earlier message** is baked into a new attachment appended after
 *   the others, with the record still pointing at the original (`of message #N`);
 * - nothing is ever written back over an original file;
 * - a failed bake **never blocks the send**: the original goes out and the coordinates
 *   still travel in `[Comments]`, which degrades the model's accuracy rather than the
 *   boss's intent (fact §8.1 of the interaction spec).
 */
import type { MessageAttachment, MessageComment } from "@shared/types";
import type { PendingAttachment } from "./chat-draft";
import { toPlainComments, type PendingComment } from "./comment-draft";
import {
  annotatedFileName,
  bakeAnnotatedCopy,
  type BakeMark,
} from "./image-annotation-bake";
import { pendingPicture } from "./image-annotation-draft";

/** A picture to bake, with everything the batch said about it. */
interface BakeGroup {
  /** Index in the outgoing attachment list this group belongs to (chips). */
  attachmentIndex?: number;
  /** Source to read pixels from. */
  source: { path?: string; url?: string };
  /** Suggested file name for the marked copy. */
  fileName: string;
  marks: BakeMark[];
}

export interface PreparedSend {
  /** Attachments to send, with marked copies in place / appended. */
  attachments: MessageAttachment[];
  /** Frozen annotation records (`undefined` when the batch is empty). */
  comments: MessageComment[] | undefined;
  /** One line per picture whose bake failed (the send still happened). */
  warnings: string[];
}

/** Group pending annotations by picture, keeping their `#n` ordinals. */
function groupByPicture(
  pending: readonly PendingComment[],
): Map<string, { comment: PendingComment; ordinal: number }[]> {
  const groups = new Map<
    string,
    { comment: PendingComment; ordinal: number }[]
  >();
  pending.forEach((comment, index) => {
    if (comment.anchor.target.kind !== "image") return;
    const picture = pendingPicture(comment);
    if (picture === null) return;
    const key =
      picture.kind === "draft"
        ? `draft:${picture.attachmentId}`
        : `sent:${
            picture.source.kind === "message"
              ? `m${picture.source.messageId}`
              : `e${picture.source.entryId}`
          }:${picture.attachmentIndex}`;
    const list = groups.get(key) ?? [];
    list.push({ comment, ordinal: index + 1 });
    groups.set(key, list);
  });
  return groups;
}

/**
 * Bake every annotated picture and return the attachment list plus the frozen
 * records.
 *
 * `chatId` decides where a marked copy is written; it is the chat the message will
 * be stored in, so a deleted conversation takes its copies with it.
 */
export async function prepareAnnotatedSend(input: {
  chatId: number;
  attachments: readonly MessageAttachment[];
  /** The composer's chips, for resolving a chip-bound annotation to its index. */
  draftAttachments: readonly PendingAttachment[];
  pending: readonly PendingComment[];
}): Promise<PreparedSend> {
  const groups = groupByPicture(input.pending);
  if (groups.size === 0) {
    return {
      attachments: [...input.attachments],
      comments: toPlainComments(input.pending, input.draftAttachments),
      warnings: [],
    };
  }
  const attachments = input.attachments.map((attachment) => ({
    ...attachment,
  }));
  // The chips as they will be *after* the bakes: the frozen records must name the
  // attachment the message ends up carrying (the marked copy), because that is the
  // file the drift check and the model's `[Attachments]` line will see.
  const chips = input.draftAttachments.map((item) => ({
    id: item.id,
    attachment: { ...item.attachment },
  }));
  const warnings: string[] = [];
  /** A chip's replacement needs the chip id to resolve its index late. */
  const chipReplacements: { attachmentId: number; group: BakeGroup }[] = [];
  const appended: BakeGroup[] = [];
  for (const entries of groups.values()) {
    const first = entries[0]?.comment;
    if (first === undefined) continue;
    const picture = pendingPicture(first);
    if (picture === null) continue;
    const marks: BakeMark[] = entries.flatMap((entry) => {
      const mark = entry.comment.anchor.mark;
      return mark === undefined ? [] : [{ mark, ordinal: entry.ordinal }];
    });
    if (picture.kind === "draft") {
      chipReplacements.push({
        attachmentId: picture.attachmentId,
        group: {
          source: {
            path: input.draftAttachments.find(
              (item) => item.id === picture.attachmentId,
            )?.attachment.path,
          },
          fileName: annotatedFileName(picture.attachmentName),
          marks,
        },
      });
      continue;
    }
    // A picture of an earlier message: read it from its own location, and append
    // the marked copy this message carries.
    appended.push({
      source: first.imageSource ?? {},
      fileName: annotatedFileName(picture.attachmentName),
      marks,
    });
  }
  for (const replacement of chipReplacements) {
    const index = input.draftAttachments.findIndex(
      (item) => item.id === replacement.attachmentId,
    );
    if (index < 0 || attachments[index] === undefined) continue;
    // The chip itself is the original file: bake from *it*, never from a previous
    // marked copy, so a picture annotated twice is one bake with both batches.
    const source = { path: attachments[index]?.path };
    const fileName = replacement.group.fileName;
    try {
      const { attachment } = await bakeAnnotatedCopy({
        source,
        marks: replacement.group.marks,
        chatId: input.chatId,
        fileName,
      });
      attachments[index] = attachment;
      chips[index] = { ...chips[index]!, attachment };
    } catch (err) {
      warnings.push(describeFailure(replacement.group.fileName, err));
    }
  }
  for (const group of appended) {
    try {
      const { attachment } = await bakeAnnotatedCopy({
        source: group.source,
        marks: group.marks,
        chatId: input.chatId,
        fileName: group.fileName,
      });
      attachments.push(attachment);
    } catch (err) {
      warnings.push(describeFailure(group.fileName, err));
    }
  }
  return {
    attachments,
    // Freeze *after* the bakes: an annotation of this message's own picture names
    // the attachment that ends up in the message (the marked copy).
    comments: toPlainComments(input.pending, chips),
    warnings,
  };
}

/** One human line for a bake that did not happen. */
function describeFailure(fileName: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  // Also logged: the boss sees one line in the composer, but whoever debugs why a
  // marked copy is missing needs the stack, not the sentence.
  console.error(`[image-annotation] bake failed for ${fileName}:`, error);
  return `${fileName}: ${detail}`;
}
