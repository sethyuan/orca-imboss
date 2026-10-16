import { ASSISTANT_ID } from "@shared/constants/employees";
import { INTEGRATION_PLATFORMS } from "@shared/constants/integrations";
import { t } from "@shared/l10n";
import type {
  IntegrationConfigPatch,
  IntegrationConfigView,
  IntegrationContact,
  IntegrationFieldView,
  IntegrationPlatform,
  IntegrationState,
  IntegrationStatus,
  Message,
} from "@shared/types";
import { appendMessage, onMessageAppended } from "../db/messages";
import * as dbChats from "../db/chats";
import * as dbIntegrations from "../db/integrations";
import { deliver } from "../agent/session-queue";
import { maybeGenerateChatTitle } from "../agent/title-gen";
import { sendToRenderer } from "../notifications";
import { handleCommand, parseCommand } from "./commands";
import { formatOutbound } from "./format";
import { deleteMediaForChat, saveInboundMedia } from "./media";
import { QqAdapter } from "./adapters/qq";
import { TelegramAdapter } from "./adapters/telegram";
import { WechatAdapter } from "./adapters/wechat";
import type {
  AdapterCallbacks,
  AdapterSession,
  InboundMessage,
  IntegrationAdapter,
} from "./types";
import {
  configFor,
  loadIntegrations,
  saveIntegrations,
  type ContactEntry,
  type IntegrationsFile,
  type PlatformConfig,
  type QqConfig,
  type TelegramConfig,
  type WechatConfig,
} from "./store";
import { errorMessage } from "./util";

/**
 * Central integration manager: owns adapter lifecycle, inbound routing
 * (platform → app chat → assistant) and outbound forwarding (agent message →
 * platform). One instance per app.
 */

const PERSIST_DEBOUNCE_MS = 300;
/** Discovered contacts are capped per platform and pruned after 90 days. */
const MAX_CONTACTS_PER_PLATFORM = 100;
const CONTACT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const STATUS_DEFAULTS: Record<IntegrationPlatform, IntegrationStatus> = {
  wechat: {
    platform: "wechat",
    enabled: false,
    state: "disabled",
    detail: null,
  },
  qq: { platform: "qq", enabled: false, state: "disabled", detail: null },
  telegram: {
    platform: "telegram",
    enabled: false,
    state: "disabled",
    detail: null,
  },
};

export class IntegrationManager {
  private config: IntegrationsFile = {};
  private readonly adapters = new Map<
    IntegrationPlatform,
    IntegrationAdapter
  >();
  private readonly statuses = new Map<IntegrationPlatform, IntegrationStatus>();
  private readonly chains = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private started = false;

