import { SettingKeys } from "@shared/constants/settings";
import type { ThemeMode, ThemeState } from "@shared/types";
import { getSetting, setSetting } from "./db/settings";
import { getThemeApplier } from "./platform";

/**
 * Theme ownership (confirmed decision): the DB `settings` table owns the
 * persisted values (`theme.mode`, `theme.color`); the *host* applies the mode so
 * Chromium's `prefers-color-scheme` follows it (desktop: `nativeTheme`), and the
 * renderer injects the accent color as CSS variables (see renderer theme.ts).
 *
 * The value is read from the settings table rather than from the host, so the
 * backend that owns the database is the single source of truth and a remote
 * desktop shell can still report the stored mode.
 */

const VALID_MODES: ThemeMode[] = ["light", "dark", "system"];
const DEFAULT_COLOR = "#07C160";
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function sanitizeMode(value: string | null | undefined): ThemeMode {
  return value && (VALID_MODES as string[]).includes(value)
    ? (value as ThemeMode)
    : "system";
}

/** Effective mode (`system` = follow the OS). */
export function getThemeMode(): ThemeMode {
  return sanitizeMode(getSetting(SettingKeys.ThemeMode));
}

export function getThemeColor(): string {
  const stored = getSetting(SettingKeys.ThemeColor);
  return stored && COLOR_RE.test(stored) ? stored.toUpperCase() : DEFAULT_COLOR;
}

export function setThemeMode(mode: ThemeMode): void {
  const safe = sanitizeMode(mode);
  setSetting(SettingKeys.ThemeMode, safe);
  getThemeApplier().applyMode(safe);
}

export function setThemeColor(color: string): void {
  if (typeof color !== "string" || !COLOR_RE.test(color)) {
    throw new Error("Invalid theme color.");
  }
  setSetting(SettingKeys.ThemeColor, color.toUpperCase());
}

export function getThemeState(): ThemeState {
  return { mode: getThemeMode(), color: getThemeColor() };
}

/** Apply the persisted mode at startup (called after DB init). */
export function initTheme(): void {
  getThemeApplier().applyMode(getThemeMode());
}
