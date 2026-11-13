import { MAX_VISIBLE_ATTACHMENTS } from "@shared/constants/attachments";
import { isPreviewableImage } from "@shared/image-attachments";
import { toImbFileUrl } from "@shared/imb-file";
import { t } from "@shared/l10n";
import type { ImageTargetSource, MessageAttachment } from "@shared/types";
import { useState } from "react";
import { cls } from "reactutils";
import { appStore } from "../../../../app-store";
import { IconChat, IconFile, IconFolder } from "../../../icons";
import { isAnnotatedCopyName } from "@shared/constants/image-annotation";
import { AnnotatedCopies } from "../image-annotation/copies";
import {
  IMAGE_PREVIEW_ENABLED,
  ImageStack,
  type ImageStackImage,
} from "../image-stack";
import "./index.css";

/** Shared empty set for a message with no failed image loads. */
const EMPTY_FAILED: ReadonlySet<number> = new Set();

/** One non-image (or failed-image) attachment rendered as a clickable chip. */
export interface AttachmentChip {
  attachment: MessageAttachment;
  /** Index within the message's attachments; what the reveal IPC takes. */
  index: number;
}

/**
 * Everything one message's attachment block needs, derived once by
 * `useMessageAttachments` and rendered by `<MessageAttachments>`.
 *
 * The split exists so the *owner* of the row can decide layout from the same
 * facts the block renders from (a bubble drops its chrome for an image-only
 * message, see `isMediaOnly`) without a second copy of the attachment logic.
 */
export interface MessageAttachmentsView {
  /** `false` ⇒ the block renders nothing (message carries no attachment). */
  hasAttachments: boolean;
  /** True attachment count; may exceed the forwarded subset (`+N` chip). */
  total: number;
  /** Attachments folded into the `+N` chip instead of being rendered. */
  hidden: number;
  /** Images rendered as the preview stack (in message order). */
  stack: ImageStackImage[];
  /**
   * Marked copies (`annotated-*`): rendered as compact thumbnails with a label, not
   * at full size — they are derived pictures, and the original they came from is
   * still in the conversation it belongs to.
   */
  copies: ImageStackImage[];
  /** Non-image / failed-image attachments rendered as chips, in message order. */
  chips: AttachmentChip[];
  /** At least one image survived to the stack. */
  showStack: boolean;
  /** Which row the pictures belong to, for image annotations. */
  source: ImageTargetSource;
  /** Inline error from the last reveal / open-conversation attempt. */
  revealError: string | null;
  /** Drop an attachment index from the stack (its `<img>` failed to load). */
  markImageFailed: (index: number) => void;
  /** Reveal one attachment in the OS file manager. */
  reveal: (index: number) => void;
  /** Open the conversation a `kind: "chat"` attachment references. */
  openConversation: (chatId: number) => void;
}

export interface UseMessageAttachmentsOptions {
  /** Global message id; the reveal IPC resolves the stored path from it. */
  messageId: number;
  /**
   * How an annotation addresses these pictures. Defaults to the chat message
   * itself; an agent-session row overrides it with its entry id.
   */
  source?: ImageTargetSource;
  attachments: MessageAttachment[] | null;
  /**
   * True attachment count. May exceed `attachments.length` when an agent only
   * forwarded the first few; drives the `+N` overflow chip.
   */
  attachmentsTotal?: number | null;
}

/**
 * Attachment state for one message row: the visible split (image stack vs file
 * chips vs `+N` overflow), the failed-image fallback set, and the reveal /
 * open-conversation actions with their inline error.
 *
 * Shared by every row kind that shows attachments — the generic `MessageBubble`
 * and the structured cards (`AskCard`, `AnswerCard`) — so a card can never
 * silently drop the attachments its payload carries. Keep this the only
 * implementation: a card that renders its own layout must use it too.
 */
