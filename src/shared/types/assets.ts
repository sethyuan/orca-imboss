/**
 * The asset library: every message attachment across all chats, derived from
 * the `messages` table (there is no separate asset table — history is included
 * automatically). An asset is deduplicated by its absolute path; its
 * representative occurrence is the most recent message attachment.
 */

/** Broad file category, derived from MIME type / extension. */
export type AssetCategory =
  "image" | "document" | "sheet" | "archive" | "media" | "other";

/**
 * Trusted locator for one attachment occurrence. File operations always go
 * through `(messageId, index)`; the main process resolves the on-disk path
 * from the stored message, never from a renderer-supplied path.
 */
export interface AssetRef {
  messageId: number;
  index: number;
}

/** One deduplicated asset in the library. */
export interface AssetSummary {
  /** Representative occurrence (the most recent one) used for file ops. */
  messageId: number;
  index: number;
  name: string;
  size: number;
  type: string;
  /** Absolute on-disk path when known; `null` when none was stored. */
  path: string | null;
  category: AssetCategory;
  chatId: number;
  chatTitle: string;
  senderEmployeeId: number | null;
  /** UNIX timestamp in seconds of the most recent occurrence. */
  createdAt: number;
  /** How many message attachments share this asset (deduplicated by path). */
  occurrences: number;
}

/** A single asset with live on-disk state. */
export interface AssetDetail extends AssetSummary {
  /** True when the path is known but the file no longer exists on disk. */
  missing: boolean;
}

/** A path hidden from the asset library (globally, across every entry point). */
export interface HiddenAsset {
  path: string;
  /** UNIX timestamp in seconds when it was hidden. */
  hiddenAt: number;
}

/** Filters accepted by the asset library list. */
export interface AssetFilter {
  chatId?: number;
  senderEmployeeId?: number;
  category?: AssetCategory;
  /** Inclusive lower bound, UNIX timestamp in seconds. */
  from?: number;
  /** Inclusive upper bound, UNIX timestamp in seconds. */
  to?: number;
  /** Case-insensitive filename substring. */
  query?: string;
  /** Restrict to image assets. */
  imagesOnly?: boolean;
}
