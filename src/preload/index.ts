import { DEFAULT_LOCALE } from "@shared/constants/locales";
import type {
  AgentSessionRunState,
  AgentSessionSendResult,
  AgentSessionSteerRevokeResult,
  AgentSessionViewEntry,
  AgentStreamPayload,
  BackupInfo,
  BackupStatus,
  CapabilityUnlinkResult,
  Chat,
  ChatParticipantUpdate,
  ChatSummary,
  CommonProject,
  CronJobInfo,
  Employee,
  EmployeeDeleteResult,
  EmployeeExportResult,
  EmployeeImportApplyOptions,
  EmployeeImportPreview,
  EmployeeImportResult,
  EmployeeInput,
  EmployeeSession,
  InstalledSkill,
  IntegrationConfigPatch,
  IntegrationPlatform,
  IntegrationQrState,
  IntegrationState,
  McpServer,
  McpServerInput,
  Message,
  MessageAttachment,
  MessageChangedPayload,
  MessageSearchResult,
  MiniApp,
  ModelOption,
  PageQuery,
  PageResult,
  ProviderInfo,
  ProviderLoginEvent,
  ProviderModelsQuery,
  ProviderUpsert,
  SpendRange,
  SpendReport,
  StagedRestore,
  ThemeState,
  UpdaterState,
  WindowShortcutState,
  WindowShortcutUpdate,
  WorkDirState,
} from "@shared/types";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const initialLocale = readArg("locale") ?? DEFAULT_LOCALE;

