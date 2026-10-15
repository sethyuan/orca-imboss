import { t } from "@shared/l10n";
import type { ChatSummary } from "@shared/types";
import type { ContextMenuItem } from "../../../context-menu";
import "./index.css";

/**
 * Per-conversation mute: a muted conversation keeps counting unread (its badge
 * stays honest), but its messages raise no OS notification and no notification
 * sound.
 *
 * The wiring spans both processes — a `chats.muted` column, `chats:setMuted`,
 * the notification gate in `notifications.ts` and the sound gate in
 * `app-store.ts` — and every one of those is inert while no conversation is
 * muted. `CHAT_MUTE_ENABLED` gates the only user-facing part (the mute entry in
 * the chat list's context menu and the glyph it shows), which is the feature's
 * single integration point:
 *
 * - keep `true` to ship it;
 * - set it to `false` to hide the mute UI: every conversation then behaves as
 *   before, and the rest of the wiring simply never runs;
 * - replace it with a stored-setting read to expose it as a user preference;
 * - revert the commit to remove the feature entirely.
 */
export const CHAT_MUTE_ENABLED = true;

/** Small bell-off glyph marking a muted conversation. */
export function MuteGlyph({
  className,
}: {
  className?: string;
}): React.JSX.Element {
  return (
    <svg
      className={className}
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4a5.5 5.5 0 0 0-5.5 5.5V13L5 15.5h14L17.5 13V9.5A5.5 5.5 0 0 0 12 4Z" />
      <path d="M10 18.5a2 2 0 0 0 4 0" />
      <path d="M4 4l16 16" />
    </svg>
  );
}

/**
 * Context-menu entry that mutes or unmutes `chat`, or `null` when the feature
 * is disabled. `onToggle` receives the value to store; the caller owns what
 * happens afterwards (refreshing the list), so this stays free of app state.
 */
export function chatMuteMenuItem(
  chat: ChatSummary,
  onToggle: (muted: boolean) => void,
): ContextMenuItem | null {
  if (!CHAT_MUTE_ENABLED) return null;
  return {
    key: "mute",
    label: chat.muted ? t("Unmute") : t("Mute"),
    onSelect: () => onToggle(!chat.muted),
  };
}
