import { ASSISTANT_ID } from "@shared/constants/employees";
import { INTEGRATION_LABEL_KEYS } from "@shared/constants/integrations";
import { TAG_FILTER_NONE } from "@shared/constants/tags";
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
import { useDebouncedValue } from "../../../../hooks/use-debounced-value";
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
import { TagSelect } from "../../../tag-select";
import { Tooltip } from "../../../tooltip";
import { pairAskAnswers } from "../ask-answer";
import { ChatInputBar } from "../chat-input-bar";
import { CHAT_MUTE_ENABLED, MuteGlyph, chatMuteMenuItem } from "../chat-mute";
import { MessageItem } from "../message-item";
import {
  displayTitle,
  formatChatTime,
  previewText,
  shouldShowTimeSeparator,
} from "../relative-time";
import "../thread.css";
import { TimeSeparator } from "../time-separator";
import "./index.css";

const PAGE_SIZE = 50;

/**
 * Initial row-height guess for the chat list. A chat row is ~91px (avatar +
 * title/preview lines + the tag-editor footer); the virtualizer re-measures
 * every row after paint, but a close estimate keeps any not-yet-measured row
 * from overlapping its neighbour.
 */
const CHAT_ROW_ESTIMATE = 90;

/** Stable props for the virtualized chat list (see `VirtualList`). */
const chatItemKey = (chat: ChatSummary): number => chat.id;
const chatRowEstimate = (): number => CHAT_ROW_ESTIMATE;

/**
 * Empty-list text for the conversation list: an empty list means something
 * different depending on why it is empty (no chats at all, a search with no
 * hits, or a tag filter that matches nothing).
 */
