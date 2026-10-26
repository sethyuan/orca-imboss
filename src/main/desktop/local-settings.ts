import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { app } from "electron";
import { dirname, join } from "path";
import { setLocalSettingsStore } from "../settings-shell";

/**
 * The remote shell's settings file (`<userData>/local-settings.json`).
 *
 * A remote setup keeps its data folder on the backend, so the few settings that
 * describe *this machine* — window geometry, the global shortcut, the UI locale —
 * have nowhere else to live. They are intentionally not sent to the backend: two
 * desktops pointing at one backend must be able to remember different window
 * positions, and a shortcut is an OS-level choice.
 *
 * Deliberately tiny and defensive: a corrupt or unreadable file degrades to "no
 * settings" (defaults apply) and is rewritten on the next change, never throwing
 * into the window setup path.
 */

const FILE_NAME = "local-settings.json";

/** Absolute path of the settings file. */
export function localSettingsPath(): string {
  return join(app.getPath("userData"), FILE_NAME);
}

/** Install the JSON store for shells without a database. */
export function installLocalSettingsStore(): void {
  setLocalSettingsStore({
    read: readFile,
    write: writeFile,
  });
}

function readFile(): Record<string, string> {
  const path = localSettingsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch (error) {
    console.warn(
      "[settings] ignoring unreadable local-settings.json:",
      error instanceof Error ? error.message : error,
    );
    return {};
  }
}

function writeFile(next: Record<string, string>): void {
  const path = localSettingsPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    // Atomic replace: a crash mid-write must never leave an unparseable file
    // (which would silently reset the window position and the shortcut).
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    if (process.platform !== "win32") {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Best-effort hardening (mirrors the rest of the app).
      }
    }
  } catch (error) {
    console.warn(
      "[settings] could not persist local-settings.json:",
      error instanceof Error ? error.message : error,
    );
  }
}
