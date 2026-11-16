import { app } from "electron";

/**
 * "Hidden" E2E mode — the switch the E2E suite launches the app with.
 *
 * `tests/e2e` drives the real app through Playwright, and the only thing that
 * made such a run visible to whoever is using the machine was the app itself:
 * every case popped a window, took focus from the frontmost app, showed a Dock
 * icon, took the menu bar, and registered the global show/hide shortcut for a
 * few seconds. None of that is needed: Playwright's `mouse`/`keyboard` are
 * synthetic CDP events (they never touch the real input devices), and a window
 * that is never shown still renders, so it can be clicked, typed into and
 * screenshotted.
 *
 * So in this mode:
 * - the window is created with `show: false` and stays hidden (`ready-to-show`
 *   does not call `show()`),
 * - `showMainWindow()` refuses to bring it up, so no stray `activate` /
 *   `second-instance` can put it on screen,
 * - no tray icon (`initTray`) and no global shortcut (`initWindowShortcut`),
 * - macOS: no Dock icon (`app.dock.hide()` in `index.ts`), which is also what
 *   keeps the app from becoming the active application.
 *
 * Deliberately an environment variable instead of a command-line flag: the suite
 * already hands the app its isolation through the environment
 * (`IMBOSS_DATA_ROOT`, `--user-data-dir`, `HOME`), and this is one more
 * process-wide fact of the same kind.
 *
 * `!app.isPackaged` is a hard guard, not a convenience: a stray
 * `IMBOSS_E2E_HIDDEN=1` in a shell must never hide the *installed* app's window.
 */
export function isE2eHidden(): boolean {
  return process.env["IMBOSS_E2E_HIDDEN"] === "1" && !app.isPackaged;
}
