/**
 * IM integration (WeChat / QQ / Telegram) shared types.
 *
 * The renderer only ever sees a masked, descriptor-driven view of each
 * platform's configuration (`IntegrationConfigView`); raw secrets live in the
 * main-process `integrations.json`. Every field is therefore described by a
 * `kind` so the settings UI can render generic inputs.
 */

export type IntegrationPlatform = "wechat" | "qq" | "telegram";

/**
 * Everything a chat can be bridged to.
 *
 * `IntegrationPlatform` is the fixed set of IM platforms the app ships; `a2a`
 * is a user-added remote A2A agent (see `RemoteAgent`). Chats carry this kind;
 * the IM settings UI keeps working with `IntegrationPlatform` alone.
 */
export type ChatSourceKind = IntegrationPlatform | "a2a";

/** Connection lifecycle of one platform adapter. */
export type IntegrationConnectionState =
  "disabled" | "connecting" | "connected" | "error" | "loginRequired";

export type IntegrationFieldKind = "text" | "password" | "boolean";

/** Whether a discovered account was last seen in a 1:1 or a group chat. */
export type IntegrationContactKind = "private" | "group";

/** One configurable field, renderer-safe (secrets are masked). */
export interface IntegrationFieldView {
  key: string;
  kind: IntegrationFieldKind;
  /** Current value for non-secret fields. */
  value: string | boolean | string[];
  /** Secret fields: whether a value is stored. */
  hasValue?: boolean;
  /** Secret fields: masked hint (last chars). */
  hint?: string | null;
  /** Optional helper text key (English source string). */
  hintText?: string;
}

export interface IntegrationConfigView {
  platform: IntegrationPlatform;
  enabled: boolean;
  fields: IntegrationFieldView[];
  /** Owner account ids (the sender whitelist). */
  owners: string[];
}

/** An account that has messaged the bot (rendered by the owner picker). */
export interface IntegrationContact {
  platform: IntegrationPlatform;
  /** Personal account id (the selectable owner id). */
  senderId: string;
  /** Conversation the account was last seen in. */
  sessionId: string;
  /** Display name, when the platform provides one. */
  name: string;
  kind: IntegrationContactKind;
  /** UNIX timestamp in milliseconds of the last inbound message. */
  lastSeen: number;
}

export interface IntegrationStatus {
  platform: IntegrationPlatform;
  enabled: boolean;
  state: IntegrationConnectionState;
  detail: string | null;
}

/** Full renderer-facing snapshot, returned by `integrations:getState`. */
export interface IntegrationState {
  configs: IntegrationConfigView[];
  statuses: IntegrationStatus[];
  /** Discovered accounts, newest first (owner picker). */
  contacts: IntegrationContact[];
}

/** Pushed while a WeChat QR login is pending (`integrations:qr`). */
export interface IntegrationQrState {
  platform: "wechat";
  /** URL / content the renderer embeds to render the QR code. */
  image: string;
  /** `wait` | `scaned` | `confirmed` | `expired`. */
  status: string;
}

/** Patch accepted by `integrations:setConfig` (validated in main). */
export type IntegrationConfigPatch = Record<
  string,
  string | boolean | string[]
>;
