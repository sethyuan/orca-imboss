import { MAX_VISIBLE_ATTACHMENTS } from "@shared/constants/attachments";
import { isPreviewableImage } from "@shared/image-attachments";
import { toImbFileUrl } from "@shared/imb-file";
import { t } from "@shared/l10n";
import type { AgentSessionAttachment, ImageTargetSource } from "@shared/types";
import { useState } from "react";
import { cls } from "reactutils";
import { isAnnotatedCopyName } from "@shared/constants/image-annotation";
import { IconChat, IconFile, IconFolder } from "../../../icons";
import { AnnotatedCopies } from "../../chat/image-annotation/copies";
import {
  IMAGE_PREVIEW_ENABLED,
  ImageStack,
  type ImageStackImage,
} from "../../chat/image-stack";
// The bubble recipes are shared verbatim: attachments of a prompt must look the
// same as attachments of a chat message (chips *and* the image deck).
import "../../chat/message-attachments/index.css";
import "./index.css";

export interface SessionAttachmentsProps {
  /** Attachments a persisted user prompt carried (already parsed main-side). */
  attachments: readonly AgentSessionAttachment[];
  /**
   * Reveal a file/folder in the OS file manager (also the image deck's
   * "show in folder" action). Omitted → nothing on disk is addressable: the
   * chips are static and the viewer renders no reveal button (a "sent, not yet
   * persisted" placeholder row has no session entry to point at yet).
   */
  onReveal?: (index: number) => void;
  /** Open the conversation a `kind: "chat"` chip references. */
  onOpenConversation?: (chatId: number) => void;
  /** Extra class for the block (context-specific spacing). */
  className?: string;
  /**
   * Which session entry these pictures belong to, so an annotation can address one
   * of them ("image 1 of session entry …"). Omitted ⇒ not annotatable.
   */
  source?: ImageTargetSource;
}

/**
 * Whether a prompt row renders **only** the image deck: no text, and every
 * attachment is a previewable image with an on-disk path (so nothing lands in the
 * chip row).
 *
 * The chat bubble drops its own chrome in that case ("the green background
 * frames the picture and skews how it reads"), and the prompt row mirrors it —
 * one rule, computed the same way on both sides, instead of two visual dialects.
 * It is a metadata-only test: an image that fails to decode later still fits the
 * chat side's rule only because it moves into a chip there, while the prompt row
 * keeps the transparent chrome (a chip brings its own background, so it stays
 * readable).
 */
export function isMediaOnlyAttachments(
  attachments: readonly AgentSessionAttachment[],
  textLength: number,
): boolean {
  if (!IMAGE_PREVIEW_ENABLED) return false;
  if (textLength > 0) return false;
  if (attachments.length === 0) return false;
  if (attachments.length > MAX_VISIBLE_ATTACHMENTS) return false;
  return attachments.every(
    (attachment) =>
      attachment.kind === "file" &&
      attachment.path !== undefined &&
      attachment.path.length > 0 &&
      isPreviewableImage(attachment.type ?? "", attachment.name),
  );
}

/**
 * The attachments of one **prompt** in the agent-session transcript, rendered
 * exactly like a chat message's attachments:
 *
 * - **image files** become the shared `ImageStack` deck (single thumbnail, or a
 *   fanned stack with a `1 / N` count and the full-screen viewer) — the same
 *   component the chat bubble uses, not a look-alike;
 * - **files / folders / conversation references** stay chips (`.imb-bubble-chip`
 *   recipe: icon + name + size/kind, tooltip explains the click);
 * - an image whose `<img>` fails to load falls back to a file chip, exactly like
 *   the chat side does, so a moved file degrades instead of leaving a hole;
 * - past `MAX_VISIBLE_ATTACHMENTS` everything folds into a `+N` chip.
 *
 * The main process owns the parsing (`splitAttachmentPrompt`), so this component
 * only renders — it never sees raw prompt text. Thumbnails go through the
 * existing `imb-file:` protocol (previewable-image extensions only) and honour
 * `IMAGE_PREVIEW_ENABLED`, the same master switch the chat previews use.
 */
