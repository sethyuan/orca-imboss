import { t } from "@shared/l10n";
import "./index.css";

/** Highest count the pill spells out; above it the badge convention applies. */
const MAX_COUNT = 99;

export interface NewMessagesJumpProps {
  /**
   * Jump targets in the batch — a progress run counts once, because it renders
   * as one row (see `chat-module`'s unseen detection). Always ≥ 1.
   */
  count: number;
  /**
   * Take the boss to the start of the batch. The module owns the scrolling (it
   * also maintains the pinned / scroll-store state), so this only asks.
   */
  onReveal: () => void;
}

/**
 * Floating pill over the bottom-right corner of the transcript: "N new
 * messages". Clicking it scrolls to the first message that arrived while the
 * boss was reading history, vertically centered, so a slice of the older
 * context stays visible above it and the batch can be read forwards.
 *
 * Text only, no arrow: a new message can land above *or* below the reading
 * position (a batch the boss scrolled past on her way up lands above it), so a
 * single directional glyph would be wrong half the time — the boss's call.
 *
 * Rendered by the module only while such a batch exists (it never keeps itself
 * mounted), so showing / hiding is the module's decision and this component
 * carries no state.
 *
 * Accessibility: a real `<button>` with the count as its visible text, so the
 * label needs no `aria-label` and no native `title` (it would duplicate the
 * text); no live region — announcing every incoming message while the boss
 * reads history would be noise.
 */
export function NewMessagesJump({
  count,
  onReveal,
}: NewMessagesJumpProps): React.JSX.Element | null {
  // Defensive: the module never renders a zero / broken batch, but a NaN would
  // otherwise reach the dictionary lookup and the DOM.
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (total === 0) return null;
  const label = t("${count} new messages", {
    count: total > MAX_COUNT ? `${MAX_COUNT}+` : String(total),
  });

  return (
    <div className="imb-new-messages">
      <button type="button" className="imb-new-messages-btn" onClick={onReveal}>
        {label}
      </button>
    </div>
  );
}