  /** Load config and start every enabled adapter. */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.config = await loadIntegrations();
    this.unsubscribe = onMessageAppended((message) =>
      this.handleAppended(message),
    );
    for (const platform of INTEGRATION_PLATFORMS) {
      const config = configFor(this.config, platform);
      this.statuses.set(platform, {
        ...STATUS_DEFAULTS[platform],
        enabled: config.enabled === true,
        state: config.enabled ? "connecting" : "disabled",
      });
      if (config.enabled) {
        await this.startAdapter(platform);
      }
    }
    this.emitState();
  }

  /** Stop every adapter and release observers/timers. */
  async shutdown(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const platforms = [...this.adapters.keys()];
    await Promise.all(platforms.map((platform) => this.stopAdapter(platform)));
    await saveIntegrations().catch((err) => {
      console.error("[integrations] final save failed:", errorMessage(err));
    });
  }

  /** Renderer snapshot (masked secrets). */
  getState(): IntegrationState {
    return {
      configs: INTEGRATION_PLATFORMS.map((platform) =>
        this.configView(platform),
      ),
      statuses: INTEGRATION_PLATFORMS.map((platform) =>
        this.statusFor(platform),
      ),
      contacts: this.listContacts(),
    };
  }

  /** Apply a validated config patch, persisting and (re)starting as needed. */
  async setConfig(
    platform: IntegrationPlatform,
    patch: IntegrationConfigPatch,
  ): Promise<void> {
    const config = configFor(this.config, platform);
    const beforeEnabled = config.enabled === true;
    applyPatch(platform, config, patch);
    await saveIntegrations();
    const afterEnabled = config.enabled === true;
    if (afterEnabled && !beforeEnabled) {
      await this.startAdapter(platform);
    } else if (!afterEnabled && beforeEnabled) {
      await this.stopAdapter(platform);
    } else if (afterEnabled && requiresRestart(platform, patch)) {
      // Re-start only when a connection-relevant field changed; editing the
      // owner list while connected must not bounce the adapter.
      await this.stopAdapter(platform, false);
      await this.startAdapter(platform);
    }
    this.emitState();
  }

  async setEnabled(
    platform: IntegrationPlatform,
    enabled: boolean,
  ): Promise<void> {
    await this.setConfig(platform, { enabled });
  }

  async login(platform: IntegrationPlatform): Promise<void> {
    if (platform !== "wechat") {
      throw new Error("Interactive login is only supported for WeChat.");
    }
    let adapter = this.adapters.get("wechat") as WechatAdapter | undefined;
    if (!adapter) {
      await this.startAdapter("wechat");
      adapter = this.adapters.get("wechat") as WechatAdapter | undefined;
    }
    if (!adapter?.login) {
      throw new Error("WeChat adapter is unavailable.");
    }
    await adapter.login();
    this.emitState();
  }

  async logout(platform: IntegrationPlatform): Promise<void> {
    const adapter = this.adapters.get(platform);
    if (adapter?.logout) {
      await adapter.logout();
      this.emitState();
    }
  }

  /** Delete a chat's downloaded platform media (called by `chats:delete`). */
  async deleteChatMedia(chatId: number): Promise<void> {
    await deleteMediaForChat(chatId);
  }

  /** Forget every discovered contact for a platform (owner picker reset). */
  async clearContacts(platform: IntegrationPlatform): Promise<void> {
    if (platform === "wechat") return;
    const config = configFor(this.config, platform) as
      QqConfig | TelegramConfig;
    const contacts = config.contacts;
    if (
      typeof contacts !== "object" ||
      contacts === null ||
      Object.keys(contacts).length === 0
    ) {
      return;
    }
    config.contacts = {};
    await saveIntegrations();
    this.emitState();
  }

  private async startAdapter(platform: IntegrationPlatform): Promise<void> {
    if (this.adapters.has(platform)) return;
    const config = configFor(this.config, platform);
    const adapter = createAdapter(platform, config, this.callbacks(platform));
    this.adapters.set(platform, adapter);
    this.setStatus(platform, { state: "connecting", detail: null });
    this.emitState();
    try {
      await adapter.start();
    } catch (err) {
      this.adapters.delete(platform);
      this.setStatus(platform, { state: "error", detail: errorMessage(err) });
      this.emitState();
    }
  }

  private async stopAdapter(
    platform: IntegrationPlatform,
    emit = true,
  ): Promise<void> {
    const adapter = this.adapters.get(platform);
    this.adapters.delete(platform);
    if (adapter) {
      try {
        await adapter.stop();
      } catch (err) {
        console.error(
          `[integrations:${platform}] stop failed:`,
          errorMessage(err),
        );
      }
    }
    this.setStatus(platform, { state: "disabled", detail: null });
    if (emit) this.emitState();
  }

  private callbacks(platform: IntegrationPlatform): AdapterCallbacks {
    return {
      onMessage: (message) => this.enqueueInbound(platform, message),
      onState: (state, detail) =>
        this.setStatus(platform, { state, detail: detail ?? null }),
      onQr: (image, status) => {
        sendToRenderer("integrations:qr", { platform, image, status });
      },
      onConfigDirty: () => this.persist(),
    };
  }

  /** Serialize inbound handling per `(platform, session)` to keep order. */
  private enqueueInbound(
    platform: IntegrationPlatform,
    message: InboundMessage,
  ): void {
    const key = `${platform}:${message.sessionId}`;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.handleInbound(platform, message))
      .catch((err) => {
        console.error(
          `[integrations:${platform}] inbound failed:`,
          errorMessage(err),
        );
      })
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  private async handleInbound(
    platform: IntegrationPlatform,
    message: InboundMessage,
  ): Promise<void> {
    // Record before authz so an unconfigured boss becomes selectable.
    this.recordContact(platform, message);
    if (!this.isOwner(platform, message)) {
      console.warn(
        `[integrations:${platform}] ignored message from unauthorized sender ${message.senderId}`,
      );
      return;
    }
    // Slash commands are owner-only control instructions: consume them instead
    // of storing/delivering them as ordinary messages. A message carrying media
    // is never treated as a command (the media must not be dropped).
    const command =
      message.media.length === 0 ? parseCommand(message.text) : null;
    if (command !== null) {
      handleCommand(platform, message, command);
      return;
    }
    const chatId = this.resolveChat(platform, message);
    if (message.replyContext) {
      dbIntegrations.updateSessionContext(chatId, message.replyContext);
    }
    const attachments = await saveInboundMedia(platform, chatId, message.media);
    const content =
      message.text.trim().length > 0
        ? message.text
        : placeholderText(attachments.length);
    appendMessage(chatId, null, content, {
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    // Mirrors `chat:send`: an immediate silent receipt before the agent turn.
    try {
      appendMessage(chatId, ASSISTANT_ID, "", { kind: "ack", silent: true });
    } catch (err) {
      console.error(
        "[integrations] failed to append receipt ack:",
        errorMessage(err),
      );
    }
    // An inbound human message steers a live run the same way a composer send
    // does; internal wakes use the default serialized queue.
    void deliver(ASSISTANT_ID, chatId, content, { mode: "steer" });
    // Same content-based title generation as a user-created chat.
    maybeGenerateChatTitle(chatId, content);
  }

  private resolveChat(
    platform: IntegrationPlatform,
    message: InboundMessage,
  ): number {
    const existing = dbIntegrations.findChatBySession(
      platform,
      message.sessionId,
    );
    if (existing !== null) return existing;
    // Untitled: the first inbound message drives the same content-based title
    // generation as a user-created chat (the platform chip is the label).
    const chat = dbChats.createChat("", [ASSISTANT_ID], {
      source: platform,
      sourceSession: message.sessionId,
      sourceContext: message.replyContext ?? null,
    });
    return chat.id;
  }

  /** Upsert a discovered account; persist always, emit only on a new id. */
  private recordContact(
    platform: IntegrationPlatform,
    message: InboundMessage,
  ): void {
    if (platform === "wechat") return; // owner is fixed at QR login
    const config = configFor(this.config, platform) as
      QqConfig | TelegramConfig;
    // Reset a malformed (non-object) value from a hand-edited config file.
    if (
      typeof config.contacts !== "object" ||
      config.contacts === null ||
      Array.isArray(config.contacts)
    ) {
      config.contacts = {};
    }
    const contacts = config.contacts;
    const isNew = !(message.senderId in contacts);
    contacts[message.senderId] = {
      name: message.senderName,
      sessionId: message.sessionId,
      kind: message.kind,
      lastSeen: Date.now(),
    };
    pruneContacts(contacts, Date.now());
    this.persist();
    if (isNew) this.emitState();
  }

  /** Discovered contacts across platforms, newest first. */
  private listContacts(): IntegrationContact[] {
    const contacts: IntegrationContact[] = [];
    for (const platform of INTEGRATION_PLATFORMS) {
      if (platform === "wechat") continue;
      const config = configFor(this.config, platform) as
        QqConfig | TelegramConfig;
      for (const [senderId, entry] of Object.entries(config.contacts ?? {})) {
        // Skip malformed entries from a hand-edited config file.
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry as Partial<ContactEntry>;
        contacts.push({
          platform,
          senderId,
          sessionId:
            typeof record.sessionId === "string" ? record.sessionId : "",
          name: typeof record.name === "string" ? record.name : "",
          kind: record.kind === "group" ? "group" : "private",
          lastSeen: typeof record.lastSeen === "number" ? record.lastSeen : 0,
        });
      }
    }
    contacts.sort((a, b) => b.lastSeen - a.lastSeen);
    return contacts;
  }

  private isOwner(
    platform: IntegrationPlatform,
    message: InboundMessage,
  ): boolean {
    const owners = ownerList(this.config, platform);
    if (owners.length === 0) return false;
    return (
      owners.includes(message.senderId) || owners.includes(message.sessionId)
    );
  }

  /** Outbound hook: forward agent/employee messages to the linked platform. */
  private handleAppended(message: Message): void {
    if (message.senderEmployeeId === null) return;
    if (message.kind === "ack") return;
    const source = dbIntegrations.getChatSource(message.chatId);
    if (!source) return;
    // A remote A2A peer's conversation has no IM adapter: its outbound path is
    // the A2A client, driven from `chat:send`, and its inbound messages are
    // stored by the remote-agent manager (so they must not be echoed back).
    // An inbound caller's conversation is the same shape, only reversed: the
    // caller's request arrives over A2A and our replies are streamed back there.
    if (source.platform === "a2a" || source.platform === "a2a-in") return;
    const adapter = this.adapters.get(source.platform);
    if (!adapter) return;
    const text = formatOutbound(message);
    const attachments = message.attachments ?? [];
    if (text.length === 0 && attachments.length === 0) return;
    const session: AdapterSession = {
      sessionId: source.session,
      ...(source.context ? { replyContext: source.context } : {}),
    };
    void this.forward(adapter, source.platform, session, text, attachments);
  }

  /**
   * Forward one app message to the linked platform.
   *
   * The text is sent first and unconditionally, then every attachment is
   * attempted independently. A failed upload must never drop the text (or the
   * remaining attachments); attachments that have no on-disk path or fail to
   * send degrade to a single "attachment delivery failed" note.
   */
  private async forward(
    adapter: IntegrationAdapter,
    platform: IntegrationPlatform,
    session: AdapterSession,
    text: string,
    attachments: NonNullable<Message["attachments"]>,
  ): Promise<void> {
    if (text.length > 0) {
      try {
        await adapter.sendText(session, text);
      } catch (err) {
        // The text failed, but attachments are still attempted below so a
        // single transient failure cannot drop the whole message.
        console.error(
          `[integrations:${platform}] failed to send message text:`,
          errorMessage(err),
        );
        this.setStatus(platform, { state: "error", detail: errorMessage(err) });
      }
    }

    const undelivered: string[] = [];
    for (const attachment of attachments) {
      if (!attachment.path) {
        // Legacy / JS-constructed attachment: no file to upload.
        console.warn(
          `[integrations:${platform}] attachment "${attachment.name}" has no path; degrading to a text note.`,
        );
        undelivered.push(attachment.name);
        continue;
      }
      try {
        await adapter.sendMedia(session, attachment.path);
      } catch (err) {
        console.error(
          `[integrations:${platform}] failed to send attachment "${attachment.name}" (${attachment.path}):`,
          errorMessage(err),
        );
        undelivered.push(attachment.name);
        this.setStatus(platform, { state: "error", detail: errorMessage(err) });
      }
    }

    if (undelivered.length > 0) {
      try {
        // No surrounding brackets: some platforms (WeChat) render a bare
        // `[name]` as a file link that cannot be opened.
        await adapter.sendText(
          session,
          t("Attachment delivery failed: ${names}", {
            names: undelivered.join(", "),
          }),
        );
      } catch (err) {
        console.error(
          `[integrations:${platform}] failed to send attachment note:`,
          errorMessage(err),
        );
        this.setStatus(platform, { state: "error", detail: errorMessage(err) });
      }
    }
  }

  private configView(platform: IntegrationPlatform): IntegrationConfigView {
    const config = configFor(this.config, platform);
    return {
      platform,
      enabled: config.enabled === true,
      fields: buildFields(platform, config),
      owners: ownerList(this.config, platform),
    };
  }

  private statusFor(platform: IntegrationPlatform): IntegrationStatus {
    const config = configFor(this.config, platform);
    const status = this.statuses.get(platform) ?? STATUS_DEFAULTS[platform];
    return { ...status, enabled: config.enabled === true };
  }

  private setStatus(
    platform: IntegrationPlatform,
    patch: Partial<Pick<IntegrationStatus, "state" | "detail">>,
  ): void {
    const current = this.statuses.get(platform) ?? STATUS_DEFAULTS[platform];
    this.statuses.set(platform, { ...current, ...patch });
    this.emitState();
  }

  private emitState(): void {
    sendToRenderer("integrations:state", this.getState());
  }

  private persist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void saveIntegrations().catch((err) => {
        console.error("[integrations] save failed:", errorMessage(err));
      });
    }, PERSIST_DEBOUNCE_MS);
  }
}

