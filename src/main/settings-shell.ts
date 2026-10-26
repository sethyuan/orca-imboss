import { isDatabaseReady } from "./db";
import { getSetting, setSetting } from "./db/settings";

/**
 * Settings the **desktop shell** needs, wherever they can be stored.
 *
 * Local mode owns the data folder, so `ui.window`, `app.windowShortcut` and
 * `app.locale` live in the SQLite settings table like every other setting.
 * A remote shell has no local database (the data folder belongs to the backend)
 * and must not write window geometry into the *backend's* database either — that
 * is a property of this machine, not of the account.
 *
 * So the same call sites go through here, and only the storage swaps:
 * database when there is one, a small JSON file otherwise (installed by the
 * desktop bootstrap, see `desktop/local-settings.ts`).
 */

export interface LocalSettingsStore {
  read(): Record<string, string>;
  write(next: Record<string, string>): void;
}

let store: LocalSettingsStore | null = null;

/** Install the JSON fallback (desktop bootstrap; unused while a DB exists). */
export function setLocalSettingsStore(next: LocalSettingsStore | null): void {
  store = next;
}

/** Read one shell setting (`null` = not set). */
export function getShellSetting(key: string): string | null {
  if (isDatabaseReady()) return getSetting(key);
  if (store === null) return null;
  const all = store.read();
  return Object.hasOwn(all, key) ? all[key] : null;
}

/** Persist one shell setting. */
export function setShellSetting(key: string, value: string): void {
  if (isDatabaseReady()) {
    setSetting(key, value);
    return;
  }
  if (store === null) {
    // Nothing to persist into: better a silent no-op than crashing the window
    // (this only happens in a half-initialized process).
    console.warn(`[settings] no store for ${key}; value not saved`);
    return;
  }
  const all = store.read();
  all[key] = value;
  store.write(all);
}
