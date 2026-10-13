import { ASSISTANT_ID } from "@shared/constants/employees";
import { getChat, updateChatTitle } from "../db/chats";
import { getEmployee } from "../db/employees";
import { sendToRenderer } from "../notifications";
import { getModelRuntime, resolveModel } from "./model-runtime";

/**
 * Auto-title generation for untitled chats.
 *
 * When the first user message of a chat is processed (`chat:send`) and the
 * chat has no title yet, a one-shot completion proposes a short title from
 * that message. If generation fails or returns empty, falls back to a snippet
 * of the user message so chats never linger untitled.
 *
 * A per-chat in-flight set prevents duplicate runs when the user sends a
 * burst of messages before the first generation resolves.
 */

/** Generation is aborted after this long so a hung provider cannot pin the guard. */
const TITLE_TIMEOUT_MS = 20_000;

/** Upper bound for a generated title (matches `updateChatTitle`'s DB limit). */
const MAX_TITLE_LENGTH = 200;

/** Chats with a generation currently in flight (by chat id). */
const inFlight = new Set<number>();

/** Longest slice of the user message embedded in the title prompt. */
const MAX_PROMPT_MESSAGE_CHARS = 2_000;

/**
 * Generate and store a title for `chatId` from `userMessage` when the chat
 * is untitled. Fire-and-forget: returns immediately, never rejects.
 */
export function maybeGenerateChatTitle(
  chatId: number,
  userMessage: string,
): void {
  const chat = getChat(chatId);
  if (!chat) return;
  if (chat.title.trim().length > 0) return;
  const message = userMessage.trim();
  if (message.length === 0) return;
  if (inFlight.has(chatId)) return;
  inFlight.add(chatId);
  void generate(chatId, message).finally(() => {
    inFlight.delete(chatId);
  });
}

/** First non-empty line of the message, condensed and capped, as a fallback title. */
function deriveFallbackTitle(message: string): string | null {
  const line = message
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return null;
  const cleaned = line.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned;
}

async function generate(chatId: number, message: string): Promise<void> {
  let title: string | null = null;
  try {
    title = await requestTitle(chatId, message);
  } catch (err) {
    console.error(
      "[title-gen] failed to generate chat title:",
      err instanceof Error ? err.message : err,
    );
  }

  const finalTitle = title ?? deriveFallbackTitle(message);
  if (finalTitle === null) return;

  const current = getChat(chatId);
  if (!current || current.title.trim().length > 0) return;
  updateChatTitle(chatId, finalTitle);
  sendToRenderer("chats:changed", { chatId });
}

/**
 * One-shot completion asking for a chat title in the message's own language.
 * Returns the sanitized title, or `null` when the model produced nothing
 * usable (the chat then stays untitled).
 */
async function requestTitle(
  chatId: number,
  message: string,
): Promise<string | null> {
  const modelRuntime = await getModelRuntime();
  const model = resolveModel(modelRuntime, getEmployee(ASSISTANT_ID)?.modelId);
  if (!model) {
    console.warn(
      `[title-gen] no model resolved for chat ${chatId} ` +
        `(available models: ${modelRuntime.getAvailableSnapshot().length})`,
    );
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  try {
    const response = await modelRuntime.completeSimple(
      model,
      {
        systemPrompt:
          "You propose titles for chats. Given the user's first message, " +
          "reply with ONLY a concise chat title (a few words, at most 40 " +
          "characters): no quotes, no colon prefix, no trailing punctuation, " +
          "no explanation. Write the title in the same language as the " +
          "message.",
        messages: [
          {
            role: "user",
            content: message.slice(0, MAX_PROMPT_MESSAGE_CHARS),
            timestamp: Date.now(),
          },
        ],
      },
      { signal: controller.signal, maxTokens: 512 },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      console.warn(
        `[title-gen] model call ended with ${response.stopReason} for chat ${chatId}`,
      );
      return null;
    }
    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();
    // A reasoning model can put its whole answer in a thinking block, leaving
    // the text blocks empty; fall back to any other string the blocks carry
    // before giving up on this chat.
    const title =
      sanitizeTitle(text) ??
      sanitizeTitle(text.length === 0 ? otherText(response.content) : "");
    if (title === null) {
      console.warn(
        `[title-gen] no usable title for chat ${chatId} ` +
          `(blocks: ${response.content.map((block) => block.type).join(",")})`,
      );
    }
    return title;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Join every string field of an unknown block list, skipping the `type` tag —
 * a last resort for models that hide their answer outside text blocks.
 */
function otherText(blocks: ReadonlyArray<unknown>): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    for (const [key, value] of Object.entries(block)) {
      if (key !== "type" && typeof value === "string") parts.push(value);
    }
  }
  return parts.join("\n").trim();
}

/**
 * Turn raw model output into a single-line title within the DB limit.
 * Returns `null` when nothing usable remains.
 */
function sanitizeTitle(raw: string): string | null {
  // Models occasionally wrap the answer or prefix it; take the first non-empty
  // line, drop surrounding quotes, and strip a stray "Title:" label.
  const firstLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  const withoutLabel = firstLine.replace(/^Title\s*[:：]\s*/i, "");
  const unquoted = withoutLabel.replace(/^["'“”«»]+|["'“”«»]+$/gu, "");
  const cleaned = unquoted.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_TITLE_LENGTH);
}
