import { IMAGE_GENERATION_ENABLED } from "@shared/constants/image-gen";
import { toImbFileUrl } from "@shared/imb-file";
import { t } from "@shared/l10n";
import type { Message } from "@shared/types";
import { useEffect, useRef, useState } from "react";
import { cls } from "reactutils";
import { ImageStack, type ImageStackImage } from "../image-stack";
import "./index.css";

/**
 * In-chat image generation, renderer side (the call itself lives in
 * `src/main/image-gen.ts`, driven by the `imb_generate_image` tool).
 *
 * One `kind="image"` message carries the whole lifecycle in place: it is
 * appended as `generating` (the shimmer below), then the same row is updated to
 * `done` (with the picture appended) or `error`. The thread re-reads on the same
 * `messages:changed` event every append uses, so the placeholder gives way to
 * the picture without a second channel.
 *
 * A row keeps every generation, and they are rendered with the shared image
 * stack — so a re-roll pushes a new card onto a deck the boss can already flip
 * through (drag, wheel, click to enlarge), and the picture still being produced
 * takes the front card while the earlier ones stay visible behind it.
 *
 * A finished picture offers **Regenerate**: it redraws with the prompt the row
 * already carries (`imageGen:reroll`), which puts the row back into `generating`
 * — so the same placeholder-and-swap path runs again. A re-roll that fails keeps
 * the pictures that were already there and reports why here; a prompt that needs
 * changing is simply typed in the composer, so this button never edits it.
 */

/** Display size of the deck (the generated picture's frame). */
const IMAGE_FRAME_SIZE = 240;

/** How long the arrival animation runs; the flag clears just after it. */
const ARRIVE_MS = 400;

export function ImageMessage({
  message,
  self,
}: {
  message: Message;
  self: boolean;
}): React.JSX.Element | null {
  const [rerollError, setRerollError] = useState<string | null>(null);
  const [arrived, setArrived] = useState(false);
  const mounted = useRef(false);

  // Stored oldest → newest; the deck shows the newest first, so the front card
  // is the latest attempt. Entries without a path are not drawable yet.
  const pictures: ImageStackImage[] = [];
  (message.attachments ?? []).forEach((attachment, index) => {
    if (typeof attachment.path === "string" && attachment.path.length > 0) {
      pictures.push({
        index,
        name: attachment.name,
        src: toImbFileUrl(attachment.path),
      });
    }
  });
  pictures.reverse();

  const newest = pictures[0]?.index ?? null;
  const generating = message.imageStatus === "generating";
  const failed = message.imageStatus === "error";

  // The freshly drawn picture fades into the slot the placeholder occupied. It
  // runs only when a picture actually arrives: a thread that merely mounts
  // (switching conversations) must not replay it.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setArrived(true);
    const timer = window.setTimeout(() => setArrived(false), ARRIVE_MS);
    return () => window.clearTimeout(timer);
  }, [newest]);

  if (!IMAGE_GENERATION_ENABLED) return null;

  const reroll = async (): Promise<void> => {
    setRerollError(null);
    try {
      await imb.imageGen.reroll(message.id);
    } catch (err) {
      setRerollError(reasonOf(err));
    }
  };

  return (
    <div
      className={cls(
        "imb-image-gen",
        self ? "imb-image-gen-self" : "imb-image-gen-other",
      )}
      // Row anchor for jumps (the row-anchoring contract, see `../message-item`).
      data-message-id={message.id}
    >
      {/* Keyed by the newest generation, so a fresh deck is built each time one
          arrives (its front card starts at the new picture) and the arrival
          animation is scoped to that deck. */}
      <div
        key={newest ?? "pending"}
        className={cls(
          "imb-image-gen-deck",
          arrived && "imb-image-gen-arrived",
        )}
      >
        {pictures.length > 0 ? (
          <ImageStack
            images={pictures}
            self={self}
            size={IMAGE_FRAME_SIZE}
            onRevealImage={(index) =>
              imb.messages.revealAttachment(message.id, index)
            }
            pending={generating ? <Placeholder failed={false} /> : undefined}
          />
        ) : (
          <Placeholder failed={failed} />
        )}
      </div>
      <p className="imb-image-gen-prompt">{message.content}</p>
      {(pictures.length > 0 || failed) && !generating && (
        <button
          type="button"
          className="imb-image-gen-reroll"
          onClick={() => void reroll()}
        >
          <RefreshGlyph />
          {t("Regenerate")}
        </button>
      )}
      {rerollError !== null && (
        <p className="imb-image-gen-error" role="alert">
          {rerollError}
        </p>
      )}
    </div>
  );
}

/** The slot's contents: the sheen while drawing, or the failure note. */
function Placeholder({ failed }: { failed: boolean }): React.JSX.Element {
  return (
    <div
      className={cls(
        "imb-image-gen-placeholder",
        failed && "imb-image-gen-failed",
      )}
      role="status"
    >
      {!failed && <span className="imb-image-gen-shimmer" aria-hidden="true" />}
      <span className="imb-image-gen-note">
        {failed ? t("Image generation failed") : t("Generating image…")}
      </span>
    </div>
  );
}

/**
 * IPC rejections arrive wrapped ("Error invoking remote method …: Error: …");
 * show the reason on its own.
 */
function reasonOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const marker = "Error: ";
  const at = raw.lastIndexOf(marker);
  return at >= 0 ? raw.slice(at + marker.length) : raw;
}

/** Small "draw it again" glyph (a circular arrow). */
function RefreshGlyph(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}
