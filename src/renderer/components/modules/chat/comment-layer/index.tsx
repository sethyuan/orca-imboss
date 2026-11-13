import {
  MAX_COMMENT_NOTE_LENGTH,
  MAX_COMMENT_QUOTE_LENGTH,
} from "@shared/constants/comments";
import { t } from "@shared/l10n";
import type { CommentAnchor } from "@shared/types";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { CommentSurface } from "../../../../comment-draft";
import { useClickOutside } from "../../../../hooks/use-click-outside";
import { useEscapeKey } from "../../../../hooks/use-escape-key";
import { Button } from "../../../button";
import { IconComment } from "../../../icons";
import {
  anchorFromSelection,
  buildTextIndex,
  rangeForSpan,
  resolveAnchor,
} from "./anchor-text";
import "./index.css";

/**
 * Commenting on an agent's (or the boss's own) output, in place.
 *
 * Select a passage inside a commentable row → a small toolbar appears above the
 * selection → open it and write the comment → the comment waits in the composer
 * and rides along with the next message (`[Comments]` block, see
 * `src/main/comment-prompt.ts`).
 *
 * Everything here is DOM work **around** the React-managed thread:
 * - highlights go through the CSS Custom Highlight API (`CSS.highlights`, the
 *   same technique as in-thread find), so no node is ever inserted into a
 *   rendered Markdown tree (which would break `Markdown`'s memo and the
 *   react-markdown structure);
 * - the selection is only *read*, never rewritten, so copying text and the find
 *   bar keep working exactly as before;
 * - both the toolbar and the compose panel are portaled to `document.body` and
 *   anchored to the selection's rect, so they are never clipped by the thread's
 *   scroll container.
 *
 * Not every passage is annotatable: the row must carry `data-commentable` and
 * the selection must stay inside **one** row's content root (`contentSelector`).
 * Live streaming blocks deliberately do not carry the attribute — their text is
 * still growing and their id changes when the run ends, so an anchor written
 * there could never be resolved again (see `.pi/facts/comments-feature-plan.md`).
 */

/** Registry name of the highlight over already-sent comments. */
const HIGHLIGHT_SENT = "imb-comment";

/** Registry name of the highlight over the comments waiting in the composer. */
const HIGHLIGHT_PENDING = "imb-comment-pending";

/** Preferred width of the compose panel (narrow windows shrink it). */
const PANEL_WIDTH = 340;

/** Width of the floating toolbar (a single short button). */
const TOOLBAR_WIDTH = 124;

/** Gap between the selection and the floating toolbar (and the panel). */
const TOOLBAR_GAP = 8;

/** Margin a floating box keeps from every viewport edge. */
const VIEWPORT_MARGIN = 8;

/** Minimal shapes of the CSS Custom Highlight API we use (as in `thread-find`). */
interface HighlightLike {
  priority: number;
}
type HighlightCtor = new (...ranges: Range[]) => HighlightLike;
interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): void;
}

function highlightRegistry(): HighlightRegistryLike | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } })
    .CSS;
  return css?.highlights ?? null;
}

/** Create a `Highlight` when the runtime supports it; `null` otherwise. */
function createHighlight(
  ranges: Range[],
  priority: number,
): HighlightLike | null {
  const ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  if (ctor === undefined) return null;
  const highlight = new ctor(...ranges);
  highlight.priority = priority;
  return highlight;
}

/** Replace (or remove) one registered highlight by name. */
function setHighlight(name: string, ranges: Range[] | null): void {
  const registry = highlightRegistry();
  if (registry === null) return;
  if (ranges === null || ranges.length === 0) {
    registry.delete(name);
    return;
  }
  const highlight = createHighlight(ranges, name === HIGHLIGHT_PENDING ? 1 : 0);
  if (highlight !== null) registry.set(name, highlight);
}

/** One annotation to draw, regardless of who wrote it (sent or pending). */
interface DrawableComment {
  anchor: CommentAnchor;
  state: "sent" | "pending";
}

/**
 * A viewport rect of the thing a floating box is anchored to.
 *
 * `bottom` is carried explicitly: a multi-line selection's bounding rect is not a
 * single line, and "the box goes below the anchor" needs its **bottom** — the
 * first version only had `top` and guessed the rest, which is how the panel ended
 * up 200px away from the selection.
 */
interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
  width: number;
}

/** A live selection that can be commented on, plus where to draw the toolbar. */
interface SelectionTarget {
  anchor: CommentAnchor;
  /** Viewport rect of the selection (the toolbar anchors to it). */
  rect: AnchorRect;
}

