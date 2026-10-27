import type {
  ChatPreview,
  ImageGenStatus,
  MessageAttachment,
  MessageKind,
  MessageStep,
} from "./types";

/**
 * Per-kind extraction of a message's human-readable content, shared by the
 * chat list (`ChatSummary.preview`) and message search (excerpts).
 *
 * This module is **presentation-free on purpose**: it turns a structured card
 * payload into plain fragments and never localizes, truncates for the UI, or
 * adds separators. The renderer turns the result into the actual one-line
 * description (`src/renderer/components/modules/chat/preview-text.ts`), which
 * is what keeps a live language switch working. Search reuses the same
 * fragments so both surfaces describe a card the same way.
 *
 * Defensive rules (a preview is a teaser and must never break a list):
 * - a payload that fails to parse degrades to the raw `content`;
 * - an unknown/legacy/new kind degrades to `text` treatment;
 * - hostile or absurd payloads are bounded (fragment count and length).
 */

/**
 * Cap of `ChatPreview.text`. Anything longer is cut here rather than in SQL:
 * the whole point is to stop a multi-kilobyte message from crossing IPC as a
 * one-line teaser (the raw `content` column stays untouched).
 */
export const PREVIEW_TEXT_MAX = 200;

/** Cap of the long-form body used for search excerpts. */
const PREVIEW_BODY_MAX = 4_000;

/** Cap of one extracted fragment; a single question/step can be long. */
const FRAGMENT_MAX = 1_000;

/** Cap of how many fragments are extracted from one payload. */
const MAX_FRAGMENTS = 32;

/** `ask` content: `{ questions: [{ id, text, type?, options? }] }`. */
interface AskQuestion {
  text: string;
  options: string[];
}

/**
 * `answer` content:
 * `{ askMessageId?, answers: [{ questionId, selected?, text? }], supplement? }`.
 * `supplement` holds the card-level notes the boss wrote beyond the questions.
 */
interface AnswerItem {
  text: string;
  selected: string[];
}

/** What a single message contributes to its teaser. */
interface Extraction {
  kind: MessageKind;
  /**
   * Primary display text, empty when the kind describes itself by its counters
   * (`ask`/`answer`) or by a link (`chat`) instead of by a body.
   */
  text: string;
  /** Every readable fragment in reading order, for search excerpts. */
  fragments: string[];
  questionCount?: number;
  answerCount?: number;
  stepsDone?: number;
  stepsTotal?: number;
  linkChatId?: number;
  linkChatTitle?: string | null;
  imageStatus?: ImageGenStatus;
  attachmentCount?: number;
}

/** Everything the extractor needs from a message row. */
export interface ChatPreviewSource {
  kind: MessageKind;
  content: string;
  steps?: MessageStep[] | null;
  attachments?: MessageAttachment[] | null;
  /** True attachment count; may exceed `attachments.length`. */
  attachmentsTotal?: number | null;
  imageStatus?: ImageGenStatus | null;
  /**
   * Title lookup for a `chat` link card: `null` = the conversation is gone,
   * `""` = it exists without a title. Omit when no lookup is available.
   */
  resolveChatTitle?: (chatId: number) => string | null;
}

/**
 * Extract the preview of one message, or `null` when there is nothing worth
 * showing (an empty payload with no link, counters, or attachments).
 */
export function buildChatPreview(
  source: ChatPreviewSource,
): ChatPreview | null {
  const extraction = extract(source);
  const text = clamp(extraction.text, PREVIEW_TEXT_MAX);
  const attachments = extraction.attachmentCount;

  // Something has to describe the message: a body, a linked conversation, the
  // counters of a card, or at least an attachment to mention.
  const describes =
    text.length > 0 ||
    extraction.linkChatId !== undefined ||
    extraction.questionCount !== undefined ||
    extraction.answerCount !== undefined ||
    extraction.stepsTotal !== undefined;
  if (!describes && attachments === undefined) return null;

  return {
    kind: extraction.kind,
    text,
    ...(extraction.questionCount !== undefined
      ? { questionCount: extraction.questionCount }
      : {}),
    ...(extraction.answerCount !== undefined
      ? { answerCount: extraction.answerCount }
      : {}),
    ...(extraction.stepsDone !== undefined
      ? { stepsDone: extraction.stepsDone }
      : {}),
    ...(extraction.stepsTotal !== undefined
      ? { stepsTotal: extraction.stepsTotal }
      : {}),
    ...(extraction.linkChatId !== undefined
      ? { linkChatId: extraction.linkChatId }
      : {}),
    ...(extraction.linkChatTitle !== undefined
      ? { linkChatTitle: extraction.linkChatTitle }
      : {}),
    ...(extraction.imageStatus !== undefined
      ? { imageStatus: extraction.imageStatus }
      : {}),
    ...(attachments !== undefined ? { attachmentCount: attachments } : {}),
  };
}

