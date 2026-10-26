import { homedir } from "os";
import { join } from "path";

/**
 * Platform seam — the *only* way the business layer talks to its host.
 *
 * The app has two hosts for the same business code (see
 * `.pi/facts/grpc-remote-backend-research.md`):
 *
 * - the Electron desktop process (`src/main/desktop/platform.ts` installs real
 *   implementations backed by `dialog`, `shell`, `clipboard`, `Notification`,
 *   `nativeTheme` and `app`),
 * - the headless Node backend (`src/main/server/bootstrap.ts` keeps the
 *   defaults below, which are inert or throw a readable error).
 *
 * Everything in this module is Electron-free on purpose: `src/main/**` business
 * modules may import it, the server bundle must never pull Electron in.
 *
 * Ownership note: values are process-global, installed exactly once at startup
 * before any handler can run. A missing installation therefore means "this host
 * has no such capability", never "initialize later".
 */

/** An OS file dialog result the caller can act on (`null` = cancelled). */
export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  /** Subset of Electron's dialog properties the app actually uses. */
  properties?: Array<
    "openFile" | "openDirectory" | "multiSelections" | "createDirectory"
  >;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/** Process-level facts about the host that business code needs to display. */
export interface AppInfo {
  /** Host app version (the desktop bundle's, or the backend package's). */
  getVersion(): string;
  /** Host UI locale, or `null` when the host cannot tell. */
  getLocale(): string | null;
  /** Default folder for a save dialog ("downloads" on the desktop). */
  getDownloadsPath(): string;
}

/** Native file/folder pickers. */
export interface FilePicker {
  showOpenDialog(options: OpenDialogOptions): Promise<string[] | null>;
  showSaveDialog(options: SaveDialogOptions): Promise<string | null>;
}

/** "Show this file to the user" affordances of the host OS. */
export interface Revealer {
  /** Select the file in the OS file manager. */
  showItemInFolder(path: string): void;
  /** Open a file/folder with the OS default application. */
  openPath(path: string): Promise<string>;
}

/** Writing to the host clipboard. */
export interface Clipboard {
  writeText(text: string): void;
}

/** Handing an http(s) URL to the host's browser. */
export interface ExternalOpener {
  openExternal(url: string): void;
}

export interface OsNotification {
  chatId: number;
  title: string;
  body: string;
}

/**
 * OS-level notification. The desktop host shows it and reports a click back
 * through the `onClick` handler installed with it; a headless backend ignores
 * it (it has no user session to interrupt).
 */
export interface OsNotifier {
  notify(notification: OsNotification): void;
}

/**
 * Restarting the host process.
 *
 * The desktop relaunches itself; a backend exits and expects its supervisor
 * (systemd / pm2) to bring it back — a staged backup restore is the one caller.
 */
export interface ProcessRestarter {
  restart(): void;
}

/** Applying the persisted theme mode to the host's chrome. */
export interface ThemeApplier {
  applyMode(mode: "light" | "dark" | "system"): void;
}

export interface Platform {
  appInfo: AppInfo;
  filePicker: FilePicker;
  revealer: Revealer;
  clipboard: Clipboard;
  externalOpener: ExternalOpener;
  osNotifier: OsNotifier;
  themeApplier: ThemeApplier;
  processRestarter: ProcessRestarter;
}

/**
 * Thrown when a channel is reachable but meaningless on this host (a native
 * dialog on a headless backend, the clipboard on a server). The message is
 * user-facing, mirroring the app's `throw new Error(...)` convention.
 */
export class UnsupportedOnHostError extends Error {
  constructor(what: string) {
    super(`${what} is not available on this host.`);
    this.name = "UnsupportedOnHostError";
  }
}

/** Plain-Node defaults: enough to display, never enough to act. */
const appInfo: AppInfo = {
  getVersion: () => "0.0.0",
  getLocale: () => null,
  getDownloadsPath: () => join(homedir(), "Downloads"),
};

const filePicker: FilePicker = {
  showOpenDialog: () =>
    Promise.reject(new UnsupportedOnHostError("A native file dialog")),
  showSaveDialog: () =>
    Promise.reject(new UnsupportedOnHostError("A native file dialog")),
};

const revealer: Revealer = {
  showItemInFolder: () => {
    throw new UnsupportedOnHostError("Revealing a file in the file manager");
  },
  openPath: () => Promise.reject(new UnsupportedOnHostError("Opening a path")),
};

const clipboard: Clipboard = {
  writeText: () => {
    throw new UnsupportedOnHostError("The clipboard");
  },
};

const externalOpener: ExternalOpener = {
  // Never throws: callers fire it and forget, and the URL itself always reaches
  // the UI through the provider login event.
  openExternal: (url) => {
    console.warn(`[platform] no browser on this host; ignoring ${url}`);
  },
};

const osNotifier: OsNotifier = {
  notify: () => {
    // A headless backend has no user to notify; the renderer still receives the
    // unread bump over the event stream.
  },
};

const processRestarter: ProcessRestarter = {
  restart: () => {
    // Without a supervisor this leaves the backend down; README requires one.
    process.exit(0);
  },
};

const themeApplier: ThemeApplier = {
  applyMode: () => {
    // No native chrome to theme on a headless host.
  },
};

let platform: Platform = {
  appInfo,
  filePicker,
  revealer,
  clipboard,
  externalOpener,
  osNotifier,
  themeApplier,
  processRestarter,
};

/** Install host implementations (desktop bootstrap calls this once). */
export function setPlatform(overrides: Partial<Platform>): void {
  platform = { ...platform, ...overrides };
}

export function getAppInfo(): AppInfo {
  return platform.appInfo;
}

export function getFilePicker(): FilePicker {
  return platform.filePicker;
}

export function getRevealer(): Revealer {
  return platform.revealer;
}

export function getClipboard(): Clipboard {
  return platform.clipboard;
}

export function getExternalOpener(): ExternalOpener {
  return platform.externalOpener;
}

export function getOsNotifier(): OsNotifier {
  return platform.osNotifier;
}

export function getThemeApplier(): ThemeApplier {
  return platform.themeApplier;
}

export function getProcessRestarter(): ProcessRestarter {
  return platform.processRestarter;
}
