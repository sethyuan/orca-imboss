import type { Message } from "@shared/types";

/**
 * Kinds whose `content` is free-form Markdown prose. These are the only rows
 * rendered through `<Markdown>` (see `MessageItem`), so they are the only ones
 * whose stored text *is* a Markdown source. Every other kind carries a payload
 * (an `ask`/`answer` JSON set, a `progress` title, a `chat` id, an image
 * prompt) that would not round-trip as Markdown.
 */
const MARKDOWN_KINDS: ReadonlySet<string> = new Set(["text", "report"]);

/**
 * The exact Markdown source a "Copy as Markdown" action should put on the
 * clipboard, or `null` when this row gets no such action.
 *
 * Rules (boss-approved):
 * - **Root chat only.** `readonly` marks the read-only group-chat mirror; the
 *   interactive root chat is the only view that offers the action.
 * - **Both sides of the conversation.** The boss asked for the assistant's
 *   messages first and then for their own: prose is prose, whoever wrote it, and
 *   a long prompt is exactly as worth reusing as a long answer. So the sender is
 *   deliberately *not* part of the rule any more — only the kind and the text.
 * - **Markdown prose only** (`text`/`report`), and only when there is something
 *   to copy — a media-only row (empty content, attachments only) must not offer
 *   an action that copies nothing.
 *
 * The text is returned **verbatim** (byte-faithful source): code fences, tables,
 * KaTeX source and `@<employeeId>` mentions stay exactly as written. Nothing is
 * serialized, flattened or re-resolved here — the renderer is allowed to
 * display names where the source has ids, but a copy must not invent text.
 */
export function markdownCopySource(
  message: Message,
  readonly: boolean,
): string | null {
  if (readonly) return null;
  if (!MARKDOWN_KINDS.has(message.kind)) return null;
  if (typeof message.content !== "string") return null;
  return message.content.trim().length > 0 ? message.content : null;
}
