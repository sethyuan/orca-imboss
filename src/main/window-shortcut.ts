import { SettingKeys } from "@shared/constants/settings";
import {
  defaultWindowShortcut,
  normalizeAccelerator,
  validateAccelerator,
  type ShortcutRejectReason,
} from "@shared/shortcut";
import type { WindowShortcutState, WindowShortcutUpdate } from "@shared/types";
import { globalShortcut } from "electron";
import { getShellSetting, setShellSetting } from "./settings-shell";
import { toggleMainWindow } from "./main-window";

/**
 * The global "show / hide main window" shortcut.
 *
 * Ownership mirrors `theme.ts`: the DB `settings` table owns the persisted value
 * (`app.windowShortcut`), this module owns the OS registration. Changing the
 * value goes through the dedicated `window:setShortcut` IPC — a plain
 * `settings:set` would persist a hotkey that is only picked up on the next
 * launch.
 *
 * Value semantics (see `SettingKeys.WindowShortcut`):
 * - row missing          → the platform default applies,
 * - empty string         → the user turned the shortcut off,
 * - anything else        → that accelerator (falling back to the default when
 *                          the stored value is corrupt).
 */

/** Accelerator the app is trying to use (`null` = off). */
let configured: string | null = null;
/** Accelerator the OS currently holds (`null` = not registered). */
let registered: string | null = null;
/** Why the last registration attempt failed. */
let lastError: ShortcutRejectReason | null = null;
/** True while the renderer is recording a new combination. */
let suspended = false;
let initialized = false;

function platformDefault(): string {
  return defaultWindowShortcut(process.platform);
}

/** Resolve the persisted value into an accelerator (`null` = feature off). */
function readConfigured(): string | null {
  const stored = getShellSetting(SettingKeys.WindowShortcut);
  if (stored === null) return platformDefault();
  if (stored.trim() === "") return null;
  // A hand-edited / corrupted row must not leave the feature silently dead.
  return normalizeAccelerator(stored) ?? platformDefault();
}

function register(accelerator: string): boolean {
  try {
    // Returns false (instead of throwing) when another app already owns the
    // combination.
    return globalShortcut.register(accelerator, () => toggleMainWindow());
  } catch (err) {
    console.error(
      `[shortcut] register ${accelerator} failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

function apply(): void {
  if (registered !== null) {
    globalShortcut.unregister(registered);
    registered = null;
  }
  lastError = null;
  if (configured === null || suspended) return;
  if (register(configured)) {
    registered = configured;
    return;
  }
  lastError = "conflict";
  console.warn(`[shortcut] the OS refused ${configured}`);
}

export function getWindowShortcutState(): WindowShortcutState {
  const accelerator = currentAccelerator();
  return {
    accelerator,
    defaultAccelerator: platformDefault(),
    registered: registered !== null,
    error: lastError,
  };
}

/** The accelerator in effect (`null` = turned off), initialised or not. */
function currentAccelerator(): string | null {
  return initialized ? configured : readConfigured();
}

/**
 * Apply the persisted shortcut. Called once at startup, after the database (and
 * therefore `settings`) is available.
 *
 * A failed registration is *not* fatal: the state reports `error: "conflict"`
 * and Settings › General shows it, so the user can pick another combination.
 */
export function initWindowShortcut(): void {
  if (initialized) return;
  initialized = true;
  configured = readConfigured();
  apply();
}

/**
 * Register a user-chosen accelerator (`""` = turn the feature off).
 *
 * Atomic: on failure nothing is persisted and the previous shortcut stays
 * active. Committing also ends a recording session (`suspendWindowShortcut`),
 * so the renderer does not have to unsuspend first.
 */
export function setWindowShortcut(raw: unknown): WindowShortcutUpdate {
  const value = typeof raw === "string" ? raw.trim() : "";

  const current = currentAccelerator();

  if (value === "") {
    suspended = false;
    configured = null;
    apply();
    setShellSetting(SettingKeys.WindowShortcut, "");
    return { accepted: true, rejected: null, state: getWindowShortcutState() };
  }

  const check = validateAccelerator(value, process.platform);
  if (!check.ok) {
    return {
      accepted: false,
      rejected: check.reason,
      state: getWindowShortcutState(),
    };
  }

  suspended = false;
  configured = check.accelerator;
  apply();

  if (registered !== configured) {
    // The OS refused it: roll back to the accelerator that was working before.
    configured = current;
    apply();
    lastError = "conflict";
    return {
      accepted: false,
      rejected: "conflict",
      state: getWindowShortcutState(),
    };
  }

  setShellSetting(SettingKeys.WindowShortcut, configured);
  return { accepted: true, rejected: null, state: getWindowShortcutState() };
}

/**
 * Temporarily drop the OS registration while the renderer records a new
 * combination — otherwise pressing the current shortcut in the recorder would
 * hide the very window the user is working in.
 */
export function suspendWindowShortcut(suspend: boolean): WindowShortcutState {
  if (suspended !== suspend) {
    suspended = suspend;
    apply();
  }
  return getWindowShortcutState();
}

/** Release the OS registration (app is quitting). */
export function unregisterWindowShortcut(): void {
  if (registered !== null) {
    globalShortcut.unregister(registered);
    registered = null;
  }
}
