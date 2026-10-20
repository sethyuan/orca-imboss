import { app, BrowserWindow, shell } from "electron";
import { join } from "path";
import icon from "../../resources/icon.png?asset";
import { disposeAll } from "./agent/session-queue";
import { applyPendingRestore } from "./backup";
import { startCore, stopCore } from "./core";
import {
  registerImbFileHandler,
  registerImbFileScheme,
} from "./imb-file-protocol";
import { registerIpcHandlers } from "./ipc";
import { getResolvedLocale } from "./locale";
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
  // The core stops the scheduler, mini-app servers and IM integrations; agent
  // sessions are disposed separately.
  void stopCore();
  void disposeAll();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.whenReady().then(() => {
  // Matches `appId` in electron-builder.yml.
  app.setAppUserModelId("com.orcastudio.imboss");

  // Database, proxy, translations, built-in skills, IM integrations, cron and
  // the model catalog — the same core the headless daemon runs.
  startCore();

  // GUI-only wiring.
  registerIpcHandlers();
  initTheme();

  // Serve `imb-file:` requests (attachment / avatar images). Must be registered
  // before the first window loads.
  registerImbFileHandler();

  createWindow();

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

  // Forward focus regain to the renderer: the chat module clears the selected
  // conversation's unread again on focus, because an `imb_notify` bump while
  // the window was in the background only pushes `chats:unreadChanged` (no
  // `messages:changed`), so the selection never changes and the selectedId
  // effect never runs again.
  mainWindow.on("focus", () => mainWindow.webContents.send("window:focus"));

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
