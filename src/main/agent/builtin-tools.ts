import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_REMOVE_CRON_MARKER,
  BUILTIN_SET_CRON_MARKER,
} from "@shared/constants/agent_tools";
import {
  MAX_ATTACHMENT_TOTAL,
  MAX_MESSAGE_ATTACHMENTS,
} from "@shared/constants/attachments";
import { ASSISTANT_ID } from "@shared/constants/employees";
import { READ_CHAT_PROMPT } from "@shared/constants/prompts";
import type {
  AgentEnvironment,
  AnyPiTool,
  CronJob,
  Employee,
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
import { notifyUnread, sendToRenderer } from "../notifications";
import { materializeSessionFile, sessionPathFor } from "./session-files";
import { wakeAgent } from "./session-queue";

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
 * `imb_add_participant`, `imb_list_employees`, `imb_notify`, `imb_progress`,
 * `imb_ask`) plus `imb_send_message` and `imb_read_chat`; a participant gets
 * `imb_send_message` and `imb_read_chat`, plus `imb_set_cronjob` and/or
 * `imb_remove_cronjob` when the employee opted in via their "Linked MCP" list.
 * The cron tools are deliberately NOT part of the assistant's tool set, and
 * `imb_progress` and `imb_ask` are assistant-only: employees exchange questions
 * and answers as plain text messages. All agent runs are serialized per
 * (employee, chat) via the session queue.
 * `createTeamToolDefinitions` captures the calling agent's identity so
 * `imb_read_chat` knows who is reading and internal sends know who is sending.
 */

const getEmployee = dbEmployees.getEmployee;

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
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
  if (paths.length > MAX_MESSAGE_ATTACHMENTS) {
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
    notify?: number[];
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
    await wakeAgent(pid, input.chatId, input.notifyPrompt ?? READ_CHAT_PROMPT);
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
 * @-mentions/notify, name/role for step cards, skills/mcp to judge fit) and
 * drops the rest — notably the full `systemPrompt` and the base64 `avatarUrl`.
 */
interface EmployeeBrief {
  id: number;
  name: string;
  role: string;
  skills: string[];
  mcp: string[];
}

