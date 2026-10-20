import { DEFAULT_LOCALE } from "@shared/constants/locales";
import { SettingKeys } from "@shared/constants/settings";
import { setupL10N } from "@shared/l10n";
import zhCN from "@shared/translations/zhCN.json";
import { app } from "electron";
import { getSetting } from "./db/settings";

const TRANSLATIONS = { "zh-CN": zhCN };

/**
 * Electron's locale, or null in a headless process. Outside Electron
 * `require("electron")` yields the binary path string, so `app` is `undefined`.
 */
function electronLocale(): string | null {
  try {
    const locale = app?.getLocale?.();
    return typeof locale === "string" && locale.length > 0 ? locale : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the active locale: the stored setting wins; otherwise Electron's
 * system locale, and finally `fallback` (used by the headless daemon, which has
 * no Electron to ask).
 */
export function getResolvedLocale(fallback?: string): string {
  const stored = getSetting(SettingKeys.Locale);
  if (stored) {
    return stored;
  }
  return electronLocale() ?? fallback ?? DEFAULT_LOCALE;
}

/**
 * Initialize main-process translations from the resolved locale. Call once
 * after the database is ready and before any native dialog or OS notification
 * is shown. The renderer owns live locale switches; main strings (native
 * dialogs, update notifications) are resolved at startup.
 */
export function initLocale(fallback?: string): void {
  setupL10N(getResolvedLocale(fallback), TRANSLATIONS);
}
