import { t } from "@shared/l10n";
import type { Message } from "@shared/types";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../../../../app-store";
import { ModuleView } from "../../../app-shell";
import { GroupAvatar } from "../../../group-avatar";
import { MessageItem } from "../../chat/message-item";
import { shouldShowTimeSeparator } from "../../chat/relative-time";
import { TimeSeparator } from "../../chat/time-separator";
import "../../chat/thread.css";

export interface GroupChatModuleProps {
  chatId: number;
}

/** Distance from the bottom (px) still considered "pinned" for auto-scroll. */
const PIN_THRESHOLD = 32;

/**
 * Per-chat thread scroll store surviving module unmounts.
 */
interface GroupChatScroll {
  scrollTop: number;
  pinned: boolean;
}
const groupChatScrollStore = new Map<number, GroupChatScroll>();

/**
 * Read-only view of a group chat opened from a `chat`-kind card. Shows the
 * conversation history and live-updates on new messages; it never sends
 * (`ChatInputBar` is absent), never binds an agent session, and never touches
 * the unread cursor.
 */
export function GroupChatModule({
  chatId,
}: GroupChatModuleProps): React.JSX.Element {
  const { openedItems } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const restoreScrollRef = useRef<{ chatId: number; scrollTop: number } | null>(
    null,
  );

  const chatItem = openedItems.find(
    (item) => item.kind === "chat" && item.id === chatId,
  );
  const chat = chatItem?.kind === "chat" ? chatItem : null;

  const loadMessages = useCallback(async (id: number): Promise<void> => {
    try {
      setMessages(await imb.messages.list(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const saved = groupChatScrollStore.get(chatId);
    pinnedRef.current = saved ? saved.pinned : true;
    restoreScrollRef.current =
      saved && !saved.pinned ? { chatId, scrollTop: saved.scrollTop } : null;
    void loadMessages(chatId);
  }, [chatId, loadMessages]);

  // Live-append: refresh whenever this chat gains a message.
  useEffect(() => {
    const off = imb.messages.onChanged(({ chatId: changedId }) => {
      if (changedId !== chatId) return;
      void loadMessages(chatId);
    });
    return off;
  }, [chatId, loadMessages]);

  // Auto-scroll to newest message while pinned, or restore previous scroll position.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const restore = restoreScrollRef.current;
    if (restore && restore.chatId === chatId) {
      el.scrollTop = restore.scrollTop;
      restoreScrollRef.current = null;
      return;
    }
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, chatId]);

  const handleScroll = useCallback((): void => {
    const el = threadRef.current;
    if (!el) return;
    const pinned =
      el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD;
    pinnedRef.current = pinned;
    groupChatScrollStore.set(chatId, {
      scrollTop: el.scrollTop,
      pinned,
    });
  }, [chatId]);

  const content = (
    <>
      <div className="imb-chat-header">
        <div className="imb-chat-header-avatar">
          <GroupAvatar
            participants={chat?.participants ?? []}
            size={36}
            title={chat?.title}
          />
        </div>
        <div className="imb-chat-title">{chat?.title ?? t("Conversation")}</div>
      </div>
      <div className="imb-thread" ref={threadRef} onScroll={handleScroll}>
        {messages.length === 0 ? (
          <div className="imb-chat-empty-detail">{t("No messages yet")}</div>
        ) : (
          messages.map((message, index) => (
            <Fragment key={`${message.chatId}-${message.id}`}>
              {shouldShowTimeSeparator(messages[index - 1], message) && (
                <TimeSeparator secs={message.createdAt} />
              )}
              <MessageItem message={message} readonly />
            </Fragment>
          ))
        )}
      </div>
      {error !== null && (
        <p className="imb-error-text imb-chat-error">{error}</p>
      )}
    </>
  );

  return <ModuleView content={content} />;
}
