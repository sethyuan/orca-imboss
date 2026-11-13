import type {
  CommentAnchor,
  CommentTarget,
  ImageGenStatus,
  ImageTargetSource,
  MessageAttachment,
  MessageComment,
  MessageStep,
  StepStatus,
} from "@shared/types";
import {
  MAX_COMMENT_NOTE_LENGTH,
  MAX_COMMENT_QUOTE_LENGTH,
  MAX_COMMENTS_PER_MESSAGE,
} from "@shared/constants/comments";
import { MAX_COMMENT_ATTACHMENT_NAME_LENGTH } from "@shared/constants/image-annotation";
import { normalizeImageMark } from "@shared/image-annotation";
import { parseJsonObject } from "./json";

/**
 * Read helpers for the `messages` table's JSON payload columns (`steps`,
 * `attachments`, `image_status`).
 *
 * Extracted from the message store so the chat-summary query can read the same
 * payloads the same way without importing the whole store (which would create
 * an import cycle). Stored values are never trusted: every parser validates
 * field by field, drops what it cannot understand, and never throws.
 */

/** Step statuses a stored step may carry, in progress order. */
export const STEP_STATUSES: readonly StepStatus[] = ["done", "busy", "pending"];

/** Sanity cap for a stored attachment path (mirrors the write-side limit). */
export const MAX_ATTACH_PATH_LENGTH = 4096;

/** Lifecycle values a stored `image_status` may carry. */
const IMAGE_STATUSES: readonly ImageGenStatus[] = [
  "generating",
  "done",
  "error",
];

/**
 * Read the optional linked group chat id stored alongside the step list.
 * Stored values are never trusted: only a safe positive integer surfaces,
 * anything else (including absence) becomes `null`.
 */
export function parseGroupChatId(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = parseJsonObject(raw);
  const id = parsed["chatId"];
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

export function parseSteps(raw: string | null): MessageStep[] | null {
  if (!raw) return null;
  const parsed = parseJsonObject(raw);
  const steps = parsed["steps"];
  if (!Array.isArray(steps)) return null;
  const result: MessageStep[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const record = step as Record<string, unknown>;
    // `task` superseded the old `role` field. Cards published before the rename
    // still carry the employee's role there, so fall back to it on read — the
    // write path (`validateSteps`) only ever produces `task`.
    const task = record["task"] ?? record["role"];
    if (
      typeof record["name"] !== "string" ||
      typeof task !== "string" ||
      !STEP_STATUSES.includes(record["status"] as StepStatus)
    ) {
      continue;
    }
    result.push({
      name: record["name"],
      task,
      status: record["status"] as StepStatus,
      employeeId:
        typeof record["employeeId"] === "number" &&
        Number.isSafeInteger(record["employeeId"]) &&
        record["employeeId"] >= 0
          ? record["employeeId"]
          : null,
    });
  }
  return result;
}

/**
 * Parse a stored attachments JSON. Stored values are never trusted: entries
 * are validated field by field and invalid ones dropped; `null` is stored as
 * null and only ever surfaces as `[]` when the column held a valid array.
 */
export function parseAttachments(
  raw: string | null,
): MessageAttachment[] | null {
  if (!raw) return null;
  const parsed = parseJsonObject(raw);
  const list = parsed["attachments"];
  if (!Array.isArray(list)) return null;
  const result: MessageAttachment[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record["name"] !== "string" || record["name"].length === 0) {
      continue;
    }
    const path = record["path"];
    const kind = record["kind"];
    const chatId = record["chatId"];
    const parsedKind =
      kind === "file" || kind === "folder" || kind === "chat"
        ? kind
        : undefined;
    result.push({
      name: record["name"],
      size: typeof record["size"] === "number" ? record["size"] : 0,
      type: typeof record["type"] === "string" ? record["type"] : "",
      ...(typeof path === "string" &&
      path.length > 0 &&
      path.length <= MAX_ATTACH_PATH_LENGTH
        ? { path }
        : {}),
      ...(parsedKind ? { kind: parsedKind } : {}),
      ...(parsedKind === "chat" &&
      typeof chatId === "number" &&
      Number.isSafeInteger(chatId) &&
      chatId > 0
        ? { chatId }
        : {}),
    });
  }
  return result;
}

/**
 * Read the optional true attachment `total` stored alongside an attachments
 * payload. Returns `null` when absent or invalid; the caller falls back to the
 * number of rows actually stored.
 */
export function parseAttachmentTotal(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = parseJsonObject(raw);
  const total = parsed["total"];
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    return null;
  }
  return total;
}

/** Coerce a stored `image_status` to a known lifecycle value, else `null`. */
export function parseImageStatus(raw: string | null): ImageGenStatus | null {
  if (!raw) return null;
  return IMAGE_STATUSES.includes(raw as ImageGenStatus)
    ? (raw as ImageGenStatus)
    : null;
}

/** Longest session entry id a stored anchor may name (mirrors the write side). */
const MAX_COMMENT_ENTRY_ID_LENGTH = 64;

/**
 * Parse a stored comments JSON (`{"comments":[…]}`). Stored values are never
 * trusted: every field is validated and anything invalid drops **the whole
 * list** — a comment whose anchor cannot be rebuilt would otherwise render a
 * quote pointing at the wrong place, which is worse than showing nothing.
 *
 * Returns `null` when the column is empty or holds no usable list.
 */