function chatListEmptyMessage(isSearching: boolean, tagCount: number): string {
  if (isSearching) return t("No conversations match your search");
  if (tagCount > 0) return t("No conversations with these tags");
  return t("No conversations yet");
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
  // The input keeps the raw `query` (instant feedback); everything that drives
  // the (server-paged) search uses the debounced value so one keystroke does
  // not fire an IPC + FTS/LIKE query, and the virtualized list is not remounted
  // mid-typing.
  const debouncedQuery = useDebouncedValue(query);
  // Tag filter of the list below the search box (AND). Candidate tags + a
  // per-chat optimistic override of the row chips are kept here too. Session-
  // only component state, so a module switch / restart clears it (like the
  // search box).
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [tagOptions, setTagOptions] = useState<string[]>([]);
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

  /** Mute or unmute one conversation, then refresh the list cache. */
  const toggleMute = useCallback(
    async (id: number, muted: boolean): Promise<void> => {
      try {
        await imb.chats.setMuted(id, muted);
        await appStore.reloadChats();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  // Hybrid search: an empty query reads the appStore chat cache (root-only,
  // recency-ordered); a non-empty query switches to a server-paged FTS/LIKE
  // search. An active tag filter also forces the server-paged path (via
  // `params`) so the result set and pagination stay exact even with an empty
  // query. `useInfiniteList` is always mounted but short-circuits to an empty
  // page when neither is active.
  const isSearching = debouncedQuery.trim().length > 0;
  const serverMode = isSearching || tagFilter.length > 0;
  // Split the "No tags" pseudo-value out of the filter: it travels as a
  // dedicated boolean (never inside `tags[]`, which the server normalizes).
  const noTagFilter = tagFilter.includes(TAG_FILTER_NONE);
  const concreteTags = tagFilter.filter((tag) => tag !== TAG_FILTER_NONE);
  // Stable reset key for the tag filter. The "No tags" pseudo-value is an
  // empty string, so a plain `[...tagFilter].sort().join()` would produce ""
  // for both "no filter" and the no-tag-only filter — `paramsKey` would not
  // change on selection, `useInfiniteList` would never re-fetch, and the
  // freshly-entered server mode would render the previous (empty) item list.
  // Tag the no-flag explicitly with \u0001 (real tags can never contain control
  // characters — `normalizeTag` strips them), keeping "" as the no-filter key.
  const tagFilterKey =
    concreteTags.length > 0 || noTagFilter
      ? `${[...concreteTags].sort().join("\u0000")}\u0001${noTagFilter ? "1" : "0"}`
      : "";
  // Force the virtualized list to remount (fresh measurement cache) whenever
  // its data source changes — the browse cache vs a server-paged search/tag
  // filter. Without this, clearing a filter swaps the item list in place while
  // the virtualizer keeps the heights measured for the previous list, and rows
  // get positioned by stale sizes (overlap). Restarting from the top on a
  // source change matches the search box's existing reset behaviour.
  const listSourceKey = serverMode
    ? `search:${debouncedQuery}\u0000${tagFilterKey}`
    : "browse";
  const fetchPage = useCallback(
    (page: PageQuery): Promise<PageResult<ChatSummary>> => {
      if (!serverMode) {
        return Promise.resolve({ items: [], nextCursor: null, hasMore: false });
      }
      return imb.chats.summariesPage(page);
    },
    [serverMode],
  );
  const search = useInfiniteList(fetchPage, {
    query: debouncedQuery,
    pageSize: PAGE_SIZE,
    params:
      tagFilter.length > 0
        ? { tags: concreteTags, noTags: noTagFilter }
        : undefined,
    paramsKey: tagFilterKey,
  });

  const chats = serverMode ? search.items : (data.chats.items as ChatSummary[]);

  const listLoading = serverMode ? search.loading : data.chats.loading;
  const listError = serverMode ? search.error : data.chats.error;
  const listHasMore = serverMode ? search.hasMore : false;
  const listLoadingMore = serverMode ? search.loadingMore : false;

  // Mirrors of the currently displayed list and its source, for the idempotent
  // unread clear: it runs from event subscriptions that must stay stable, so it
  // cannot close over the per-render `chats` / `serverMode` values directly.
  const chatsRef = useRef<ChatSummary[]>(chats);
  chatsRef.current = chats;
  const serverModeRef = useRef(serverMode);
  serverModeRef.current = serverMode;

  // Lazy-load the chat cache on first visit.
  useEffect(() => {
    appStore.ensureChats();
  }, []);

  // Latest tag filter, read from `saveTags` without re-creating it.
  const tagFilterRef = useRef(tagFilter);
  tagFilterRef.current = tagFilter;

  /**
   * Persist one conversation's tags (saved on every toggle/create). The
   * authoritative summary patches the browse cache; a server-paged list is
   * patched in place, and reloaded when a tag filter is active (the edit may
   * change the row's membership in the filtered result).
   */
  const saveTags = useCallback(
    async (chatId: number, tags: string[]): Promise<void> => {
      try {
        const updated = await imb.chats.setTags(chatId, tags);
        if (updated === null) return;
        appStore.replaceChat(updated);
        if (tagFilterRef.current.length > 0) {
          search.reset();
        } else {
          search.mutate((items) =>
            items.map((chat) =>
              chat.id === chatId ? { ...chat, tags: updated.tags } : chat,
            ),
          );
        }
        // Refresh the candidate list so a newly created tag is selectable
        // elsewhere without a remount.
        setTagOptions(await imb.tags.list());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [search],
  );

  // Candidate tags (distinct, currently in use) for the row editor + filter.
  useEffect(() => {
    let alive = true;
    void imb.tags
      .list()
      .then((tags) => {
        if (alive) setTagOptions(tags);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * The composer wrote tags to the conversation (a common-project pick). The
   * `chats:changed` broadcast updates the browse-cache row; a server-paged
   * list is reloaded, and the candidate list is refetched so tags that only
   * exist because of a project become selectable in the filter.
   */
  const handleTagsApplied = useCallback(
    (_chatId: number): void => {
      void imb.tags
        .list()
        .then(setTagOptions)
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : String(err)),
        );
      if (serverMode) search.reset();
    },
    [serverMode, search],
  );

  const loadMessages = useCallback(async (chatId: number): Promise<void> => {
    try {
      const data = await imb.messages.list(chatId);
      loadedChatIdRef.current = chatId;
      setMessages(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /**
   * Mark `chatId` read and mirror the cleared counter into every list source:
   * the browse cache (`setChatUnread`), and — when the visible list is a
   * server-paged search / tag filter — the matching row in `search.items`
   * (otherwise its badge would stay stale). Unconditional; callers either know
   * the chat is unread or call the guarded {@link clearSelectedUnread}.
   */
  const applyUnreadCleared = useCallback(
    (chatId: number): void => {
      void imb.chats.markRead(chatId);
      appStore.setChatUnread(chatId, 0);
      if (serverModeRef.current) {
        search.mutate((items) =>
          items.map((c) => (c.id === chatId ? { ...c, unread: 0 } : c)),
        );
      }
    },
    [search.mutate],
  );

  /**
   * Idempotent "selected ⇒ read": clear `chatId`'s unread only when it
   * currently has some. Repeated calls (window focus, unread pushes, a no-op
   * re-selection) are therefore cheap and never re-issue IPC. Used wherever a
   * chat can become the displayed one *without* the `selectedId` effect running
   * (e.g. regaining window focus, or a notification click landing on the chat
   * that is already selected).
   */
  const clearSelectedUnread = useCallback(
    (chatId: number | null): void => {
      if (chatId === null) return;
      const inCache = appStore.data.chats.items.find((c) => c.id === chatId);
      const inList = chatsRef.current.find((c) => c.id === chatId);
      if ((inCache?.unread ?? 0) <= 0 && (inList?.unread ?? 0) <= 0) return;
      applyUnreadCleared(chatId);
    },
    [applyUnreadCleared],
  );

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

  // Switching between browse/search (query/tag change) clears the selection.
  useEffect(() => {
    clearSelection();
  }, [clearSelection, debouncedQuery, tagFilterKey]);

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
    clearSelectedUnread(selectedId);
  }, [selectedId, loadMessages, clearSelectedUnread]);

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
    // `selectChat` is a no-op when the target is already selected (React bails
    // out on the identical state and the selectedId effect never re-runs), so
    // clear its unread explicitly to cover the notification-click path that
    // lands on the currently-open chat.
    clearSelectedUnread(focusChatId);
    appStore.focusChatId = null;
  }, [focusChatId, chats, selectChat, clearSelectedUnread]);

  useEffect(() => {
    const offMessages = imb.messages.onChanged((payload) => {
      const { chatId } = payload;
      if (chatId !== selectedIdRef.current) {
        // A background chat: keep the visible (server-paged) list's badge in
        // sync, since `refreshChatSummary` only updates the browse cache. The
        // +1 mirrors `appendMessage`'s unread rule (root chat, non-silent,
        // employee/assistant sender) — the same rule app-store uses for the
        // global beep.
        if (
          serverModeRef.current &&
          payload.root &&
          payload.senderEmployeeId !== null &&
          !payload.silent
        ) {
          search.mutate((items) =>
            items.map((c) =>
              c.id === chatId ? { ...c, unread: c.unread + 1 } : c,
            ),
          );
        }
        return;
      }
      // The currently-open chat: refresh its thread and keep it read. The
      // notification beep is handled globally in app-store for any root chat,
      // so it is no longer gated on this selection.
      applyUnreadCleared(chatId);
      void loadMessages(chatId);
    });
    return offMessages;
  }, [applyUnreadCleared, loadMessages, search.mutate]);

  // Two paths that can leave the *already-selected* chat marked unread:
  //  - the window regains focus (nothing changes on focus by itself), and
  //  - an `imb_notify` bump arrives for the selected chat while it is open
  //    (that path pushes only `chats:unreadChanged`, never `messages:changed`).
  // Both clear it again; the clear is idempotent, so they are cheap no-ops in
  // the common case. `chats:unreadChanged` additionally keeps the visible
  // (server-paged) list's badge in sync with the browse cache for every chat.
  useEffect(() => {
    const offFocus = imb.windowControls.onFocus(() => {
      clearSelectedUnread(selectedIdRef.current);
    });
    const offUnread = imb.chats.onUnreadChanged(({ chatId, unread }) => {
      if (chatId === selectedIdRef.current) {
        // The selected chat is read by definition; clear the stray bump.
        if (unread > 0) applyUnreadCleared(chatId);
        return;
      }
      // Any other chat: keep the visible (server-paged) list's badge in sync
      // with the browse cache (the payload carries the authoritative count).
      if (serverModeRef.current) {
        search.mutate((items) =>
          items.map((c) => (c.id === chatId ? { ...c, unread } : c)),
        );
      }
    });
    return () => {
      offFocus();
      offUnread();
    };
  }, [applyUnreadCleared, clearSelectedUnread, search.mutate]);

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
      // A brand-new chat has no unread, but run the same idempotent clear so
      // every "selected ⇒ read" rendezvous goes through one path.
      clearSelectedUnread(chat.id);
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
        <div className="imb-chat-search-stack">
          <SearchInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("Search chats")}
            hint={IS_MAC ? "⌘K" : "Ctrl+K"}
          />
          <TagSelect
            className="imb-chat-tag-filter"
            value={tagFilter}
            options={tagOptions}
            allowNoTag
            placeholder={t("Filter by tags")}
            onChange={setTagFilter}
          />
        </div>
      }
      footer={
        <Button block onClick={() => void newChat()}>
          {t("New Chat")}
        </Button>
      }
    >
      <ItemList
        key={listSourceKey}
        items={chats}
        getItemKey={chatItemKey}
        estimateSize={chatRowEstimate}
        loading={listLoading}
        loadingMore={listLoadingMore}
        hasMore={listHasMore}
        loadMore={() => void search.loadMore()}
        loadError={listError}
        emptyMessage={chatListEmptyMessage(isSearching, tagFilter.length)}
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
            footer={
              <TagSelect
                className="imb-chat-tag-select"
                value={chat.tags}
                options={tagOptions}
                allowCreate
                noClear
                placeholder={`# ${t("Tags")}`}
                onChange={(next) => void saveTags(chat.id, next)}
              />
            }
            avatar={
              <Avatar
                letter={displayTitle(chat.title).slice(0, 1)}
                name={displayTitle(chat.title)}
                size={30}
              />
            }
            name={
              <span className="imb-chat-name-wrap">
                {chat.pinned && (
                  <PinGlyph className="imb-chat-pin" aria-hidden="true" />
                )}
                {CHAT_MUTE_ENABLED && chat.muted && (
                  <MuteGlyph className="imb-chat-mute" aria-hidden="true" />
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
              const muteItem = chatMuteMenuItem(
                chat,
                (muted) => void toggleMute(chat.id, muted),
              );
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
                  ...(muteItem ? [muteItem] : []),
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
        onTagsApplied={handleTagsApplied}
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
