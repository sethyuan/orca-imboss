/**
 * Renderer-facing projection of a persisted `(employee, chat)` agent session.
 *
 * The raw Pi session JSONL holds full system prompts, tool arguments, tool
 * results, images and usage data. This projection is deliberately slim: only
 * the content the read-only session view renders crosses the IPC boundary
 * (see `readSessionView` in the main process).
 */
export type AgentSessionViewEntry =
  | {
      /**
       * A prompt delivered to the session by a human (composer, integrations,
       * cron job content). Internal wake prompts are `kind: "wake"` instead.
       */
      kind: "user";
      id: string;
      text: string;
    }
  | {
      /**
       * An internal "you have new messages" wake prompt.
       *
       * Never user-authored and never rendered as a user bubble: the view draws
       * it as a batch separator (one per batch of processed messages). The
       * original prompt text is intentionally not carried over.
       */
      kind: "wake";
      id: string;
      /**
       * Chat the wake points at (the `… in chat <id>` variant, used when the
       * assistant is woken in its root session for a task group chat).
       * Informational only — the view does not resolve a title for it.
       */
      targetChatId?: number;
    }
  | {
      /** Assistant free-form text. */
      kind: "text";
      id: string;
      text: string;
    }
  | {
      /** Assistant reasoning (thinking) block. */
      kind: "thinking";
      id: string;
      text: string;
    }
  | {
      /** A tool call; the name plus a compact argument summary (no results). */
      kind: "tool";
      id: string;
      /** Pi tool-call id; correlates live `tool_execution_*` stream events. */
      toolCallId?: string;
      name: string;
      /** One-line, capped human-readable argument summary. */
      argsSummary: string;
      /** Capped pretty-printed arguments JSON, when the call had arguments. */
      argsDetail?: string;
      status: "running" | "ok" | "error";
    }
  | {
      /**
       * A turn the boss interrupted. Drawn as a system separator where the aborted
       * turn was cut (backed by a Pi custom entry, so it survives a restart and is
       * never part of the model's context).
       */
      kind: "interrupted";
      id: string;
    }
  | {
      /** A context-compaction marker (summary text only). */
      kind: "compaction";
      id: string;
      summary: string;
    };

/** Full projected session returned by `sessions:entries`. */
export interface AgentSessionView {
  employeeId: number;
  chatId: number;
  entries: AgentSessionViewEntry[];
}

/**
 * How the main process routed a composer send from the agent-session view.
 *
 * `"steer"`: the session was streaming, so the text was handed to the live Pi
 * run and is seen after the current assistant turn. `"queued"`: the session was
 * not streaming, so the text joins (or starts) the app-level serialized queue.
 */
export type AgentSessionDeliveryMode = "steer" | "queued";

/** Result of `agentSession:send` (the session view's composer). */
export interface AgentSessionSendResult {
  /** Authoritative routing decided by the main process, for user feedback. */
  mode: AgentSessionDeliveryMode;
  /**
   * Handle of the interjection, present only when `mode === "steer"`.
   *
   * It addresses one *copy* of the text (two identical interjections are two
   * records), which is what `agentSession:revokeSteer` and the `steer_state`
   * stream use. A queued send has no id: it is a plain app-queue string.
   */
  steerId?: string;
}

/**
 * Lifecycle of one interjection (a text this app handed to a live Pi run as a
 * steering message).
 *
 * - `pending`: still in Pi's steering queue, never injected — **withdrawable**;
 * - `injected`: Pi turned it into a transcript user message, the model has seen
 *   it — **not withdrawable** (rolling that back is a turn rollback, not a
 *   withdrawal);
 * - `revoked`: this app removed it from the queue — the text will never run;
 * - `unknown`: a withdrawal was attempted and failed (the queue state could not
 *   be determined) — treated as not withdrawable;
 * - `lost`: the run ended (or was interrupted) while it was still queued — it
 *   may never have been delivered. Informational only, dismissable.
 */
export type AgentSessionSteerPhase =
  "pending" | "injected" | "revoked" | "unknown" | "lost";

