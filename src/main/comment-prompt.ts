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
 * #3 on image 2 of this message (shot.png)
 * at: point 88.0%, 6.0%
 * note: …
 * ```
 *
 * A record is always three lines: the header, then **either** `quote:` (a
 * passage of text) **or** `at:` (a point/region on a picture), then `note:`.
 * Both kinds share one numbering axis, because the answer contract is `#<n>:`
 * and a second axis would make `#3` ambiguous. The `at:` line is the same
 * geometry the bake replays onto the picture — the picture says *where*, the note
 * says *what* (fact §0: coordinates + mark + words, all three).
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
import {
  MAX_COMMENT_ATTACHMENT_NAME_LENGTH,
  MAX_PROMPT_IMAGE_NAME_LENGTH,
} from "@shared/constants/image-annotation";
import {
  formatMarkAt,
  normalizeImageMark,
  parseMarkAt,
} from "@shared/image-annotation";
import type {
  CommentAnchor,
  CommentTarget,
  ImageMark,
  ImageTargetSource,
  MessageComment,
} from "@shared/types";
import { sanitizePromptField } from "./attachment-prompt";

/** First line of the block `withComments()` appends (and the parser looks for). */
const BLOCK_HEADER = "[Comments]";

/** Longest entry id a `session entry` header may carry (defensive cap). */
const MAX_ENTRY_ID_LENGTH = 64;

/**
 * One recovered image annotation: the picture it belongs to plus its geometry.
 *
 * `attachmentIndex` is the 0-based position in the owner's `attachments` (the
 * block writes it 1-based, like a human counting pictures); `source` is `null`
 * when the block said "this message".
 */
export interface PromptImageTargetView {
  attachmentIndex: number;
  attachmentName: string;
  source: ImageTargetSource | null;
  mark: ImageMark;
}

/** Renderer-facing projection of one recovered comment (display data only). */
export interface PromptCommentView {
  /** The annotated message, when the block named one. */
  messageId?: number;
  /** The annotated session entry, when the block named one. */
  entryId?: string;
  /** Set for an image annotation; then `quote` is empty and vice versa. */
  image?: PromptImageTargetView;
  /** The quoted passage (text annotations only; `""` for images). */
  quote: string;
  note: string;
}

// --- Writing -----------------------------------------------------------------

/** The header line of one comment: its id plus where the annotation sits. */
function formatCommentHeader(ordinal: number, target: CommentTarget): string {
  if (target.kind === "image") {
    // "image 2 of this message (shot.png)": 1-based (a human counts pictures
    // from one) plus the file name, which is what makes the line readable when
    // the message carries several pictures.
    const name = sanitizePromptField(
      target.attachmentName,
      MAX_PROMPT_IMAGE_NAME_LENGTH,
    );
    const where =
      target.source === null
        ? "this message"
        : target.source.kind === "message"
          ? `message #${target.source.messageId}`
          : `session entry ${target.source.entryId}`;
    return `#${ordinal} on image ${target.attachmentIndex + 1} of ${where} (${name})`;
  }
  const where =
    target.kind === "message"
      ? `on message #${target.messageId}`
      : `on session entry ${target.entryId}`;
  return `#${ordinal} ${where}`;
}

/**
 * One comment's three lines. Shared by the writer and the parser's round-trip
 * check so the two can never disagree about the shape.
 *
 * The middle line is `quote:` for a passage or `at:` for a picture — the only
 * thing that differs between the two annotation kinds, which is what keeps the
 * record at three lines (and `splitCommentPrompt()`'s `1 + 3n` shape) sane.
 */