/**
 * Every readable fragment of a message joined into one searchable body, used
 * for search excerpts. Unlike `ChatPreview.text` this keeps *all* questions,
 * options, answers and steps, so a match anywhere in the payload can be
 * excerpted from readable text instead of raw JSON.
 */
export function chatPreviewBodyText(source: ChatPreviewSource): string {
  const extraction = extract(source);
  const body = extraction.fragments
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0)
    .join(" ");
  return clamp(body, PREVIEW_BODY_MAX);
}

function extract(source: ChatPreviewSource): Extraction {
  const kind =
    typeof source.kind === "string" && source.kind.length > 0
      ? source.kind
      : "text";
  const content = typeof source.content === "string" ? source.content : "";
  const base: Extraction = { kind, text: "", fragments: [] };
  const attachmentCount = attachmentTotal(source);
  if (attachmentCount !== undefined) base.attachmentCount = attachmentCount;
  const extracted = extractByKind(kind, content, source);
  return {
    ...base,
    ...extracted,
    text: extracted.text ?? "",
    fragments: bounded(extracted.fragments ?? []),
  };
}

function extractByKind(
  kind: MessageKind,
  content: string,
  source: ChatPreviewSource,
): Partial<Extraction> {
  switch (kind) {
    case "ask":
      return extractAsk(content);
    case "answer":
      return extractAnswer(content);
    case "progress":
      return extractProgress(content, source.steps);
    case "chat":
      return extractChatLink(content, source.resolveChatTitle);
    case "image":
      return {
        text: content,
        fragments: fragmentsOf(content),
        ...(isImageStatus(source.imageStatus)
          ? { imageStatus: source.imageStatus }
          : {}),
      };
    default:
      // `text`, `report` and every kind we do not know yet: the body is the
      // message itself, exactly as it reads in the thread.
      return { text: content, fragments: fragmentsOf(content) };
  }
}

function extractAsk(content: string): Partial<Extraction> {
  // An unreadable payload degrades to the stored bytes, which is also the only
  // case where the list shows a question's text at all (no count to show).
  const unparsed = { text: content, fragments: fragmentsOf(content) };
  const payload = parseJsonObject(content);
  const raw = payload === null ? null : payload["questions"];
  if (!Array.isArray(raw)) return unparsed;
  const questions: AskQuestion[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null) continue;
    const text = typeof record["text"] === "string" ? record["text"] : "";
    const options = Array.isArray(record["options"])
      ? record["options"].filter((option): option is string => {
          return typeof option === "string";
        })
      : [];
    if (text.trim().length === 0 && options.length === 0) continue;
    questions.push({ text, options });
  }
  if (questions.length === 0) return unparsed;
  // The list describes the card by its question count alone, so no text is
  // extracted for display; every question and option still feeds the
  // searchable body (a hit inside the payload must excerpt readable text).
  return {
    text: "",
    fragments: [
      ...questions.map((question) => question.text),
      ...questions.flatMap((question) => question.options),
    ],
    questionCount: questions.length,
  };
}

