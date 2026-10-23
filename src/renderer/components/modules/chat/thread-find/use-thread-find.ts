import type { Message } from "@shared/types";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useDebouncedValue } from "../../../../hooks/use-debounced-value";
import { scrollThreadToRect, scrollThreadToRow } from "../thread-scroll";

/**
 * In-thread search engine (⌘F / Ctrl+F) for the interactive chat module and the
 * read-only group-chat module.
 *
 * How it works: the thread renders every message of the conversation (both
 * views hold the full history — `imb.messages.list` is not paged), so there is
 * no backend involved. When the bar is open we walk the *rendered* text and
 * build a `Range` per occurrence; those ranges back both the highlight and the
 * jump target. Matching on the rendered text (rather than on the stored
 * Markdown source) is what the boss actually sees: `**重点**` is one text node
 * after rendering, and code/KaTeX/table content is searched too.
 *
 * Highlights use the CSS Custom Highlight API, i.e. no DOM is inserted into the
 * React-managed tree (see `index.css`). Where the API is unavailable the bar
 * still jumps and flashes the landing row — only the inline tint is lost.
 */

/** Registry names; keep in sync with `index.css`. */
const HIGHLIGHT_ALL = "imb-find";
const HIGHLIGHT_ACTIVE = "imb-find-active";

/**
 * Elements whose text is chat *content*. Only text inside one of these is
 * searched: the thread also renders chrome — avatar initials, the hover
 * timestamp, attachment chips, status tags, buttons — that must never produce
 * a hit. Chat card titles are deliberately absent (they are a link to another
 * conversation, not this one's content).
 */
const SEARCHABLE_SELECTOR = [
  ".imb-markdown",
  ".imb-bubble-text",
  ".imb-progress-card-title",
  ".imb-pname",
  ".imb-pname-task",
  ".imb-image-gen-prompt",
].join(", ");

/**
 * Cap on highlighted occurrences. Building one `Range` per hit is the real
 * cost here (a very long conversation is fully mounted); the cap keeps a
 * one-letter query from freezing the thread.
 */
const MAX_MATCHES = 500;

/**
 * Debounce before re-scanning while the user types (ms).
 *
 * Debounce, not throttle: only the value the user stops on is worth searching,
 * and every scan also moves the matched cursor / may scroll the thread —
 * running one mid-word would both waste work and yank the view around.
 *
 * 150ms is snappy enough for find-as-you-type on a normal conversation
 * (measured end-to-end input→counter: ~160ms at 60-200 rows); the longer one
 * is used for very long conversations, where one whole-transcript walk plus the
 * resulting commit is ~25ms at 600 rows and ~45ms at 2000 rows (see
 * `LONG_THREAD_ROWS`).
 */
const SCAN_DEBOUNCE_MS = 150;

/**
 * Threshold (messages) above which the longer debounce applies. A conversation
 * this long is fully mounted (no virtualization): the walk is the dominant
 * per-scan cost, so scanning less often matters more than the extra 150ms of
 * latency — the input itself stays perfectly responsive either way.
 */
const LONG_THREAD_ROWS = 600;

/** Debounce for a long conversation (ms). */
const LONG_THREAD_DEBOUNCE_MS = 300;

/**
 * Jumps closer together than this are one burst (a held Enter / ⌘G): the burst
 * scrolls without animation, so the smooth animations cannot pile up and leave
 * the view lagging several matches behind the counter.
 */
const JUMP_BURST_MS = 250;

/**
 * Landing line for a jump: clears the floating find bar (top-right), which is
 * ~20px from the thread's top edge and ~36px tall.
 */
const FIND_TOP_GAP = 64;

/** One occurrence of the query in the rendered thread. */
interface ThreadMatch {
  /** The exact span: highlighted, and the rect the jump scrolls to. */
  range: Range;
  /** The `.imb-msg` row the span lives in, for the landing flash. */
  row: HTMLElement | null;
}

/** Minimal shape of the parts of the CSS Custom Highlight API we use. */
interface HighlightLike {
  priority: number;
}
type HighlightCtor = new (...ranges: Range[]) => HighlightLike;
interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): void;
}

