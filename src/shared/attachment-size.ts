/**
 * Human-readable size of an attachment, shared by the two ends that render it:
 *
 * - the agent prompt's attachment block (`formatAttachmentBlock()`), which is the
 *   only thing persisted, and
 * - the chips the session view renders — including the placeholder row of a send
 *   that is not in the transcript yet.
 *
 * One implementation on purpose: the placeholder's label must be identical to the
 * one the transcript row shows a moment later, otherwise the chip would visibly
 * relabel itself when the row arrives.
 */

/** `123 B` / `1.5 KB` / `2.0 MB`; `unknown size` for a missing/invalid byte count. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