/** The compose panel's state: the frozen annotation being written. */
interface ComposeState {
  anchor: CommentAnchor;
  /**
   * Where the toolbar was when it was clicked. The panel takes the toolbar's
   * place (it grows downwards from the toolbar's bottom), so the panel never
   * covers the passage the boss just selected and never jumps away from it.
   */
  toolbarRect: AnchorRect;
}

/** `DOMRect` → the subset the placement math needs. */
function toAnchorRect(rect: DOMRect): AnchorRect {
  return {
    left: rect.left,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
  };
}

/**
 * Where a floating box of `width`×`height` goes for one anchor rect.
 *
 * The rules, in order (`prefer` says which side gets the first chance):
 * - horizontally centered on the anchor, clamped inside the viewport;
 * - vertically on the preferred side with exactly `TOOLBAR_GAP` between the box
 *   and the anchor — **below** means `anchor.bottom + gap`, **above** means
 *   `anchor.top - gap - height` (the box's bottom edge, not its top);
 * - when the preferred side does not fit, the other side is used;
 * - when neither fits, the box is pinned inside the viewport (a box taller than
 *   the viewport scrolls inside itself — see the panel's `max-height`).
 *
 * The height is always the **measured** one: a guessed constant is what made the
 * panel land ~200px below the selection in the first place.
 */
function placeFloating(
  anchor: AnchorRect,
  width: number,
  height: number,
  prefer: "above" | "below",
): { top: number; left: number } {
  const viewWidth = window.innerWidth;
  const viewHeight = window.innerHeight;
  const left = Math.min(
    Math.max(anchor.left + anchor.width / 2 - width / 2, VIEWPORT_MARGIN),
    Math.max(viewWidth - width - VIEWPORT_MARGIN, VIEWPORT_MARGIN),
  );
  const below = anchor.bottom + TOOLBAR_GAP;
  const above = anchor.top - TOOLBAR_GAP - height;
  const fitsBelow = below + height <= viewHeight - VIEWPORT_MARGIN;
  const fitsAbove = above >= VIEWPORT_MARGIN;
  const first = prefer === "below" ? below : above;
  const second = prefer === "below" ? above : below;
  const firstFits = prefer === "below" ? fitsBelow : fitsAbove;
  const secondFits = prefer === "below" ? fitsAbove : fitsBelow;
  const top = firstFits ? first : secondFits ? second : first;
  return {
    top: Math.min(
      Math.max(top, VIEWPORT_MARGIN),
      Math.max(viewHeight - height - VIEWPORT_MARGIN, VIEWPORT_MARGIN),
    ),
    left,
  };
}

/**
 * Fixed-position style for one floating box, computed from its **measured**
 * height.
 *
 * The width is known up front (it is a clamped constant), so it is applied on the
 * very first render: measuring a box at the wrong width measures the wrong
 * height (a narrower panel wraps its quote onto more lines and grows), which is
 * what made an early version overlap the toolbar by a few pixels after flipping
 * above. The position itself is measured in a `useLayoutEffect`, i.e. before the
 * browser paints — the box is invisible for that one pass (`visibility: hidden`)
 * and appears at its final spot, never jumping.
 *
 * Re-measures when the anchor changes, when the box's own size changes (the boss
 * typed enough to grow it) and when the window resizes (every clamp depends on
 * it).
 */
