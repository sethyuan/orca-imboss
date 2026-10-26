import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from "electron";
import { join } from "path";
import icon from "../../resources/icon.png?asset";
import trayColorIcon from "../../resources/tray/tray.png?asset";
import trayTemplateIcon from "../../resources/tray/trayTemplate.png?asset";
import { t } from "@shared/l10n";
import { getRemoteIncompatibility, isRemoteMode } from "./app-mode";
import { getResolvedLocale } from "./locale";
import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  ensureWindowOnScreen,
  loadWindowBounds,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  saveWindowBounds,
} from "./window-state";

/**
 * The main window: its single owner and the single implementation point for
 * "make it visible" / "hide it".
 *
 * Ownership note: this module is the only place that creates or hides the
 * window, and the only place that knows whether the app is quitting. Every
 * "bring the app back" entry point (global shortcut, tray click, second
 * instance, macOS `activate`, OS notification click, update notification) calls
 * `showMainWindow()` — there used to be three half-correct copies of that logic
 * (`index.ts` `second-instance`/`activate`, `notifications.focusMainWindow`),
 * and hidden windows fell through all of them.
 *
 * Closing the window now *hides* it (the boss's decision): the app keeps running
 * in the background so its agents/cron/IM integrations stay alive, and the tray
 * icon / global shortcut bring it back. Quitting therefore has to be explicit —
 * `markQuitting()` is set from `before-quit` (and from `quitApp()`) so the
 * `close` handler lets the window really close while the app is going down.
 */

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

/**
 * Native (sheet) dialogs currently attached to the window. Hiding a window that
 * owns an open sheet leaves a floating, ownerless dialog, so `hideMainWindow()`
 * refuses while one is open.
 */
let openNativeDialogs = 0;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function isQuitting(): boolean {
  return quitting;
}

/** Let the `close` handler close the window for real (app is going down). */
export function markQuitting(): void {
  quitting = true;
}

/** Track a native dialog so the window is not hidden out from under it. */
export function beginNativeDialog(): void {
  openNativeDialogs += 1;
}

export function endNativeDialog(): void {
  openNativeDialogs = Math.max(0, openNativeDialogs - 1);
}

