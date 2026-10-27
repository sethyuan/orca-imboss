/**
 * Drafts of the interactive ask cards (`kind: "ask"`), kept **outside** the React
 * tree so they survive the unmount that a page or chat switch causes.
 *
 * Why a plain module-scoped `Map` and not `appStore` (where composer drafts
 * live): the card is the only reader, so a keystroke must never notify
 * `useSnapshot(appStore)` subscribers (App, AppShell, ChatModule…). The same
 * reasoning as `chatScrollStore` / `sessionScrollStore` in the modules.
 *
 * Session-only, like `chatDrafts`: the draft is gone when the app exits.
 *
 * Keyed by the ask **message** id (globally unique row id, stable across
 * reloads); `chatId` rides along so a deleted conversation can drop its drafts
 * (chat deletion cascades over messages).
 *
 * The draft also carries the files the boss attached to this answer. Their
 * on-disk copies (a pasted screenshot has no file of its own) are owned by the
 * draft until it is consumed, so every path that drops a draft has to decide
 * whether the files are now referenced by a message (submit) or garbage
 * (removal / eviction / deleted conversation) — see `clearAskDraft`.
 */
import { MAX_ANSWER_SUPPLEMENT_LENGTH } from "@shared/constants/ask";
import {
  discardPendingAttachments,
  revokePendingAttachment,
} from "./attachment-pick";
import type { PendingAttachment } from "./chat-draft";

/** Retained input of one ask card that has not been submitted yet. */
export interface AskDraft {
  /** Conversation the ask message belongs to (cleanup scope only). */
  chatId: number;
  /** Chosen options per question id (single and multiple). */
  selected: Record<string, string[]>;
  /** Free-form text per question id (a `free` question or a "Other" field). */
  text: Record<string, string>;
  /**
   * The card's "additional notes" field: instructions beyond the questions,
   * keyed to the card as a whole (never to a question id). Empty when the boss
   * wrote none.
   */
  supplement: string;
  /** Files the boss attached to this answer, in the order they were added. */
  attachments: PendingAttachment[];
  /** Epoch ms of the last edit; oldest entries are evicted first. */
  updatedAt: number;
}

/**
 * Per-question text cap. The main process already rejects oversized answers;
 * this only keeps one pasted blob from living in memory forever.
 */
const MAX_TEXT_LENGTH = 10_000;

/** Upper bound for the number of retained drafts (defensive, LRU eviction). */
const MAX_DRAFTS = 200;

const drafts = new Map<number, AskDraft>();

/** Whether `value` can be a message id (defensive: IPC/derived values). */
function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Normalise a question id; anything else means "not usable". */
function normalizeQuestionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

/**
 * Read a draft for in-card rendering.
 *
 * The returned object is shared, not copied: callers must treat it as
 * read-only and go through the setters below to change it.
 */
export function readAskDraft(messageId: number): AskDraft | undefined {
  if (!isId(messageId)) return undefined;
  return drafts.get(messageId);
}

/**
 * Drop one draft.
 *
 * `keepFiles: true` is for the submit path: the answer message now references
 * those attachments, so only the thumbnail URLs are released. Everywhere else
 * (the boss removed the card's contents, the chat is gone, the entry was
 * evicted) the files are unreferenced and get deleted along with the URLs.
 */
export function clearAskDraft(
  messageId: number,
  options: { keepFiles?: boolean } = {},
): void {
  if (!isId(messageId)) return;
  const draft = drafts.get(messageId);
  drafts.delete(messageId);
  if (!draft) return;
  if (options.keepFiles === true) {
    for (const item of draft.attachments) revokePendingAttachment(item);
    return;
  }
  discardPendingAttachments(draft.attachments);
}

/** Drop every draft of one conversation (conversation deleted). */
export function clearAskDraftsForChat(chatId: number): void {
  if (!isId(chatId)) return;
  for (const [messageId, draft] of [...drafts]) {
    if (draft.chatId === chatId) {
      drafts.delete(messageId);
      discardPendingAttachments(draft.attachments);
    }
  }
}

/**
 * Replace this draft's attachment list.
 *
 * The card owns the cap (it needs to show a warning), so this stays a plain
 * assignment — but any chip that falls out of the list is discarded here, so a
 * caller can never leak a thumbnail URL or orphan a pasted file by forgetting.
 */
export function setAskDraftAttachments(
  messageId: number,
  chatId: number,
  attachments: readonly PendingAttachment[],
): void {
  const draft = ensureDraft(messageId, chatId);
  if (!draft) return;
  const kept = new Set(attachments.map((item) => item.id));
  const dropped = draft.attachments.filter((item) => !kept.has(item.id));
  draft.attachments = [...attachments];
  discardPendingAttachments(dropped);
  commit(messageId, draft);
}

/**
 * Remove one chip (by its stable id, not its index: a concurrent add cannot
 * shift the target) and discard what it owned.
 */
