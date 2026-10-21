import type { ThinkingLevel } from "../constants/thinking";

/** Row of the `employees` table. Id 0 is the built-in assistant (reserved). */
export interface Employee {
  id: number;
  name: string;
  role: string;
  systemPrompt: string;
  /** Configured MCP server names (options come from `mcp:list`); may also
   *  carry built-in opt-in markers (see `BUILTIN_*_MARKER` in constants). */
  mcp: string[];
  skills: string[];
  /** Group / department tags assigned to this employee (e.g. "信息检索", "开发功能"). */
  groups: string[];
  modelId: string | null;
  /** Per-employee thinking strength; null = follow the global default. */
  thinkingLevel: ThinkingLevel | null;
  /**
   * Absolute on-disk avatar path (null when none). The renderer turns this into
   * an `imb-file:` URL for display; main never reads the bytes.
   */
  avatar: string | null;
  /**
   * Last-modified time (ms) of the avatar file, used as an `imb-file:` cache key
   * so a same-format re-upload is not masked by the browser's image cache.
   * `null` when there is no avatar (or it could not be stat'ed).
   */
  avatarVersion: number | null;
  /** `true` when the employee is disabled (soft-deleted, still a chat participant). */
  disabled: boolean;
}

/** Result of an employee delete: hard-deleted, disabled (still a chat participant), or missing. */
export type EmployeeDeleteResult = "deleted" | "disabled" | null;

/** Input for creating/updating an employee (fields optional → untouched). */
export interface EmployeeInput {
  name?: string;
  role?: string;
  systemPrompt?: string;
  mcp?: string[];
  skills?: string[];
  groups?: string[];
  modelId?: string | null;
  thinkingLevel?: ThinkingLevel | null;
}

export interface EmployeeRow {
  id: number;
  name: string;
  role: string;
  system_prompt: string;
  mcp: string;
  skills: string;
  groups?: string;
  model_id: string | null;
  thinking_level: string | null;
  avatar: string | null;
  disabled: number;
}

/** One employee in a `set_employees` batch: omit `id` to create, pass `id` to update. */
export interface EmployeeUpsertInput extends EmployeeInput {
  id?: number;
}

/** One employee purged at startup (session file paths captured pre-delete). */
export interface PurgedEmployee {
  employeeId: number;
  sessionPaths: string[];
}

/**
 * One entry for the `[tools]` block's `Available tools` list. The base SDK
 * tools (read/bash/edit/write, plus powershell on Windows) use
 * `BASE_TOOL_SNIPPETS`; custom tools (MCP + team `imb_*`) use their
 * `promptSnippet` (falling back to the description).
 */
export interface EmployeeToolEntry {
  name: string;
  snippet: string;
}

export interface BuildEmployeeSystemPromptArgs {
  /** Persona parts joined before the built-in skills; empty strings dropped.
   *  Assistant: `[ASSISTANT_SYSTEM_PROMPT, employee.systemPrompt]`.
   *  Regular:   `[employee.systemPrompt]`. */
  personaParts: string[];
  /** `true` for the built-in assistant (id 0). The assistant's role text is
   *  baked into `ASSISTANT_SYSTEM_PROMPT`, so no generated role block is emitted
   *  for it. */
  isAssistant: boolean;
  /** Employee display name; used in the generated non-assistant role block. */
  name: string;
  /** Employee role; used in the generated non-assistant role block. */
  role: string;
  /** Employee id (assistant = 0). */
  employeeId: number;
  /** The chat this session runs in; injected into the leading identity block. */
  chatId: number;
  /** Spawning chat for a group chat (`chats.from_chat_id`); null for root
   *  chats. When non-null, a second line in the identity block links back. */
  fromChatId: number | null;
  /** Active tools for this employee-session (core + MCP + team `imb_*`). */
  toolEntries: EmployeeToolEntry[];
  /**
   * The `## Guidelines` bullets for this session. Resolved by the platform-
   * aware caller (`session.ts`) — `TOOLS_GUIDELINES` on macOS/Linux,
   * `WINDOWS_TOOLS_GUIDELINES` on Windows — so this formatter stays
   * platform-agnostic.
   */
  toolsGuidelines: readonly string[];
}
