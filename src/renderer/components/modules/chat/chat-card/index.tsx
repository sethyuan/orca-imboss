import { t } from "@shared/l10n";
import type { Message } from "@shared/types";
import { appStore } from "../../../../app-store";
import { EmployeeAvatar } from "../../../employee-avatar";
import { GroupAvatar } from "../../../group-avatar";
import { HaltButton } from "../halt-button";
import { MessageTime } from "../message-time";
import { useChatSummary } from "../use-chat-summary";
import "./index.css";

export interface ChatCardProps {
  /** A `kind="chat"` message whose content is the linked chat's id. */
  message: Message;
  /** Click handler for the sender avatar (opens the agent session). */
  onAvatarClick?: () => void;
  /** Exact send time, revealed on hover at the card's bottom-right corner. */
  timeLabel?: string | null;
}

/**
 * Link card for a `kind="chat"` message (posted by `imb_create_chat` into the
 * spawning chat). Shows the linked group's composite avatar + title; clicking
 * opens the group conversation as a Nav entry. A missing/invalid link renders
 * a disabled placeholder instead of navigation. Summary resolution (shared
 * cache, delete invalidation) lives in `useChatSummary`.
 */
export function ChatCard({
  message,
  onAvatarClick,
  timeLabel,
}: ChatCardProps): React.JSX.Element {
  const chatId = parseChatId(message.content);
  const summary = useChatSummary(chatId);

  return (
    <div
      className="imb-msg imb-other"
      // Row anchor for jumps (the row-anchoring contract, see `../message-item`).
      data-message-id={message.id}
    >
      <EmployeeAvatar
        employeeId={message.senderEmployeeId}
        size={34}
        onClick={onAvatarClick}
      />
      {summary ? (
        <button
          type="button"
          className="imb-chat-card"
          onClick={() => appStore.openChat(summary)}
        >
          <GroupAvatar
            participants={summary.participants}
            size={40}
            title={summary.title}
          />
          <span className="imb-chat-card-title">{summary.title}</span>
          <MessageTime label={timeLabel} />
        </button>
      ) : (
        <div className="imb-chat-card imb-is-disabled" aria-disabled="true">
          <span className="imb-chat-card-placeholder" aria-hidden="true">
            ?
          </span>
          <span className="imb-chat-card-title">
            {summary === undefined
              ? t("Loading…")
              : t("Conversation unavailable")}
          </span>
          <MessageTime label={timeLabel} />
        </div>
      )}
      {/* Row sibling of the bubble, gated on the parsed link id so it is
          present from the first render (no width jump while the summary loads). */}
      {chatId !== null && <HaltButton chatId={chatId} />}
    </div>
  );
}

/** Defensive parse of the message content (the linked chat id). */
function parseChatId(content: string): number | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  const id = Number(trimmed);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
