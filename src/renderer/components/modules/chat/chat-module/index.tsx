import { ASSISTANT_ID } from "@shared/constants/employees";
import { INTEGRATION_LABEL_KEYS } from "@shared/constants/integrations";
import { MAX_TAGS_PER_CHAT, TAG_FILTER_NONE } from "@shared/constants/tags";
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cls } from "reactutils";
import { appStore, IS_MAC, useApp } from "../../../../app-store";
import { useDebouncedValue } from "../../../../hooks/use-debounced-value";
import { useInfiniteList } from "../../../../hooks/use-infinite-list";
import { useModuleFilter } from "../../../../hooks/use-module-filter";
import { useMultiSelect } from "../../../../hooks/use-multi-select";
import { ModuleView } from "../../../app-shell";
import { Avatar } from "../../../avatar";
import { Button } from "../../../button";
import { ContextMenu, type ContextMenuState } from "../../../context-menu";
import { EmployeeAvatar } from "../../../employee-avatar";
import { FilterBar } from "../../../filter-bar";
import { IconButton } from "../../../icon-button";
import { IconSearch } from "../../../icons";
import { Input } from "../../../input";
import { ItemList } from "../../../item-list";
import { ListPane } from "../../../list-pane";
import { ListRow } from "../../../list-row";
import { useMentionResolver } from "../../../markdown/use-mention";
import { Modal } from "../../../modal";
import {
  applyNoTagExclusion,
  buildTagFilterOptions,
  TagSelect,
} from "../../../tag-select";
import { Tooltip } from "../../../tooltip";
import { pairAskAnswers } from "../ask-answer";
import { ChatInputBar } from "../chat-input-bar";
import { CHAT_MUTE_ENABLED, chatMuteMenuItem, MuteGlyph } from "../chat-mute";
import { MessageItem } from "../message-item";
import {
  MY_JUMP_TOP_GAP,
  MyMessageJump,
  type MyMessageEntry,
} from "../my-message-jump";
import { NewMessagesJump } from "../new-messages-jump";
import { formatChatPreview } from "../preview-text";
import { ProgressGroup } from "../progress-group";
import { groupProgressRuns, type ProgressRun } from "../progress-runs";
import {
  displayTitle,
  formatChatTime,
  shouldShowTimeSeparator,
} from "../relative-time";
import "../thread.css";
import { ThreadFindBar } from "../thread-find";
import { useThreadFind } from "../thread-find/use-thread-find";
import {
  PIN_THRESHOLD,
  prefersReducedMotion,
  scrollThreadToRow,
  type ThreadAlign,
} from "../thread-scroll";
import { TimeSeparator } from "../time-separator";
import { buildUnseenBatch, type UnseenBatch } from "../unseen-batch";
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
 * hits, a tag filter that matches nothing, or both stacked — the two are
 * AND-combined, so a keyword + tag miss needs its own wording).
 */
