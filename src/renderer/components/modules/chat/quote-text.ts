import type { DraftQuote } from "../../../chat-draft";

/** Longest quoted span kept (chars); longer selections are clipped. */
export const MAX_QUOTE_CHARS = 2000;

/** Trim and clip a raw selection into a quote body. */
export function clipQuoteText(raw: string): string {
  const text = raw.trim();
  return text.length > MAX_QUOTE_CHARS ? text.slice(0, MAX_QUOTE_CHARS) : text;
}

/**
 * Join the composer's quoted selections into the single quoted-selection
 * string stored on the outgoing message (kept separate from `content`, so the
 * quote never pollutes the message body).
 */
export function joinQuoteTexts(
  quotes: readonly DraftQuote[],
): string | undefined {
  if (quotes.length === 0) return undefined;
  return quotes.map((quote) => quote.text).join("\n\n");
}
