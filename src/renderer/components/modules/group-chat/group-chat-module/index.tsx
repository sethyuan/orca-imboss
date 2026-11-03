import { t } from "@shared/l10n";
import type { Message } from "@shared/types";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cls } from "reactutils";
import { IS_MAC, appStore, useApp } from "../../../../app-store";
import { ModuleView } from "../../../app-shell";
import { ChatAvatar } from "../../../chat-avatar";
import { IconButton } from "../../../icon-button";
import { IconChevronDown, IconChevronUp, IconSearch } from "../../../icons";
import { Tooltip } from "../../../tooltip";
import { MessageItem } from "../../chat/message-item";
import { shouldShowTimeSeparator } from "../../chat/relative-time";
import "../../chat/thread.css";
import { ThreadFindBar } from "../../chat/thread-find";
import { useThreadFind } from "../../chat/thread-find/use-thread-find";
import { PIN_THRESHOLD, prefersReducedMotion } from "../../chat/thread-scroll";
import { TimeSeparator } from "../../chat/time-separator";
import "./index.css";

export interface GroupChatModuleProps {
  chatId: number;
}

/**
 * Per-chat thread scroll store surviving module unmounts.
 */
interface GroupChatScroll {
  scrollTop: number;
  pinned: boolean;
}
const groupChatScrollStore = new Map<number, GroupChatScroll>();

/** Scroll distance (px) below which the view counts as "at an edge". */
const EDGE_EPSILON = 1;

/** Which of the two scroll jumps can still move the view. */
interface ScrollAvailability {
  /** The thread overflows at all (otherwise no control is shown). */
  scrollable: boolean;
  top: boolean;
  bottom: boolean;
}

const NO_SCROLL: ScrollAvailability = {
  scrollable: false,
  top: false,
  bottom: false,
};

function sameAvailability(
  a: ScrollAvailability,
  b: ScrollAvailability,
): boolean {
  return (
    a.scrollable === b.scrollable && a.top === b.top && a.bottom === b.bottom
  );
}

/**
 * Title of the conversation this group chat belongs to (the **root** chat), for
 * the header subtitle.
 *
 * The root id is resolved in main (`chats:rootId` walks `from_chat_id`), which
 * also covers a group chat spawned by another group chat. The title comes from
 * the root-chat list cache (`data.chats.items`): that is the store's single,
 * always-fresh source of root-chat titles — `refreshChatSummary` rewrites it on
 * `messages:changed` / `chats:changed`, so a rename is reflected here with no
 * extra subscription. The id is only resolved once per mounted chat, so the
 * subtitle costs one IPC per open.
 */
