/**
 * Headless-capable application core.
 *
 * Everything the app needs to *run* — database, outbound proxy, translations,
 * built-in skills, IM integrations, the cron scheduler and the model catalog —
 * lives here, so the Electron main process (`src/main/index.ts`) and the
 * headless daemon (`src/daemon/index.ts`) share exactly one startup path.
 *
 * GUI-only concerns (window creation, IPC registration, theme, updater) stay in
 * `src/main/index.ts`. Every import in this module is Electron-free.
 */

import { materializeBuiltinSkills } from "./agent/builtin-skills";
import { refreshModelStore } from "./agent/model-runtime";
import { deleteAvatarFiles } from "./avatars";
import * as cron from "./cron";
import { getAgentRoot } from "./data-dir";
import { initDatabase } from "./db";
import { purgeDisabledEmployees } from "./db/employees";
import { unlinkSessionFile } from "./db/sessions";
import { applyStoredHttpProxy } from "./http-proxy";
import { initIntegrations, shutdownIntegrations } from "./integrations";
import { initLocale } from "./locale";
import { stopAllMiniAppServers, syncMiniAppIndex } from "./mini-apps";

// Keep the Pi SDK's own agent-dir defaults (MCP OAuth credentials and MCP logs)
// inside the app's isolated data dir instead of the host's `~/.pi/agent`. The
// app passes explicit `agentDir`/paths everywhere else, and the MCP extension's
// server discovery is supplied by the app's own `loadConfig`. Set at module
// load so it is in place before any SDK import resolves.
process.env.PI_CODING_AGENT_DIR = getAgentRoot();

export interface StartCoreOptions {
  /** Locale used when the user has not stored one (headless has no Electron). */
  fallbackLocale?: string;
  /** Set false to skip starting the IM integrations. */
  integrations?: boolean;
  /** Set false to skip the model-catalog refresh. */
  refreshModels?: boolean;
}

let started = false;

/** Start everything the core owns. Idempotent. */
export function startCore(options: StartCoreOptions = {}): void {
  if (started) return;
  started = true;

  initDatabase();
  // Apply the persisted outbound proxy before any network work (integrations,
  // model-catalog refresh, provider "Fetch models") so it takes effect from the
  // very first request.
  applyStoredHttpProxy();
  // Localize main-process strings (native dialogs, OS notifications) from the
  // stored/system locale. Must run after the database is available.
  initLocale(options.fallbackLocale);
  // Generate the app's built-in Skills (hidden from the Skills module) so the
  // assistant's sessions can load them. Best-effort: a failure is logged and
  // never blocks startup.
  materializeBuiltinSkills();
  // Start enabled IM integrations (WeChat / QQ / Telegram) in the background.
  if (options.integrations !== false) void initIntegrations();
  // Keep `index.json` in sync (append new apps, prune stale ids).
  void syncMiniAppIndex();
  cron.initCron();
  void purgeDisabledEmployeesOnStartup();
  if (options.refreshModels !== false) {
    void refreshModelStore(new AbortController().signal);
  }
}

/** Stop the core's background work (scheduler, mini-app servers, integrations). */
export async function stopCore(): Promise<void> {
  if (!started) return;
  started = false;
  cron.stopAll();
  stopAllMiniAppServers();
  await shutdownIntegrations();
}

/** Whether `startCore()` has run and `stopCore()` has not. */
export function isCoreStarted(): boolean {
  return started;
}

async function purgeDisabledEmployeesOnStartup(): Promise<void> {
  try {
    const purged = purgeDisabledEmployees();
    for (const entry of purged) {
      // The employee row (and its `cron_jobs` via FK cascade) is already gone;
      // stop the corresponding live Cron handles so they cannot keep firing.
      cron.stopJobsForEmployee(entry.employeeId);
      await Promise.all(entry.sessionPaths.map(unlinkSessionFile));
      deleteAvatarFiles(entry.employeeId);
    }
  } catch (err) {
    console.error(
      "[startup] purge disabled employees failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