export function SessionAttachments({
  attachments,
  onReveal,
  onOpenConversation,
  className,
  source,
}: SessionAttachmentsProps): React.JSX.Element | null {
  /**
   * Attachment indices whose `<img>` failed to decode. Keyed by position within
   * the visible slice (the same key the chat side uses); a row remounts when the
   * entry changes, so a recycled row cannot inherit another entry's failures.
   */
  const [failedImages, setFailedImages] = useState<ReadonlySet<number>>(
    () => new Set(),
  );

  if (attachments.length === 0) return null;

  const visible = attachments.slice(0, MAX_VISIBLE_ATTACHMENTS);
  const hidden = Math.max(attachments.length - visible.length, 0);

  // Image slots, in attachment order: a previewable image that still resolves to
  // an on-disk path and has not failed to load.
  const imageSlots: { index: number; name: string; path: string }[] =
    IMAGE_PREVIEW_ENABLED
      ? visible.flatMap((attachment, index) => {
          if (attachment.kind !== "file") return [];
          const path = attachment.path;
          if (path === undefined || path.length === 0) return [];
          return isPreviewableImage(attachment.type ?? "", attachment.name)
            ? [{ index, name: attachment.name, path }]
            : [];
        })
      : [];
  const drawable: ImageStackImage[] = imageSlots
    .filter((slot) => !failedImages.has(slot.index))
    .map((slot) => ({
      index: slot.index,
      name: slot.name,
      src: toImbFileUrl(slot.path),
    }));
  // Same split as the chat bubble: a baked copy is a derived picture and is shown
  // compact, never at full size next to the original (`image-annotation/copies`).
  const copies = drawable.filter((image) => isAnnotatedCopyName(image.name));
  const stack = drawable.filter((image) => !isAnnotatedCopyName(image.name));
  const imageIndices = new Set(imageSlots.map((slot) => slot.index));

  // Everything that is not (still) an image in the deck: files, folders,
  // conversation references, and images that failed to load.
  const chips = visible
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ index }) => !imageIndices.has(index) || failedImages.has(index));

  return (
    <div
      className={cls(
        "imb-bubble-attachments",
        "imb-session-attachments",
        className,
      )}
    >
      {stack.length > 0 && (
        <ImageStack
          images={stack}
          source={source}
          // A prompt row is the boss's own message (right-aligned), so the deck
          // leans away from the outer edge exactly like a self chat bubble.
          self
          onImageError={(index) =>
            setFailedImages((prev) => {
              const next = new Set(prev);
              next.add(index);
              return next;
            })
          }
          onRevealImage={
            onReveal === undefined ? undefined : (index) => onReveal(index)
          }
        />
      )}
      <AnnotatedCopies
        copies={copies}
        onReveal={onReveal === undefined ? undefined : (index) => onReveal(index)}
      />
      {(chips.length > 0 || hidden > 0) && (
        <div className="imb-bubble-chips">
          {chips.map(({ attachment, index }) => {
            const chatId =
              attachment.kind === "chat" &&
              typeof attachment.chatId === "number" &&
              attachment.chatId > 0
                ? attachment.chatId
                : null;
            const revealable = chatId === null && onReveal !== undefined;
            const clickable = chatId !== null || revealable;
            const detail =
              chatId !== null
                ? t("Conversation")
                : attachment.kind === "folder"
                  ? t("Folder")
                  : (attachment.sizeLabel ?? "");
            const title =
              chatId !== null
                ? t("Open conversation")
                : attachment.path !== undefined && attachment.path.length > 0
                  ? attachment.path
                  : t("File location is unavailable.");
            const onClick = (): void => {
              if (revealable) {
                onReveal(index);
                return;
              }
              if (chatId !== null) {
                onOpenConversation?.(chatId);
              }
            };
            return (
              <button
                key={`${attachment.kind}-${attachment.name}-${index}`}
                type="button"
                className={cls(
                  "imb-bubble-chip",
                  !clickable && "imb-bubble-chip-static",
                )}
                aria-disabled={!clickable}
                title={title}
                onClick={clickable ? onClick : undefined}
              >
                {chatId !== null ? (
                  <IconChat className="imb-icon imb-sm" />
                ) : attachment.kind === "folder" ? (
                  <IconFolder className="imb-icon imb-sm" />
                ) : (
                  <IconFile className="imb-icon imb-sm" />
                )}
                <span className="imb-bubble-chip-name">{attachment.name}</span>
                {detail.length > 0 && (
                  <span className="imb-bubble-chip-size">{detail}</span>
                )}
              </button>
            );
          })}
          {hidden > 0 && (
            <span
              className="imb-bubble-chip imb-bubble-chip-more"
              title={t("${count} attachments in total", {
                count: String(attachments.length),
              })}
            >
              {`+${hidden}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
