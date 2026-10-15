import { BrowserWindow, dialog } from "electron";

/**
 * Show a native open dialog attached to the focused window (falling back to the
 * first window). Returns the selected absolute paths, or `null` when the dialog
 * was cancelled or produced no selection.
 */
export async function showOpenDialog(
  options: Electron.OpenDialogOptions,
): Promise<string[] | null> {
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths;
}

/**
 * Show a native save dialog attached to the focused window (falling back to the
 * first window). Returns the chosen absolute path, or `null` when the dialog
 * was cancelled or produced no path.
 */
export async function showSaveDialog(
  options: Electron.SaveDialogOptions,
): Promise<string | null> {
  const win =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
}
