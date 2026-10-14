import { ASSISTANT_ID } from "@shared/constants/employees";
import { INTEGRATION_LABEL_KEYS } from "@shared/constants/integrations";
import { getLocale, t } from "@shared/l10n";
import type {
  AgentStreamEvent,
  ChatSummary,
  Message,
  MessageAttachment,
  PageQuery,
  PageResult,
} from "@shared/types";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cls } from "reactutils";
import { appStore, IS_MAC, useApp } from "../../../../app-store";
import { useInfiniteList } from "../../../../hooks/use-infinite-list";
import { useMultiSelect } from "../../../../hooks/use-multi-select";
import { ModuleView } from "../../../app-shell";
import { Avatar } from "../../../avatar";
import { Button } from "../../../button";
import { ContextMenu, type ContextMenuState } from "../../../context-menu";
import { EmployeeAvatar } from "../../../employee-avatar";
import { Input } from "../../../input";
import { ItemList } from "../../../item-list";
import { ListPane } from "../../../list-pane";
import { ListRow } from "../../../list-row";
import { useMentionResolver } from "../../../markdown/use-mention";
import { Modal } from "../../../modal";
import { SearchInput } from "../../../search-input";
import { Tooltip } from "../../../tooltip";
import { pairAskAnswers } from "../ask-answer";
import { ChatInputBar } from "../chat-input-bar";
import { MessageItem } from "../message-item";
import {
  formatChatTime,
  previewText,
  shouldShowTimeSeparator,
} from "../relative-time";
import { TimeSeparator } from "../time-separator";
import "../thread.css";
import "./index.css";

const PAGE_SIZE = 50;

/**
 * Chat title for display: untitled chats fall back to the localized default
 * at render time (the DB stores `""` for a new chat, so the fallback follows
 * locale switches — unlike a title baked in at creation time).
 */
function displayTitle(title: string): string {
  return title.trim().length > 0 ? title : t("New Chat");
}

/** Transient per-chat run status driven by bound agent events. */
interface ChatRunStatus {
  /** A run is in progress (keeps the reserved status slot in the layout). */
  running: boolean;
  /** Context compaction is in progress (the only status text shown). */
  compacting: boolean;
}

/** Distance from the bottom (px) still considered "pinned" for auto-scroll. */
const PIN_THRESHOLD = 32;

/**
 * Per-chat thread scroll, kept outside the component so it survives a module
 * switch. A plain `Map` (not the appStore proxy): scroll is high-frequency and
 * imperative, and nothing should re-render when it changes. Session-only.
 */
interface ChatScroll {
  scrollTop: number;
  pinned: boolean;
}
const chatScrollStore = new Map<number, ChatScroll>();

