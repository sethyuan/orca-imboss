import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_GENERATE_IMAGE_MARKER,
  BUILTIN_REMOVE_CRON_MARKER,
  BUILTIN_SET_CRON_MARKER,
  BUILTIN_TOOL_OPTIONS,
} from "@shared/constants/agent_tools";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL,
  MAX_TOOL_ATTACHMENTS,
} from "@shared/constants/attachments";
import { ASSISTANT_ID } from "@shared/constants/employees";
import { IMAGE_GENERATION_ENABLED } from "@shared/constants/image-gen";
import { READ_CHAT_PROMPT } from "@shared/constants/prompts";
import { t } from "@shared/l10n";
import type {
  AgentEnvironment,
  AnyPiTool,
  ChatEmployeeStats,
  CronJob,
  Employee,
  EmployeeAgentStat,
  EmployeeSession,
  Message,
  MessageAttachment,
  MessageKind,
  MessageStep,
  TeamToolOptions,
} from "@shared/types";
import { stat } from "fs/promises";
import { basename, extname, resolve } from "path";
import { Type } from "typebox";
import * as cron from "../cron";
import { getDB } from "../db";
import * as dbChats from "../db/chats";
import { parseCronJobId } from "../db/cron";
import * as dbEmployees from "../db/employees";
import * as dbMessages from "../db/messages";
import * as dbReadCursors from "../db/read-cursors";
import * as dbSessions from "../db/sessions";
import {
  drawIntoImageMessage,
  getImageModelRef,
  imageModelRef,
  normalizeImageSize,
} from "../image-gen";
import { readMcpServers } from "../mcp-store";
import { notifyUnread, sendToRenderer } from "../notifications";
import { materializeSessionFile, sessionPathFor } from "./session-files";
import {
  interruptTurnDiscardingQueue,
  readSessionActivity,
  wakeAgent,
} from "./session-queue";
import {
  buildEmployeeAgentStat,
  readLastAssistantMessage,
} from "./session-stat";
import { listSkills } from "./skills";

/**
 * Imboss built-in team tools.
 *
 * LLM-callable tools that let the assistant orchestrate a team (create/edit
 * employees, create chats, send messages, schedule cron jobs, notify) and let
 * participant agents work inside chats. Backed by a persistent per-(employee,
 * chat) Pi session with a read cursor. The assistant has no session in task
 * group chats: it reads them from its root-chat session on `wakeAgent`.
 *
 * The tool set is role-based: the assistant (employee id 0) gets the
 * orchestration tools (`imb_set_employees`, `imb_create_chat`,
 * `imb_add_participant`, `imb_list_employees`, `imb_toolset`, `imb_notify`,
 * `imb_progress`, `imb_ask`, `imb_get_employee_stat`, `imb_interrupt`) plus
 * `imb_send_message` and `imb_read_chat`; a participant gets
 * `imb_send_message` and `imb_read_chat`, plus `imb_set_cronjob` and/or
 * `imb_remove_cronjob` and/or `imb_generate_image` when the employee opted in
 * via their "Linked MCP" list. The assistant gets those three tools
 * unconditionally: its `mcp` list is immutable, so it can never be gated the
 * way employees are.
 * `imb_progress`, `imb_ask`, `imb_get_employee_stat` and `imb_interrupt` are
 * assistant-only: employees exchange questions and answers as plain text
 * messages, and only the assistant supervises and redirects them. All agent
 * runs are serialized per
 * (employee, chat) via the session queue.
 * `createTeamToolDefinitions` captures the calling agent's identity so
 * `imb_read_chat` knows who is reading and internal sends know who is sending.
 */

const getEmployee = dbEmployees.getEmployee;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  zip: "application/zip",
  gz: "application/gzip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// Session file materialization (`sessionPathFor` / `materializeSessionFile`)
// lives in `./session-files`, shared with the session queue so every run —
// including the assistant's root chat — is persisted. Waking a participant goes
// through `wakeAgent`, which redirects the assistant to its root-chat session.

function mimeByExtension(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Resolve file paths → attachment metadata (name/size/type/path); no previews. */
async function resolveAttachments(
  paths: string[] | undefined,
): Promise<MessageAttachment[] | undefined> {
  if (!paths || paths.length === 0) return undefined;
  if (paths.length > MAX_TOOL_ATTACHMENTS) {
    throw new Error("Too many attachments.");
  }
  const result: MessageAttachment[] = [];
  for (const path of paths) {
    let stats;
    try {
      stats = await stat(path);
    } catch {
      throw new Error(`Attachment file not found: ${path}`);
    }
    if (!stats.isFile()) throw new Error(`Attachment is not a file: ${path}`);
    if (stats.size > MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachment is too large.");
    }
    result.push({
      name: basename(path),
      size: stats.size,
      type: mimeByExtension(path),
      // Store an absolute path (matching how `stat` resolved it) so the file
      // can later be revealed in the OS file manager.
      path: resolve(path),
    });
  }
  return result;
}

/**
 * Shared send pipeline used by the `send_message` tool and by internal sends
 * (`create_chat`, `add_participant`).
 *
 * The tool enforces that the sender is an active non-disabled participant of
 * the chat; internal sends pass `skipSenderCheck` so the orchestrating
 * assistant can post without being a participant of the target chat.
 */
async function performSendMessage(
  _env: AgentEnvironment,
  input: {
    senderEmployeeId: number;
    chatId: number;
    kind?: string;
    content: string;
    steps?: MessageStep[];
    /** Task group a `progress` card links to (required alongside `steps`). */
    groupChatId?: number;
    attachments?: string[];
    attachmentTotal?: number;
    /** Participants to wake; `null`/absent means nobody is woken. */
    notify?: number[] | null;
    notifyPrompt?: string;
    skipSenderCheck?: boolean;
  },
): Promise<Message> {
  const chat = dbChats.getChat(input.chatId);
  if (!chat) throw new Error("Chat does not exist.");
  if (
    !input.skipSenderCheck &&
    !chat.participants.includes(input.senderEmployeeId)
  ) {
    throw new Error("Sender is not a participant of this chat.");
  }
  const sender = dbEmployees.getEmployee(input.senderEmployeeId);
  if (!sender || sender.disabled) {
    throw new Error("Sender is not an active employee.");
  }
  const attachments = await resolveAttachments(input.attachments);
  const message = dbMessages.appendMessage(
    input.chatId,
    input.senderEmployeeId,
    input.content,
    {
      kind: input.kind ?? "text",
      steps: input.steps,
      groupChatId: input.groupChatId,
      attachments,
      attachmentTotal: input.attachmentTotal,
    },
  );

  for (const pid of input.notify ?? []) {
    if (!chat.participants.includes(pid)) continue;
    const target = dbEmployees.getEmployee(pid);
    if (!target || target.disabled) continue;
    // `wakeAgent` redirects the assistant (id 0) from a task group chat to its
    // root-chat session; participants run in their own (pid, chat) session.
    // A mention is a human-directed wake: steer the target's live run instead
    // of waiting for it to settle (falls back to the queue when idle).
    await wakeAgent(pid, input.chatId, input.notifyPrompt ?? READ_CHAT_PROMPT, {
      mode: "steer",
    });
  }
  return message;
}

/**
 * Wrap a tool payload as a Pi text tool result.
 *
 * `details` is deliberately empty: the SDK never sends it to the model and no
 * app code reads it, yet it is persisted in the session file — mirroring the
 * payload there would double every tool result. Only `content` is meaningful,
 * so the model receives `JSON.stringify(value)` once.
 */
function toolResult(value: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: {},
  };
}

/**
 * Slim employee projection: keeps what the orchestrator uses (id for
 * @-mentions/notify, name for step cards, role/skills/mcp to judge fit) and
 * drops the rest — notably the `avatar` path. The full `systemPrompt` is only
 * attached when the caller explicitly opts in (`withSystemPrompt`), which the
 * assistant uses solely to read an employee's current persona before editing it
 * at the boss's request.
 */
interface EmployeeBrief {
  id: number;
  name: string;
  role: string;
  skills: string[];
  mcp: string[];
  /** Present only when the caller passed `withSystemPrompt: true`. */
  systemPrompt?: string;
}

