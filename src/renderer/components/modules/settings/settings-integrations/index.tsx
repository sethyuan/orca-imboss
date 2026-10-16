import {
  INTEGRATION_DESC_KEYS,
  INTEGRATION_LABEL_KEYS,
  INTEGRATION_PLATFORMS,
} from "@shared/constants/integrations";
import { t } from "@shared/l10n";
import type {
  IntegrationConfigPatch,
  IntegrationConfigView,
  IntegrationContact,
  IntegrationFieldView,
  IntegrationPlatform,
  IntegrationQrState,
  IntegrationStatus,
} from "@shared/types";
import { useEffect, useId, useState } from "react";
import { cls } from "reactutils";
import { appStore, useApp } from "../../../../app-store";
import { Button } from "../../../button";
import { DetailBody } from "../../../detail-pane/detail-body";
import { DetailHead } from "../../../detail-pane/detail-head";
import { Field } from "../../../field";
import { IconHelp, IconX } from "../../../icons";
import { Input } from "../../../input";
import { Toggle } from "../../../toggle";
import { ConnectGuide } from "./connect-guide";
import "./index.css";

/** Settings → Integrations: connect WeChat / QQ / Telegram accounts. */
export function SettingsIntegrations(): React.JSX.Element {
  const { data } = useApp();
  const state = data.integrations.state;
  const [guide, setGuide] = useState<IntegrationPlatform | null>(null);
  const [qr, setQr] = useState<IntegrationQrState | null>(null);

  useEffect(() => {
    appStore.ensureIntegrations();
  }, []);

  useEffect(() => imb.integrations.onQr((next) => setQr(next)), []);

  const configs = state?.configs ?? [];
  const statuses = state?.statuses ?? [];
  const contacts = (state?.contacts ?? []) as IntegrationContact[];
  const wechatState = statuses.find(
    (item) => item.platform === "wechat",
  )?.state;

  // Drop any stale QR once WeChat reports a live connection.
  useEffect(() => {
    if (wechatState === "connected") setQr(null);
  }, [wechatState]);

  return (
    <>
      <DetailHead
        eyebrow="Integrations"
        title={t("Integrations")}
        sub={t("Connect WeChat, QQ and Telegram")}
      />
      <DetailBody>
        <p className="imb-integrations-intro">
          {t(
            "Link your messaging accounts so the assistant can chat with you from WeChat, QQ or Telegram. Messages from the owner account are treated as yours.",
          )}
        </p>
        {INTEGRATION_PLATFORMS.map((platform) => (
          <IntegrationCard
            key={platform}
            platform={platform}
            config={
              (configs.find((item) => item.platform === platform) ??
                null) as IntegrationConfigView | null
            }
            status={statuses.find((item) => item.platform === platform) ?? null}
            contacts={contacts.filter((item) => item.platform === platform)}
            qr={qr?.platform === "wechat" ? qr : null}
            onGuide={() => setGuide(platform)}
          />
        ))}
      </DetailBody>
      <ConnectGuide platform={guide} onClose={() => setGuide(null)} />
    </>
  );
}

interface IntegrationCardProps {
  platform: IntegrationPlatform;
  config: IntegrationConfigView | null;
  status: IntegrationStatus | null;
  contacts: IntegrationContact[];
  qr: IntegrationQrState | null;
  onGuide: () => void;
}

