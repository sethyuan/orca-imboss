import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@shared/constants/locales";
import { SettingKeys } from "@shared/constants/settings";
import { t } from "@shared/l10n";
import type {
  ModelOption,
  WindowShortcutState,
  WorkDirState,
} from "@shared/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../../../../app-store";
import { setLocale } from "../../../../locale";
import { DetailBody } from "../../../detail-pane/detail-body";
import { DetailHead } from "../../../detail-pane/detail-head";
import { Field } from "../../../field";
import { IconPlus, IconTrash } from "../../../icons";
import { Input } from "../../../input";
import { Select } from "../../../select";
import { ShortcutInput, shortcutRejectMessage } from "../../../shortcut-input";
import { useFavoriteModels } from "../../../../use-favorite-models";
import {
  groupedModelSelectOptions,
  thinkingLevelsFor,
  thinkingSelectOptions,
} from "../../../../thinking-options";
import "./index.css";

interface EnvVar {
  key: string;
  value: string;
}

const SAVE_DEBOUNCE_MS = 400;

export function SettingsGeneral(): React.JSX.Element {
  const { locale } = useApp();
  const [defaultModel, setDefaultModel] = useState("");
  // App-wide image-generation model, stored as `"<provider>/<modelId>"`
  // (empty = image generation off). Lives here rather than on a provider page
  // because it is one global choice, not a per-provider setting.
  const [imageModel, setImageModel] = useState("");
  const [defaultThinking, setDefaultThinking] = useState("");
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const favorites = useFavoriteModels();
  const [workdir, setWorkdir] = useState<WorkDirState | null>(null);
  const [workdirError, setWorkdirError] = useState<string | null>(null);
  // Global show/hide shortcut: the main process owns the OS registration, so the
  // value is read from (and written through) the dedicated `window:setShortcut`
  // channel rather than the generic settings KV.
  const [windowShortcut, setWindowShortcut] =
    useState<WindowShortcutState | null>(null);
  const [windowShortcutError, setWindowShortcutError] = useState<string | null>(
    null,
  );
  const envTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistEnv = useCallback((next: EnvVar[]): void => {
    if (envTimerRef.current) clearTimeout(envTimerRef.current);
    envTimerRef.current = setTimeout(() => {
      void imb.settings.set(SettingKeys.UserEnv, JSON.stringify(next));
    }, SAVE_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [
        defaultModelStored,
        imageModelStored,
        defaultThinkingStored,
        envStored,
        models,
        workDir,
        windowShortcut,
      ] = await Promise.all([
        imb.settings.get(SettingKeys.DefaultModel),
        imb.settings.get(SettingKeys.ImageModel),
        imb.settings.get(SettingKeys.DefaultThinkingLevel),
        imb.settings.get(SettingKeys.UserEnv),
        imb.models.list(),
        imb.workdir.get(),
        imb.windowControls.getShortcut(),
      ]);
      if (!alive) return;
      setDefaultModel(defaultModelStored ?? "");
      setImageModel(imageModelStored ?? "");
      setDefaultThinking(defaultThinkingStored ?? "");
      setEnvVars(parseEnv(envStored));
      setModels(models);
      setWorkdir(workDir);
      setWindowShortcut(windowShortcut);
    })();
    return () => {
      alive = false;
      if (envTimerRef.current) clearTimeout(envTimerRef.current);
    };
  }, []);

  function changeDefaultModel(value: string): void {
    setDefaultModel(value);
    void imb.settings.set(SettingKeys.DefaultModel, value);
  }

  function changeImageModel(value: string): void {
    setImageModel(value);
    void imb.settings.set(SettingKeys.ImageModel, value);
  }

  function changeDefaultThinking(value: string): void {
    setDefaultThinking(value);
    void imb.settings.set(SettingKeys.DefaultThinkingLevel, value);
  }

  async function chooseWorkdir(): Promise<void> {
    setWorkdirError(null);
    try {
      const next = await imb.workdir.choose();
      if (next) setWorkdir(next);
    } catch (err) {
      setWorkdirError(err instanceof Error ? err.message : String(err));
    }
  }

  const commitWindowShortcut = useCallback(
    async (accelerator: string): Promise<void> => {
      try {
        const update = await imb.windowControls.setShortcut(accelerator);
        setWindowShortcut(update.state);
        // `rejected` is the precise reason for *this* attempt; `state.error`
        // only describes the registration the app ended up with.
        setWindowShortcutError(
          update.rejected ? shortcutRejectMessage(update.rejected) : null,
        );
      } catch (err) {
        setWindowShortcutError(
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [],
  );

  function updateEnv(next: EnvVar[]): void {
    setEnvVars(next);
    persistEnv(next);
  }

  function addEnv(): void {
    const next = [...envVars, { key: "", value: "" }];
    updateEnv(next);
    requestAnimationFrame(() => {
      const rows =
        document.querySelectorAll<HTMLInputElement>(".imb-env-key-input");
      rows[rows.length - 1]?.focus();
    });
  }

  function removeEnv(index: number): void {
    updateEnv(envVars.filter((_, i) => i !== index));
  }

  return (
    <>
      <DetailHead
        eyebrow="General"
        title={t("General")}
        sub={t("App language and basic settings")}
      />
      <DetailBody>
        <Field
          label={t("App language")}
          hint={t(
            "Switch the interface language. Currently only Simplified Chinese and English are supported.",
          )}
        >
          <Select
            value={SUPPORTED_LOCALES.includes(locale) ? locale : DEFAULT_LOCALE}
            options={SUPPORTED_LOCALES.map((l) => ({
              value: l,
              label: l === "zh-CN" ? "简体中文" : "English",
            }))}
            onChange={setLocale}
          />
        </Field>

        <Field
          label={t("Default model")}
          hint={t(
            "Combines models from all providers, used as the default model for new employees / tasks.",
          )}
        >
          <Select
            value={defaultModel}
            options={groupedModelSelectOptions(
              models,
              { value: "", label: t("None") },
              favorites.refs,
            )}
            onToggleStar={favorites.toggle}
            onChange={changeDefaultModel}
          />
        </Field>

        <Field
          label={t("Image generation model")}
          hint={t(
            "The model an agent uses to generate an image in a chat. Leave it unset to turn image generation off.",
          )}
        >
          <Select
            value={imageModel}
            options={groupedModelSelectOptions(
              models,
              { value: "", label: t("None") },
              favorites.refs,
            )}
            onToggleStar={favorites.toggle}
            onChange={changeImageModel}
          />
        </Field>

        <Field
          label={t("Default thinking level")}
          hint={
            defaultModel
              ? t(
                  "Only levels this model accepts are listed. Unset lets each model apply its own default.",
                )
              : t(
                  "The default thinking strength for new employees / tasks. Unset lets each model apply its own default.",
                )
          }
        >
          <Select
            value={defaultThinking}
            options={[
              { value: "", label: t("None") },
              ...thinkingSelectOptions(
                thinkingLevelsFor(models, defaultModel),
                defaultThinking,
              ),
            ]}
            onChange={changeDefaultThinking}
          />
        </Field>

        <Field
          label={t("Working directory")}
          hint={t(
            "The working directory (cwd) for agent sessions — used by shell commands and project context files. Defaults to the app's own workdir.",
          )}
          error={workdirError ?? undefined}
        >
          <div className="imb-settings-workdir-row">
            <Input
              className="imb-workdir-path"
              value={workdir?.effective ?? ""}
              readOnly
              mono
              aria-label={t("Working directory")}
            />
            {workdir?.isDefault && (
              <span className="imb-workdir-badge">{t("Default")}</span>
            )}
            <button
              type="button"
              className="imb-env-add-btn"
              onClick={() => void chooseWorkdir()}
            >
              {t("Browse…")}
            </button>
          </div>
        </Field>

        <Field
          label={t("Show/hide window shortcut")}
          hint={t(
            "A system-wide shortcut that hides the main window while the app keeps running, and brings it back from any state. Turn it off and use the tray icon instead.",
          )}
        >
          <ShortcutInput
            value={windowShortcut?.accelerator ?? null}
            defaultAccelerator={windowShortcut?.defaultAccelerator ?? ""}
            error={
              windowShortcutError ??
              (windowShortcut?.error
                ? shortcutRejectMessage(windowShortcut.error)
                : null)
            }
            onCommit={commitWindowShortcut}
          />
        </Field>

        <div className="imb-settings-env-section">
          <label className="imb-settings-env-title">
            {t("Environment variables")}
          </label>
          <span className="imb-settings-env-help">
            {t(
              "Provides runtime environment variables for MCP servers and agents. One key-value pair per line. Values support $VAR / ${VAR} references (e.g. $PATH) resolved against the app's own environment.",
            )}
          </span>
          <div className="imb-env-list">
            {envVars.length === 0 && (
              <span className="imb-settings-env-empty">
                {t("No environment variables configured")}
              </span>
            )}
            {envVars.map((env, index) => (
              <div className="imb-env-row" key={index}>
                <Input
                  className="imb-env-key-input imb-env-key"
                  value={env.key}
                  placeholder="KEY"
                  aria-label="KEY"
                  onChange={(e) =>
                    updateEnv(
                      envVars.map((item, i) =>
                        i === index ? { ...item, key: e.target.value } : item,
                      ),
                    )
                  }
                />
                <span className="imb-env-sep">=</span>
                <Input
                  className="imb-env-value-input"
                  value={env.value}
                  placeholder="value"
                  aria-label="value"
                  onChange={(e) =>
                    updateEnv(
                      envVars.map((item, i) =>
                        i === index ? { ...item, value: e.target.value } : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="imb-btn-icon"
                  aria-label={t("Remove environment variable")}
                  title={t("Remove environment variable")}
                  onClick={() => removeEnv(index)}
                >
                  <IconTrash className="imb-icon imb-sm" />
                </button>
              </div>
            ))}
          </div>
          <div className="imb-env-add-row">
            <button type="button" className="imb-env-add-btn" onClick={addEnv}>
              <IconPlus className="imb-icon imb-sm" />
              {t("Add environment variable")}
            </button>
          </div>
        </div>
      </DetailBody>
    </>
  );
}

function parseEnv(raw: string | null): EnvVar[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is EnvVar =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as EnvVar).key === "string" &&
          typeof (item as EnvVar).value === "string",
      )
      .map((item) => ({ key: item.key, value: item.value }));
  } catch {
    return [];
  }
}
