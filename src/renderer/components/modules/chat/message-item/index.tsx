import type { Message } from "@shared/types";
import { appStore, useApp } from "../../../../app-store";
import { EmployeeAvatar } from "../../../employee-avatar";
import { useMentionResolver } from "../../../markdown/use-mention";
import { AckIndicator } from "../ack-indicator";
import { AnswerCard } from "../answer-card";
import { AskCard } from "../ask-card";
import { ChatCard } from "../chat-card";
import { MessageBubble } from "../message-bubble";
import { ProgressCard } from "../progress-card";
import { formatMessageTime } from "../relative-time";

export interface MessageItemProps {
  message: Message;
  /** Read-only rendering (group-chat view): interactive cards are static. */
  readonly?: boolean;
  /** Called after a successful ask-card answer (interactive mode only). */
  onAnswered?: () => void;
  /** The answer message folded into this ask card, when one exists. */
  askAnswer?: Message;
}

/**
 * Renders one message according to its `kind`, shared by the interactive chat
 * module and the read-only group-chat module so the two views never drift.
 */
export function MessageItem({
  message,
  readonly = false,
  onAnswered,
  askAnswer,
}: MessageItemProps): React.JSX.Element {
  // `@<id>` mentions in chat bubbles render as clickable employee names that
  // open the same agent session as the avatar for this chat.
  const mentions = useMentionResolver(message.chatId, true);
  // Read from the store (not `getLocale()`) so a language switch re-renders
  // the hover time.
  const { locale } = useApp();

  // Clicking an employee/assistant avatar opens that sender's agent session for
  // this chat. The user (null sender) has no session avatar.
  const sender = message.senderEmployeeId;
  const openSession =
    sender === null
      ? undefined
      : () => void appStore.openAgentSession(sender, message.chatId);

  switch (message.kind) {
    case "ask":
      return (
        <AskCard
          message={message}
          readonly={readonly}
          onAnswered={onAnswered ?? (() => undefined)}
          answer={askAnswer}
          onAvatarClick={openSession}
          resolveMention={mentions.resolveMention}
        />
      );
    case "answer":
      return <AnswerCard message={message} onAvatarClick={openSession} />;
    case "progress":
      return (
        <div className="imb-msg imb-other">
          <EmployeeAvatar
            employeeId={message.senderEmployeeId ?? 0}
            size={34}
            onClick={openSession}
          />
          <ProgressCard
            title={message.content}
            steps={message.steps ?? []}
            groupChatId={message.groupChatId}
          />
        </div>
      );
    case "chat":
      return <ChatCard message={message} onAvatarClick={openSession} />;
    case "ack":
      // App-generated receipt: rendered as a transient "thinking" indicator
      // (never a bubble), hidden by CSS once a real message follows it. It
      // shares the standard incoming row layout so the sender (assistant)
      // avatar renders and opens their agent session like any other message.
      return (
        <div className="imb-msg imb-other">
          <EmployeeAvatar
            employeeId={message.senderEmployeeId ?? 0}
            size={34}
            onClick={openSession}
          />
          <AckIndicator />
        </div>
      );
    default:
      return (
        <MessageBubble
          self={message.senderEmployeeId === null}
          messageId={message.id}
          content={message.content}
          attachments={message.attachments}
          attachmentsTotal={message.attachmentsTotal}
          markdown={message.kind === "text" || message.kind === "report"}
          resolveMention={mentions.resolveMention}
          onMentionClick={mentions.onMentionClick}
          timeLabel={formatMessageTime(message.createdAt, locale)}
          avatar={
            <EmployeeAvatar
              employeeId={message.senderEmployeeId}
              size={34}
              onClick={openSession}
            />
          }
        />
      );
  }
}