function IntegrationCard({
  platform,
  config,
  status,
  contacts,
  qr,
  onGuide,
}: IntegrationCardProps): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = config?.fields ?? [];
  const owners = config?.owners ?? [];
  const revision = fields
    .map((field) => `${field.key}:${JSON.stringify(field.value)}`)
    .join("|");

  async function run(task: () => Promise<void>): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  function commit(patch: IntegrationConfigPatch): void {
    void run(() => appStore.setIntegrationConfig(platform, patch));
  }

  return (
    <section className="imb-integration-card">
      <div className="imb-integration-head">
        <div className="imb-integration-title">
          <span className="imb-integration-name">
            {t(INTEGRATION_LABEL_KEYS[platform])}
          </span>
          <StatusBadge status={status} />
        </div>
        <div className="imb-integration-controls">
          <button
            type="button"
            className="imb-integration-help"
            onClick={onGuide}
          >
            <IconHelp className="imb-icon imb-sm" />
            {t("How to connect")}
          </button>
          <Toggle
            checked={config?.enabled ?? false}
            disabled={pending || config === null}
            label={t(INTEGRATION_LABEL_KEYS[platform])}
            onChange={(enabled) =>
              void run(() => appStore.setIntegrationEnabled(platform, enabled))
            }
          />
        </div>
      </div>
      <p className="imb-integration-desc">
        {t(INTEGRATION_DESC_KEYS[platform])}
      </p>
      {status?.detail && (
        <p
          className={cls(
            "imb-integration-detail",
            status.state === "error" && "imb-is-error",
          )}
        >
          {status.detail}
        </p>
      )}
      {error && <p className="imb-integration-detail imb-is-error">{error}</p>}

      {fields.length > 0 && (
        <div className="imb-integration-fields" key={revision}>
          {fields.map((field) => (
            <FieldControl
              key={field.key}
              field={field as IntegrationFieldView}
              disabled={pending}
              onCommit={commit}
            />
          ))}
        </div>
      )}

      {platform === "wechat" && (
        <WeChatActions
          status={status}
          qr={qr}
          pending={pending}
          onLogin={() => void run(() => appStore.loginIntegration("wechat"))}
          onLogout={() => void run(() => appStore.logoutIntegration("wechat"))}
        />
      )}

      {platform !== "wechat" && (
        <OwnerPicker
          owners={owners}
          contacts={contacts}
          disabled={pending}
          onCommit={commit}
          onClear={() =>
            void run(() => appStore.clearIntegrationContacts(platform))
          }
        />
      )}
    </section>
  );
}

function StatusBadge({
  status,
}: {
  status: IntegrationStatus | null;
}): React.JSX.Element {
  const state = status?.state ?? "disabled";
  return (
    <span className={cls("imb-integration-status", `imb-is-${state}`)}>
      {statusLabel(state)}
    </span>
  );
}

function statusLabel(state: IntegrationStatus["state"]): string {
  switch (state) {
    case "connecting":
      return t("Connecting…");
    case "connected":
      return t("Connected");
    case "error":
      return t("Error");
    case "loginRequired":
      return t("Login required");
    default:
      return t("Disabled");
  }
}

/**
 * Owner whitelist picker: discovered accounts can be checked/unchecked instead
 * of typing opaque platform ids.
 */
