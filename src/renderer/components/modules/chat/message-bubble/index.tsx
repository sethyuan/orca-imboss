import { MAX_VISIBLE_ATTACHMENTS } from "@shared/constants/attachments";
import { isPreviewableImage } from "@shared/image-attachments";
import { toImbFileUrl } from "@shared/imb-file";
import { t } from "@shared/l10n";
import type { MessageAttachment } from "@shared/types";
import { useState } from "react";
import { cls } from "reactutils";
import { IconFile, IconFolder } from "../../../icons";
import { Markdown } from "../../../markdown";
import {
  IMAGE_PREVIEW_ENABLED,
  ImageStack,
  type ImageStackImage,
} from "../image-stack";
import "./index.css";

/** Shared empty set for a message with no failed image loads. */
const EMPTY_FAILED: ReadonlySet<number> = new Set();

export interface MessageBubbleProps {
  /** `true` = user message (right-aligned, green bubble). */
  self: boolean;
  /** Global message id; the reveal IPC resolves the stored path from it. */
  messageId: number;
  content: string;
  attachments: MessageAttachment[] | null;
  /**
   * True attachment count. May exceed `attachments.length` when an agent only
   * forwarded the first few; drives the `+N` overflow chip.
   */
  attachmentsTotal?: number | null;
  /** Avatar node (left side for other-messages, right side for self). */
  avatar: React.ReactNode;
  /**
   * Render `content` as Markdown + KaTeX instead of plain pre-wrapped text.
   * Only free-form prose kinds opt in (`text`, `report`); system/structured
   * kinds keep the literal rendering.
   */
  markdown?: boolean;
  /** Resolve `@<id>` mentions to employee names (Markdown path only). */
  resolveMention?: (id: number) => string | null;
  /** When set, a resolved mention becomes a button that opens the agent session. */
  onMentionClick?: (id: number) => void;
  /**
   * Exact send time, revealed at the bubble's bottom-right corner while the
   * row is hovered. The thread itself only shows a rough group divider, so
   * this is where the precise time stays reachable. `null` hides it.
   */
  timeLabel?: string | null;
}

export function MessageBubble({
  self,
  messageId,
  content,
  attachments,
  attachmentsTotal,
  avatar,
  markdown = false,
  resolveMention,
  onMentionClick,
  timeLabel,
}: MessageBubbleProps): React.JSX.Element {
  const [revealError, setRevealError] = useState<string | null>(null);
  // Attachment indices whose `imb-file:` image failed to load (missing file,
  // undecodable bytes) — they fall back to a plain file chip. Keyed by message
  // so a recycled bubble (no React key) cannot inherit a previous message's
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
  const total = Math.max(attachmentsTotal ?? all.length, all.length);
  const hidden = total - visible.length;

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
  const stack: ImageStackImage[] = imageSlots
    .filter((slot) => !failedImages.has(slot.index))
    .map((slot) => ({
      index: slot.index,
      name: slot.name,
      src: toImbFileUrl(slot.path),
    }));
  const imageIndices = new Set(imageSlots.map((slot) => slot.index));

  const chips = visible
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ index }) => !imageIndices.has(index) || failedImages.has(index));

  const showStack = stack.length > 0;
  // An image-only message drops the bubble chrome so the picture is not framed
  // by the bubble's color (the green self bubble skews how an image reads).
  const mediaOnly =
    showStack && content.length === 0 && chips.length === 0 && hidden === 0;

  const reveal = async (index: number): Promise<void> => {
    setRevealError(null);
    try {
      await imb.messages.revealAttachment(messageId, index);
    } catch (err) {
      setRevealError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={cls("imb-msg", self ? "imb-self" : "imb-other")}>
      {avatar}
      <div className={cls("imb-bubble", mediaOnly && "imb-bubble-media")}>
        {hasAttachments && (
          <div className="imb-bubble-attachments">
            {showStack && (
              <ImageStack
                images={stack}
                self={self}
                onImageError={markImageFailed}
              />
            )}
            {(chips.length > 0 || hidden > 0) && (
              <div className="imb-bubble-chips">
                {chips.map(({ attachment, index }) => {
                  const hasPath =
                    typeof attachment.path === "string" &&
                    attachment.path.length > 0;
                  return (
                    <button
                      key={`${attachment.name}-${attachment.size}-${index}`}
                      type="button"
                      className={cls(
                        "imb-bubble-chip",
                        !hasPath && "imb-bubble-chip-static",
                      )}
                      aria-disabled={!hasPath}
                      title={
                        hasPath
                          ? attachment.kind === "folder"
                            ? t("Open folder")
                            : t("Show in folder")
                          : t("File location is unavailable.")
                      }
                      onClick={hasPath ? () => void reveal(index) : undefined}
                    >
                      {attachment.kind === "folder" ? (
                        <IconFolder className="imb-icon imb-sm" />
                      ) : (
                        <IconFile className="imb-icon imb-sm" />
                      )}
                      <span className="imb-bubble-chip-name">
                        {attachment.name}
                      </span>
                      <span className="imb-bubble-chip-size">
                        {attachment.kind === "folder"
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
        )}
        {revealError !== null && (
          <div className="imb-bubble-attachment-error">{revealError}</div>
        )}
        {content.length > 0 &&
          (markdown ? (
            <Markdown
              content={content}
              resolveMention={resolveMention}
              onMentionClick={onMentionClick}
            />
          ) : (
            <span className="imb-bubble-text">{content}</span>
          ))}
        {timeLabel != null && timeLabel.length > 0 && (
          <span className="imb-bubble-time">{timeLabel}</span>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
