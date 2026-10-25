import type {
  AgentSessionEvent,
  ModelRuntime,
  AgentSession as PiAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ASSISTANT_ID } from "@shared/constants/employees";
import {
  ASSISTANT_SYSTEM_PROMPT,
  BASE_TOOL_SNIPPETS,
  TOOLS_GUIDELINES,
  WINDOWS_TOOLS_GUIDELINES,
} from "@shared/constants/prompts";
import { SettingKeys } from "@shared/constants/settings";
import {
  isThinkingLevel,
  type ThinkingLevel,
} from "@shared/constants/thinking";
import type {
  AgentEnvironment,
  AgentSessionContext,
  AnyPiTool,
  EmployeeToolEntry,
  McpConfig,
  McpServer,
  McpTransport,
} from "@shared/types";
import { createHash } from "crypto";
import {
  getAgentRoot,
  getAgentSessionsDir,
  getBuiltinSkillsDir,
} from "../data-dir";
import { getChat } from "../db/chats";
import { getEmployee } from "../db/employees";
import { getSession } from "../db/sessions";
import { getSetting } from "../db/settings";
import { readMcpServers } from "../mcp-store";
import {
  BUILTIN_SKILL_NAMES,
  materializeBuiltinSkills,
} from "./builtin-skills";
import { createTeamToolDefinitions } from "./builtin-tools";
import { buildEmployeeSystemPrompt } from "./employee-prompt";
import { INTERRUPT_MARKER } from "./interrupt-marker";
import { toMcpServerEntries } from "./mcp";
import { getModelRuntime, resolveModel } from "./model-runtime";
import { planQueueRevoke, planSteerRevoke } from "./steer-records";
import { loadPiSdk, type PiSdk } from "./pi-sdk";
import { listSkills } from "./skills";
import { createShellToolDefinitions } from "./tools";
import { readUserEnv } from "./user-env";
import { resolveWorkDir } from "./workdir";

/**
 * Pi-backed agent session.
 *
 * The app wrapper owns a single cached Pi `AgentSession` per app wrapper
 * instance. `prepare()` composes a *session spec* (resolved model, persona,
 * effective MCP definitions, user env, installed skills, per-employee skill
 * filter, agent-root context files, cwd), hashes it, and rebuilds the Pi
 * session only when that signature changed — so a queued burst of messages
 * reuses one live session while any config edit still lands on the next
 * message. The session is resumed from the per-`(employee, chat)` file when a
 * `sessions` row exists.
 *
 * Environment guarantees for every subprocess the agent spawns:
 * - the bash tool (and the PowerShell tool on Windows) is replaced by an
 *   env-injected definition (user env via the tool's `spawnHook` — see
 *   `tools.ts`);
 * - the employee's configured MCP servers are connected by the Pi SDK's
 *   built-in MCP extension, which is given only this employee's servers via a
 *   custom `loadConfig` (see `mcp.ts`; stdio servers get the user env merged
 *   into their `env`).
 *
 * The wrapper never captures or persists a reply: the agent posts its own
 * output through the built-in `imb_*` tools. `prompt()` only advances the
 * session; callers observe progress through the subscribed event listener.
 */

type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** Listener receiving every raw Pi session event. */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

/**
 * Upper bound for `waitForRunSettled`. `abort()` already waits for the agent to
 * become idle, so this only has to cover the run's own teardown; the bound keeps
 * a wedged run from hanging an interrupt forever.
 */
const RUN_SETTLE_TIMEOUT_MS = 5_000;

/**
 * Canonical description of everything that shapes a built Pi session. Hashed
 * to decide whether a warm session can be reused for the next queued message.
 */
