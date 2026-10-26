import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { rm } from "fs/promises";
import { basename, extname, isAbsolute, join, resolve, sep } from "path";
import { MAX_ATTACHMENT_BYTES } from "@shared/constants/attachments";
import type { MessageAttachment } from "@shared/types";
import { getAttachmentsDir } from "./data-dir";

/**
 * On-disk store for files pasted into the chat composer:
 * `<dataRoot>/attachments/<chatId>/<name>`. Clipboard-synthesized files
 * (screenshots, copied image data) have no backing file, so they are written
 * here to give the attachment a real `path` — without it the agent cannot read
 * the image and the bubble chip cannot be revealed. The directory is removed
 * per chat when the chat is deleted (`chats:delete`), mirroring integration
 * media.
 *
 * Security posture:
 * - Files are written only under `getAttachmentsDir()`; the per-chat segment is
 *   an integer and the file name is sanitized to a single path segment, so path
 *   traversal is impossible by construction.
 * - The extension is sanitized and capped; unknown MIME falls back to the
 *   renderer-suggested extension only when it is filesystem-safe.
 * - Writes are atomic (temp file + rename) and chmod 0600 on POSIX.
 */

/**
 * Name prefixes this module mints itself. Only these may be deleted from the
 * attachments store: a chip dropped from the composer must never be able to
 * remove a file the user picked from their own disk (those live outside the
 * store anyway, but the check keeps the trust model in one place).
 */
const APP_MINTED_PREFIXES = ["pasted-", "upload-"];

/** A filesystem-safe extension (letters/digits only, short). */
const SAFE_EXTENSION = /^[a-z0-9]{1,8}$/;

const DEFAULT_MIME = "application/octet-stream";
const MAX_MIME_LENGTH = 128;
const MAX_BASE_LENGTH = 100;

/** Best-effort extension for a synthesized payload with an unknown name. */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "text/plain": "txt",
};

function chatAttachmentsDir(chatId: number): string {
  return join(getAttachmentsDir(), String(chatId));
}

/** Reduce a suggested name to a single safe path segment (no extension). */
function sanitizeBaseName(name: string): string {
  const base = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\.[^.]*$/, "")
    .trim();
  if (base.length === 0 || base === "." || base === "..") return "pasted";
  return base.slice(0, MAX_BASE_LENGTH);
}

/** Extension from the suggested name when safe, else from the MIME type. */
function resolveExtension(name: string, mime: string): string {
  const ext = extname(name).slice(1).toLowerCase();
  if (SAFE_EXTENSION.test(ext)) return ext;
  return EXT_BY_MIME[mime.toLowerCase()] ?? "";
}

/** Find a name whose path does not exist yet (`<base>`, `<base>-2`, ...). */
function uniqueDestination(
  dir: string,
  base: string,
  ext: string,
): { name: string; path: string } {
  const suffix = ext.length > 0 ? `.${ext}` : "";
  let name = `${base}${suffix}`;
  let target = join(dir, name);
  let counter = 2;
  while (existsSync(target)) {
    name = `${base}-${counter}${suffix}`;
    target = join(dir, name);
    counter += 1;
  }
  return { name, path: target };
}

/**
 * Persist a pasted file and return its attachment metadata (with the stored
 * absolute `path`). Synchronous so a single, non-interleaved write also makes
 * name-collision resolution race-free.
 */
export function savePastedFile(
  chatId: number,
  suggestedName: string,
  mime: string,
  data: Buffer,
): MessageAttachment {
  if (!Number.isSafeInteger(chatId)) {
    throw new Error("chat id must be an integer.");
  }
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new Error("Attachment data is required.");
  }
  if (data.length > MAX_ATTACHMENT_BYTES) {
    throw new Error("Attachment is too large.");
  }

  const safeMime = mime.length > 0 ? mime.slice(0, MAX_MIME_LENGTH) : "";
  const type = safeMime.length > 0 ? safeMime : DEFAULT_MIME;
  const base = sanitizeBaseName(suggestedName);
  const ext = resolveExtension(suggestedName, type);

  const dir = chatAttachmentsDir(chatId);
  mkdirSync(dir, { recursive: true });
  const { name, path: dest } = uniqueDestination(dir, base, ext);

  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, dest);
  if (process.platform !== "win32") {
    try {
      chmodSync(dest, 0o600);
    } catch {
      // Best-effort hardening only (mirrors avatars.ts).
    }
  }

  return { name, size: data.length, type, path: dest };
}

