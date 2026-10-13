import type { AssetFilter, AssetRef } from "@shared/types";
import { ipcMain } from "electron";
import { basename } from "path";
import {
  exportAssetsZip,
  openAsset,
  readAssetBytes,
  readAssetText,
  resolveAssetPath,
  saveAssetAs,
  trashAsset,
} from "../assets";
import * as dbAssets from "../db/assets";
import { sendToRenderer } from "../notifications";
import {
  assertInteger,
  assertObject,
  assertString,
  parsePageQuery,
} from "./helpers";

/**
 * Validate an `AssetRef` payload. The renderer only ever passes the trusted
 * locator (`messageId`, `index`); the main process resolves the on-disk path
 * from the stored message.
 */
function assertAssetRef(value: unknown): AssetRef {
  const record = assertObject(value, "asset ref");
  const messageId = assertInteger(record["messageId"], "message id");
  const index = assertInteger(record["index"], "attachment index");
  if (index < 0) {
    throw new Error("Attachment index must be non-negative.");
  }
  return { messageId, index };
}

export function registerAssetHandlers(): void {
  ipcMain.handle("assets:list", (_event, filter: unknown, page: unknown) => {
    const safeFilter =
      filter === undefined || filter === null
        ? {}
        : assertObject(filter, "filter");
    return dbAssets.listAssets(safeFilter as AssetFilter, parsePageQuery(page));
  });

  ipcMain.handle("assets:detail", (_event, ref: unknown) => {
    const safe = assertAssetRef(ref);
    return dbAssets.getAsset(safe.messageId, safe.index);
  });

  ipcMain.handle("assets:occurrences", (_event, ref: unknown) => {
    const safe = assertAssetRef(ref);
    return dbAssets.listAssetOccurrences(safe.messageId, safe.index);
  });

  ipcMain.handle("assets:hide", (_event, ref: unknown) => {
    const safe = assertAssetRef(ref);
    // A missing file must still be hideable, so resolve the stored path without
    // requiring it to exist on disk.
    dbAssets.hideAsset(
      resolveAssetPath(safe.messageId, safe.index, { requireExists: false }),
    );
    sendToRenderer("assets:changed", {});
  });

  ipcMain.handle("assets:unhide", (_event, path: unknown) => {
    dbAssets.unhideAsset(assertString(path, "path"));
    sendToRenderer("assets:changed", {});
  });

  ipcMain.handle("assets:hidden", () => dbAssets.listHiddenAssets());

  ipcMain.handle("assets:textPreview", (_event, ref: unknown) => {
    const safe = assertAssetRef(ref);
    return readAssetText(resolveAssetPath(safe.messageId, safe.index));
  });

  ipcMain.handle("assets:fileBytes", (_event, ref: unknown) => {
    const safe = assertAssetRef(ref);
    return readAssetBytes(resolveAssetPath(safe.messageId, safe.index));
  });

  ipcMain.handle("assets:saveAs", (_event, ref: unknown) => {
    const safe = assertAssetRef(ref);
    const path = resolveAssetPath(safe.messageId, safe.index);
    return saveAssetAs(path, basename(path));
  });

  ipcMain.handle("assets:exportZip", (_event, refs: unknown) => {
    if (!Array.isArray(refs)) throw new Error("refs must be an array.");
    const paths = refs.map((ref) => {
      const safe = assertAssetRef(ref);
      return resolveAssetPath(safe.messageId, safe.index);
    });
    return exportAssetsZip(paths);
  });

  ipcMain.handle("assets:open", (_event, ref: unknown) => {
    const safe = assertAssetRef(ref);
    return openAsset(resolveAssetPath(safe.messageId, safe.index));
  });

  ipcMain.handle("assets:trash", (_event, ref: unknown) => {
    const safe = assertAssetRef(ref);
    const path = resolveAssetPath(safe.messageId, safe.index);
    return trashAsset(path).then(() => {
      dbAssets.hideAsset(path);
      sendToRenderer("assets:changed", {});
    });
  });
}
