import { isAttachmentOnlyBlurb } from "@shared/attachment-blurb";
import type { MessageAttachment, MessageComment } from "@shared/types";
import { cls } from "reactutils";
import { Markdown } from "../../../markdown";
import { CommentCards } from "../comment-card";
import {
  isMediaOnly,
  MessageAttachments,
  useMessageAttachments,
} from "../message-attachments";
import { MessageTime } from "../message-time";
import "./index.css";

export interface MessageBubbleProps {
  /** `true` = user message (right-aligned, green bubble). */
  self: boolean;
  /** Global message id; the reveal IPC resolves the stored path from it. */
  messageId: number;
  content: string;
  attachments: MessageAttachment[] | null;
  /**
   * Comments this message was sent with (annotations of earlier messages).
   * Rendered above the message's own words — see `../comment-card`.
   */
  comments?: MessageComment[] | null;
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
  /**
   * Raw Markdown source to offer behind the "Copy as Markdown" button beside
   * the time tag. `null`/undefined/blank renders no button. Deciding *whether*
   * a row qualifies lives in `message-item` (`chat/copy-markdown.ts`).
   */
  copyMarkdown?: string | null;
}

/**
 * The generic message row: avatar + bubble, with the attachment block above the
 * body. Attachment rendering itself lives in `../message-attachments` so the
 * structured cards (`AskCard`, `AnswerCard`) show the very same thing.
 */
export function MessageBubble({
  self,
  messageId,
  content,
  attachments,
  comments = null,
  attachmentsTotal,
  avatar,
  markdown = false,
  resolveMention,
  onMentionClick,
  timeLabel,
  copyMarkdown,
}: MessageBubbleProps): React.JSX.Element {
  const attachmentView = useMessageAttachments({
    messageId,
    attachments,
    attachmentsTotal,
  });
  // A send that carried only files stores the generated `Attached: …` blurb as its
  // text. It is a duplicate of the thumbnails/chips above (and English baked into the
  // row), so it is not rendered — and the row is then treated as attachment-only.
  const blurbOnly = isAttachmentOnlyBlurb(content, attachments);
  const body = blurbOnly ? "" : content;
  const mediaOnly = isMediaOnly(attachmentView, body.length);

  return (
    <div
      className={cls("imb-msg", self ? "imb-self" : "imb-other")}
      // Anchor for in-thread jumps (the root chat's "my messages" list). Text
      // bubbles are the only kind the boss writes, so tagging this row covers
      // every jump target without touching the other message kinds.
      data-message-id={messageId}
      // Boxing a comment on this row: the bubble's prose (`..imb-markdown` /
      // `.imb-bubble-text`) is what `comment-layer` lets the boss select, and the
      // id it records comes from this attribute.
      data-commentable="1"
    >
      {avatar}
      <div className={cls("imb-bubble", mediaOnly && "imb-bubble-media")}>
        <MessageAttachments view={attachmentView} self={self} />
        <CommentCards
          comments={comments ?? []}
          carrier={{ kind: "message", messageId }}
        />
        {body.length > 0 &&
          (markdown ? (
            <Markdown
              content={body}
              resolveMention={resolveMention}
              onMentionClick={onMentionClick}
            />
          ) : (
            <span className="imb-bubble-text">{body}</span>
          ))}
        <MessageTime label={timeLabel} copyMarkdown={copyMarkdown} />
      </div>
    </div>
  );
}
