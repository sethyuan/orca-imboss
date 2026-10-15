import { CHAT_HANDOFF_ENABLED } from "@shared/constants/handoff";
import { getLocale, t } from "@shared/l10n";
import type { ChatSummary } from "@shared/types";
import { useEffect, useMemo, useState } from "react";
import { Avatar } from "../../../avatar";
import { Button } from "../../../button";
import type { ContextMenuItem } from "../../../context-menu";
import { ListRow } from "../../../list-row";
import { Modal } from "../../../modal";
import { SearchInput } from "../../../search-input";
import { formatChatTime, previewText } from "../relative-time";
import "./index.css";

/**
 * Chat handoff, from the boss's side: hand a conversation to another
 * conversation as reference, background or follow-up.
 *
 * The agents already do this to each other (`imb_read_chat` +
 * `imb_send_message`); this is the same act, initiated by the boss and with
 * both ends picked explicitly. Main owns the whole mechanism (see
 * `src/main/handoff.ts`), so this module is only the two pieces of UI:
 *
 * - `handoffMenuItem` — the chat list's context-menu entry;
 * - `HandoffPicker` — the modal that picks the receiving conversation.
 *
 * `CHAT_HANDOFF_ENABLED` (shared with main) gates both: with the switch off the
 * chat module renders neither and nothing else changes.
 */

/** Context-menu entry opening the picker for `chat`, or `null` when disabled. */
export function handoffMenuItem(
  chat: ChatSummary,
  onSelect: (chat: ChatSummary) => void,
): ContextMenuItem | null {
  if (!CHAT_HANDOFF_ENABLED) return null;
  return {
    key: "handoff",
    label: t("Share with a conversation…"),
    onSelect: () => onSelect(chat),
  };
}

export interface HandoffPickerProps {
  /** Conversation to hand off; `null` keeps the picker closed. */
  source: ChatSummary | null;
  /** Every root conversation; the source is filtered out here. */
  chats: ChatSummary[];
  onClose: () => void;
}

/** Modal that picks the conversation to receive `source`. */
export function HandoffPicker({
  source,
  chats,
  onClose,
}: HandoffPickerProps): React.JSX.Element | null {
  const [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every open starts from a clean slate (the modal is remounted per source).
  useEffect(() => {
    if (source === null) return;
    setQuery("");
    setTargetId(null);
    setBusy(false);
    setError(null);
  }, [source]);

  const targets = useMemo(() => {
    if (source === null) return [];
    const needle = query.trim().toLowerCase();
    return chats.filter(
      (chat) =>
        chat.id !== source.id &&
        (needle.length === 0 ||
          displayTitle(chat.title).toLowerCase().includes(needle)),
    );
  }, [chats, query, source]);

  if (!CHAT_HANDOFF_ENABLED || source === null) return null;

  const share = async (): Promise<void> => {
    if (targetId === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await imb.handoff.toChat(source.id, targetId);
      // The append already pushed `messages:changed`, so the target's list row
      // and (when it is open) its thread refresh on their own.
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("Share with a conversation")}
      sub={t(
        "Hand this conversation over as reference, background or follow-up.",
      )}
      error={error}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            loading={busy}
            disabled={targetId === null}
            onClick={() => void share()}
          >
            {t("Share")}
          </Button>
        </>
      }
    >
      <SearchInput
        value={query}
        onValueChange={setQuery}
        placeholder={t("Search conversations")}
      />
      <div className="imb-handoff-targets">
        {targets.length === 0 ? (
          <p className="imb-handoff-empty">{t("No other conversations")}</p>
        ) : (
          targets.map((chat) => (
            <ListRow
              key={chat.id}
              active={chat.id === targetId}
              onClick={() => setTargetId(chat.id)}
              avatar={
                <Avatar
                  letter={displayTitle(chat.title).slice(0, 1)}
                  name={displayTitle(chat.title)}
                />
              }
              name={displayTitle(chat.title)}
              meta={
                chat.lastAt !== null
                  ? formatChatTime(chat.lastAt, getLocale())
                  : undefined
              }
              sub={previewText(chat.preview ?? "", 60)}
            />
          ))
        )}
      </div>
    </Modal>
  );
}

/** Same fallback the chat list uses for a conversation with no title yet. */
function displayTitle(title: string): string {
  return title.trim().length > 0 ? title : t("New Chat");
}