function formatCommentLines(
  ordinal: number,
  anchor: CommentAnchor,
  note: string,
): string {
  const middle =
    anchor.mark !== undefined && anchor.target.kind === "image"
      ? `at: ${formatMarkAt(anchor.mark)}`
      : `quote: ${sanitizePromptField(
          anchor.quote ?? "",
          MAX_PROMPT_COMMENT_QUOTE_LENGTH,
        )}`;
  return [
    formatCommentHeader(ordinal, anchor.target),
    middle,
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
      comment.anchor,
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

/**
 * `#<n> on message #<id>` / `#<n> on session entry <id>` /
 * `#<n> on image <i> of this message (<name>)` /
 * `#<n> on image <i> of message #<id> (<name>)` /
 * `#<n> on image <i> of session entry <id> (<name>)`.
 *
 * The greedy `(.*)` for the name is deliberate: an attachment name may itself
 * contain parentheses, and taking everything up to the final `)` is exactly what
 * the writer produced, so the byte-exact rebuild below still matches.
 */
const HEADER_LINE =
  /^#(\d+) on (?:(?:message #(\d+))|(?:session entry (\S+))|image (\d+) of (?:(this message)|(?:message #(\d+))|(?:session entry (\S+))) \((.*)\))$/;

/** Parse one `at:` line's payload into a mark, or `null` when it is not one. */
function parseAtLine(text: string): ImageMark | null {
  if (!text.startsWith("at: ")) return null;
  return parseMarkAt(text.slice("at: ".length));
}

/** Parse one comment's three lines, or `null` when they are not one of ours. */
function parseCommentLines(
  lines: string[],
  at: number,
): PromptCommentView | null {
  const header = HEADER_LINE.exec(lines[at] ?? "");
  if (header === null) return null;
  const middleLine = lines[at + 1] ?? "";
  const noteLine = lines[at + 2] ?? "";
  if (!noteLine.startsWith("note: ")) return null;
  const note = noteLine.slice("note: ".length);
  if (note.length === 0) return null;
  const imageNumber = header[4];
  if (imageNumber !== undefined) {
    // Picture record: an `at:` middle line, and a 1-based picture number (the
    // block counts pictures the way a human does; the record is 0-based).
    const mark = parseAtLine(middleLine);
    if (mark === null) return null;
    const display = Number(imageNumber);
    if (!Number.isSafeInteger(display) || display <= 0) return null;
    const source = parseHeaderSource(header);
    if (source === undefined) return null;
    const attachmentName = header[8] ?? "";
    if (attachmentName.length === 0) return null;
    return {
      image: { attachmentIndex: display - 1, attachmentName, source, mark },
      quote: "",
      note,
    };
  }
  if (!middleLine.startsWith("quote: ")) return null;
  const quote = middleLine.slice("quote: ".length);
  if (quote.length === 0) return null;
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

/**
 * `null` for "this message", the named row for a picture of an earlier one, and
 * `undefined` when the header's source is unusable.
 */
function parseHeaderSource(
  header: RegExpExecArray,
): ImageTargetSource | null | undefined {
  if (header[5] !== undefined) return null;
  const messageId = header[6];
  if (messageId !== undefined) {
    const value = Number(messageId);
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    return { kind: "message", messageId: value };
  }
  const entryId = header[7];
  if (entryId === undefined || entryId.length > MAX_ENTRY_ID_LENGTH) {
    return undefined;
  }
  return { kind: "entry", entryId };
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
      formatCommentLines(index + 1, viewAnchor(item), item.note),
    ),
  ].join("\n");
  if (rebuilt !== block) return unchanged;
  return { text: body, comments: parsed };
}

/** The anchor one recovered comment rebuilds into (used by the inverse check). */
function viewAnchor(item: PromptCommentView): CommentAnchor {
  if (item.image !== undefined) {
    return {
      target: {
        kind: "image",
        attachmentIndex: item.image.attachmentIndex,
        attachmentName: item.image.attachmentName,
        source: item.image.source,
      },
      mark: item.image.mark,
    };
  }
  return {
    target:
      item.messageId !== undefined
        ? { kind: "message", messageId: item.messageId }
        : { kind: "entry", entryId: item.entryId ?? "" },
    quote: item.quote,
  };
}

/**
 * Rebuild a stored-shaped anchor from a recovered comment, for the renderer's
 * highlight resolution and its image marks.
 *
 * The prompt block carries no offsets (the model does not need them), so a text
 * anchor comes back **quote-only**: the offsets are absent and the anchor must be
 * resolved by searching the target's rendered text (a supported state everywhere
 * — see the `CommentAnchor` doc). An image anchor comes back with its geometry
 * and no pixel size (`0` = unknown): the bake always measures the original file
 * itself, never a value from a prompt.
 */
export function promptCommentToMessageComment(
  comment: PromptCommentView,
): MessageComment {
  if (comment.image !== undefined) {
    return {
      anchor: {
        target: {
          kind: "image",
          attachmentIndex: comment.image.attachmentIndex,
          attachmentName: comment.image.attachmentName,
          source: comment.image.source,
        },
        mark: comment.image.mark,
      },
      note: comment.note,
    };
  }
  const target: CommentTarget =
    comment.messageId !== undefined
      ? { kind: "message", messageId: comment.messageId }
      : { kind: "entry", entryId: comment.entryId ?? "" };
  const anchor: CommentAnchor = { target, quote: comment.quote };
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
  const target = validateTarget(anchor["target"], index);
  // Two annotation kinds, told apart by the target: a picture carries geometry
  // and no text, a passage carries text and no geometry. Anything mixing the two
  // is a bug in the caller, not a shape we can interpret.
  if (target.kind === "image") {
    if (anchor["mark"] === undefined) {
      throw new Error(`Comment ${index + 1} has no image mark.`);
    }
    const mark = normalizeImageMark(anchor["mark"]);
    if (mark === null) {
      throw new Error(`Comment ${index + 1} has an invalid image mark.`);
    }
    if (anchor["quote"] !== undefined) {
      throw new Error(
        `Comment ${index + 1} annotates both a picture and text.`,
      );
    }
    return { anchor: { target, mark }, note };
  }
  const quote = anchor["quote"];
  if (
    typeof quote !== "string" ||
    quote.trim().length === 0 ||
    quote.length > MAX_COMMENT_QUOTE_LENGTH
  ) {
    throw new Error(`Comment ${index + 1} has an invalid quote.`);
  }
  if (anchor["mark"] !== undefined) {
    throw new Error(`Comment ${index + 1} annotates both a picture and text.`);
  }
  const start = anchor["start"];
  const end = anchor["end"];
  const occurrence = anchor["occurrence"];
  const textLength = anchor["textLength"];
  // No offsets at all (a prompt-recovered anchor) and the legacy `-1` sentinel
  // both mean "quote-only": such an anchor is always resolved by searching the
  // quote inside the named target. Any other value must be a coherent span.
  const quoteOnly =
    (start === undefined &&
      end === undefined &&
      occurrence === undefined &&
      textLength === undefined) ||
    (start === -1 && end === -1 && occurrence === 0 && textLength === -1);
  if (quoteOnly) {
    return { anchor: { target, quote }, note };
  }
  if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0) {
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
  return {
    anchor: { target, quote, start, end, occurrence, textLength },
    note,
  };
}

/** Validate the anchor target: exactly one of a message / entry / image subject. */
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
  if (kind === "image") {
    return validateImageTarget(target, index);
  }
  throw new Error(`Comment ${index + 1} has an unknown target kind.`);
}