function toEmployeeBrief(
  employee: Employee,
  withSystemPrompt = false,
): EmployeeBrief {
  const brief: EmployeeBrief = {
    id: employee.id,
    name: employee.name,
    role: employee.role,
    skills: employee.skills,
    mcp: employee.mcp,
  };
  if (withSystemPrompt) brief.systemPrompt = employee.systemPrompt;
  return brief;
}

/**
 * Catalog of values the assistant may assign to an employee's `mcp` / `skills`.
 * MCP servers expose only their name and description — never `config`, which
 * holds `env`/`headers` secrets; choosing a server does not require them.
 */
interface AssignmentCapabilities {
  skills: Array<{ name: string; description: string | null }>;
  mcpServers: Array<{ name: string; description: string }>;
  builtinToolOptions: Array<{
    value: string;
    label: string;
    description: string;
  }>;
}

/** Build the assignable-capability catalog from on-disk app state. */
async function loadAssignmentCapabilities(): Promise<AssignmentCapabilities> {
  const skills = (await listSkills()).map((skill) => ({
    name: skill.name,
    description: skill.description,
  }));
  const mcpServers = readMcpServers()
    .map((server) => ({ name: server.name, description: server.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const builtinToolOptions = BUILTIN_TOOL_OPTIONS.map((option) => ({
    ...option,
  }));
  return { skills, mcpServers, builtinToolOptions };
}

/** Cap on the valid options enumerated in a validation error message. */
const MAX_VALID_OPTIONS_IN_ERROR = 50;

function formatValidOptions(options: string[]): string {
  if (options.length === 0) return "(none)";
  const shown = options.slice(0, MAX_VALID_OPTIONS_IN_ERROR);
  return options.length > shown.length
    ? `${shown.join(", ")}, …`
    : shown.join(", ");
}

/**
 * Reject `mcp` / `skills` entries that do not correspond to a configured MCP
 * server, a built-in tool option, or an installed skill. The session composes
 * its tool/skill set by filtering, so an unknown value is silently ineffective;
 * failing loudly with the valid options lets the model correct itself at once.
 */
function assertAssignableRefs(
  item: { mcp?: string[]; skills?: string[] },
  capabilities: AssignmentCapabilities,
): void {
  if (item.mcp !== undefined) {
    const valid = new Set<string>([
      ...capabilities.mcpServers.map((server) => server.name),
      ...capabilities.builtinToolOptions.map((option) => option.value),
    ]);
    const unknown = [...new Set(item.mcp)].filter((value) => !valid.has(value));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown MCP entries: ${unknown.join(", ")}. Valid values: ${formatValidOptions([...valid])}.`,
      );
    }
  }
  if (item.skills !== undefined) {
    const valid = new Set(capabilities.skills.map((skill) => skill.name));
    const unknown = [...new Set(item.skills)].filter(
      (value) => !valid.has(value),
    );
    if (unknown.length > 0) {
      throw new Error(
        `Unknown skills: ${unknown.join(", ")}. Valid skills: ${formatValidOptions([...valid])}.`,
      );
    }
  }
}

/** Slim message projection; `steps`/`attachments` are omitted when absent. */
interface MessageBrief {
  id: number;
  senderEmployeeId: number | null;
  kind: MessageKind;
  content: string;
  steps?: MessageStep[];
  /** Task group the card reports on; forwarded so a later progress update can reuse it. */
  groupChatId?: number;
  attachments?: MessageAttachment[];
  /** True attachment count when it exceeds the metadata rows forwarded. */
  attachmentsTotal?: number;
  createdAt: number;
}

function toMessageBrief(message: Message): MessageBrief {
  const brief: MessageBrief = {
    id: message.id,
    senderEmployeeId: message.senderEmployeeId,
    kind: message.kind,
    content: message.content,
    createdAt: message.createdAt,
  };
  if (message.steps && message.steps.length > 0) brief.steps = message.steps;
  if (message.groupChatId !== null) brief.groupChatId = message.groupChatId;
  if (message.attachments && message.attachments.length > 0) {
    // Forward the on-disk `path` too: the model has filesystem tools and needs
    // the location to read the attached file. Paths are captured by the app
    // (picker via `webUtils`, tool attachments via `resolve`), never invented
    // by the model, and are only exposed to agents that may already read the
    // chat.
    brief.attachments = message.attachments.map((attachment) => ({
      name: attachment.name,
      size: attachment.size,
      type: attachment.type,
      ...(attachment.path ? { path: attachment.path } : {}),
      // A conversation attachment is a reference: forward its id so the reader
      // can `imb_read_chat` it in full (`full: true`).
      ...(attachment.kind === "chat" && typeof attachment.chatId === "number"
        ? { kind: "chat" as const, chatId: attachment.chatId }
        : {}),
    }));
    if (
      message.attachmentsTotal !== null &&
      message.attachmentsTotal > message.attachments.length
    ) {
      brief.attachmentsTotal = message.attachmentsTotal;
    }
  }
  return brief;
}

/** Slim cron job projection: enough to confirm the schedule, no echoed content. */
interface CronJobBrief {
  id: string;
  schedule: string;
  nextRunAt: number | null;
}

function toCronJobBrief(job: CronJob): CronJobBrief {
  return { id: job.id, schedule: job.schedule, nextRunAt: job.nextRunAt };
}

/** Validate an employee id is an active (non-disabled) employee. */
function assertActiveEmployee(employeeId: number): void {
  const employee = getEmployee(employeeId);
  if (!employee || employee.disabled) {
    throw new Error(`Employee ${employeeId} is not an active employee.`);
  }
}

/**
 * Display name for orchestration messages: `#ID name`, or `#ID` for an
 * unnamed employee. Matches the employee list/detail `#ID` convention.
 */
function employeeDisplayName(employeeId: number): string {
  const name = getEmployee(employeeId)?.name.trim() ?? "";
  return name.length > 0 ? `#${employeeId} ${name}` : `#${employeeId}`;
}

/**
 * Record one Pi session per employee participant of a chat and return the
 * records to materialize after commit.
 *
 * Must be called inside a DB transaction: the synchronous `setSession` writes
 * join the caller's transaction. The assistant is deliberately skipped — it has
 * no session in a task group chat and reads it from its root-chat session
 * instead. The on-disk files are materialized separately/best-effort by
 * `materializeSessions`, so a file problem never rolls back committed DB.
 */
function recordParticipantSessions(
  chatId: number,
  employeeIds: number[],
): EmployeeSession[] {
  const records: EmployeeSession[] = [];
  for (const pid of employeeIds) {
    if (pid === ASSISTANT_ID) continue;
    const path = sessionPathFor(chatId, pid);
    dbSessions.setSession(pid, chatId, path);
    records.push({ employeeId: pid, chatId, session: path });
  }
  return records;
}

/** Materialize recorded session files; best-effort, never rolls back the DB. */
async function materializeSessions(records: EmployeeSession[]): Promise<void> {
  await Promise.all(
    records.map((r) =>
      materializeSessionFile(r.session).catch(() => undefined),
    ),
  );
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

/** `imb_set_employees` — batch create (omit `id`) or update (pass `id`) employees. */
function setEmployeesTool(): AnyPiTool {
  return {
    name: "imb_set_employees",
    label: "Set employees",
    description:
      "Batch create or update employees (name, role, system prompt, linked MCP servers, skills, model, thinking level). " +
      "Each item omits `id` to create a new employee or passes `id` to update an existing one. " +
      "`id: 0` targets the built-in assistant itself (self-edit) and is only allowed when the boss explicitly asks; " +
      "the assistant's `role` and `mcp` are immutable. " +
      "`mcp` and `skills` entries must come from the catalog returned by `imb_toolset`; " +
      "any value outside it is rejected. Returns the array of employee ids created or updated.",
    promptSnippet: "batch create/edit employees",
    parameters: Type.Object({
      employees: Type.Array(
        Type.Object({
          id: Type.Optional(
            Type.Integer({
              minimum: 0,
              description:
                "Omit to create a new employee; pass an existing employee's id to update it. `0` targets the built-in assistant itself (self-edit), only at the boss's explicit request; its `role`/`mcp` cannot be changed.",
            }),
          ),
          name: Type.Optional(Type.String({ maxLength: 200 })),
          role: Type.Optional(Type.String({ maxLength: 200 })),
          systemPrompt: Type.Optional(Type.String({ maxLength: 100000 })),
          mcp: Type.Optional(
            Type.Array(Type.String({ maxLength: 256 }), {
              maxItems: 256,
              description:
                "Names of configured MCP servers combined with built-in tool option values, as one list (see `imb_toolset`: `mcp` server names + `builtinTools` values).",
            }),
          ),
          skills: Type.Optional(
            Type.Array(Type.String({ maxLength: 256 }), {
              maxItems: 256,
              description:
                "Names of installed skills to assign (see `imb_toolset`: `skills`).",
            }),
          ),
          modelId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          thinkingLevel: Type.Optional(
            Type.Union([
              Type.Literal("off"),
              Type.Literal("low"),
              Type.Literal("medium"),
              Type.Literal("high"),
              Type.Literal("xhigh"),
              Type.Literal("max"),
              Type.Null(),
            ]),
          ),
        }),
        { minItems: 1, maxItems: 50 },
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        employees: {
          id?: number;
          name?: string;
          role?: string;
          systemPrompt?: string;
          mcp?: string[];
          skills?: string[];
          modelId?: string | null;
          thinkingLevel?:
            "off" | "low" | "medium" | "high" | "xhigh" | "max" | null;
        }[];
      };
      // Reject invented MCP/skill names: the session composes its tools and
      // skills by filtering, so a value that does not resolve would be stored
      // but never take effect. The catalog is only read when needed.
      if (
        input.employees.some(
          (item) => item.mcp !== undefined || item.skills !== undefined,
        )
      ) {
        const capabilities = await loadAssignmentCapabilities();
        for (const item of input.employees) {
          assertAssignableRefs(item, capabilities);
        }
      }
      const ids = dbEmployees.upsertEmployees(
        input.employees.map((item) => ({ ...item })),
      );
      // The renderer caches employees for chat avatars/names; let it refresh so
      // newly recruited staff show up without visiting the Employees module.
      if (ids.length > 0) sendToRenderer("employees:changed", { ids });
      return toolResult({ ids });
    },
  };
}

/** `imb_create_chat` — new chat + one persistent session per employee. */
function createChatTool(
  env: AgentEnvironment,
  callingChatId: number,
): AnyPiTool {
  return {
    name: "imb_create_chat",
    label: "Create chat",
    description:
      "Create a new chat with the given title and employee participants, initializing one persistent agent session per employee participant " +
      "(the assistant orchestrates from its own root-chat session and gets no session here). " +
      "The assistant always joins, and the chat that spawned this one is linked as `from_chat_id`. " +
      "Participants are NOT notified or started automatically — assign their work afterwards with `imb_send_message`, " +
      "passing their ids in `notify` to wake them.",
    promptSnippet: "new team chat",
    parameters: Type.Object({
      title: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Descriptive title for the new chat.",
      }),
      participants: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        title: string;
        participants: number[];
      };
      for (const pid of input.participants) assertActiveEmployee(pid);

      // The spawning chat must exist so the new chat can link back to it.
      // Validate before committing anything so a bad id never half-creates a
      // chat.
      if (!dbChats.getChat(callingChatId)) {
        throw new Error("Spawning chat does not exist.");
      }

      // The assistant joins every task chat it creates so participants can
      // notify it and it can post through the normal `imb_send_message` path.
      const participants = [...new Set([ASSISTANT_ID, ...input.participants])];

      const db = getDB();
      // Atomic: chat row + one session row per employee participant commit
      // together. The assistant is deliberately skipped (see
      // `recordParticipantSessions`).
      const { chat, sessionRecords } = db.transaction(() => {
        const chat = dbChats.createChat(input.title, participants, {
          fromChatId: callingChatId,
        });
        return {
          chat,
          sessionRecords: recordParticipantSessions(chat.id, chat.participants),
        };
      })();

      // Best-effort: materialize session files; never roll back committed DB.
      await materializeSessions(sessionRecords);

      // Link the new chat back to its spawning chat with a `chat`-kind card.
      // No `notify` on purpose: creating a chat must NOT start any participant's
      // agent. They are woken only when an assignment reaches them through
      // `imb_send_message` with a `notify` list.
      await performSendMessage(env, {
        senderEmployeeId: ASSISTANT_ID,
        chatId: callingChatId,
        kind: "chat",
        content: String(chat.id),
        skipSenderCheck: true,
      });

      return toolResult({
        chatId: chat.id,
        participants: chat.participants,
      });
    },
  };
}

/**
 * Cap on the participants one `imb_send_message` call may wake. Shared by the
 * parameter schema and the raw-argument guard so both agree.
 */
const MAX_NOTIFY_IDS = 64;

/**
 * Guard the raw `notify` argument before the SDK coerces it.
 *
 * Tool arguments are run through `Value.Convert` before they are validated,
 * and its conversions are lossy for this field: `""` becomes `[0]`,
 * `[1, null]` becomes `[1, 0]` and `"null"` becomes `null`. A coerced `0`
 * silently wakes the assistant (id 0) — a notification nobody asked for — so a
 * malformed `notify` must fail loudly instead. This never repairs the value nor
 * fills a missing one: an absent `notify` is left to the schema's `required`.
 *
 * Throws a message the model can act on; the SDK turns it into an error tool
 * result (see `prepareToolCall`), so the next call can be corrected.
 */
function assertRawNotify(rawArgs: unknown): void {
  if (typeof rawArgs !== "object" || rawArgs === null) return;
  const args = rawArgs as Record<string, unknown>;
  // `hasOwnProperty` (not `in`): only an explicitly passed key is inspected.
  if (!Object.prototype.hasOwnProperty.call(args, "notify")) return;
  const notify = args.notify;
  // `null` is the documented "wake nobody" value; `[]` means the same thing and
  // is deliberately accepted rather than rejected as a shape error.
  if (notify === null) return;
  if (!Array.isArray(notify)) {
    throw new Error(
      "Invalid `notify`: pass an array of employee ids, or `null` when nobody should be woken " +
        "(e.g. a message for the boss).",
    );
  }
  if (notify.length > MAX_NOTIFY_IDS) {
    throw new Error(
      `Invalid \`notify\`: at most ${MAX_NOTIFY_IDS} ids are allowed.`,
    );
  }
  for (const id of notify) {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
      throw new Error(
        `Invalid \`notify\` entry ${JSON.stringify(id)}: ids must be non-negative integers. ` +
          "Pass `null` when nobody should be woken.",
      );
    }
  }
}

/** `imb_send_message` — post as an active participant, waking the listed participants. */
function sendMessageTool(env: AgentEnvironment): AnyPiTool {
  return {
    name: "imb_send_message",
    label: "Send message",
    description:
      "Send a message into a chat as one of the active participants, with optional file-path attachments " +
      "(at most 5; pass `attachmentTotal` when more files were produced) and notifications to other " +
      "participants. `kind` is `text` (the default) or `report` to report a finished task's result. " +
      "`notify` is required: pass the ids of the participants that must be woken, or `null` when nobody " +
      "should be woken.",
    promptSnippet: "post to a chat",
    parameters: Type.Object({
      senderEmployeeId: Type.Integer({ minimum: 0 }),
      chatId: Type.Integer({ minimum: 1 }),
      kind: Type.Optional(
        Type.Union([Type.Literal("text"), Type.Literal("report")]),
      ),
      content: Type.String({ minLength: 1, maxLength: 100000 }),
      attachments: Type.Optional(
        Type.Array(Type.String(), { maxItems: MAX_TOOL_ATTACHMENTS }),
      ),
      attachmentTotal: Type.Optional(
        Type.Integer({ minimum: 0, maximum: MAX_ATTACHMENT_TOTAL }),
      ),
      // Required, and nullable on purpose: notifying someone is a decision the
      // caller has to make explicit (an assignment with no `notify` stays
      // unread), while `null` states "wake nobody" without faking an id.
      notify: Type.Union(
        [
          Type.Array(Type.Integer({ minimum: 0 }), {
            maxItems: MAX_NOTIFY_IDS,
          }),
          Type.Null(),
        ],
        {
          description:
            "Participants to wake. Pass their ids when someone has to react (an assignment, a note to a " +
            "teammate, a report back to whoever assigned the work); pass `null` when nobody should be " +
            "woken (e.g. a message for the boss). `[]` means the same as `null`.",
        },
      ),
    }),
    // Reject a malformed raw `notify` before the SDK's coercion can turn it
    // into a bogus id; validation then runs on the untouched arguments.
    prepareArguments: (args) => {
      assertRawNotify(args);
      return args;
    },
    execute: async (_toolCallId, params) => {
      const input = params as {
        senderEmployeeId: number;
        chatId: number;
        kind?: "text" | "report";
        content: string;
        attachments?: string[];
        attachmentTotal?: number;
        notify: number[] | null;
      };
      const message = await performSendMessage(env, {
        senderEmployeeId: input.senderEmployeeId,
        chatId: input.chatId,
        kind: input.kind ?? "text",
        content: input.content,
        attachments: input.attachments,
        attachmentTotal: input.attachmentTotal,
        notify: input.notify,
      });
      return toolResult({ id: message.id });
    },
  };
}

/**
 * `imb_progress` — assistant-only: post a task-progress card into a chat.
 *
 * Split out of `imb_send_message` so publishing progress has a dedicated,
 * typed tool: the sender is always the assistant (id 0), the card links to the
 * task group it reports on (`groupChatId`, rendered as the card's title link),
 * and it neither notifies anyone nor carries attachments. Registered only for
 * the assistant in `createTeamToolDefinitions`; the shared send pipeline keeps
 * its participant check, which the assistant satisfies in every chat it posts
 * to.
 */
function progressTool(env: AgentEnvironment): AnyPiTool {
  return {
    name: "imb_progress",
    label: "Post progress",
    description:
      "Post a task-progress card into a chat as the assistant. `chatId` is the chat the card is " +
      "posted into (the boss's chat) and `groupChatId` is the task group the card reports on — the " +
      "card links to that group so the boss can open it. `content` is the card title and `steps` is " +
      "the full, current step list (one step per employee, each carrying that employee's " +
      "`employeeId`, that employee's `name`, and a `task` — a short phrase saying what that employee " +
      "is doing on this step, not their role/title; `status` `pending` before work is assigned, " +
      "`busy` once it is assigned and running, `done` when finished). Always resend the whole list " +
      "on every update; no participant is notified.",
    promptSnippet: "post a progress card",
    parameters: Type.Object({
      chatId: Type.Integer({ minimum: 1 }),
      groupChatId: Type.Integer({ minimum: 1 }),
      content: Type.String({ minLength: 1, maxLength: 100000 }),
      steps: Type.Array(
        Type.Object({
          name: Type.String({ minLength: 1, maxLength: 256 }),
          task: Type.String({
            minLength: 1,
            maxLength: 256,
            description:
              'What this employee does on this step, as a short phrase (e.g. "write the migration") — not their role/title.',
          }),
          employeeId: Type.Integer({ minimum: 0 }),
          status: Type.Union([
            Type.Literal("done"),
            Type.Literal("busy"),
            Type.Literal("pending"),
          ]),
        }),
        { minItems: 1, maxItems: 64 },
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        chatId: number;
        groupChatId: number;
        content: string;
        steps: MessageStep[];
      };
      // Validate the link and every step employee before anything is written:
      // a dangling id would render as a dead click target the model can no
      // longer repair, so it must be corrected in this call instead.
      if (!dbChats.getChat(input.groupChatId)) {
        throw new Error(`Chat ${input.groupChatId} does not exist.`);
      }
      for (const step of input.steps) {
        const employeeId = step.employeeId ?? -1;
        if (!dbEmployees.getEmployee(employeeId)) {
          throw new Error(`Employee ${employeeId} does not exist.`);
        }
      }
      const message = await performSendMessage(env, {
        senderEmployeeId: ASSISTANT_ID,
        chatId: input.chatId,
        kind: "progress",
        content: input.content,
        steps: input.steps,
        groupChatId: input.groupChatId,
      });
      return toolResult({ id: message.id });
    },
  };
}

/**
 * Safety cap for a `full` (whole-conversation) `imb_read_chat` read. A real
 * conversation read is uncursored, so the cap only guards against a
 * pathologically long chat; when it is hit the model is told via `hasMore`.
 */
const MAX_FULL_CHAT_MESSAGES = 1000;

/**
 * `imb_read_chat` — advance the calling agent's cursor and return new messages,
 * or (`full: true`) read one whole attached conversation without touching it.
 */
function readChatTool(employeeId: number, callingChatId: number): AnyPiTool {
  return {
    name: "imb_read_chat",
    label: "Read chat",
    description:
      "Read the latest messages in a chat (after your read cursor) and advance that cursor. " +
      "For a conversation attached to this chat, pass `full: true` to read its entire history; a " +
      "`full` read ignores and does not advance your read cursor. When a `full` read returns " +
      "`hasMore: true`, repeat the call with `after: <nextAfter>` to continue where it stopped.",
    promptSnippet: "consume new messages",
    parameters: Type.Object({
      chatId: Type.Integer({ minimum: 1 }),
      full: Type.Optional(
        Type.Boolean({
          description:
            "Read the chat's entire history, ignoring your read cursor. Only allowed for a conversation attached to this chat; the cursor is not advanced.",
        }),
      ),
      after: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Only with `full: true`: read messages after this id (pass the previous page's `nextAfter`). Omit to start from the beginning.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        chatId: number;
        full?: boolean;
        after?: number;
      };
      const chat = dbChats.getChat(input.chatId);
      if (!chat) throw new Error("Chat does not exist.");

      if (input.after !== undefined && input.full !== true) {
        throw new Error("`after` is only valid together with `full: true`.");
      }

      if (input.full === true) {
        // `full` is a convenience for a conversation the boss attached to this
        // chat at some point — never a way to slurp any chat's whole history.
        // Authorize against the chat attachments of the chat's user messages.
        const attachedIds = dbMessages.listAttachedChatIds(callingChatId);
        if (!attachedIds.includes(input.chatId)) {
          throw new Error(
            "full reads are only allowed for a conversation attached to this chat.",
          );
        }
        const { messages, hasMore, nextAfter } = listWholeChat(
          input.chatId,
          input.after ?? 0,
        );
        return toolResult({
          from: chat.fromChatId,
          full: true,
          hasMore,
          ...(nextAfter !== null ? { nextAfter } : {}),
          // App-generated receipt acks are noise for the model.
          messages: messages
            .filter((message) => message.kind !== "ack")
            .map(toMessageBrief),
        });
      }

      // Cursors live in their own table: the assistant reads task group chats
      // from its root-chat session and has no `sessions` row there.
      const cursor = dbReadCursors.getReadCursor(employeeId, input.chatId);
      const messages = dbMessages.listMessagesAfter(input.chatId, cursor);
      const nextCursor =
        messages.length > 0
          ? Math.max(...messages.map((message) => message.id))
          : cursor;
      if (nextCursor !== cursor) {
        dbReadCursors.setReadCursor(employeeId, input.chatId, nextCursor);
      }
      return toolResult({
        from: chat.fromChatId,
        // App-generated receipt acks are noise for the model; the cursor above
        // still advances past them so they are never re-read.
        messages: messages
          .filter((message) => message.kind !== "ack")
          .map(toMessageBrief),
      });
    },
  };
}

/**
 * Read a slice of a chat in conversation order (after `after`, defaults to the
 * beginning) up to `MAX_FULL_CHAT_MESSAGES`, paging the per-id query so a huge
 * chat is never loaded in one shot. When the cap is reached with messages still
 * remaining, `hasMore` is true and `nextAfter` is the last returned id — pass it
 * back as `after` to continue.
 */
function listWholeChat(
  chatId: number,
  after: number,
): { messages: Message[]; hasMore: boolean; nextAfter: number | null } {
  const messages: Message[] = [];
  let cursor = after;
  while (messages.length < MAX_FULL_CHAT_MESSAGES) {
    const page = dbMessages.listMessagesAfter(
      chatId,
      cursor,
      Math.min(200, MAX_FULL_CHAT_MESSAGES - messages.length),
    );
    if (page.length === 0) break;
    messages.push(...page);
    cursor = page[page.length - 1].id;
    if (page.length < 200) break;
  }
  const hasMore =
    messages.length >= MAX_FULL_CHAT_MESSAGES &&
    dbMessages.listMessagesAfter(chatId, cursor, 1).length > 0;
  return {
    messages,
    hasMore,
    nextAfter: hasMore ? messages[messages.length - 1].id : null,
  };
}

/** `imb_list_employees` — active employees, optionally with their system prompts. */
function listEmployeesTool(): AnyPiTool {
  return {
    name: "imb_list_employees",
    label: "List employees",
    description:
      "List all active employees (excluding the built-in assistant), ordered by id, " +
      "or pass `employeeID` to fetch a single active employee — including `0`, the built-in assistant itself. " +
      "A single-employee fetch always includes that employee's current `systemPrompt`. " +
      "For the full list, pass `withSystemPrompt: true` to also include each employee's current `systemPrompt`; " +
      "use this only before editing an employee's description at the boss's request. " +
      "Call `imb_toolset` for the `mcp` / `skills` values assignable via `imb_set_employees`.",
    promptSnippet: "team members",
    parameters: Type.Object({
      employeeID: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Fetch only this employee (must be active). `0` fetches the built-in assistant's own record; the result always includes `systemPrompt`.",
        }),
      ),
      withSystemPrompt: Type.Optional(
        Type.Boolean({
          description:
            "Include each employee's current `systemPrompt` in the list result. Ignored when `employeeID` is set (that always includes it). Use only before editing an employee's description at the boss's explicit request.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        employeeID?: number;
        withSystemPrompt?: boolean;
      };
      if (input.employeeID !== undefined) {
        const employee = dbEmployees.getEmployee(input.employeeID);
        if (!employee || employee.disabled) {
          throw new Error(
            `Employee ${input.employeeID} is not an active employee.`,
          );
        }
        return toolResult({ employees: [toEmployeeBrief(employee, true)] });
      }
      const withSystemPrompt = input.withSystemPrompt ?? false;
      const employees = dbEmployees
        .listEmployees()
        .filter((employee) => employee.id !== ASSISTANT_ID)
        .map((employee) => toEmployeeBrief(employee, withSystemPrompt));
      return toolResult({ employees });
    },
  };
}

/**
 * `imb_toolset` — the assignable capability catalog for the assistant.
 *
 * Deliberately separate from `imb_list_employees`: deciding who should do a task
 * only needs the employee roster, while choosing MCP servers / built-in tools /
 * skills is only needed when recruiting or editing an employee. The catalog
 * exposes MCP `name` + `description` only — never `config`, which holds
 * `env`/`headers` secrets.
 */
function toolsetTool(): AnyPiTool {
  return {
    name: "imb_toolset",
    label: "List toolset",
    description:
      "List the capabilities that can be assigned to an employee: the configured MCP " +
      "servers (`mcp`), the built-in tool options (`builtinTools`), and the installed " +
      "`skills`. An employee's `mcp` array combines the `mcp` server names with the " +
      "`builtinTools` `value`s; `skills` fills the `skills` array. Call this before " +
      "`imb_set_employees` to choose valid values for a new (or edited) employee.",
    promptSnippet: "assignable MCP / built-in tools / skills",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params) => {
      const { skills, mcpServers, builtinToolOptions } =
        await loadAssignmentCapabilities();
      return toolResult({
        mcp: mcpServers,
        builtinTools: builtinToolOptions,
        skills,
      });
    },
  };
}

/** `imb_notify` — bump a chat's unread and optionally raise an OS notification. */
function notifyTool(): AnyPiTool {
  return {
    name: "imb_notify",
    label: "Notify",
    description:
      "Add a non-negative delta to a chat's unread counter and, when the app window " +
      "is not focused, show an OS notification that focuses the app and jumps to that chat.",
    promptSnippet: "bump unread / OS notification",
    parameters: Type.Object({
      chatId: Type.Integer({ minimum: 1 }),
      unread: Type.Integer({ minimum: 0 }),
      text: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { chatId: number; unread: number; text: string };
      const chat = dbChats.getChat(input.chatId);
      if (!chat) throw new Error("Chat does not exist.");
      const newUnread = notifyUnread(input.chatId, input.unread, input.text);
      return toolResult({ chatId: input.chatId, unread: newUnread });
    },
  };
}

/**
 * `imb_set_cronjob` — create/update a scheduled task.
 *
 * A participant (non-assistant) may only schedule for themselves, within a
 * chat they participate in; the assistant (id 0) remains unrestricted.
 */
function setCronjobTool(employeeId: number): AnyPiTool {
  return {
    name: "imb_set_cronjob",
    label: "Set cron job",
    description:
      "Create or update a scheduled task. The id is a composite `chatId/employeeId/jobId`. " +
      "On each trigger the content is delivered to the (employee, chat) agent session; " +
      "the agent must post its result with `imb_send_message`.",
    promptSnippet: "schedule a task",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 256 }),
      schedule: Type.String({ minLength: 1, maxLength: 128 }),
      content: Type.String({ minLength: 1, maxLength: 100000 }),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        id: string;
        schedule: string;
        content: string;
      };
      const parsed = parseCronJobId(input.id);
      if (employeeId !== ASSISTANT_ID) {
        if (parsed.employeeId !== employeeId) {
          throw new Error("An employee can only schedule their own cron job.");
        }
        const chat = dbChats.getChat(parsed.chatId);
        if (!chat || !chat.participants.includes(employeeId)) {
          throw new Error(
            "An employee can only schedule cron jobs for chats they participate in.",
          );
        }
      }
      const job = cron.setJob({
        id: input.id,
        chatId: parsed.chatId,
        employeeId: parsed.employeeId,
        schedule: input.schedule,
        content: input.content,
      });
      return toolResult(toCronJobBrief(job));
    },
  };
}

/**
 * `imb_remove_cronjob` — delete a scheduled task by id.
 *
 * A participant may only remove their own cron jobs; the assistant can remove any.
 */
function removeCronjobTool(employeeId: number): AnyPiTool {
  return {
    name: "imb_remove_cronjob",
    label: "Remove cron job",
    description: "Delete a scheduled task by its id.",
    promptSnippet: "delete a scheduled task",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 256 }),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { id: string };
      if (employeeId !== ASSISTANT_ID) {
        const parsed = parseCronJobId(input.id);
        if (parsed.employeeId !== employeeId) {
          throw new Error("An employee can only remove their own cron job.");
        }
      }
      return toolResult({ removed: cron.removeJob(input.id) });
    },
  };
}