export function useMessageAttachments({
  messageId,
  attachments,
  attachmentsTotal,
  source = { kind: "message", messageId },
}: UseMessageAttachmentsOptions): MessageAttachmentsView {
  const [revealError, setRevealError] = useState<string | null>(null);
  // Attachment indices whose `imb-file:` image failed to load (missing file,
  // undecodable bytes) — they fall back to a plain file chip. Keyed by message
  // so a recycled row (no React key) cannot inherit a previous message's
  // failures.
  const [failedState, setFailedState] = useState<{
    messageId: number;
    indices: ReadonlySet<number>;
  }>(() => ({ messageId, indices: new Set() }));
  const failedImages =
    failedState.messageId === messageId ? failedState.indices : EMPTY_FAILED;
  const markImageFailed = (index: number): void =>
    setFailedState((prev) => {
      const indices =
        prev.messageId === messageId
          ? new Set(prev.indices)
          : new Set<number>();
      indices.add(index);
      return { messageId, indices };
    });

  const all = attachments ?? [];
  const hasAttachments = all.length > 0;
  const visible = all.slice(0, MAX_VISIBLE_ATTACHMENTS);
  // A junk `attachmentsTotal` (non-integer, negative) falls back to the real
  // list length rather than producing a nonsense `+N`.
  const declared =
    typeof attachmentsTotal === "number" &&
    Number.isSafeInteger(attachmentsTotal) &&
    attachmentsTotal > 0
      ? attachmentsTotal
      : 0;
  const total = Math.max(declared, all.length);
  const hidden = Math.max(total - visible.length, 0);

  // Visible attachments renderable as images: a previewable format with an
  // on-disk path (the `imb-file:` URL is derived from it directly; main never
  // reads the bytes). Gated by the feature's master switch — disabled, every
  // attachment stays a plain file chip.
  const imageSlots: { index: number; name: string; path: string }[] =
    IMAGE_PREVIEW_ENABLED
      ? visible.flatMap((attachment, index) => {
          const path = attachment.path;
          return typeof path === "string" &&
            path.length > 0 &&
            isPreviewableImage(attachment.type, attachment.name)
            ? [{ index, name: attachment.name, path }]
            : [];
        })
      : [];

  // Images still in the stack (those whose `<img>` has not errored) plus the
  // non-image / failed chips.
  const drawable: ImageStackImage[] = imageSlots
    .filter((slot) => !failedImages.has(slot.index))
    .map((slot) => ({
      index: slot.index,
      name: slot.name,
      src: toImbFileUrl(slot.path),
    }));
  // A baked copy is the *delivered* form of a picture that already appeared in the
  // conversation, so it is shown compact (decision ⑥) instead of at full size.
  const copies = drawable.filter((image) => isAnnotatedCopyName(image.name));
  const stack = drawable.filter((image) => !isAnnotatedCopyName(image.name));
  const imageIndices = new Set(imageSlots.map((slot) => slot.index));

  const chips: AttachmentChip[] = visible
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ index }) => !imageIndices.has(index) || failedImages.has(index));

  const reveal = (index: number): void => {
    setRevealError(null);
    // Wrapped in an async IIFE (not `.catch()` on the returned value) so a
    // bridge that is missing the method degrades to the inline error instead of
    // throwing out of the click handler.
    void (async (): Promise<void> => {
      try {
        await imb.messages.revealAttachment(messageId, index);
      } catch (err) {
        setRevealError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  // A chat attachment is a reference, not a file: clicking it opens the
  // referenced conversation instead of revealing anything on disk. Root chats
  // open in the Chat module; a (defensively handled) group chat opens as a Nav
  // entry. A missing referenced chat surfaces the same inline error slot.
  const openConversation = (chatId: number): void => {
    setRevealError(null);
    void (async (): Promise<void> => {
      try {
        const summary = await imb.chats.summary(chatId);
        if (!summary) {
          setRevealError(t("Conversation unavailable"));
          return;
        }
        if (summary.fromChatId === null) {
          await appStore.focusChat(summary.id);
        } else {
          appStore.openChat(summary);
        }
      } catch (err) {
        setRevealError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  return {
    hasAttachments,
    total,
    hidden,
    stack,
    copies,
    chips,
    showStack: stack.length > 0,
    source,
    revealError,
    markImageFailed,
    reveal,
    openConversation,
  };
}

/**
 * An image-only message should drop the bubble chrome: the green (self) /
 * surface (other) background frames the picture and skews how it reads, so the
 * images sit directly on the thread background instead.
 */
export function isMediaOnly(
  view: MessageAttachmentsView,
  contentLength: number,
): boolean {
  return (
    view.showStack &&
    contentLength === 0 &&
    view.chips.length === 0 &&
    view.hidden === 0
  );
}

export interface MessageAttachmentsProps {
  view: MessageAttachmentsView;
  /** `true` = the row is the boss's own; the preview deck leans the other way. */
  self: boolean;
}

/**
 * The attachment block of one message: the image preview stack, the file /
 * folder / conversation chips, the `+N` overflow chip and the inline reveal
 * error. Renders nothing when the message carries no attachment.
 *
 * Presentational on purpose — call `useMessageAttachments` for the `view`.
 */
export function MessageAttachments({
  view,
  self,
}: MessageAttachmentsProps): React.JSX.Element | null {
  if (!view.hasAttachments) return null;
  const { stack, copies, chips, hidden, total, revealError } = view;
  return (
    <>
      <div className="imb-bubble-attachments">
        {view.showStack && (
          <ImageStack
            images={stack}
            source={view.source}
            self={self}
            onImageError={view.markImageFailed}
            onRevealImage={(index) => view.reveal(index)}
          />
        )}
        <AnnotatedCopies
          copies={copies}
          onReveal={(index) => view.reveal(index)}
        />
        {(chips.length > 0 || hidden > 0) && (
          <div className="imb-bubble-chips">
            {chips.map(({ attachment, index }) => {
              const chatId =
                attachment.kind === "chat" &&
                typeof attachment.chatId === "number"
                  ? attachment.chatId
                  : null;
              const hasPath =
                typeof attachment.path === "string" &&
                attachment.path.length > 0;
              const clickable = chatId !== null || hasPath;
              return (
                <button
                  key={`${attachment.name}-${attachment.size}-${index}`}
                  type="button"
                  className={cls(
                    "imb-bubble-chip",
                    !clickable && "imb-bubble-chip-static",
                  )}
                  aria-disabled={!clickable}
                  title={
                    chatId !== null
                      ? t("Open conversation")
                      : hasPath
                        ? attachment.kind === "folder"
                          ? t("Open folder")
                          : t("Show in folder")
                        : t("File location is unavailable.")
                  }
                  onClick={
                    chatId !== null
                      ? () => view.openConversation(chatId)
                      : hasPath
                        ? () => view.reveal(index)
                        : undefined
                  }
                >
                  {chatId !== null ? (
                    <IconChat className="imb-icon imb-sm" />
                  ) : attachment.kind === "folder" ? (
                    <IconFolder className="imb-icon imb-sm" />
                  ) : (
                    <IconFile className="imb-icon imb-sm" />
                  )}
                  <span className="imb-bubble-chip-name">
                    {attachment.name}
                  </span>
                  <span className="imb-bubble-chip-size">
                    {chatId !== null
                      ? t("Conversation")
                      : attachment.kind === "folder"
                        ? t("Folder")
                        : formatSize(attachment.size)}
                  </span>
                </button>
              );
            })}
            {hidden > 0 && (
              <span
                className="imb-bubble-chip imb-bubble-chip-more"
                title={t("${count} attachments in total", {
                  count: String(total),
                })}
              >
                {`+${hidden}`}
              </span>
            )}
          </div>
        )}
      </div>
      {revealError !== null && (
        <div className="imb-bubble-attachment-error">{revealError}</div>
      )}
    </>
  );
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
