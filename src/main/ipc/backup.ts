import { t } from "@shared/l10n";
import { isAbsolute, join } from "path";
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
import { getAppInfo, getProcessRestarter } from "../platform";
import { assertString } from "./helpers";
import type { Binder } from "../rpc/types";

/**
 * Settings › Backup. The pickers are native dialogs driven from here, so the
 * renderer only ever sees the manifest and the resulting paths — it never
 * handles the archive itself.
 */
export function registerBackupHandlers(bind: Binder): void {
  bind("backup:status", () => getBackupStatus());

  // `destination` is passed by the remote shell, which chose it with the local
  // save dialog and pulls the archive down afterwards; local mode omits it and
  // gets the native dialog here.
  bind("backup:export", async (_ctx, destinationPath?: unknown) => {
    if (destinationPath !== undefined) {
      const path = assertString(destinationPath, "backup path");
      if (!isAbsolute(path))
        throw new Error("The backup path must be absolute.");
      return createBackup({ destination: path });
    }
    const destination = await showSaveDialog({
      title: t("Export a backup"),
      defaultPath: join(
        getAppInfo().getDownloadsPath(),
        defaultBackupFileName(),
      ),
      filters: [
        { name: t("imboss backup"), extensions: [BACKUP_EXTENSION] },
        { name: t("All files"), extensions: ["*"] },
      ],
    });
    if (destination === null) return null;
    return createBackup({ destination });
  });

  // Same split as `backup:export`: the remote shell uploads the chosen archive
  // first and passes its backend path; local mode opens the dialog.
  bind("backup:inspect", async (_ctx, archivePath?: unknown) => {
    if (archivePath !== undefined) {
      const path = assertString(archivePath, "backup path");
      if (!isAbsolute(path))
        throw new Error("The backup path must be absolute.");
      return inspectBackup(path);
    }
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

  bind("backup:restore", (_ctx, path: unknown) =>
    stageRestore(assertString(path, "backup path")),
  );

  bind("backup:cancelRestore", () => {
    cancelPendingRestore();
  });

  bind("backup:restart", () => {
    // Host-specific: the desktop relaunches itself, a backend expects its
    // supervisor to bring it back — the data folder is about to be replaced
    // wholesale, so nothing here may survive the restart.
    getProcessRestarter().restart();
  });
}
