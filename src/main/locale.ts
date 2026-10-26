import { DEFAULT_LOCALE } from "@shared/constants/locales";
import { SettingKeys } from "@shared/constants/settings";
import { setupL10N } from "@shared/l10n";
import zhCN from "@shared/translations/zhCN.json";
import { getAppInfo } from "./platform";
import { getShellSetting } from "./settings-shell";

const TRANSLATIONS = { "zh-CN": zhCN };

/**
 * Resolved UI locale.
 *
 * Priority: the stored setting (the user's explicit choice, which is data and
 * therefore lives with the database) → the host's own locale → the app default.
 * The database check matters for the remote desktop shell, which never opens the
 * data folder (it belongs to the backend) and must still start localized.
 */
export function getResolvedLocale(): string {
  const stored = getShellSetting(SettingKeys.Locale);
  if (stored) return stored;
  return getAppInfo().getLocale() ?? DEFAULT_LOCALE;
}

/**
 * Initialize main-process translations from the resolved locale. Call once
 * after the database is ready and before any native dialog or OS notification
 * is shown. The renderer owns live locale switches; main strings (native
 * dialogs, update notifications) are resolved at startup.
 */
export function initLocale(): void {
  setupL10N(getResolvedLocale(), TRANSLATIONS);
}