function useRootChat(groupChatId: number): {
  rootChatId: number | null;
  title: string | null;
} {
  const { data } = useApp();
  const [rootChatId, setRootChatId] = useState<number | null>(null);

  useEffect(() => {
    let ignore = false;
    // Root-chat summaries are the chat module's list cache; load it once so the
    // subtitle resolves without a second IPC.
    appStore.ensureChats();
    void (async () => {
      try {
        const id = await imb.chats.rootId(groupChatId);
        if (ignore) return;
        setRootChatId(Number.isSafeInteger(id) && id > 0 ? id : null);
      } catch {
        if (!ignore) setRootChatId(null);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [groupChatId]);

  const rootChat = useMemo(
    () =>
      rootChatId === null
        ? undefined
        : data.chats.items.find((chat) => chat.id === rootChatId),
    [data.chats.items, rootChatId],
  );

  const title = useMemo(() => {
    if (rootChat === undefined) return null;
    const trimmed = rootChat.title.trim();
    // Same normalization as `appStore.resolveChatTitle`: an unnamed root chat
    // reads as "New Chat" until the title-generation job names it.
    return trimmed.length > 0 ? trimmed : t("New Chat");
  }, [rootChat]);

  return { rootChatId, title };
}

/**
 * Read-only view of a group chat opened from a `chat`-kind card. Shows the
 * conversation history and live-updates on new messages; it never sends
 * (`ChatInputBar` is absent), never binds an agent session, and never touches
 * the unread cursor.
 *
 * In-thread find (⌘F) works exactly as in the root chat — same engine, same bar
 * — over the same rendered content.
 */
export function GroupChatModule({
  chatId,
}: GroupChatModuleProps): React.JSX.Element {
  const { openedItems } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scroll, setScroll] = useState<ScrollAvailability>(NO_SCROLL);
  const [rootBusy, setRootBusy] = useState(false);
  const rootBusyRef = useRef(false);
  const disposedRef = useRef(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const restoreScrollRef = useRef<{ chatId: number; scrollTop: number } | null>(
    null,
  );

  const chatItem = openedItems.find(
    (item) => item.kind === "chat" && item.id === chatId,
  );
  const chat = chatItem?.kind === "chat" ? chatItem : null;

  // The conversation this group belongs to — the header subtitle links to it.
  const root = useRootChat(chatId);

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
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    const pinned = maxScroll - el.scrollTop <= PIN_THRESHOLD;
    pinnedRef.current = pinned;
    groupChatScrollStore.set(chatId, {
      scrollTop: el.scrollTop,
      pinned,
    });
    // Edge state for the scroll-jump control (re-renders only on change).
    const next: ScrollAvailability = {
      scrollable: maxScroll > EDGE_EPSILON,
      top: el.scrollTop > EDGE_EPSILON,
      bottom: maxScroll - el.scrollTop > EDGE_EPSILON,
    };
    setScroll((current) => (sameAvailability(current, next) ? current : next));
  }, [chatId]);

  // Seed the jump control once the messages are in (and re-measure when the
  // content changes length, e.g. an image message finishing its load).
  useEffect(() => {
    handleScroll();
  }, [messages, handleScroll]);

  /**
   * Scroll to one end of the transcript. Landing at the bottom re-pins the view
   * to the live tail (the same state a normal read of the latest message leaves
   * behind), landing at the top unpins it so new messages do not yank the boss
   * away from what she is reading.
   */
  const scrollToEdge = useCallback(
    (edge: "top" | "bottom"): void => {
      const el = threadRef.current;
      if (!el) return;
      const target =
        edge === "top" ? 0 : Math.max(0, el.scrollHeight - el.clientHeight);
      const pinned = edge === "bottom";
      pinnedRef.current = pinned;
      groupChatScrollStore.set(chatId, { scrollTop: target, pinned });
      el.scrollTo({
        top: target,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    },
    [chatId],
  );

  /**
   * Jump to the root conversation (the header subtitle).
   *
   * Same route as the session header's chat link: `openConversationById` sends a
   * root chat to the Chat module and a (nested) group chat into the Nav. Only the
   * busy flag and the inline error are local — the destination is the store's
   * job. The `ref` guard makes a same-frame double click a single request, and
   * `setState` is skipped once the view is gone (the module unmounts as soon as
   * the module switches).
   */
  const openRootChat = useCallback(async (): Promise<void> => {
    const rootChatId = root.rootChatId;
    if (rootChatId === null || rootBusyRef.current) return;
    rootBusyRef.current = true;
    setRootBusy(true);
    setError(null);
    try {
      const opened = await appStore.openConversationById(rootChatId);
      if (!opened) setError(t("Conversation unavailable"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      rootBusyRef.current = false;
      // The jump itself unmounts this view (it switches the module); skip the
      // state write when that already happened.
      if (!disposedRef.current) setRootBusy(false);
    }
  }, [root.rootChatId]);

  // Reset the "disposed" flag on (re)mount: `chatId` changes remount the view
  // through `App.tsx`'s `key`, but a defensive reset keeps this correct even if
  // it ever stops doing so.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  /**
   * A find-bar jump leaves the bottom (the view is no longer pinned to the live
   * tail) and records the landing position, so switching away and back keeps
   * the place the boss was reading.
   */
  const handleFindJump = useCallback(
    (target: number): void => {
      pinnedRef.current = false;
      groupChatScrollStore.set(chatId, {
        scrollTop: target,
        pinned: false,
      });
    },
    [chatId],
  );

  const threadFind = useThreadFind({
    chatId,
    messages,
    threadRef,
    onBeforeJump: handleFindJump,
  });

  const content = (
    <>
      <div className="imb-chat-header">
        <div className="imb-chat-header-avatar">
          <ChatAvatar
            participants={chat?.participants ?? []}
            fromChatId={chat?.fromChatId ?? null}
            directEmployeeId={chat?.directEmployeeId ?? null}
            size={30}
            title={chat?.title}
          />
        </div>
        {/* Two-line heading, mirroring the agent-session header: the group's own
            title, then the conversation it was spawned from. */}
        <div className="imb-gc-heading">
          <div className="imb-chat-title">
            {chat?.title ?? t("Conversation")}
          </div>
          {root.title !== null && (
            <Tooltip placement="bottom" content={root.title}>
              <button
                type="button"
                className="imb-gc-subtitle imb-gc-root-link"
                // The tooltip is the hint; drop the native duplicate.
                title=""
                aria-label={`${t("Open chat")}: ${root.title}`}
                disabled={rootBusy}
                onClick={() => void openRootChat()}
              >
                {root.title}
              </button>
            </Tooltip>
          )}
        </div>
        {/* Header search entry: identical to the root chat's (⌘F's action, not
            a toggle). This view has no composer, so the bar is the only way in
            besides the shortcut. */}
        <Tooltip
          placement="bottom"
          content={`${t("Find in chat")} · ${IS_MAC ? "⌘F" : "Ctrl+F"}`}
        >
          <IconButton
            className="imb-chat-find"
            label={t("Find in chat")}
            aria-pressed={threadFind.open}
            // See the root chat's copy: suppress the duplicate native tooltip.
            title=""
            boxSize={28}
            size={16}
            onClick={threadFind.openFind}
          >
            <IconSearch />
          </IconButton>
        </Tooltip>
      </div>
      {/* Same wrapper as the interactive chat: the positioning context of the
          floating find bar (an absolute child of the scroller would scroll away
          with the messages). */}
      <div className="imb-chat-thread-wrap">
        <div
          className={cls("imb-thread", scroll.scrollable && "imb-has-jumps")}
          ref={threadRef}
          // Focus target after the find bar closes (this view has no composer).
          tabIndex={-1}
          onScroll={handleScroll}
        >
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
        {threadFind.open && <ThreadFindBar find={threadFind} />}
        {/* Quick jump to either end of a long transcript. Only rendered when the
            thread actually overflows (otherwise it is dead weight over the
            content), and each button is disabled once that end is reached. */}
        {scroll.scrollable && (
          <div className="imb-thread-jumps">
            <IconButton
              className="imb-thread-jump"
              label={t("Jump to top")}
              size={16}
              boxSize={32}
              disabled={!scroll.top}
              onClick={() => scrollToEdge("top")}
            >
              <IconChevronUp />
            </IconButton>
            <IconButton
              className="imb-thread-jump"
              label={t("Jump to bottom")}
              size={16}
              boxSize={32}
              disabled={!scroll.bottom}
              onClick={() => scrollToEdge("bottom")}
            >
              <IconChevronDown />
            </IconButton>
          </div>
        )}
      </div>
      {error !== null && (
        <p className="imb-error-text imb-chat-error">{error}</p>
      )}
    </>
  );

  return <ModuleView content={content} />;
}
