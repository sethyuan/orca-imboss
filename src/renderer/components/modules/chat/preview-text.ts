import { t } from "@shared/l10n";
import type { ChatPreview } from "@shared/types";
import { replaceMentions } from "../../markdown/mention";
import { toPlainText } from "../../markdown/plain-text";
import { displayTitle } from "./relative-time";

/**
 * The one-line description of a message, shared by the chat list and the
 * composer's conversation picker so the two can never disagree.
 *
 * The main process only *extracts* the message's readable content
 * (`@shared/chat-preview`); everything visible is decided here: the label per
 * message kind, Markdown flattening, `@<id>` mentions, the attachment note and
 * the truncation. Keeping it in the renderer is what makes a live language
 * switch apply immediately (a string baked in the main process would keep its
 * startup language until restart).
 *
 * Defensive: an unknown kind, a missing field or an empty body degrades to the
 * plain text (or nothing at all) — a teaser must never break the list.
 */
export function formatChatPreview(
  preview: ChatPreview | null | undefined,
  max = 80,
  resolveMention?: (id: number) => string | null,
): string {
  if (!preview) return "";

  const body = flatten(preview.text, resolveMention);
  const parts: string[] = [];

  switch (preview.kind) {
    case "ask": {
      // A card is described by how many questions it asks, never by their text
      // (the list is a one-line teaser; the questions belong to the card).
      const count = preview.questionCount ?? 0;
      parts.push(
        count > 0
          ? countLabel("Question", count)
          : // Unparseable payload: the extractor kept the raw bytes instead.
            t("Question: ${text}", { text: fallback(body) }),
      );
      break;
    }
    case "answer": {
      const count = preview.answerCount ?? 0;
      parts.push(
        count > 0
          ? countLabel("Answer", count)
          : t("Answer: ${text}", { text: fallback(body) }),
      );
      break;
    }
    case "progress": {
      const title = body.length > 0 ? body : t("Progress");
      const total = preview.stepsTotal ?? 0;
      if (total > 0) {
        parts.push(
          `${title} · ${t("${done}/${total} done", {
            done: String(preview.stepsDone ?? 0),
            total: String(total),
          })}`,
        );
      } else {
        parts.push(title);
      }
      break;
    }
    case "chat": {
      const title = preview.linkChatTitle;
      if (preview.linkChatId === undefined) {
        // Not a resolvable link (malformed content): describe the stored bytes.
        if (body.length > 0) parts.push(body);
      } else if (typeof title !== "string") {
        parts.push(t("Group chat (conversation unavailable)"));
      } else {
        // `""` means the conversation exists without a title, which has the
        // same fallback as a chat row in the list.
        parts.push(t("Group chat: ${title}", { title: displayTitle(title) }));
      }
      break;
    }
    case "image": {
      const text = fallback(body);
      if (preview.imageStatus === "generating") {
        parts.push(t("Generating image: ${text}", { text }));
      } else if (preview.imageStatus === "error") {
        parts.push(t("Image generation failed: ${text}", { text }));
      } else {
        parts.push(t("Image: ${text}", { text }));
      }
      break;
    }
    default:
      // `text`, `report` and every kind we do not know yet: the message body
      // is the description.
      if (body.length > 0) parts.push(body);
      break;
  }

  // A send that carried only comments has no body at all: the count is its
  // description. Localized here (never stored), like every other label.
  const comments = preview.commentCount ?? 0;
  if (body.length === 0 && comments > 0) {
    parts.push(countLabel("Comment", comments));
  }

  const attachments = preview.attachmentCount ?? 0;
  // An image message's attachments *are* the picture, so counting them here
  // would only add noise to "Generating image: …".
  if (attachments > 0 && preview.kind !== "image") {
    parts.push(t("${count} attachments", { count: String(attachments) }));
  }

  const line = parts.filter((part) => part.length > 0).join(" · ");
  return truncate(line, max);
}

/** Cut to `max` UTF-16 units without splitting a surrogate pair (emoji). */
function truncate(line: string, max: number): string {
  if (line.length <= max) return line;
  let cut = line.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** A card with no readable body still deserves a line rather than a gap. */
function fallback(text: string): string {
  return text.length > 0 ? text : t("(empty message)");
}

/**
 * `"Question (3 questions)"` / `"Answer (1 answer)"` / `"Comment (2 comments)"`.
 *
 * The dictionary has no plural engine (`t()` only interpolates), so the
 * singular is a key of its own instead of an `s` sexed onto the count in code —
 * every language then spells its own singular/plural, and Chinese (which has
 * neither) simply translates both keys the same way.
 */
function countLabel(
  noun: "Question" | "Answer" | "Comment",
  count: number,
): string {
  const one = count === 1;
  switch (noun) {
    case "Question":
      return one
        ? t("Question (1 question)")
        : t("Question (${count} questions)", { count: String(count) });
    case "Answer":
      return one
        ? t("Answer (1 answer)")
        : t("Answer (${count} answers)", { count: String(count) });
    case "Comment":
      return one
        ? t("Comment (1 comment)")
        : t("Comment (${count} comments)", { count: String(count) });
  }
}

/**
 * Markdown → one-line plain text: formatting markers, math source and repeated
 * whitespace are dropped, and `@<id>` mentions become names (the preview is
 * plain text, so mentions carry no theme color or click target). Truncation
 * happens once, on the composed line — a label must not be cut away.
 */
function flatten(
  content: string,
  resolveMention?: (id: number) => string | null,
): string {
  const plain = toPlainText(content).replace(/\s+/g, " ").trim();
  return resolveMention ? replaceMentions(plain, resolveMention) : plain;
}

/**
 * Collapse every whitespace run (newlines included) to one space and trim the
 * ends — the shape a one-line summary needs (the "my messages" list renders one
 * line per entry, so the raw multi-line text is never shown).
 *
 * Shared by the root chat and the agent session so both lists describe a message
 * the same way.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
