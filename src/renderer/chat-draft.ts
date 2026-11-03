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

/**
 * One composer's draft: the text the boss typed plus the chips attached to it.
 *
 * Stored per chat in `appStore.chatDrafts` (the chat composer) and per
 * `(employee, chat)` in `appStore.sessionDrafts` (the agent-session composer),
 * so a module switch never loses input. Both composers render the same shared
 * `ComposerCard`, which is why they share this shape.
 */
export interface ChatDraft {
  text: string;
  attachments: PendingAttachment[];
}

/**
 * Read-only view of a draft — what a composer *renders*.
 *
 * The composers read their draft through a valtio snapshot, where every nested
 * array and object is deeply readonly. Typing the render path against this view
 * keeps a component from mutating the store by accident: every write goes
 * through an explicit store method (`setChatDraftText`, `addSessionDraft…`, …),
 * which is also what notifies the subscribers.
 */
export interface ComposerDraftView {
  readonly text: string;
  readonly attachments: readonly PendingAttachment[];
}

/**
 * Shared immutable fallback for a chat that has no draft yet. Never assigned
 * into the store (mutations always allocate a fresh draft) so it stays frozen.
 */
export const EMPTY_DRAFT: ChatDraft = { text: "", attachments: [] };

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
  if (
    attachment.kind === "file" ||
    attachment.kind === "folder" ||
    attachment.kind === "chat"
  ) {
    plain.kind = attachment.kind;
  }
  if (
    typeof attachment.chatId === "number" &&
    Number.isSafeInteger(attachment.chatId) &&
    attachment.chatId > 0
  ) {
    plain.chatId = attachment.chatId;
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