/** One interjection as reported to a bound renderer (`steer_state`) or in a snapshot. */
export interface AgentSessionSteerState {
  /** Opaque handle; unique per app run of this session (`agentSession:send`). */
  id: string;
  /** What the boss typed — never the skill/template expanded text. */
  text: string;
  phase: AgentSessionSteerPhase;
}

/**
 * Result of `agentSession:revokeSteer`.
 *
 * Withdrawal is a **normal business outcome**, not an error: a text that Pi
 * already injected simply cannot be taken back, so the reasons are values the
 * view renders instead of exceptions it has to catch.
 */
export interface AgentSessionSteerRevokeResult {
  /** `true` only when the text was actually removed from Pi's queue. */
  withdrawn: boolean;
  /**
   * Why nothing was withdrawn (`withdrawn: true` omits it):
   * - `delivered`: Pi already injected it (the model has seen it);
   * - `gone`: it is no longer pending (session disposed, run ended, queue
   *   cleared) — nothing left to withdraw;
   * - `unknown`: the attempt failed and the queue state is undetermined.
   */
  reason?: "delivered" | "gone" | "unknown";
}

/**
 * Cosmetic run-state snapshot of one `(employee, chat)` session, so the view
 * can label its controls ("Send" vs "Interject") and enable the interrupt chip.
 *
 * Never used to decide delivery: `deliver()` re-checks the live session
 * (`busy && isStreaming`), so a stale snapshot only affects labels — and a
 * withdrawal is re-validated main-side too.
 */
export interface AgentSessionRunState {
  /** A Pi run is actively streaming — a steer or an interrupt can land now. */
  streaming: boolean;
  /**
   * Interjections of the **current** run (in hand-over order), so a view that
   * mounts mid-run can restore its placeholders — including a still
   * withdrawable one — instead of starting blank.
   *
   * Absent when the queue state does not exist at all (nothing was ever
   * delivered here), which is the same reason `streaming` would be `false`.
   */
  steers?: AgentSessionSteerState[];
}

/**
 * One agent message as reported to the assistant by `imb_get_employee_stat`.
 *
 * Deliberately lossy, like every other projection: assistant text blocks only
 * (never thinking, never tool arguments, never tool results).
 */
export interface AgentMessageStat {
  /** Assistant text blocks joined with a newline, capped by the caller. */
  text: string;
  /** Length of the **full** text before the cap, so a cap is visible. */
  chars: number;
  truncated: boolean;
  /** Names of the tool calls in this message (identity only, no arguments). */
  toolCalls: string[];
  /**
   * `true`: this is the **in-flight** assistant message of a streaming run and
   * has not been persisted yet — `at`/`ageSeconds` are `null` and the text is
   * the partial output produced so far. `false`: a message read from the
   * session transcript. A streaming message with an empty `text` and no
   * `toolCalls` means the current turn has produced nothing readable yet
   * (between turns while a tool executes, or before the first token).
   */
  streaming: boolean;
  /** ISO timestamp of the persisted entry (`null` for in-flight content). */
  at: string | null;
  /** Whole seconds since `at` (`null` for in-flight content). */
  ageSeconds: number | null;
}

/**
 * Current state of exactly one `(employee, chat)` agent session — the payload
 * of the assistant-only `imb_get_employee_stat` tool.
 *
 * Describes what the session is doing **now**: `running` is the authoritative
 * signal, `queued` is background information only (pending prompts that have
 * not started) and never influences which message is considered "the last".
 */
export interface EmployeeAgentStat {
  employeeId: number;
  chatId: number;
  chatTitle: string;
  /** A persisted session exists for this pair (row + file inside the store). */
  sessionExists: boolean;
  /** A Pi run is streaming right now. */
  running: boolean;
  /** Prompts waiting in the app-level queue (informational only). */
  queued: number;
  /**
   * The employee's last agent message, always describing the **current** state:
   * while `running` it is the **in-flight** message of the current turn
   * (`streaming: true`, partial output — possibly still empty), otherwise the
   * last assistant message of the transcript (`streaming: false`). `null` only
   * when the session is not running and has produced no agent output at all.
   */
  lastAgentMessage: AgentMessageStat | null;
  /**
   * Present only while `running`: the last **persisted** assistant message, for
   * comparison. Never a substitute for `lastAgentMessage` — it is history, not
   * what the employee is producing now.
   */
  previousAgentMessage?: AgentMessageStat;
  /**
   * Present only while `running`: how the current run is progressing in time.
   * This is what separates "still working" from "wedged inside a tool" —
   * `lastAgentMessage` carries no timestamp while a message is in flight.
   *
   * All ages are whole seconds, computed main-side at read time (the model never
   * has to know the clock). Omitted entirely when no run in-flight is observed
   * (no progress data is invented).
   */
  progress?: AgentProgressStat;
}

