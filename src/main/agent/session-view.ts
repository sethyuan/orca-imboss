import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionLiveBlock,
  AgentSessionLiveBlockEntry,
  AgentSessionViewEntry,
} from "@shared/types";
import { resolve } from "path";
import { splitAttachmentPrompt } from "../attachment-prompt";
import { getAgentSessionsDir } from "../data-dir";
import { getSession } from "../db/sessions";
import { INTERRUPT_MARKER } from "./interrupt-marker";
import { loadPiSdk } from "./pi-sdk";
import { formatToolArgsDetail, summarizeToolArgs } from "./tool-args";

/**
 * Project a persisted `(employee, chat)` Pi session into the slim, serializable
 * block list the read-only session view renders.
 *
 * Deliberately lossy: system messages, tool results, images and usage data
 * never leave the main process. User prompts, assistant text and thinking, tool
 * names with a compact argument summary/detail, and compaction summaries are
 * returned **in full** (no length truncation of text/thinking/summary blocks —
 * the boss's explicit requirement; only tool-argument formatting caps its own
 * one-line summary/expandable detail, see `tool-args.ts`). Internal wake
 * prompts are reduced to a bare `wake` separator (no text) so the view can draw
 * one batch boundary per wake. Runs are linear in this app, so raw append order
 * is the transcript order (`getEntries()`).
 */

/**
 * Upper bound for the number of blocks one live seed may carry (defensive): a
 * runaway single message must not turn a `bind` into a multi-megabyte push.
 * This bounds the block **count** only; each block's text is sent in full.
 */
const MAX_LIVE_BLOCKS = 200;

/** Read + project the session for `(employeeId, chatId)`. Never throws. */
export async function readSessionView(
  employeeId: number,
  chatId: number,
): Promise<AgentSessionViewEntry[]> {
  return projectEntries(await readSessionEntries(employeeId, chatId));
}

/**
 * Read the raw entries of the persisted `(employee, chat)` Pi session — the
 * shared front half of every session reader (this projection and
 * `readLastAssistantMessage` in `session-stat.ts`).
 *
 * Returns an empty list instead of throwing: a missing/corrupt/zero-byte
 * session file, an unknown pair and a path outside the session store all
 * degrade to "nothing persisted". Callers never need their own guard.
 */