export function ChatModule(): React.JSX.Element {
  const { data, focusChatId } = useApp();
  const [selectedId, setSelectedId] = useState<number | null>(
    // Restore the chat selected before this module was unmounted.
    () => appStore.activeRootChatId,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState("");
  // Bumped on chat creation so the composer resets and focuses (see
  // `ChatInputBar`). Starts at 0 so ordinary selections never steal focus.
  const [focusToken, setFocusToken] = useState(0);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteIds, setDeleteIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<Map<number, ChatRunStatus>>(
    () => new Map(),
  );
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  // Optimistic header title for a just-committed rename. Needed because the
  // active list may be a search page that is not refreshed by `chats:changed`.
  const [titleOverride, setTitleOverride] = useState<{
    chatId: number;
    title: string;
  } | null>(null);
  // Set on the first commit/cancel so the blur that follows (the input
  // unmounts) cannot persist a second time.
  const titleDoneRef = useRef(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<number | null>(null);
  selectedIdRef.current = selectedId;
  // Whether the thread is scrolled to (near) the bottom. Auto-scroll only
  // happens while pinned, so reading history is never interrupted.
  const pinnedRef = useRef(true);
  // The chat whose messages are currently in `messages`. Guards the one-shot
  // scroll restore from running against another chat's not-yet-replaced thread.
  const loadedChatIdRef = useRef<number | null>(null);
  // Pending one-shot scroll restore keyed by chat, set when a chat is selected.
  const restoreScrollRef = useRef<{ chatId: number; scrollTop: number } | null>(
    null,
  );
  const locale = getLocale();
  // Chat-list previews show `@名字` for `@<id>` mentions (plain text, so no
  // theme color or click target there).
  const { resolveMention } = useMentionResolver(selectedId ?? 0, false);

  /** Pin or unpin one conversation, then refresh the list order. */
  const togglePin = useCallback(
    async (id: number, pinned: boolean): Promise<void> => {
      try {
        await imb.chats.setPinned(id, pinned);
        await appStore.reloadChats();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  // Hybrid search: an empty query reads the appStore chat cache (root-only,
  // recency-ordered); a non-empty query switches to a server-paged FTS/LIKE
  // search. `useInfiniteList` is always mounted but short-circuits to an empty
  // page when there is no query so it never shadows the cache.
  const isSearching = query.trim().length > 0;
  const fetchPage = useCallback(
    (page: PageQuery): Promise<PageResult<ChatSummary>> => {
      if (!isSearching) {
        return Promise.resolve({ items: [], nextCursor: null, hasMore: false });
      }
      return imb.chats.summariesPage(page);
    },
    [isSearching],
  );
  const search = useInfiniteList(fetchPage, { query, pageSize: PAGE_SIZE });

  const chats = isSearching
    ? search.items
    : (data.chats.items as ChatSummary[]);
  const listLoading = isSearching ? search.loading : data.chats.loading;
  const listError = isSearching ? search.error : data.chats.error;
  const listHasMore = isSearching ? search.hasMore : false;
  const listLoadingMore = isSearching ? search.loadingMore : false;

  // Lazy-load the chat cache on first visit.
  useEffect(() => {
    appStore.ensureChats();
  }, []);

  const loadMessages = useCallback(async (chatId: number): Promise<void> => {
    try {
      const data = await imb.messages.list(chatId);
      loadedChatIdRef.current = chatId;
      setMessages(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Fold a bound agent stream event into the per-chat run status. Only run
  // start/end and compaction affect the UI; tool events and streamed deltas are
  // deliberately ignored, so rapid tool calls can no longer shift the layout
  // (the old per-tool status line was the source of the thread "jitter").
  const applyAgentEvent = useCallback(
    (chatId: number, event: AgentStreamEvent): void => {
      if (event.type === "error") {
        setError(event.message);
      }
      setRunStatus((prev) => {
        const current = prev.get(chatId) ?? {
          running: false,
          compacting: false,
        };
        const next: ChatRunStatus = { ...current };
        switch (event.type) {
          case "agent_start":
            next.running = true;
            break;
          case "agent_end":
            // A retry keeps the run (and the reserved slot) alive.
            if (event.willRetry) return prev;
            next.running = false;
            next.compacting = false;
            break;
          case "error":
            next.running = false;
            next.compacting = false;
            break;
          case "compaction_start":
            next.compacting = true;
            break;
          case "compaction_end":
            next.compacting = false;
            break;
          default:
            return prev;
        }
        const map = new Map(prev);
        if (!next.running && !next.compacting) {
          map.delete(chatId);
        } else {
          map.set(chatId, next);
        }
        return map;
      });
    },
    [],
  );

  // Plain click / auto-select target: the rest (thread, unread) is an effect
  // on `selectedId` so every selection path stays consistent.
  const selectChat = useCallback((chatId: number): void => {
    setSelectedId(chatId);
  }, []);

  const multi = useMultiSelect<ChatSummary, number>({
    getKey: (chat) => chat.id,
    items: chats,
    onActivate: (chat) => selectChat(chat.id),
  });
  const clearSelection = multi.clear;
  const selectSelection = multi.select;

  // Switching between browse/search (query change) clears the selection.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, query]);

  // Open thread + clear unread whenever the selection changes.
  useEffect(() => {
    // Remember the selection so returning to this module restores it.
    appStore.setActiveRootChat(selectedId);
    if (selectedId === null) {
      restoreScrollRef.current = null;
      pinnedRef.current = true;
      setMessages([]);
      return;
    }
    // Restore this chat's previous scroll unless it was pinned to the bottom
    // (a fresh selection with no saved position also starts pinned).
    const saved = chatScrollStore.get(selectedId);
    pinnedRef.current = saved ? saved.pinned : true;
    restoreScrollRef.current =
      saved && !saved.pinned
        ? { chatId: selectedId, scrollTop: saved.scrollTop }
        : null;
    void loadMessages(selectedId);
    void imb.chats.markRead(selectedId);
    appStore.setChatUnread(selectedId, 0);
  }, [selectedId, loadMessages]);

  // Switching chats abandons any in-progress rename and drops the optimistic
  // title (the new chat's title comes from its own summary).
  useEffect(() => {
    titleDoneRef.current = true;
    setEditingTitle(false);
    setTitleOverride(null);
  }, [selectedId]);

  // Subscribe this window to the selected chat's agent events. The session
  // itself is created lazily main-side on the first `chat:send` (via the
  // session queue), so merely selecting a chat does not build a Pi session.
  useEffect(() => {
    if (selectedId === null) return;
    const chatId = selectedId;
    void imb.agentSession.bind(ASSISTANT_ID, chatId);
    return () => {
      void imb.agentSession.unbind(ASSISTANT_ID, chatId);
      // Drop any stale run indicator for the chat we are leaving (its events
      // stop arriving once unbound).
      setRunStatus((prev) => {
        if (!prev.has(chatId)) return prev;
        const map = new Map(prev);
        map.delete(chatId);
        return map;
      });
    };
  }, [selectedId]);

  // Subscribe once to bound session events; route by (employee, chat).
  useEffect(() => {
    const off = imb.agentSession.onEvent(({ employeeId, chatId, event }) => {
      if (employeeId !== ASSISTANT_ID) return;
      applyAgentEvent(chatId, event);
    });
    return off;
  }, [applyAgentEvent]);

  // Auto-select the first chat after page 1 loads (and recover when the
  // selected chat disappears, e.g. bulk delete). The resolved active item is
  // mirrored into `selectedKeys` so the active row is always selected.
  useEffect(() => {
    if (listLoading) return;
    if (chats.length === 0) {
      setSelectedId(null);
      clearSelection();
      return;
    }
    const current = selectedIdRef.current;
    const nextId =
      current !== null && chats.some((chat) => chat.id === current)
        ? current
        : chats[0].id;
    setSelectedId(nextId);
    selectSelection(nextId);
  }, [chats, listLoading, clearSelection, selectSelection]);

  // Jump to a focused chat (an OS notification click) once it is loaded.
  useEffect(() => {
    if (focusChatId === null) return;
    if (!chats.some((chat) => chat.id === focusChatId)) return;
    selectChat(focusChatId);
    appStore.focusChatId = null;
  }, [focusChatId, chats, selectChat]);

  useEffect(() => {
    const offMessages = imb.messages.onChanged(({ chatId }) => {
      // Only the currently-open chat refreshes its thread. The notification
      // beep is handled globally in app-store for any root chat, so it is no
      // longer gated on this selection.
      if (chatId !== selectedIdRef.current) return;
      void imb.chats.markRead(chatId);
      void loadMessages(chatId);
    });
    return offMessages;
  }, [loadMessages]);

  const selectedRunStatus =
    selectedId !== null ? runStatus.get(selectedId) : undefined;

  // Pair answered asks with their answer so the ask card can retain the chosen
  // options/text; folded answers are hidden from the thread.
  const pairing = useMemo(() => pairAskAnswers(messages), [messages]);
  const visibleMessages = useMemo(
    () =>
      messages.filter((message) => !pairing.foldedAnswerIds.has(message.id)),
    [messages, pairing],
  );

  // Cmd/Ctrl+K focuses the chat search (the same muscle memory as most apps).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }
      const input = document.querySelector<HTMLInputElement>(
        ".imb-searchbox input",
      );
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Auto-scroll to the newest message, but only while the user is pinned to
  // the bottom. Incoming messages/run events must not yank a user who scrolled
  // up to read history. A restored (non-pinned) position wins once, after that
  // chat's messages have rendered.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const restore = restoreScrollRef.current;
    if (restore && loadedChatIdRef.current === restore.chatId) {
      el.scrollTop = restore.scrollTop;
      restoreScrollRef.current = null;
      return;
    }
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, selectedRunStatus]);

  const handleThreadScroll = useCallback((): void => {
    const el = threadRef.current;
    if (!el) return;
    const pinned =
      el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD;
    pinnedRef.current = pinned;
    if (selectedIdRef.current !== null) {
      chatScrollStore.set(selectedIdRef.current, {
        scrollTop: el.scrollTop,
        pinned,
      });
    }
  }, []);

  const handleSend = useCallback(
    async (text: string, attachments: MessageAttachment[]): Promise<void> => {
      if (selectedId === null) return;
      const chatId = selectedId;
      // Sending always jumps to the bottom, even if the user had scrolled up.
      pinnedRef.current = true;
      restoreScrollRef.current = null;
      try {
        await imb.chat.send(chatId, text, attachments);
        void loadMessages(chatId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [selectedId, loadMessages],
  );

  const newChat = useCallback(async (): Promise<void> => {
    try {
      // No title at creation: the first user message generates one (main-side
      // `maybeGenerateChatTitle`); until then the list/header render the
      // localized `displayTitle` fallback.
      const chat = await imb.chats.create("", []);
      // The new chat sorts to the top (last_message_at = creation time). The
      // auto-select effect only recovers a *missing* selection, so select the
      // new chat explicitly and clear any stale multi-selection.
      await appStore.reloadChats();
      clearSelection();
      // Clear any active search so the new chat is present in the (unfiltered)
      // list and its detail/input can be rendered.
      setQuery("");
      setSelectedId(chat.id);
      // Reset the composer and focus the new chat's input.
      setFocusToken((token) => token + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [clearSelection]);

  const deleteSelected = useCallback(async (): Promise<void> => {
    if (deleteIds.length === 0) return;
    try {
      setDeleteOpen(false);
      for (const id of deleteIds) {
        await imb.chats.remove(id);
      }
      await appStore.reloadChats();
      // Drop the just-deleted keys so a subsequent bulk action only acts on
      // the reloaded (and auto-select-recovered) list.
      clearSelection();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [deleteIds, clearSelection]);

  const toggleSelectAll = useCallback((): void => {
    if (multi.selectedKeys.size === chats.length && chats.length > 0) {
      multi.clear();
    } else {
      multi.selectAll();
    }
  }, [multi, chats.length]);

  const selected = chats.find((chat) => chat.id === selectedId) ?? null;

  // Raw effective title (accounts for the local rename override); the header
  // applies `displayTitle` on top so an empty title still falls back.
  const selectedRawTitle =
    selected === null
      ? ""
      : titleOverride?.chatId === selected.id
        ? titleOverride.title
        : selected.title;
  const selectedTitle = displayTitle(selectedRawTitle);

  // Double-click the header title to rename inline. Enter/blur commits, Escape
  // cancels; `titleDoneRef` guards against a double commit from the blur that
  // fires when the input unmounts.
  const beginTitleEdit = useCallback((): void => {
    if (selected === null) return;
    titleDoneRef.current = false;
    setTitleDraft(selectedRawTitle);
    setEditingTitle(true);
  }, [selected, selectedRawTitle]);

  const cancelTitleEdit = useCallback((): void => {
    titleDoneRef.current = true;
    setEditingTitle(false);
  }, []);

  const commitTitleEdit = useCallback(async (): Promise<void> => {
    if (titleDoneRef.current) return;
    titleDoneRef.current = true;
    setEditingTitle(false);
    if (selectedId === null) return;
    const chatId = selectedId;
    const next = titleDraft.trim();
    const current = selectedRawTitle.trim();
    // An empty title is a valid stored state (it would also re-enable
    // auto-titling), and an unchanged value is a no-op: both revert silently.
    if (next.length === 0 || next === current) return;
    try {
      const updated = await imb.chats.update(chatId, next);
      if (updated !== null) {
        setTitleOverride({ chatId, title: updated.title });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedId, selectedRawTitle, titleDraft]);

  const listPane = (
    <ListPane
      title={t("Chats")}
      search={
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder={t("Search chats")}
          hint={IS_MAC ? "⌘K" : "Ctrl+K"}
        />
      }
      footer={
        <Button block onClick={() => void newChat()}>
          {t("New Chat")}
        </Button>
      }
    >
      <ItemList
        items={chats}
        getItemKey={(chat) => chat.id}
        loading={listLoading}
        loadingMore={listLoadingMore}
        hasMore={listHasMore}
        loadMore={() => void search.loadMore()}
        loadError={listError}
        selectable
        selectedKeys={multi.selectedKeys}
        onItemClick={(chat, index, mods) =>
          multi.onItemClick(chat, index, mods)
        }
        renderItem={(chat, { selected: isSelectedRow }) => (
          <ListRow
            className={cls(chat.pinned && "imb-chat-pinned")}
            active={chat.id === selectedId}
            selected={isSelectedRow}
            avatar={
              <Avatar
                letter={displayTitle(chat.title).slice(0, 1)}
                name={displayTitle(chat.title)}
              />
            }
            name={
              <span className="imb-chat-name-wrap">
                {chat.pinned && (
                  <PinGlyph className="imb-chat-pin" aria-hidden="true" />
                )}
                <span className="imb-chat-name-text">
                  {displayTitle(chat.title)}
                </span>
                {chat.source && (
                  <span className="imb-chat-source">
                    {t(INTEGRATION_LABEL_KEYS[chat.source])}
                  </span>
                )}
              </span>
            }
            meta={formatChatTime(chat.lastAt, locale)}
            sub={previewText(chat.preview ?? "", 80, resolveMention)}
            badge={
              chat.unread > 0 ? (
                <span className="imb-unread">
                  {chat.unread > 99 ? "99+" : chat.unread}
                </span>
              ) : undefined
            }
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  {
                    key: "select-all",
                    label: t("Select all"),
                    onSelect: toggleSelectAll,
                  },
                  {
                    key: "pin",
                    label: chat.pinned ? t("Unpin") : t("Pin"),
                    onSelect: () => void togglePin(chat.id, !chat.pinned),
                  },
                  {
                    key: "delete",
                    label: t("Delete"),
                    danger: true,
                    onSelect: () => {
                      // Selection-aware: a right-click on an already-selected
                      // row deletes the whole selection; otherwise it deletes
                      // just the right-clicked chat (never a hidden select-all).
                      setDeleteIds(
                        multi.selectedKeys.has(chat.id)
                          ? [...multi.selectedKeys]
                          : [chat.id],
                      );
                      setDeleteOpen(true);
                    },
                  },
                ],
              });
            }}
          />
        )}
      />
    </ListPane>
  );

  const detail = selected ? (
    <>
      <div className="imb-chat-header">
        <div className="imb-chat-header-avatar">
          <EmployeeAvatar employeeId={0} size={36} />
        </div>
        {editingTitle ? (
          <Input
            className="imb-chat-title-input"
            value={titleDraft}
            maxLength={200}
            autoFocus
            aria-label={t("Double-click to rename chat")}
            onChange={(event) => setTitleDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => void commitTitleEdit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitTitleEdit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelTitleEdit();
              }
            }}
          />
        ) : (
          <Tooltip
            placement="bottom"
            content={t("Double-click to rename chat")}
          >
            <div
              className="imb-chat-title imb-chat-title-editable"
              onDoubleClick={beginTitleEdit}
            >
              {selectedTitle}
            </div>
          </Tooltip>
        )}
        {selected.source && (
          <span className="imb-chat-source">
            {t(INTEGRATION_LABEL_KEYS[selected.source])}
          </span>
        )}
      </div>
      <div className="imb-thread" ref={threadRef} onScroll={handleThreadScroll}>
        {visibleMessages.map((message, index) => (
          <Fragment key={`${message.chatId}-${message.id}`}>
            {shouldShowTimeSeparator(visibleMessages[index - 1], message) && (
              <TimeSeparator secs={message.createdAt} />
            )}
            <MessageItem
              message={message}
              onAnswered={() => void loadMessages(message.chatId)}
              askAnswer={pairing.answerByAskId.get(message.id)}
            />
          </Fragment>
        ))}
        {selectedRunStatus !== undefined && (
          // Reserved, fixed-height slot: it is present for the whole run, so
          // toggling the compaction text never shifts the messages above it.
          <div className="imb-run-status" role="status">
            {selectedRunStatus.compacting ? t("Compacting…") : ""}
          </div>
        )}
      </div>
      <ChatInputBar
        chatId={selected.id}
        focusToken={focusToken}
        onSend={handleSend}
      />
    </>
  ) : null;

  return (
    <>
      <ModuleView list={listPane} detail={detail} />
      <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />
      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t("Delete chats")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button variant="danger" onClick={() => void deleteSelected()}>
              {t("Delete")}
            </Button>
          </>
        }
      >
        <p className="imb-chat-delete-note">
          {t(
            "This chat, any chats it created, and their messages will be permanently removed.",
          )}
        </p>
      </Modal>
      {error !== null && (
        <p className="imb-error-text imb-chat-error">{error}</p>
      )}
    </>
  );
}

/** Small push-pin marking a pinned conversation. */
function PinGlyph({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z" />
    </svg>
  );
}
