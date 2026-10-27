import { t } from "@shared/l10n";
import { useCallback, useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../../../../clipboard";
import { IconCheck, IconCopy } from "../../../icons";
import "./index.css";

/** How long the "copied" state (check glyph + label) stays before resetting. */
const COPIED_RESET_MS = 1500;

export interface MessageTimeProps {
  /** Exact send-time label; `null`/empty renders no time tag. */
  label?: string | null;
  /**
   * Raw Markdown source of this message. When set, a "Copy as Markdown" button
   * is rendered to the left of the time tag (the caller decides whether the row
   * qualifies — see `chat/copy-markdown.ts`). `null`/`undefined`/blank renders
   * no button.
   */
  copyMarkdown?: string | null;
}

/**
 * Hover-revealed bottom-right meta row of a message: an optional
 * "Copy as Markdown" button followed by the exact send-time tag.
 *
 * Shared by the message bubble and the card kinds (ask/answer/progress/chat) so
 * every non-ack message exposes its precise timestamp the same way, and so a
 * copy action lands in the same visual slot wherever it is offered. The row
 * anchors to the nearest positioned host (the bubble or card container), which
 * each caller keeps `position: relative`; it straddles the host's bottom edge so
 * it covers only the host's own padding (never the last line of text) and needs
 * no reserved space.
 *
 * Reveal is per child (not on the row) so the two can differ: the time tag
 * stays hover-only, while the copy button also stays visible on
 * `hover: none` devices (see `index.css`).
 */
export function MessageTime({
  label,
  copyMarkdown,
}: MessageTimeProps): React.JSX.Element | null {
  const showTime = label != null && label.length > 0;
  const copyText =
    copyMarkdown != null && copyMarkdown.trim().length > 0
      ? copyMarkdown
      : null;
  if (!showTime && copyText === null) return null;
  return (
    <span className="imb-msg-meta">
      {copyText !== null && <CopyMarkdownButton text={copyText} />}
      {showTime && <span className="imb-msg-time">{label}</span>}
    </span>
  );
}

/**
 * Copy-to-clipboard glyph button. Mirrors the code-block copy button
 * (`markdown/index.tsx`) in *behaviour*: the icon flips to a check for ~1.5s,
 * the label (`title` + `aria-label`) flips to "Copied", and a clipboard failure
 * is non-fatal — the message text stays selectable.
 *
 * It does not mirror the code-block copy button in *chrome*: this one sits in the
 * bubble's bottom-right meta row, so it wears the same chip as the time tag
 * beside it (opaque `--imb-surface` fill + hairline + one raise, hover/press
 * deepen it). Colours, reveal and the no-hover fallback all live in `index.css`.
 */
function CopyMarkdownButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    },
    [],
  );

  const copy = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>): void => {
      // The button lives inside the message row; a click here is a copy, never
      // a click on the bubble/row (future row-level handlers stay unaffected).
      event.stopPropagation();
      void copyToClipboard(text)
        .then(() => {
          setCopied(true);
          if (resetTimerRef.current !== null) {
            clearTimeout(resetTimerRef.current);
          }
          resetTimerRef.current = setTimeout(
            () => setCopied(false),
            COPIED_RESET_MS,
          );
        })
        .catch(() => {
          // Clipboard failures are non-fatal; the text stays selectable.
        });
    },
    [text],
  );

  // The label stays descriptive after the click, so assistive tech (and the
  // native tooltip) report the outcome of the action that was just taken.
  const label = copied ? t("Copied") : t("Copy as Markdown");

  return (
    <button
      type="button"
      className="imb-msg-copy"
      onClick={copy}
      aria-label={label}
      title={label}
    >
      {copied ? (
        <IconCheck className="imb-icon imb-2xs" />
      ) : (
        <IconCopy className="imb-icon imb-2xs" />
      )}
    </button>
  );
}
