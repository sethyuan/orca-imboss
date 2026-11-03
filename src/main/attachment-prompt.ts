/**
 * Attachment ↔ prompt helpers, shared by every place that hands a message
 * carrying files to an agent (`chat:send`, `messages:answer`,
 * `agentSession:send`) **and** by the session view that reads those prompts back
 * (`agent/session-view.ts`).
 *
 * One module for both directions is deliberate: `formatAttachmentBlock()` is how
 * an attachment is described to the model, `splitAttachmentPrompt()` is the exact
 * inverse, and the inverse is validated by re-composing what it parsed and
 * requiring a byte-for-byte match. Keeping them together is what stops the two
 * from drifting apart — a change to the wording silently downgrades the parser
 * to "leave the text alone" instead of mangling a prompt.
 */
import { formatAttachmentSize } from "@shared/attachment-size";
import { MAX_USER_ATTACHMENTS } from "@shared/constants/attachments";
import type { AgentSessionAttachment, MessageAttachment } from "@shared/types";
import { isAbsolute } from "path";

/** Typed view of the renderer-supplied attachments payload. */
export function validateAttachmentsPayload(
  value: unknown,
): MessageAttachment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("attachments must be an array.");
  // Field-level validation happens in the messages service; pass through and
  // let it throw on malformed entries.
  return value as MessageAttachment[];
}

/** Cap for a name/type/path embedded in the agent prompt (matches the DB limits). */
const MAX_PROMPT_ATTACH_NAME_LENGTH = 256;
const MAX_PROMPT_ATTACH_TYPE_LENGTH = 128;
const MAX_PROMPT_ATTACH_PATH_LENGTH = 4096;

/** First line of the block `agentPrompt()` appends (and the parser looks for). */
const BLOCK_HEADER = "[Attachments]";

/**
 * Collapse control characters (notably newlines) and cap length so an
 * attachment name/path can never forge extra lines in the agent prompt.
 */
export function sanitizePromptField(value: string, maxLength: number): string {
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength
    ? `${cleaned.slice(0, maxLength)}…`
    : cleaned;
}

/**
 * One attachment as it appears in the prompt: **already sanitized/formatted**
 * values, which is what makes the block re-composable byte-for-byte.
 *
 * The prompt is lossy by nature (a size is a human string, a type may have been
 * truncated), so the parser can only ever rebuild these fields — and the
 * round-trip check in `splitAttachmentPrompt()` is what proves it rebuilt them
 * exactly.
 */
interface AttachmentLine {
  name: string;
  kind: "file" | "folder" | "chat";
  /** MIME-ish type; the prompt's fallback is `unknown type`. Files only. */
  type: string;
  /** Human size (`1.5 KB` / `unknown size`). Files only. */
  sizeLabel: string;
  /** Absolute path, or `""` when the prompt could not carry one. */
  path: string;
  /** Conversation reference only. */
  chatId?: number;
}

/** Normalize one renderer-supplied attachment into its prompt shape. */
function toAttachmentLine(attachment: MessageAttachment): AttachmentLine {
  const name =
    sanitizePromptField(attachment.name, MAX_PROMPT_ATTACH_NAME_LENGTH) ||
    "file";
  // A folder is a location the model reads in place, not a file to open. A chat
  // reference *without* a usable id degrades to a plain file line (it would be a
  // dead reference otherwise).
  const chatId =
    attachment.kind === "chat" &&
    typeof attachment.chatId === "number" &&
    attachment.chatId > 0
      ? attachment.chatId
      : undefined;
  const kind: AttachmentLine["kind"] =
    chatId !== undefined
      ? "chat"
      : attachment.kind === "folder"
        ? "folder"
        : "file";
  // Only absolute paths are embedded (a relative path is useless outside the
  // agent's workdir, mirroring the reveal IPC's `isAbsolute` guard).
  const path =
    typeof attachment.path === "string" &&
    attachment.path.length > 0 &&
    isAbsolute(attachment.path)
      ? sanitizePromptField(attachment.path, MAX_PROMPT_ATTACH_PATH_LENGTH)
      : "";
  return {
    name,
    kind,
    type:
      sanitizePromptField(attachment.type, MAX_PROMPT_ATTACH_TYPE_LENGTH) ||
      "unknown type",
    sizeLabel: formatAttachmentSize(attachment.size),
    path,
    ...(chatId !== undefined ? { chatId } : {}),
  };
}

/**
 * One `- …` line of the block. The five shapes below are the whole format; the
 * parser recognizes exactly these and nothing else.
 */
