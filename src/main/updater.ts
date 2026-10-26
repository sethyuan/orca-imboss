import { SettingKeys } from "@shared/constants/settings";
import { t } from "@shared/l10n";
import type { UpdaterState } from "@shared/types";
import { app, Notification } from "electron";
import electronUpdater from "electron-updater";
import { basename } from "path";
import { isDatabaseReady } from "./db";
import { getSetting, setSetting } from "./db/settings";
import { markQuitting, showMainWindow } from "./main-window";
import { sendToRenderer } from "./notifications";

// electron-updater is a CommonJS module; use the default-import interop to
// reliably obtain the singleton `autoUpdater` and `CancellationToken`.
const { autoUpdater, CancellationToken } = electronUpdater;

const IDLE_STATE: UpdaterState = {
  status: "idle",
  version: null,
  progress: null,
  error: null,
  checkedAt: null,
};

let state: UpdaterState = { ...IDLE_STATE };
let initialized = false;
/** In-flight check, shared so concurrent callers await the same result. */
let activeCheck: Promise<UpdaterState> | null = null;
/** True while `downloadUpdate` is in flight (guards concurrent downloads). */
let downloading = false;
/** Token for the in-flight download, used by `cancelUpdateDownload`. */
let activeDownloadToken: {
  readonly cancelled: boolean;
  cancel(): void;
} | null = null;
/** When true, the next `update-available` also raises an OS notification. */
let notifyNextResult = false;

/** Current updater state (also pushed to the renderer on every transition). */
export function getUpdaterState(): UpdaterState {
  return state;
}

/**
 * True when `error` is the ENOENT raised while electron-updater reads its
 * update config (`<resources>/app-update.yml` in packaged builds,
 * `dev-app-update.yml` during development). A build without that file cannot
 * self-update at all, so the raw filesystem error must never reach the UI.
 */
function isMissingUpdateConfigError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, path } = error as { code?: unknown; path?: unknown };
  if (code !== "ENOENT" || typeof path !== "string") return false;
  const file = basename(path);
  return file === "app-update.yml" || file === "dev-app-update.yml";
}