/**
 * Store a file the *remote client* uploaded (a picked local file, which only
 * exists on the user's machine).
 *
 * Same store, same limits and same ownership rules as {@link savePastedFile},
 * with two differences that matter in remote mode:
 * - the on-disk name carries a UUID, so a retried upload can never collide with
 *   the copy the previous attempt wrote;
 * - the name kept in the metadata is the user's own (`report.pdf`), while the
 *   disk name is prefixed, which is what marks it as app-minted for deletion.
 */
export function saveUploadedFile(
  chatId: number,
  suggestedName: string,
  mime: string,
  data: Buffer,
): MessageAttachment {
  if (!Number.isSafeInteger(chatId)) {
    throw new Error("chat id must be an integer.");
  }
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new Error("Attachment data is required.");
  }
  if (data.length > MAX_ATTACHMENT_BYTES) {
    throw new Error("Attachment is too large.");
  }

  const safeMime = mime.length > 0 ? mime.slice(0, MAX_MIME_LENGTH) : "";
  const type = safeMime.length > 0 ? safeMime : DEFAULT_MIME;
  const base = sanitizeBaseName(suggestedName);
  const ext = resolveExtension(suggestedName, type);
  const displayName = ext.length > 0 ? `${base}.${ext}` : base;

  const dir = chatAttachmentsDir(chatId);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `upload-${randomUUID()}-${displayName}`);

  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, dest);
  if (process.platform !== "win32") {
    try {
      chmodSync(dest, 0o600);
    } catch {
      // Best-effort hardening only (mirrors `savePastedFile`).
    }
  }

  return { name: displayName, size: data.length, type, path: dest };
}

/**
 * Delete a single pasted file previously written by `savePastedFile` (e.g.
 * when the user removes the chip from the composer). The renderer supplies the
 * path, so ownership is verified before anything is removed: the path must
 * resolve inside `getAttachmentsDir()`, name a regular (non-symlink) file, and
 * start with the `pasted-` prefix we mint. Disk-backed user files and legacy
 * attachments are therefore never touched.
 */
export function deletePastedFile(path: string): void {
  if (path.length === 0 || !isAbsolute(path)) return;
  const root = getAttachmentsDir();
  const resolved = resolve(path);
  if (!resolved.startsWith(root + sep)) return;
  if (
    !APP_MINTED_PREFIXES.some((prefix) => basename(resolved).startsWith(prefix))
  ) {
    return;
  }
  try {
    if (!lstatSync(resolved).isFile()) return;
  } catch {
    return; // already gone or inaccessible
  }
  rmSync(resolved, { force: true });
}

/** Remove every pasted file belonging to a chat (called from `chats:delete`). */
export async function deletePastedFilesForChat(chatId: number): Promise<void> {
  if (!Number.isSafeInteger(chatId)) return;
  await rm(chatAttachmentsDir(chatId), { recursive: true, force: true });
}

/**
 * Delete a file this app wrote under the attachments dir, without the
 * `pasted-` name check `deletePastedFile` applies — for files the app generated
 * itself (a picture dropped by the image-message generation cap). Ownership is
 * still verified by directory: the path must resolve inside
 * `getAttachmentsDir()` and name a regular (non-symlink) file, so a
 * caller-supplied path can never reach a user file outside the store.
 */
export function deleteAttachmentFile(path: string): void {
  if (path.length === 0 || !isAbsolute(path)) return;
  const root = getAttachmentsDir();
  const resolved = resolve(path);
  if (!resolved.startsWith(root + sep)) return;
  try {
    if (!lstatSync(resolved).isFile()) return;
  } catch {
    return; // already gone or inaccessible
  }
  rmSync(resolved, { force: true });
}
