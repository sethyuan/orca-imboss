import type { Message } from "@shared/types";
import { memo } from "react";
import { appStore, useApp } from "../../../../app-store";
import { EmployeeAvatar } from "../../../employee-avatar";
import { useMentionResolver } from "../../../markdown/use-mention";
import { AckIndicator } from "../ack-indicator";
import { AnswerCard } from "../answer-card";
import { AskCard } from "../ask-card";
import { ChatCard } from "../chat-card";
import { ImageMessage } from "../image-gen";
import { InterruptedNotice } from "../interrupted-notice";
import { MessageBubble } from "../message-bubble";
import { ProgressCard } from "../progress-card";
import { formatMessageTime } from "../relative-time";
import { RunErrorNotice } from "../run-error-notice";

export interface MessageItemProps {
  message: Message;
  /** Read-only rendering (group-chat view): interactive cards are static. */
  readonly?: boolean;
  /**
   * Called after a successful ask-card answer (interactive mode only), with the
   * answered chat's id. Takes the id (instead of closing over it) so callers can
   * keep one stable callback and this row can stay memoized.
   */
  onAnswered?: (chatId: number) => void;
  /** The answer message folded into this ask card, when one exists. */
  askAnswer?: Message;
  /**
   * Progress cards only. False hides the halt control on an earlier card of a
   * run. Omitted elsewhere, and on a progress card that stands alone.
   */
  showHalt?: boolean;
}

/**
 * Renders one message according to its `kind`, shared by the interactive chat
 * module and the read-only group-chat module so the two views never drift.
 *
 * Memoized: a thread module re-renders on every keystroke in the in-thread find
 * bar and on every scan result (the find engine keeps its state in the module),
 * and re-rendering hundreds of already-rendered rows for that is pure waste.
 * The props are all reference-stable (`message`/`askAnswer` come from the loaded
 * message list, the callbacks are memoized by the callers), and the internals
 * that do depend on app state (`useApp`, mention resolution) subscribe on their
 * own, so a skipped render can never show stale data.
 */
export const MessageItem = memo(function MessageItem({
  message,
  readonly = false,
  onAnswered,
  askAnswer,
  showHalt = true,
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
  // Exact send time, revealed on hover by every kind except the transient ack.
  const timeLabel = formatMessageTime(message.createdAt, locale);

  switch (message.kind) {
    case "ask":
      return (
        <AskCard
          message={message}
          readonly={readonly}
          onAnswered={() => onAnswered?.(message.chatId)}
          answer={askAnswer}
          onAvatarClick={openSession}
          resolveMention={mentions.resolveMention}
          timeLabel={timeLabel}
        />
      );
    case "answer":
      return (
        <AnswerCard
          message={message}
          onAvatarClick={openSession}
          timeLabel={timeLabel}
        />
      );
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
            timeLabel={timeLabel}
            showHalt={showHalt}
          />
        </div>
      );
    case "chat":
      return (
        <ChatCard
          message={message}
          onAvatarClick={openSession}
          timeLabel={timeLabel}
        />
      );
    case "interrupted":
      // App-generated notice (the boss halted the linked task group). Rendered
      // as a centered system hint, not a bubble; no sender/avatar row.
      return <InterruptedNotice groupChatId={message.groupChatId} />;
    case "error":
      // App-generated notice (an agent run failed and was recorded). Also a
      // centered system hint: nobody sent it, and its raw technical detail sits
      // behind a toggle.
      return <RunErrorNotice content={message.content} />;
    case "image":
      // Image generation: one row carries the whole lifecycle (a placeholder
      // while the model runs, then the picture) — see `../image-gen`.
      return (
        <ImageMessage
          message={message}
          self={message.senderEmployeeId === null}
        />
      );
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
            showName
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
          timeLabel={timeLabel}
          avatar={
            <EmployeeAvatar
              employeeId={message.senderEmployeeId}
              size={34}
              showName
              onClick={openSession}
            />
          }
        />
      );
  }
});
