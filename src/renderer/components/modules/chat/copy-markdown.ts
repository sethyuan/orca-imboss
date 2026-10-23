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
 * - **Assistant side only.** A `null` sender is the boss (or a system notice);
 *   their messages are not "assistant messages".
 * - **Markdown prose only** (`text`/`report`), and only when there is something
 *   to copy — a media-only row has empty content and must not offer an action
 *   that copies nothing.
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
  if (message.senderEmployeeId === null) return null;
  if (!MARKDOWN_KINDS.has(message.kind)) return null;
  if (typeof message.content !== "string") return null;
  return message.content.trim().length > 0 ? message.content : null;
}
