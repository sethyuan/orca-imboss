import {
  isSubscriptionLoginProvider,
  SUBSCRIPTION_SIGNED_IN_LABELS,
} from "@shared/constants/providers";
import { SettingKeys } from "@shared/constants/settings";
import { t } from "@shared/l10n";
import type { ModelOption, ProviderInfo, ProviderUpsert } from "@shared/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { modelRef } from "../../../../thinking-options";
import { Button } from "../../../button";
import { DetailBody } from "../../../detail-pane/detail-body";
import { DetailHead } from "../../../detail-pane/detail-head";
import { Field } from "../../../field";
import { Modal } from "../../../modal";
import { PasswordField } from "../../../password-field";
import { PasswordInput } from "../../../password-input";
import {
  isHttpUrl,
  ProviderConfigFields,
  providerConfigToForm,
  resolveProviderModels,
  type ProviderConfigFormValue,
} from "../provider-config-fields";
import { SubscriptionLogin } from "../subscription-login";
import "./index.css";

export interface ProviderDetailProps {
  provider: ProviderInfo;
  /** Persist the edited configuration (add-or-update). */
  onSave: (input: ProviderUpsert) => Promise<void>;
  onRemove: () => void;
  /** Subscription sign-in replaced the credential; the parent reloads the list. */
  onSignedIn: () => Promise<void>;
}

/** Transient "Saved" feedback duration. */
const SAVED_FLASH_MS = 1500;

