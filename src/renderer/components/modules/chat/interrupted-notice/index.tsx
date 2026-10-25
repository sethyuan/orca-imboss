import { t } from "@shared/l10n";
import { appStore } from "../../../../app-store";
import { IconHalt } from "../../../icons";
import { useChatSummary } from "../use-chat-summary";
import "./index.css";

export interface InterruptedNoticeProps {
  /** Task group whose sessions the boss halted (`null` for legacy/unknown links). */
  groupChatId: number | null;
  /**
   * The notice's message id, set as `data-message-id` on the root so a jump can
   * land on this row (the row-anchoring contract, see `../message-item`).
   */
  messageId?: number;
}

/**
 * Centered system notice for a `kind="interrupted"` message: records that the
 * boss halted all sessions in a task group. The group name links to that
 * conversation when it still resolves. Rendered in both the interactive chat
 * module and the read-only group-chat module (the link stays clickable, like
 * the `chat` card).
 */
export function InterruptedNotice({
  groupChatId,
  messageId,
}: InterruptedNoticeProps): React.JSX.Element {
  const summary = useChatSummary(groupChatId);
  return (
    <div className="imb-interrupted" role="note" data-message-id={messageId}>
      <span className="imb-interrupted-icon" aria-hidden="true">
        <IconHalt />
      </span>
      <span className="imb-interrupted-text">
        {t("The boss interrupted all sessions in this task group chat.")}
      </span>
      {summary && (
        <button
          type="button"
          className="imb-interrupted-link"
          onClick={() => appStore.openChat(summary)}
        >
          {summary.title}
        </button>
      )}
    </div>
  );
}
