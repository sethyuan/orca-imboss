/**
 * Conversation tags (`chat_tags` table). A tag is free-form text the user
 * types; the candidate list is derived from the tags already in use, so there
 * is deliberately no separate tag dictionary to manage.
 */

/** Maximum length of one tag, in characters, after normalization. */
export const MAX_TAG_LENGTH = 50;

/** Maximum number of tags a single conversation can carry. */
export const MAX_TAGS_PER_CHAT = 20;

/**
 * Defensive upper bound on the *length of a tag filter* (how many tags one
 * filter may AND-combine). Deliberately larger than {@link MAX_TAGS_PER_CHAT}:
 * a filter is not a conversation, and silently truncating one would show
 * numbers for a filter the user never picked.
 */
export const MAX_TAG_FILTER_TAGS = 256;

/**
 * Pseudo-value of the "No tags" option inside a tag **filter** (never a real
 * tag). Stored in the same `string[]` as the selected concrete tags so the
 * existing filter plumbing (`length > 0`, reset keys, clear-all) needs no
 * special case; consumers strip it and translate it to a dedicated predicate
 * (`PageQuery.noTags` on the server, `matchesTagFilter()` for conversations).
 *
 * `""` is safe as a sentinel because a real tag can never be blank:
 * `normalizeTag()` / `parsePageQuery()` both drop whitespace-only values, and
 * the filter state itself never passes through normalization.
 */
export const TAG_FILTER_NONE = "";

/**
 * Does one conversation's tag list match a tag **filter**?
 *
 * The filter is AND-combined: every selected tag must be present. The
 * {@link TAG_FILTER_NONE} pseudo-value matches conversations that carry no tag
 * at all (it is mutually exclusive with real tags in the UI, so a mixed filter
 * matches nothing). An empty filter matches everything.
 *
 * Shared by the server-side spend aggregation (`main/spend.ts`) and the
 * renderer's conversation list, so both narrow by exactly the same rule.
 */
export function matchesTagFilter(
  chatTags: readonly string[],
  filter: readonly string[],
): boolean {
  return filter.every((tag) =>
    tag === TAG_FILTER_NONE ? chatTags.length === 0 : chatTags.includes(tag),
  );
}

/**
 * Normalize a raw tag the user typed: collapse control characters and runs of
 * whitespace, then trim and cap the length. Case is preserved on purpose —
 * `Work` and `work` are two distinct tags.
 *
 * Returns `""` when nothing but whitespace was supplied (the caller drops it).
 */
export function normalizeTag(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TAG_LENGTH)
    .trim();
}

/**
 * Normalize a list of raw tags: normalize each, drop empties, drop exact
 * duplicates (first occurrence wins) and cap to `MAX_TAGS_PER_CHAT`.
 */
export function normalizeTags(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const tag = normalizeTag(value);
    if (tag.length === 0 || result.includes(tag)) continue;
    result.push(tag);
    if (result.length >= MAX_TAGS_PER_CHAT) break;
  }
  return result;
}