function chatListEmptyMessage(isSearching: boolean, tagCount: number): string {
  if (isSearching && tagCount > 0) {
    return t("No conversations match these filters");
  }
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

/**
 * Every text a progress card shows, lower-cased, in one string: the title plus
 * each step's employee name and task. Used to decide whether a find query
 * matches a card that is currently hidden inside a history layer.
 */
function progressCardText(message: Message): string {
  const parts = [message.content];
  for (const step of message.steps ?? []) {
    if (step === null || typeof step !== "object") continue;
    parts.push(step.name, step.task);
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Collapse every whitespace run (newlines included) to one space — the "my
 * messages" list is one line per entry, so the raw text is never shown.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Per-chat thread scroll, kept outside the component so it survives a module
 * switch. A plain `Map` (not the appStore proxy): scroll is high-frequency and
 * imperative, and nothing should re-render when it changes. Session-only.
 */
interface ChatScroll {
  scrollTop: number;
  pinned: boolean;
  /**
   * Id of the newest rendered message the boss had already been shown when the
   * thread was last pinned to the bottom — i.e. how far she has read. Used to
   * rebuild the "new messages" marker after a chat or module switch: anything
   * newer than this is unseen. `null` until the chat has been seen at the tail
   * in this session.
   */
  seenUpToId: number | null;
}
const chatScrollStore = new Map<number, ChatScroll>();

/**
 * Merge one patch into a chat's scroll record. Each writer only owns part of the
 * record (the scroll position, or the read position), so a plain `set` would
 * silently drop the fields its caller knows nothing about.
 */
function patchChatScroll(chatId: number, patch: Partial<ChatScroll>): void {
  const current = chatScrollStore.get(chatId);
  chatScrollStore.set(chatId, {
    scrollTop: patch.scrollTop ?? current?.scrollTop ?? 0,
    pinned: patch.pinned ?? current?.pinned ?? true,
    seenUpToId: patch.seenUpToId ?? current?.seenUpToId ?? null,
  });
}

/**
 * Is the window actually on screen? A hidden / minimized / occluded window means
 * "the boss is not looking": messages that arrive then must not count as read,
 * and the view must not creep forward behind her back.
 */
function isDocumentVisible(): boolean {
  return document.visibilityState !== "hidden";
}

export function ChatModule(): React.JSX.Element {
  const { data, focusChatId } = useApp();
  const [selectedId, setSelectedId] = useState<number | null>(
    // Restore the chat selected before this module was unmounted.
    () => appStore.activeRootChatId,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  // Search text + tag filter of the list below, stored on the appStore so a
  // module switch does not lose them (the module unmounts on a switch).
  // Session-only: an app restart starts with an empty search / no tag filter.
  // The input keeps the raw `query` (instant feedback); everything that drives
  // the (server-paged) search uses the debounced value so one keystroke does
  // not fire an IPC + FTS/LIKE query, and the virtualized list is not remounted
  // mid-typing.
  const {
    query,
    tags: tagFilter,
    setQuery,
    setTags: setTagFilter,
  } = useModuleFilter("chat");
  const debouncedQuery = useDebouncedValue(query);
  // Candidate tags for both tag pickers (row editor + list filter). Kept in
  // component state: the candidates come from the `chat_tags` table and must be
  // re-read on every mount so a tag deleted meanwhile cannot linger.
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  // Pending "a new chat was just created" request for the composer (see
  // `ChatInputBar.composerReset`). `null` after the composer applied it, so a
  // chat switch can never replay the reset; ordinary selections never touch it.
  const [composerReset, setComposerReset] = useState<{
    chatId: number;
    seq: number;
  } | null>(null);
  const composerResetSeqRef = useRef(0);
  /** Drop the request the composer just applied (or discarded as stale). */
  const applyComposerReset = useCallback((seq: number): void => {
    setComposerReset((current) => (current?.seq === seq ? null : current));
  }, []);
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
  // The batch of messages behind the floating "new messages" pill (see
  // `../new-messages-jump`). The state drives the pill; the ref mirrors it for
  // the scroll handler and the visibility pass, which are stable callbacks.
  const [unseen, setUnseen] = useState<UnseenBatch | null>(null);
  const unseenRef = useRef<UnseenBatch | null>(null);
  unseenRef.current = unseen;
  // Id of the newest rendered message: the read baseline is advanced from it.
  const newestVisibleIdRef = useRef<number | null>(null);
  // Read position of the open chat, mirrored from `ChatScroll.seenUpToId`.
  const seenUpToIdRef = useRef<number | null>(null);
  // Coalesces the scroll-driven visibility pass to one per frame.
  const unseenCheckRef = useRef(0);
  // Latest scroll handler, for the window-visibility listener (which is
  // registered before the handler is defined and must not re-subscribe).
  const handleThreadScrollRef = useRef<() => void>(() => undefined);
  // Set by the restore path in the follow effect, consumed by the marker pass:
  // a batch that came back from a restore is *announced*, not "already on
  // screen", even when its first row happens to be visible.
  const restoreBatchPendingRef = useRef(false);
  // Whether the batch currently on screen is *announced* — it arrived while she
  // was not looking (a restore, or a hidden window). Announced batches are not
  // auto-dismissed just because their first row happens to be on screen: the
  // pill is what tells her, and it stays until she reaches the tail or jumps.
  const batchAnnouncedRef = useRef(false);
  const locale = getLocale();
  // Chat-list previews show `@名字` for `@<id>` mentions (plain text, so no
  // theme color or click target there).
  const { resolveMention } = useMentionResolver(selectedId ?? 0, false);

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
  // Options of the filter bar's tag panel: candidates + any selected tag that
  // is missing from them + the "No tags" pseudo-option (plain text, no `#`).
  const filterOptions = useMemo(
    () => buildTagFilterOptions(tagOptions, tagFilter, true),
    [tagOptions, tagFilter],
  );
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
  const isSearchingRef = useRef(isSearching);
  isSearchingRef.current = isSearching;
  // Stable handle to the paged list, so action callbacks (pin / mute / delete /
  // rename) can recompute it without their dependency arrays churning on every
  // render — `useInfiniteList` returns a fresh wrapper object each render while
  // `reset` / `mutate` themselves are stable.
  const searchRef = useRef(search);
  searchRef.current = search;
  // The list's keyword input (the `FilterBar`), focused by the ⌘K shortcut.
  const searchInputRef = useRef<HTMLInputElement>(null);

  /**
   * Rebuild the visible chat list after a mutation that can change *which* rows
   * match or how they sort (delete, pin, tag edits).
   * - No filter (`browse`): the list renders `appStore.data.chats.items`, so
   *   `reloadChats()` re-fetches it.
   * - Keyword search / tag filter: the list renders `search.items`, which
   *   `reloadChats()` never touches (it only refills the app store cache), so
   *   page 1 has to be recomputed from the current query + filter — otherwise a
   *   deleted row keeps showing up / the result set stays stale.
   * Callers must not `reloadChats()` themselves: this refreshes both sources.
   */
  const refreshVisibleList = useCallback(async (): Promise<void> => {
    if (serverModeRef.current) searchRef.current.reset();
    await appStore.reloadChats();
  }, []);

  /**
   * Patch one row of the server-paged list in place (no re-fetch, no flash).
   * Only valid for mutations that leave membership and ordering untouched
   * (title under a tag filter, mute): `reloadChats()` never updates
   * `search.items`, so such a row would otherwise keep its stale summary.
   */
  const patchPagedChat = useCallback(
    (chatId: number, patch: Partial<ChatSummary>): void => {
      if (!serverModeRef.current) return;
      searchRef.current.mutate((items) =>
        items.map((chat) =>
          chat.id === chatId ? { ...chat, ...patch } : chat,
        ),
      );
    },
    [],
  );

  /**
   * Pin or unpin one conversation, then refresh the list order. Pinned chats
   * sort first, so both data sources must be rebuilt: the browse cache via
   * `reloadChats()` and — when a search / tag filter is active — the
   * server-paged page 1 via `search.reset()` (a re-sort across not-yet-loaded
   * pages cannot be done locally by patching rows).
   */
  const togglePin = useCallback(
    async (id: number, pinned: boolean): Promise<void> => {
      try {
        await imb.chats.setPinned(id, pinned);
        await refreshVisibleList();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refreshVisibleList],
  );

  /**
   * Mute or unmute one conversation, then refresh the list cache. Mute changes
   * neither the membership nor the order of the rows, so the server-paged list
   * is patched in place (a re-fetch would flash the list and re-mount the open
   * thread for nothing).
   */
  const toggleMute = useCallback(
    async (id: number, muted: boolean): Promise<void> => {
      try {
        await imb.chats.setMuted(id, muted);
        patchPagedChat(id, { muted: muted === true });
        await appStore.reloadChats();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [patchPagedChat],
  );

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
   * Stable ask-card answer handler. `MessageItem` is memoized, so it must not
   * receive a fresh closure on every render (the row would re-render with it).
   */
  const handleAnswered = useCallback(
    (chatId: number): void => {
      void loadMessages(chatId);
    },
    [loadMessages],
  );

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
      seenUpToIdRef.current = null;
      unseenRef.current = null;
      setUnseen(null);
      setMessages([]);
      return;
    }
    // Restore this chat's previous scroll position — whatever `pinned` says.
    // `pinned` records that she *left* at the tail, not that she has read what
    // arrived since: when a batch is pending the effect below keeps the old
    // position (instead of following the tail) so the pill can offer the start
    // of the batch. A fresh selection has no saved position and starts pinned.
    const saved = chatScrollStore.get(selectedId);
    pinnedRef.current = saved ? saved.pinned : true;
    restoreScrollRef.current = saved
      ? { chatId: selectedId, scrollTop: saved.scrollTop }
      : null;
    // The read baseline comes with the scroll record: re-entering a chat that
    // was left mid-history while messages arrived must show the marker again
    // (the detection effect compares the fresh `messages` against this).
    seenUpToIdRef.current = saved?.seenUpToId ?? null;
    // A batch belongs to the conversation it was built in.
    unseenRef.current = null;
    setUnseen(null);
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

  // Newest rendered message, for the read baseline the new-messages marker
  // advances. Read from a ref: the scroll handler is stable and must not
  // re-create on every reload.
  newestVisibleIdRef.current =
    visibleMessages.length > 0
      ? visibleMessages[visibleMessages.length - 1].id
      : null;

  // Every rendered message by id (progress runs are stored as ids only, so the
  // thread can resolve a run's cards without re-walking the list per group).
  const messageById = useMemo(() => {
    const map = new Map<number, Message>();
    for (const message of messages) map.set(message.id, message);
    return map;
  }, [messages]);

  // Consecutive progress cards of one task group fold into a single run (see
  // `../progress-runs`): the assistant re-posts the whole step list on every
  // update, so a run is N snapshots of the same work.
  const progressRuns = useMemo(
    () => groupProgressRuns(visibleMessages),
    [visibleMessages],
  );

  // Which card of a run the boss paged to, keyed by the run's anchor id. The
  // stored run signature invalidates the choice as soon as the run receives a
  // new card (a fresh snapshot is what matters, so the group returns to the
  // newest), and the map is dropped when the conversation changes.
  const [shownCards, setShownCards] = useState<
    Map<number, { signature: string; messageId: number }>
  >(() => new Map());
  // A card a jump asked to reveal (it is flashed once it is the shown one).
  const [revealTarget, setRevealTarget] = useState<{
    anchorId: number;
    messageId: number;
  } | null>(null);

  const pageRun = useCallback((run: ProgressRun, messageId: number): void => {
    setShownCards((prev) => {
      const next = new Map(prev);
      next.set(run.anchorId, { signature: run.signature, messageId });
      return next;
    });
    setRevealTarget((current) =>
      current !== null && current.anchorId === run.anchorId ? null : current,
    );
  }, []);

  const handleRevealed = useCallback((run: ProgressRun): void => {
    setRevealTarget((current) =>
      current !== null && current.anchorId === run.anchorId ? null : current,
    );
  }, []);

  // A different conversation starts on the newest card of every run.
  useEffect(() => {
    setShownCards(new Map());
    setRevealTarget(null);
  }, [selectedId]);

  // Messages the boss herself wrote, **oldest first** (the order they were said
  // in — the list reads top-down like the transcript): a plain text bubble with
  // no sender (the composer and IM integrations both store it that way).
  // `answer` rows are folded into their ask card and not rendered, the
  // `interrupted` notice is an app-generated hint, and every other kind is
  // written by an employee or by the app — none of them is "something the boss
  // said".
  const myMessages = useMemo<MyMessageEntry[]>(() => {
    const entries: MyMessageEntry[] = [];
    for (const message of visibleMessages) {
      if (message.senderEmployeeId !== null || message.kind !== "text") {
        continue;
      }
      const text = collapseWhitespace(message.content);
      if (text.length > 0) entries.push({ id: message.id, text });
    }
    return entries;
  }, [visibleMessages]);

  // Cmd/Ctrl+K focuses the chat search (the same muscle memory as most apps).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }
      const input = searchInputRef.current;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /**
   * Are there rendered messages newer than the read baseline? Asked at restore
   * time, before the marker state exists, to decide whether landing on the tail
   * would skip content the boss has not seen yet.
   */
  const hasPendingBatch = useCallback((): boolean => {
    const seen = seenUpToIdRef.current;
    const newest = newestVisibleIdRef.current;
    if (seen === null || newest === null || newest <= seen) return false;
    return (
      buildUnseenBatch(
        visibleMessages,
        seen,
        progressRuns.runByMessageId,
        null,
      ) !== null
    );
  }, [visibleMessages, progressRuns]);

  // Auto-scroll to the newest message, but only while the user is pinned to
  // the bottom. Incoming messages/run events must not yank a user who scrolled
  // up to read history. A restored position wins once, after that chat's
  // messages have rendered.
  //
  // Two things never count as "following the live tail":
  //  1. A **restore** while a batch is pending. Re-entering a conversation the
  //     boss left at the bottom used to jump her straight to the newest message,
  //     which silently skipped everything that arrived while she was away. She
  //     asked to land back where she left off instead, with the "new messages"
  //     pill offering the start of the batch.
  //  2. A **hidden window**. Nothing she could have read happened while the
  //     window was not on screen, so the view must not creep forward (and
  //     `markSeen` must not advance either).
  //
  // A **layout** effect (not a passive one): the marker pass below is a layout
  // effect too, and it must judge the position this effect just produced. A
  // passive follow would run *after* the marker pass, so on return the marker
  // would see the stale "pinned" flag from before the leave and swallow the
  // batch. It also keeps the landing position out of the first paint.
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const restore = restoreScrollRef.current;
    if (restore !== null) {
      // A restore is pending: do **nothing** until this chat's own rows are the
      // ones on screen. Scrolling the previously rendered chat here would move
      // the thread for nothing, and its `scroll` event is handled *after* the
      // new rows land — it would report the incoming chat as read (this is
      // exactly how a batch used to be swallowed on the way back).
      if (loadedChatIdRef.current !== restore.chatId) return;
      restoreScrollRef.current = null;
      if (pinnedRef.current && hasPendingBatch()) {
        el.scrollTop = restore.scrollTop;
        // The `scroll` event that follows re-syncs this, but the marker logic in
        // this same commit must already see the truth.
        pinnedRef.current = false;
        // She was away: the marker is what tells her about the batch (and what
        // takes her to its start), so it is announced even if the first new row
        // already sits in the viewport.
        restoreBatchPendingRef.current = true;
        return;
      }
      el.scrollTop = pinnedRef.current ? el.scrollHeight : restore.scrollTop;
      return;
    }
    if (pinnedRef.current && isDocumentVisible())
      el.scrollTop = el.scrollHeight;
  }, [messages, selectedRunStatus, hasPendingBatch]);

  /**
   * Advance the read baseline to the newest rendered message. Called whenever
   * the boss has reached the tail (or the start of a batch) — the marker must
   * not resurrect after she scrolls back up.
   */
  const markSeen = useCallback((): void => {
    const chatId = selectedIdRef.current;
    const newest = newestVisibleIdRef.current;
    if (chatId === null || newest === null) return;
    // `messages` can still hold the previous chat's rows for a frame after a
    // switch: never record those as this chat's read position.
    if (loadedChatIdRef.current !== chatId) return;
    // A hidden window is not a reader: the baseline only moves while the tail
    // is on screen for a looking boss.
    if (!isDocumentVisible()) return;
    seenUpToIdRef.current = newest;
    patchChatScroll(chatId, { seenUpToId: newest });
  }, []);

  /** Hide the marker: the batch behind it has been dealt with. */
  const dropUnseen = useCallback((): void => {
    unseenRef.current = null;
    restoreBatchPendingRef.current = false;
    batchAnnouncedRef.current = false;
    setUnseen(null);
    markSeen();
  }, [markSeen]);

  /**
   * The thread's row for a message id, whichever kind renders it.
   *
   * Two attributes address rows (the row-anchoring contract in
   * `../message-item`): a folded progress run by `data-progress-run` (its
   * `data-message-id` is the *shown* card, which a batch target — the run's
   * anchor — need not be), every other row by `data-message-id`. A run of a
   * **single** card renders as a plain message row, i.e. only the second
   * attribute is there — hence the fallback. Without it such a row was silently
   * unjumpable: the pill disappeared and nothing scrolled (the bug this
   * addresses), and the "batch start came into view" pass could never see it.
   */
  const findThreadRow = useCallback((messageId: number): HTMLElement | null => {
    const el = threadRef.current;
    // The id is interpolated into a selector: anything but a safe integer would
    // either throw or match nothing, and every stored id is one.
    if (el === null || !Number.isSafeInteger(messageId)) return null;
    return (
      el.querySelector<HTMLElement>(`[data-progress-run="${messageId}"]`) ??
      el.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
    );
  }, []);

  /**
   * Is the *start* of the batch on screen? Its top edge being inside the
   * viewport is the test (not "fully visible"): a first message taller than the
   * thread is at its start as soon as its top shows, which is exactly the
   * position the pill would scroll to.
   */
  const isBatchStartVisible = useCallback((row: HTMLElement): boolean => {
    const el = threadRef.current;
    if (el === null) return false;
    const viewport = el.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return rect.top >= viewport.top - 1 && rect.top < viewport.bottom - 1;
  }, []);

  /**
   * Re-evaluate the marker after the thread moved: it stays only while the boss
   * cannot see the start of the batch. Reaching the tail, or bringing the start
   * into view by hand, means she has arrived — the marker goes and the baseline
   * advances so it does not come back.
   */
  const checkUnseenVisibility = useCallback((): void => {
    if (unseenRef.current === null) return;
    if (pinnedRef.current) {
      dropUnseen();
      return;
    }
    // A batch she was not looking at is read forwards from wherever she is: it
    // stays until she reaches the tail or takes the jump below. (A live arrival
    // she was watching is different: if its first row is already on screen
    // there is nothing to jump to.)
    if (batchAnnouncedRef.current) return;
    const row = findThreadRow(unseenRef.current.targetId);
    // A row that is gone (mid-reload) is not evidence of anything: keep the
    // marker, the next pass re-checks.
    if (row === null) return;
    if (isBatchStartVisible(row)) dropUnseen();
  }, [dropUnseen, findThreadRow, isBatchStartVisible]);

  /** One visibility pass per frame, however fast the thread scrolls. */
  const scheduleUnseenCheck = useCallback((): void => {
    if (unseenCheckRef.current !== 0) return;
    unseenCheckRef.current = window.requestAnimationFrame(() => {
      unseenCheckRef.current = 0;
      checkUnseenVisibility();
    });
  }, [checkUnseenVisibility]);

  /**
   * The window came back. While it was hidden the thread deliberately stopped
   * following the tail, so the pinned flag is stale: re-read it from the DOM and
   * let the marker pass run again (that is what reveals the pill after "hide the
   * window while the assistant is answering").
   */
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (!isDocumentVisible()) return;
      handleThreadScrollRef.current();
      if (unseenRef.current !== null) scheduleUnseenCheck();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [scheduleUnseenCheck]);

  // A pending frame must not outlive the module (it would run against a dead
  // thread ref).
  useEffect(() => {
    return () => {
      if (unseenCheckRef.current !== 0) {
        window.cancelAnimationFrame(unseenCheckRef.current);
        unseenCheckRef.current = 0;
      }
    };
  }, []);

  /**
   * Detect messages that arrived while the boss was reading history.
   *
   * Declared **after** the auto-scroll effect on purpose: that effect is what
   * keeps a pinned view on the tail, so by the time this runs the position it
   * should judge is already in place. Layout (not passive) effect: the thread
   * DOM is committed, so a batch that is already on screen is dropped before
   * the pill is ever painted.
   *
   * The unit is a rendered row (`visibleMessages`, ids are globally monotonic)
   * and the count is "jump targets": a progress run renders once, so its N
   * snapshots are one target. All of that lives in `../unseen-batch` (pure, so
   * the batch rules can be exercised without a DOM).
   */
  useLayoutEffect(() => {
    const chatId = selectedIdRef.current;
    const newest = newestVisibleIdRef.current;
    // Nothing to judge yet (no chat, or the previous chat's rows are still on
    // screen while this one loads).
    if (chatId === null || newest === null) return;
    if (loadedChatIdRef.current !== chatId) return;
    const seen = seenUpToIdRef.current;
    if (seen === null) {
      // First sighting in this session: the boss is being shown the tail, so
      // everything in it counts as read.
      markSeen();
      return;
    }
    if (newest <= seen) return;
    if (pinnedRef.current && isDocumentVisible()) {
      // The auto-scroll effect just kept the tail on screen, and the boss was
      // looking at it.
      dropUnseen();
      return;
    }
    const fromRestore = restoreBatchPendingRef.current;
    restoreBatchPendingRef.current = false;
    const previous = unseenRef.current;
    // A batch that came back with her from a restore, or that landed while the
    // window was hidden, is *announced* (see `batchAnnouncedRef`). Once a batch
    // exists, its character never changes: later messages just join it.
    const announced =
      previous !== null
        ? batchAnnouncedRef.current
        : fromRestore || !isDocumentVisible();
    const next = buildUnseenBatch(
      visibleMessages,
      seen,
      progressRuns.runByMessageId,
      previous,
    );
    // Nothing newer than the baseline, or an identical batch: leave the marker
    // (and the thread) alone.
    if (next === null || next === previous) return;
    // A message that landed just below the reading position is already visible
    // and she was watching: there is nothing to jump to. An *announced* batch is
    // the exception — see `checkUnseenVisibility`.
    const row = findThreadRow(next.targetId);
    if (!announced && row !== null && isBatchStartVisible(row)) {
      dropUnseen();
      return;
    }
    batchAnnouncedRef.current = announced;
    unseenRef.current = next;
    setUnseen(next);
  }, [
    visibleMessages,
    progressRuns,
    dropUnseen,
    findThreadRow,
    isBatchStartVisible,
    markSeen,
  ]);

  const handleThreadScroll = useCallback((): void => {
    const el = threadRef.current;
    if (!el) return;
    const pinned =
      el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD;
    pinnedRef.current = pinned;
    if (selectedIdRef.current !== null) {
      const chatId = selectedIdRef.current;
      // Sitting at the tail keeps the read baseline current, so re-entering the
      // chat later does not report already-read messages as new. Guarded by
      // `markSeen`'s rule: never record another chat's rows, and never advance
      // while the window is hidden.
      const newest =
        loadedChatIdRef.current === chatId && isDocumentVisible()
          ? newestVisibleIdRef.current
          : null;
      if (pinned && newest !== null) seenUpToIdRef.current = newest;
      patchChatScroll(chatId, {
        scrollTop: el.scrollTop,
        pinned,
        ...(pinned && newest !== null ? { seenUpToId: newest } : null),
      });
    }
    // Only while a batch is waiting: one rect read per frame, nothing while the
    // boss is simply reading (the common case).
    if (unseenRef.current !== null) scheduleUnseenCheck();
  }, [scheduleUnseenCheck]);
  handleThreadScrollRef.current = handleThreadScroll;

  /**
   * Scroll the thread so one row lands on the landing line. One rect read (no
   * measuring while hovering / scrolling) and the row flashes once the smooth
   * scroll settles; the scroll itself is shared with the other thread views
   * through `../thread-scroll`.
   */
  const scrollToRow = useCallback(
    (row: HTMLElement, align: ThreadAlign): void => {
      const el = threadRef.current;
      if (el === null) return;
      scrollThreadToRow(el, row, {
        topGap: MY_JUMP_TOP_GAP,
        align,
        // Following the live tail must not fight the jump: the follow effect
        // re-pins on every `messages` change, so `pinned` is cleared *before*
        // scrolling (a programmatic scroll emits `scroll`, which re-syncs it
        // from the position).
        beforeScroll: (target) => {
          pinnedRef.current = false;
          if (selectedIdRef.current !== null) {
            patchChatScroll(selectedIdRef.current, {
              scrollTop: target,
              pinned: false,
            });
          }
        },
        // The group flashes the revealed card itself once it is mounted, but
        // the row flash covers a run that stays on its own card.
        flash: row,
      });
    },
    [],
  );

  /** Scroll the thread to one message row (whatever kind renders it). */
  const scrollToMessageRow = useCallback(
    (messageId: number, align: ThreadAlign = "top"): void => {
      const row = findThreadRow(messageId);
      if (row !== null) scrollToRow(row, align);
    },
    [findThreadRow, scrollToRow],
  );

  /**
   * Scroll to a folded progress run's row. Its `data-message-id` changes with
   * the card on screen, so the run anchor is what a jump can address before the
   * run has paged to the target card.
   */
  const scrollToRunRow = useCallback(
    (anchorId: number, align: ThreadAlign = "top"): void => {
      const row = findThreadRow(anchorId);
      if (row !== null) scrollToRow(row, align);
    },
    [findThreadRow, scrollToRow],
  );

  /**
   * Reveal the start of the new-message batch: vertically centered, so a slice
   * of the older context stays visible above it and the boss reads forwards
   * from there.
   *
   * The row is resolved **first**: a click that cannot land anywhere must leave
   * the pill (and the read baseline) alone instead of swallowing the batch —
   * the thread can be mid-reload, in which case a second click still works.
   * Only once there is somewhere to go is the marker dropped (it has done its
   * job, and a batch arriving afterwards starts from the new tail).
   */
  const jumpToUnseen = useCallback((): void => {
    const batch = unseenRef.current;
    if (batch === null) return;
    const row = findThreadRow(batch.targetId);
    if (row === null) return;
    dropUnseen();
    scrollToRow(row, "center");
  }, [dropUnseen, findThreadRow, scrollToRow]);

  /**
   * Jump to the newest message and resume following it (the 「Latest message」
   * row of the my-messages panel). Same end state as sending: `pinned` is set
   * *before* scrolling, so the follow effect keeps the view on the tail, and the
   * stored position matches the real one (a programmatic scroll emits `scroll`,
   * which re-syncs it anyway).
   */
  const jumpToLatest = useCallback((): void => {
    const el = threadRef.current;
    if (!el) return;
    pinnedRef.current = true;
    restoreScrollRef.current = null;
    // "Go to bottom" is the same arrival as clicking the new-messages pill: the
    // batch is on screen now, so it is read.
    dropUnseen();
    if (selectedIdRef.current !== null) {
      patchChatScroll(selectedIdRef.current, {
        scrollTop: Math.max(0, el.scrollHeight - el.clientHeight),
        pinned: true,
      });
    }
    el.scrollTo({
      top: el.scrollHeight,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [dropUnseen]);

  /**
   * A find-bar jump cleared the "pinned to the bottom" state (new messages must
   * not yank the view back to the tail while a match is being read) and records
   * the landing position, exactly like `jumpToMessage`.
   */
  const handleFindJump = useCallback((target: number): void => {
    pinnedRef.current = false;
    if (selectedIdRef.current !== null) {
      patchChatScroll(selectedIdRef.current, {
        scrollTop: target,
        pinned: false,
      });
    }
  }, []);

  // In-thread find (⌘F). It searches exactly what the thread renders, so it is
  // handed the same list the thread maps over (a folded answer is not rendered
  // and therefore not searchable).
  const threadFind = useThreadFind({
    chatId: selectedId,
    messages: visibleMessages,
    threadRef,
    // The delete dialog owns the keyboard while it is open.
    hotkeysEnabled: !deleteOpen,
    onBeforeJump: handleFindJump,
  });

  // A run renders one card, so a find query can only match the card that is
  // shown. A query that matches an older snapshot of a run therefore pages that
  // run to the matching card — the match then exists, is highlighted, and the
  // jump lands on it. Dropped when the bar closes, which puts every run back on
  // its own card (the newest, unless the boss paged).
  const findQuery = threadFind.open
    ? threadFind.query.trim().toLowerCase()
    : "";
  const findShownCards = useMemo(() => {
    const cards = new Map<number, number>();
    if (findQuery.length === 0) return cards;
    for (const run of progressRuns.runs) {
      if (run.ids.length < 2) continue;
      const hidden = run.ids.slice(0, -1);
      for (const id of hidden) {
        const card = messageById.get(id);
        if (card !== undefined && progressCardText(card).includes(findQuery)) {
          cards.set(run.anchorId, id);
          break;
        }
      }
    }
    return cards;
  }, [findQuery, progressRuns, messageById]);

  // The card each run shows: a pending reveal wins (the jump is already
  // scrolling there), then a find match, then the boss's own choice, then the
  // newest snapshot.
  const shownCardId = (run: ProgressRun): number => {
    if (revealTarget !== null && revealTarget.anchorId === run.anchorId) {
      return revealTarget.messageId;
    }
    const found = findShownCards.get(run.anchorId);
    if (found !== undefined) return found;
    const paged = shownCards.get(run.anchorId);
    if (paged !== undefined && paged.signature === run.signature) {
      return paged.messageId;
    }
    return run.latestId;
  };

  const progressRunsRef = useRef(progressRuns);
  progressRunsRef.current = progressRuns;

  /**
   * Jump to one message. An older card of a run is not in the DOM while another
   * card of that run is shown, so the jump pages the run to it (and the group
   * flashes it once it is on screen) and scrolls the thread to the run's row.
   */
  const jumpToMessage = useCallback(
    (messageId: number): void => {
      const run = progressRunsRef.current.runByMessageId.get(messageId);
      if (run === undefined) {
        scrollToMessageRow(messageId);
        return;
      }
      pageRun(run, messageId);
      setRevealTarget({ anchorId: run.anchorId, messageId });
      scrollToRunRow(run.anchorId);
    },
    [pageRun, scrollToMessageRow, scrollToRunRow],
  );

  const handleSend = useCallback(
    async (text: string, attachments: MessageAttachment[]): Promise<void> => {
      if (selectedId === null) return;
      const chatId = selectedId;
      // Sending always jumps to the bottom, even if the user had scrolled up.
      pinnedRef.current = true;
      restoreScrollRef.current = null;
      // A message the boss herself is sending is not something to be told
      // about; the follow effect will show the tail (and its replies).
      dropUnseen();
      try {
        await imb.chat.send(chatId, text, attachments);
        void loadMessages(chatId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [selectedId, loadMessages, dropUnseen],
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
      // Clear any active search *and* tag filter so the new chat is present in
      // the (unfiltered) list and its detail/input can be rendered. Clearing
      // only the query left the tag filter applying: a brand-new chat has no
      // tags, so it was missing from the filtered result, the detail pane
      // stayed empty and the auto-select effect re-selected another chat.
      setQuery("");
      setTagFilter([]);
      setSelectedId(chat.id);
      // A brand-new chat has no unread, but run the same idempotent clear so
      // every "selected ⇒ read" rendezvous goes through one path.
      clearSelectedUnread(chat.id);
      // Reset the composer and focus the new chat's input. The new chat has no
      // draft yet; clearing it is defensive only (a recycled id must never leak
      // an old draft into a fresh composer). The previous chat's draft is
      // deliberately kept — switching chats / creating one never drops drafts.
      appStore.clearChatDraft(chat.id);
      composerResetSeqRef.current += 1;
      setComposerReset({ chatId: chat.id, seq: composerResetSeqRef.current });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [clearSelection]);

  const deleteSelected = useCallback(async (): Promise<void> => {
    if (deleteIds.length === 0) return;
    setDeleteOpen(false);
    const ids = [...deleteIds];
    // Drop the target ids straight away so a re-opened dialog / a second action
    // can never re-use the just-deleted set.
    setDeleteIds([]);
    // Delete one by one and remember the first failure instead of aborting: an
    // aborted loop would leave the already-deleted chats (and their cascade)
    // deleted while the list below was never refreshed.
    let failure: string | null = null;
    for (const id of ids) {
      try {
        await imb.chats.remove(id);
      } catch (err) {
        failure ??= err instanceof Error ? err.message : String(err);
      }
    }
    // Drop the just-deleted keys before refreshing: the auto-select effect
    // re-mirrors the recovered active row into the selection once the refreshed
    // items land, so clearing first cannot wipe a fresh selection.
    clearSelection();
    // Refresh both list sources: the browse cache, and — for a keyword search /
    // tag filter — page 1 recomputed from the current query + filter, so the
    // deleted rows really disappear and later pages shift up as expected.
    try {
      await refreshVisibleList();
      // Candidate tags come from the `chat_tags` table: deleting the last chat
      // holding a tag would otherwise leave it selectable in both tag pickers.
      setTagOptions(await imb.tags.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    if (failure !== null) setError(failure);
  }, [deleteIds, clearSelection, refreshVisibleList]);

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
        if (isSearchingRef.current) {
          // A keyword search matches on the title, so the row may newly match /
          // stop matching: recompute page 1 from the current query.
          searchRef.current.reset();
        } else {
          // Tag filter (or no filter): the title affects neither membership nor
          // order, so patch the row instead of re-fetching (and re-mounting the
          // open thread). `chats:changed` covers the browse cache.
          patchPagedChat(chatId, { title: updated.title });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedId, selectedRawTitle, titleDraft, patchPagedChat]);

  // Empty-state recovery: one click back to the unfiltered list (the keyword
  // and the tag chips are AND-combined, so a no-hit result may need both gone).
  const clearFilters = useCallback((): void => {
    setQuery("");
    setTagFilter([]);
  }, [setQuery, setTagFilter]);

  const listPane = (
    <ListPane
      title={t("Chats")}
      search={
        <FilterBar
          inputRef={searchInputRef}
          value={query}
          onValueChange={setQuery}
          filters={tagFilter}
          filterOptions={filterOptions}
          onFiltersChange={(next) =>
            setTagFilter(applyNoTagExclusion(tagFilter, next))
          }
          placeholder={t("Search chats")}
          hint={IS_MAC ? "⌘K" : "Ctrl+K"}
          filtersLabel={t("Filter by tags")}
          emptyHint={t("No tags yet")}
          maxSelected={MAX_TAGS_PER_CHAT}
        />
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
        emptyMessage={
          <div className="imb-chat-empty">
            <div>{chatListEmptyMessage(isSearching, tagFilter.length)}</div>
            {serverMode && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                {t("Clear filters")}
              </Button>
            )}
          </div>
        }
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
            sub={formatChatPreview(chat.preview, 80, resolveMention)}
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
          <EmployeeAvatar employeeId={0} size={30} />
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
        {/* Header trailing actions: the my-messages panel and the search entry.
            One `margin-left: auto` on the group keeps both pinned right (two
            auto margins would split the free space and float the group's first
            button towards the middle). */}
        <div className="imb-chat-header-actions">
          <MyMessageJump
            threadRef={threadRef}
            entries={myMessages}
            onSelect={jumpToMessage}
            onLatest={jumpToLatest}
          />
          {/* Header search entry: the same action as ⌘F (open + focus, or
              re-select the term when the bar is already up). `aria-pressed`
              states whether the bar is open; it never toggles it closed — that
              would make the button behave differently from the shortcut. */}
          <Tooltip
            placement="bottom"
            content={`${t("Find in chat")} · ${IS_MAC ? "⌘F" : "Ctrl+F"}`}
          >
            <IconButton
              className="imb-chat-find"
              label={t("Find in chat")}
              aria-pressed={threadFind.open}
              // The bubble above is the hint; an empty `title` suppresses the
              // native (duplicate) one the component would otherwise add.
              title=""
              boxSize={28}
              size={16}
              onClick={threadFind.openFind}
            >
              <IconSearch />
            </IconButton>
          </Tooltip>
        </div>
      </div>
      {/* The thread is the scroll container. The my-messages list lives in the
          header (a floating control over the transcript was covering message
          text), so the thread needs no reserved space for it. */}
      <div className="imb-chat-thread-wrap">
        <div
          className="imb-thread"
          ref={threadRef}
          // Focus target after the find bar closes when nothing better is
          // available (a message row keeps `focus-within` styling intact).
          tabIndex={-1}
          onScroll={handleThreadScroll}
        >
          {visibleMessages.map((message, index) => {
            const run = progressRuns.runByMessageId.get(message.id);
            // A run renders once, at its anchor (oldest card): it shows the
            // newest card and keeps the others in its history layer.
            if (run !== undefined && run.anchorId !== message.id) return null;
            return (
              <Fragment key={`${message.chatId}-${message.id}`}>
                {shouldShowTimeSeparator(
                  visibleMessages[index - 1],
                  message,
                ) && <TimeSeparator secs={message.createdAt} />}
                {run === undefined ? (
                  <MessageItem
                    message={message}
                    onAnswered={handleAnswered}
                    askAnswer={pairing.answerByAskId.get(message.id)}
                  />
                ) : (
                  <ProgressGroup
                    run={run}
                    cards={run.ids
                      .map((id) => messageById.get(id))
                      .filter((card): card is Message => card !== undefined)}
                    shownId={shownCardId(run)}
                    revealId={
                      revealTarget !== null &&
                      revealTarget.anchorId === run.anchorId
                        ? revealTarget.messageId
                        : null
                    }
                    onPage={pageRun}
                    onRevealed={handleRevealed}
                  />
                )}
              </Fragment>
            );
          })}
          {selectedRunStatus !== undefined && (
            // Reserved, fixed-height slot: it is present for the whole run, so
            // toggling the compaction text never shifts the messages above it.
            <div className="imb-run-status" role="status">
              {selectedRunStatus.compacting ? t("Compacting…") : ""}
            </div>
          )}
        </div>
        {threadFind.open && <ThreadFindBar find={threadFind} />}
        {/* Messages that arrived while the boss was reading history: floating
            pill over the bottom-right corner of the transcript, above the
            composer. Centering the start of the batch keeps a slice of the
            older context visible, so the batch can be read forwards. */}
        {unseen !== null && (
          <NewMessagesJump count={unseen.count} onReveal={jumpToUnseen} />
        )}
      </div>
      <ChatInputBar
        chatId={selected.id}
        composerReset={composerReset}
        onComposerResetApplied={applyComposerReset}
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
