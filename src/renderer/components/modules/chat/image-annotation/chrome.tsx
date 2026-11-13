/**
 * The two dark surfaces the annotation mode adds to the lightbox: the banner
 * across the top and the per-picture list down the right side.
 *
 * They are their own recipe (not `.imb-menu-surface`) because they stand on the
 * lightbox's near-black backdrop and are the only place in the app where a
 * surface is dark in both theme modes — the shallow "menu" material reads as a
 * hole there.
 */
import { t } from "@shared/l10n";
import { cls } from "reactutils";
import type { MarkView } from "./marks-layer";

export interface AnnotationBannerProps {
  /** Annotations in the whole pending batch, text ones included. */
  batchCount: number;
  onDone: () => void;
}

/**
 * The mode's only always-visible explanation: what a click does, what a drag
 * does, how to pan now that dragging draws, and how to leave.
 *
 * 「空格拖动平移」 is written out because it is the one gesture that had to move
 * (dragging used to pan) and an undocumented replacement would just look broken.
 */
export function AnnotationBanner({
  batchCount,
  onDone,
}: AnnotationBannerProps): React.JSX.Element {
  return (
    <div className="imb-annot-banner" role="status">
      <span className="imb-annot-banner-dot" aria-hidden="true" />
      <span className="imb-annot-banner-main">
        {t("Click to mark a point · Drag to mark an area")}
      </span>
      <span className="imb-annot-banner-hint">
        {t("Space+drag to pan · Esc to leave")}
      </span>
      <span className="imb-annot-banner-count">
        {t("${count} in this batch", { count: String(batchCount) })}
      </span>
      <button type="button" className="imb-annot-banner-done" onClick={onDone}>
        {t("Done")}
      </button>
    </div>
  );
}

export interface AnnotationListProps {
  marks: readonly MarkView[];
  /** Key of the mark whose editor is open. */
  editingKey: string | null;
  /** Key of the mark hovered from the picture. */
  hoverKey: string | null;
  onSelect: (key: string) => void;
  onHover: (key: string | null) => void;
  onRemove: (key: string) => void;
}

/**
 * 「本图标注」: the marks of the picture on screen, one row each.
 *
 * The count is **everything on this picture** — the batch being written *and* what
 * earlier batches left there — because that is what the boss sees on the picture: a
 * header saying `0` over three visible marks is a contradiction (it read that way
 * until QA caught it).
 *
 * Rows of an already-delivered mark are present but **inert**: no ✕, no editor.
 * They are still listed because they are the only way to find a mark that has no
 * ordinal any more (a grey one), and hovering a row lights its mark up — the
 * read-only rule is about editing/deleting/re-annotating, not about pointing.
 */
export function AnnotationList({
  marks,
  editingKey,
  hoverKey,
  onSelect,
  onHover,
  onRemove,
}: AnnotationListProps): React.JSX.Element {
  const empty = marks.length === 0;
  return (
    <aside
      className="imb-annot-list"
      aria-label={t("Annotations on this image")}
    >
      <p className="imb-annot-list-title">
        {t("Annotations on this image · ${count}", {
          count: String(marks.length),
        })}
      </p>
      {empty ? (
        <p className="imb-annot-list-empty">
          {t("Nothing yet. Click a point, or drag a box around an area.")}
        </p>
      ) : (
        <ul className="imb-annot-list-rows">
          {marks.map((view) => {
            const delivered = view.sent === true;
            return (
              <li key={view.key}>
                <div
                  className={cls(
                    "imb-annot-list-row",
                    editingKey === view.key && "imb-annot-list-row-editing",
                    hoverKey === view.key && "imb-annot-list-row-hover",
                  )}
                  onMouseEnter={() => onHover(view.key)}
                  onMouseLeave={() => onHover(null)}
                >
                  {delivered ? (
                    // Inert by construction: a delivered mark has no editor and no
                    // delete (the row still points at its mark while hovered).
                    <span className="imb-annot-list-open imb-annot-list-open-static">
                      <span className="imb-annot-list-ordinal">
                        {view.ordinal === undefined ? "" : `#${view.ordinal}`}
                      </span>
                      <span className="imb-annot-list-note">{view.note}</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="imb-annot-list-open"
                      onClick={() => onSelect(view.key)}
                    >
                      <span className="imb-annot-list-ordinal">
                        {view.ordinal === undefined ? "" : `#${view.ordinal}`}
                      </span>
                      <span className="imb-annot-list-note">{view.note}</span>
                    </button>
                  )}
                  {!delivered && (
                    <button
                      type="button"
                      className="imb-annot-list-remove"
                      aria-label={t("Remove annotation")}
                      title={t("Remove annotation")}
                      onClick={() => onRemove(view.key)}
                    >
                      ×
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
