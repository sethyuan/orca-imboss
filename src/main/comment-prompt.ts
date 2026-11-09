/**
 * Comments ↔ prompt helpers, shared by both send paths that can carry comments
 * (`chat:send` for a stored message, `agentSession:send` for a session prompt)
 * **and** by the session projection that reads those prompts back
 * (`agent/session-view.ts`).
 *
 * One module for both directions, exactly like `attachment-prompt.ts`: the block
 * below is how a comment is described to the model, `splitCommentPrompt()` is
 * its inverse, and the inverse is validated by re-composing what it parsed and
 * requiring a byte-for-byte match. A change to the wording therefore degrades the
 * parser to "leave the text alone" instead of mangling a prompt.
 *
 * ## The block
 *
 * ```
 * [Comments]
 * #1 on message #1200
 * quote: the selected passage, one line
 * note: what the boss wrote about it, one line
 * #2 on session entry 8e5c1a2b
 * quote: …
 * note: …
 * ```
 *
 * The block is **payload only**: a header plus one three-line record per comment
 * (`#<n>` plus where the passage lives, then the two field lines). It carries no
 * prose of its own — what a comment is and how to answer it belongs to the
 * system prompt (`COMMENT_RESPONSE_PROMPT` / `ASSISTANT_COMMENT_RESPONSE_PROMPT`),
 * which is in context for every turn. Restating it here was pure duplication and
 * cost tokens on the one turn that could least afford it. `quote`/`note` are collapsed to a single
 * line and capped (`sanitizePromptField`), which is what makes the format
 * unambiguous and re-composable. The full note stays in `messages.comments` (the
 * prompt is a delivery channel, not the storage of record); a quote is capped
 * tighter than the stored one because the annotated message is still in the
 * conversation and the agent can re-read it with `imb_read_chat`.
 *
 * ## Position in the prompt
 *
 * The block goes **after** the boss's text and **before** the `[Attachments]`
 * block: the attachment block must stay the prompt's trailing suffix (the session
 * projection splits it off last-but-first — see `session-view.ts`), and the
 * per-turn boss-direct hint sits between them. Composition order is therefore
 * `text → [Comments] → boss hint → [Attachments]`, and the projection peels them
 * off in exactly the reverse order.
 */
import {
  MAX_COMMENTS_PER_MESSAGE,
  MAX_COMMENT_NOTE_LENGTH,
  MAX_COMMENT_QUOTE_LENGTH,
  MAX_PROMPT_COMMENT_NOTE_LENGTH,
  MAX_PROMPT_COMMENT_QUOTE_LENGTH,
} from "@shared/constants/comments";
import type {
  CommentAnchor,
  CommentTarget,
  MessageComment,
} from "@shared/types";
import { sanitizePromptField } from "./attachment-prompt";

/** First line of the block `withComments()` appends (and the parser looks for). */
const BLOCK_HEADER = "[Comments]";

/** Longest entry id a `session entry` header may carry (defensive cap). */
const MAX_ENTRY_ID_LENGTH = 64;

/** Renderer-facing projection of one recovered comment (display data only). */
export interface PromptCommentView {
  /** The annotated message, when the block named one. */
  messageId?: number;
  /** The annotated session entry, when the block named one. */
  entryId?: string;
  quote: string;
  note: string;
}

// --- Writing -----------------------------------------------------------------

/** The header line of one comment: its id plus where the passage lives. */
function formatCommentHeader(ordinal: number, target: CommentTarget): string {
  const where =
    target.kind === "message"
      ? `on message #${target.messageId}`
      : `on session entry ${target.entryId}`;
  return `#${ordinal} ${where}`;
}

/**
 * One comment's three lines. Shared by the writer and the parser's round-trip
 * check so the two can never disagree about the shape.
 */
function formatCommentLines(
  ordinal: number,
  target: CommentTarget,
  quote: string,
  note: string,
): string {
  return [
    formatCommentHeader(ordinal, target),
    `quote: ${quote}`,
    `note: ${note}`,
  ].join("\n");
}

/**
 * Serialize comments into the whole block (header included), or `""` for an
 * empty list (no block at all), so this doubles as the parser's canonical
 * comparator.
 *
 * Values are sanitized here rather than trusted from the caller: the block is
 * model input, and a note containing a newline would otherwise forge an extra
 * line (and a second comment the parser would then believe in).
 */
export function composeCommentBlock(
  comments: readonly MessageComment[],
): string {
  if (comments.length === 0) return "";
  const blocks = comments.map((comment, index) =>
    formatCommentLines(
      index + 1,
      comment.anchor.target,
      sanitizePromptField(
        comment.anchor.quote,
        MAX_PROMPT_COMMENT_QUOTE_LENGTH,
      ),
      sanitizePromptField(comment.note, MAX_PROMPT_COMMENT_NOTE_LENGTH),
    ),
  );
  return [BLOCK_HEADER, ...blocks].join("\n");
}

