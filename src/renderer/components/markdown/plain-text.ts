import remarkGfm from "remark-gfm";
import remarkMath from "remark-math-extended";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import stripMarkdown from "strip-markdown";
import { unified } from "unified";
import { GFM_OPTIONS, unescapeTildes } from "./gfm";

/**
 * Markdown → plain text for the chat-list preview (and any other place that
 * needs a one-line teaser). Code, tables, math, and formatting markers are
 * removed; the result is still markdown source, so callers should collapse
 * whitespace before truncating.
 *
 * `GFM_OPTIONS` keeps the parse identical to the renderer's, so a teaser never
 * claims a `~abc~` is struck through while the bubble shows it literally.
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm, GFM_OPTIONS)
  .use(remarkMath)
  .use(stripMarkdown, { remove: ["math", "inlineMath"] })
  .use(remarkStringify);

/** Defensive: never let a malformed document break the chat list. */
export function toPlainText(markdown: string): string {
  if (markdown.trim().length === 0) return "";
  try {
    // With single-tilde strikethrough off, stringify escapes literal tildes
    // (`\~`); the teaser must read `~abc~`, not `\~abc\~`.
    return unescapeTildes(String(processor.processSync(markdown)));
  } catch {
    return markdown;
  }
}