export function ProviderDetail({
  provider,
  onSave,
  onRemove,
  onSignedIn,
}: ProviderDetailProps): React.JSX.Element {
  const [config, setConfig] = useState<ProviderConfigFormValue>(() =>
    providerConfigToForm(provider),
  );
  const [apiKey, setApiKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Models this provider contributes (Pi catalog for built-ins, the stored
  // list for custom ones) plus the app default, so a model can be picked
  // right here instead of only in the global model selects.
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const [all, stored] = await Promise.all([
        imb.models.list(),
        imb.settings.get(SettingKeys.DefaultModel),
      ]);
      setModels(all.filter((model) => model.provider === provider.id));
      setDefaultModel(stored ?? "");
    } catch {
      // A model list is a convenience here; the provider is still usable
      // without it (the global model selects load their own list).
      setModels([]);
    }
  }, [provider.id]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const copy = async (): Promise<void> => {
    try {
      await imb.providers.copyKey(provider.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateConfig = (next: ProviderConfigFormValue): void => {
    setConfig(next);
    setDirty(true);
    setError(null);
  };

  const updateKey = (value: string): void => {
    setApiKey(value);
    setDirty(true);
    setError(null);
  };

  const cancel = (): void => {
    setConfig(providerConfigToForm(provider));
    setApiKey("");
    setDirty(false);
    setSaved(false);
    setError(null);
  };

  const key = apiKey.trim();
  // Built-ins always have a stored key (they are only listed once configured),
  // so replacing one requires a non-empty input; custom edits may omit it.
  const canSave =
    dirty && !saving && (provider.kind === "custom" || key.length > 0);

  const save = async (): Promise<void> => {
    if (!canSave) return;
    let input: ProviderUpsert;
    if (provider.kind === "built-in") {
      input = { id: provider.id, kind: "built-in", apiKey: key };
    } else {
      const baseUrl = config.baseUrl.trim();
      const resolved = resolveProviderModels(config);
      if (!baseUrl) {
        setError(t("Please enter a base URL."));
        return;
      }
      if (!isHttpUrl(baseUrl)) {
        setError(t("Base URL must be a valid http(s) URL."));
        return;
      }
      if (resolved.error !== null) {
        setError(resolved.error);
        return;
      }
      input = {
        id: provider.id,
        kind: "custom",
        baseUrl,
        apiType: config.apiType,
        models: resolved.models,
        ...(key.length > 0 ? { apiKey: key } : {}),
      };
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(input);
      // A new key can add this provider's models to the runtime, so the
      // list is re-read instead of trusted from before the save.
      await loadModels();
      // Reflect what was persisted (trimmed base URL, de-duplicated model ids)
      // without depending on the reloaded provider identity.
      setConfig((prev) => ({
        ...prev,
        baseUrl: input.baseUrl ?? prev.baseUrl,
        // Reflect what was persisted (trimmed ids, normalized input types) and
        // clear the staging textarea — it was merged into the list.
        modelIds: "",
        models: input.models ?? prev.models,
      }));
      setApiKey("");
      setDirty(false);
      setSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaved(false), SAVED_FLASH_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const masked = provider.keyHint ? `••••••••${provider.keyHint}` : "••••••••";

  /** Make one of this provider's models the app-wide default. */
  const useAsDefault = async (model: ModelOption): Promise<void> => {
    try {
      const ref = modelRef(model);
      await imb.settings.set(SettingKeys.DefaultModel, ref);
      setDefaultModel(ref);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <DetailHead
        eyebrow="Provider"
        title={provider.id}
        sub={provider.kind === "custom" ? t("Custom") : t("Built-in")}
        actions={
          <>
            {saved && <span className="imb-provider-saved">{t("Saved")}</span>}
            {dirty && (
              <Button
                variant="secondary"
                size="sm"
                disabled={saving}
                onClick={cancel}
              >
                {t("Cancel")}
              </Button>
            )}
            <Button
              size="sm"
              loading={saving}
              disabled={!canSave}
              onClick={() => void save()}
            >
              {t("Save")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setRemoveOpen(true)}
            >
              {t("Remove")}
            </Button>
          </>
        }
      />
      <DetailBody>
        {provider.kind === "custom" && (
          <>
            <Field label={t("Provider id")}>
              <span className="imb-provider-info imb-mono">{provider.id}</span>
            </Field>
            <ProviderConfigFields
              idPrefix={`provider-${provider.id}`}
              value={config}
              onChange={updateConfig}
              apiKey={apiKey}
              onFetchModels={(query) => imb.providers.listModels(query)}
            />
          </>
        )}
        <SubscriptionLogin providerId={provider.id} onSignedIn={onSignedIn} />
        {provider.kind === "built-in" && (
          <Field
            label={t("Available models")}
            hint={t(
              "Models this provider offers. Pick one to use it as the app default.",
            )}
          >
            {models.length === 0 ? (
              <p className="imb-module-note">
                {t("No models available for this provider yet.")}
              </p>
            ) : (
              <div className="imb-provider-model-list">
                {models.map((model) => {
                  const ref = modelRef(model);
                  const isDefault = defaultModel === ref;
                  return (
                    <Button
                      key={ref}
                      size="sm"
                      variant={isDefault ? "primary" : "secondary"}
                      title={isDefault ? t("Current default model") : ref}
                      onClick={() => void useAsDefault(model)}
                    >
                      {model.name || model.id}
                      {isDefault && ` · ${t("Default")}`}
                    </Button>
                  );
                })}
              </div>
            )}
          </Field>
        )}
        {provider.authType === "oauth" ? (
          <Field label={t("Subscription")}>
            <span className="imb-provider-info">
              {t(
                isSubscriptionLoginProvider(provider.id)
                  ? SUBSCRIPTION_SIGNED_IN_LABELS[provider.id]
                  : "Signed in with a subscription.",
              )}
            </span>
          </Field>
        ) : (
          <Field label={t("API key")}>
            <PasswordField
              value={masked}
              onCopy={copy}
              disabled={!provider.hasKey}
            />
          </Field>
        )}
        <Field
          label={t("New API key")}
          htmlFor={`provider-key-${provider.id}`}
          hint={
            provider.authType === "oauth"
              ? t("Saving an API key replaces the subscription sign-in.")
              : provider.hasKey
                ? t("Leave blank to keep the current key.")
                : undefined
          }
        >
          <PasswordInput
            id={`provider-key-${provider.id}`}
            value={apiKey}
            onChange={updateKey}
            placeholder="sk-…"
          />
        </Field>
        {error !== null && <p className="imb-error-text">{error}</p>}
      </DetailBody>

      <Modal
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        title={t("Remove provider")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRemoveOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setRemoveOpen(false);
                onRemove();
              }}
            >
              {t("Remove")}
            </Button>
          </>
        }
      >
        <p className="imb-provider-remove-note">
          {t("The provider's API key and custom model config will be deleted.")}
        </p>
      </Modal>
    </>
  );
}