export interface ThreadFindOptions {
  /** The conversation on screen; changing it resets (and closes) the find state. */
  chatId: number | null;
  /**
   * The messages the thread renders, in order. Only used as a change signal
   * (and as the "there is nothing to search" case): any change re-scans, so a
   * message that arrives (or reloads) is immediately searchable.
   */
  messages: Message[];
  /** The thread's scroll container (the only scrolling element). */
  threadRef: RefObject<HTMLDivElement | null>;
  /**
   * False while the owner wants the shortcuts to stay inert (e.g. one of its
   * own dialogs is open and owns the keyboard).
   */
  hotkeysEnabled?: boolean;
  /**
   * Called with the computed `scrollTop` right before a jump, so the module can
   * drop its "pinned to the bottom" flag and record the position (new messages
   * must not yank the view back to the tail while reading a match).
   */
  onBeforeJump?: (targetTop: number) => void;
  /**
   * A match whose row is inside a collapsed progress run. Return true when the
   * caller will expand that run: the row has no box until the next layout, so
   * the jump waits and retries once the card is visible.
   */
  onRevealMatch?: (row: HTMLElement) => boolean;
}

export interface ThreadFind {
  open: boolean;
  /** Raw input value (instant feedback while typing). */
  query: string;
  setQuery: (query: string) => void;
  /** 1-based position of the active match; 0 when there is none. */
  position: number;
  /** Number of highlighted matches (capped by {@link MAX_MATCHES}). */
  count: number;
  /** More matches exist than the cap; the counter renders `n/m+`. */
  truncated: boolean;
  /** A non-empty query with no hit at all. */
  noMatch: boolean;
  openFind: () => void;
  closeFind: () => void;
  next: () => void;
  prev: () => void;
  /** The find field, so the bar can render (and focus) it. */
  inputRef: RefObject<HTMLInputElement | null>;
  /**
   * Spread onto the search field. No scan runs while an IME composition is in
   * flight: the intermediate (pinyin) value is worth nothing to search on and
   * would only flash spurious "No matches" results; the committed value is
   * scanned once, right after composition ends.
   */
  compositionHandlers: {
    onCompositionStart: () => void;
    onCompositionEnd: () => void;
  };
}

function highlightRegistry(): HighlightRegistryLike | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } })
    .CSS;
  return css?.highlights ?? null;
}

/** Build a `Highlight` when the runtime supports it; `null` otherwise. */
function createHighlight(
  ranges: Range[],
  priority: number,
): HighlightLike | null {
  const ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  if (typeof ctor !== "function") return null;
  try {
    const highlight = new ctor(...ranges);
    // The active occurrence must win where it overlaps the "all matches" layer.
    highlight.priority = priority;
    return highlight;
  } catch {
    return null;
  }
}

function clearHighlights(): void {
  const registry = highlightRegistry();
  if (registry === null) return;
  registry.delete(HIGHLIGHT_ALL);
  registry.delete(HIGHLIGHT_ACTIVE);
}

/** Set the single active occurrence layer (`activeIndex < 0` clears it). */
function applyActiveHighlight(
  matches: ThreadMatch[],
  activeIndex: number,
): void {
  const registry = highlightRegistry();
  if (registry === null) return;
  const active = matches[activeIndex];
  const one = active === undefined ? null : createHighlight([active.range], 1);
  if (one === null) registry.delete(HIGHLIGHT_ACTIVE);
  else registry.set(HIGHLIGHT_ACTIVE, one);
}

/** (Re)apply both highlight layers; `activeIndex < 0` = no active match. */
function applyHighlights(matches: ThreadMatch[], activeIndex: number): void {
  const registry = highlightRegistry();
  if (registry === null) return;
  if (matches.length === 0) {
    clearHighlights();
    return;
  }
  const all = createHighlight(
    matches.map((match) => match.range),
    0,
  );
  if (all !== null) registry.set(HIGHLIGHT_ALL, all);
  applyActiveHighlight(matches, activeIndex);
}

/**
 * Collect every occurrence of `query` in the thread's rendered content, in
 * document order (i.e. transcript order).
 *
 * Only content containers are visited, so the walk is proportional to the
 * amount of text, not to the number of nodes in the thread.
 */
