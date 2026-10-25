import { t } from "@shared/l10n";
import { useState } from "react";
import "./index.css";

export interface RunErrorNoticeProps {
  /**
   * The stored notice text. Fixed English on purpose (the model reads it back
   * through `imb_read_chat` and it carries the raw provider error), so it is
   * shown verbatim behind the toggle while the label stays localized.
   */
  content: string;
  /**
   * The notice's message id, set as `data-message-id` on the root so a jump can
   * land on this row (the row-anchoring contract, see `../message-item`).
   */
  messageId?: number;
}

/**
 * Centered system notice for a `kind="error"` message: an agent run failed and
 * the failure was recorded in the chat (see `agent/run-failure.ts`).
 *
 * Nothing was "sent", so it renders like `InterruptedNotice` — a muted system
 * hint without a sender row or avatar — but in the danger tint, because it is
 * the one notice that says work stopped. The technical detail is collapsed by
 * default: it is for troubleshooting, not for reading the conversation.
 */
export function RunErrorNotice({
  content,
  messageId,
}: RunErrorNoticeProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="imb-run-error" role="note" data-message-id={messageId}>
      <span className="imb-run-error-label">{t("Agent run failed")}</span>
      <button
        type="button"
        className="imb-run-error-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? t("Hide details") : t("Show details")}
      </button>
      {open ? <p className="imb-run-error-detail">{content}</p> : null}
    </div>
  );
}