/** `imb_add_participant` — add members to a chat and prepare their sessions. */
function addParticipantTool(env: AgentEnvironment): AnyPiTool {
  return {
    name: "imb_add_participant",
    label: "Add participant",
    description:
      "Add participants to an existing chat and initialize one persistent agent " +
      "session per new participant. A join notice is posted into " +
      "the chat. New participants are NOT notified or started automatically — " +
      "assign their work afterwards with `imb_send_message`, passing their ids in " +
      "`notify` to wake them.",
    promptSnippet: "add members to a chat",
    parameters: Type.Object({
      chatId: Type.Integer({ minimum: 1 }),
      participants: Type.Array(
        Type.Object({
          employeeID: Type.Integer({ minimum: 1 }),
        }),
        { minItems: 1 },
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        chatId: number;
        participants: { employeeID: number }[];
      };
      const chat = dbChats.getChat(input.chatId);
      if (!chat) throw new Error("Chat does not exist.");

      // Only genuinely-new, active employees are added; dedupe defensively.
      const add = [
        ...new Set(
          input.participants
            .map((p) => p.employeeID)
            .filter((id) => !chat.participants.includes(id)),
        ),
      ];
      for (const id of add) assertActiveEmployee(id);
      if (add.length === 0) {
        return toolResult({ chatId: chat.id, added: [] });
      }

      // Atomic: the participant edit + one session row per new participant
      // commit together. The assistant is skipped by the helper — it has no
      // session in a task group chat and reads it from its root-chat session.
      const { updated, sessionRecords } = getDB().transaction(() => {
        const updated = dbChats.updateChatParticipants(input.chatId, { add });
        if (!updated) throw new Error("Chat does not exist.");
        return {
          updated,
          sessionRecords: recordParticipantSessions(updated.id, add),
        };
      })();

      // Best-effort: materialize session files; never roll back committed DB.
      await materializeSessions(sessionRecords);

      // Join notice with the new members' `#ID name` display names. No `notify`
      // on purpose: adding members must NOT start any participant's agent. They
      // are woken only when an assignment reaches them through
      // `imb_send_message` with a `notify` list.
      const names = add.map(employeeDisplayName);
      await performSendMessage(env, {
        senderEmployeeId: ASSISTANT_ID,
        chatId: updated.id,
        kind: "text",
        content: t("New participant(s) joined: ${names}", {
          names: names.join(", "),
        }),
        skipSenderCheck: true,
      });

      return toolResult({ chatId: updated.id, added: add });
    },
  };
}

/**
 * `imb_ask` — assistant-only: post a structured question set for the boss.
 *
 * Reserved for decisions only the boss can make. The sender is always the
 * assistant (id 0) and there is no `notify` — the boss is a human, not an
 * employee. The assistant alerts the boss with a separate `imb_notify` call
 * after posting. The boss answers through the AskCard UI, which appends a
 * `kind:"answer"` message and wakes the assistant.
 *
 * The card always offers an "additional notes" field after the last question,
 * so an answer may carry a top-level `supplement` string next to `answers`: the
 * boss's instructions *beyond* the questions (absent when left empty). It is
 * part of the answer and must be honoured — see the tool description.
 */
function askTool(env: AgentEnvironment): AnyPiTool {
  return {
    name: "imb_ask",
    label: "Ask the boss",
    description:
      "Post a question set for the boss into a chat. Each question offers candidate options " +
      "and/or a free-form answer; the message body is the JSON serialization of the question set. " +
      "Each question's `type` picks the answer mode: `single` renders radio buttons (one choice), " +
      "`multiple` renders checkboxes (several choices), and `free` renders a free-text field (also " +
      "used when a question has no `options`). When `options` are given but `type` is omitted, the " +
      "question defaults to `multiple` (checkboxes). The boss answers through the question card, " +
      "delivered back as an `answer` message; call `imb_notify` afterwards so the boss is alerted. " +
      'The card always shows an "additional notes" field after the last question, so the answer ' +
      "may also carry a top-level `supplement` string next to `answers`: extra instructions the boss " +
      "wrote beyond the questions (absent when empty, and the only content when they answered no " +
      "question). Treat `supplement` as part of the answer and follow it. " +
      "Attachments are capped at 5; pass `attachmentTotal` when more files were produced.",
    promptSnippet: "ask the boss a question set",
    parameters: Type.Object({
      chatId: Type.Integer({ minimum: 1 }),
      questions: Type.Object({
        questions: Type.Array(
          Type.Object({
            id: Type.String({ minLength: 1, maxLength: 128 }),
            text: Type.String({ minLength: 1, maxLength: 2000 }),
            type: Type.Optional(
              Type.Union([
                Type.Literal("single"),
                Type.Literal("multiple"),
                Type.Literal("free"),
              ]),
            ),
            options: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
          }),
          { minItems: 1, maxItems: 32 },
        ),
      }),
      attachments: Type.Optional(
        Type.Array(Type.String(), { maxItems: MAX_TOOL_ATTACHMENTS }),
      ),
      attachmentTotal: Type.Optional(
        Type.Integer({ minimum: 0, maximum: MAX_ATTACHMENT_TOTAL }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        chatId: number;
        questions: {
          questions: {
            id: string;
            text: string;
            type?: string;
            options?: string[];
          }[];
        };
        attachments?: string[];
        attachmentTotal?: number;
      };
      const message = await performSendMessage(env, {
        senderEmployeeId: ASSISTANT_ID,
        chatId: input.chatId,
        kind: "ask",
        content: JSON.stringify(input.questions),
        attachments: input.attachments,
        attachmentTotal: input.attachmentTotal,
      });
      return toolResult({ id: message.id });
    },
  };
}

/**
 * `imb_get_employee_stat` — assistant-only: what are the employee session(s)
 * of a chat doing **right now**?
 *
 * `chatId` is always required; `employeeId` is optional. With it, the result is
 * the single `(employeeId, chatId)` stat described below, byte-identical to
 * before. Without it, the result is `{ chatId, chatTitle, employees }` — one
 * stat per employee participant of the chat; the assistant (id 0) is never
 * listed, and participants without a session here are included with
 * `sessionExists: false` so the roster stays complete.
 *
 * The boss needs to tell "stuck" from "still working", so every field describes
 * the present: `running` (a Pi run is streaming), `queued` (pending prompts,
 * informational only — future work, never part of "the last message"), and the
 * employee's last agent message. While the session is running, that message is
 * always the **current turn's** in-flight one (`streaming: true`, partial output,
 * no timestamp) — even when nothing readable has been produced yet, and never a
 * persisted message standing in for it. The last persisted message is then only
 * offered as `previousAgentMessage` for comparison.
 *
 * A message in flight has no timestamp, so `progress` carries the timing: how
 * long this run has lasted, how long ago the last observable activity was, and
 * — the case that motivated it — which tool call it is stuck in and for how
 * long (`activeTool`, oldest still-open call, with its truncated arguments). A
 * long tool that reports no partial results legitimately shows
 * `lastProgressAgeSeconds == activeTool.ageSeconds`: silence, not necessarily a
 * hang. All times are whole seconds computed here, and `progress` is omitted
 * entirely when nothing is running.
 *
 * Read-only and side-effect free: it never creates a queue state or a Pi
 * session (see `readSessionActivity`), and a corrupt/missing session file
 * degrades to "no output yet" instead of an error. Bulk mode fans out the same
 * per-employee pipeline concurrently: one slow or broken transcript degrades to
 * that employee's `null`, never to a failed call.
 */
function employeeStatTool(callingEmployeeId: number): AnyPiTool {
  return {
    name: "imb_get_employee_stat",
    label: "Employee status",
    description:
      "Report the current state of the employee agent session(s) of a chat. `chatId` is " +
      "required; `employeeId` selects one session and is optional: omit it to get **every** " +
      "employee participant of the chat at once — the result is then `{ chatId, chatTitle, " +
      "employees: [...] }` with one stat per employee (the assistant itself is never listed; " +
      "participants without a session appear with `sessionExists: false`). With `employeeId` " +
      "the result is a single stat: `running` (the employee is streaming a response right now), " +
      "`queued` (prompts waiting to run — background only, it never affects `lastAgentMessage`) " +
      "and `lastAgentMessage`. While `running`, `lastAgentMessage` always describes the turn " +
      "being produced right now: `streaming: true`, partial `text`, `at`/`ageSeconds` null — " +
      "possibly still empty (nothing readable yet, e.g. a tool is executing), never a finished " +
      "message standing in for it; the last finished message is then given separately as " +
      "`previousAgentMessage`. When not running, `lastAgentMessage` is the last finished message " +
      "with its `ageSeconds`. `toolCalls` lists the tool names in that message (no arguments). " +
      "`text` is capped by `maxChars`; `chars`/`truncated` tell whether it was cut. While " +
      "running, `progress` times the run: `runAgeSeconds` (since the run started), " +
      "`lastProgressAgeSeconds` + `lastProgressKind` (how long ago, and what, the last observable " +
      "activity was: a token, a message/turn boundary, a tool start/update/end, a retry wait), " +
      "`activeTool` (the oldest tool call that has not finished: `name`, `ageSeconds`, and its " +
      "already-truncated `args` — the model's own input arguments as one line of JSON, cut at " +
      "~1000 chars with `argsTruncated: true`, `null` when unserializable; they may contain " +
      "sensitive values or long bodies and are never the complete call), and `toolCallsThisRun`. " +
      "A tool that reports no partial results leaves `lastProgressAgeSeconds == " +
      "activeTool.ageSeconds`, which is silence rather than proof of a hang. Use it to tell a " +
      "stuck employee from one that is still working.",
    promptSnippet: "check an employee's current state",
    parameters: Type.Object({
      employeeId: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "The employee to inspect; `0` is the assistant itself. Omit it to get every " +
            "employee participant of `chatId` at once.",
        }),
      ),
      chatId: Type.Integer({
        minimum: 1,
        description:
          "The chat of the session(s) to inspect — one session per employee and chat.",
      }),
      maxChars: Type.Optional(
        Type.Integer({
          minimum: STAT_MIN_TEXT_CHARS,
          maximum: STAT_MAX_TEXT_CHARS,
          description: `Cap for \`text\` (default ${STAT_DEFAULT_TEXT_CHARS}).`,
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        employeeId?: number;
        chatId: number;
        maxChars?: number;
      };
      assertAssistantCaller(callingEmployeeId);
      const maxChars = clampMaxChars(input.maxChars);
      if (input.employeeId === undefined) {
        // Bulk mode: the chat is the only target to validate — who belongs to
        // it is decided from its participants, so there is no per-employee
        // caller mistake to catch.
        const chat = dbChats.getChat(input.chatId);
        if (!chat) throw new Error(`Chat ${input.chatId} does not exist.`);
        const employees = await Promise.all(
          bulkStatTargets(chat.participants).map((employeeId) =>
            buildStat(employeeId, input.chatId, chat.title, maxChars),
          ),
        );
        return toolResult({
          chatId: input.chatId,
          chatTitle: chat.title,
          employees,
        } satisfies ChatEmployeeStats);
      }
      assertStatTarget(input.employeeId, input.chatId);
      const chat = dbChats.getChat(input.chatId);
      // `assertStatTarget` already proved the chat exists; re-read for the title.
      return toolResult(
        await buildStat(
          input.employeeId,
          input.chatId,
          chat?.title ?? "",
          maxChars,
        ),
      );
    },
  };
}

/**
 * One employee's stat — the shared core of the single and the bulk mode of
 * `imb_get_employee_stat`.
 *
 * Side-effect free per employee: `readSessionActivity` only reads queue state
 * that already exists, and `readLastAssistantMessage` degrades to `null` on any
 * transcript failure, so one broken session never fails a whole bulk call.
 */
async function buildStat(
  employeeId: number,
  chatId: number,
  chatTitle: string,
  maxChars: number,
): Promise<EmployeeAgentStat> {
  const activity = readSessionActivity(employeeId, chatId);
  const persisted = await readLastAssistantMessage(employeeId, chatId);
  return buildEmployeeAgentStat({
    employeeId,
    chatId,
    chatTitle,
    sessionExists: dbSessions.getSession(employeeId, chatId) !== null,
    activity,
    persisted,
    maxChars,
  });
}

/**
 * The employees the bulk mode reports, in the chat's participant order:
 * deduplicated, and with the assistant (id 0 — it has no session in a task
 * group chat, its stat belongs to the root chat) and stale ids of deleted
 * employees dropped (`chats.participants` is a JSON column, not FK-enforced).
 */
function bulkStatTargets(participants: readonly number[]): number[] {
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const id of participants) {
    if (id === ASSISTANT_ID || seen.has(id)) continue;
    if (!getEmployee(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Defense in depth for the assistant-only orchestration tools.
 *
 * The real gate is registration in `createTeamToolDefinitions` (only the
 * `isAssistant` branch pushes these), so a mismatch only happens when a session
 * still carries a stale tool list. Failing loudly beats a participant silently
 * probing or interrupting its colleagues. Same pattern as
 * `performGenerateImage`'s marker re-check.
 */
function assertAssistantCaller(employeeId: number): void {
  if (employeeId !== ASSISTANT_ID) {
    throw new Error("This tool is only available to the assistant.");
  }
}

/** Default `text` cap of `imb_get_employee_stat`. */
const STAT_DEFAULT_TEXT_CHARS = 2000;
/** Hard cap for the same text (the model may ask for more, never for less). */
const STAT_MAX_TEXT_CHARS = 8000;
const STAT_MIN_TEXT_CHARS = 200;

/** Clamp the requested text cap into the supported range. */
function clampMaxChars(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return STAT_DEFAULT_TEXT_CHARS;
  }
  return Math.min(
    STAT_MAX_TEXT_CHARS,
    Math.max(STAT_MIN_TEXT_CHARS, Math.trunc(requested)),
  );
}

/**
 * Validate a stat target the same way the deliver path does, so the model gets
 * a correctable error instead of an empty, misleading snapshot:
 * the employee must exist, and a non-assistant employee must actually be a
 * participant of the chat. The assistant has no session in a task group chat
 * (it runs in the chat's root chat — see `wakeAgent`), so asking for it is a
 * caller mistake worth reporting.
 */
function assertStatTarget(employeeId: number, chatId: number): void {
  if (!getEmployee(employeeId)) {
    throw new Error(`Employee ${employeeId} does not exist.`);
  }
  const chat = dbChats.getChat(chatId);
  if (!chat) throw new Error(`Chat ${chatId} does not exist.`);
  if (employeeId === ASSISTANT_ID) {
    if (dbChats.getRootChatId(chatId) !== chatId) {
      throw new Error(
        "Employee 0 (the assistant) only has a session in its root chat.",
      );
    }
    return;
  }
  if (!chat.participants.includes(employeeId)) {
    throw new Error(
      `Employee ${employeeId} is not a participant of chat ${chatId}.`,
    );
  }
}

/**
 * `imb_interrupt` — assistant-only: stop one employee's current turn **and**
 * give it new instructions in one step.
 *
 * Deliberately a composition of existing primitives instead of a new interrupt
 * path:
 * 1. the `instruction` is posted as an ordinary `text` message from the
 *    assistant — the app's existing "assign work as a chat message" semantics,
 *    so the redirect has a durable, reviewable record in the task group and the
 *    employee's next `imb_read_chat` sees it;
 * 2. `interruptTurnDiscardingQueue(employeeId, chatId)` aborts the in-flight
 *    run (clearing Pi's internal queues first, marking the cut point in the
 *    transcript) **and discards everything that was still pending for that
 *    session** — the app-level queue and the undelivered steered texts. That is
 *    the difference from the view's interrupt chip and from the Halt button,
 *    both of which keep their own existing semantics: after a redirect the
 *    employee must only see the new instruction, not resume the old queue;
 * 3. `wakeAgent(...)` wakes the employee with the standard read-chat prompt so
 *    it picks up the instruction immediately.
 *
 * An employee that was not running is not an error: the instruction is then
 * simply delivered and the call reports `interrupted: false`. Nothing here
 * targets the assistant itself — aborting your own session mid-tool would drop
 * the tool result — so `employeeId: 0` is rejected.
 */
function interruptTool(
  env: AgentEnvironment,
  callingEmployeeId: number,
): AnyPiTool {
  return {
    name: "imb_interrupt",
    label: "Interrupt and redirect",
    description:
      "Interrupt one employee's current processing and hand it a new instruction in a single step. " +
      "The `instruction` is posted into `chatId` as a normal message from the assistant, the " +
      "employee's in-flight turn is aborted, and the employee is woken to read the new instruction. " +
      "Everything that was still pending for that session is **discarded** — queued prompts and " +
      "undelivered steered messages do not run afterwards, so after the call the employee only sees " +
      "your instruction: re-assign anything you still want done. Returns `interrupted: false` (not " +
      "an error) when the employee was not running: the pending work is still discarded, the " +
      "instruction is delivered and the employee is woken. Check `imb_get_employee_stat` first to " +
      "be sure an interrupt is warranted; never interrupt the assistant itself (id 0).",
    promptSnippet: "interrupt an employee and redirect it",
    parameters: Type.Object({
      employeeId: Type.Integer({
        minimum: 1,
        description: "The employee to interrupt (never `0`).",
      }),
      chatId: Type.Integer({
        minimum: 1,
        description: "The chat whose agent session is interrupted.",
      }),
      instruction: Type.String({
        minLength: 1,
        maxLength: 100000,
        description:
          "The new instruction, posted into the chat as the assistant's message. Make it self-contained.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        employeeId: number;
        chatId: number;
        instruction: string;
      };
      assertAssistantCaller(callingEmployeeId);
      if (input.employeeId === ASSISTANT_ID) {
        throw new Error(
          "You cannot interrupt yourself: aborting your own session would drop this tool call's result.",
        );
      }
      assertActiveEmployee(input.employeeId);
      const chat = dbChats.getChat(input.chatId);
      if (!chat) throw new Error(`Chat ${input.chatId} does not exist.`);
      if (!chat.participants.includes(input.employeeId)) {
        throw new Error(
          `Employee ${input.employeeId} is not a participant of chat ${input.chatId}.`,
        );
      }
      if (input.instruction.trim().length === 0) {
        throw new Error("`instruction` must not be empty.");
      }

      // 1. The instruction lands first: the interrupted run can then never end
      //    with the employee having nothing new to read, and the fresh run sees
      //    it through its read cursor.
      const message = await performSendMessage(env, {
        senderEmployeeId: ASSISTANT_ID,
        chatId: input.chatId,
        kind: "text",
        content: input.instruction,
      });
      // 2. Abort the in-flight turn of exactly this (employee, chat) session and
      //    discard the work still pending for it: a redirect must not be
      //    followed by the old queue. (The view's chip and the Halt button keep
      //    their own, unchanged semantics.)
      const interrupted = await interruptTurnDiscardingQueue(
        input.employeeId,
        input.chatId,
      );
      // 3. Wake the employee in its own session (queue: never steer the new
      //    instruction into a run that is being replaced). This is the only
      //    pending input the session has left.
      await wakeAgent(input.employeeId, input.chatId, READ_CHAT_PROMPT, {
        mode: "queue",
      });
      return toolResult({
        employeeId: input.employeeId,
        chatId: input.chatId,
        messageId: message.id,
        interrupted,
      });
    },
  };
}

/**
 * Build the role-based tool set for the calling agent.
 *
 * - Assistant (id 0): orchestration tools — `imb_set_employees`,
 *   `imb_create_chat`, `imb_add_participant`, `imb_read_chat`,
 *   `imb_list_employees`, `imb_toolset`, `imb_notify`, `imb_progress`,
 *   `imb_ask`, `imb_get_employee_stat`, `imb_interrupt`; plus
 *   `imb_send_message`, the cron tools and `imb_generate_image`
 *   (never gated: the assistant's `mcp` list is immutable).
 * - Participant employee: `imb_send_message`, `imb_read_chat`; plus
 *   `imb_set_cronjob` / `imb_remove_cronjob` / `imb_generate_image` when the
 *   corresponding opt-in marker is present in `mcp` (the image tool also
 *   needs `IMAGE_GENERATION_ENABLED`). Employees have no structured
 *   ask/answer tools — they exchange questions and answers as plain text
 *   messages — and no supervision tools: status probing and interrupting are
 *   the assistant's alone.
 */
/**
 * `imb_generate_image` — generate a picture and show it in the chat.
 *
 * The call is app-owned (see `../image-gen`), not an SDK call, so the message
 * has a lifecycle: a `kind="image"` placeholder is appended first (the chat
 * shows a placeholder immediately), then the same row is updated with the
 * picture or with a failure. The tool returns the stored file path so the agent
 * can also use the picture elsewhere.
 *
 * Registered while `IMAGE_GENERATION_ENABLED` is set, and only for agents
 * allowed to draw: always for the assistant (its `mcp` list is immutable), and
 * for an employee only when the boss linked the built-in "Generate image"
 * option to it — the same opt-in mechanism as the cron tools. `execute`
 * re-checks the marker defensively (stale session / dirty data).
 */
function generateImageTool(employeeId: number): AnyPiTool {
  return {
    name: "imb_generate_image",
    label: "Generate image",
    description:
      "Generate one picture from a text prompt and post it into a chat. Call this only when the boss " +
      "actually asked for an image — it costs money and takes tens of seconds. The chat immediately " +
      "shows a placeholder that is replaced by the picture once the model answers. `size` is an OpenAI-style " +
      "size such as 1024x1024 (default), 1536x1024 or 1024x1536; the Google backend generates at " +
      "its own default resolution. One picture per call.",
    promptSnippet: "draw a picture",
    parameters: Type.Object({
      chatId: Type.Integer({ minimum: 1 }),
      prompt: Type.String({ minLength: 1, maxLength: 8000 }),
      size: Type.Optional(Type.String({ maxLength: 32 })),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        chatId: number;
        prompt: string;
        size?: string;
      };
      return performGenerateImage(employeeId, input);
    },
  };
}

async function performGenerateImage(
  employeeId: number,
  input: { chatId: number; prompt: string; size?: string },
) {
  const chat = dbChats.getChat(input.chatId);
  if (!chat) throw new Error("Chat does not exist.");
  if (!chat.participants.includes(employeeId)) {
    throw new Error("You are not a participant of this chat.");
  }
  const sender = dbEmployees.getEmployee(employeeId);
  if (!sender || sender.disabled) {
    throw new Error("Sender is not an active employee.");
  }
  // Defense in depth: the tool is normally only registered for an employee
  // that linked the built-in option (see `createTeamToolDefinitions`), so this
  // only trips when a session still carries a stale tool list. The assistant
  // is never gated, exactly like the cron tools.
  if (
    employeeId !== ASSISTANT_ID &&
    !sender.mcp.includes(BUILTIN_GENERATE_IMAGE_MARKER)
  ) {
    throw new Error(
      'Image generation has not been enabled for you. Ask the boss to link the built-in "Generate image" tool to your employee (Employees › your name › Linked MCP).',
    );
  }

  const ref = getImageModelRef();
  if (ref === null) {
    throw new Error(
      "No image model is configured, so image generation is off. Ask the boss to choose one " +
        "under Settings › General › Image generation model.",
    );
  }

  const size = normalizeImageSize(input.size);
  // The placeholder goes first so the chat reacts immediately; the same row is
  // finished below, which is what the thread's swap animation watches.
  const placeholder = dbMessages.appendMessage(
    input.chatId,
    employeeId,
    input.prompt,
    {
      kind: "image",
      imageStatus: "generating",
      imageModel: imageModelRef(ref),
    },
  );

  try {
    const finished = await drawIntoImageMessage(
      placeholder.id,
      ref,
      input.prompt,
      size,
    );
    return toolResult({
      messageId: placeholder.id,
      path: finished?.attachments?.[0]?.path ?? null,
    });
  } catch (err) {
    // `drawIntoImageMessage` already marked the row; just report the reason so
    // the agent can tell the boss what went wrong.
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

export function createTeamToolDefinitions(
  options: TeamToolOptions,
): AnyPiTool[] {
  const { env, employeeId, chatId } = options;
  const isAssistant = employeeId === ASSISTANT_ID;
  const mcp = options.mcp ?? [];
  const tools: AnyPiTool[] = [];
  if (isAssistant) {
    tools.push(setEmployeesTool());
    tools.push(createChatTool(env, chatId));
    tools.push(addParticipantTool(env));
    tools.push(listEmployeesTool());
    tools.push(toolsetTool());
    tools.push(notifyTool());
    // Progress cards are assistant-only: the tool hardcodes the sender to the
    // assistant and participants have no way to post one (they lack `steps`).
    tools.push(progressTool(env));
    // `imb_ask` is assistant-only (it asks the boss); employees exchange
    // questions and answers as plain text messages.
    tools.push(askTool(env));
    // Status + intervention are assistant-only orchestration tools: they are how
    // the assistant sees what an employee is doing right now and aborts its
    // current turn to redirect it. Employees must never get them — this
    // `isAssistant` branch is the single registration point, and both tools
    // re-check the caller defensively (see `assertAssistantCaller`).
    tools.push(employeeStatTool(employeeId));
    tools.push(interruptTool(env, employeeId));
    tools.push(setCronjobTool(employeeId));
    tools.push(removeCronjobTool(employeeId));
  } else {
    // Cron tools are opt-in: registered only when the employee selected the
    // corresponding marker in their "Linked MCP" list.
    if (mcp.includes(BUILTIN_SET_CRON_MARKER)) {
      tools.push(setCronjobTool(employeeId));
    }
    if (mcp.includes(BUILTIN_REMOVE_CRON_MARKER)) {
      tools.push(removeCronjobTool(employeeId));
    }
    // Image generation is opt-in for employees (marker in their "Linked MCP"
    // list).
    if (
      IMAGE_GENERATION_ENABLED &&
      mcp.includes(BUILTIN_GENERATE_IMAGE_MARKER)
    ) {
      tools.push(generateImageTool(employeeId));
    }
  }
  tools.push(sendMessageTool(env));
  tools.push(readChatTool(employeeId, chatId));
  return tools;
}