/** Create the (single) main window. Returns the live window. */
export function createMainWindow(): BrowserWindow {
  const locale = getResolvedLocale();
  const savedBounds = loadWindowBounds();

  const win = new BrowserWindow({
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
    // macOS chrome glass (design route A).
    //
    // The native `NSVisualEffectView` sits *behind* the web contents; the
    // renderer paints only the chrome band translucent over it
    // (`--imb-material-chrome`) and keeps every content surface opaque, so the
    // material can never bleed into text. `followWindow` lets the system
    // brighten/desaturate the material with the window's key state.
    //
    // `under-window` (not `sidebar`): the app owns a full-window layout rather
    // than an AppKit source list, and the whole-window background material is
    // the more translucent of the two — the boss read `sidebar` as too solid on
    // a real window. The CSS layer above it is 60% window colour, so ~40% of the
    // material shows through; see `--imb-material-chrome` in tokens.css for the
    // tuning band (55–65%).
    //
    // Deliberately NOT `transparent: true`: that path needs a private corner
    // mask to keep the window corners smooth and previously spiked
    // WindowServer GPU load. The alpha background below is only "let the
    // material through", not a see-through window.
    ...(process.platform === "darwin"
      ? {
          vibrancy: "under-window" as const,
          visualEffectState: "followWindow" as const,
          backgroundColor: "#00000000",
          roundedCorners: true,
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      spellcheck: false,
      // `--remote-mode` is what the preload turns into `imb.remote.enabled`: the
      // renderer decides between "a path the agent can read" and "upload the
      // bytes" from it.
      additionalArguments: [
        `--locale=${locale}`,
        ...(isRemoteMode() ? ["--remote-mode=1"] : []),
        ...(getRemoteIncompatibility() !== null
          ? [
              `--remote-incompatible=${getRemoteIncompatibility()?.shell}:${getRemoteIncompatibility()?.backend}`,
            ]
          : []),
      ],
    },
  });

  mainWindow = win;

  win.on("ready-to-show", () => {
    if (win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
  });

  // Forward maximize state to the renderer (drives the custom window buttons).
  win.on("maximize", () => win.webContents.send("window:maximized", true));
  win.on("unmaximize", () => win.webContents.send("window:maximized", false));

  // Forward focus regain to the renderer: the chat module clears the selected
  // conversation's unread again on focus, because an `imb_notify` bump while
  // the window was in the background only pushes `chats:unreadChanged` (no
  // `messages:changed`), so the selection never changes and the selectedId
  // effect never runs again.
  win.on("focus", () => win.webContents.send("window:focus"));

  // Close = hide (the app keeps running in the tray); a real close only happens
  // while the app is quitting.
  win.on("close", (event) => {
    if (win.isDestroyed()) return;
    saveWindowBounds(win);
    if (quitting) return;
    event.preventDefault();
    hideMainWindow();
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    updateTrayMenu();
  });

  // Open external links in the OS browser; never allow in-app popups. Only
  // known-safe schemes are forwarded.
  win.webContents.setWindowOpenHandler((details) => {
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
  win.webContents.on("will-navigate", (event, url) => {
    if (isAppOwnUrl(win, url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  updateTrayMenu();
  return win;
}

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

function isWindowShown(win: BrowserWindow | null): boolean {
  return (
    win !== null && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
  );
}

/**
 * Bring the main window in front of the user — whatever state it is in
 * (destroyed, hidden, minimized, behind another window, on another Space).
 *
 * Each step covers a specific way "show" silently fails:
 */
export function showMainWindow(): void {
  const win = getMainWindow() ?? createMainWindow();
  if (win.isDestroyed()) return;

  // macOS: a hidden *application* (Cmd+H, or our own hide) keeps all of its
  // windows hidden even after `win.show()`, so unhide the app first.
  if (process.platform === "darwin" && app.isHidden()) app.show();

  // `show()` does not reliably restore a minimized window on every platform.
  if (win.isMinimized()) win.restore();

  // Defensive: a window left on a display that no longer exists would be
  // "shown" where nobody can see it.
  ensureWindowOnScreen(win);

  if (process.platform === "win32") {
    // Windows only grants the foreground to a background process when the
    // window was just made topmost; flip the flag around the show.
    win.setAlwaysOnTop(true);
    win.show();
    win.moveTop();
    win.focus();
    win.setAlwaysOnTop(false);
  } else {
    win.show();
    win.moveTop();
    win.focus();
  }

  if (process.platform === "darwin") {
    // Activation is what actually pulls the window across Spaces (including
    // over another app's full-screen Space); `focus()` alone only raises it
    // inside the Space that is already in front.
    app.focus({ steal: true });
  }

  // `show()` focuses the window, not its web contents: on Windows the keyboard
  // focus can stay on the frame, which reads as "the window is there but I
  // cannot type". Focus the page explicitly.
  win.webContents.focus();

  updateTrayMenu();
}

/**
 * Hide (not minimize) the main window. Returns `false` when hiding is not safe
 * right now (a native sheet is open, or there is no window).
 */
export function hideMainWindow(): boolean {
  const win = getMainWindow();
  if (!win) return false;
  if (openNativeDialogs > 0) return false;

  // A macOS full-screen window lives in its own Space: hiding it directly
  // leaves an empty black Space behind, so leave full screen first.
  if (win.isFullScreen()) {
    leaveFullScreenThenHide(win);
    return true;
  }

  hideNow(win);
  return true;
}

function hideNow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.hide();
  // macOS: hiding only the window leaves the application active with an empty
  // menu bar (and no Dock click to come back through). Hide the *application*
  // instead — `activate` then restores it, exactly like Cmd+H.
  if (process.platform === "darwin") app.hide();
  updateTrayMenu();
}

function leaveFullScreenThenHide(win: BrowserWindow): void {
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    win.removeListener("leave-full-screen", finish);
    hideNow(win);
  };

  // `setFullScreen(false)` is asynchronous and, on a window that is already
  // leaving full screen, may never emit the event again — hence the timeout.
  win.once("leave-full-screen", finish);
  timer = setTimeout(finish, 700);
  win.setFullScreen(false);
}

/**
 * The global shortcut / tray click semantics: "summon".
 *
 * Only a window the user can actually see *and* is using gets hidden; anything
 * else (hidden, minimized, behind another window, on another Space) is brought
 * to the front. A plain toggle would make "press the hotkey while the window is
 * covered" hide it — the worst possible answer to "bring the app back".
 */
export function toggleMainWindow(): void {
  const win = getMainWindow();
  if (
    win &&
    isWindowShown(win) &&
    win.isFocused() &&
    (process.platform !== "darwin" || !app.isHidden())
  ) {
    hideMainWindow();
    return;
  }
  showMainWindow();
}

/** Quit for real (tray menu / the app menu): bypasses "close = hide". */
export function quitApp(): void {
  markQuitting();
  app.quit();
}

/**
 * Menu-bar / system-tray entry point.
 *
 * Interaction (the boss's choice): left click toggles the window, right click
 * opens a menu with show/hide + quit. Linux app indicators only support a
 * context menu (the desktop shows it on click, and no click events are
 * delivered), so there the menu is installed instead of handled.
 */
export function initTray(): void {
  if (tray) return;
  try {
    const image =
      process.platform === "darwin"
        ? nativeImage.createFromPath(trayTemplateIcon)
        : nativeImage.createFromPath(trayColorIcon);
    if (image.isEmpty()) {
      console.error("[tray] icon could not be loaded");
      return;
    }
    if (process.platform === "darwin") image.setTemplateImage(true);
    tray = new Tray(image);
  } catch (err) {
    // A tray can be unavailable (headless session, missing appindicator): the
    // app must still start, with the global shortcut as the only entry point.
    console.error(
      "[tray] failed to create the tray icon:",
      err instanceof Error ? err.message : err,
    );
    tray = null;
    return;
  }

  tray.setToolTip("imboss");

  if (process.platform === "darwin") {
    // Never `setContextMenu` on macOS: it would make *every* click open the menu
    // instead of toggling. The menu is popped up on right click only.
    tray.on("click", handleTrayClick);
    tray.on("right-click", () => tray?.popUpContextMenu(buildTrayMenu()));
  } else if (process.platform === "win32") {
    tray.on("click", handleTrayClick);
    tray.setContextMenu(buildTrayMenu());
  } else {
    // Linux app indicators own the menu and deliver no click events.
    tray.setContextMenu(buildTrayMenu());
  }

  updateTrayMenu();
}

let lastTrayClickAt = 0;

/**
 * Left click on the tray icon toggles the window. A double click arrives as two
 * `click` events, which would show and immediately hide again — collapse the
 * second one of a burst.
 */
function handleTrayClick(): void {
  const now = Date.now();
  if (now - lastTrayClickAt < 300) return;
  lastTrayClickAt = now;
  toggleMainWindow();
}

export function disposeTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

function buildTrayMenu(): Menu {
  const shown = isWindowShown(getMainWindow());
  return Menu.buildFromTemplate([
    {
      label: shown ? t("Hide Window") : t("Show Window"),
      // Explicit seam: the label describes the action, and clicking it must do
      // exactly that — not "toggle twice" on platforms that also fire `click`.
      click: () => {
        if (isWindowShown(getMainWindow())) hideMainWindow();
        else showMainWindow();
      },
    },
    { type: "separator" },
    { label: t("Quit imboss"), click: () => quitApp() },
  ]);
}

function updateTrayMenu(): void {
  if (!tray || process.platform === "darwin") return;
  // Windows / Linux render the installed menu; it has to be rebuilt whenever the
  // window state (which decides show-vs-hide) changes.
  tray.setContextMenu(buildTrayMenu());
}