/** Whether a config patch requires reconnecting the adapter to take effect. */
/** Drop contacts unseen for 90 days, then keep only the newest N. */
function contactLastSeen(entry: ContactEntry | undefined): number {
  return typeof entry?.lastSeen === "number" ? entry.lastSeen : 0;
}

function pruneContacts(
  contacts: Record<string, ContactEntry>,
  now: number,
): void {
  for (const [id, entry] of Object.entries(contacts)) {
    if (now - contactLastSeen(entry) > CONTACT_RETENTION_MS)
      delete contacts[id];
  }
  const ids = Object.keys(contacts);
  if (ids.length <= MAX_CONTACTS_PER_PLATFORM) return;
  ids
    .sort((a, b) => contactLastSeen(contacts[a]) - contactLastSeen(contacts[b]))
    .slice(0, ids.length - MAX_CONTACTS_PER_PLATFORM)
    .forEach((id) => delete contacts[id]);
}

/** Whether a config patch requires reconnecting the adapter to take effect. */
function requiresRestart(
  platform: IntegrationPlatform,
  patch: IntegrationConfigPatch,
): boolean {
  const keys = Object.keys(patch);
  if (keys.length === 0) return false;
  switch (platform) {
    case "wechat":
      return keys.some((key) => key === "botToken" || key === "accountId");
    case "qq":
      return keys.some((key) => key === "appId" || key === "secret");
    case "telegram":
      return keys.some((key) => key === "botToken");
  }
}

