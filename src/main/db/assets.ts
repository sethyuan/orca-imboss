import { assetCategoryOf } from "@shared/constants/assets";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@shared/constants/paged";
import type {
  AssetCategory,
  AssetDetail,
  AssetFilter,
  AssetSummary,
  HiddenAsset,
  MessageAttachment,
  PageQuery,
  PageResult,
} from "@shared/types";
import { statSync } from "fs";
import { getDB } from "./index";
import { getMessageById, parseAttachments } from "./messages";

/**
 * The asset library is derived from the `messages` table (there is no separate
 * asset table), so history is included automatically. Each message attachment
 * is an "occurrence"; occurrences sharing the same dedup key collapse into one
 * asset whose representative is the most recent occurrence (rows load
 * newest-first, so the first occurrence seen wins).
 *
 * Dedup key: the absolute `path` when present and non-empty, else
 * `name|size|type`. `hidden_assets` records paths, so only path-keyed assets
 * can be hidden.
 */

/** Raw row shape of the asset source query. */
interface AssetRow {
  id: number;
  chat_id: number;
  sender_employee_id: number | null;
  attachments: string | null;
  created_at: number;
  chat_title: string | null;
}

/** One parsed attachment occurrence, before deduplication. */
interface Occurrence {
  messageId: number;
  index: number;
  name: string;
  size: number;
  type: string;
  path: string | null;
  category: AssetCategory;
  chatId: number;
  chatTitle: string;
  senderEmployeeId: number | null;
  createdAt: number;
}

/** Cursor payload: the sort tuple `(createdAt, messageId, index)`. */
interface AssetCursor {
  createdAt: number;
  messageId: number;
  index: number;
}

/** Dedup key of a raw occurrence: absolute path when known, else name|size|type. */
function occurrenceKey(
  name: string,
  size: number,
  type: string,
  path: string | null,
): string {
  return path !== null && path.length > 0 ? path : `${name}|${size}|${type}`;
}

/** Dedup key of a built asset (mirrors `occurrenceKey`). */
function assetKeyOf(asset: AssetSummary): string {
  return occurrenceKey(asset.name, asset.size, asset.type, asset.path);
}

/**
 * One page of deduplicated assets across every chat, newest representative
 * first. Search/filters run on the representative occurrence; pagination is a
 * keyset seek on the `(createdAt, messageId, index)` sort tuple so inserts or
 * deletes during scrolling never skip or duplicate rows.
 */
export function listAssets(
  filter: AssetFilter = {},
  page: PageQuery = {},
): PageResult<AssetSummary> {
  const limit = Math.min(
    Math.max(Math.trunc(page.limit ?? DEFAULT_PAGE_SIZE), 1),
    MAX_PAGE_SIZE,
  );
  const assets = collectAssets(filter, page.query);
  assets.sort(compareAssets);

  // Keyset seek — keep only rows that sort strictly after the cursor.
  let remaining = assets;
  if (page.cursor) {
    const cursor = decodeAssetCursor(page.cursor);
    if (cursor) {
      remaining = assets.filter(
        (asset) => compareAssetCursor(asset, cursor) > 0,
      );
    }
  }

  const items = remaining.slice(0, limit);
  const hasMore = remaining.length > limit;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeAssetCursor(last) : null,
    hasMore,
  };
}

/**
 * A single deduplicated asset plus its live on-disk state. Returns `null` when
 * the message/index does not exist, has no such attachment, or the asset is
 * hidden (hidden assets are excluded from the same collector as the list).
 * `missing` is true when the path is unknown or the file is gone.
 */
export function getAsset(messageId: number, index: number): AssetDetail | null {
  const attachment = attachmentAt(messageId, index);
  if (!attachment) return null;
  const key = occurrenceKey(
    attachment.name,
    attachment.size,
    attachment.type,
    attachment.path ?? null,
  );
  const asset = collectAssets({}).find((item) => assetKeyOf(item) === key);
  if (!asset) return null;
  const missing = asset.path === null || !isReadableFile(asset.path);
  return { ...asset, missing };
}

/**
 * Every occurrence of the asset identified by `(messageId, index)` — same
 * dedup key — newest first. Each summary carries the total group size in
 * `occurrences`. Returns `[]` when the message/index does not exist or has no
 * such attachment. Hidden assets are not filtered here (the caller is already
 * looking at a specific occurrence).
 */
