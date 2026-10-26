import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentStreamEvent, AgentStreamPayload } from "@shared/types";
import type { Subscriber } from "../rpc/types";
import { formatToolArgsDetail, summarizeToolArgs } from "./tool-args";

/**
 * Map raw Pi `AgentSessionEvent`s to the small, serializable DTOs the
 * renderer consumes, and push them to the windows bound to a session.
 *
 * Only a whitelist of event types crosses the IPC boundary; everything else
 * (retry/summarization internals, `entry_appended`, `tool_execution_update`,
 * …) is dropped. The raw event payloads are never forwarded — they embed the
 * full in-progress message / tool result and `message_update` fires per token.
 */

/** The single renderer channel carrying bound session events. */
export const AGENT_SESSION_EVENT_CHANNEL = "agentSession:event";

/** Map one raw event to its DTO, or `null` when it is not forwarded. */
export function toStreamEvent(
  event: AgentSessionEvent,
): AgentStreamEvent | null {
  switch (event.type) {
    case "message_update": {
      const partial = event.assistantMessageEvent;
      const dto: Extract<AgentStreamEvent, { type: "message_update" }> = {
        type: "message_update",
        subType: partial.type,
      };
      if (
        partial.type === "text_delta" ||
        partial.type === "thinking_delta" ||
        partial.type === "toolcall_delta"
      ) {
        dto.delta = partial.delta;
        dto.contentIndex = partial.contentIndex;
      } else if ("contentIndex" in partial) {
        dto.contentIndex = partial.contentIndex;
      }
      // Tool-call identity + a capped argument summary/detail for inline
      // placement (arguments are capped in main; tool results are never sent).
      if (partial.type === "toolcall_end") {
        dto.toolCallId = partial.toolCall.id;
        dto.toolName = partial.toolCall.name;
        const summary = summarizeToolArgs(
          partial.toolCall.name,
          partial.toolCall.arguments,
        );
        if (summary.length > 0) dto.toolArgsSummary = summary;
        const detail = formatToolArgsDetail(partial.toolCall.arguments);
        if (detail !== undefined) dto.toolArgsDetail = detail;
      }
      return dto;
    }
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      };
    case "agent_start":
      return { type: "agent_start" };
    case "agent_end":
      return { type: "agent_end", willRetry: event.willRetry };
    case "message_start":
      return { type: "message_start" };
    case "message_end":
      return { type: "message_end" };
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
    case "compaction_start":
      return { type: "compaction_start", reason: event.reason };
    case "compaction_end":
      return {
        type: "compaction_end",
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
        ...(event.errorMessage !== undefined
          ? { errorMessage: event.errorMessage }
          : {}),
      };
    default:
      return null;
  }
}

/** Build the app-level `error` event for a failed run. */
export function errorEvent(error: unknown): AgentStreamEvent {
  return {
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Send one event to every live bound sender. Destroyed windows are skipped;
 * a send failure must never break the queue.
 */
export function sendEventTo(
  senders: Iterable<Subscriber>,
  employeeId: number,
  chatId: number,
  event: AgentStreamEvent,
): void {
  const payload: AgentStreamPayload = { employeeId, chatId, event };
  for (const sender of senders) {
    try {
      if (sender.alive) {
        sender.send(AGENT_SESSION_EVENT_CHANNEL, payload);
      }
    } catch {
      // A renderer tear-down race must not abort delivery to other windows.
    }
  }
}
