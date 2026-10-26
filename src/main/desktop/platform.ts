import type { ThemeMode } from "@shared/types";
import { app, clipboard, nativeTheme, shell } from "electron";
import { setPlatform } from "../platform";
import { desktopFilePicker } from "./dialogs";
import { desktopOsNotifier } from "./os-notifications";

/**
 * Install the Electron implementations of the platform seam.
 *
 * Called once, before any handler can run, by both desktop bootstraps (local
 * mode and the remote shell). The two differ only in what wraps the business
 * layer — IPC handlers vs. gRPC proxies — never in host capabilities: a remote
 * setup still opens its dialogs, clipboard and notifications on this machine.
 */
export function installDesktopPlatform(): void {
  setPlatform({
    appInfo: {
      getVersion: () => app.getVersion(),
      getLocale: () => app.getLocale(),
      getDownloadsPath: () => app.getPath("downloads"),
    },
    filePicker: desktopFilePicker,
    revealer: {
      showItemInFolder: (path) => {
        shell.showItemInFolder(path);
      },
      openPath: (path) => shell.openPath(path),
    },
    clipboard: {
      writeText: (text) => {
        clipboard.writeText(text);
      },
    },
    externalOpener: {
      openExternal: (url) => {
        void shell.openExternal(url);
      },
    },
    osNotifier: desktopOsNotifier,
    processRestarter: {
      restart: () => {
        // `exit` rather than `quit`: the relaunched instance takes the
        // single-instance lock the moment this process is gone (see
        // `ipc/backup.ts`).
        app.relaunch();
        app.exit(0);
      },
    },
    themeApplier: {
      applyMode: (mode: ThemeMode) => {
        // `nativeTheme.themeSource` is what makes Chromium's
        // `prefers-color-scheme` follow the app's choice (`system` keeps
        // tracking the OS, exactly like the pre-split code did).
        nativeTheme.themeSource = mode;
      },
    },
  });
}