/**
 * Add the `[Comments]` block to one turn's prompt text.
 *
 * Call it **before** `agentPrompt()` (and before the boss-direct hint): the
 * block must never end up after the `[Attachments]` block. An empty list leaves
 * the text untouched, so every caller can pass its (possibly empty) list.
 */
export function withComments(
  text: string,
  comments: readonly MessageComment[] | undefined,
): string {
  const block = composeCommentBlock(comments ?? []);
  if (block.length === 0) return text;
  return text.length > 0 ? `${text}\n\n${block}` : block;
}

// --- Reading a prompt back ---------------------------------------------------

/** `#<n> on message #<id>` or `#<n> on session entry <id>`. */
const HEADER_LINE = /^#(\d+) on (?:message #(\d+)|session entry (\S+))$/;

/** Parse one comment's three lines, or `null` when they are not one of ours. */
function parseCommentLines(
  lines: string[],
  at: number,
): PromptCommentView | null {
  const header = HEADER_LINE.exec(lines[at] ?? "");
  if (header === null) return null;
  const quoteLine = lines[at + 1] ?? "";
  const noteLine = lines[at + 2] ?? "";
  if (!quoteLine.startsWith("quote: ")) return null;
  if (!noteLine.startsWith("note: ")) return null;
  const quote = quoteLine.slice("quote: ".length);
  const note = noteLine.slice("note: ".length);
  if (quote.length === 0 || note.length === 0) return null;
  const messageId = header[2] === undefined ? undefined : Number(header[2]);
  if (messageId !== undefined) {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
    return { messageId, quote, note };
  }
  const entryId = header[3];
  if (entryId === undefined || entryId.length > MAX_ENTRY_ID_LENGTH)
    return null;
  return { entryId, quote, note };
}

/** Parse a whole block body (header included), or `null` when it is not ours. */
function parseCommentBlock(block: string): PromptCommentView[] | null {
  const lines = block.split("\n");
  if (lines[0] !== BLOCK_HEADER) return null;
  const body = lines.slice(1);
  if (body.length === 0 || body.length % 3 !== 0) return null;
  if (body.length / 3 > MAX_COMMENTS_PER_MESSAGE) return null;
  const parsed: PromptCommentView[] = [];
  for (let at = 0; at < body.length; at += 3) {
    const item = parseCommentLines(body, at);
    if (item === null) return null;
    // Ids are positional; a mismatch means the block was hand-edited.
    if (!body[at].startsWith(`#${parsed.length + 1} `)) return null;
    parsed.push(item);
  }
  return parsed;
}

/**
 * The exact inverse of `withComments()`: split a persisted prompt into the text
 * that was sent plus the comments its `[Comments]` block carried.
 *
 * Returns `comments: []` (and the text **untouched**) whenever the block is not
 * one this module could have written: not a trailing block, a line count that is
 * not `1 + 3n`, non-sequential ids, an unknown line shape, or a re-composition
 * that does not reproduce the block byte for byte. Never throws and never drops text — the
 * prompt is the boss's own words plus chrome we are only allowed to remove when
 * we recognize it exactly.
 */
export function splitCommentPrompt(text: string): {
  text: string;
  comments: PromptCommentView[];
} {
  const unchanged = { text, comments: [] as PromptCommentView[] };
  const header = `${BLOCK_HEADER}\n`;
  let body = "";
  let block: string;
  if (text.startsWith(header)) {
    block = text;
  } else {
    const at = text.lastIndexOf(`\n\n${header}`);
    if (at < 0) return unchanged;
    body = text.slice(0, at);
    block = text.slice(at + 2);
  }
  const parsed = parseCommentBlock(block);
  if (parsed === null) return unchanged;
  // Byte-exact round-trip check: rebuild from the parsed fields and require the
  // very same block. Anything that cannot be rebuilt was not ours to remove.
  const rebuilt = [
    BLOCK_HEADER,
    ...parsed.map((item, index) =>
      formatCommentLines(
        index + 1,
        item.messageId !== undefined
          ? { kind: "message", messageId: item.messageId }
          : { kind: "entry", entryId: item.entryId ?? "" },
        item.quote,
        item.note,
      ),
    ),
  ].join("\n");
  if (rebuilt !== block) return unchanged;
  return { text: body, comments: parsed };
}

/**
 * Rebuild a stored-shaped anchor from a recovered comment, for the renderer's
 * highlight resolution.
 *
 * The prompt block carries no offsets (the model does not need them), so the
 * offsets are `-1`: the anchor is **quote-only** and must be resolved by
 * searching the target's rendered text. That is a supported state everywhere —
 * see the `CommentAnchor` doc.
 */
