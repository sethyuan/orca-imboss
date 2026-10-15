import { t } from "@shared/l10n";
import { app, ipcMain } from "electron";
import { join } from "path";
import {
  BACKUP_EXTENSION,
  cancelPendingRestore,
  createBackup,
  defaultBackupFileName,
  getBackupStatus,
  inspectBackup,
  stageRestore,
} from "../backup";
import { showOpenDialog, showSaveDialog } from "./dialog";
import { assertString } from "./helpers";

/**
 * Settings › Backup. The pickers are native dialogs driven from here, so the
 * renderer only ever sees the manifest and the resulting paths — it never
 * handles the archive itself.
 */
export function registerBackupHandlers(): void {
  ipcMain.handle("backup:status", () => getBackupStatus());

  ipcMain.handle("backup:export", async (_event, options: unknown) => {
    const includeCredentials =
      (options as { includeCredentials?: unknown } | null)
        ?.includeCredentials === true;
    const destination = await showSaveDialog({
      title: t("Export a backup"),
      defaultPath: join(app.getPath("downloads"), defaultBackupFileName()),
      filters: [
        { name: t("imboss backup"), extensions: [BACKUP_EXTENSION] },
        { name: t("All files"), extensions: ["*"] },
      ],
    });
    if (destination === null) return null;
    return createBackup({ includeCredentials, destination });
  });

  ipcMain.handle("backup:inspect", async () => {
    const paths = await showOpenDialog({
      title: t("Select a backup file"),
      properties: ["openFile"],
      filters: [
        { name: t("imboss backup"), extensions: [BACKUP_EXTENSION] },
        { name: t("All files"), extensions: ["*"] },
      ],
    });
    if (paths === null) return null;
    return inspectBackup(paths[0]);
  });

  ipcMain.handle("backup:restore", (_event, path: unknown) =>
    stageRestore(assertString(path, "backup path")),
  );

  ipcMain.handle("backup:cancelRestore", () => {
    cancelPendingRestore();
  });

  ipcMain.handle("backup:restart", () => {
    // `exit` rather than `quit`: the relaunched instance takes the
    // single-instance lock the moment this process is gone, and the data folder
    // is about to be replaced wholesale anyway.
    app.relaunch();
    app.exit(0);
  });
}
