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
  ThemeState,
  UpdaterState,
} from "@shared/types";
import { createRef } from "react";
import { proxy, useSnapshot } from "valtio";
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
  | "providers"
  | "mcp"
  | "skills"
  | "assets"
  | "settings"
  | "miniapp"
  | "group-chat"
  | "agent-session";

/** A group chat opened from a `chat`-kind card and shown in the Nav. */
export interface OpenedChat {
  id: number;
  title: string;
  participants: number[];
}

/** An employee/assistant agent session opened from a chat avatar, shown in the Nav. */
export interface OpenedSession {
  employeeId: number;
  chatId: number;
  /** Snapshot of the chat title at open time; employee names resolve live. */
  chatTitle: string;
}

/** Stable key for an opened `(employee, chat)` agent session. */
export function sessionKey(employeeId: number, chatId: number): string {
  return `${employeeId}/${chatId}`;
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
  "general" | "theme" | "integrations" | "network" | "about";

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
  "providers",
  "mcp",
  "skills",
  "assets",
  "settings",
  "miniapp",
];

/** Global renderer app state (valtio proxy — replaces the former context). */
export const appStore = proxy({
  locale: imb.initialLocale,
  theme: { mode: "system", color: "#07C160" } as ThemeState,
  navCollapsed: false,
  module: "chat" as AppModule,

  /** Folder id of the mini app currently open in `module === "miniapp"`. */
  activeMiniAppId: null as string | null,

  // Mini apps visited this session, in first-visit order. Their frames are
  // kept mounted (hidden when inactive) so switching sidebar modules never
  // reloads a page. Session-only: deliberately not persisted.
  visitedMiniAppIds: [] as string[],

  // Group chats opened from `chat`-kind link cards, rendered in the Nav
  // "chats" section. Session-only: deliberately not persisted, so a restart
  // starts with none and the app falls back to the chat module.
  openedChats: [] as OpenedChat[],
  activeChatId: null as number | null,

  // Agent sessions opened from a chat avatar, rendered in the Nav "sessions"
  // section. Session-only: deliberately not persisted, so a restart starts
  // with none and the app falls back to the chat module.
  openedSessions: [] as OpenedSession[],
  activeSessionKey: null as string | null,

  // Pending chat to select when the chat module is mounted (set by an OS
  // notification click). Cleared once consumed.
  focusChatId: null as number | null,

  // Per-chat composer drafts (text + pending attachments). Kept here so the
  // chat module can be unmounted on a module switch without losing input.
  // Session-only: deliberately not persisted.
  chatDrafts: {} as Record<number, ChatDraft>,

  // Root chat currently selected in the chat module. Distinct from
  // `activeChatId` (an opened *group* chat). Written by `ChatModule` so the
  // selection survives a module switch; session-only.
  activeRootChatId: null as number | null,

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
  async refreshChatSummary(id: number): Promise<void> {
    try {
      const summary = await imb.chats.summary(id);
      if (summary === null) {
        appStore.removeChat(id);
        return;
      }
      // Group chats (from_chat_id != null) are never cached as root chats.
      if (summary.fromChatId !== null) return;
      appStore.replaceChat(summary);
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
    if (appStore.focusChatId !== null && deleted.has(appStore.focusChatId)) {
      appStore.focusChatId = null;
    }
    // Close opened group chats (closeChat picks a neighbour / the chat module
    // fallback when the active one is removed).
    for (const chat of [...appStore.openedChats]) {
      if (deleted.has(chat.id)) appStore.closeChat(chat.id);
    }
    // Close agent sessions bound to deleted chats.
    for (const session of [...appStore.openedSessions]) {
      if (deleted.has(session.chatId)) {
        appStore.closeSession(sessionKey(session.employeeId, session.chatId));
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
    let draft = appStore.chatDrafts[chatId];
    if (!draft) {
      draft = { text: "", attachments: [] };
      appStore.chatDrafts[chatId] = draft;
    }
    return draft;
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
  setActiveRootChat(chatId: number | null): void {
    appStore.activeRootChatId = chatId;
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
    appStore.focusChatId = chatId;
    appStore.module = "chat";
    await imb.settings.set(SettingKeys.Module, "chat");
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

  // --- Opened group chats (Nav "chats" section) -------------------------------
  /** Open (or focus) a group chat linked by a `chat`-kind card. */
  openChat(chat: ChatSummary): void {
    const existing = appStore.openedChats.find((c) => c.id === chat.id);
    if (existing) {
      existing.title = chat.title;
      existing.participants = chat.participants;
    } else {
      appStore.openedChats.push({
        id: chat.id,
        title: chat.title,
        participants: chat.participants,
      });
    }
    appStore.activeChatId = chat.id;
    // Deliberately not persisted: opened chats are session-only.
    appStore.module = "group-chat";
  },

  /** Focus an already-opened group chat (Nav item click). */
  activateChat(id: number): void {
    if (!appStore.openedChats.some((c) => c.id === id)) return;
    appStore.activeChatId = id;
    appStore.module = "group-chat";
  },

  /** Close an opened group chat; fall back to a neighbour or the chat module. */
  closeChat(id: number): void {
    const index = appStore.openedChats.findIndex((c) => c.id === id);
    if (index < 0) return;
    appStore.openedChats.splice(index, 1);
    if (appStore.activeChatId !== id) return;
    const next =
      appStore.openedChats[index] ?? appStore.openedChats[index - 1] ?? null;
    if (next) {
      appStore.activeChatId = next.id;
    } else {
      appStore.activeChatId = null;
      appStore.module = "chat";
    }
  },

  // --- Opened agent sessions (Nav "sessions" section) -------------------------
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
    const existing = appStore.openedSessions.find(
      (s) => sessionKey(s.employeeId, s.chatId) === key,
    );
    if (existing) {
      existing.chatTitle = chatTitle;
    } else {
      appStore.openedSessions.push({
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
      !appStore.openedSessions.some(
        (s) => sessionKey(s.employeeId, s.chatId) === key,
      )
    ) {
      return;
    }
    appStore.activeSessionKey = key;
    appStore.module = "agent-session";
  },

  /** Close an opened agent session; fall back to a neighbour or the chat module. */
  closeSession(key: string): void {
    const index = appStore.openedSessions.findIndex(
      (s) => sessionKey(s.employeeId, s.chatId) === key,
    );
    if (index < 0) return;
    appStore.openedSessions.splice(index, 1);
    if (appStore.activeSessionKey !== key) return;
    const next =
      appStore.openedSessions[index] ??
      appStore.openedSessions[index - 1] ??
      null;
    if (next) {
      appStore.activeSessionKey = sessionKey(next.employeeId, next.chatId);
    } else {
      appStore.activeSessionKey = null;
      appStore.module = "chat";
    }
  },
});

/** One-time app-state bootstrap (theme/locale subscriptions + persisted prefs). */
let initialized = false;
export async function initAppStore(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await Promise.all([
    imb.theme.get(),
    imb.settings.get(SettingKeys.NavCollapse),
    imb.settings.get(SettingKeys.Module),
    imb.settings.get(SettingKeys.MiniAppActive),
  ]).then(([theme, collapsed, storedModule, storedMiniApp]) => {
    updateThemeState(theme);
    if (collapsed === "1") {
      appStore.navCollapsed = true;
    }
    if (storedModule && (VALID_MODULES as string[]).includes(storedModule)) {
      appStore.module = storedModule as AppModule;
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
  imb.messages.onChanged(({ chatId, senderEmployeeId, silent, root }) => {
    void appStore.refreshChatSummary(chatId);
    // Beep for any non-silent employee/assistant message in a root chat,
    // regardless of the active module or the selected chat (group chats and
    // silent acks stay quiet). Throttled inside playNotificationSound().
    if (root && senderEmployeeId !== null && !silent) {
      playNotificationSound();
    }
  });
  // Title-only updates (auto title generation lands asynchronously, after the
  // messages:changed refresh) — same summary refresh keeps list + header in sync.
  imb.chats.onChanged(({ chatId }) => {
    void appStore.refreshChatSummary(chatId);
  });
  // Cascade deletes push the full deleted id set (root + spawned chats) so the
  // list cache, Nav opened chats and the focus target all stay consistent.
  imb.chats.onDeleted(({ chatIds }) => {
    if (Array.isArray(chatIds)) appStore.removeDeletedChats(chatIds);
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

/** Keep the chat cache ordered newest-message-first (recency key, id breaks ties). */
function sortChats(): void {
  appStore.data.chats.items.sort(
    (a, b) => b.lastMessageAt - a.lastMessageAt || b.id - a.id,
  );
}

/** Best-effort chat title for a Nav session label (root or group chat). */
async function resolveChatTitle(chatId: number): Promise<string> {
  const cached = appStore.data.chats.items.find((c) => c.id === chatId);
  if (cached && cached.title.trim().length > 0) return cached.title.trim();
  const opened = appStore.openedChats.find((c) => c.id === chatId);
  if (opened && opened.title.trim().length > 0) return opened.title.trim();
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
