/**
 * The annotation editor: one floating card that writes / edits the note of one
 * mark.
 *
 * Deliberately minimal, and that is the boss's call, not a taste: the header is
 * the ordinal plus the shape label (「点」/「区域」) and **nothing else** — no
 * 「图片标注」 prefix, no saved/idle hint on the right, and no `at:` coordinate
 * readout (he removed all three after reviewing the prototype). The geometry is
 * still delivered to the model; it simply is not shown here — the mark on the
 * picture *is* the readout, and 「模型视角」 shows what the model gets.
 *
 * Why no status text is not a gap: saving closes the card, so there is no
 * "open but already saved" state to report. After it closes, the numbered badge
 * on the picture, the row in 「本图标注」 and the row in the pending list are all
 * persistent feedback; reopening a mark shows its text in the field, which is
 * itself the proof it was stored.
 */
import { MAX_COMMENT_NOTE_LENGTH } from "@shared/constants/comments";
import { t } from "@shared/l10n";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Button } from "../../../button";
import { IconTrash } from "../../../icons";

import type { ImageMark } from "@shared/types";
import "./index.css";

export interface AnnotationPanelProps {
  /** The `#n` of the mark being edited. */
  ordinal: number;
  mark: ImageMark;
  /** Current note (`""` for a brand-new mark). */
  note: string;
  /** Viewport rect of the mark, which the card is placed next to. */
  anchor: { left: number; top: number; width: number; height: number };
  /** `true` when this mark already exists (the trash button deletes it). */
  saved: boolean;
  onSave: (note: string) => void;
  onCancel: () => void;
  onDelete: () => void;
}

/** Card width; narrow windows shrink it. */
const PANEL_WIDTH = 320;

/** Gap between the mark and the card, and the margin kept from every edge. */
const GAP = 10;
const MARGIN = 12;

/** The lightbox banner sits above this line, so the card must stay below it. */
const BANNER_HEIGHT = 64;

/** The lightbox caption sits below this line. */
const CAPTION_HEIGHT = 88;

/**
 * Where the card goes: **right → left → below → above**, the first side where it
 * fits completely inside the safe area (the banner, the caption and the window
 * edges are kept clear). The order matters — the right side covers the least of
 * the picture the boss is judging, and a card that lands on the mark itself would
 * hide the thing being annotated.
 *
 * When no side fits (a card taller than the safe area), it is pinned inside the
 * safe area instead and scrolls in place.
 */
function place(
  anchor: AnnotationPanelProps["anchor"],
  width: number,
  height: number,
): { top: number; left: number } {
  const top = BANNER_HEIGHT + MARGIN;
  const bottom = window.innerHeight - CAPTION_HEIGHT - MARGIN;
  const maxLeft = window.innerWidth - width - MARGIN;
  const clampTop = (value: number): number =>
    Math.min(Math.max(value, top), Math.max(bottom - height, top));
  const clampLeft = (value: number): number =>
    Math.min(Math.max(value, MARGIN), Math.max(maxLeft, MARGIN));
  const right = anchor.left + anchor.width + GAP;
  if (right <= maxLeft) {
    return {
      left: right,
      top: clampTop(anchor.top + anchor.height / 2 - height / 2),
    };
  }
  const left = anchor.left - GAP - width;
  if (left >= MARGIN) {
    return { left, top: clampTop(anchor.top + anchor.height / 2 - height / 2) };
  }
  const below = anchor.top + anchor.height + GAP;
  if (below + height <= bottom) {
    return {
      left: clampLeft(anchor.left + anchor.width / 2 - width / 2),
      top: below,
    };
  }
  const above = anchor.top - GAP - height;
  if (above >= top) {
    return {
      left: clampLeft(anchor.left + anchor.width / 2 - width / 2),
      top: above,
    };
  }
  return {
    left: clampLeft(anchor.left + anchor.width / 2 - width / 2),
    top: clampTop(below),
  };
}

/**
 * One floating annotation card.
 *
 * Keyboard contract is the app's usual one: `Enter` saves, `Shift+Enter` breaks
 * the line, an Enter that commits an IME candidate never saves, `Esc` cancels.
 * The field owns the caret as soon as the card is visible, and the card re-places
 * itself whenever it grows (the same measured-placement rule as the comment
 * panel: a fixed-position box must never slide off screen).
 */
export function AnnotationPanel({
  ordinal,
  mark,
  note,
  anchor,
  saved,
  onSave,
  onCancel,
  onDelete,
}: AnnotationPanelProps): React.JSX.Element {
  const [text, setText] = useState(note);
  const cardRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const width = Math.min(
    PANEL_WIDTH,
    Math.max(window.innerWidth - MARGIN * 2, 200),
  );
  const [placed, setPlaced] = useState<{ top: number; left: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const element = cardRef.current;
    if (element === null) return;
    const measure = (): void => {
      const next = place(anchor, width, element.offsetHeight);
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
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [anchor, width]);

  // Focus once the card is placed: the first pass is measured at
  // `visibility: hidden`, and focusing a hidden field silently does nothing.
  useEffect(() => {
    const field = fieldRef.current;
    if (field === null || placed === null) return;
    field.focus({ preventScroll: true });
    const end = field.value.length;
    field.setSelectionRange(end, end);
  }, [placed, ordinal]);

  const value = text.trim();
  const commit = (): void => {
    if (value.length === 0) return;
    onSave(value);
  };

  return (
    <div
      ref={cardRef}
      className="imb-annot-panel imb-menu-surface"
      role="dialog"
      aria-label={t("Write an annotation")}
      style={
        {
          position: "fixed",
          width: `${width}px`,
          ...(placed === null
            ? { visibility: "hidden" as const, top: 0, left: 0 }
            : { top: `${placed.top}px`, left: `${placed.left}px` }),
        } as CSSProperties
      }
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="imb-annot-panel-head">
        <span className="imb-annot-panel-ordinal">{`#${ordinal}`}</span>
        <span className="imb-annot-panel-kind">
          {/* The shape, in the words the boss approved (「点」/「区域」), spelled out as
              three `t()` calls so the translation tooling can see them. */}
          {mark.kind === "point"
            ? t("Point")
            : mark.kind === "region"
              ? t("Region")
              : t("Whole image")}
        </span>
      </div>
      <textarea
        ref={fieldRef}
        className="imb-annot-panel-input"
        value={text}
        maxLength={MAX_COMMENT_NOTE_LENGTH}
        rows={3}
        placeholder={t("What about this part?")}
        aria-label={t("What about this part?")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key !== "Enter" || event.shiftKey) return;
          if (event.nativeEvent.isComposing) return;
          event.preventDefault();
          commit();
        }}
      />
      <div className="imb-annot-panel-actions">
        <button
          type="button"
          className="imb-annot-panel-trash"
          aria-label={t("Remove annotation")}
          title={t("Remove annotation")}
          onClick={onDelete}
          disabled={!saved}
        >
          <IconTrash />
        </button>
        <span className="imb-annot-panel-hint">
          {t("Enter to save · Shift+Enter for new line")}
        </span>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button size="sm" onClick={commit} disabled={value.length === 0}>
          {t("Save")}
        </Button>
      </div>
    </div>
  );
}
