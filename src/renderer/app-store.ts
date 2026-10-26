import { ASSISTANT_ID } from "@shared/constants/employees";
import { SettingKeys } from "@shared/constants/settings";
import { t } from "@shared/l10n";
import type {
  ChatSummary,
  Employee,
  InstalledSkill,
  IntegrationConfigPatch,
  IntegrationPlatform,
  IntegrationState,
  McpServer,
  MiniApp,
  ProviderInfo,
  SpendGrouping,
  SpendRange,
  ThemeState,
  UpdaterState,
} from "@shared/types";
import { createRef } from "react";
import { proxy, useSnapshot } from "valtio";
import { clearAskDraftsForChat } from "./ask-draft";
import { onChatsDeleted } from "./chat-events";
import {
  invalidateChatSummary,
  setCachedChatSummary,
} from "./chat-summary-cache";
import {
  revokeDraftUrls,
  type ChatDraft,
  type PendingAttachment,
} from "./chat-draft";
import { updateLocale } from "./locale";
import { playNotificationSound } from "./sound";
import { updateThemeState } from "./theme";

export type AppModule =
  | "chat"
  | "employees"
  | "cron"
  | "settings"
  | "miniapp"
  | "group-chat"
  | "agent-session"
  | "spend";

/** A group chat opened from a `chat`-kind card and shown in the Nav. */
export interface OpenedChat {
  id: number;
  title: string;
  participants: number[];
  /**
   * The chat this one was spawned from (`null` for a root chat). Snapshotted at
   * open time and used by the group-chat view to label itself with the root
   * conversation's title (see `GroupChatModule`).
   */
  fromChatId: number | null;
}

/** An employee/assistant agent session opened from a chat avatar, shown in the Nav. */
export interface OpenedSession {
  employeeId: number;
  chatId: number;
  /** Snapshot of the chat title at open time; employee names resolve live. */
  chatTitle: string;
}

/**
 * One entry of the combined Nav "opened" section. Group chats and agent
 * sessions share one ordered list so they can be interleaved and reordered
 * together (drag-and-drop).
 */
export type OpenedItem =
  ({ kind: "chat" } & OpenedChat) | ({ kind: "session" } & OpenedSession);

/** Structural subset of `OpenedItem` needed to derive its stable Nav key.
 *  Also accepts the deeply-readonly valtio snapshot of an `OpenedItem`. */
export type OpenedItemRef =
  | { kind: "chat"; id: number }
  | { kind: "session"; employeeId: number; chatId: number };

/** Stable key for an opened `(employee, chat)` agent session. */
export function sessionKey(employeeId: number, chatId: number): string {
  return `${employeeId}/${chatId}`;
}

/** Stable Nav key (drag-and-drop id + order map key) for an opened entry. */
export function openedItemKey(item: OpenedItemRef): string {
  return item.kind === "chat"
    ? `chat:${item.id}`
    : `session:${sessionKey(item.employeeId, item.chatId)}`;
}

/** Parse a `sessionKey` back into its ids, or `null` when malformed. */
export function parseSessionKey(
  key: string,
): { employeeId: number; chatId: number } | null {
  const [employeePart, chatPart] = key.split("/");
  const employeeId = Number(employeePart);
  const chatId = Number(chatPart);
  if (!Number.isSafeInteger(employeeId) || !Number.isSafeInteger(chatId)) {
    return null;
  }
  return { employeeId, chatId };
}

/** Sections of the Settings module. Lifted here so main can deep-link to one. */
export type SettingsSection =
  | "general"
  | "projects"
  | "theme"
  | "providers"
  | "mcp"
  | "skills"
  | "integrations"
  | "network"
  | "backup"
  | "about";

/**
 * Modules whose list pane has filter state (a search box and/or a tag filter)
 * that must survive a module switch. See `filters` below.
 */
export type FilterModule =
  "chat" | "employees" | "cron" | "spend" | "settings-mcp" | "settings-skills";

/**
 * Filter state of one module's list pane. Both fields are always present so the
 * shared hook has one uniform shape; a module without a search box (spend) or
 * without a tag filter (employees / cron / the two Settings panes) simply never
 * writes that field.
 */
export interface ModuleFilterState {
  /** Raw search-box text (the debounce is applied by the consumer). */
  query: string;
  /** Tag filter (AND). May contain `TAG_FILTER_NONE` (the "No tags" pseudo
   *  value) where the module offers it. */
  tags: string[];
}

/** True when running on macOS (native traffic lights stay, no custom buttons). */
export const IS_MAC = imb.platform === "darwin";

/** Pane mount points for modules (portal targets). These are mutable DOM refs,
 *  not reactive state, so they live outside the valtio proxy. */
export const listPaneRef = createRef<HTMLElement | null>();
export const detailPaneRef = createRef<HTMLElement | null>();

/** Single content pane used by two-column (list-less) modules. */
export const contentPaneRef = createRef<HTMLElement | null>();

const VALID_MODULES: AppModule[] = [
  "chat",
  "employees",
  "cron",
  "spend",
  "settings",
  "miniapp",
];

/**
 * Sidebar modules that were moved into the Settings module (model providers,
 * MCP, Skills). A `ui.module` stored by a build from before the migration
 * still opens Settings on the matching section instead of silently falling
 * back to Chat.
 */
const LEGACY_MODULE_SECTIONS: Record<string, SettingsSection> = {
  providers: "providers",
  mcp: "mcp",
  skills: "skills",
};