/** Validate the picture an image annotation points at. */
function validateImageTarget(
  target: Record<string, unknown>,
  index: number,
): CommentTarget {
  const attachmentIndex = target["attachmentIndex"];
  if (
    typeof attachmentIndex !== "number" ||
    !Number.isSafeInteger(attachmentIndex) ||
    attachmentIndex < 0
  ) {
    throw new Error(`Comment ${index + 1} has an invalid image attachment.`);
  }
  const attachmentName = target["attachmentName"];
  if (
    typeof attachmentName !== "string" ||
    attachmentName.length === 0 ||
    attachmentName.length > MAX_COMMENT_ATTACHMENT_NAME_LENGTH ||
    /\s{2,}|[\r\n]/.test(attachmentName)
  ) {
    throw new Error(`Comment ${index + 1} has an invalid image name.`);
  }
  const raw = target["source"];
  if (raw === null) {
    return { kind: "image", attachmentIndex, attachmentName, source: null };
  }
  if (typeof raw !== "object") {
    throw new Error(`Comment ${index + 1} has an invalid image source.`);
  }
  const source = raw as Record<string, unknown>;
  if (source["kind"] === "message") {
    const messageId = source["messageId"];
    if (
      typeof messageId !== "number" ||
      !Number.isSafeInteger(messageId) ||
      messageId <= 0
    ) {
      throw new Error(`Comment ${index + 1} has an invalid image source.`);
    }
    return {
      kind: "image",
      attachmentIndex,
      attachmentName,
      source: { kind: "message", messageId },
    };
  }
  const entryId = source["entryId"];
  if (
    typeof entryId !== "string" ||
    entryId.length === 0 ||
    entryId.length > MAX_ENTRY_ID_LENGTH ||
    /\s/.test(entryId)
  ) {
    throw new Error(`Comment ${index + 1} has an invalid image source.`);
  }
  return {
    kind: "image",
    attachmentIndex,
    attachmentName,
    source: { kind: "entry", entryId },
  };
}
