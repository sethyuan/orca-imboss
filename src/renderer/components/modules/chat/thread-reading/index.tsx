import { t } from "@shared/l10n";
import type { Message } from "@shared/types";
import { IconChevronDown } from "../../../icons";
import "./index.css";

/**
 * Thread reading aids: a "new messages" divider and a jump-to-latest button.
 *
 * Both are presentational. They consume the read position that
 * `chats:markRead` already returns (the newest message id of the previous
 * visit) and the thread's own scroll state, and they add nothing to the data
 * model — no extra state, no extra IPC.
 *
 * `THREAD_READING_ENABLED` is the feature's only integration point:
 * - keep `true` to ship both aids;
 * - set it to `false` to drop them, and the chat module falls back to its
 *   previous behaviour (no divider, no button);
 * - replace it with a stored-setting read to expose it as a user preference;
 * - revert the commit to remove the feature entirely.
 */
export const THREAD_READING_ENABLED = true;

/**
 * Index of the first message the user has not seen, or -1 when there is none.
 *
 * `anchorId` is the read position *before* the current visit (the newest
 * message id of the previous one), so a message counts as unread when its id
 * is greater. The caller passes the messages actually rendered, which keeps
 * the divider correct when rows are folded into a card (an answered ask hides
 * its answer message): the divider still lands before the first visible
 * unseen row.
 */
export function firstUnreadIndex(
  messages: Message[],
  anchorId: number,
): number {
  if (anchorId <= 0) return -1;
  return messages.findIndex((message) => message.id > anchorId);
}

/** Hairline divider marking where the previous visit left off. */
export function UnreadDivider(): React.JSX.Element {
  return (
    <div
      className="imb-unread-divider"
      role="separator"
      aria-label={t("New messages")}
    >
      <span className="imb-unread-divider-rule" aria-hidden="true" />
      <span className="imb-unread-divider-label">{t("New messages")}</span>
      <span className="imb-unread-divider-rule" aria-hidden="true" />
    </div>
  );
}

/** Floating affordance to return to the newest message while scrolled up. */
export function JumpToLatest({
  onClick,
}: {
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="imb-jump-latest"
      onClick={onClick}
      title={t("Jump to latest")}
      aria-label={t("Jump to latest")}
    >
      <IconChevronDown />
    </button>
  );
}