function formatAttachmentLine(line: AttachmentLine): string {
  const name = line.name.length > 0 ? line.name : "file";
  // A conversation attachment is a reference, not a file: give the model the
  // chat id and tell it how to read the whole thing (uncursored).
  if (line.kind === "chat" && line.chatId !== undefined && line.chatId > 0) {
    return `- [conversation] ${name} — chat #${line.chatId}: read it in full with imb_read_chat (chatId: ${line.chatId}, full: true)`;
  }
  // A folder is a location the model reads in place, not a file to open: say
  // so, otherwise "- docs (folder, 0 B)" reads like an empty file.
  if (line.kind === "folder") {
    return line.path.length > 0
      ? `- [folder] ${name} — directory at ${line.path}: list/read files inside it with your filesystem tools (its contents are not attached individually)`
      : `- [folder] ${name} — directory location unavailable`;
  }
  const base = `- ${name} (${line.type}, ${line.sizeLabel})`;
  return line.path.length > 0 ? `${base}: ${line.path}` : base;
}

/**
 * The whole block from prompt-shaped lines. Empty list ⇒ empty string (no
 * block at all), so this is safe to use as the parser's canonical comparator.
 */
export function composeAttachmentBlock(
  lines: readonly AttachmentLine[],
): string {
  if (lines.length === 0) return "";
  return `${BLOCK_HEADER}\n${lines.map(formatAttachmentLine).join("\n")}`;
}

/**
 * Agent-facing description of the user's attachments. Only absolute paths are
 * embedded; the rest degrade to name/type/size.
 */
export function formatAttachmentBlock(
  attachments: MessageAttachment[] | undefined,
): string {
  if (!attachments || attachments.length === 0) return "";
  return composeAttachmentBlock(attachments.map(toAttachmentLine));
}

/**
 * Prompt delivered to the agent: the raw text plus a compact attachment list,
 * so the model immediately knows where the files live.
 *
 * Used for a user send (text + files) and for the wake prompt after the boss
 * answers an ask card with files attached — in the latter case `content` is the
 * generic "read the chat" prompt, and the list is what stops the model from
 * replying "got it" without ever opening the attached file.
 */
export function agentPrompt(
  content: string,
  attachments: MessageAttachment[] | undefined,
): string {
  const block = formatAttachmentBlock(attachments);
  if (block.length === 0) return content;
  return content.length > 0 ? `${content}\n\n${block}` : block;
}

/**
 * Stored content for a user message. Attachments without text get a neutral
 * file-name list instead of the former hardcoded `"[附件]"`; `appendMessage`
 * rejects empty content.
 */
export function userMessageContent(
  content: string,
  attachments: MessageAttachment[] | undefined,
): string {
  if (content.length > 0) return content;
  const names = (attachments ?? [])
    .map((attachment) =>
      sanitizePromptField(attachment.name, MAX_PROMPT_ATTACH_NAME_LENGTH),
    )
    .filter((name) => name.length > 0);
  return names.length > 0 ? `Attached: ${names.join(", ")}` : "Attached files";
}

// --- Reading a prompt back ---------------------------------------------------
//
// The session view shows the prompts as they were persisted, which includes the
// block above. It must render the attachments as chips instead, so it needs the
// inverse of `formatAttachmentBlock()`.

/** A file/folder line's trailing path (greedy: a path may contain most things). */
const CONVERSATION_LINE =
  /^- \[conversation\] (.+) — chat #(\d+): read it in full with imb_read_chat \(chatId: (\d+), full: true\)$/;
const FOLDER_LINE =
  /^- \[folder\] (.+?) — directory at (.+): list\/read files inside it with your filesystem tools \(its contents are not attached individually\)$/;
const FOLDER_NO_PATH_LINE =
  /^- \[folder\] (.+?) — directory location unavailable$/;
const FILE_WITH_PATH_LINE = /^- (.+) \(([^()]+), ([^()]+)\): (.+)$/;
const FILE_LINE = /^- (.+) \(([^()]+), ([^()]+)\)$/;

/**
 * Parse one block line back into prompt-shaped fields, or `null` when the line
 * is not one of the five known shapes.
 */
function parseAttachmentLine(line: string): AttachmentLine | null {
  const conversation = CONVERSATION_LINE.exec(line);
  if (conversation !== null) {
    const chatId = Number(conversation[2]);
    // Both ids are written from the same value; a mismatch means the line was
    // hand-edited and must not be trusted.
    if (!Number.isSafeInteger(chatId) || String(chatId) !== conversation[3]) {
      return null;
    }
    return {
      name: conversation[1],
      kind: "chat",
      type: "",
      sizeLabel: "",
      path: "",
      chatId,
    };
  }
  const folder = FOLDER_LINE.exec(line);
  if (folder !== null) {
    return {
      name: folder[1],
      kind: "folder",
      type: "",
      sizeLabel: "",
      path: folder[2],
    };
  }
  const folderNoPath = FOLDER_NO_PATH_LINE.exec(line);
  if (folderNoPath !== null) {
    return {
      name: folderNoPath[1],
      kind: "folder",
      type: "",
      sizeLabel: "",
      path: "",
    };
  }
  const fileWithPath = FILE_WITH_PATH_LINE.exec(line);
  if (fileWithPath !== null) {
    return {
      name: fileWithPath[1],
      kind: "file",
      type: fileWithPath[2],
      sizeLabel: fileWithPath[3],
      path: fileWithPath[4],
    };
  }
  const file = FILE_LINE.exec(line);
  if (file !== null) {
    return {
      name: file[1],
      kind: "file",
      type: file[2],
      sizeLabel: file[3],
      path: "",
    };
  }
  return null;
}

