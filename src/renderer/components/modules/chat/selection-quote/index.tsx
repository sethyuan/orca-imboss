import { t } from "@shared/l10n";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { DraftQuote } from "../../../../chat-draft";
import { clipQuoteText } from "../quote-text";
import "./index.css";

export interface SelectionQuoteLayerProps {
  /** Called when the user commits a quote; the caller adds it to the draft. */
  onQuote: (quote: DraftQuote) => void;
  /** Called after a quote is added so the composer can take focus. */
  onFocusInput: () => void;
}

interface Candidate {
  text: string;
  messageId: number | null;
  sourceLabel?: string;
  rect: { left: number; top: number; right: number; bottom: number };
}

const BUTTON_GAP = 8;
const BUTTON_W = 104;
const BUTTON_H = 32;
const EDGE = 8;
const IGNORE_SELECTOR =
  "input, textarea, select, button, [contenteditable='true'], [data-selection-ignore='true']";

/**
 * Watches for text selections inside a chat bubble and floats a "quote to
 * chat" button next to them. Ported from openhanako's
 * `SelectionQuoteActionSurface`: only a selection fully contained in one
 * message (`[data-message-id]` within `[data-chat-selection-root]`) qualifies,
 * and selections inside controls/ignored nodes are skipped.
 */
export function SelectionQuoteLayer({
  onQuote,
  onFocusInput,
}: SelectionQuoteLayerProps): React.JSX.Element | null {
  const [candidate, setCandidate] = useState<Candidate | null>(null);

  useEffect(() => {
    const commit = (): void => {
      // Defer a frame so the browser has finalized the selection.
      window.requestAnimationFrame(() => setCandidate(readCandidate()));
    };
    const handleSelectionChange = (): void => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.toString().trim().length === 0) {
        setCandidate(null);
      }
    };
    const handlePointerDown = (event: PointerEvent): void => {
      const el = event.target instanceof Element ? event.target : null;
      if (el?.closest(IGNORE_SELECTOR)) return;
      setCandidate(null);
    };
    const handleReflow = (): void => {
      if (window.getSelection?.()?.toString().trim()) {
        setCandidate(readCandidate());
      }
    };

    document.addEventListener("mouseup", commit);
    document.addEventListener("keyup", commit);
    document.addEventListener("touchend", commit);
    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("scroll", handleReflow, true);
    window.addEventListener("resize", handleReflow);
    return () => {
      document.removeEventListener("mouseup", commit);
      document.removeEventListener("keyup", commit);
      document.removeEventListener("touchend", commit);
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("scroll", handleReflow, true);
      window.removeEventListener("resize", handleReflow);
    };
  }, []);

  if (!candidate) return null;

  const position = computePosition(candidate.rect);

  const handleQuote = (): void => {
    onQuote({
      text: candidate.text,
      messageId: candidate.messageId,
      sourceLabel: candidate.sourceLabel,
    });
    window.getSelection()?.removeAllRanges();
    setCandidate(null);
    onFocusInput();
  };

  return createPortal(
    <div
      className="imb-quote-action"
      data-selection-ignore="true"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
    >
      <button
        type="button"
        className="imb-quote-action-btn"
        // Keep the selection alive until the click resolves.
        onMouseDown={(event) => event.preventDefault()}
        onClick={handleQuote}
      >
        <QuoteIcon />
        <span>{t("Quote to chat")}</span>
      </button>
    </div>,
    document.body,
  );
}

function readCandidate(): Candidate | null {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!sel || !text || sel.rangeCount === 0) return null;

  const anchorEl = nodeElement(sel.anchorNode);
  const focusEl = nodeElement(sel.focusNode);
  if (!anchorEl || !focusEl) return null;
  if (anchorEl.closest(IGNORE_SELECTOR) || focusEl.closest(IGNORE_SELECTOR)) {
    return null;
  }

  const anchorMessage = anchorEl.closest<HTMLElement>("[data-message-id]");
  const focusMessage = focusEl.closest<HTMLElement>("[data-message-id]");
  if (!anchorMessage || !focusMessage || anchorMessage !== focusMessage) {
    return null;
  }
  if (!anchorMessage.closest("[data-chat-selection-root]")) return null;

  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  const rawId = anchorMessage.dataset.messageId;
  const parsedId = rawId === undefined ? NaN : Number(rawId);
  const label = anchorMessage.dataset.quoteLabel;

  return {
    text: clipQuoteText(text),
    messageId: Number.isFinite(parsedId) ? parsedId : null,
    sourceLabel: label && label.length > 0 ? label : undefined,
    rect: {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    },
  };
}

function computePosition(rect: Candidate["rect"]): {
  left: number;
  top: number;
} {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const center = rect.left + (rect.right - rect.left) / 2;
  let top = rect.top - BUTTON_H - BUTTON_GAP;
  if (top < EDGE) top = rect.bottom + BUTTON_GAP;
  return {
    left: clamp(center - BUTTON_W / 2, EDGE, vw - BUTTON_W - EDGE),
    top: clamp(top, EDGE, vh - BUTTON_H - EDGE),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function nodeElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement;
}

function QuoteIcon(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M7.4 6.2C5.2 7.7 4 9.9 4 12.8V18h5.7v-5.7H7.1c.1-1.6.9-2.8 2.3-3.8l-2-2.3Z" />
      <path d="M16.4 6.2c-2.2 1.5-3.4 3.7-3.4 6.6V18h5.7v-5.7h-2.6c.1-1.6.9-2.8 2.3-3.8l-2-2.3Z" />
    </svg>
  );
}