export function promptCommentToMessageComment(
  comment: PromptCommentView,
): MessageComment {
  const target: CommentTarget =
    comment.messageId !== undefined
      ? { kind: "message", messageId: comment.messageId }
      : { kind: "entry", entryId: comment.entryId ?? "" };
  const anchor: CommentAnchor = {
    target,
    quote: comment.quote,
    start: -1,
    end: -1,
    occurrence: 0,
    textLength: -1,
  };
  return { anchor, note: comment.note };
}

// --- Validation (shared trust boundary) --------------------------------------

/**
 * Shape check for a renderer-supplied comment list: what may reach the model at
 * all. Deliberately does **not** check that a `message` target exists — a chat
 * send validates that against its own chat (`db/messages.validateComments`),
 * while a session prompt has no row to check.
 */
export function validateCommentsPayload(
  value: unknown,
): MessageComment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("comments must be an array.");
  if (value.length > MAX_COMMENTS_PER_MESSAGE) {
    throw new Error("Too many comments.");
  }
  return value.map((item, index) => validateOneComment(item, index));
}

/** Validate one comment and rebuild it field by field. */
function validateOneComment(value: unknown, index: number): MessageComment {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Comment ${index + 1} is invalid.`);
  }
  const record = value as Record<string, unknown>;
  const note = record["note"];
  if (
    typeof note !== "string" ||
    note.trim().length === 0 ||
    note.length > MAX_COMMENT_NOTE_LENGTH
  ) {
    throw new Error(`Comment ${index + 1} has an invalid note.`);
  }
  const rawAnchor = record["anchor"];
  if (typeof rawAnchor !== "object" || rawAnchor === null) {
    throw new Error(`Comment ${index + 1} has no anchor.`);
  }
  const anchor = rawAnchor as Record<string, unknown>;
  const quote = anchor["quote"];
  if (
    typeof quote !== "string" ||
    quote.trim().length === 0 ||
    quote.length > MAX_COMMENT_QUOTE_LENGTH
  ) {
    throw new Error(`Comment ${index + 1} has an invalid quote.`);
  }
  const target = validateTarget(anchor["target"], index);
  const start = anchor["start"];
  const end = anchor["end"];
  const occurrence = anchor["occurrence"];
  const textLength = anchor["textLength"];
  // `-1` is the quote-only sentinel a recovered prompt anchor uses; any other
  // value must be a coherent span.
  const quoteOnly =
    start === -1 && end === -1 && occurrence === 0 && textLength === -1;
  if (!quoteOnly) {
    if (
      typeof start !== "number" ||
      !Number.isSafeInteger(start) ||
      start < 0
    ) {
      throw new Error(`Comment ${index + 1} has an invalid start offset.`);
    }
    if (typeof end !== "number" || !Number.isSafeInteger(end) || end <= start) {
      throw new Error(`Comment ${index + 1} has an invalid end offset.`);
    }
    if (
      typeof textLength !== "number" ||
      !Number.isSafeInteger(textLength) ||
      textLength < end
    ) {
      throw new Error(`Comment ${index + 1} has an invalid text length.`);
    }
    if (
      typeof occurrence !== "number" ||
      !Number.isSafeInteger(occurrence) ||
      occurrence < 0
    ) {
      throw new Error(`Comment ${index + 1} has an invalid occurrence.`);
    }
  }
  return {
    anchor: {
      target,
      quote,
      start: start as number,
      end: end as number,
      occurrence: occurrence as number,
      textLength: textLength as number,
    },
    note,
  };
}

/** Validate the anchor target: exactly one of a message id / a session entry id. */
function validateTarget(value: unknown, index: number): CommentTarget {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Comment ${index + 1} has no target.`);
  }
  const target = value as Record<string, unknown>;
  const kind = target["kind"];
  if (kind === "message") {
    const messageId = target["messageId"];
    if (
      typeof messageId !== "number" ||
      !Number.isSafeInteger(messageId) ||
      messageId <= 0
    ) {
      throw new Error(`Comment ${index + 1} has an invalid message target.`);
    }
    return { kind: "message", messageId };
  }
  if (kind === "entry") {
    const entryId = target["entryId"];
    if (
      typeof entryId !== "string" ||
      entryId.length === 0 ||
      entryId.length > MAX_ENTRY_ID_LENGTH ||
      /\s/.test(entryId)
    ) {
      throw new Error(`Comment ${index + 1} has an invalid entry target.`);
    }
    return { kind: "entry", entryId };
  }
  throw new Error(`Comment ${index + 1} has an unknown target kind.`);
}