/**
 * Every size label the formatter can emit (see `formatAttachmentSize`). A value
 * outside this set cannot be the app's own output.
 */
const SIZE_LABEL = /^(?:\d+ B|\d+\.\d KB|\d+\.\d MB|unknown size)$/;

/**
 * Whether a parsed line could have been produced by `formatAttachmentLine()`.
 *
 * Re-composition (see `splitAttachmentPrompt`) already proves the line *parses*;
 * this proves it is **canonical**: every field survives its own sanitizer, a
 * path is absolute, a file's type/size are present and a size label is one of the
 * formatter's shapes. Together they mean "only a block this app wrote can be
 * recognized" — an inbound message that merely looks like one is left as text.
 */
function isCanonicalAttachmentLine(line: AttachmentLine): boolean {
  if (line.name.length === 0) return false;
  if (
    sanitizePromptField(line.name, MAX_PROMPT_ATTACH_NAME_LENGTH) !== line.name
  ) {
    return false;
  }
  if (line.kind === "file") {
    if (line.type.length === 0) return false;
    if (
      sanitizePromptField(line.type, MAX_PROMPT_ATTACH_TYPE_LENGTH) !==
      line.type
    ) {
      return false;
    }
    if (!SIZE_LABEL.test(line.sizeLabel)) return false;
  }
  if (line.path.length > 0) {
    // The formatter only embeds absolute paths, and always sanitized ones.
    if (!isAbsolute(line.path)) return false;
    if (
      sanitizePromptField(line.path, MAX_PROMPT_ATTACH_PATH_LENGTH) !==
      line.path
    ) {
      return false;
    }
  }
  if (line.kind === "chat" && line.chatId === undefined) return false;
  return true;
}

/** Parse a whole block body (header included), or `null` when it is not ours. */
function parseAttachmentBlock(block: string): AttachmentLine[] | null {
  const lines = block.split("\n");
  if (lines[0] !== BLOCK_HEADER) return null;
  const body = lines.slice(1);
  if (body.length === 0 || body.length > MAX_USER_ATTACHMENTS) return null;
  const parsed: AttachmentLine[] = [];
  for (const line of body) {
    const item = parseAttachmentLine(line);
    if (item === null) return null;
    if (!isCanonicalAttachmentLine(item)) return null;
    parsed.push(item);
  }
  return parsed;
}

/** Renderer-facing projection of one prompt-shaped line. */
function toViewAttachment(line: AttachmentLine): AgentSessionAttachment {
  const attachment: AgentSessionAttachment = {
    name: line.name,
    kind: line.kind,
  };
  if (line.kind === "file") {
    if (line.type.length > 0) attachment.type = line.type;
    if (line.sizeLabel.length > 0) attachment.sizeLabel = line.sizeLabel;
  }
  if (line.path.length > 0) attachment.path = line.path;
  if (line.kind === "chat" && line.chatId !== undefined) {
    attachment.chatId = line.chatId;
  }
  return attachment;
}

/**
 * The exact inverse of `agentPrompt()`'s trailing attachment block: split a
 * persisted prompt into the text the boss typed plus the attachments it carried.
 *
 * Safety rules (all of them must hold, otherwise the text is returned
 * **untouched** and nothing is stripped):
 *
 * 1. the block sits at the very **end** of the text (`"\n\n[Attachments]\n…"`),
 *    or is the whole text (a send with files and no words);
 * 2. the block ends at the last such boundary — never a `[Attachments]` the boss
 *    happens to have typed in the middle;
 * 3. every line is one of the five shapes above (≤ `MAX_USER_ATTACHMENTS`) and
 *    is canonical: each field survives its own sanitizer, a path is absolute, a
 *    size label is one the formatter can produce (`isCanonicalAttachmentLine`);
 * 4. **re-composing** the parsed fields reproduces the block byte for byte.
 *
 * Rule 4 is the important one: it makes this parser the formatter's strict
 * inverse instead of a guess. A name containing `)`/`—`, a double space, a
 * truncated field, a hand-edited or forgeable look-alike block, or a future
 * wording change all fail it and degrade to "show the prompt as written" — the
 * app never hides text it does not fully understand.
 */
export function splitAttachmentPrompt(text: string): {
  text: string;
  attachments: AgentSessionAttachment[];
} {
  const unchanged = { text, attachments: [] as AgentSessionAttachment[] };
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
  const parsed = parseAttachmentBlock(block);
  if (parsed === null) return unchanged;
  if (composeAttachmentBlock(parsed) !== block) return unchanged;
  return { text: body, attachments: parsed.map(toViewAttachment) };
}