interface SessionSpec {
  employeeId: number;
  isAssistant: boolean;
  /** The chat this session runs in; part of the hash so the signature covers
   *  the identity block injected into the prompt. Immutable per wrapper (one
   *  `AgentSession` is bound to a single `(employee, chat)` key for life), so
   *  adding it never causes extra rebuilds on its own. */
  chatId: number;
  /** Spawning chat for a group chat; null for root chats. Immutable after
   *  `createChat` (no update path touches `from_chat_id`). */
  fromChatId: number | null;
  /** Employee display name; injected into the generated non-assistant role block. */
  employeeName: string;
  /** Employee role; injected into the generated non-assistant role block. */
  employeeRole: string;
  /** Resolved `"provider/modelId"`. */
  modelRef: string;
  /**
   * Effective thinking strength (employee → global default → null). Null
   * means "not configured": the value is omitted from `createAgentSession`
   * so the SDK applies its own restore/default chain.
   */
  thinkingLevel: ThinkingLevel | null;
  systemPrompt: string;
  /** Raw `employee.mcp` (sorted) — includes built-in tool opt-in markers. */
  mcpServerNames: string[];
  /** Effective MCP server definitions (full transport/config), sorted by name. */
  mcpServers: Array<{
    name: string;
    transport: McpTransport;
    config: McpConfig;
  }>;
  /** Raw `agent.userEnv` setting value (drives shell/MCP subprocess env). */
  userEnv: string | null;
  /** Installed skills (global dir), sorted by name. */
  skills: Array<{ name: string; description: string | null }>;
  /** `employee.skills` — the per-employee skill filter, sorted. */
  employeeSkills: string[];
  /** Agent-root context files with content hashes, sorted by path. */
  contextFiles: Array<{ path: string; contentHash: string }>;
  cwd: string;
}

interface ComposedSession {
  spec: SessionSpec;
  model: PiModel;
  modelRuntime: ModelRuntime;
  /** Effective servers (with row ids) to connect for the session. */
  mcpServers: McpServer[];
}

export class AgentSession {
  private _disposed = false;
  private _piSession: PiAgentSession | undefined;
  private _signature: string | undefined;
  /** The in-flight `prompt()` run, so an interrupt can wait for its teardown. */
  private _run: Promise<void> | null = null;

  constructor(
    private readonly env: AgentEnvironment,
    private readonly context?: AgentSessionContext,
    private readonly onEvent?: AgentSessionEventListener,
  ) {}

  /**
   * Ensure a live Pi session matching the current composition, rebuilding it
   * only when the composition signature changed (or no session exists yet).
   *
   * Throws when no usable model is configured — `prompt()` surfaces that to
   * the queue, which converts it to a bound `error` event.
   */
  async prepare(): Promise<void> {
    if (this._disposed) {
      throw new Error("AgentSession has been disposed.");
    }
    if (!this.context) {
      throw new Error("AgentSession requires an employee/chat context.");
    }
    const pi = await loadPiSdk();
    const composed = await this._compose(pi);
    const signature = hashSpec(composed.spec);
    if (this._piSession && this._signature === signature) return;

    await this._disposePiSession();
    await this._buildPiSession(pi, composed);
    this._signature = signature;
  }

  /**
   * Run one agent turn. Prepares (or reuses) the session, then forwards the
   * message to Pi. No reply is captured or persisted.
   */
  async prompt(message: string): Promise<void> {
    if (this._disposed) {
      throw new Error("AgentSession has been disposed.");
    }
    await this.prepare();
    if (!this._piSession) {
      throw new Error("Agent session was not prepared.");
    }
    // Remembered so `waitForRunSettled()` can await the *whole* run (including
    // Pi's teardown after an abort). Set after `prepare()`: preparing may dispose
    // and rebuild the Pi session, so an earlier promise would belong to a
    // discarded run.
    const run = this._piSession.prompt(message);
    this._run = run;
    try {
      await run;
    } finally {
      if (this._run === run) this._run = null;
    }
  }