function collectMatches(
  thread: HTMLElement,
  query: string,
): { matches: ThreadMatch[]; truncated: boolean } {
  const matches: ThreadMatch[] = [];
  const needle = query.toLowerCase();
  if (needle.length === 0) return { matches, truncated: false };

  const roots = thread.querySelectorAll<HTMLElement>(SEARCHABLE_SELECTOR);
  for (const root of roots) {
    // Defensive: a whitelisted container nested in another one would be walked
    // twice, producing duplicate hits for the same text.
    if (root.parentElement?.closest(SEARCHABLE_SELECTOR) != null) continue;
    const row = root.closest<HTMLElement>(".imb-msg");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (
      let node = walker.nextNode();
      node !== null;
      node = walker.nextNode()
    ) {
      const text = node.nodeValue ?? "";
      if (text.length < needle.length) continue;
      const lowered = text.toLowerCase();
      // `toLowerCase` may change the string length for a few exotic characters;
      // fall back to a case-sensitive scan then so offsets stay valid.
      const caseInsensitive = lowered.length === text.length;
      const source = caseInsensitive ? lowered : text;
      const target = caseInsensitive ? needle : query;
      let from = 0;
      for (;;) {
        const at = source.indexOf(target, from);
        if (at < 0) break;
        if (matches.length >= MAX_MATCHES) return { matches, truncated: true };
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + target.length);
        matches.push({ range, row });
        from = at + target.length;
      }
    }
  }
  return { matches, truncated: false };
}

/** The first match at or below the thread's top edge (0 when none is left). */
function nearestIndex(thread: HTMLElement, matches: ThreadMatch[]): number {
  const top = thread.getBoundingClientRect().top;
  for (let index = 0; index < matches.length; index += 1) {
    const rect = matches[index].range.getBoundingClientRect();
    if (rect.bottom >= top) return index;
  }
  return 0;
}

/** True when `rect` is already fully inside the thread's viewport. */
function isFullyVisible(thread: HTMLElement, rect: DOMRect): boolean {
  // A hidden progress card reports an empty box. That is not "already on
  // screen": the jump has to open the run and bring the row in.
  if (rect.width === 0 && rect.height === 0) return false;
  const view = thread.getBoundingClientRect();
  return rect.top >= view.top && rect.bottom <= view.bottom;
}

