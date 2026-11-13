/**
 * The pictures this message carries that are **already marked**: a baked copy is a
 * derived attachment, not a picture the boss wrote, so it must not be rendered at
 * full size next to the original it came from.
 *
 * The boss's decision ⑥: a `96×60` compact thumbnail with an 「打标副本」 label,
 * clicking it opens the viewer (where the marks are in the pixels and cannot be
 * annotated again). Without it a message appeared to carry two identical pictures —
 * the original in the earlier message *and* its marked copy here — which read as a
 * duplicate rather than as "this is what the model was shown".
 */
import { t } from "@shared/l10n";
import { useState } from "react";
import { ImageLightbox } from "../image-lightbox";
import type { ImageStackImage } from "../image-stack";
import "./index.css";

export interface AnnotatedCopiesProps {
  /** The marked copies of this message, in attachment order. */
  copies: readonly ImageStackImage[];
  /** Reveal a copy in the OS file manager (its attachment index is passed). */
  onReveal?: (attachmentIndex: number) => void;
}

export function AnnotatedCopies({
  copies,
  onReveal,
}: AnnotatedCopiesProps): React.JSX.Element | null {
  const [open, setOpen] = useState<number | null>(null);
  if (copies.length === 0) return null;
  return (
    <>
      <ul className="imb-annot-copies" aria-label={t("Annotated copies")}>
        {copies.map((copy, position) => (
          <li key={copy.index}>
            <button
              type="button"
              className="imb-annot-copy"
              title={copy.name}
              onClick={() => setOpen(position)}
            >
              <img src={copy.src} alt={copy.name} draggable={false} />
              <span className="imb-annot-copy-label">
                {t("Annotated copy")}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open !== null && (
        <ImageLightbox
          images={copies.map(({ name, src }) => ({ name, src }))}
          index={open}
          onIndexChange={setOpen}
          onClose={() => setOpen(null)}
          onReveal={
            onReveal === undefined
              ? undefined
              : () => {
                  const copy = copies[open];
                  if (copy !== undefined) onReveal(copy.index);
                }
          }
        />
      )}
    </>
  );
}
