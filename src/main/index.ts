import { ASSISTANT_ID } from "@shared/constants/employees";
import { READ_CHAT_PROMPT } from "@shared/constants/prompts";
import { app, dialog } from "electron";
import { materializeBuiltinSkills } from "./agent/builtin-skills";
import { setRemoteMode } from "./app-mode";
import { refreshModelStore } from "./agent/model-runtime";
import { cancelRunRecovery, initRunRecovery } from "./agent/run-recovery";
import {
  disposeAll,
  readSessionActivity,
  wakeAgent,
} from "./agent/session-queue";
import { deleteAvatarFiles } from "./avatars";
import { applyPendingRestore } from "./backup";
import * as cron from "./cron";
import { getAgentRoot } from "./data-dir";
import { initDatabase } from "./db";
import { purgeDisabledEmployees } from "./db/employees";
import { unlinkSessionFile } from "./db/sessions";
import { installDesktopBroadcaster } from "./desktop/broadcast";
import { installLocalSettingsStore } from "./desktop/local-settings";
import { createIpcBinder } from "./desktop/ipc";
import { installDesktopPlatform } from "./desktop/platform";
import { applyStoredHttpProxy } from "./http-proxy";
import {
  registerImbFileHandler,
  registerImbFileScheme,
} from "./imb-file-protocol";
import { initIntegrations, shutdownIntegrations } from "./integrations";
import { registerRemoteHandlers } from "./ipc";
import { registerLocalHandlers } from "./ipc/local";
import { initLocale } from "./locale";
import {
  createMainWindow,
  disposeTray,
  initTray,
  markQuitting,
  showMainWindow,
} from "./main-window";
import { stopAllMiniAppServers, syncMiniAppIndex } from "./mini-apps";
import {
  parseRemoteArgs,
  RemoteArgsError,
  type RemoteOptions,
} from "./remote/args";
import { startRemoteShell } from "./remote/shell";
import { initTheme } from "./theme";
import { initUpdater } from "./updater";
import {
  initWindowShortcut,
  unregisterWindowShortcut,
} from "./window-shortcut";

/**
 * Desktop entry point.
 *
 * Two modes, decided by the command line (`--remote=host:port`):
 * - **local** (default): everything runs in this process, exactly as before —
 *   the database, the agent sessions, cron, IM integrations, Mini Apps.
 * - **remote shell**: the business layer lives in a backend reached over gRPC;
 *   this process keeps the window, tray, shortcut, dialogs and its own updater,
 *   and proxies every channel to the backend (`src/main/remote/shell.ts`).
 *
 * Keeping both modes on the same channel table is what makes the switch a
 * start-up flag rather than a fork of the app.
 */

let remoteOptions: RemoteOptions | null = null;
try {
  remoteOptions = parseRemoteArgs(process.argv);
} catch (error) {
  if (error instanceof RemoteArgsError) {
    // A `--remote` setup that cannot work must not fall back to local mode: the
    // user would be editing a different data folder than they expect.
    dialog.showErrorBox("imboss — remote mode", error.message);
    app.quit();
    throw error;
  }
  throw error;
}

const isRemote = remoteOptions !== null;
setRemoteMode(isRemote);

// Keep the Pi SDK's own agent-dir defaults (MCP OAuth credentials and MCP logs)
// inside the app's isolated data dir instead of the host's `~/.pi/agent`. The
// app passes explicit `agentDir`/paths everywhere else, and the MCP extension's
// server discovery is supplied by the app's own `loadConfig`.
if (!isRemote) {
  process.env.PI_CODING_AGENT_DIR = getAgentRoot();
}

// Must run before the `app` `ready` event (Electron requires it): registers the
// `imb-file:` scheme used by `<img>` to load attachment/avatar files directly.
registerImbFileScheme();

// Single instance
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

// A restore staged from Settings › Backup replaces the whole data folder, so it
// has to be applied before anything reads or creates it — and only in the
// process that actually owns the single-instance lock (and only when this
// process owns the data folder at all).
if (singleInstanceLock && !isRemote) {
  const restored = applyPendingRestore();
  if (restored) {
    console.log(
      `[backup] restored ${restored.restoredFrom}` +
        (restored.keptAt ? ` (previous data kept at ${restored.keptAt})` : ""),
    );
  }
}