const api = {
  platform: process.platform,

  initialLocale,
  onLocaleChanged: (cb: (locale: string) => void) => on("locale:changed", cb),

  settings: {
    get: (key: string) =>
      ipcRenderer.invoke("settings:get", key) as Promise<string | null>,
    set: (key: string, value: string) =>
      ipcRenderer.invoke("settings:set", key, value) as Promise<void>,
    /** Fired when main asks the renderer to open a Settings section (e.g. an
     *  update-notification click jumps to "about"). */
    onFocusSection: (cb: (section: string) => void) =>
      on<string>("settings:focus", cb),
  },

  network: {
    /** Persisted outbound HTTP(S) proxy URL (empty = direct). */
    getProxy: () => ipcRenderer.invoke("network:getProxy") as Promise<string>,
    /** Validate + persist + apply immediately; throws on an invalid URL. */
    setProxy: (url: string) =>
      ipcRenderer.invoke("network:setProxy", url) as Promise<void>,
  },

  workdir: {
    get: () => ipcRenderer.invoke("workdir:get") as Promise<WorkDirState>,
    choose: () =>
      ipcRenderer.invoke("workdir:choose") as Promise<WorkDirState | null>,
  },

  files: {
    /**
     * Absolute on-disk path of a `File` picked via an `<input type=file>`.
     * Electron 44 removed `File.path`, so `webUtils` is the supported way to
     * recover it. Returns `""` for JS-constructed `File` objects with no
     * backing file on disk, or when the argument is not a `File`.
     */
    getPath: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return "";
      }
    },
    /**
     * Persist bytes pasted into the composer that have no backing file on disk
     * (screenshots / copied image data) and return the stored attachment
     * metadata, including the absolute `path` the agent can read.
     */
    savePastedFile: (
      chatId: number,
      name: string,
      type: string,
      data: Uint8Array,
    ) =>
      ipcRenderer.invoke(
        "files:savePastedFile",
        chatId,
        name,
        type,
        data,
      ) as Promise<MessageAttachment>,
    /**
     * Remove the on-disk copy of a pasted attachment (chip discarded). Main
     * verifies ownership and silently ignores anything outside the pasted
     * store, so a disk-backed user file is never deleted.
     */
    deletePastedFile: (path: string) =>
      ipcRenderer.invoke("files:deletePastedFile", path) as Promise<void>,
    /**
     * Choose one or more folders from the native directory dialog. Resolves to
     * the folder name + absolute path, or `null` when cancelled. The path is
     * minted by main (never the renderer), so it is safe to forward to agents.
     */
    chooseDirectories: () =>
      ipcRenderer.invoke("files:chooseDirectories") as Promise<
        { name: string; path: string }[] | null
      >,
  },

  getVersion: () => ipcRenderer.invoke("app:getVersion") as Promise<string>,

  updater: {
    getState: () =>
      ipcRenderer.invoke("updater:getState") as Promise<UpdaterState>,
    check: () => ipcRenderer.invoke("updater:check") as Promise<UpdaterState>,
    download: () =>
      ipcRenderer.invoke("updater:download") as Promise<UpdaterState>,
    cancel: () => ipcRenderer.invoke("updater:cancel") as Promise<void>,
    install: () => ipcRenderer.invoke("updater:install") as Promise<void>,
    onState: (cb: (state: UpdaterState) => void) =>
      on<UpdaterState>("updater:state", cb),
  },

  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
    /** Hides the window — it does not quit the app (see the tray menu to quit). */
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () =>
      ipcRenderer.invoke("window:isMaximized") as Promise<boolean>,
    onMaximized: (cb: (maximized: boolean) => void) =>
      on<boolean>("window:maximized", cb),
    /** Fired when the OS window regains focus (used to re-clear unread). */
    onFocus: (cb: () => void) => on<undefined>("window:focus", cb),

    /** Global show/hide shortcut state (persisted value + OS registration). */
    getShortcut: () =>
      ipcRenderer.invoke("window:getShortcut") as Promise<WindowShortcutState>,
    /**
     * Register a recorded accelerator (`""` turns the feature off). Rejected
     * values are not persisted and leave the previous shortcut active.
     */
    setShortcut: (accelerator: string) =>
      ipcRenderer.invoke(
        "window:setShortcut",
        accelerator,
      ) as Promise<WindowShortcutUpdate>,
    /**
     * Drop / restore the OS registration while the settings recorder is
     * listening, so pressing the current combination does not hide the window.
     */
    suspendShortcut: (suspended: boolean) =>
      ipcRenderer.invoke(
        "window:suspendShortcut",
        suspended,
      ) as Promise<WindowShortcutState>,
  },

  theme: {
    get: () => ipcRenderer.invoke("theme:get") as Promise<ThemeState>,
    set: (patch: Partial<ThemeState>) =>
      ipcRenderer.invoke("theme:set", patch) as Promise<ThemeState>,
    onChanged: (cb: (state: ThemeState) => void) => on("theme:changed", cb),
  },

  employees: {
    list: () => ipcRenderer.invoke("employees:list") as Promise<Employee[]>,
    listPage: (page: PageQuery) =>
      ipcRenderer.invoke("employees:listPage", page) as Promise<
        PageResult<Employee>
      >,
    create: (input: EmployeeInput) =>
      ipcRenderer.invoke("employees:create", input) as Promise<Employee>,
    update: (id: number, input: EmployeeInput) =>
      ipcRenderer.invoke(
        "employees:update",
        id,
        input,
      ) as Promise<Employee | null>,
    remove: (id: number) =>
      ipcRenderer.invoke(
        "employees:delete",
        id,
      ) as Promise<EmployeeDeleteResult>,
    updateAvatar: (id: number, ext: string, data: Uint8Array) =>
      ipcRenderer.invoke(
        "employees:updateAvatar",
        id,
        ext,
        data,
      ) as Promise<Employee | null>,
    /**
     * Write one employee (+ its MCP servers and skill folders) to a zip the
     * user picks in a native save dialog. `null` = dialog cancelled.
     */
    exportToFile: (id: number) =>
      ipcRenderer.invoke(
        "employees:export",
        id,
      ) as Promise<EmployeeExportResult | null>,
    /**
     * Pick an exported zip and unpack it into a staging folder. Nothing is
     * applied yet: the preview carries the token the apply step needs.
     * `null` = dialog cancelled.
     */
    importInspect: () =>
      ipcRenderer.invoke(
        "employees:importInspect",
      ) as Promise<EmployeeImportPreview | null>,
    /** Apply a previewed package (creates a new employee). */
    importApply: (token: string, options: EmployeeImportApplyOptions) =>
      ipcRenderer.invoke(
        "employees:importApply",
        token,
        options,
      ) as Promise<EmployeeImportResult>,
    /** Discard a staged package the user declined. */
    importCancel: (token: string) =>
      ipcRenderer.invoke("employees:importCancel", token) as Promise<void>,
    /** Fired when main creates/updates/deletes an employee (e.g. the agent's
     *  `imb_set_employees`), so the renderer cache can re-fetch. */
    onChanged: (cb: (payload: { ids: number[] }) => void) =>
      on<{ ids: number[] }>("employees:changed", cb),
  },

  cron: {
    /** Cron jobs owned by an employee, with chat titles resolved (id 0 = assistant). */
    listByEmployee: (employeeId: number) =>
      ipcRenderer.invoke("cron:listByEmployee", employeeId) as Promise<
        CronJobInfo[]
      >,
    /** Every job across all employees (flat, creation order). */
    listAll: () => ipcRenderer.invoke("cron:listAll") as Promise<CronJobInfo[]>,
    /** Edit `schedule` + `content` only; throws on an invalid schedule. */
    update: (id: string, schedule: string, content: string) =>
      ipcRenderer.invoke(
        "cron:update",
        id,
        schedule,
        content,
      ) as Promise<CronJobInfo | null>,
    /** Persist the enabled flag and start/stop the live scheduler handle. */
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke(
        "cron:setEnabled",
        id,
        enabled,
      ) as Promise<CronJobInfo | null>,
    /** Fire a job immediately (does not touch its schedule timestamps). */
    runNow: (id: string) =>
      ipcRenderer.invoke("cron:runNow", id) as Promise<boolean>,
    /** Remove a job (stops the live scheduler handle + deletes the row). */
    remove: (id: string) =>
      ipcRenderer.invoke("cron:remove", id) as Promise<boolean>,
  },

  chats: {
    list: () => ipcRenderer.invoke("chats:list") as Promise<Chat[]>,
    summaries: () =>
      ipcRenderer.invoke("chats:summaries") as Promise<ChatSummary[]>,
    /** Pin or unpin one conversation (sorts above the rest). */
    setPinned: (id: number, pinned: boolean) =>
      ipcRenderer.invoke("chats:setPinned", id, pinned) as Promise<Chat | null>,
    /** Mute or unmute one conversation (silences its notifications). */
    setMuted: (id: number, muted: boolean) =>
      ipcRenderer.invoke("chats:setMuted", id, muted) as Promise<Chat | null>,
    summariesPage: (page: PageQuery) =>
      ipcRenderer.invoke("chats:summariesPage", page) as Promise<
        PageResult<ChatSummary>
      >,
    summary: (id: number) =>
      ipcRenderer.invoke("chats:summary", id) as Promise<ChatSummary | null>,
    rootId: (id: number) =>
      ipcRenderer.invoke("chats:rootId", id) as Promise<number>,
    markRead: (id: number) =>
      ipcRenderer.invoke("chats:markRead", id) as Promise<void>,
    onUnreadChanged: (
      cb: (payload: { chatId: number; unread: number }) => void,
    ) => on<{ chatId: number; unread: number }>("chats:unreadChanged", cb),
    onFocus: (cb: (chatId: number) => void) => on<number>("chat:focus", cb),
    onChanged: (cb: (payload: { chatId: number }) => void) =>
      on<{ chatId: number }>("chats:changed", cb),
    onDeleted: (cb: (payload: { chatIds: number[] }) => void) =>
      on<{ chatIds: number[] }>("chats:deleted", cb),
    create: (title: string, participants: number[]) =>
      ipcRenderer.invoke("chats:create", title, participants) as Promise<Chat>,
    update: (id: number, title: string) =>
      ipcRenderer.invoke("chats:update", id, title) as Promise<Chat | null>,
    updateParticipants: (id: number, changes: ChatParticipantUpdate) =>
      ipcRenderer.invoke(
        "chats:updateParticipants",
        id,
        changes,
      ) as Promise<Chat | null>,
    remove: (id: number) =>
      ipcRenderer.invoke("chats:delete", id) as Promise<boolean>,
    /** Replace one conversation's tags; returns the refreshed summary. */
    setTags: (id: number, tags: string[]) =>
      ipcRenderer.invoke(
        "chats:setTags",
        id,
        tags,
      ) as Promise<ChatSummary | null>,
    /** Merge tags into a conversation's existing ones; returns the summary. */
    addTags: (id: number, tags: string[]) =>
      ipcRenderer.invoke(
        "chats:addTags",
        id,
        tags,
      ) as Promise<ChatSummary | null>,
  },

  tags: {
    /** Candidate tags: every tag currently in use (distinct). */
    list: () => ipcRenderer.invoke("tags:list") as Promise<string[]>,
  },

  projects: {
    /**
     * Shortlisted projects (folder and/or tags) configured in Settings. Main
     * re-normalizes the stored setting, so malformed entries are already
     * dropped when they reach the renderer.
     */
    list: () => ipcRenderer.invoke("projects:list") as Promise<CommonProject[]>,
  },

  imageGen: {
    /**
     * Redraw an image message with the prompt it already carries
     * (`IMAGE_GENERATION_ENABLED`); resolves to the updated message.
     */
    reroll: (messageId: number) =>
      ipcRenderer.invoke(
        "imageGen:reroll",
        messageId,
      ) as Promise<Message | null>,
  },

  messages: {
    list: (chatId: number) =>
      ipcRenderer.invoke("messages:list", chatId) as Promise<Message[]>,
    search: (query: string) =>
      ipcRenderer.invoke("messages:search", query) as Promise<
        MessageSearchResult[]
      >,
    append: (
      chatId: number,
      senderEmployeeId: number | null,
      content: string,
    ) =>
      ipcRenderer.invoke(
        "messages:append",
        chatId,
        senderEmployeeId,
        content,
      ) as Promise<Message>,
    /**
     * Answer an ask card. `attachments` are files the boss attaches to this
     * answer; they are stored on the `answer` message itself (the same
     * `messages.attachments` column every other kind uses), not inside the
     * answers JSON. Omitted/empty = today's attachment-less answer.
     */
    answer: (
      chatId: number,
      askMessageId: number,
      answers: object,
      attachments?: MessageAttachment[],
    ) =>
      ipcRenderer.invoke(
        "messages:answer",
        chatId,
        askMessageId,
        answers,
        attachments,
      ) as Promise<Message>,
    /** Reveal an attachment's file in the OS file manager (main resolves the path). */
    revealAttachment: (messageId: number, index: number) =>
      ipcRenderer.invoke(
        "messages:revealAttachment",
        messageId,
        index,
      ) as Promise<void>,
    onChanged: (cb: (payload: MessageChangedPayload) => void) =>
      on<MessageChangedPayload>("messages:changed", cb),
  },

  chat: {
    send: (
      chatId: number,
      content: string,
      attachments?: MessageAttachment[],
    ) =>
      ipcRenderer.invoke(
        "chat:send",
        chatId,
        content,
        attachments,
      ) as Promise<Message>,
  },

  agentSession: {
    bind: (employeeId: number, chatId: number) =>
      ipcRenderer.invoke(
        "agentSession:bind",
        employeeId,
        chatId,
      ) as Promise<void>,
    unbind: (employeeId: number, chatId: number) =>
      ipcRenderer.invoke(
        "agentSession:unbind",
        employeeId,
        chatId,
      ) as Promise<void>,
    /**
     * Interrupt every agent session belonging to a chat (task group): its
     * non-assistant employee participants plus the assistant's root-chat
     * orchestration session. Returns the number of session states acted on.
     */
    interruptChat: (chatId: number) =>
      ipcRenderer.invoke(
        "agentSession:interruptChat",
        chatId,
      ) as Promise<number>,
    /**
     * Interrupt the **current turn** of one `(employee, chat)` session (the
     * agent-session view's button). Queued messages are kept and the session
     * stays alive. Returns whether a streaming run was actually interrupted;
     * `false` is the harmless no-op when the session is idle.
     */
    interruptTurn: (employeeId: number, chatId: number) =>
      ipcRenderer.invoke(
        "agentSession:interruptTurn",
        employeeId,
        chatId,
      ) as Promise<boolean>,
    /**
     * Send a message into exactly one `(employee, chat)` agent session (the
     * session view's composer). The main process decides between steering the
     * live run and queueing; nothing is written to the conversation. A steered
     * text also comes back with a `steerId`, which is what
     * `revokeSteer` addresses.
     */
    send: (employeeId: number, chatId: number, text: string) =>
      ipcRenderer.invoke(
        "agentSession:send",
        employeeId,
        chatId,
        text,
      ) as Promise<AgentSessionSendResult>,
    /**
     * Withdraw one interjection of one session (its text never reaches the
     * model). `withdrawn: false` is a normal answer with a `reason` — the text
     * may already be part of the transcript, or no longer queued.
     */
    revokeSteer: (employeeId: number, chatId: number, steerId: string) =>
      ipcRenderer.invoke(
        "agentSession:revokeSteer",
        employeeId,
        chatId,
        steerId,
      ) as Promise<AgentSessionSteerRevokeResult>,
    /**
     * Cosmetic run state of one session (labels + the interrupt chip's enabled
     * state). Not authoritative for routing: `send` re-checks it main-side.
     */
    state: (employeeId: number, chatId: number) =>
      ipcRenderer.invoke(
        "agentSession:state",
        employeeId,
        chatId,
      ) as Promise<AgentSessionRunState>,
    onEvent: (cb: (payload: AgentStreamPayload) => void) =>
      on<AgentStreamPayload>("agentSession:event", cb),
  },

  sessions: {
    /** Projected, read-only session view (no system prompt / tool args / results). */
    entries: (employeeId: number, chatId: number) =>
      ipcRenderer.invoke("sessions:entries", employeeId, chatId) as Promise<
        AgentSessionViewEntry[]
      >,
    get: (employeeId: number, chatId: number) =>
      ipcRenderer.invoke(
        "sessions:get",
        employeeId,
        chatId,
      ) as Promise<EmployeeSession | null>,
    set: (employeeId: number, chatId: number, sessionPath: string) =>
      ipcRenderer.invoke(
        "sessions:set",
        employeeId,
        chatId,
        sessionPath,
      ) as Promise<void>,
    remove: (employeeId: number, chatId: number) =>
      ipcRenderer.invoke(
        "sessions:delete",
        employeeId,
        chatId,
      ) as Promise<boolean>,
  },

  providers: {
    list: () => ipcRenderer.invoke("providers:list") as Promise<ProviderInfo[]>,
    listPage: (page: PageQuery) =>
      ipcRenderer.invoke("providers:listPage", page) as Promise<
        PageResult<ProviderInfo>
      >,
    upsert: (input: ProviderUpsert) =>
      ipcRenderer.invoke("providers:upsert", input) as Promise<void>,
    remove: (id: string) =>
      ipcRenderer.invoke("providers:remove", id) as Promise<void>,
    copyKey: (id: string) =>
      ipcRenderer.invoke("providers:copyKey", id) as Promise<boolean>,
    listModels: (input: ProviderModelsQuery) =>
      ipcRenderer.invoke("providers:listModels", input) as Promise<string[]>,
    /** Subscription sign-in. Resolves after the credential is stored. */
    login: (id: string) =>
      ipcRenderer.invoke("providers:login", id) as Promise<void>,
    cancelLogin: () =>
      ipcRenderer.invoke("providers:cancelLogin") as Promise<void>,
    /** Paste step for a subscription flow that cannot finish in the browser. */
    submitLogin: (value: string) =>
      ipcRenderer.invoke("providers:submitLogin", value) as Promise<void>,
    onLoginEvent: (cb: (event: ProviderLoginEvent) => void) =>
      on<ProviderLoginEvent>("providers:loginEvent", cb),
  },

  models: {
    list: () => ipcRenderer.invoke("models:list") as Promise<ModelOption[]>,
  },

  integrations: {
    getState: () =>
      ipcRenderer.invoke("integrations:getState") as Promise<IntegrationState>,
    setConfig: (platform: IntegrationPlatform, patch: IntegrationConfigPatch) =>
      ipcRenderer.invoke(
        "integrations:setConfig",
        platform,
        patch,
      ) as Promise<IntegrationState>,
    setEnabled: (platform: IntegrationPlatform, enabled: boolean) =>
      ipcRenderer.invoke(
        "integrations:setEnabled",
        platform,
        enabled,
      ) as Promise<IntegrationState>,
    login: (platform: IntegrationPlatform) =>
      ipcRenderer.invoke(
        "integrations:login",
        platform,
      ) as Promise<IntegrationState>,
    logout: (platform: IntegrationPlatform) =>
      ipcRenderer.invoke(
        "integrations:logout",
        platform,
      ) as Promise<IntegrationState>,
    clearContacts: (platform: IntegrationPlatform) =>
      ipcRenderer.invoke(
        "integrations:clearContacts",
        platform,
      ) as Promise<IntegrationState>,
    onState: (cb: (state: IntegrationState) => void) =>
      on<IntegrationState>("integrations:state", cb),
    onQr: (cb: (qr: IntegrationQrState) => void) =>
      on<IntegrationQrState>("integrations:qr", cb),
  },

  mcp: {
    list: () => ipcRenderer.invoke("mcp:list") as Promise<McpServer[]>,
    create: (input: McpServerInput) =>
      ipcRenderer.invoke("mcp:create", input) as Promise<McpServer>,
    update: (name: string, input: McpServerInput) =>
      ipcRenderer.invoke(
        "mcp:update",
        name,
        input,
      ) as Promise<McpServer | null>,
    /** Delete a server; the result reports the employees it was unlinked from. */
    remove: (name: string) =>
      ipcRenderer.invoke("mcp:delete", name) as Promise<CapabilityUnlinkResult>,
  },

  skills: {
    list: () => ipcRenderer.invoke("skills:list") as Promise<InstalledSkill[]>,
    listPage: (page: PageQuery) =>
      ipcRenderer.invoke("skills:listPage", page) as Promise<
        PageResult<InstalledSkill>
      >,
    install: () =>
      ipcRenderer.invoke("skills:install") as Promise<string[] | null>,
    /** Uninstall a skill folder, unlinking it from the employees that had it. */
    uninstall: (name: string) =>
      ipcRenderer.invoke(
        "skills:uninstall",
        name,
      ) as Promise<CapabilityUnlinkResult>,
    onChanged: (cb: () => void) => on("skills:changed", cb),
  },

  miniapps: {
    list: () => ipcRenderer.invoke("miniapps:list") as Promise<MiniApp[]>,
    setOrder: (ids: string[]) =>
      ipcRenderer.invoke("miniapps:setOrder", ids) as Promise<MiniApp[]>,
    /** Ensure the app's server is running and reachable, then return it. */
    open: (id: string) =>
      ipcRenderer.invoke("miniapps:open", id) as Promise<MiniApp>,
  },

  spend: {
    /** Aggregated token/cost report, per employee and as a grand total. */
    report: (range: SpendRange) =>
      ipcRenderer.invoke("spend:report", range) as Promise<SpendReport>,
  },

  backup: {
    /** Staged-restore state and the folders earlier restores kept aside. */
    status: () => ipcRenderer.invoke("backup:status") as Promise<BackupStatus>,
    /** Pick a destination and write a full backup; `null` when cancelled. */
    export: () =>
      ipcRenderer.invoke("backup:export") as Promise<BackupInfo | null>,
    /** Pick an archive and read its manifest; `null` when cancelled. */
    inspect: () =>
      ipcRenderer.invoke("backup:inspect") as Promise<BackupInfo | null>,
    /** Unpack an archive and stage it for the next launch. */
    restore: (path: string) =>
      ipcRenderer.invoke("backup:restore", path) as Promise<StagedRestore>,
    /** Forget a staged restore and delete its unpacked copy. */
    cancelRestore: () =>
      ipcRenderer.invoke("backup:cancelRestore") as Promise<void>,
    /** Restart the app so a staged restore is applied. */
    restart: () => ipcRenderer.invoke("backup:restart") as Promise<void>,
  },
};

contextBridge.exposeInMainWorld("imb", api);

export type IMB = typeof api;

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