function useFloatingPlacement(
  elementRef: RefObject<HTMLDivElement | null>,
  anchor: AnchorRect | null,
  prefer: "above" | "below",
  preferredWidth: number,
): { style: React.CSSProperties; ready: boolean } {
  const width = Math.min(
    preferredWidth,
    Math.max(window.innerWidth - VIEWPORT_MARGIN * 2, 120),
  );
  const [placed, setPlaced] = useState<{ top: number; left: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const element = elementRef.current;
    if (anchor === null || element === null) {
      setPlaced(null);
      return;
    }
    const measure = (): void => {
      const next = placeFloating(anchor, width, element.offsetHeight, prefer);
      setPlaced((previous) =>
        previous !== null &&
        Math.abs(previous.top - next.top) < 0.5 &&
        Math.abs(previous.left - next.left) < 0.5
          ? previous
          : next,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    // The box grows as the boss types (and shrinks when the note is cleared):
    // a fixed-position box must re-place itself instead of sliding off screen.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measure());
    observer?.observe(element);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [elementRef, anchor, prefer, width]);
  if (anchor === null) return { style: {}, ready: false };
  return {
    // `ready` tells the caller the box is **visible**: the first pass renders it
    // with `visibility: hidden`, and focusing a hidden element silently does
    // nothing — which is exactly why the compose field never got the caret.
    ready: placed !== null,
    style: {
      position: "fixed",
      top: `${placed?.top ?? 0}px`,
      left: `${placed?.left ?? 0}px`,
      width: `${width}px`,
      ...(placed === null ? { visibility: "hidden" as const } : {}),
    },
  };
}

export interface CommentLayerProps {
  /** The scrolling thread container that owns the rendered rows. */
  threadRef: RefObject<HTMLDivElement | null>;
  /** Where pending/sent comments live for this surface. */
  comments: CommentSurface;
  /**
   * Selector of the annotatable content root **inside** one row. A row is
   * annotatable when it also carries `data-commentable`.
   */
  contentSelector: string;
  /**
   * Change signal: any change re-resolves the highlights (the transcript was
   * reloaded, a run finished, a comment was sent). Cheapest correct signal is the
   * array the thread renders from.
   */
  revision: unknown;
}

export function CommentLayer({
  threadRef,
  comments,
  contentSelector,
  revision,
}: CommentLayerProps): React.JSX.Element | null {
  const [target, setTarget] = useState<SelectionTarget | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [note, setNote] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Placement comes from the boxes' **measured** sizes, never a guessed height:
  // the toolbar sits above/below the selection, and the panel takes the toolbar's
  // place and grows downwards from its bottom edge.
  const toolbarPlacement = useFloatingPlacement(
    toolbarRef,
    target?.rect ?? null,
    "above",
    TOOLBAR_WIDTH,
  );
  const panelPlacement = useFloatingPlacement(
    panelRef,
    compose?.toolbarRect ?? null,
    "below",
    PANEL_WIDTH,
  );

  /**
   * Hand focus back to the transcript the annotation belongs to.
   *
   * The panel is portaled and unmounted on close, so focus would otherwise fall
   * to `<body>` and the boss would have to click back into the conversation. The
   * thread is a `tabIndex={-1}` focus target in both hosts (chat thread and
   * session transcript), so it is the one element that always exists here.
   */
  const focusThread = useCallback((): void => {
    const thread = threadRef.current;
    if (thread !== null && thread.isConnected) {
      thread.focus({ preventScroll: true });
    }
  }, [threadRef]);

  /**
   * Close the compose panel (and forget the draft note).
   *
   * `restoreFocus` is off for a click outside: that click already focused
   * whatever the boss clicked (the composer, a message, …), and yanking focus
   * back to the transcript would undo it.
   */
  const closeCompose = useCallback(
    (restoreFocus = true): void => {
      setCompose(null);
      setNote("");
      if (restoreFocus) focusThread();
    },
    [focusThread],
  );

  useClickOutside([panelRef], () => closeCompose(false), compose !== null);
  useEscapeKey(() => closeCompose(true), compose !== null);

  // --- Selection capture ------------------------------------------------------
  /**
   * Read the current selection and, when it sits in one annotatable row, keep it
   * as the toolbar's target.
   *
   * Runs on `pointerup` (pointer only: keyboard selections and programmatic ones
   * never pop a toolbar in the middle of a read) and is deferred by a tick so the
   * browser has settled the selection.
   */
  const captureSelection = useCallback((): void => {
    const thread = threadRef.current;
    if (thread === null) return;
    const selection = window.getSelection();
    if (
      selection === null ||
      selection.rangeCount === 0 ||
      selection.isCollapsed
    ) {
      setTarget(null);
      return;
    }
    const range = selection.getRangeAt(0);
    // The row is decided by where the selection **starts**; whether it stays
    // inside that row is settled by `anchorFromSelection`, which clamps the end
    // boundary (a triple-click ends at the next block's start) and then requires
    // the selection's text to be that row's text — so a drag across rows is still
    // rejected, without relying on both Range ends landing in the same element.
    const row = rowOf(range.startContainer, thread);
    if (row === null) {
      setTarget(null);
      return;
    }
    const id = row.dataset.messageId;
    if (id === undefined || id.length === 0) {
      setTarget(null);
      return;
    }
    const root = contentRootOf(row, contentSelector);
    if (root === null) {
      setTarget(null);
      return;
    }
    const anchor = anchorFromSelection(
      root,
      range,
      comments.kind,
      comments.kind === "chat" ? Number(id) : id,
      MAX_COMMENT_QUOTE_LENGTH,
    );
    if (anchor === null) {
      setTarget(null);
      return;
    }
    // The whole rect, `bottom` included: a multi-line selection is not a single
    // line, and the toolbar is placed relative to its top while the panel is
    // placed relative to the toolbar.
    setTarget({ anchor, rect: toAnchorRect(range.getBoundingClientRect()) });
  }, [comments.kind, contentSelector, threadRef]);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread === null) return;
    let timer = 0;
    const onPointerUp = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(captureSelection, 0);
    };
    thread.addEventListener("pointerup", onPointerUp);
    return () => {
      window.clearTimeout(timer);
      thread.removeEventListener("pointerup", onPointerUp);
    };
  }, [threadRef, captureSelection]);

  // The toolbar is anchored to a viewport rect, so anything that moves the text
  // out from under it must dismiss it: a collapsed selection (a click elsewhere,
  // Escape) and a scroll of the thread. The compose panel owns its own anchor and
  // stays while the boss types.
  useEffect(() => {
    if (target === null) return;
    const dismiss = (): void => setTarget(null);
    const onSelectionChange = (): void => {
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed) dismiss();
    };
    const thread = threadRef.current;
    document.addEventListener("selectionchange", onSelectionChange);
    thread?.addEventListener("scroll", dismiss, { passive: true });
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      thread?.removeEventListener("scroll", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [target, threadRef]);

  // --- Highlights -------------------------------------------------------------
  const drawable = useMemo<DrawableComment[]>(
    () => [
      ...comments.sent.map((comment) => ({
        anchor: comment.anchor,
        state: "sent" as const,
      })),
      ...comments.pending.map((comment) => ({
        anchor: comment.anchor,
        state: "pending" as const,
      })),
    ],
    [comments.sent, comments.pending],
  );

  useEffect(() => {
    const thread = threadRef.current;
    if (thread === null) return;
    const sent: Range[] = [];
    const pending: Range[] = [];
    for (const item of drawable) {
      const range = rangeForComment(thread, item.anchor, contentSelector);
      if (range === null) continue;
      (item.state === "pending" ? pending : sent).push(range);
    }
    setHighlight(HIGHLIGHT_SENT, sent);
    setHighlight(HIGHLIGHT_PENDING, pending);
    return () => {
      setHighlight(HIGHLIGHT_SENT, null);
      setHighlight(HIGHLIGHT_PENDING, null);
    };
    // `revision` is the thread's content signal: the rows were re-rendered, so
    // the ranges must be rebuilt (a detached range draws nothing).
  }, [drawable, threadRef, contentSelector, revision]);

  // --- Actions ----------------------------------------------------------------
  const openCompose = useCallback((): void => {
    if (target === null) return;
    const element = toolbarRef.current;
    // The panel hangs from the toolbar's bottom edge, so the toolbar's rect is
    // what it is anchored to. The fallback (the selection's top edge, treated as
    // a zero-height anchor) only applies if the toolbar was never measurable.
    const toolbarRect =
      element === null
        ? { ...target.rect, bottom: target.rect.top }
        : toAnchorRect(element.getBoundingClientRect());
    setCompose({ anchor: target.anchor, toolbarRect });
    setNote("");
    setTarget(null);
  }, [target]);

  const save = useCallback((): void => {
    if (compose === null) return;
    const value = note.trim();
    if (value.length === 0) return;
    comments.add(compose.anchor, value);
    closeCompose();
    // Drop the browser selection: the comment's own tint replaces it, and a
    // leftover selection would swallow the boss's next click on the bubble.
    window.getSelection()?.removeAllRanges();
  }, [comments, compose, note, closeCompose]);

  /**
   * Put the caret in the field as soon as the panel is **visible**.
   *
   * Gated on `panelPlacement.ready`: the panel's first render is measured at
   * `visibility: hidden` (one layout pass, never painted), and `focus()` on a
   * hidden element is a silent no-op — the original effect ran exactly in that
   * pass and did nothing. `preventScroll` keeps a fixed overlay from scrolling
   * the transcript under it.
   */
  useEffect(() => {
    if (compose === null || !panelPlacement.ready) return;
    const field = textareaRef.current;
    if (field === null) return;
    field.focus({ preventScroll: true });
    // Caret at the end (the field starts empty; this keeps a restored/typed value
    // editable straight away).
    const end = field.value.length;
    field.setSelectionRange(end, end);
  }, [compose, panelPlacement.ready]);

  const toolbar =
    target === null ? null : (
      <div
        className="imb-comment-toolbar"
        ref={toolbarRef}
        // Never let the press steal the selection the toolbar is about.
        onMouseDown={(event) => event.preventDefault()}
        style={toolbarPlacement.style}
      >
        <button
          type="button"
          className="imb-comment-toolbar-btn"
          onClick={openCompose}
        >
          <IconComment className="imb-icon imb-xs" />
          <span>{t("Comment")}</span>
        </button>
      </div>
    );

  const panel =
    compose === null ? null : (
      <div
        className="imb-comment-panel imb-menu-surface"
        ref={panelRef}
        role="dialog"
        aria-label={t("Write a comment")}
        style={panelPlacement.style}
        // Typing in the panel must not disturb the frozen anchor, and a press
        // inside it must not reach the thread's own click handling.
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="imb-comment-panel-quote">{compose.anchor.quote}</p>
        <textarea
          ref={textareaRef}
          className="imb-comment-panel-input"
          value={note}
          maxLength={MAX_COMMENT_NOTE_LENGTH}
          placeholder={t("Your comment. Shift+Enter for new line.")}
          // Enter submits (see `onKeyDown`); the hint below the field says so.
          rows={3}
          aria-label={t("Comment")}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            // Same contract as the chat composer: `Enter` submits,
            // `Shift+Enter` inserts a newline, and an Enter that belongs to an
            // IME candidate never submits (committing a Chinese/Japanese
            // candidate must not send the comment).
            if (event.key !== "Enter" || event.shiftKey) return;
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            save();
          }}
        />
        <div className="imb-comment-panel-actions">
          <span className="imb-comment-panel-hint">
            {t("Sent with your next message")}
          </span>
          <Button variant="secondary" size="sm" onClick={() => closeCompose()}>
            {t("Cancel")}
          </Button>
          <Button size="sm" onClick={save} disabled={note.trim().length === 0}>
            {t("Save")}
          </Button>
        </div>
      </div>
    );

  if (toolbar === null && panel === null) return null;
  return createPortal(
    <>
      {toolbar}
      {panel}
    </>,
    document.body,
  );
}