/** Normalize any updater failure into a user-facing, localized message. */
function describeUpdaterError(error: unknown): string {
  if (isMissingUpdateConfigError(error)) {
    return t("Automatic updates are unavailable in this build.");
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wire automatic updates against the GitHub provider configured in
 * `electron-builder.yml`. Always runs so the renderer's manual "check for
 * updates" works in dev too (via `dev-app-update.yml`); only the automatic
 * startup check is limited to the packaged app.
 */
export function initUpdater(): void {
  if (initialized) return;
  initialized = true;

  autoUpdater.autoDownload = false;
  // The user decides when to install: downloading alone must never install on
  // quit, otherwise declining the restart prompt would be meaningless.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = console;
  // Dev builds have no generated `app-update.yml`; use the repo's
  // `dev-app-update.yml` so the manual check can be exercised during
  // development. Never set `autoUpdater.channel` — the generated config carries
  // the correct per-architecture macOS channel (`latest-${arch}`).
  autoUpdater.forceDevUpdateConfig = !app.isPackaged;

  autoUpdater.on("checking-for-update", () => {
    setState({ status: "checking", error: null });
  });
  autoUpdater.on("update-available", (info) => {
    const notify = notifyNextResult;
    notifyNextResult = false;
    setState({
      status: "available",
      version: info.version,
      progress: null,
      error: null,
      checkedAt: Date.now(),
    });
    if (notify) notifyUpdateAvailable(info.version);
  });
  autoUpdater.on("update-not-available", () => {
    notifyNextResult = false;
    setState({
      status: "not-available",
      version: null,
      progress: null,
      error: null,
      checkedAt: Date.now(),
    });
  });
  autoUpdater.on("download-progress", (info) => {
    setState({
      status: "downloading",
      progress: {
        percent: info.percent,
        transferred: info.transferred,
        total: info.total,
        bytesPerSecond: info.bytesPerSecond,
      },
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    setState({
      status: "downloaded",
      version: info.version,
      progress: null,
      error: null,
    });
  });
  autoUpdater.on("update-cancelled", () => {
    setState({ status: "available", progress: null, error: null });
  });
  autoUpdater.on("error", (error) => {
    console.error("[updater]", error);
    setState({
      status: "error",
      progress: null,
      error: describeUpdaterError(error),
      checkedAt: Date.now(),
    });
  });

  // Automatic startup check (packaged only) — raises the OS notification.
  if (app.isPackaged) {
    void checkForUpdates(true);
  }
}

/**
 * Ask the server whether an update exists. Concurrent calls are coalesced onto
 * the same in-flight check. `notify` requests an OS notification when an update
 * is found (startup only).
 */
export async function checkForUpdates(notify = false): Promise<UpdaterState> {
  if (activeCheck !== null) return activeCheck;
  if (downloading) return state;
  notifyNextResult = notify;
  setState({ status: "checking", error: null });
  activeCheck = runCheck();
  try {
    return await activeCheck;
  } finally {
    activeCheck = null;
    notifyNextResult = false;
  }
}

async function runCheck(): Promise<UpdaterState> {
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result === null) {
      setState({
        status: "error",
        error: t("Updates are unavailable."),
        checkedAt: Date.now(),
      });
    }
    return state;
  } catch (error) {
    // The `error` event also fires; keep one coherent terminal state.
    setState({
      status: "error",
      progress: null,
      error: describeUpdaterError(error),
      checkedAt: Date.now(),
    });
    return state;
  }
}

/** Download the update found by the last check. No-op unless `available`. */
export async function downloadUpdate(): Promise<UpdaterState> {
  if (downloading || state.status !== "available") return state;
  const token = new CancellationToken();
  activeDownloadToken = token;
  downloading = true;
  setState({
    status: "downloading",
    progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
    error: null,
  });
  try {
    await autoUpdater.downloadUpdate(token);
    // `update-downloaded` transitions to the terminal state.
    return state;
  } catch (error) {
    if (token.cancelled) {
      setState({ status: "available", progress: null, error: null });
    } else {
      setState({
        status: "error",
        progress: null,
        error: describeUpdaterError(error),
      });
    }
    return state;
  } finally {
    downloading = false;
    activeDownloadToken = null;
  }
}

/** Abort an in-flight download. Returns to `available` so it can be retried. */
export function cancelUpdateDownload(): void {
  activeDownloadToken?.cancel();
}

/** Quit and install a downloaded update, then relaunch (silent on Windows). */
export function installUpdate(): void {
  if (state.status !== "downloaded") return;
  // Closing the window only hides it now, so mark the app as quitting *before*
  // the updater tears the windows down; otherwise the process would survive the
  // close and never install.
  markQuitting();
  autoUpdater.quitAndInstall(true, true);
}

function setState(patch: Partial<UpdaterState>): void {
  state = { ...state, ...patch };
  sendToRenderer("updater:state", state);
}

/**
 * Show the "update available" OS notification once per version (a stored
 * setting suppresses repeats across launches). Clicking focuses the app and
 * jumps to Settings → About.
 */
function notifyUpdateAvailable(version: string): void {
  if (!Notification.isSupported()) return;
  // The dedupe row lives in the app database. A remote desktop shell has no
  // local data folder, so it cannot remember the version and always notifies —
  // correct, just noisier.
  if (isDatabaseReady()) {
    if (getSetting(SettingKeys.UpdateNotifiedVersion) === version) return;
    try {
      setSetting(SettingKeys.UpdateNotifiedVersion, version);
    } catch (error) {
      console.error("[updater] failed to persist notified version:", error);
    }
  }

  const notification = new Notification({
    title: t("A new version of imboss is available"),
    body: t("Click to view and update to v${version}.", { version }),
  });
  notification.on("click", () => {
    showMainWindow();
    sendToRenderer("settings:focus", "about");
  });
  notification.show();
}
