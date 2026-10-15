import { DEFAULT_LOCALE } from "@shared/constants/locales";
import type {
  AgentSessionViewEntry,
  AgentStreamPayload,
  BackupInfo,
  BackupStatus,
  Chat,
  ChatParticipantUpdate,
  ChatSummary,
  CronJobInfo,
  Employee,
  EmployeeDeleteResult,
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
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () =>
      ipcRenderer.invoke("window:isMaximized") as Promise<boolean>,
    onMaximized: (cb: (maximized: boolean) => void) =>
      on<boolean>("window:maximized", cb),
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
    answer: (chatId: number, askMessageId: number, answers: object) =>
      ipcRenderer.invoke(
        "messages:answer",
        chatId,
        askMessageId,
        answers,
      ) as Promise<Message>,
    /** Reveal an attachment's file in the OS file manager (main resolves the path). */
    revealAttachment: (messageId: number, index: number) =>
      ipcRenderer.invoke(
        "messages:revealAttachment",
        messageId,
        index,
      ) as Promise<void>,
    onChanged: (
      cb: (payload: {
        chatId: number;
        senderEmployeeId: number | null;
        silent?: boolean;
        root: boolean;
      }) => void,
    ) =>
      on<{
        chatId: number;
        senderEmployeeId: number | null;
        silent?: boolean;
        root: boolean;
      }>("messages:changed", cb),
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
    /** Subscription device-code sign-in. Resolves after the credential is stored. */
    login: (id: string) =>
      ipcRenderer.invoke("providers:login", id) as Promise<void>,
    cancelLogin: () =>
      ipcRenderer.invoke("providers:cancelLogin") as Promise<void>,
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
    remove: (name: string) =>
      ipcRenderer.invoke("mcp:delete", name) as Promise<boolean>,
  },

  skills: {
    list: () => ipcRenderer.invoke("skills:list") as Promise<InstalledSkill[]>,
    listPage: (page: PageQuery) =>
      ipcRenderer.invoke("skills:listPage", page) as Promise<
        PageResult<InstalledSkill>
      >,
    install: () =>
      ipcRenderer.invoke("skills:install") as Promise<string[] | null>,
    uninstall: (name: string) =>
      ipcRenderer.invoke("skills:uninstall", name) as Promise<void>,
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
    export: (options: { includeCredentials: boolean }) =>
      ipcRenderer.invoke("backup:export", options) as Promise<BackupInfo | null>,
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