/** The annotatable row a node belongs to (`null` outside the thread). */
function rowOf(node: Node | null, thread: HTMLElement): HTMLElement | null {
  if (node === null) return null;
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  if (element === null || !thread.contains(element)) return null;
  const row = element.closest<HTMLElement>("[data-commentable]");
  return row !== null && thread.contains(row) ? row : null;
}

/**
 * The annotatable content root of one row.
 *
 * `row.matches()` is checked **first**, and that is not a detail: some rows *are*
 * their own content container (a settled assistant block in a session transcript
 * is both the `[data-commentable]` row and the `.imb-session-text` root), while
 * `querySelector()` only ever searches descendants. Looking only downwards
 * silently disabled commenting on exactly those rows — capture found no root, so
 * the toolbar never appeared, and resolution found no root, so nothing was ever
 * tinted.
 *
 * Capture (`anchorFromSelection`) and resolution (`rangeForComment`) both go
 * through here, which is what keeps their offsets relative to the same element.
 */
function contentRootOf(row: HTMLElement, selector: string): HTMLElement | null {
  if (row.matches(selector)) return row;
  return row.querySelector<HTMLElement>(selector);
}

/**
 * Resolve one stored anchor to a live `Range` inside the thread.
 *
 * The row is looked up by its id (not by a query selector: session entry ids are
 * opaque strings that would need escaping), then the anchor is resolved against
 * that row's rendered text. Anything that does not resolve yields `null` — the
 * comment keeps its card and simply has no tint.
 */
function rangeForComment(
  thread: HTMLElement,
  anchor: CommentAnchor,
  contentSelector: string,
): Range | null {
  // Image annotations are drawn on the picture, not tinted in the text.
  if (anchor.target.kind === "image") return null;
  const id =
    anchor.target.kind === "message"
      ? String(anchor.target.messageId)
      : anchor.target.entryId;
  let row: HTMLElement | null = null;
  for (const candidate of thread.querySelectorAll<HTMLElement>(
    "[data-message-id]",
  )) {
    if (candidate.dataset.messageId === id) {
      row = candidate;
      break;
    }
  }
  if (row === null) return null;
  const root = contentRootOf(row, contentSelector);
  if (root === null) return null;
  const index = buildTextIndex(root);
  const resolution = resolveAnchor(index, anchor);
  if (resolution.kind === "unresolved") return null;
  return rangeForSpan(index, resolution.span);
}