export function useThreadFind({
  chatId,
  messages,
  threadRef,
  hotkeysEnabled = true,
  onBeforeJump,
  onRevealMatch,
}: ThreadFindOptions): ThreadFind {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [count, setCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  // True between `compositionstart` and `compositionend`: an IME's intermediate
  // value is not worth scanning (see `ThreadFind.compositionHandlers`).
  const [composing, setComposing] = useState(false);
  const scanDebounceMs =
    messages.length > LONG_THREAD_ROWS
      ? LONG_THREAD_DEBOUNCE_MS
      : SCAN_DEBOUNCE_MS;
  const debouncedQuery = useDebouncedValue(query, scanDebounceMs);

  const inputRef = useRef<HTMLInputElement | null>(null);
  // Element focused before the bar opened, restored when it closes.
  const focusReturnRef = useRef<HTMLElement | null>(null);
  // Matches are a DOM fact, not view state: keeping them out of React avoids
  // re-rendering the thread when the scan result changes.
  const matchesRef = useRef<ThreadMatch[]>([]);
  // Mirror of `activeIndex` for callbacks that must not re-create on each step.
  const activeIndexRef = useRef(-1);
  activeIndexRef.current = activeIndex;
  // Mirror of `open` for the window-level shortcut listener (registered once).
  const openRef = useRef(false);
  openRef.current = open;
  // The query the current match list was built for: a change (or a fresh open)
  // re-seeds the cursor at the reading position, a `messages` refresh keeps it.
  const scannedQueryRef = useRef<string | null>(null);
  // Latest jump hook, read without re-creating `jumpTo`.
  const onBeforeJumpRef = useRef(onBeforeJump);
  onBeforeJumpRef.current = onBeforeJump;
  const onRevealMatchRef = useRef(onRevealMatch);
  onRevealMatchRef.current = onRevealMatch;
  // Jump index waiting for a collapsed progress run to open. Set when a match
  // lands inside a hidden card; the layout effect below scrolls once the card
  // has a box.
  const pendingRevealJumpRef = useRef<number | null>(null);
  // Bumps when a jump waits for a run to expand, so the retry layout effect
  // runs on that render (the jump callback itself is stable).
  const [revealTick, setRevealTick] = useState(0);
  // Timestamp of the previous jump, for burst detection (see `JUMP_BURST_MS`).
  const lastJumpAtRef = useRef(0);

  /** Scroll to one match: its own rect when it is still in the DOM. */
  const jumpTo = useCallback(
    (index: number, fromRetry = false): void => {
      const thread = threadRef.current;
      const match = matchesRef.current[index];
      if (thread === null || match === undefined) return;
      // A hidden card has an empty rect, and scrolling to it lands nowhere.
      // The caller expands the run; this jump retries after that layout.
      // The retry itself must not schedule another one: if the card is still
      // hidden, fall through and scroll the row we have.
      if (
        !fromRetry &&
        match.row !== null &&
        onRevealMatchRef.current?.(match.row) === true
      ) {
        pendingRevealJumpRef.current = index;
        setRevealTick((tick) => tick + 1);
        return;
      }
      const now = performance.now();
      const burst = now - lastJumpAtRef.current < JUMP_BURST_MS;
      lastJumpAtRef.current = now;
      const options = {
        topGap: FIND_TOP_GAP,
        beforeScroll: (targetTop: number) =>
          onBeforeJumpRef.current?.(targetTop),
        flash: match.row,
        // A held Enter / ⌘G must not stack smooth animations (each new one
        // restarts from the current, still-moving position, so the view ends up
        // seconds behind the counter): only the first jump of a burst animates.
        instant: burst,
      };
      const rect = match.range.getBoundingClientRect();
      // A range whose nodes were replaced by a re-render reports an empty rect:
      // fall back to the message row so the jump still lands sensibly.
      if (rect.width === 0 && rect.height === 0) {
        if (match.row !== null) scrollThreadToRow(thread, match.row, options);
        return;
      }
      scrollThreadToRect(thread, rect, options);
    },
    [threadRef],
  );

  // Retry a jump that waited for a collapsed run to open. Clearing the pending
  // index first keeps a reveal that is already open from scheduling itself
  // again.
  useLayoutEffect(() => {
    const index = pendingRevealJumpRef.current;
    if (index === null) return;
    pendingRevealJumpRef.current = null;
    jumpTo(index, true);
  }, [revealTick, jumpTo]);

  /** Move the cursor by `delta` occurrences, wrapping around both ends. */
  const step = useCallback(
    (delta: 1 | -1): void => {
      const total = matchesRef.current.length;
      if (total === 0) return;
      const current = activeIndexRef.current;
      const nextIndex =
        current < 0
          ? delta > 0
            ? 0
            : total - 1
          : (current + delta + total) % total;
      activeIndexRef.current = nextIndex;
      setActiveIndex(nextIndex);
      // Only the active layer moves when stepping: the "all matches" layer is
      // untouched and does not need rebuilding.
      applyActiveHighlight(matchesRef.current, nextIndex);
      jumpTo(nextIndex);
    },
    [jumpTo],
  );

  const next = useCallback((): void => step(1), [step]);
  const prev = useCallback((): void => step(-1), [step]);

  /** Drop every match / highlight and (optionally) restore the focus. */
  const reset = useCallback(
    (restoreFocus: boolean): void => {
      matchesRef.current = [];
      scannedQueryRef.current = null;
      activeIndexRef.current = -1;
      lastJumpAtRef.current = 0;
      pendingRevealJumpRef.current = null;
      clearHighlights();
      setComposing(false);
      setOpen(false);
      setQuery("");
      setActiveIndex(-1);
      setCount(0);
      setTruncated(false);
      if (!restoreFocus) {
        focusReturnRef.current = null;
        return;
      }
      const target = focusReturnRef.current;
      focusReturnRef.current = null;
      if (target !== null && target.isConnected) {
        // Back where the user was (the composer, usually).
        target.focus();
        return;
      }
      // Nothing sensible to restore (the trigger unmounted): keep keyboard
      // scrolling working by focusing the thread itself (see `tabIndex={-1}`).
      threadRef.current?.focus();
    },
    [threadRef],
  );

  const closeFind = useCallback((): void => reset(true), [reset]);

  // IME composition gating (see `ThreadFind.compositionHandlers`). The value
  // still flows into `query` (a controlled input must follow the IME), only the
  // scan waits for the commit.
  const compositionHandlers = useMemo(
    () => ({
      onCompositionStart: (): void => setComposing(true),
      onCompositionEnd: (): void => setComposing(false),
    }),
    [],
  );

  const focusInput = useCallback((): void => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, []);

  const openFind = useCallback((): void => {
    // No thread on screen (no conversation selected): nothing to search.
    if (threadRef.current === null) return;
    if (openRef.current) {
      // Already open: ⌘F re-selects the current term.
      focusInput();
      return;
    }
    const active = document.activeElement;
    focusReturnRef.current = active instanceof HTMLElement ? active : null;
    setOpen(true);
  }, [focusInput, threadRef]);

  // Focus the field as soon as the bar is mounted (before paint, so the caret
  // never appears a frame late).
  useLayoutEffect(() => {
    if (open) focusInput();
  }, [open, focusInput]);

  // Closing while the module unmounts (module switch, chat switch): drop the
  // highlights so nothing lingers in the registry.
  useEffect(() => clearHighlights, []);

  // A different conversation starts with a clean slate.
  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current === chatId) return;
    prevChatIdRef.current = chatId;
    reset(false);
  }, [chatId, reset]);

  /**
   * Drop the match list and highlight layers (empty query / closed bar).
   */
  const clearMatches = useCallback((): void => {
    matchesRef.current = [];
    activeIndexRef.current = -1;
    clearHighlights();
    setCount(0);
    setTruncated(false);
    setActiveIndex(-1);
  }, []);

  /**
   * Scan the rendered thread for `debouncedQuery` and apply the result.
   *
   * `reseed` = the query itself changed (or the bar just opened): the cursor
   * starts at the reading position and the match is brought on screen. Without
   * it the re-scan was driven by new/updated messages: the occurrence being read
   * is kept (and its content shifted only if it no longer exists).
   */
  const scan = useCallback(
    (thread: HTMLElement, reseed: boolean): void => {
      const scanned = collectMatches(thread, debouncedQuery);
      matchesRef.current = scanned.matches;
      setCount(scanned.matches.length);
      setTruncated(scanned.truncated);

      const previous = activeIndexRef.current;
      let nextIndex: number;
      if (scanned.matches.length === 0) {
        nextIndex = -1;
      } else if (
        !reseed &&
        previous >= 0 &&
        previous < scanned.matches.length
      ) {
        nextIndex = previous;
      } else {
        nextIndex = nearestIndex(thread, scanned.matches);
      }
      activeIndexRef.current = nextIndex;
      setActiveIndex(nextIndex);
      applyHighlights(scanned.matches, nextIndex);
      if (reseed && nextIndex >= 0) {
        const rect = scanned.matches[nextIndex].range.getBoundingClientRect();
        // Never yank a match that is already on screen; only bring it in when
        // the reading position does not show it.
        if (!isFullyVisible(thread, rect)) jumpTo(nextIndex);
      }
    },
    [debouncedQuery, jumpTo],
  );

  // Re-scan whenever the bar opens, the (debounced) query changes, or the
  // thread's messages change (a new message, a whole-table reload). Layout
  // effect: the DOM is committed but not painted yet, so highlights appear
  // together with the text they mark.
  //
  // A message-driven re-scan is coalesced to one per frame: several messages
  // landing in one tick (or a streaming reload) must not each walk the whole
  // transcript. A query-driven one stays synchronous — it *is* the feedback.
  useLayoutEffect((): (() => void) | undefined => {
    if (!open) return;
    // An IME composition owns the field: scan the committed value only, once it
    // ends (the effect re-runs on `composing`).
    if (composing) return;
    const thread = threadRef.current;
    const reseed = scannedQueryRef.current !== debouncedQuery;
    scannedQueryRef.current = debouncedQuery;
    if (thread === null || debouncedQuery.trim().length === 0) {
      clearMatches();
      return;
    }
    if (!reseed) {
      const frame = window.requestAnimationFrame(() => scan(thread, false));
      return () => window.cancelAnimationFrame(frame);
    }
    scan(thread, true);
    // `messages` is a change signal only, never read here.
    return undefined;
  }, [
    open,
    composing,
    debouncedQuery,
    messages,
    threadRef,
    jumpTo,
    scan,
    clearMatches,
  ]);

  // ⌘F / Ctrl+F opens (and re-selects); ⌘G / ⇧⌘G walk the matches while open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!hotkeysEnabled) return;
      // Never hijack a key the IME is currently consuming.
      if (event.isComposing) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "f") {
        // Also keeps the web view's own find UI (never used, but harmless) from
        // competing with ours.
        event.preventDefault();
        openFind();
        return;
      }
      if (!openRef.current) return;
      if (key === "g") {
        event.preventDefault();
        step(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hotkeysEnabled, openFind, step]);

  return {
    open,
    query,
    setQuery,
    position: activeIndex >= 0 ? activeIndex + 1 : 0,
    count,
    truncated,
    noMatch: debouncedQuery.trim().length > 0 && count === 0,
    openFind,
    closeFind,
    next,
    prev,
    inputRef,
    compositionHandlers,
  };
}