export async function readSessionEntries(
  employeeId: number,
  chatId: number,
): Promise<SessionEntry[]> {
  const record = getSession(employeeId, chatId);
  if (!record || !isInsideSessionsDir(record.session)) return [];

  try {
    const pi = await loadPiSdk();
    const manager = pi.SessionManager.open(
      record.session,
      getAgentSessionsDir(),
    );
    return manager.getEntries();
  } catch (err) {
    // A missing/corrupt/zero-byte session file must degrade to an empty read,
    // never break the renderer request or a status probe.
    console.error(
      `[session-view] failed to read session for ${employeeId} in chat ${chatId}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Map raw session entries to the renderer DTO list. */
function projectEntries(entries: SessionEntry[]): AgentSessionViewEntry[] {
  const out: AgentSessionViewEntry[] = [];
  // toolCallId -> index in `out`, so a later toolResult can resolve its status.
  const toolIndex = new Map<string, number>();

  for (const entry of entries) {
    if (entry.type === "compaction") {
      if (entry.summary.length > 0) {
        out.push({ kind: "compaction", id: entry.id, summary: entry.summary });
      }
      continue;
    }
    if (entry.type === "custom" && entry.customType === INTERRUPT_MARKER) {
      // The app's own "turn interrupted here" marker: a durable custom entry that
      // never reaches the model. Projected as a separator, positioned exactly
      // where the aborted turn was cut (entries are appended in run order).
      out.push({ kind: "interrupted", id: entry.id });
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.message as {
      role?: unknown;
      content?: unknown;
      toolCallId?: unknown;
      isError?: unknown;
    };
    switch (message.role) {
      case "user": {
        const raw = extractTextContent(message.content);
        if (raw.length === 0) break;
        const wake = classifyWakePrompt(raw);
        if (wake !== null) {
          // One separator per batch boundary: two adjacent wakes (nothing
          // rendered between them) collapse into a single marker.
          if (out.length === 0 || out[out.length - 1].kind !== "wake") {
            const separator: Extract<AgentSessionViewEntry, { kind: "wake" }> =
              {
                kind: "wake",
                id: entry.id,
              };
            if (wake.chatId !== undefined) separator.targetChatId = wake.chatId;
            out.push(separator);
          }
          break;
        }
        // The prompt the agent received carries its attachments as a trailing
        // `[Attachments]` block (see `agentPrompt()`). That block is the model's
        // addressing scheme, not something the boss wrote, so it is split off
        // and projected as chips. `splitAttachmentPrompt()` only reports
        // attachments when it could rebuild the block byte for byte; anything it
        // cannot fully understand stays in `text`, exactly as persisted.
        const { text, attachments } = splitAttachmentPrompt(raw);
        // A file-only send has no words at all: it is still a turn, and dropping
        // it here would make the boss's message disappear from the view.
        if (text.length === 0 && attachments.length === 0) break;
        out.push({
          kind: "user",
          id: entry.id,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        break;
      }
      case "assistant":
        projectAssistant(entry.id, message.content, out, toolIndex);
        break;
      case "toolResult":
        applyToolResult(out, toolIndex, message.toolCallId, message.isError);
        break;
      default:
        // System messages (prompt + tool declarations) are intentionally hidden.
        break;
    }
  }
  return out;
}

/** Append one block per assistant content block, preserving order. */
function projectAssistant(
  entryId: string,
  content: unknown,
  out: AgentSessionViewEntry[],
  toolIndex: Map<string, number>,
): void {
  if (typeof content === "string") {
    if (content.length > 0) {
      out.push({ kind: "text", id: entryId, text: content });
    }
    return;
  }
  if (!Array.isArray(content)) return;

  content.forEach((raw, index) => {
    const block = projectAssistantBlock(entryId, raw, index);
    if (block === null) return;
    if (block.kind === "tool") {
      // Resolved later by the matching toolResult (see `applyToolResult`).
      toolIndex.set(block.toolCallId ?? `${entryId}:c${index}`, out.length);
    }
    out.push(block);
  });
}

/**
 * Project the **in-flight** assistant message of a streaming session into the
 * block shapes the persisted history uses, each tagged with its content index
 * (the same index the token-level `message_update` stream reports).
 *
 * Same whitelist as the history projection: text, thinking and tool-call
 * identity plus a capped argument summary — tool results never leave the main
 * process. A tool call still in `pendingToolCalls` is reported as `running`;
 * any other call in the message already has its result (`ok`).
 */
export function projectLiveAssistant(
  content: unknown,
  pendingToolCalls?: ReadonlySet<string>,
): AgentSessionLiveBlock[] {
  const blocks: AgentSessionLiveBlock[] = [];
  if (typeof content === "string") {
    if (content.length > 0) {
      blocks.push({
        index: 0,
        block: { kind: "text", id: "live", text: content },
      });
    }
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;

  const bounded = Math.min(content.length, MAX_LIVE_BLOCKS);
  for (let index = 0; index < bounded; index += 1) {
    const block = projectAssistantBlock("live", content[index], index);
    if (block === null) continue;
    if (block.kind === "tool") {
      block.status = isToolCallPending(block.toolCallId, pendingToolCalls)
        ? "running"
        : "ok";
    }
    blocks.push({ index, block });
  }
  return blocks;
}

/** Whether a seeded tool call is still executing (defaults to "settled"). */
function isToolCallPending(
  toolCallId: string | undefined,
  pendingToolCalls: ReadonlySet<string> | undefined,
): boolean {
  if (toolCallId === undefined || !pendingToolCalls) return false;
  return pendingToolCalls.has(toolCallId);
}

/**
 * Project one assistant content block, or `null` when the app deliberately does
 * not expose it (images, unknown types, empty text/thinking).
 *
 * `index` is the block's position in the assistant message's content array; it
 * is only used to build stable ids.
 */
function projectAssistantBlock(
  entryId: string,
  block: unknown,
  index: number,
): AgentSessionLiveBlockEntry | null {
  if (block === null || typeof block !== "object") return null;
  const b = block as {
    type?: unknown;
    text?: unknown;
    thinking?: unknown;
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
  };
  if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
    return { kind: "text", id: `${entryId}:t${index}`, text: b.text };
  }
  if (
    b.type === "thinking" &&
    typeof b.thinking === "string" &&
    b.thinking.length > 0
  ) {
    return {
      kind: "thinking",
      id: `${entryId}:k${index}`,
      text: b.thinking,
    };
  }
  if (b.type === "toolCall" && typeof b.name === "string") {
    const toolCallId = typeof b.id === "string" ? b.id : undefined;
    const tool: AgentSessionLiveBlockEntry = {
      kind: "tool",
      id: `${entryId}:c${index}`,
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      name: b.name,
      argsSummary: summarizeToolArgs(b.name, b.arguments),
      // Flipped to ok/error when the matching toolResult is reached; a
      // session read mid-run legitimately leaves it "running".
      status: "running",
    };
    const detail = formatToolArgsDetail(b.arguments);
    if (detail !== undefined) tool.argsDetail = detail;
    return tool;
  }
  return null;
}

/** Resolve a persisted toolResult against its tool block. */
function applyToolResult(
  out: AgentSessionViewEntry[],
  toolIndex: Map<string, number>,
  toolCallId: unknown,
  isError: unknown,
): void {
  if (typeof toolCallId !== "string") return;
  const index = toolIndex.get(toolCallId);
  if (index === undefined) return;
  const tool = out[index];
  if (tool.kind !== "tool") return;
  tool.status = isError === true ? "error" : "ok";
}

/**
 * Flatten a message's `content` to its text blocks joined with a newline — the
 * app's one text extractor (user messages, assistant stats). String content is
 * returned verbatim; anything else contributes only `type: "text"` blocks.
 */
export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/**
 * Recognise an internal synthetic wake prompt (READ_CHAT_PROMPT /
 * `readChatPrompt(chatId)`), injected by the orchestrator to wake an agent to
 * read a chat. These are background dispatcher triggers, never user-authored
 * messages, so they are projected as a batch separator instead of a user turn.
 *
 * Returns `null` for anything else. `chatId` is set only for the
 * `… in chat <id>` variant; `Number.isSafeInteger` guards a malformed prompt
 * (only reachable if a stored session were tampered with).
 */
function classifyWakePrompt(text: string): { chatId?: number } | null {
  const match = /^You have new messages in (?:chat (\d+)|this chat)\./i.exec(
    text.trim(),
  );
  if (!match) return null;
  if (match[1] === undefined) return {};
  const chatId = Number(match[1]);
  return Number.isSafeInteger(chatId) ? { chatId } : {};
}

/**
 * Security: only read files recorded inside `~/.imboss/agent/sessions`.
 * Mirrors the guard used by `db/sessions.ts` for unlinking.
 */
function isInsideSessionsDir(filePath: string): boolean {
  const norm = (p: string): string =>
    process.platform === "win32" ? p.toLowerCase() : p;
  const root = norm(resolve(getAgentSessionsDir()));
  const target = norm(resolve(filePath));
  return (
    target === root ||
    target.startsWith(root + "/") ||
    target.startsWith(root + "\\")
  );
}
