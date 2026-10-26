import { MAX_ATTACHMENT_BYTES } from "@shared/constants/attachments";
import { t } from "@shared/l10n";
import { basename, isAbsolute } from "path";
import { randomUUID } from "crypto";
import { statSync, writeFileSync } from "fs";
import {
  deletePastedFile,
  savePastedFile,
  saveUploadedFile,
} from "../attachments";
import {
  createDirectory,
  createTransferTempPath,
  listDirectories,
} from "../file-browser";
import { showOpenDialog } from "./dialog";
import { assertInteger, assertString } from "./helpers";
import type { Binder } from "../rpc/types";

export function registerFileHandlers(bind: Binder): void {
  // Persist bytes pasted into the composer that have no backing file on disk
  // (screenshots / copied image data). The renderer must send a generated,
  // non-authoritative `name`/`type`; main sanitizes both and owns the path.
  bind(
    "files:savePastedFile",
    (_ctx, chatId: unknown, name: unknown, type: unknown, data: unknown) => {
      const safeChatId = assertInteger(chatId, "chat id");
      const safeName = assertString(name, "file name");
      const safeType = assertString(type, "file type");
      return savePastedFile(safeChatId, safeName, safeType, toBuffer(data));
    },
  );

  /**
   * Store a file the *remote client* uploaded (a file picked on the user's
   * machine, which the backend cannot read by path). Reached through the
   * transport's `Upload` stream, which appends the bytes as the last argument —
   * so the signature is the same shape as `files:savePastedFile`.
   *
   * The reply carries the backend path, which is what the agent will read and
   * what an `imb-file:` preview URL is built from.
   */
  bind(
    "files:uploadAttachment",
    (_ctx, chatId: unknown, name: unknown, type: unknown, data: unknown) => {
      const safeChatId = assertInteger(chatId, "chat id");
      const safeName = assertString(name, "file name");
      const safeType = assertString(type, "file type");
      return saveUploadedFile(safeChatId, safeName, safeType, toBuffer(data));
    },
  );

  // Remove the on-disk copy of a pasted attachment when its chip is discarded.
  // Main verifies the path belongs to the pasted store before deleting, so a
  // disk-backed user file (original path) is never removed.
  bind("files:deletePastedFile", (_ctx, path: unknown) => {
    deletePastedFile(assertString(path, "attachment path"));
  });

  // Choose one or more folders from the native directory dialog. The path
  // always originates in main (never a renderer-supplied string), matching the
  // workdir picker and the reveal IPC's trust model. A folder is attached by
  // path only — no bytes are copied; the model reads the directory in place.
  bind("files:chooseDirectories", async () => {
    const paths = await showOpenDialog({
      title: t("Select folder"),
      properties: ["openDirectory", "multiSelections"],
    });
    if (!paths) return null;
    return paths
      .filter((path) => isAbsolute(path))
      .map((path) => ({ name: basename(path), path }));
  });

  /**
   * Remote path picking (see `src/main/file-browser.ts`): the client has no
   * access to the backend's filesystem, so "choose a folder" becomes "browse it".
   * Directories only — every flow that needs a path needs a folder.
   */
  bind("files:listDir", (_ctx, path: unknown) => {
    if (path !== undefined && path !== null && typeof path !== "string") {
      throw new Error("path must be a string.");
    }
    return listDirectories(path as string | undefined);
  });

  bind("files:createDirectory", (_ctx, parent: unknown, name: unknown) =>
    createDirectory(
      assertString(parent, "parent path"),
      assertString(name, "folder name"),
    ),
  );

  /**
   * Put arbitrary local bytes on the backend for a one-shot flow (importing a
   * backup or an employee package the user picked on their machine). Writes into
   * the transfer temp folder and returns the path, which the caller then hands
   * to the channel that reads archives.
   */
  bind("files:stageUpload", (_ctx, name: unknown, data: unknown) => {
    const safeName = assertString(name, "file name");
    if (safeName.length > 200) throw new Error("The file name is too long.");
    // Streamed uploads (large imports) arrive as a path the transport already
    // wrote to disk; small ones as bytes. Both end up as a path the caller can
    // hand to the archive-reading channel.
    if (typeof data === "string") {
      if (!isAbsolute(data)) {
        throw new Error("The uploaded file path must be absolute.");
      }
      return { name: safeName, path: data, size: statSync(data).size };
    }
    const bytes = toBuffer(data);
    const path = createTransferTempPath(safeName, randomUUID());
    writeFileSync(path, bytes, { mode: 0o600 });
    return { name: safeName, path, size: bytes.length };
  });

  /**
   * Mint a backend path an export can be written to, for the client to download.
   * The token keeps concurrent exports (and retries) apart; the client never
   * chooses the directory, only the file name.
   */
  bind("files:tempPath", (_ctx, name: unknown) => {
    const safeName = assertString(name, "file name");
    if (safeName.length > 200) throw new Error("The file name is too long.");
    return createTransferTempPath(safeName, randomUUID());
  });
}

/** Coerce renderer bytes to a `Buffer`, rejecting oversized payloads early. */
function toBuffer(value: unknown): Buffer {
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachment is too large.");
    }
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachment is too large.");
    }
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("file data must be a Uint8Array or ArrayBuffer.");
}