  /**
   * Wait (bounded) until the in-flight run has **fully** settled — i.e. until Pi
   * has stopped emitting events for it.
   *
   * `abort()` only waits for the agent to become *idle*; the run's own teardown
   * (pending-message flush, `agent_settled`) can still emit `message_end` events
   * afterwards. An interrupt uses those events to tell an already-persisted
   * steered message from a lost one, so it must not account for them too early.
   * Never throws (a failed run is the queue's business) and never waits longer
   * than `timeoutMs`.
   */
  async waitForRunSettled(timeoutMs = RUN_SETTLE_TIMEOUT_MS): Promise<void> {
    const run = this._run;
    if (!run) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      void run
        .catch(() => {
          // The queue reports run failures; settling only needs to know it ended.
        })
        .then(() => {
          clearTimeout(timer);
          resolve();
        });
    });
  }

  /**
   * Hand a message to the *currently running* Pi turn as a steering message.
   * Pi delivers it after the current assistant turn and its tool calls
   * complete, before the next LLM call — so a user who types mid-turn is seen
   * at the next turn boundary instead of waiting for the whole run to settle.
   *
   * Returns the text that Pi actually queued: `steer()` expands `/skill:`
   * commands and prompt templates first, so the queued text is not necessarily
   * `message`. Withdrawal addresses a queue entry, so the caller must remember
   * this value rather than the original text (see `steer-records.ts`). Falls back
   * to `message` when the queue could not be observed (the hand-over may then
   * have been consumed by an extension command instead of being queued).
   *
   * Only valid while the underlying session is streaming; callers must gate on
   * `isStreaming` (the queue does).
   */
  async steer(message: string): Promise<string> {
    if (this._disposed) {
      throw new Error("AgentSession has been disposed.");
    }
    if (!this._piSession) {
      throw new Error("Agent session was not prepared.");
    }
    // The queue only ever grows here (one entry, appended): comparing lengths
    // tells us whether this hand-over really landed and what its queued form is.
    const before = this._piSession.getSteeringMessages().length;
    await this._piSession.steer(message);
    const after = this._piSession?.getSteeringMessages() ?? [];
    if (after.length === before + 1) return after[after.length - 1];
    return message;
  }

  /**
   * Texts currently sitting in Pi's steering queue (read-only snapshot, in
   * delivery order) — i.e. the interjections the model has **not** seen yet.
   */
  getSteeringTexts(): readonly string[] {
    return this._piSession?.getSteeringMessages() ?? [];
  }

  /**
   * Withdraw one interjection: remove the `occurrence`-th queue entry equal to
   * `text` while keeping every other pending message, in its original order.
   *
   * Pi exposes no per-entry removal — only `clearQueue()`, which empties both
   * queues — so this is "snapshot → clear → re-queue the rest". The remaining
   * texts are re-handed one by one, in their original order, which preserves what
   * the model sees next (`steeringMode` is `one-at-a-time`, so they are injected
   * one turn boundary at a time either way).
   *
   * Returns `false` (and changes nothing) when the queue no longer holds that
   * entry — a withdrawal must never touch the wrong message: the shared queue may
   * also hold employee @-mention wakes and IM bridge texts, which this app must
   * not swallow.
   *
   * The clear→re-queue window is a handful of microtasks. If a turn boundary
   * lands inside it, the re-queued messages arrive one turn later — they are
   * never lost and never reordered relative to each other.
   */
  async removeQueuedSteer(text: string, occurrence: number): Promise<boolean> {
    if (this._disposed) {
      throw new Error("AgentSession has been disposed.");
    }
    const session = this._piSession;
    if (!session) return false;
    // Nothing to do when the entry is gone: never clear a queue we cannot put
    // back exactly as it was.
    if (
      planSteerRevoke(session.getSteeringMessages(), text, occurrence) === null
    ) {
      return false;
    }
    // Snapshot and clear with **no await in between**, so the entries that are
    // restored are exactly the ones that were cleared.
    const cleared = session.clearQueue();
    const plan = planQueueRevoke(cleared, text, occurrence);
    // Restore everything else (or all of it, in the unreachable case where the
    // entry vanished together with the clear), so Pi's queue is never left
    // emptier than it was.
    for (const queued of plan.steering) {
      await this._piSession?.steer(queued);
    }
    for (const queued of plan.followUp) {
      await this._piSession?.followUp(queued);
    }
    return plan.removed;
  }

  /**
   * Abort the in-flight Pi turn and wait for the agent to become idle
   * (interrupt). Only meaningful while streaming; callers gate on
   * `isStreaming`. Messages already persisted elsewhere are never touched —
   * abort only stops the current run.
   */
  async abort(): Promise<void> {
    if (this._disposed) {
      throw new Error("AgentSession has been disposed.");
    }
    if (!this._piSession) {
      throw new Error("Agent session was not prepared.");
    }
    await this._piSession.abort();
  }

  /**
   * Drop Pi's internal queued steering / follow-up messages and return their
   * text. The RPC contract is to clear the queue *before* aborting, otherwise
   * the aborted turn immediately continues with the still-queued messages.
   * Tolerant when no session is prepared (returns empty lists).
   */
  clearQueue(): { steering: string[]; followUp: string[] } {
    if (!this._piSession) return { steering: [], followUp: [] };
    return this._piSession.clearQueue();
  }

  /** Whether the underlying Pi session is actively processing a run. */
  get isStreaming(): boolean {
    return this._piSession?.isStreaming ?? false;
  }

  /**
   * The **in-flight** assistant message of the current streamed response, with
   * the tool-call ids still executing. `undefined` when there is no prepared Pi
   * session or nothing is streaming.
   *
   * Display-only: it feeds the session view's "live seed" (see `projectLive
   * Assistant`), so a window that binds mid-run can render the part of the
   * message that streamed while it was not listening. It never drives a run and
   * its content is never forwarded raw — only the whitelisted projection is.
   */
  get streamingAssistant():
    { content: unknown; pendingToolCalls: ReadonlySet<string> } | undefined {
    const state = this._piSession?.state;
    const message = state?.streamingMessage as
      { content?: unknown } | undefined;
    if (!message) return undefined;
    return {
      content: message.content,
      pendingToolCalls: state?.pendingToolCalls ?? new Set<string>(),
    };
  }

  /**
   * Persist an app-level "the boss interrupted this turn here" marker in the
   * session transcript.
   *
   * Uses a Pi **custom entry** (`type: "custom"`, `customType: INTERRUPT_MARKER`),
   * which by construction never participates in the model's context — it is
   * display/state data only. Appending it *advances the session leaf*, so it also
   * marks the exact position in the transcript where the turn was cut, which is
   * what the read-only view draws a separator for. Durable: the entry lives in
   * the session JSONL, so it survives idle disposal, session rebuilds and app
   * restarts.
   *
   * Best-effort: a failure only logs. An interrupt must never fail (or look
   * failed) because the marker could not be written.
   */
  markInterrupted(): void {
    const session = this._piSession;
    if (!session) return;
    try {
      session.sessionManager.appendCustomEntry(INTERRUPT_MARKER);
    } catch (err) {
      console.error(
        "[agent-session] failed to append the interrupt marker:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Dispose the Pi session and close MCP connections. Idempotent. */
  async dispose(): Promise<void> {
    this._disposed = true;
    await this._disposePiSession();
  }

  private async _disposePiSession(): Promise<void> {
    const session = this._piSession;
    this._piSession = undefined;
    this._signature = undefined;
    if (session) {
      // `AgentSession.dispose()` does not emit `session_shutdown`; emit it so
      // extension-scoped resources (MCP stdio children, connections) are
      // released before the session goes away.
      try {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } catch (err) {
        console.error(
          "[agent-session] failed to emit session_shutdown:",
          err instanceof Error ? err.message : err,
        );
      }
      try {
        session.dispose();
      } catch (err) {
        console.error(
          "[agent-session] failed to dispose Pi session:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /** Resolve the current composition (model included) for this context. */
  private async _compose(pi: PiSdk): Promise<ComposedSession> {
    if (!this.context) {
      throw new Error("AgentSession requires an employee/chat context.");
    }
    const employee = getEmployee(this.context.employeeId);
    const employeeId = employee?.id ?? this.context.employeeId;
    const isAssistant = employeeId === ASSISTANT_ID;

    const modelRuntime = await getModelRuntime();
    const model = resolveModel(modelRuntime, employee?.modelId);
    if (!model) {
      throw new Error(
        "No model is configured. Add a model provider with credentials or set a default model.",
      );
    }

    // Thinking strength cascade: employee override → global default → unset
    // (the SDK then falls back to its own history/default chain and clamps
    // the level to the selected model's capabilities).
    const storedThinking = getSetting(SettingKeys.DefaultThinkingLevel);
    const thinkingLevel =
      (isThinkingLevel(employee?.thinkingLevel)
        ? employee.thinkingLevel
        : null) ?? (isThinkingLevel(storedThinking) ? storedThinking : null);

    const cwd = resolveWorkDir();
    const agentRoot = getAgentRoot();

    const employeeMcp = [...(employee?.mcp ?? [])].sort((a, b) =>
      a.localeCompare(b),
    );
    const mcpServers = readMcpServers()
      .filter((server) => employeeMcp.includes(server.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    const installedSkills = await listSkills();
    const skills = installedSkills
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const employeeSkills = [...(employee?.skills ?? [])].sort((a, b) =>
      a.localeCompare(b),
    );

    const contextFiles = loadAgentContextFiles(pi, cwd, agentRoot)
      .map((file) => ({
        path: file.path,
        contentHash: sha256(file.content),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));

    const spec: SessionSpec = {
      employeeId,
      isAssistant,
      // Defensive: a chat row that vanished between queueing and composing
      // degrades to a null `from` rather than failing the whole run.
      chatId: this.context.chatId,
      fromChatId: getChat(this.context.chatId)?.fromChatId ?? null,
      employeeName: employee?.name ?? "",
      employeeRole: employee?.role ?? "",
      modelRef: `${model.provider}/${model.id}`,
      thinkingLevel,
      systemPrompt: employee?.systemPrompt ?? "",
      mcpServerNames: employeeMcp,
      mcpServers: mcpServers.map((server) => ({
        name: server.name,
        transport: server.config.transport,
        config: server.config,
      })),
      userEnv: getSetting(SettingKeys.UserEnv),
      skills,
      employeeSkills,
      contextFiles,
      cwd,
    };
    return { spec, model, modelRuntime, mcpServers };
  }

  /** Build a fresh Pi session from a composed spec. */
  private async _buildPiSession(
    pi: PiSdk,
    composed: ComposedSession,
  ): Promise<void> {
    const { spec, model, modelRuntime, mcpServers } = composed;
    const cwd = spec.cwd;

    // Per-employee MCP scoping: the SDK MCP extension connects every server its
    // `loadConfig` returns, so this build only hands it the servers selected by
    // this employee. The extension is created per session build and reconnects
    // when the composition signature changes.
    const userEnv = readUserEnv();
    const mcpExtension = pi.createMcpExtension({
      loadConfig: () => ({
        servers: toMcpServerEntries(mcpServers, userEnv),
        errors: [],
      }),
    });

    const shellTools = await createShellToolDefinitions({ cwd });
    // Role-based team tools: the assistant orchestrates; participants just
    // work inside chats. The context is guaranteed by `prepare()`.
    const teamTools = this.context
      ? createTeamToolDefinitions({
          env: this.env,
          employeeId: spec.employeeId,
          chatId: this.context.chatId,
          // Includes built-in opt-in markers (e.g. `builtin:imb_set_cronjob`)
          // alongside any MCP server names.
          mcp: spec.mcpServerNames,
        })
      : [];
    const customTools: AnyPiTool[] = [...shellTools, ...teamTools];

    // Base built-in tools are pinned through the in-memory `defaultTools`
    // setting instead of the `tools` allowlist: an allowlist would filter out
    // extension-registered MCP tools entirely, so direct MCP tools would never
    // become active. Custom tools and direct MCP tools auto-activate on
    // registration; only these base names are enabled initially.
    const isWindows = process.platform === "win32";
    const defaultToolNames = [
      "read",
      "bash",
      "edit",
      "write",
      ...(isWindows ? ["powershell"] : []),
    ];
    // Source of the generated `Available tools:` block. MCP tools are not listed
    // here (their servers connect only after this prompt is built); the model
    // still receives their full tool declarations once they do.
    const activeToolNames = [
      ...defaultToolNames,
      ...customTools.map((tool) => tool.name),
    ];

    // Resume the persistent per-(employee, chat) session when a row exists;
    // otherwise start ephemeral. A stored-but-unreadable session file falls
    // back to in-memory rather than failing the turn.
    let sessionManager: SessionManager;
    const sessionRecord = this.context
      ? getSession(spec.employeeId, this.context.chatId)
      : null;
    if (sessionRecord) {
      try {
        sessionManager = pi.SessionManager.open(
          sessionRecord.session,
          getAgentSessionsDir(),
          cwd,
        );
      } catch {
        sessionManager = pi.SessionManager.inMemory(cwd);
      }
    } else {
      sessionManager = pi.SessionManager.inMemory(cwd);
    }

    const settingsManager = pi.SettingsManager.inMemory();
    settingsManager.applyOverrides({ defaultTools: defaultToolNames });

    // Enumeration of the active tools for this employee-session's `[tools]`
    // block: the SDK core tools use their base snippets; team `imb_*` tools use
    // their `promptSnippet` (falling back to the description).
    const toolEntries = buildEmployeeToolEntries(activeToolNames, customTools);

    // The `## Guidelines` bullets are platform-selected: Windows swaps the
    // POSIX shell/path bullets for PowerShell-aware ones (see
    // `prompts.ts`). Resolved here, like `toolEntries`, so the formatter stays
    // platform-agnostic. `isWindows` is a process constant (mirroring `today`),
    // so it never enters the session spec/hash.
    const toolsGuidelines = isWindows
      ? WINDOWS_TOOLS_GUIDELINES
      : TOOLS_GUIDELINES;

    // Every employee session goes fully custom (decision 8): the SDK base
    // prompt is dropped and the app builds the identity block, role block,
    // persona, response-language rule, `[builtinSkills]`, `[tools]` and the
    // Today line. The SDK still appends `<project_context>`,
    // `[skills]` and a trailing `Current working directory` line after the
    // override.
    const systemPromptOverride = (): string =>
      buildEmployeeSystemPrompt({
        personaParts: spec.isAssistant
          ? [ASSISTANT_SYSTEM_PROMPT, spec.systemPrompt]
          : [spec.systemPrompt],
        isAssistant: spec.isAssistant,
        name: spec.employeeName,
        role: spec.employeeRole,
        employeeId: spec.employeeId,
        chatId: spec.chatId,
        fromChatId: spec.fromChatId,
        toolEntries,
        toolsGuidelines,
      });

    // Anchor `<project_context>` to the app's `~/.imboss/agent` dir only,
    // dropping any ancestor AGENTS.md files outside it (decision 5), and
    // filter the global installed skills down to the employee's selection
    // (empty selection ⇒ no `[skills]` block). The assistant (id 0) may also
    // select user-installed skills like any employee; its code-shipped
    // built-in skills are always forced in on top of that selection.
    const selectedSkills = new Set(spec.employeeSkills);
    const builtinSkills = spec.isAssistant
      ? new Set<string>(BUILTIN_SKILL_NAMES)
      : null;
    // Built-in skills are generated onto disk; the startup pass covers the
    // normal path, this is a defensive no-op when they are already current.
    if (spec.isAssistant) materializeBuiltinSkills();

    const resourceLoader = new pi.DefaultResourceLoader({
      cwd,
      agentDir: this.env.rootDir,
      settingsManager,
      systemPromptOverride,
      agentsFilesOverride: (base) => ({
        agentsFiles: filterAgentContextFiles(base.agentsFiles, getAgentRoot()),
      }),
      skillsOverride: (base) => ({
        skills: base.skills.filter(
          (skill) =>
            selectedSkills.has(skill.name) ||
            (builtinSkills !== null && builtinSkills.has(skill.name)),
        ),
        diagnostics: base.diagnostics,
      }),
      // Built-in skills live in their own dir so they never show up under
      // Settings › Skills; only the assistant loads them.
      ...(spec.isAssistant
        ? { additionalSkillPaths: [getBuiltinSkillsDir()] }
        : {}),
      // Built-in extensions are opt-in for SDK hosts; add the MCP extension so
      // this session connects the employee's servers.
      extensionFactories: [mcpExtension],
    });
    await resourceLoader.reload();

    const { session } = await pi.createAgentSession({
      cwd,
      agentDir: this.env.rootDir,
      modelRuntime,
      model,
      // Omitted when unset: the SDK restores the session-history level or
      // falls back to its default (medium), clamped to model capabilities.
      ...(spec.thinkingLevel !== null
        ? { thinkingLevel: spec.thinkingLevel }
        : {}),
      customTools,
      resourceLoader,
      sessionManager,
      settingsManager,
    });

    // Emits `session_start`, which connects the MCP servers in the background.
    await session.bindExtensions({});

    session.subscribe((event) => {
      this.onEvent?.(event);
    });

    this._piSession = session;
  }
}

/**
 * Resolve the ordered entries for the `[tools]` block from a session's active
 * tool names. Core tools (read/bash/edit/write, plus powershell on Windows) map
 * to `BASE_TOOL_SNIPPETS`; custom tools (MCP + team `imb_*`) use their
 * `promptSnippet` (falling back to the description). Names that appear twice in
 * `activeToolNames` (bash and PowerShell are both base tools and shell
 * definitions) are deduplicated.
 */
function buildEmployeeToolEntries(
  activeToolNames: string[],
  customTools: AnyPiTool[],
): EmployeeToolEntry[] {
  const byName = new Map<string, AnyPiTool>(
    customTools.map((tool) => [tool.name, tool]),
  );
  const entries: EmployeeToolEntry[] = [];
  const seen = new Set<string>();
  for (const name of activeToolNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const base = BASE_TOOL_SNIPPETS[name];
    if (base) {
      entries.push({ name, snippet: base });
      continue;
    }
    const custom = byName.get(name);
    const snippet = custom?.promptSnippet ?? custom?.description;
    if (custom && snippet) {
      entries.push({ name, snippet });
    }
  }
  return entries;
}

/** Stable hash of a session spec (recursively key-sorted JSON). */
function hashSpec(spec: SessionSpec): string {
  return sha256(stableStringify(spec));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic JSON: object keys sorted recursively, array order preserved. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Load context files the SDK would include and keep only those under the
 * app's agent root (mirrors the loader's `agentsFilesOverride`).
 */
function loadAgentContextFiles(
  pi: PiSdk,
  cwd: string,
  agentRoot: string,
): Array<{ path: string; content: string }> {
  return filterAgentContextFiles(
    pi.loadProjectContextFiles({ cwd, agentDir: agentRoot }),
    agentRoot,
  );
}

/** Filter context files to those inside `root` (path-separator agnostic). */
function filterAgentContextFiles<T extends { path: string }>(
  files: T[],
  root: string,
): T[] {
  return files.filter((file) => isUnderPath(file.path, root));
}

function isUnderPath(filePath: string, root: string): boolean {
  const normalize = (path: string): string => path.replace(/\\/g, "/");
  const resolvedRoot = normalize(root);
  const prefix = resolvedRoot.endsWith("/") ? resolvedRoot : `${resolvedRoot}/`;
  const normalizedPath = normalize(filePath);
  return normalizedPath === resolvedRoot || normalizedPath.startsWith(prefix);
}