function OwnerPicker({
  owners,
  contacts,
  disabled,
  onCommit,
  onClear,
}: {
  owners: string[];
  contacts: IntegrationContact[];
  disabled: boolean;
  onCommit: (patch: IntegrationConfigPatch) => void;
  onClear: () => void;
}): React.JSX.Element {
  const ownerSet = new Set(owners);
  const known = new Map(contacts.map((contact) => [contact.senderId, contact]));
  const discovered = contacts.filter(
    (contact) => !ownerSet.has(contact.senderId),
  );

  function toggle(senderId: string, checked: boolean): void {
    const next = checked
      ? [...owners, senderId]
      : owners.filter((id) => id !== senderId);
    onCommit({ owners: next });
  }

  return (
    <div className="imb-owner-picker">
      <div className="imb-owner-picker-head">
        <span className="imb-owner-picker-title">{t("Owner accounts")}</span>
        {contacts.length > 0 && (
          <button
            type="button"
            className="imb-owner-clear"
            disabled={disabled}
            onClick={onClear}
          >
            {t("Clear discovered accounts")}
          </button>
        )}
      </div>

      {owners.length > 0 && (
        <div className="imb-owner-selected">
          {owners.map((id) => (
            <span className="imb-owner-chip" key={id}>
              <span className="imb-owner-chip-name">
                {known.get(id)?.name || id}
              </span>
              <button
                type="button"
                className="imb-owner-chip-remove"
                aria-label={t("Remove")}
                title={t("Remove")}
                disabled={disabled}
                onClick={() => toggle(id, false)}
              >
                <IconX className="imb-icon imb-sm" />
              </button>
            </span>
          ))}
        </div>
      )}

      {contacts.length === 0 ? (
        <p className="imb-owner-empty">
          {t("Send the bot a message from your account, then select it here.")}
        </p>
      ) : discovered.length === 0 ? (
        <p className="imb-owner-empty">
          {t("All discovered accounts are selected.")}
        </p>
      ) : (
        <div className="imb-owner-list">
          {discovered.map((contact) => (
            <label className="imb-owner-row" key={contact.senderId}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={false}
                onChange={(event) =>
                  toggle(contact.senderId, event.target.checked)
                }
              />
              <span className="imb-owner-name">
                {contact.name || contact.senderId}
              </span>
              {contact.kind === "group" && (
                <span className="imb-owner-kind">{t("Group")}</span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Human labels for the generic config field keys. */
const FIELD_LABELS: Record<string, string> = {
  botToken: "Bot token",
  appId: "App ID",
  secret: "App secret",
};

interface FieldControlProps {
  field: IntegrationFieldView;
  disabled: boolean;
  onCommit: (patch: IntegrationConfigPatch) => void;
}

function FieldControl({
  field,
  disabled,
  onCommit,
}: FieldControlProps): React.JSX.Element {
  const label = t(FIELD_LABELS[field.key] ?? field.key);
  const hint = field.hintText ? t(field.hintText) : undefined;
  const uid = useId();
  // Unique per field so the `<label>` is associated with its control (several
  // integrations can render a field with the same key on one page).
  const inputId = `integration-${uid}`;
  // Controlled local draft; the value is only committed on blur/Enter so
  // typing a secret never triggers a per-keystroke save (which would also
  // remount the field and discard the rest of the secret).
  const [draft, setDraft] = useState<string>(() => initialDraft(field));

  if (field.kind === "boolean") {
    return (
      <Field label={label} hint={hint}>
        <Toggle
          checked={field.value === true}
          disabled={disabled}
          label={label}
          onChange={(checked) => onCommit({ [field.key]: checked })}
        />
      </Field>
    );
  }

  function commit(): void {
    if (field.kind === "password") {
      if (draft.trim().length > 0) onCommit({ [field.key]: draft });
      return;
    }
    if (draft === field.value) return;
    onCommit({ [field.key]: draft });
  }

  function handleKeyDown(event: React.KeyboardEvent): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    (event.target as HTMLElement).blur();
  }

  return (
    <Field
      label={label}
      hint={
        field.kind === "password" && field.hasValue
          ? t("Stored: ${hint}", { hint: field.hint ?? "••••" })
          : hint
      }
      htmlFor={inputId}
    >
      <Input
        id={inputId}
        type={field.kind === "password" ? "password" : undefined}
        autoComplete={field.kind === "password" ? "off" : undefined}
        spellCheck={false}
        value={draft}
        disabled={disabled}
        placeholder={
          field.kind === "password" && field.hasValue ? "••••••••" : ""
        }
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
      />
    </Field>
  );
}

function initialDraft(field: IntegrationFieldView): string {
  if (field.kind === "password") return "";
  return typeof field.value === "string" ? field.value : "";
}

interface WeChatActionsProps {
  status: IntegrationStatus | null;
  qr: IntegrationQrState | null;
  pending: boolean;
  onLogin: () => void;
  onLogout: () => void;
}

function WeChatActions({
  status,
  qr,
  pending,
  onLogin,
  onLogout,
}: WeChatActionsProps): React.JSX.Element {
  const connected = status?.state === "connected";
  const showQr = !connected && qr !== null && qr.image.length > 0;
  return (
    <div className="imb-integration-auth">
      {showQr && (
        <div className="imb-integration-qr">
          <img src={qr.image} alt={t("WeChat login QR code")} />
          <span>{t("Scan with WeChat")}</span>
        </div>
      )}
      <div className="imb-integration-auth-actions">
        {connected ? (
          <Button
            variant="secondary"
            size="sm"
            loading={pending}
            onClick={onLogout}
          >
            {t("Log out")}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            loading={pending}
            onClick={onLogin}
          >
            {t("Log in with QR code")}
          </Button>
        )}
      </div>
    </div>
  );
}