/** Global renderer app state (valtio proxy — replaces the former context). */
export const appStore = proxy({
  locale: imb.initialLocale,
  theme: { mode: "system", color: "#07C160" } as ThemeState,
  module: "chat" as AppModule,

  /** Folder id of the mini app currently open in `module === "miniapp"`. */
  activeMiniAppId: null as string | null,

  // Mini apps visited this session, in first-visit order. Their frames are
  // kept mounted (hidden when inactive) so switching sidebar modules never
  // reloads a page. Session-only: deliberately not persisted.
  visitedMiniAppIds: [] as string[],

  // Group chats opened from `chat`-kind link cards and agent sessions opened
  // from a chat avatar, rendered together in one Nav "opened" section and
  // reorderable as a whole. Session-only: deliberately not persisted, so a
  // restart starts with none and the app falls back to the chat module.
  openedItems: [] as OpenedItem[],
  activeChatId: null as number | null,
  activeSessionKey: null as string | null,

  /**
   * Remote path browser (`components/path-browser`): the only UI state here that
   * belongs to the *backend* rather than this window. `title` is set by the flow
   * that asked for a folder; the resolver lives in `remote-files.ts` so a
   * function is never proxied by the store.
   */
  pathBrowser: { open: false, title: "" } as { open: boolean; title: string },

  /**
   * Remote transport facts the window was started with (`remote-files.ts` owns
   * the helpers). `incompatibility` non-null = the shell and the backend disagree
   * about the channel contract; the shell banner says so and read-only browsing
   * keeps working.
   */
  remote: {
    enabled: imb.remote.enabled === true,
    incompatibility: (imb.remote.incompatibility ?? null) as {
      shell: number;
      backend: number;
    } | null,
  },

  /**
   * Bumped every time the remote transport tells us the event stream could not
   * be resumed (backend restart, long outage, backpressure). Whatever the UI
   * holds may be stale from that moment on, so the snapshot-loading effects
   * (chat thread, agent session) include this in their dependencies and refetch.
   * Always 0 in local mode — there is no gap to recover from.
   */
  resyncEpoch: 0,

  // Pending chat to select when the chat module is mounted (set by an OS
  // notification click). Cleared once consumed.
  focusChatId: null as number | null,

  // Pending employee to select when the employees module is mounted (set by the
  // agent-session header's name link). Cleared once consumed.
  focusEmployeeId: null as number | null,

  // Spend module selection: the grouping dimension (conversation list is the
  // default), the time window (only shown for the employee grouping), and the
  // active row per grouping. `null` employee/chat = the grand-total row.
  // Session-only, so a module switch keeps the view the user left.
  spendGrouping: "chat" as SpendGrouping,
  spendRange: "today" as SpendRange,
  activeSpendEmployeeId: null as number | null,
  activeSpendChatId: null as number | null,

  // Per-chat composer drafts (text + pending attachments). Kept here so the
  // chat module can be unmounted on a module switch without losing input.
  // Session-only: deliberately not persisted.
  chatDrafts: {} as Record<number, ChatDraft>,

  // Composer drafts of the agent-session view, keyed by `"<employee>/<chat>"`
  // (the session identity, see `sessionKey`). Text only: that composer has no
  // attachments. Session-only, like `chatDrafts`.
  sessionDrafts: {} as Record<string, string>,

  // Root chat currently selected in the chat module. Distinct from
  // `activeChatId` (an opened *group* chat). Written by `ChatModule` so the
  // selection survives a module switch; session-only.
  activeRootChatId: null as number | null,

  // List-pane search / tag filter per module (see `useModuleFilter`). Modules
  // are unmounted on a module switch (App.tsx renders only the active one), so
  // the filters have to live outside the component tree to be restored.
  // Session-only: a switch keeps them, an app restart clears them (same as the
  // selection, the thread scroll and the composer drafts).
  filters: {
    chat: { query: "", tags: [] as string[] },
    employees: { query: "", tags: [] as string[] },
    cron: { query: "", tags: [] as string[] },
    spend: { query: "", tags: [] as string[] },
    "settings-mcp": { query: "", tags: [] as string[] },
    "settings-skills": { query: "", tags: [] as string[] },
  } as Record<FilterModule, ModuleFilterState>,

  // Active Settings section. Lifted out of `SettingsModule` so main can
  // deep-link to a section (the update notification opens "about").
  settingsSection: "general" as SettingsSection,

  // Auto-update state mirrored from main (see `initUpdater`).
  updater: {
    status: "idle",
    version: null,
    progress: null,
    error: null,
    checkedAt: null,
  } as UpdaterState,

  // Centralized collections loaded lazily on first visit and kept in sync by
  // the modules after each mutation (see ensureChats/ensureProviders).
  data: {
    chats: {
      items: [] as ChatSummary[],
      loading: false,
      loaded: false,
      error: null as string | null,
    },
    providers: {
      items: [] as ProviderInfo[],
      loading: false,
      loaded: false,
      error: null as string | null,
    },
    mcp: {
      items: [] as McpServer[],
      loading: false,
      loaded: false,
      error: null as string | null,
    },
    skills: {
      items: [] as InstalledSkill[],
      loading: false,
      loaded: false,
      error: null as string | null,
    },
    miniapps: {
      items: [] as MiniApp[],
      loading: false,
      loaded: false,
      error: null as string | null,
    },
    employees: {
      items: [] as Employee[],
      loading: false,
      loaded: false,
      error: null as string | null,
    },
    integrations: {
      state: null as IntegrationState | null,
      loading: false,
      loaded: false,
      error: null as string | null,
    },
  },

  // --- MCP -------------------------------------------------------------------
  async loadMcp(): Promise<void> {
    if (appStore.data.mcp.loading) return;
    appStore.data.mcp.loading = true;
    appStore.data.mcp.error = null;
    try {
      appStore.data.mcp.items = await imb.mcp.list();
      appStore.data.mcp.loaded = true;
    } catch (err) {
      console.error("[data:mcp]", err instanceof Error ? err.message : err);
      appStore.data.mcp.error =
        err instanceof Error ? err.message : String(err);
    } finally {
      appStore.data.mcp.loading = false;
    }
  },
  ensureMcp(): void {
    if (!appStore.data.mcp.loaded && !appStore.data.mcp.loading) {
      void appStore.loadMcp();
    }
  },
  // MCP servers are DB-backed; a re-fetch is the most robust way to reflect an
  // add/update/delete (including agent/external changes) in the store.
  async reloadMcp(): Promise<void> {
    if (!appStore.data.mcp.loaded) appStore.data.mcp.loading = true;
    try {
      appStore.data.mcp.items = await imb.mcp.list();
      appStore.data.mcp.loaded = true;
      appStore.data.mcp.error = null;
    } catch (err) {
      console.error("[data:mcp]", err instanceof Error ? err.message : err);
      appStore.data.mcp.error =
        err instanceof Error ? err.message : String(err);
    } finally {
      appStore.data.mcp.loading = false;
    }
  },
  addMcp(server: McpServer): void {
    appStore.data.mcp.items.push(server);
  },
  replaceMcp(server: McpServer): void {
    const index = appStore.data.mcp.items.findIndex(
      (s) => s.name === server.name,
    );
    if (index >= 0) {
      appStore.data.mcp.items[index] = server;
    }
  },
  removeMcp(name: string): void {
    const index = appStore.data.mcp.items.findIndex((s) => s.name === name);
    if (index >= 0) {
      appStore.data.mcp.items.splice(index, 1);
    }
  },

  // --- Employees --------------------------------------------------------------
  async loadEmployees(): Promise<void> {
    if (appStore.data.employees.loading) return;
    appStore.data.employees.loading = true;
    appStore.data.employees.error = null;
    try {
      appStore.data.employees.items = await imb.employees.list();
      appStore.data.employees.loaded = true;
    } catch (err) {
      console.error(
        "[data:employees]",
        err instanceof Error ? err.message : err,
      );
      appStore.data.employees.error =
        err instanceof Error ? err.message : String(err);
    } finally {
      appStore.data.employees.loading = false;
    }
  },
  ensureEmployees(): void {
    if (!appStore.data.employees.loaded && !appStore.data.employees.loading) {
      void appStore.loadEmployees();
    }
  },
  // Employees can be created/updated by main (the agent's `imb_set_employees`
  // or IPC mutations), which pushes `employees:changed`; the subscription in
  // initAppStore re-fetches so chat avatars/names stay fresh between module
  // visits.
  async reloadEmployees(): Promise<void> {
    if (!appStore.data.employees.loaded) {
      appStore.data.employees.loading = true;
    }
    try {
      appStore.data.employees.items = await imb.employees.list();
      appStore.data.employees.loaded = true;
      appStore.data.employees.error = null;
    } catch (err) {
      console.error(
        "[data:employees]",
        err instanceof Error ? err.message : err,
      );
      appStore.data.employees.error =
        err instanceof Error ? err.message : String(err);
    } finally {
      appStore.data.employees.loading = false;
    }
  },
  addEmployee(employee: Employee): void {
    // Idempotent: an `employees:changed` reload may race the optimistic add.
    const index = appStore.data.employees.items.findIndex(
      (e) => e.id === employee.id,
    );
    if (index >= 0) {
      appStore.data.employees.items[index] = employee;
    } else {
      appStore.data.employees.items.push(employee);
    }
  },
  replaceEmployee(employee: Employee): void {
    const index = appStore.data.employees.items.findIndex(
      (e) => e.id === employee.id,
    );
    if (index >= 0) {
      appStore.data.employees.items[index] = employee;
    }
  },
  removeEmployee(id: number): void {
    if (id === 0) return; // built-in assistant is never removed.
    const index = appStore.data.employees.items.findIndex((e) => e.id === id);
    if (index >= 0) {
      appStore.data.employees.items.splice(index, 1);
    }
    // A pending "open this employee's detail" jump cannot resolve any more.
    if (appStore.focusEmployeeId === id) appStore.focusEmployeeId = null;
  },

  // --- Integrations -----------------------------------------------------------
  async loadIntegrations(): Promise<void> {
    if (appStore.data.integrations.loading) return;
    appStore.data.integrations.loading = true;
    appStore.data.integrations.error = null;
    try {
      appStore.data.integrations.state = await imb.integrations.getState();
      appStore.data.integrations.loaded = true;
    } catch (err) {
      console.error(
        "[data:integrations]",
        err instanceof Error ? err.message : err,
      );
      appStore.data.integrations.error =
        err instanceof Error ? err.message : String(err);
    } finally {
      appStore.data.integrations.loading = false;
    }
  },
  ensureIntegrations(): void {
    if (
      !appStore.data.integrations.loaded &&
      !appStore.data.integrations.loading
    ) {
      void appStore.loadIntegrations();
    }
  },
  setIntegrationState(state: IntegrationState): void {
    appStore.data.integrations.state = state;
    appStore.data.integrations.loaded = true;
    appStore.data.integrations.error = null;
  },
  async setIntegrationConfig(
    platform: IntegrationPlatform,
    patch: IntegrationConfigPatch,
  ): Promise<void> {
    appStore.setIntegrationState(
      await imb.integrations.setConfig(platform, patch),
    );
  },
  async setIntegrationEnabled(
    platform: IntegrationPlatform,
    enabled: boolean,
  ): Promise<void> {
    appStore.setIntegrationState(
      await imb.integrations.setEnabled(platform, enabled),
    );
  },
  async loginIntegration(platform: IntegrationPlatform): Promise<void> {
    appStore.setIntegrationState(await imb.integrations.login(platform));
  },
  async logoutIntegration(platform: IntegrationPlatform): Promise<void> {
    appStore.setIntegrationState(await imb.integrations.logout(platform));
  },
  async clearIntegrationContacts(platform: IntegrationPlatform): Promise<void> {
    appStore.setIntegrationState(
      await imb.integrations.clearContacts(platform),
    );
  },

  // --- Skills -----------------------------------------------------------------
  async loadSkills(): Promise<void> {
    if (appStore.data.skills.loading) return;
    appStore.data.skills.loading = true;
    appStore.data.skills.error = null;
    try {
      appStore.data.skills.items = await imb.skills.list();
      appStore.data.skills.loaded = true;
    } catch (err) {
      console.error("[data:skills]", err instanceof Error ? err.message : err);
      appStore.data.skills.error =
        err instanceof Error ? err.message : String(err);
    } finally {
      appStore.data.skills.loading = false;
    }
  },
  ensureSkills(): void {
    if (!appStore.data.skills.loaded && !appStore.data.skills.loading) {
      void appStore.loadSkills();
    }
  },
  // Skills come from the filesystem (name-ASC sorted), so a re-fetch is the
  // most robust way to reflect an install/uninstall in the store. First load
  // shows the loading state; a revisit revalidates silently (stale data stays
  // visible until the response lands).
  async reloadSkills(): Promise<void> {
    if (!appStore.data.skills.loaded) appStore.data.skills.loading = true;
    try {
      appStore.data.skills.items = await imb.skills.list();
      appStore.data.skills.loaded = true;
      appStore.data.skills.error = null;
    } catch (err) {
      console.error("[data:skills]", err instanceof Error ? err.message : err);
      appStore.data.skills.error =
        err instanceof Error ? err.message : String(err);
    } finally {
      appStore.data.skills.loading = false;
    }
  },

  // --- Mini Apps --------------------------------------------------------------
  async loadMiniApps(): Promise<void> {
    if (appStore.data.miniapps.loading) return;
    appStore.data.miniapps.loading = true;
    appStore.data.miniapps.error = null;
    try {
      appStore.data.miniapps.items = await imb.miniapps.list();
      appStore.data.miniapps.loaded = true;
      appStore.pruneVisitedMiniApps();
    } catch (err) {
      console.error(
        "[data:miniapps]",
        err instanceof Error ? err.message : err,
      );
      appStore.data.miniapps.error =
        err instanceof Error ? err.message : String(err);
    } finally {
      appStore.data.miniapps.loading = false;
    }
  },
  ensureMiniApps(): void {
    if (!appStore.data.miniapps.loaded && !appStore.data.miniapps.loading) {
      void appStore.loadMiniApps();
    }
  },
  // Mini apps live on the filesystem (startup scan), so a re-fetch is the most
  // robust way to reflect an external change.
  async reloadMiniApps(): Promise<void> {
    if (!appStore.data.miniapps.loaded) appStore.data.miniapps.loading = true;
    try {
      appStore.data.miniapps.items = await imb.miniapps.list();
      appStore.data.miniapps.loaded = true;
      appStore.data.miniapps.error = null;
      appStore.pruneVisitedMiniApps();
    } catch (err) {
      console.error(
        "[data:miniapps]",
        err instanceof Error ? err.message : err,
      );
      appStore.data.miniapps.error =
        err instanceof Error ? err.message : String(err);
    } finally {
      appStore.data.miniapps.loading = false;
    }
  },
  /** Persist a new sidebar order (drag-and-drop) and apply the result. */
  async reorderMiniApps(ids: string[]): Promise<void> {
    try {
      appStore.data.miniapps.items = await imb.miniapps.setOrder(ids);
      appStore.data.miniapps.loaded = true;
      appStore.data.miniapps.error = null;
    } catch (err) {
      console.error(
        "[data:miniapps:reorder]",
        err instanceof Error ? err.message : err,
      );
      appStore.data.miniapps.error =
        err instanceof Error ? err.message : String(err);
    }
  },
  /** Open a mini app: switch the module, remember it for the next launch, and
   *  keep its frame mounted for the rest of the session. The server is started
   *  by the frame itself (`imb.miniapps.open`). */
  openMiniApp(id: string): void {
    if (!appStore.visitedMiniAppIds.includes(id)) {
      appStore.visitedMiniAppIds.push(id);
    }
    appStore.activeMiniAppId = id;
    appStore.module = "miniapp";
    void imb.settings.set(SettingKeys.MiniAppActive, id);
    void imb.settings.set(SettingKeys.Module, "miniapp");
  },
  /** Drop visited apps whose folder is gone; recover the active one to Chat. */
  pruneVisitedMiniApps(): void {
    const ids = new Set(appStore.data.miniapps.items.map((app) => app.id));
    appStore.visitedMiniAppIds = appStore.visitedMiniAppIds.filter((id) =>
      ids.has(id),
    );
    if (
      appStore.activeMiniAppId !== null &&
      !ids.has(appStore.activeMiniAppId)
    ) {
      appStore.activeMiniAppId = null;
      if (appStore.module === "miniapp") {
        appStore.module = "chat";
        void imb.settings.set(SettingKeys.Module, "chat");
      }
    }
  },

  // --- Chats (full cache) --------------------------------------------------------
  async loadChats(): Promise<void> {
    if (appStore.data.chats.loading) return;
    appStore.data.chats.loading = true;
    appStore.data.chats.error = null;
    try {
      appStore.data.chats.items = await imb.chats.summaries();
      appStore.data.chats.loaded = true;
      sortChats();
    } catch (err) {
      console.error("[data:chats]", err instanceof Error ? err.message : err);
      appStore.data.chats.error =
        err instanceof Error ? err.message : String(err);
    } finally {
      appStore.data.chats.loading = false;
    }
  },
  ensureChats(): void {
    if (!appStore.data.chats.loaded && !appStore.data.chats.loading) {
      void appStore.loadChats();
    }
  },
  async reloadChats(): Promise<void> {
    try {
      appStore.data.chats.items = await imb.chats.summaries();
      appStore.data.chats.loaded = true;
      appStore.data.chats.error = null;
      sortChats();
    } catch (err) {
      console.error("[data:chats]", err instanceof Error ? err.message : err);
      appStore.data.chats.error =
        err instanceof Error ? err.message : String(err);
    }
  },
  /**
   * Re-read one chat's summary and apply it to **every** consumer of that data:
   * the root-chat list cache, the opened Nav entries, and the shared link-card
   * summary cache (`chat-summary-cache`).
   *
   * One IPC read, no matter how many surfaces show the chat. Driven by
   * `messages:changed` (so a group chat's **participant list** follows an
   * assistant `imb_add_participant` — the join notice is a message) and by
   * `chats:changed` (rename / pin / mute / tags / auto title generation).
   *
   * Leaving group chats out of the opened-entry refresh is what used to make the
   * group avatar go stale (and, via a stale snapshot handed back to `openChat`,
   * revert to fewer members): a group chat is never part of the root-chat list,
   * but its Nav entry and its link cards are.
   */
  async refreshChatSummary(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    try {
      const summary = await imb.chats.summary(id);
      if (summary === null) {
        appStore.removeChat(id);
        invalidateChatSummary(id);
        return;
      }
      // Root chats (from_chat_id == null) are the chat module's list cache;
      // group chats must never be pushed in there.
      if (summary.fromChatId === null) appStore.replaceChat(summary);
      applyChatSummaryToOpenedItems(summary);
      // Link cards (chat card / progress card / interrupted notice).
      setCachedChatSummary(summary);
    } catch (err) {
      console.error(
        "[data:chats:refresh]",
        err instanceof Error ? err.message : err,
      );
    }
  },
  addChat(chat: ChatSummary): void {
    appStore.data.chats.items.push(chat);
    sortChats();
  },
  replaceChat(chat: ChatSummary): void {
    const index = appStore.data.chats.items.findIndex((c) => c.id === chat.id);
    if (index >= 0) {
      appStore.data.chats.items[index] = chat;
    } else {
      appStore.data.chats.items.push(chat);
    }
    sortChats();
  },
  removeChat(id: number): void {
    appStore.clearChatDraft(id);
    // The conversation's ask messages are cascade-deleted with it, so their
    // retained (unsubmitted) card drafts can never be shown again.
    clearAskDraftsForChat(id);
    if (appStore.activeRootChatId === id) {
      appStore.activeRootChatId = null;
    }
    const index = appStore.data.chats.items.findIndex((c) => c.id === id);
    if (index >= 0) {
      appStore.data.chats.items.splice(index, 1);
    }
  },
  /**
   * Drop cascade-deleted chats (root + spawned descendants) from the cached
   * list and from the Nav opened-chat entries. The id set arrives over IPC, so
   * it is filtered defensively before use.
   */
  removeDeletedChats(ids: number[]): void {
    const deleted = new Set(
      ids.filter((id) => Number.isSafeInteger(id) && id > 0),
    );
    if (deleted.size === 0) return;
    for (const id of deleted) {
      appStore.removeChat(id);
    }
    // The link cards' shared summary cache must not keep a deleted chat's
    // snapshot (the cache also invalidates on its own `chats:deleted`
    // subscription; this keeps the store's path explicit and order-free).
    for (const id of deleted) invalidateChatSummary(id);
    if (appStore.focusChatId !== null && deleted.has(appStore.focusChatId)) {
      appStore.focusChatId = null;
    }
    // Close opened group chats and agent sessions bound to deleted chats
    // (close* picks a merged-list neighbour / the chat module fallback when the
    // active one is removed).
    for (const item of [...appStore.openedItems]) {
      if (item.kind === "chat") {
        if (deleted.has(item.id)) appStore.closeChat(item.id);
      } else if (deleted.has(item.chatId)) {
        appStore.closeSession(sessionKey(item.employeeId, item.chatId));
      }
    }
  },
  setChatUnread(chatId: number, unread: number): void {
    const chat = appStore.data.chats.items.find((c) => c.id === chatId);
    if (chat) {
      chat.unread = Math.max(0, unread);
    }
  },

  // --- Chat composer drafts (session-only, per chat) --------------------------
  /**
   * Draft for `chatId`, allocating an empty one on demand so callers can mutate
   * it in place. In render, prefer the allocation-free read path
   * `appStore.chatDrafts[chatId] ?? EMPTY_DRAFT` (`src/renderer/chat-draft.ts`).
   */
  ensureChatDraft(chatId: number): ChatDraft {
    const existing = appStore.chatDrafts[chatId];
    if (existing) return existing;
    // Assigning a plain object makes valtio store a proxy whose target is that
    // object; read the entry back through the store so mutations go through the
    // proxy's set trap. Mutating the raw object directly never notifies
    // subscribers, so the first keystroke/paste into an empty composer would be
    // dropped from the snapshot (send stays disabled until the next input).
    appStore.chatDrafts[chatId] = { text: "", attachments: [] };
    return appStore.chatDrafts[chatId];
  },
  setChatDraftText(chatId: number, text: string): void {
    appStore.ensureChatDraft(chatId).text = text;
  },
  addChatDraftAttachments(chatId: number, items: PendingAttachment[]): void {
    if (items.length === 0) return;
    appStore.ensureChatDraft(chatId).attachments.push(...items);
  },
  removeChatDraftAttachment(chatId: number, index: number): void {
    const draft = appStore.chatDrafts[chatId];
    if (!draft) return;
    const [removed] = draft.attachments.splice(index, 1);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    // Delete the on-disk copy of a pasted attachment. Main verifies ownership,
    // so a disk-backed user file (original path) is never removed.
    if (removed?.attachment.path) {
      void imb.files.deletePastedFile(removed.attachment.path);
    }
    // Drop the entry entirely once it is empty so the store holds only real
    // drafts and `EMPTY_DRAFT` remains the only empty shape.
    if (draft.text.length === 0 && draft.attachments.length === 0) {
      delete appStore.chatDrafts[chatId];
    }
  },
  clearChatDraft(chatId: number): void {
    revokeDraftUrls(appStore.chatDrafts[chatId]);
    delete appStore.chatDrafts[chatId];
  },
  // --- Agent-session composer drafts (session-only, per session key) ---------
  /**
   * Store one agent-session composer's text. An empty text deletes the entry so
   * the map only ever holds real drafts (the composer reads `?? ""`).
   */
  setSessionDraftText(key: string, text: string): void {
    if (text.length === 0) {
      delete appStore.sessionDrafts[key];
      return;
    }
    appStore.sessionDrafts[key] = text;
  },
  clearSessionDraft(key: string): void {
    delete appStore.sessionDrafts[key];
  },
  setActiveRootChat(chatId: number | null): void {
    appStore.activeRootChatId = chatId;
  },

  /** Clear one module's list-pane search text and tag filter. */
  resetFilter(module: FilterModule): void {
    const filter = appStore.filters[module];
    filter.query = "";
    filter.tags = [];
  },

  // --- Providers (full cache) ----------------------------------------------------
  async loadProviders(): Promise<void> {
    if (appStore.data.providers.loading) return;
    appStore.data.providers.loading = true;
    appStore.data.providers.error = null;
    try {
      appStore.data.providers.items = await imb.providers.list();
      appStore.data.providers.loaded = true;
    } catch (err) {
      console.error(
        "[data:providers]",
        err instanceof Error ? err.message : err,
      );
      appStore.data.providers.error =
        err instanceof Error ? err.message : String(err);
    } finally {
      appStore.data.providers.loading = false;
    }
  },
  ensureProviders(): void {
    if (!appStore.data.providers.loaded && !appStore.data.providers.loading) {
      void appStore.loadProviders();
    }
  },
  // Providers are file-backed (auth/models), so a re-fetch is the most
  // robust way to reflect an upsert/remove in the store.
  async reloadProviders(): Promise<void> {
    try {
      appStore.data.providers.items = await imb.providers.list();
      appStore.data.providers.loaded = true;
      appStore.data.providers.error = null;
    } catch (err) {
      console.error(
        "[data:providers]",
        err instanceof Error ? err.message : err,
      );
      appStore.data.providers.error =
        err instanceof Error ? err.message : String(err);
    }
  },

  async focusChat(chatId: number): Promise<void> {
    // A jump to a specific chat (OS notification click, a cron job's "open
    // chat") is an explicit intent: drop the chat module's restored search /
    // tag filter first, or the target may not be part of the filtered result
    // and the pending `focusChatId` could never resolve into a selection.
    appStore.resetFilter("chat");
    appStore.focusChatId = chatId;
    appStore.module = "chat";
    await imb.settings.set(SettingKeys.Module, "chat");
  },

  /**
   * Jump to one employee's detail pane in the Employees module (the agent
   * session header's name link).
   *
   * Same shape as `focusChat`: an explicit jump drops the module's restored
   * search filter first, then hands the id to the module through
   * `focusEmployeeId` (the module is unmounted on a switch, so the pending id
   * has to live in the store). Persisted module choice, like any nav switch.
   */
  async openEmployeeDetail(employeeId: number): Promise<void> {
    if (!Number.isSafeInteger(employeeId) || employeeId < 0) return;
    appStore.resetFilter("employees");
    appStore.focusEmployeeId = employeeId;
    appStore.module = "employees";
    await imb.settings.set(SettingKeys.Module, "employees");
  },

  /** Open the Settings module on a section (persists the active module). */
  async openSettings(section: SettingsSection): Promise<void> {
    appStore.settingsSection = section;
    appStore.module = "settings";
    await imb.settings.set(SettingKeys.Module, "settings");
  },

  // --- Auto-update ------------------------------------------------------------
  setUpdaterState(next: UpdaterState): void {
    appStore.updater = next;
  },
  async checkForUpdates(): Promise<UpdaterState> {
    const next = await imb.updater.check();
    appStore.setUpdaterState(next);
    return next;
  },
  async downloadUpdate(): Promise<void> {
    await imb.updater.download();
  },
  async cancelDownload(): Promise<void> {
    await imb.updater.cancel();
  },
  async installUpdate(): Promise<void> {
    await imb.updater.install();
  },

  // --- Opened chats & agent sessions (combined Nav section) -------------------
  /**
   * Open (or focus) a group chat linked by a `chat`-kind card.
   *
   * The caller's `summary` is only a **snapshot**: the cards that call this hold
   * one from their own render (`useChatSummary`), which may predate a rename or
   * a participant edit. Rendering it immediately keeps the click instant, then
   * one `refreshChatSummary` read brings the Nav entry, the group-chat header
   * and the card cache in line with the database — a stale snapshot can no
   * longer overwrite newer data (`existing.participants` used to be clobbered
   * with the card's old member list).
   */
  openChat(chat: ChatSummary): void {
    if (!Number.isSafeInteger(chat.id) || chat.id <= 0) return;
    const existing = appStore.openedItems.find(
      (item) => item.kind === "chat" && item.id === chat.id,
    );
    const participants = [...chat.participants];
    if (existing?.kind === "chat") {
      existing.title = chat.title;
      existing.participants = participants;
      existing.fromChatId = chat.fromChatId;
    } else {
      appStore.openedItems.push({
        kind: "chat",
        id: chat.id,
        title: chat.title,
        participants,
        fromChatId: chat.fromChatId,
      });
    }
    appStore.activeChatId = chat.id;
    // Deliberately not persisted: opened entries are session-only.
    appStore.module = "group-chat";
    // Self-heal against a stale caller snapshot (see the doc comment).
    void appStore.refreshChatSummary(chat.id);
  },

  /** Focus an already-opened group chat (Nav item click). */
  activateChat(id: number): void {
    if (
      !appStore.openedItems.some(
        (item) => item.kind === "chat" && item.id === id,
      )
    ) {
      return;
    }
    appStore.activeChatId = id;
    appStore.module = "group-chat";
  },

  /**
   * Open a conversation by id in the view that can display it: a root chat is
   * selected inside the Chat module, a spawned group chat is opened as a Nav
   * entry (the Chat module's list only holds root chats, so there is no other
   * way in).
   *
   * Returns `false` when the chat no longer exists — nothing was opened, so the
   * caller decides how to report it. IPC failures are **thrown** to the caller
   * for the same reason (this helper never swallows them).
   */
  async openConversationById(chatId: number): Promise<boolean> {
    if (!Number.isSafeInteger(chatId) || chatId <= 0) return false;
    const summary = await imb.chats.summary(chatId);
    if (summary === null) return false;
    if (summary.fromChatId === null) {
      await appStore.focusChat(summary.id);
    } else {
      appStore.openChat(summary);
    }
    return true;
  },

  /** Close an opened group chat; activate the merged-list neighbour or Chat. */
  closeChat(id: number): void {
    const index = appStore.openedItems.findIndex(
      (item) => item.kind === "chat" && item.id === id,
    );
    if (index >= 0) closeOpenedItemAt(index);
  },

  /**
   * Open (or focus) an employee's agent session for a chat. The assistant has
   * no session in task group chats (it runs in its root chat), so its requests
   * are redirected to the resolved root chat.
   */
  async openAgentSession(employeeId: number, chatId: number): Promise<void> {
    if (!Number.isSafeInteger(employeeId) || !Number.isSafeInteger(chatId)) {
      return;
    }
    if (employeeId < 0 || chatId <= 0) return;

    let targetChatId = chatId;
    if (employeeId === ASSISTANT_ID) {
      try {
        targetChatId = await imb.chats.rootId(chatId);
      } catch (err) {
        console.error(
          "[agent-session:rootId]",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const key = sessionKey(employeeId, targetChatId);
    const chatTitle = await resolveChatTitle(targetChatId);
    const existing = appStore.openedItems.find(
      (item) =>
        item.kind === "session" &&
        sessionKey(item.employeeId, item.chatId) === key,
    );
    if (existing?.kind === "session") {
      existing.chatTitle = chatTitle;
    } else {
      appStore.openedItems.push({
        kind: "session",
        employeeId,
        chatId: targetChatId,
        chatTitle,
      });
    }
    appStore.activeSessionKey = key;
    appStore.module = "agent-session";
    // Needed by the Nav entry (avatar + label) and the session header.
    appStore.ensureEmployees();
  },

  /** Focus an already-opened agent session (Nav item click). */
  activateSession(key: string): void {
    if (
      !appStore.openedItems.some(
        (item) =>
          item.kind === "session" &&
          sessionKey(item.employeeId, item.chatId) === key,
      )
    ) {
      return;
    }
    appStore.activeSessionKey = key;
    appStore.module = "agent-session";
  },

  /** Close an opened agent session; activate the merged-list neighbour or Chat. */
  closeSession(key: string): void {
    const index = appStore.openedItems.findIndex(
      (item) =>
        item.kind === "session" &&
        sessionKey(item.employeeId, item.chatId) === key,
    );
    if (index >= 0) closeOpenedItemAt(index);
  },

  /**
   * Close every opened group chat and agent session (Nav 「Close all」).
   *
   * Deliberately not a loop of `closeChat`/`closeSession`: those activate a
   * neighbour and switch the module per entry, whereas the whole list is gone
   * here in one synchronous update. Closing is view-only — drafts
   * (`chatDrafts` / `sessionDrafts`), unread counts, pins and running agent
   * sessions (their runs continue in main; the view merely unbinds) are
   * untouched — so no confirmation is required.
   */
  closeAllOpenedItems(): void {
    if (appStore.openedItems.length === 0) return;
    appStore.openedItems.splice(0, appStore.openedItems.length);
    // Both active pointers now refer to entries that no longer exist.
    appStore.activeChatId = null;
    appStore.activeSessionKey = null;
    // Only these two modules display an opened entry; elsewhere the current
    // view is unrelated and must stay.
    if (
      appStore.module === "group-chat" ||
      appStore.module === "agent-session"
    ) {
      appStore.module = "chat";
    }
  },

  /**
   * Close every opened Nav entry except one (Nav 「Close others」).
   *
   * The kept entry is the one that was right-clicked, so the view follows the
   * right-click: whatever is left on screen is exactly what the boss asked to
   * keep. Like `closeAllOpenedItems`, this is view state only — composer drafts,
   * unread counts, pins and running agent sessions (their runs continue in main;
   * the view merely unbinds) are untouched — and it never loops through
   * `closeChat`/`closeSession`, which would activate neighbours and switch the
   * module per entry.
   *
   * A single opened entry (or an unknown reference) is a no-op.
   */
  closeOtherOpenedItems(ref: OpenedItemRef): void {
    const keepKey = openedItemKey(ref);
    const kept = appStore.openedItems.find(
      (item) => openedItemKey(item) === keepKey,
    );
    if (!kept || appStore.openedItems.length <= 1) return;
    appStore.openedItems.splice(0, appStore.openedItems.length, kept);
    // The kept entry is the only one left, so both pointers are unambiguous.
    if (kept.kind === "chat") {
      appStore.activeSessionKey = null;
      appStore.activeChatId = kept.id;
      appStore.module = "group-chat";
    } else {
      appStore.activeChatId = null;
      appStore.activeSessionKey = sessionKey(kept.employeeId, kept.chatId);
      appStore.module = "agent-session";
    }
  },

  /**
   * Apply a new combined Nav order (drag-and-drop). Session-only, so nothing is
   * persisted. Unknown/duplicate keys are ignored and any omitted entry is kept
   * (appended) so the live set always matches the rendered order.
   */
  reorderOpenedItems(keys: string[]): void {
    const byKey = new Map(
      appStore.openedItems.map((item) => [openedItemKey(item), item]),
    );
    const next: OpenedItem[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      const item = byKey.get(key);
      if (!item || seen.has(key)) continue;
      next.push(item);
      seen.add(key);
    }
    for (const item of appStore.openedItems) {
      if (!seen.has(openedItemKey(item))) next.push(item);
    }
    appStore.openedItems.splice(0, appStore.openedItems.length, ...next);
  },
});

/** One-time app-state bootstrap (theme/locale subscriptions + persisted prefs). */
let initialized = false;
export async function initAppStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await Promise.all([
    imb.theme.get(),
    imb.settings.get(SettingKeys.Module),
    imb.settings.get(SettingKeys.MiniAppActive),
  ]).then(([theme, storedModule, storedMiniApp]) => {
    updateThemeState(theme);
    if (storedModule) {
      const legacySection = LEGACY_MODULE_SECTIONS[storedModule] ?? null;
      if (legacySection !== null) {
        appStore.settingsSection = legacySection;
        appStore.module = "settings";
      } else if ((VALID_MODULES as string[]).includes(storedModule)) {
        appStore.module = storedModule as AppModule;
      }
    }
    appStore.activeMiniAppId = storedMiniApp;
  });
  imb.onLocaleChanged(updateLocale);
  imb.theme.onChanged(updateThemeState);

  // Mini apps back the always-mounted Nav, so load them eagerly, then drop a
  // stale restored app (folder deleted since last launch) back to Chat.
  await appStore.loadMiniApps();
  appStore.pruneVisitedMiniApps();
  if (
    appStore.module === "miniapp" &&
    appStore.activeMiniAppId !== null &&
    appStore.data.miniapps.items.some(
      (app) => app.id === appStore.activeMiniAppId,
    )
  ) {
    // Session-only visited set: remount only the restored active app so it
    // keeps its page for the rest of the session.
    appStore.visitedMiniAppIds = [appStore.activeMiniAppId];
  }

  // Chats / MCP / skills / employees / providers are NOT loaded here. They are
  // lazy-loaded by their module on first visit (see ensure*), and kept in sync
  // by the modules after each mutation.

  // Chats: every message append refreshes that chat's summary (preview,
  // lastAt, unread) and re-sorts the cached list. A lightweight unread-only
  // event (imb_notify) updates items[].unread directly.
  imb.messages.onChanged(
    ({ chatId, senderEmployeeId, silent, root, muted, kind }) => {
      void appStore.refreshChatSummary(chatId);
      // Beep for any non-silent employee/assistant message in a root chat,
      // regardless of the active module or the selected chat (group chats, muted
      // chats and silent acks stay quiet). Throttled inside
      // playNotificationSound().
      //
      // Progress cards are the exception: they post in bursts (one card per step
      // update) and the thread folds a run of them into one card the boss pages
      // through, so they keep bumping the unread badge (done in main) but never
      // ring.
      if (
        root &&
        senderEmployeeId !== null &&
        !silent &&
        !muted &&
        kind !== "progress"
      ) {
        playNotificationSound();
      }
    },
  );
  // Title-only updates (auto title generation lands asynchronously, after the
  // messages:changed refresh) — same summary refresh keeps list, Nav entries,
  // group-chat header and link cards in sync with one IPC read.
  imb.chats.onChanged(({ chatId }) => {
    void appStore.refreshChatSummary(chatId);
  });
  // Cascade deletes push the full deleted id set (root + spawned chats) so the
  // list cache, Nav opened chats and the focus target all stay consistent.
  // App-lifetime subscription (never released), routed through the shared
  // `chats:deleted` dispatcher so the renderer keeps exactly one IPC listener
  // no matter how many link cards are mounted — see `chat-events.ts`.
  onChatsDeleted((chatIds) => {
    appStore.removeDeletedChats(chatIds);
  });
  imb.chats.onUnreadChanged(({ chatId, unread }) => {
    appStore.setChatUnread(chatId, unread);
  });

  // Employees can change from main with no renderer-side mutation (notably the
  // agent's `imb_set_employees` when it recruits staff mid-conversation).
  // Re-fetch the cache so chat avatars/names resolve immediately.
  imb.employees.onChanged(() => {
    void appStore.reloadEmployees();
  });

  // OS notification click → switch to the chat module and select the chat.
  imb.chats.onFocus((chatId) => {
    void appStore.focusChat(chatId);
  });

  // The remote event stream could not be resumed: refetch every snapshot we
  // already hold, and bump `resyncEpoch` so the views that own their own data
  // (chat thread, agent session) reload as well. Local mode never fires this.
  imb.remote.onResync(({ reason }) => {
    console.warn(`[remote] resync (${reason}); refetching snapshots`);
    appStore.resyncEpoch += 1;
    if (appStore.data.chats.loaded) void appStore.reloadChats();
    if (appStore.data.employees.loaded) void appStore.reloadEmployees();
    // Mini Apps cannot work against a remote backend (see `nav/index.tsx`).
    if (!appStore.remote.enabled) void appStore.reloadMiniApps();
  });

  // Updater state is pushed by main on every transition. Fetch once as well in
  // case the startup check completed before the renderer subscribed.
  imb.updater.onState((state) => {
    appStore.setUpdaterState(state);
  });
  void imb.updater
    .getState()
    .then((state) => appStore.setUpdaterState(state))
    .catch((err) => {
      console.error("[updater:getState]", err);
    });

  // Integration config/status is pushed by main on every change (adapter
  // connect/disconnect, QR progress). Fetch once too in case a change landed
  // before the renderer subscribed.
  imb.integrations.onState((state) => appStore.setIntegrationState(state));
  void imb.integrations
    .getState()
    .then((state) => appStore.setIntegrationState(state))
    .catch((err) => {
      console.error("[integrations:getState]", err);
    });

  // Update notification click → Settings → About (validate the IPC string).
  imb.settings.onFocusSection((section) => {
    if (
      section === "general" ||
      section === "theme" ||
      section === "integrations" ||
      section === "network" ||
      section === "about"
    ) {
      void appStore.openSettings(section);
    }
  });
}

/** Reactive app-state hook (valtio snapshot). */
export function useApp() {
  return useSnapshot(appStore);
}

/**
 * Reactive app-state hook with synchronous updates, for controlled inputs where
 * the default batching can reset the DOM value/caret (valtio's documented
 * `useSnapshot(store, { sync: true })` pattern).
 */
export function useAppSync() {
  return useSnapshot(appStore, { sync: true });
}

/** Keep the chat cache ordered pinned-first, then newest-message-first
 *  (recency key, id breaks ties). Mirrors the SQL ordering in
 *  `listChatSummaries` so a client-side re-sort cannot drop pinned chats. */
function sortChats(): void {
  appStore.data.chats.items.sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      b.lastMessageAt - a.lastMessageAt ||
      b.id - a.id,
  );
}

/**
 * Write one freshly read summary into every opened Nav entry that labels itself
 * with it: agent sessions (`OpenedSession.chatTitle` — the session header and
 * its Nav label) and opened group chats (`OpenedChat.title` + `participants` —
 * its Nav label, its Nav composite avatar and the group-chat view's header).
 *
 * Both kinds are snapshots taken when the entry was opened (see
 * `openAgentSession` / `openChat`), yet they change afterwards: a freshly
 * spawned task group is named after its first messages, the boss can rename a
 * chat at any time, and the assistant can add participants to a group mid-run.
 *
 * Only changed fields are assigned (valtio re-renders on any write, and a
 * participant array is always a new reference), and only the fields listed
 * above are touched — order, unread, pins and tags are other owners' state.
 */
function applyChatSummaryToOpenedItems(summary: ChatSummary): void {
  const raw = summary.title.trim();
  const title = raw.length > 0 ? raw : t("New Chat");
  for (const item of appStore.openedItems) {
    if (item.kind === "chat") {
      if (item.id !== summary.id) continue;
      if (item.title !== title) item.title = title;
      if (item.fromChatId !== summary.fromChatId) {
        item.fromChatId = summary.fromChatId;
      }
      const current = item.participants;
      const same =
        current.length === summary.participants.length &&
        summary.participants.every((id, index) => id === current[index]);
      if (!same) item.participants = [...summary.participants];
    } else if (item.chatId === summary.id && item.chatTitle !== title) {
      item.chatTitle = title;
    }
  }
}

/**
 * Remove the opened entry at `index`. When it was the entry currently shown,
 * activate the adjacent merged-list entry (of either kind) or fall back to the
 * Chat module; otherwise only clear its active pointer so it cannot stay stale.
 */
function closeOpenedItemAt(index: number): void {
  const removed = appStore.openedItems[index];
  if (!removed) return;

  const removedSessionKey =
    removed.kind === "session"
      ? sessionKey(removed.employeeId, removed.chatId)
      : null;
  const wasDisplayed =
    removed.kind === "chat"
      ? appStore.module === "group-chat" && appStore.activeChatId === removed.id
      : appStore.module === "agent-session" &&
        appStore.activeSessionKey === removedSessionKey;

  appStore.openedItems.splice(index, 1);

  // Clear the closed entry's active pointer.
  if (removed.kind === "chat") {
    if (appStore.activeChatId === removed.id) appStore.activeChatId = null;
  } else if (appStore.activeSessionKey === removedSessionKey) {
    appStore.activeSessionKey = null;
  }

  if (!wasDisplayed) return;

  const next =
    appStore.openedItems[index] ?? appStore.openedItems[index - 1] ?? null;
  if (!next) {
    appStore.module = "chat";
    return;
  }
  if (next.kind === "chat") {
    appStore.activeChatId = next.id;
    appStore.module = "group-chat";
  } else {
    appStore.activeSessionKey = sessionKey(next.employeeId, next.chatId);
    appStore.module = "agent-session";
  }
}

/** Best-effort chat title for a Nav session label (root or group chat). */
async function resolveChatTitle(chatId: number): Promise<string> {
  const cached = appStore.data.chats.items.find((c) => c.id === chatId);
  if (cached && cached.title.trim().length > 0) return cached.title.trim();
  const opened = appStore.openedItems.find(
    (item) => item.kind === "chat" && item.id === chatId,
  );
  if (opened?.kind === "chat" && opened.title.trim().length > 0) {
    return opened.title.trim();
  }
  try {
    const summary = await imb.chats.summary(chatId);
    if (summary && summary.title.trim().length > 0) return summary.title.trim();
  } catch (err) {
    console.error(
      "[agent-session:title]",
      err instanceof Error ? err.message : err,
    );
  }
  return t("New Chat");
}
