import { MAX_ATTACHMENT_BYTES } from "@shared/constants/attachments";
import { isPreviewableImagePath } from "@shared/image-attachments";
import { statSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import { getDataRoot } from "../data-dir";

/**
 * File-transfer policy for the remote transport.
 *
 * Two directions, one rule set — and the rule set is *narrow on purpose*: the
 * remote client can read and write only what the app itself owns.
 *
 * - **Upload** (client → backend): the bytes are always written by a channel
 *   handler the backend already trusts (`files:uploadAttachment`), which mints
 *   the destination path. The client never picks a server path, so an upload
 *   cannot overwrite a file it should not touch.
 * - **Download** (backend → client): a path is served only when it is a regular
 *   file *and* either inside the data folder (attachments, avatars, exports) or
 *   a previewable image anywhere (the same allowance the local `imb-file:`
 *   handler already makes, so images outside the data folder keep working).
 *
 * Limits are enforced here, not in the client: a client is never trusted to
 * respect them.
 */

/** Largest accepted single upload kept in memory. Mirrors the composer cap. */
export const MAX_UPLOAD_BYTES = MAX_ATTACHMENT_BYTES;

/**
 * Largest accepted upload streamed to a temp file.
 *
 * These are imports (a whole data-folder archive, an employee package), written
 * straight to disk, so the limit is disk-shaped rather than memory-shaped. It is
 * still bounded: an unauthenticated-but-lucky client must not be able to fill the
 * volume, and the temp folder is swept at startup (see `sweepTransferTempRoot`).
 */
export const MAX_STREAMED_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** How many upload streams one client may have open at a time. */
export const MAX_CONCURRENT_UPLOADS = 4;

/** Read size for a download stream. */
export const DOWNLOAD_CHUNK_BYTES = 64 * 1024;

/** Channels whose last positional argument is the uploaded bytes. */
const BINARY_TAIL_CHANNELS = new Set([
  "files:uploadAttachment",
  "files:stageUpload",
  // Legacy binary channels: still reachable over the remote transport so a
  // future client does not have to know about two mechanisms.
  "files:savePastedFile",
  "employees:updateAvatar",
]);

/**
 * Split a channel call into "arguments" and "trailing bytes".
 *
 * The transport treats the bytes specially (streamed, never JSON): everything
 * before them is the JSON envelope the backend already validates.
 */
export function splitBinaryArgs(
  channel: string,
  args: unknown[],
): { args: unknown[]; bytes: Uint8Array | null } {
  if (!BINARY_TAIL_CHANNELS.has(channel)) return { args, bytes: null };
  const last = args[args.length - 1];
  const bytes =
    last instanceof Uint8Array
      ? last
      : typeof last === "string"
        ? Buffer.from(last, "base64")
        : null;
  if (bytes === null) {
    throw new Error(`${channel} expects a Uint8Array as its last argument.`);
  }
  return { args: args.slice(0, -1), bytes };
}

/**
 * Streamed-upload channels whose temp file must **survive** the call.
 *
 * The default is "the file exists only so this handler can consume it", which is
 * what makes an abandoned import impossible to leak. `files:stageUpload` is the
 * exception: its whole job is to hand the caller a path that a *later* call
 * (`backup:inspect`, `employees:importInspect`) reads. Those leftovers are bounded
 * by the startup sweep (`TRANSFER_TEMP_RETENTION_DAYS`).
 */
const KEEP_TEMP_UPLOAD_CHANNELS = new Set(["files:stageUpload"]);

export function keepsTempUpload(channel: string): boolean {
  return KEEP_TEMP_UPLOAD_CHANNELS.has(channel);
}

/** True when `channel` carries binary payload (needs the Upload stream). */
export function isBinaryTailChannel(channel: string): boolean {
  return BINARY_TAIL_CHANNELS.has(channel);
}

export interface DownloadDenial {
  code: "invalid" | "forbidden" | "missing";
  message: string;
}

/**
 * Decide whether `path` may be served to a client.
 *
 * Returns `null` when it may, or why not. The checks run in order of cost:
 * shape, containment, existence — so a forbidden path never touches the disk.
 */
export function checkDownloadable(path: string): DownloadDenial | null {
  if (typeof path !== "string" || path.length === 0) {
    return { code: "invalid", message: "A file path is required." };
  }
  if (!isAbsolute(path)) {
    return { code: "invalid", message: "The file path must be absolute." };
  }
  const resolved = resolve(path);
  if (!insideDataRoot(resolved) && !isPreviewableImagePath(resolved)) {
    return {
      code: "forbidden",
      message:
        "Only files inside the imboss data folder (and previewable images) can be downloaded.",
    };
  }
  try {
    if (!statSync(resolved).isFile()) {
      return { code: "missing", message: "The file does not exist." };
    }
  } catch {
    return { code: "missing", message: "The file does not exist." };
  }
  return null;
}

/** True when `path` resolves inside the data folder (never the folder itself). */
function insideDataRoot(path: string): boolean {
  const root = resolve(getDataRoot());
  if (path === root) return false;
  const rel = relative(root, path);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return false;
  return !rel.split(sep).includes("..");
}