export function listAssetOccurrences(
  messageId: number,
  index: number,
): AssetSummary[] {
  const attachment = attachmentAt(messageId, index);
  if (!attachment) return [];
  const key = occurrenceKey(
    attachment.name,
    attachment.size,
    attachment.type,
    attachment.path ?? null,
  );
  const occurrences = loadOccurrences({}).filter(
    (occurrence) =>
      occurrenceKey(
        occurrence.name,
        occurrence.size,
        occurrence.type,
        occurrence.path,
      ) === key,
  );
  occurrences.sort(compareOccurrences);
  const total = occurrences.length;
  return occurrences.map((occurrence) => toAssetSummary(occurrence, total));
}

/** Hide an asset globally by its resolved absolute path. */
export function hideAsset(path: string): void {
  getDB()
    .prepare(
      "INSERT OR REPLACE INTO hidden_assets(path, hidden_at) VALUES (?, ?)",
    )
    .run(path, Math.floor(Date.now() / 1000));
}

/** Restore a previously hidden path to the asset library. */
export function unhideAsset(path: string): void {
  getDB().prepare("DELETE FROM hidden_assets WHERE path = ?").run(path);
}

/** List hidden paths, most recently hidden first. */
export function listHiddenAssets(): HiddenAsset[] {
  const rows = getDB()
    .prepare(
      "SELECT path, hidden_at FROM hidden_assets ORDER BY hidden_at DESC",
    )
    .all() as Array<{ path: string; hidden_at: number }>;
  return rows.map((row) => ({ path: row.path, hiddenAt: row.hidden_at }));
}

/** Attachment at `(messageId, index)`, or null when absent/out of bounds. */
function attachmentAt(
  messageId: number,
  index: number,
): MessageAttachment | null {
  const message = getMessageById(messageId);
  if (!message) return null;
  const attachments = message.attachments;
  if (!attachments || index < 0 || index >= attachments.length) return null;
  return attachments[index];
}

/**
 * Load every attachment occurrence matching the SQL-level filters, newest
 * first. `from`/`to` narrow occurrences by `created_at`; category/imagesOnly/
 * query are applied later, on the deduplicated representative.
 */