/**
 * The kinds of observable progress of a run, in the order they typically occur.
 *
 * Fixed vocabulary so the model can branch on it:
 * - `run_start`: the run began (nothing produced yet);
 * - `turn_start`: a new turn of the run began;
 * - `message_start` / `token`: the assistant is writing (a streaming delta
 *   arrived — text, thinking or a tool-call delta);
 * - `message_end`: an assistant message finished and is persisted;
 * - `tool_start` / `tool_update` / `tool_end`: a tool call started, reported
 *   partial results, or finished;
 * - `retry_wait`: the app is waiting for an automatic model retry.
 *
 * Most tools (`bash`, `read`, `write`, …) never report partial results, so a
 * long tool legitimately parks at `tool_start` — see `activeTool`.
 */
export type AgentProgressKind =
  | "run_start"
  | "turn_start"
  | "message_start"
  | "token"
  | "message_end"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "retry_wait";

/** The tool call the run is currently blocked in. */
export interface AgentActiveToolStat {
  /** Tool name (e.g. `bash`, `read`, `imb_send_message`). */
  name: string;
  /** Whole seconds since this call started executing. */
  ageSeconds: number;
  /**
   * The call's **input arguments**, serialized to one line of JSON and
   * truncated to a fixed budget (~1000 chars), or `null` when they could not be
   * serialized.
   *
   * These are the model's own tool arguments: they may contain sensitive values
   * (URLs with tokens, file paths, secrets inside a command) or long bodies, and
   * they are **never complete** — see `argsTruncated`. Do not treat them as a
   * faithful record of the call.
   */
  args: string | null;
  /** `true` when `args` was cut at the character budget. */
  argsTruncated: boolean;
}

/**
 * Time information about the run in flight — present only while `running`.
 *
 * Answering "is it wedged inside a tool, and for how long?" is the whole point:
 * `activeTool.ageSeconds` is the age of the oldest call that has not finished,
 * and `lastProgressAgeSeconds` is how long ago the last observable activity was
 * (a token, a tool boundary, a retry note). A long tool that reports no partial
 * results leaves both values equal — that is expected, not a bug.
 */
export interface AgentProgressStat {
  /** Whole seconds since this run started. */
  runAgeSeconds: number;
  /** Whole seconds since the last observable progress of this run. */
  lastProgressAgeSeconds: number;
  /** What that last observable progress was. */
  lastProgressKind: AgentProgressKind;
  /**
   * Present while at least one tool call of this run has not finished: the
   * **oldest** open call (the run cannot advance past it).
   */
  activeTool?: AgentActiveToolStat;
  /** Tool calls started in this run (distinguishes one slow call from a loop). */
  toolCallsThisRun: number;
}

/**
 * Payload of the assistant-only `imb_get_employee_stat` tool when
 * `employeeId` is **omitted**: the state of every real employee participant of
 * the chat in one call.
 *
 * Each entry has exactly the shape of the single-session payload
 * (`EmployeeAgentStat`), so a consumer that understands one understands the
 * other. The assistant itself (id 0) is never listed — bulk mode answers
 * "what are the employees doing in this chat", not "what am I doing".
 */
export interface ChatEmployeeStats {
  chatId: number;
  chatTitle: string;
  /**
   * One entry per employee participant of the chat (deduplicated; employees
   * that never opened a session here are still included, with
   * `sessionExists: false` and no agent output — the roster is complete, an
   * absent employee is never silently dropped).
   */
  employees: EmployeeAgentStat[];
}
