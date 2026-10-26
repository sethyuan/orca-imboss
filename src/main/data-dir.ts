import { chmodSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

/**
 * Root of the app's dedicated data folder under the user's home directory.
 * Everything the app persists — SQLite database, avatars and Pi SDK
 * environment files (skills, auth, models, sessions) — lives here, isolated
 * from Electron's default userData and from the host system's own Pi agent.
 *
 * `IMBOSS_DATA_ROOT` relocates the whole folder (the headless backend's
 * `--data-root`, or a deployment that keeps data on another volume). It is read
 * on every call — not captured at import time — because the backend resolves its
 * configuration before the first filesystem access.
 */
export function getDataRoot(): string {
  const override = process.env["IMBOSS_DATA_ROOT"]?.trim();
  if (override !== undefined && override.length > 0) return resolve(override);
  return join(homedir(), ".imboss");
}

/** Path of the app's SQLite database file. */
export function getDbPath(): string {
  return join(getDataRoot(), "db", "imboss.db");
}

/** Root of the isolated Pi agent environment (used as the SDK's `agentDir`). */
export function getAgentRoot(): string {
  return join(getDataRoot(), "agent");
}

export function getAgentSkillsDir(): string {
  return join(getAgentRoot(), "skills");
}

/**
 * Directory holding the app's built-in (code-shipped) Skills. Deliberately
 * separate from the user skills dir so they never appear under
 * Settings › Skills;
 * they are loaded into the assistant's session via `additionalSkillPaths`.
 */
export function getBuiltinSkillsDir(): string {
  return join(getAgentRoot(), "builtin-skills");
}

/** Directory where Pi session files will live once runtime wiring lands. */
export function getAgentSessionsDir(): string {
  return join(getAgentRoot(), "sessions");
}

/** Directory where employee avatar files live (`<id>.<ext>`). */
export function getAvatarsDir(): string {
  return join(getDataRoot(), "avatars");
}

/**
 * Directory holding files pasted into the chat composer
 * (`<chatId>/pasted-<timestamp>.<ext>`). Removed per chat when the chat is
 * deleted, mirroring integration media.
 */
export function getAttachmentsDir(): string {
  return join(getDataRoot(), "attachments");
}

/**
 * Root of the user/AI-authored Mini Apps (`<id>/metadata.json`). Scanned by
 * `src/main/mini-apps.ts`; the renderer never touches it directly.
 */
export function getMiniAppsDir(): string {
  return join(getDataRoot(), "mini-apps");
}

/** Path of the Pi provider-credentials file (`auth.json`). Keep 0600. */
export function getAuthPath(): string {
  return join(getAgentRoot(), "auth.json");
}

/** Path of the Pi custom provider/model definitions file (`models.json`). */
export function getModelsPath(): string {
  return join(getAgentRoot(), "models.json");
}

/**
 * Path of the Pi dynamic-catalog cache (`models-store.json`), written by the
 * SDK's `FileModelsStore` next to `models.json`. The app only reads it (the
 * SDK owns writes); see `listAvailableModels`.
 */
export function getModelsStorePath(): string {
  return join(getAgentRoot(), "models-store.json");
}

/** Path of the cmd for agent sessions. */
export function getWorkDir(): string {
  return join(getDataRoot(), "workdir");
}

/** Path of the IM integration credentials/config file (`integrations.json`). */
export function getIntegrationsPath(): string {
  return join(getDataRoot(), "integrations.json");
}

/**
 * Directory holding media downloaded from IM platforms
 * (`<platform>/<chatId>/<file>`). Deleted per-chat when a bridged chat is
 * removed.
 */
export function getIntegrationsMediaDir(): string {
  return join(getDataRoot(), "integrations", "media");
}

/**
 * Create the full data-folder layout if missing and harden permissions.
 *
 * - Directories are created recursively; an existing tree is left untouched.
 * - On POSIX systems the `.imboss` root is chmod'd to owner-only (0700) on a
 *   best-effort basis: failures (e.g. filesystems without permission bits) are
 *   swallowed so first launch never hard-fails, while `mkdir` errors propagate
 *   because a missing data folder is unrecoverable for everything downstream.
 */
export function ensureDataDir(): void {
  const dirs = [
    getDataRoot(),
    join(getDataRoot(), "db"),
    getAvatarsDir(),
    getAttachmentsDir(),
    getAgentRoot(),
    getAgentSkillsDir(),
    getBuiltinSkillsDir(),
    getAgentSessionsDir(),
    getWorkDir(),
    getMiniAppsDir(),
    getIntegrationsMediaDir(),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(getDataRoot(), 0o700);
    } catch {
      // Best-effort hardening only — see doc comment above.
    }
  }
}