function createAdapter(
  platform: IntegrationPlatform,
  config: PlatformConfig,
  callbacks: AdapterCallbacks,
): IntegrationAdapter {
  switch (platform) {
    case "wechat":
      return new WechatAdapter(config as WechatConfig, callbacks);
    case "qq":
      return new QqAdapter(config as QqConfig, callbacks);
    case "telegram":
      return new TelegramAdapter(config as TelegramConfig, callbacks);
  }
}

function ownerList(
  config: IntegrationsFile,
  platform: IntegrationPlatform,
): string[] {
  if (platform === "wechat") {
    const userId = config.wechat?.userId;
    return typeof userId === "string" && userId.length > 0 ? [userId] : [];
  }
  const raw = platform === "qq" ? config.qq?.owners : config.telegram?.owners;
  const values = Array.isArray(raw) ? raw : [];
  return values.filter(
    (value) => typeof value === "string" && value.length > 0,
  );
}

function placeholderText(attachmentCount: number): string {
  return attachmentCount > 0
    ? t("${count} attachments in total", {
        count: String(attachmentCount),
      })
    : t("(empty message)");
}

/** Validate + coerce a renderer-supplied patch for one platform. */
function applyPatch(
  platform: IntegrationPlatform,
  config: PlatformConfig,
  patch: IntegrationConfigPatch,
): void {
  if (typeof patch.enabled === "boolean") config.enabled = patch.enabled;
  if (platform === "wechat") {
    const wechat = config as WechatConfig;
    if (typeof patch.botToken === "string" && patch.botToken.length > 0) {
      wechat.botToken = patch.botToken;
    }
    if (typeof patch.accountId === "string") wechat.accountId = patch.accountId;
    if (typeof patch.userId === "string") wechat.userId = patch.userId;
    return;
  }
  if (platform === "qq") {
    const qq = config as QqConfig;
    if (typeof patch.appId === "string") qq.appId = patch.appId;
    if (typeof patch.secret === "string" && patch.secret.length > 0) {
      qq.secret = patch.secret;
    }
    if (patch.owners !== undefined) qq.owners = asStringList(patch.owners);
    return;
  }
  const telegram = config as TelegramConfig;
  if (typeof patch.botToken === "string" && patch.botToken.length > 0) {
    telegram.botToken = patch.botToken;
  }
  if (patch.owners !== undefined) telegram.owners = asStringList(patch.owners);
}

function asStringList(value: string | boolean | string[]): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

function maskSecret(value: string | undefined): string | null {
  if (!value || value.length < 4) return null;
  return `…${value.slice(-4)}`;
}

function buildFields(
  platform: IntegrationPlatform,
  config: PlatformConfig,
): IntegrationFieldView[] {
  // WeChat has no user-editable fields: the QR login derives every credential
  // and the owner account automatically.
  if (platform === "wechat") return [];
  if (platform === "qq") {
    const qq = config as QqConfig;
    return [
      { key: "appId", kind: "text", value: qq.appId ?? "" },
      {
        key: "secret",
        kind: "password",
        value: "",
        hasValue: Boolean(qq.secret),
        hint: maskSecret(qq.secret),
      },
    ];
  }
  const telegram = config as TelegramConfig;
  return [
    {
      key: "botToken",
      kind: "password",
      value: "",
      hasValue: Boolean(telegram.botToken),
      hint: maskSecret(telegram.botToken),
    },
  ];
}

/** App-wide singleton used by IPC. */
export const integrationManager = new IntegrationManager();
