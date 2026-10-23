import type { MessageAttachment } from "@shared/types";
import { cls } from "reactutils";
import { Markdown } from "../../../markdown";
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
  const mediaOnly = isMediaOnly(attachmentView, content.length);

  return (
    <div
      className={cls("imb-msg", self ? "imb-self" : "imb-other")}
      // Anchor for in-thread jumps (the root chat's "my messages" list). Text
      // bubbles are the only kind the boss writes, so tagging this row covers
      // every jump target without touching the other message kinds.
      data-message-id={messageId}
    >
      {avatar}
      <div className={cls("imb-bubble", mediaOnly && "imb-bubble-media")}>
        <MessageAttachments view={attachmentView} self={self} />
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
        <MessageTime label={timeLabel} copyMarkdown={copyMarkdown} />
      </div>
    </div>
  );
}
