import { SettingKeys } from "@shared/constants/settings";
import { screen, type BrowserWindow } from "electron";
import { getShellSetting, setShellSetting } from "./settings-shell";

// Window state persistence: stores the main window's normal (unmaximized) bounds
// so they can be restored on the next launch. Persisted via the DB `settings` KV
// table under the `ui.window` key as a JSON `{x,y,width,height}` string (CSS px).

export const DEFAULT_WINDOW_WIDTH = 950;
export const DEFAULT_WINDOW_HEIGHT = 670;
export const MIN_WINDOW_WIDTH = 900;
export const MIN_WINDOW_HEIGHT = 600;

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Load and validate the persisted window bounds.
 *
 * Returns the bounds to (re)apply, or `null` when there is no usable saved state:
 * missing or corrupt record, size below the configured minimum, or the saved
 * position+size no longer fits inside any currently-connected display's work area
 * (e.g. the monitor was disconnected). The caller then falls back to the defaults
 * and lets Electron center the window on the primary display.
 */
export function loadWindowBounds(): WindowBounds | null {
  // A remote shell stores this in its own JSON (see `settings-shell.ts`): the
  // window position describes *this* machine, never the backend.
  const stored = getShellSetting(SettingKeys.WindowState);
  if (!stored) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const x = record["x"];
  const y = record["y"];
  const width = record["width"];
  const height = record["height"];
  if (
    !isSafeInteger(x) ||
    !isSafeInteger(y) ||
    !isSafeInteger(width) ||
    !isSafeInteger(height)
  ) {
    return null;
  }

  const candidate: WindowBounds = { x, y, width, height };
  if (
    candidate.width < MIN_WINDOW_WIDTH ||
    candidate.height < MIN_WINDOW_HEIGHT
  ) {
    return null;
  }

  // The saved bounds must still fit inside a currently-connected display's work
  // area. This covers both "the display no longer exists" and "position plus size
  // is now out of display range" → the caller falls back to defaults.
  for (const display of screen.getAllDisplays()) {
    if (isContained(display.workArea, candidate)) return candidate;
  }
  return null;
}

/**
 * Overlap (px, in each dimension) with a display's work area that counts as
 * "the user can see this window". A smaller sliver is not grabbable, so it is
 * treated as off-screen.
 */
const MIN_VISIBLE_PX = 48;

/**
 * Make sure the window sits on a connected display.
 *
 * A window whose bounds no longer intersect any display's work area (monitor
 * unplugged, resolution changed) is "shown" while the user sees nothing — the
 * exact failure the show/hide feature must not have. Such a window is re-centred
 * (and clamped) into the primary display's work area.
 *
 * Returns `true` when the window had to be moved.
 */
export function ensureWindowOnScreen(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false;
  // Maximized / full-screen geometry belongs to the OS.
  if (win.isMaximized() || win.isFullScreen()) return false;

  const bounds = win.getBounds();
  const onScreen = screen.getAllDisplays().some(({ workArea }) => {
    const overlapX =
      Math.min(bounds.x + bounds.width, workArea.x + workArea.width) -
      Math.max(bounds.x, workArea.x);
    const overlapY =
      Math.min(bounds.y + bounds.height, workArea.y + workArea.height) -
      Math.max(bounds.y, workArea.y);
    return overlapX >= MIN_VISIBLE_PX && overlapY >= MIN_VISIBLE_PX;
  });
  if (onScreen) return false;

  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  win.setBounds({
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  });
  return true;
}

/** Persist the window's normal (unmaximized) bounds when it closes. */
export function saveWindowBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const { x, y, width, height } = win.getNormalBounds();
  if (width <= 0 || height <= 0) return;
  setShellSetting(
    SettingKeys.WindowState,
    JSON.stringify({ x, y, width, height }),
  );
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isContained(
  workArea: { x: number; y: number; width: number; height: number },
  bounds: WindowBounds,
): boolean {
  return (
    bounds.x >= workArea.x &&
    bounds.y >= workArea.y &&
    bounds.x + bounds.width <= workArea.x + workArea.width &&
    bounds.y + bounds.height <= workArea.y + workArea.height
  );
}