function toEmployeeBrief(employee: Employee): EmployeeBrief {
  return {
    id: employee.id,
    name: employee.name,
    role: employee.role,
    skills: employee.skills,
    mcp: employee.mcp,
  };
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
      "Returns the array of employee ids created or updated.",
    promptSnippet: "batch create/edit employees",
    parameters: Type.Object({
      employees: Type.Array(
        Type.Object({
          id: Type.Optional(Type.Integer({ minimum: 1 })),
          name: Type.Optional(Type.String({ maxLength: 200 })),
          role: Type.Optional(Type.String({ maxLength: 200 })),
          systemPrompt: Type.Optional(Type.String({ maxLength: 100000 })),
          mcp: Type.Optional(
            Type.Array(Type.String({ maxLength: 256 }), { maxItems: 256 }),
          ),
          skills: Type.Optional(
            Type.Array(Type.String({ maxLength: 256 }), { maxItems: 256 }),
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
      "Create a new chat with the given employee participants, initializing one persistent agent session per employee participant " +
      "(the assistant orchestrates from its own root-chat session and gets no session here). " +
      "The assistant always joins, and the chat that spawned this one is linked as `from_chat_id`. " +
      "Participants are NOT notified or started automatically — assign their work afterwards with `imb_send_message`, " +
      "passing their ids in `notify` to wake them.",
    promptSnippet: "new team chat",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 200 }),
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

/** `imb_send_message` — post as an active participant, optionally notifying others. */
function sendMessageTool(env: AgentEnvironment): AnyPiTool {
  return {
    name: "imb_send_message",
    label: "Send message",
    description:
      "Send a message into a chat as one of the active participants, with optional file-path attachments " +
      "(at most 50; pass `attachmentTotal` when more files were produced) and notifications to other " +
      "participants. `kind` is `text` (the default) or `report` to report a finished task's result.",
    promptSnippet: "post to a chat",
    parameters: Type.Object({
      senderEmployeeId: Type.Integer({ minimum: 0 }),
      chatId: Type.Integer({ minimum: 1 }),
      kind: Type.Optional(
        Type.Union([Type.Literal("text"), Type.Literal("report")]),
      ),
      content: Type.String({ minLength: 1, maxLength: 100000 }),
      attachments: Type.Optional(
        Type.Array(Type.String(), { maxItems: MAX_MESSAGE_ATTACHMENTS }),
      ),
      attachmentTotal: Type.Optional(
        Type.Integer({ minimum: 0, maximum: MAX_ATTACHMENT_TOTAL }),
      ),
      notify: Type.Optional(
        Type.Array(Type.Integer({ minimum: 0 }), { maxItems: 64 }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        senderEmployeeId: number;
        chatId: number;
        kind?: "text" | "report";
        content: string;
        attachments?: string[];
        attachmentTotal?: number;
        notify?: number[];
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
 * task group it reports on (`groupChatId`, rendered as an open-group arrow),
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
      "`employeeId`; `status` `pending` before work is assigned, `busy` once it is assigned and " +
      "running, `done` when finished). Always resend the whole list on every update; no " +
      "participant is notified.",
    promptSnippet: "post a progress card",
    parameters: Type.Object({
      chatId: Type.Integer({ minimum: 1 }),
      groupChatId: Type.Integer({ minimum: 1 }),
      content: Type.String({ minLength: 1, maxLength: 100000 }),
      steps: Type.Array(
        Type.Object({
          name: Type.String({ minLength: 1, maxLength: 256 }),
          role: Type.String({ maxLength: 256 }),
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

/** `imb_read_chat` — advance the calling agent's cursor and return new messages. */
function readChatTool(employeeId: number): AnyPiTool {
  return {
    name: "imb_read_chat",
    label: "Read chat",
    description:
      "Read the latest messages in a chat (after your read cursor) and advance that cursor.",
    promptSnippet: "consume new messages",
    parameters: Type.Object({
      chatId: Type.Integer({ minimum: 1 }),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { chatId: number };
      const chat = dbChats.getChat(input.chatId);
      if (!chat) throw new Error("Chat does not exist.");
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

/** `imb_list_employees` — active employees, excluding the built-in assistant. */
function listEmployeesTool(): AnyPiTool {
  return {
    name: "imb_list_employees",
    label: "List employees",
    description:
      "List all active employees (excluding the built-in assistant), ordered by id.",
    promptSnippet: "active team members",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params) => {
      const employees = dbEmployees
        .listEmployees()
        .filter((employee) => employee.id !== ASSISTANT_ID);
      return toolResult(employees.map(toEmployeeBrief));
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
        content: `New participant(s) joined: ${names.join(", ")}`,
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
 */
function askTool(env: AgentEnvironment): AnyPiTool {
  return {
    name: "imb_ask",
    label: "Ask the boss",
    description:
      "Post a question set for the boss into a chat. Each question offers candidate options " +
      "(single or multiple) and/or a free-form answer; the message body is the JSON serialization " +
      "of the question set. The boss answers through the question card, delivered back as an " +
      "`answer` message; call `imb_notify` afterwards so the boss is alerted. " +
      "Attachments are capped at 50; pass `attachmentTotal` when more files were produced.",
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
        Type.Array(Type.String(), { maxItems: MAX_MESSAGE_ATTACHMENTS }),
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
 * Build the role-based tool set for the calling agent.
 *
 * - Assistant (id 0): orchestration tools — `imb_set_employees`,
 *   `imb_create_chat`, `imb_add_participant`, `imb_read_chat`,
 *   `imb_list_employees`, `imb_notify`, `imb_progress`, `imb_ask`; plus
 *   `imb_send_message`. No cron tools.
 * - Participant employee: `imb_send_message`, `imb_read_chat`; plus
 *   `imb_set_cronjob` / `imb_remove_cronjob` when the corresponding opt-in
 *   marker is present in `mcp`. Employees have no structured ask/answer
 *   tools — they exchange questions and answers as plain text messages.
 */
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
    tools.push(notifyTool());
    // Progress cards are assistant-only: the tool hardcodes the sender to the
    // assistant and participants have no way to post one (they lack `steps`).
    tools.push(progressTool(env));
    // `imb_ask` is assistant-only (it asks the boss); employees exchange
    // questions and answers as plain text messages.
    tools.push(askTool(env));
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
  }
  tools.push(sendMessageTool(env));
  tools.push(readChatTool(employeeId));
  return tools;
}