function loadOccurrences(filter: AssetFilter): Occurrence[] {
  const db = getDB();
  const conditions: string[] = ["m.attachments IS NOT NULL"];
  const params: Array<string | number> = [];

  if (
    typeof filter.chatId === "number" &&
    Number.isSafeInteger(filter.chatId)
  ) {
    conditions.push("m.chat_id = ?");
    params.push(filter.chatId);
  }
  if (
    typeof filter.senderEmployeeId === "number" &&
    Number.isSafeInteger(filter.senderEmployeeId)
  ) {
    conditions.push("m.sender_employee_id = ?");
    params.push(filter.senderEmployeeId);
  }
  if (typeof filter.from === "number" && Number.isFinite(filter.from)) {
    conditions.push("m.created_at >= ?");
    params.push(Math.trunc(filter.from));
  }
  if (typeof filter.to === "number" && Number.isFinite(filter.to)) {
    conditions.push("m.created_at <= ?");
    params.push(Math.trunc(filter.to));
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.chat_id, m.sender_employee_id, m.attachments, m.created_at,
              c.title AS chat_title
       FROM messages m
       LEFT JOIN chats c ON c.id = m.chat_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY m.created_at DESC, m.id DESC`,
    )
    .all(...params) as AssetRow[];

  const occurrences: Occurrence[] = [];
  for (const row of rows) {
    const attachments = parseAttachments(row.attachments);
    if (!attachments) continue;
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      occurrences.push({
        messageId: row.id,
        index,
        name: attachment.name,
        size: attachment.size,
        type: attachment.type,
        path: attachment.path ?? null,
        category: assetCategoryOf(attachment.name, attachment.type),
        chatId: row.chat_id,
        chatTitle: row.chat_title ?? "",
        senderEmployeeId: row.sender_employee_id,
        createdAt: row.created_at,
      });
    }
  }
  return occurrences;
}

/**
 * Deduplicate occurrences into assets, drop hidden paths, and apply the
 * representative-level filters (category, imagesOnly, filename query, and the
 * inclusive `from`/`to` bounds). The representative is the newest occurrence
 * (first seen, since rows load newest-first).
 */
function collectAssets(
  filter: AssetFilter,
  pageQuery?: string,
): AssetSummary[] {
  const hidden = hiddenPathSet();
  const groups = new Map<
    string,
    { representative: Occurrence; count: number }
  >();

  for (const occurrence of loadOccurrences(filter)) {
    const key = occurrenceKey(
      occurrence.name,
      occurrence.size,
      occurrence.type,
      occurrence.path,
    );
    const group = groups.get(key);
    if (group) {
      group.count += 1;
    } else {
      groups.set(key, { representative: occurrence, count: 1 });
    }
  }

  const result: AssetSummary[] = [];
  for (const [key, group] of groups) {
    if (hidden.has(key)) continue;
    const asset = toAssetSummary(group.representative, group.count);
    if (!matchesFilter(asset, filter, pageQuery)) continue;
    result.push(asset);
  }
  return result;
}

/** Representative-level filters (category, imagesOnly, filename query, bounds). */
function matchesFilter(
  asset: AssetSummary,
  filter: AssetFilter,
  pageQuery?: string,
): boolean {
  if (filter.category !== undefined && asset.category !== filter.category) {
    return false;
  }
  if (filter.imagesOnly === true && asset.category !== "image") return false;
  if (
    typeof filter.from === "number" &&
    Number.isFinite(filter.from) &&
    asset.createdAt < Math.trunc(filter.from)
  ) {
    return false;
  }
  if (
    typeof filter.to === "number" &&
    Number.isFinite(filter.to) &&
    asset.createdAt > Math.trunc(filter.to)
  ) {
    return false;
  }
  // `filter.query` is the filename search; the page term is a fallback so the
  // same search box works whether the term rides on the filter or the page.
  const filterQuery =
    typeof filter.query === "string" ? filter.query.trim() : "";
  const query = filterQuery || (pageQuery ?? "").trim();
  if (
    query.length > 0 &&
    !asset.name.toLowerCase().includes(query.toLowerCase())
  ) {
    return false;
  }
  return true;
}

function toAssetSummary(
  occurrence: Occurrence,
  occurrences: number,
): AssetSummary {
  return {
    messageId: occurrence.messageId,
    index: occurrence.index,
    name: occurrence.name,
    size: occurrence.size,
    type: occurrence.type,
    path: occurrence.path,
    category: occurrence.category,
    chatId: occurrence.chatId,
    chatTitle: occurrence.chatTitle,
    senderEmployeeId: occurrence.senderEmployeeId,
    createdAt: occurrence.createdAt,
    occurrences,
  };
}

/** Set of hidden absolute paths (empty table → empty set). */
function hiddenPathSet(): Set<string> {
  const rows = getDB()
    .prepare("SELECT path FROM hidden_assets")
    .all() as Array<{ path: string }>;
  return new Set(rows.map((row) => row.path));
}

/** True when `path` points at an existing regular file. */
function isReadableFile(path: string): boolean {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat !== undefined && stat.isFile();
}

/** Sort descending by `(createdAt, messageId, index)`. */
function compareAssets(a: AssetSummary, b: AssetSummary): number {
  return (
    b.createdAt - a.createdAt || b.messageId - a.messageId || b.index - a.index
  );
}

function compareOccurrences(a: Occurrence, b: Occurrence): number {
  return (
    b.createdAt - a.createdAt || b.messageId - a.messageId || b.index - a.index
  );
}

/** Positive when `asset` sorts strictly after `cursor` in the page order. */
function compareAssetCursor(asset: AssetSummary, cursor: AssetCursor): number {
  return (
    cursor.createdAt - asset.createdAt ||
    cursor.messageId - asset.messageId ||
    cursor.index - asset.index
  );
}

function encodeAssetCursor(asset: AssetSummary): string {
  return `${asset.createdAt}:${asset.messageId}:${asset.index}`;
}

/** Defensive cursor decode — malformed payloads are ignored (first page). */
function decodeAssetCursor(cursor: string): AssetCursor | null {
  const parts = cursor.split(":");
  if (parts.length !== 3) return null;
  const createdAt = Number(parts[0]);
  const messageId = Number(parts[1]);
  const index = Number(parts[2]);
  if (
    !Number.isFinite(createdAt) ||
    !Number.isSafeInteger(messageId) ||
    !Number.isSafeInteger(index)
  ) {
    return null;
  }
  return { createdAt, messageId, index };
}
