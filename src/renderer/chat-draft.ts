import type { MessageAttachment } from "@shared/types";

/**
 * Composer-local attachment: the persisted metadata plus an optional
 * renderer-only object URL used to show an image thumbnail before sending.
 * Object URLs cannot be persisted, so the URL lives only for the session
 * (until the chip is removed, the draft is cleared, or the app exits).
 */
export interface PendingAttachment {
  id: number;
  attachment: MessageAttachment;
  previewUrl?: string;
}

/** One quoted selection waiting in the composer to be sent with the message. */
export interface DraftQuote {
  /** Quoted text (already trimmed and clipped). */
  text: string;
  /** Source chat message id when quoted from a bubble; `null` otherwise. */
  messageId: number | null;
  /** Display name of the source sender, shown on the quote block header. */
  sourceLabel?: string;
}

/**
 * One chat's composer draft. Stored per chat in `appStore.chatDrafts` so it
 * survives a module switch (the chat module is unmounted when another nav
 * module is active).
 */
export interface ChatDraft {
  text: string;
  attachments: PendingAttachment[];
  quotes: DraftQuote[];
}

/**
 * Shared immutable fallback for a chat that has no draft yet. Never assigned
 * into the store (mutations always allocate a fresh draft) so it stays frozen.
 */
export const EMPTY_DRAFT: ChatDraft = { text: "", attachments: [], quotes: [] };

/**
 * Monotonic attachment id source. Module-scoped (not per mount) so a restored
 * draft can never collide with ids minted after a remount — including the
 * StrictMode double-mount cycle.
 */
let attachmentSeq = 0;

/** Mint a fresh id for an attachment chip. */
export function nextAttachmentId(): number {
  return attachmentSeq++;
}

/**
 * Copy an attachment read out of the Valtio draft into a plain object.
 *
 * The composer reads its draft through `useSnapshot`, so every nested object —
 * including `PendingAttachment.attachment` — is a `proxy-compare` proxy, and
 * proxies cannot cross the Electron IPC boundary (V8's structured clone raises
 * "An object could not be cloned."). Rebuilding the known fields also pins the
 * shape the main process validates.
 */
export function toPlainAttachment(
  attachment: MessageAttachment,
): MessageAttachment {
  const plain: MessageAttachment = {
    name: attachment.name,
    size: attachment.size,
    type: attachment.type,
  };
  if (typeof attachment.path === "string" && attachment.path.length > 0) {
    plain.path = attachment.path;
  }
  if (attachment.kind === "file" || attachment.kind === "folder") {
    plain.kind = attachment.kind;
  }
  return plain;
}

/**
 * Release every renderer-only preview URL held by a draft. Called when a draft
 * is cleared (send / new chat / chat deletion); revoking an already-revoked URL
 * is a no-op, so callers need no extra bookkeeping.
 */
export function revokeDraftUrls(draft: ChatDraft | undefined): void {
  if (!draft) return;
  for (const item of draft.attachments) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
}
