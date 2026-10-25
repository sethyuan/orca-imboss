import { t } from "@shared/l10n";
import type { Message } from "@shared/types";
import { cls } from "reactutils";
import { EmployeeAvatar } from "../../../employee-avatar";
import { parseAnswer } from "../ask-answer";
import {
  MessageAttachments,
  useMessageAttachments,
} from "../message-attachments";
import { MessageBubble } from "../message-bubble";
import { MessageTime } from "../message-time";
import "./index.css";

export interface AnswerCardProps {
  message: Message;
  /** Click handler for the sender avatar (opens the agent session). */
  onAvatarClick?: () => void;
  /** Exact send time, revealed on hover at the card's bottom-right corner. */
  timeLabel?: string | null;
}

/**
 * Read-only answer card (kind=`answer`). Parses the message `content` as a
 * JSON answer set and renders each answer's question ref + chosen options +
 * free text. A parse failure or an empty set degrades to the generic bubble.
 */
export function AnswerCard({
  message,
  onAvatarClick,
  timeLabel,
}: AnswerCardProps): React.JSX.Element {
  const self = message.senderEmployeeId === null;
  const payload = parseAnswer(message.content);
  // Today's `messages:answer` IPC writes no attachments, so this renders
  // nothing. It is here for the same reason the ask card has it: a row that
  // renders its own layout must never be the reason an attachment is invisible
  // (legacy rows, a future answer-with-files, an older/newer app version).
  const attachmentView = useMessageAttachments({
    messageId: message.id,
    attachments: message.attachments,
    attachmentsTotal: message.attachmentsTotal,
  });

  if (!payload) {
    return (
      <MessageBubble
        self={self}
        messageId={message.id}
        content={message.content}
        attachments={message.attachments}
        attachmentsTotal={message.attachmentsTotal}
        avatar={
          <EmployeeAvatar
            employeeId={message.senderEmployeeId}
            size={34}
            onClick={onAvatarClick}
          />
        }
      />
    );
  }

  return (
    <div
      className={cls("imb-msg", self ? "imb-self" : "imb-other")}
      // Row anchor for jumps (the row-anchoring contract, see `../message-item`).
      data-message-id={message.id}
    >
      <EmployeeAvatar
        employeeId={message.senderEmployeeId}
        size={34}
        onClick={onAvatarClick}
      />
      <div className="imb-answer-card">
        <div className="imb-answer-card-title">{t("Answer")}</div>
        <MessageAttachments view={attachmentView} self={self} />
        {payload.answers.map((a) => (
          <div className="imb-answer-item" key={a.questionId}>
            <div className="imb-answer-qid">{a.questionId}</div>
            {a.selected !== undefined && a.selected.length > 0 && (
              <div className="imb-answer-selected">{a.selected.join(", ")}</div>
            )}
            {a.text !== undefined && a.text.length > 0 && (
              <div className="imb-answer-text">{a.text}</div>
            )}
          </div>
        ))}
        <MessageTime label={timeLabel} />
      </div>
    </div>
  );
}
