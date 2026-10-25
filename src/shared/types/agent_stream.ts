import type {
  AgentSessionSteerState,
  AgentSessionViewEntry,
} from "./agent_session";

/** Reason a session compaction was triggered (mirrors the Pi session event). */
export type CompactionReason = "manual" | "threshold" | "overflow";

/**
 * A block of the history projection that can also appear in a live message.
 * Reused verbatim so one renderer branch draws seeded and streamed content.
 */
export type AgentSessionLiveBlockEntry = Extract<
  AgentSessionViewEntry,
  { kind: "text" | "thinking" | "tool" }
>;

/**
 * One block of the currently streaming assistant message, tagged with the
 * assistant content index the token-level stream also uses (`contentIndex`).
 *
 * Sent once per `agentSession:bind` while a run is streaming, so a window that
 * binds mid-run can render everything it missed before its first delta (see
 * `projectLiveAssistant` in the main process).
 */
export interface AgentSessionLiveBlock {
  /** Index in the assistant message's `content` array. */
  index: number;
  block: AgentSessionLiveBlockEntry;
}

/**
 * Minimal, structured-cloneable projection of the Pi `AgentSessionEvent`s the
 * renderer needs.
 *
 * Raw events are never forwarded: they carry full message objects / tool
 * results and `message_update` fires per streamed token. `message_update` is
 * reduced to its sub-type plus the delta; every other event is metadata only.
 */
export type AgentStreamEvent =
  | {
      type: "message_update";
      /** `assistantMessageEvent.type`, e.g. `text_delta` / `thinking_delta`. */
      subType: string;
      delta?: string;
      contentIndex?: number;
      /** Set on `toolcall_end`: the completed tool call's identity. */
      toolCallId?: string;
      toolName?: string;
      /** Set on `toolcall_end`: capped one-line argument summary. */
      toolArgsSummary?: string;
      /** Set on `toolcall_end`: capped pretty-printed arguments JSON. */
      toolArgsDetail?: string;
    }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
    }
  | { type: "agent_start" }
  | { type: "agent_end"; willRetry: boolean }
  | { type: "message_start" }
  | { type: "message_end" }
  /**
   * The in-flight assistant message as it looks right now. Sent once per bind
   * (never on the regular stream): the message is not persisted yet, so the
   * projection cannot supply it, and a window that was not bound while it
   * streamed would otherwise only ever see its tail.
   */
  | { type: "live_seed"; blocks: AgentSessionLiveBlock[] }
  /**
   * Lifecycle of one interjection of this session.
   *
   * The view owns one placeholder row per interjection (the text is nowhere else:
   * it is not written to the chat, and Pi persists it only at the next turn
   * boundary). `injected` means the transcript now holds it (drop the row),
   * `revoked` that the boss took it back, `lost`/`unknown` that it may never
   * arrive. A withdrawal is decided main-side; this event is the answer, never a
   * request.
   */
  | { type: "steer_state"; steer: AgentSessionSteerState }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "compaction_start"; reason: CompactionReason }
  | {
      type: "compaction_end";
      reason: CompactionReason;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | { type: "error"; message: string };

/** Envelope pushed to a bound renderer over `agentSession:event`. */
export interface AgentStreamPayload {
  employeeId: number;
  chatId: number;
  event: AgentStreamEvent;
}
