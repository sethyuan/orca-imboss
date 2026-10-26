import { BrowserWindow, dialog } from "electron";
import { beginNativeDialog, endNativeDialog } from "../main-window";
import type {
  FilePicker,
  OpenDialogOptions,
  SaveDialogOptions,
} from "../platform";

/**
 * Native file/folder dialogs, attached to the focused window (falling back to
 * the first window).
 *
 * Sheet dialogs are tracked so the window cannot be hidden (close button /
 * global shortcut / tray) out from under an open dialog, which would leave a
 * floating ownerless sheet — that is why this lives next to `main-window` rather
 * than in the generic platform layer.
 */
function anchorWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

/** Electron's dialog properties are a superset of ours; widen for the cast. */
type DialogProperties = NonNullable<OpenDialogOptions["properties"]>;

export const desktopFilePicker: FilePicker = {
  async showOpenDialog(options: OpenDialogOptions): Promise<string[] | null> {
    const win = anchorWindow();
    beginNativeDialog();
    let result: Electron.OpenDialogReturnValue;
    try {
      const native: Electron.OpenDialogOptions = {
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.defaultPath !== undefined
          ? { defaultPath: options.defaultPath }
          : {}),
        ...(options.properties !== undefined
          ? { properties: options.properties as DialogProperties }
          : {}),
        ...(options.filters !== undefined ? { filters: options.filters } : {}),
      };
      result = win
        ? await dialog.showOpenDialog(win, native)
        : await dialog.showOpenDialog(native);
    } finally {
      endNativeDialog();
    }
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths;
  },

  async showSaveDialog(options: SaveDialogOptions): Promise<string | null> {
    const win = anchorWindow();
    beginNativeDialog();
    let result: Electron.SaveDialogReturnValue;
    try {
      const native: Electron.SaveDialogOptions = {
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.defaultPath !== undefined
          ? { defaultPath: options.defaultPath }
          : {}),
        ...(options.filters !== undefined ? { filters: options.filters } : {}),
      };
      result = win
        ? await dialog.showSaveDialog(win, native)
        : await dialog.showSaveDialog(native);
    } finally {
      endNativeDialog();
    }
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  },
};
