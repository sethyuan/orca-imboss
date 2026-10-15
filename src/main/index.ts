import { app, BrowserWindow, shell } from "electron";
import { join } from "path";
import icon from "../../resources/icon.png?asset";
import { materializeBuiltinSkills } from "./agent/builtin-skills";
import { refreshModelStore } from "./agent/model-runtime";
import { disposeAll } from "./agent/session-queue";
import { deleteAvatarFiles } from "./avatars";
import { applyPendingRestore } from "./backup";
import * as cron from "./cron";
import { getAgentRoot } from "./data-dir";
import { initDatabase } from "./db";
import { purgeDisabledEmployees } from "./db/employees";
import { unlinkSessionFile } from "./db/sessions";
import { applyStoredHttpProxy } from "./http-proxy";
import {
  registerImbFileHandler,
  registerImbFileScheme,
} from "./imb-file-protocol";
import { initIntegrations, shutdownIntegrations } from "./integrations";
import { registerIpcHandlers } from "./ipc";
import { getResolvedLocale, initLocale } from "./locale";
import { stopAllMiniAppServers, syncMiniAppIndex } from "./mini-apps";
import { setMainWindow } from "./notifications";
import { initTheme } from "./theme";
import { initUpdater } from "./updater";
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  loadWindowBounds,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  saveWindowBounds,
} from "./window-state";

// Keep the Pi SDK's own agent-dir defaults (MCP OAuth credentials and MCP logs)
// inside the app's isolated data dir instead of the host's `~/.pi/agent`. The
// app passes explicit `agentDir`/paths everywhere else, and the MCP extension's
// server discovery is supplied by the app's own `loadConfig`.
process.env.PI_CODING_AGENT_DIR = getAgentRoot();

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
// process that actually owns the single-instance lock.
if (singleInstanceLock) {
  const restored = applyPendingRestore();
  if (restored) {
    console.log(
      `[backup] restored ${restored.restoredFrom}` +
        (restored.keptAt ? ` (previous data kept at ${restored.keptAt})` : ""),
    );
  }
}

// Single window
app.on("second-instance", () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// Closing the last window quits the app on every platform, including macOS:
// the app has no reason to keep running in the background, so the red close
// button (and the custom title-bar close) fully exits instead of leaving a
// dock-persistent process.
app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  cron.stopAll();
  stopAllMiniAppServers();
  void disposeAll();
  void shutdownIntegrations();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.whenReady().then(() => {
  // Matches `appId` in electron-builder.yml.
  app.setAppUserModelId("com.orcastudio.imboss");

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
  registerIpcHandlers();
  initTheme();

  // Serve `imb-file:` requests (attachment / avatar images). Must be registered
  // before the first window loads.
  registerImbFileHandler();

  // Start enabled IM integrations (WeChat / QQ / Telegram) in the background.
  void initIntegrations();

  createWindow();

  // Keep `index.json` in sync (append new apps, prune stale ids).
  void syncMiniAppIndex();

  cron.initCron();

  void purgeDisabledEmployeesOnStartup();

  void refreshModelStore(new AbortController().signal);

  // Always initialize the updater: the automatic startup check is packaged-only
  // (inside `initUpdater`), but the renderer's manual check also works in dev.
  initUpdater();
});

/**
 * Only these schemes are ever handed to the OS. Chat content is model- and
 * user-authored, so an arbitrary `shell.openExternal` target (custom protocol,
 * `file:`, …) must never be reachable from a link.
 */
function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const { protocol } = new URL(rawUrl);
    return (
      protocol === "http:" || protocol === "https:" || protocol === "mailto:"
    );
  } catch {
    return false;
  }
}

/**
 * True when `rawUrl` belongs to the app itself: the current window URL (a
 * reload) or the Vite dev-server origin (a full HMR reload in development).
 */
function isAppOwnUrl(win: BrowserWindow, rawUrl: string): boolean {
  if (win.isDestroyed() || rawUrl === win.webContents.getURL()) return true;
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  return devUrl !== undefined && rawUrl.startsWith(devUrl);
}

function createWindow(): void {
  const locale = getResolvedLocale();
  const savedBounds = loadWindowBounds();

  const mainWindow = new BrowserWindow({
    ...(savedBounds ?? {
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
    }),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      spellcheck: false,
      additionalArguments: [`--locale=${locale}`],
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  // Forward maximize state to the renderer (drives the custom window buttons).
  mainWindow.on("maximize", () =>
    mainWindow.webContents.send("window:maximized", true),
  );
  mainWindow.on("unmaximize", () =>
    mainWindow.webContents.send("window:maximized", false),
  );

  mainWindow.on("close", () => saveWindowBounds(mainWindow));

  // Register the window for OS notification click-to-focus + jump-to-chat.
  setMainWindow(mainWindow);
  mainWindow.on("closed", () => setMainWindow(null));

  // Open external links in the OS browser; never allow in-app popups. Only
  // known-safe schemes are forwarded.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url);
    }
    return { action: "deny" };
  });

  // Defense-in-depth: a Markdown link without `target="_blank"` would otherwise
  // navigate the app window away from the UI (and a `file:` target could load
  // local HTML with the preload bridge attached). Allow only the app's own
  // URL / dev-server origin (reloads, HMR) and forward safe external URLs to
  // the OS; everything else is dropped.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAppOwnUrl(mainWindow, url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
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