function extractAnswer(content: string): Partial<Extraction> {
  const unparsed = { text: content, fragments: fragmentsOf(content) };
  const payload = parseJsonObject(content);
  const raw = payload === null ? null : payload["answers"];
  if (!Array.isArray(raw)) return unparsed;
  const answers: AnswerItem[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    if (record === null) continue;
    const selected = Array.isArray(record["selected"])
      ? record["selected"].filter((value): value is string => {
          return typeof value === "string" && value.length > 0;
        })
      : [];
    const text =
      typeof record["text"] === "string" && record["text"].trim().length > 0
        ? record["text"]
        : "";
    if (selected.length === 0 && text.length === 0) continue;
    answers.push({ text, selected });
  }
  // The card-level "additional notes" (`supplement`) answer no question, so they
  // never count as answers — but they are readable content and must be
  // searchable like everything else the boss wrote.
  const supplement = readSupplement(
    payload === null ? null : payload["supplement"],
  );
  if (answers.length === 0 && supplement.length === 0) return unparsed;
  if (answers.length === 0) {
    // Notes only: there is no answer to count, so the teaser falls back to the
    // "Answer: <text>" form with the notes themselves (see `preview-text.ts`).
    return { text: supplement, fragments: [supplement] };
  }
  // Same as `ask`: the count is the teaser, the answers only feed search.
  return {
    text: "",
    fragments: [
      ...answers.map((answer) => answerText(answer)),
      ...(supplement.length > 0 ? [supplement] : []),
    ],
    answerCount: answers.length,
  };
}

/** Defensive read of an `answer` payload's note field: a trimmed string or `""`. */
function readSupplement(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * One answer rendered as text: the chosen option(s), else the free-form answer.
 * Joined with ", " like the thread's answer card does (not localized here).
 */
function answerText(answer: AnswerItem): string {
  if (answer.selected.length > 0) return answer.selected.join(", ");
  return answer.text;
}

function extractProgress(
  content: string,
  steps: MessageStep[] | null | undefined,
): Partial<Extraction> {
  const list = Array.isArray(steps) ? steps.filter(isStep) : [];
  // The card title is the teaser; step names/tasks stay in the searchable body.
  const fragments = [
    content,
    ...list.map((step) => `${step.name} ${step.task}`),
  ];
  if (list.length === 0) return { text: content, fragments };
  return {
    text: content,
    fragments,
    stepsTotal: list.length,
    stepsDone: list.filter((step) => step.status === "done").length,
  };
}

function extractChatLink(
  content: string,
  resolveChatTitle?: (chatId: number) => string | null,
): Partial<Extraction> {
  const chatId = Number(content.trim());
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    // Not a link we can describe: fall back to the stored bytes.
    return { text: content, fragments: fragmentsOf(content) };
  }
  // `undefined` (no resolver supplied) is as good as "cannot resolve".
  const title = resolveChatTitle ? resolveChatTitle(chatId) : null;
  const fragments = title !== null && title.trim().length > 0 ? [title] : [];
  return {
    text: fragments[0] ?? "",
    fragments,
    linkChatId: chatId,
    linkChatTitle: title,
  };
}

/** Fragments of a plain body (Markdown source; the renderer flattens it). */
function fragmentsOf(content: string): string[] {
  const trimmed = content.trim();
  return trimmed.length > 0 ? [trimmed] : [];
}

/** True attachment count: the recorded total when it exceeds the stored rows. */
function attachmentTotal(source: ChatPreviewSource): number | undefined {
  const stored = Array.isArray(source.attachments)
    ? source.attachments.length
    : 0;
  const total =
    typeof source.attachmentsTotal === "number" &&
    Number.isSafeInteger(source.attachmentsTotal) &&
    source.attachmentsTotal > 0
      ? source.attachmentsTotal
      : 0;
  const count = Math.max(stored, total);
  return count > 0 ? count : undefined;
}

function isImageStatus(value: unknown): value is ImageGenStatus {
  return value === "generating" || value === "done" || value === "error";
}

function isStep(value: unknown): value is MessageStep {
  const record = asRecord(value);
  if (record === null) return false;
  const status = record["status"];
  return (
    typeof record["name"] === "string" &&
    typeof record["task"] === "string" &&
    (status === "done" || status === "busy" || status === "pending")
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Defensive parse: a malformed payload returns `null`, never throws. */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (raw.length === 0) return null;
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** Cut a fragment to a bounded length without splitting a surrogate pair. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  // A high surrogate at the very end would render as a replacement character.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Bound the number and length of extracted fragments. */
function bounded(fragments: string[]): string[] {
  return fragments.slice(0, MAX_FRAGMENTS).map((f) => clamp(f, FRAGMENT_MAX));
}
