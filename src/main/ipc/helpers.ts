import {
  MAX_TAG_FILTER_TAGS,
  MAX_TAGS_PER_CHAT,
  normalizeTag,
  TAG_FILTER_NONE,
} from "@shared/constants/tags";
import type { PageQuery } from "@shared/types";

export function assertString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

export function assertInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be an integer.`);
  }
  return value;
}

export function assertObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
} /** Validate a `PageQuery` payload defensively (cursor/query strings, sane limit). */

export function parsePageQuery(value: unknown): PageQuery {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("page query must be an object.");
  }
  const record = value as Record<string, unknown>;
  const page: PageQuery = {};
  if (record["cursor"] !== undefined && record["cursor"] !== null) {
    page.cursor = assertString(record["cursor"], "cursor");
  }
  if (record["query"] !== undefined && record["query"] !== null) {
    page.query = assertString(record["query"], "query");
  }
  if (record["limit"] !== undefined) {
    const limit = assertInteger(record["limit"], "limit");
    if (limit < 1 || limit > 200) {
      throw new Error("limit must be between 1 and 200.");
    }
    page.limit = limit;
  }
  if (record["tags"] !== undefined && record["tags"] !== null) {
    const raw = record["tags"];
    if (!Array.isArray(raw)) throw new Error("tags must be an array.");
    if (raw.length > MAX_TAGS_PER_CHAT) {
      throw new Error(`at most ${MAX_TAGS_PER_CHAT} tags may be filtered on.`);
    }
    const tags: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== "string") {
        throw new Error("each tag must be a string.");
      }
      const tag = normalizeTag(entry);
      if (tag.length > 0 && !tags.includes(tag)) tags.push(tag);
    }
    if (tags.length > 0) page.tags = tags;
  }
  if (record["noTags"] !== undefined && record["noTags"] !== null) {
    if (typeof record["noTags"] !== "boolean") {
      throw new Error("noTags must be a boolean.");
    }
    if (record["noTags"]) page.noTags = true;
  }
  return page;
}

/**
 * Validate a tag **filter** payload defensively (a filter over conversations,
 * e.g. `spend:report`'s second argument).
 *
 * Differs from the filter inside {@link parsePageQuery} on purpose: the
 * `TAG_FILTER_NONE` ("no tags") pseudo-value survives verbatim, and the length
 * is bounded by {@link MAX_TAG_FILTER_TAGS} instead of `MAX_TAGS_PER_CHAT` (a
 * filter is not a conversation — silently truncating one would answer for a
 * filter the user never picked). Concrete tags are normalized, whitespace-only
 * entries dropped and duplicates collapsed; input order is preserved.
 */
export function parseTagFilter(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("tag filter must be an array.");
  }
  if (value.length > MAX_TAG_FILTER_TAGS) {
    throw new Error(`at most ${MAX_TAG_FILTER_TAGS} tags may be filtered on.`);
  }
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error("each tag must be a string.");
    }
    // "No tags" is a sentinel, not a tag: keep it as-is (normalization would
    // otherwise drop it together with whitespace-only input).
    if (entry === TAG_FILTER_NONE) {
      if (!tags.includes(TAG_FILTER_NONE)) tags.push(TAG_FILTER_NONE);
      continue;
    }
    const tag = normalizeTag(entry);
    if (tag.length > 0 && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}