export function removeAskDraftAttachment(
  messageId: number,
  chatId: number,
  id: number,
): void {
  const draft = drafts.get(messageId);
  if (!draft || draft.chatId !== chatId) return;
  const index = draft.attachments.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [removed] = draft.attachments.splice(index, 1);
  // The chip is no longer referenced: drop its thumbnail URL and its pasted file.
  if (removed) discardPendingAttachments([removed]);
  commit(messageId, draft);
}

/** Record the chosen options of one question (an empty list clears it). */
export function setAskDraftSelection(
  messageId: number,
  chatId: number,
  questionId: string,
  selected: readonly string[],
): void {
  const draft = ensureDraft(messageId, chatId);
  const question = normalizeQuestionId(questionId);
  if (!draft || question === null) return;
  const options = selected.filter(
    (option): option is string => typeof option === "string",
  );
  if (options.length === 0) {
    delete draft.selected[question];
  } else {
    draft.selected[question] = [...options];
  }
  commit(messageId, draft);
}

/** Record the free-form text of one question (an empty string clears it). */
export function setAskDraftText(
  messageId: number,
  chatId: number,
  questionId: string,
  text: string,
): void {
  const draft = ensureDraft(messageId, chatId);
  const question = normalizeQuestionId(questionId);
  if (!draft || question === null) return;
  if (typeof text !== "string" || text.length === 0) {
    delete draft.text[question];
  } else {
    draft.text[question] = text.slice(0, MAX_TEXT_LENGTH);
  }
  commit(messageId, draft);
}

/**
 * Record the card's "additional notes" text (an empty string clears it).
 *
 * Not keyed by question id: the field belongs to the whole card, so it survives
 * `pruneAskDraft` (which only drops entries of questions that no longer exist)
 * and is capped like a per-question text so one pasted blob cannot live in
 * memory forever.
 */
export function setAskDraftSupplement(
  messageId: number,
  chatId: number,
  text: string,
): void {
  const draft = ensureDraft(messageId, chatId);
  if (!draft) return;
  if (typeof text !== "string" || text.length === 0) {
    draft.supplement = "";
  } else {
    draft.supplement = text.slice(0, MAX_ANSWER_SUPPLEMENT_LENGTH);
  }
  commit(messageId, draft);
}

/**
 * Drop the entries of questions that no longer exist in the ask payload (the
 * card was re-rendered from a changed/chunked question set). A no-op when the
 * draft only holds current questions.
 */
export function pruneAskDraft(
  messageId: number,
  validQuestionIds: ReadonlySet<string>,
): void {
  const draft = readAskDraft(messageId);
  if (!draft) return;
  let changed = false;
  for (const question of Object.keys(draft.selected)) {
    if (validQuestionIds.has(question)) continue;
    delete draft.selected[question];
    changed = true;
  }
  for (const question of Object.keys(draft.text)) {
    if (validQuestionIds.has(question)) continue;
    delete draft.text[question];
    changed = true;
  }
  if (!changed) return;
  if (isEmpty(draft)) {
    clearAskDraft(messageId);
    return;
  }
  commit(messageId, draft);
}

/** Allocate an empty draft for a valid (message, chat) pair on demand. */
function ensureDraft(messageId: number, chatId: number): AskDraft | undefined {
  if (!isId(messageId) || !isId(chatId)) return undefined;
  let draft = drafts.get(messageId);
  if (!draft) {
    draft = {
      chatId,
      selected: {},
      text: {},
      supplement: "",
      attachments: [],
      updatedAt: Date.now(),
    };
    drafts.set(messageId, draft);
  }
  return draft;
}

/**
 * Finish a mutation: stamp it, drop a draft that carries nothing any more (so an
 * emptied card leaves no residue), and keep the map bounded.
 */
function commit(messageId: number, draft: AskDraft): void {
  draft.updatedAt = Date.now();
  if (isEmpty(draft)) {
    drafts.delete(messageId);
    return;
  }
  evictOverflow();
}

function isEmpty(draft: AskDraft): boolean {
  return (
    Object.keys(draft.selected).length === 0 &&
    Object.keys(draft.text).length === 0 &&
    // A note-only draft is content: dropping it would lose what the boss typed
    // in the "additional notes" field on any page/chat switch.
    draft.supplement.length === 0 &&
    draft.attachments.length === 0
  );
}

/** Evict the least recently edited drafts once the map exceeds its bound. */
function evictOverflow(): void {
  if (drafts.size <= MAX_DRAFTS) return;
  const ordered = [...drafts].sort(
    ([, left], [, right]) => left.updatedAt - right.updatedAt,
  );
  for (const [messageId, draft] of ordered.slice(0, drafts.size - MAX_DRAFTS)) {
    drafts.delete(messageId);
    // An evicted draft's pasted files are unreferenced: delete them.
    discardPendingAttachments(draft.attachments);
  }
}