export function parseComments(raw: string | null): MessageComment[] | null {
  if (!raw) return null;
  const parsed = parseJsonObject(raw);
  const list = parsed["comments"];
  if (!Array.isArray(list) || list.length === 0) return null;
  if (list.length > MAX_COMMENTS_PER_MESSAGE) return null;
  const result: MessageComment[] = [];
  for (const item of list) {
    const comment = parseOneComment(item);
    if (comment === null) return null;
    result.push(comment);
  }
  return result;
}

/** Parse one stored comment, or `null` when any field is unusable. */
function parseOneComment(value: unknown): MessageComment | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const note = record["note"];
  if (
    typeof note !== "string" ||
    note.trim().length === 0 ||
    note.length > MAX_COMMENT_NOTE_LENGTH
  ) {
    return null;
  }
  const anchorRecord = record["anchor"];
  if (typeof anchorRecord !== "object" || anchorRecord === null) return null;
  const raw = anchorRecord as Record<string, unknown>;
  const target = parseCommentTarget(raw["target"]);
  if (target === null) return null;
  // An image annotation carries geometry and no text at all; everything else is
  // a passage annotation (which may be quote-only, see below).
  if (target.kind === "image") {
    if (raw["quote"] !== undefined) return null;
    const mark = normalizeImageMark(raw["mark"]);
    if (mark === null) return null;
    return { anchor: { target, mark }, note };
  }
  if (raw["mark"] !== undefined) return null;
  const quote = raw["quote"];
  if (
    typeof quote !== "string" ||
    quote.trim().length === 0 ||
    quote.length > MAX_COMMENT_QUOTE_LENGTH
  ) {
    return null;
  }
  const start = raw["start"];
  const end = raw["end"];
  const occurrence = raw["occurrence"];
  const textLength = raw["textLength"];
  // No offsets at all (the shape a prompt-recovered anchor has) and the legacy
  // `-1` sentinel both mean "quote-only": resolved by searching the quote.
  if (
    start === undefined &&
    end === undefined &&
    occurrence === undefined &&
    textLength === undefined
  ) {
    return { anchor: { target, quote }, note };
  }
  const quoteOnly =
    start === -1 && end === -1 && occurrence === 0 && textLength === -1;
  if (!quoteOnly) {
    if (!isSafeInt(start) || start < 0) return null;
    if (!isSafeInt(end) || end <= start) return null;
    if (!isSafeInt(textLength) || textLength < end) return null;
    if (!isSafeInt(occurrence) || occurrence < 0) return null;
  }
  const anchor: CommentAnchor = {
    target,
    quote,
    start: start as number,
    end: end as number,
    occurrence: occurrence as number,
    textLength: textLength as number,
  };
  return { anchor, note };
}

/** Parse one anchor target (exactly one of the three shapes). */
function parseCommentTarget(value: unknown): CommentTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["kind"] === "message") {
    const messageId = record["messageId"];
    if (!isSafeInt(messageId) || messageId <= 0) return null;
    return { kind: "message", messageId };
  }
  if (record["kind"] === "entry") {
    const entryId = record["entryId"];
    if (
      typeof entryId !== "string" ||
      entryId.length === 0 ||
      entryId.length > MAX_COMMENT_ENTRY_ID_LENGTH ||
      /\s/.test(entryId)
    ) {
      return null;
    }
    return { kind: "entry", entryId };
  }
  if (record["kind"] === "image") {
    return parseImageTarget(record);
  }
  return null;
}

/** Parse the picture an image annotation points at. */
function parseImageTarget(
  record: Record<string, unknown>,
): CommentTarget | null {
  const attachmentIndex = record["attachmentIndex"];
  if (!isSafeInt(attachmentIndex) || attachmentIndex < 0) return null;
  const attachmentName = record["attachmentName"];
  if (
    typeof attachmentName !== "string" ||
    attachmentName.length === 0 ||
    attachmentName.length > MAX_COMMENT_ATTACHMENT_NAME_LENGTH ||
    /\s{2,}|[\r\n]/.test(attachmentName)
  ) {
    return null;
  }
  const raw = record["source"];
  if (raw === null) {
    return { kind: "image", attachmentIndex, attachmentName, source: null };
  }
  const source = parseImageSource(raw);
  if (source === null) return null;
  return { kind: "image", attachmentIndex, attachmentName, source };
}

/** Parse the "where does that picture live" half of an image target. */
function parseImageSource(value: unknown): ImageTargetSource | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record["kind"] === "message") {
    const messageId = record["messageId"];
    if (!isSafeInt(messageId) || messageId <= 0) return null;
    return { kind: "message", messageId };
  }
  if (record["kind"] === "entry") {
    const entryId = record["entryId"];
    if (
      typeof entryId !== "string" ||
      entryId.length === 0 ||
      entryId.length > MAX_COMMENT_ENTRY_ID_LENGTH ||
      /\s/.test(entryId)
    ) {
      return null;
    }
    return { kind: "entry", entryId };
  }
  return null;
}

/** `true` for a non-negative safe integer. */
function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