/**
 * False until startup has created the window and the services behind it. The
 * OS can emit `activate` / `second-instance` while we are still initialising;
 * revealing the window then would build it before the database (locale, window
 * bounds) exists.
 */
let started = false;

// Single window. A second launch is "bring the app back", not "open another one"
// — the same entry point as the global shortcut and the tray icon, so a hidden
// or minimized window comes back instead of silently staying away.
app.on("second-instance", () => {
  if (!started) return;
  showMainWindow();
});

// No `window-all-closed` handler on purpose: closing the window only hides it
// (see `main-window.ts`), so the app keeps running in the tray. Quitting is
// explicit — tray menu, the app menu / Cmd+Q, or `app.quit()` from an update
// install or a backup restore.

app.on("before-quit", () => {
  // Let the window's `close` handler really close (it hides instead otherwise).
  markQuitting();
  unregisterWindowShortcut();
  disposeTray();
  // Backend services only exist in local mode; the remote shell owns none of
  // them (its backend does, and keeps running).
  if (isRemote) return;
  cancelRunRecovery();
  cron.stopAll();
  stopAllMiniAppServers();
  void disposeAll();
  void shutdownIntegrations();
});

// macOS: clicking the Dock icon (or being reactivated) must bring a hidden
// window back; `showMainWindow()` also re-creates it when there is none.
app.on("activate", () => {
  if (!started) return;
  showMainWindow();
});

app.whenReady().then(() => {
  // Matches `appId` in electron-builder.yml.
  app.setAppUserModelId("com.orcastudio.imboss");

  // Host capabilities and the event sink are needed by both modes: a remote
  // setup still opens its dialogs, clipboard and notifications on this machine.
  installDesktopPlatform();
  installDesktopBroadcaster();
  // Fallback store for shell settings when there is no local database (remote
  // shell); with a database it is never consulted.
  installLocalSettingsStore();

  if (remoteOptions !== null) {
    void startRemoteShell(remoteOptions).then(
      () => {
        started = true;
      },
      (error: unknown) => {
        console.error(
          "[remote] failed to start the remote shell:",
          error instanceof Error ? error.message : error,
        );
      },
    );
    return;
  }

  initDatabase();
  // Apply the persisted outbound proxy before any network work (integrations,
  // model-catalog refresh, provider "Fetch models") so it takes effect from the
  // very first request.
  applyStoredHttpProxy();
  // Localize main-process strings (native dialogs, OS notifications) from the
  // stored/system locale. Must run after the database is available.
  initLocale();
  // Generate the app's built-in Skills (hidden from Settings › Skills) so the
  // assistant's sessions can load them. Best-effort: a failure is logged and
  // never blocks startup.
  materializeBuiltinSkills();
  registerLocalHandlers();
  registerRemoteHandlers(createIpcBinder());
  initTheme();

  // Serve `imb-file:` requests (attachment / avatar images). Must be registered
  // before the first window loads.
  registerImbFileHandler();

  // Start enabled IM integrations (WeChat / QQ / Telegram) in the background.
  void initIntegrations();

  createMainWindow();
  // Tray icon: the second entry point for showing a hidden window, and the only
  // way to quit with the window hidden on Windows / Linux.
  initTray();
  started = true;

  // Keep `index.json` in sync (append new apps, prune stale ids).
  void syncMiniAppIndex();

  cron.initCron();

  // Retry a human turn whose agent run never finished because the app quit,
  // crashed or was killed: one delayed, bounded pass that only wakes the
  // assistant to re-read those chats. It never makes up a missed cron time
  // point (cron wakes leave no `messages` row to recover from) — see
  // `agent/run-recovery.ts`.
  initRunRecovery({
    isStreaming: (chatId) =>
      readSessionActivity(ASSISTANT_ID, chatId).streaming,
    wake: (chatId) =>
      wakeAgent(ASSISTANT_ID, chatId, READ_CHAT_PROMPT, { mode: "queue" }),
  });

  // Register the global show/hide shortcut (after the database, so the stored
  // accelerator is readable). A registration failure is surfaced in
  // Settings › General instead of being fatal.
  initWindowShortcut();

  void purgeDisabledEmployeesOnStartup();

  void refreshModelStore(new AbortController().signal);

  // Always initialize the updater: the automatic startup check is packaged-only
  // (inside `initUpdater`), but the renderer's manual check also works in dev.
  initUpdater();
});

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
