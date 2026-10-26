/**
 * Turning OS/clipboard files into draft attachments, shared by every place the
 * boss can attach a file to something they are about to send: the chat composer
 * and the ask card's answer.
 *
 * Plain functions only — no React, no store access — so the two call sites can
 * keep their own state (per-chat draft vs per-ask draft) while behaving
 * identically: same path resolution, same `pasted-*` naming, same "paste is
 * persisted to disk before it can be sent" rule, same cap handling.
 *
 * Folders are supported (a directory is attached by absolute path; the agent
 * reads it in place, so there are no bytes to carry). Conversation references
 * (`kind: "chat"`) are NOT modelled: only the composer offers them, and it
 * builds those attachments itself.
 */
import { MAX_ATTACHMENT_BYTES } from "@shared/constants/attachments";
import { t } from "@shared/l10n";
import type { MessageAttachment } from "@shared/types";
import { nextAttachmentId, type PendingAttachment } from "./chat-draft";
import { chooseRemoteDirectory, isRemoteMode } from "./remote-files";

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|heic|heif)$/i;

/**
 * Best-effort image detection: prefer the MIME type the picker/drag source
 * supplies, falling back to the extension because some drag sources report an
 * empty type.
 */
export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS.test(file.name);
}

/** True when a drag payload carries OS files (ignores text/link drags). */
export function hasDroppedFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes("Files");
}

/**
 * Collect clipboard files synchronously. `DataTransferItem`s are only valid
 * during the paste event, so this must not be deferred behind an await. Falls
 * back to `clipboardData.files` for sources without `items`.
 */
export function filesFromClipboard(data: DataTransfer): File[] {
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0 && data.files.length > 0) {
    files.push(...Array.from(data.files));
  }
  return files;
}

/** Safe extension for a pasted file: its name first, then its MIME subtype. */
function extensionFor(file: File): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(file.name);
  if (match) return match[1].toLowerCase();
  const slash = file.type.indexOf("/");
  if (slash < 0) return "";
  const subtype = file.type.slice(slash + 1).toLowerCase();
  if (subtype === "jpeg") return "jpg";
  return /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : "";
}

/** `pasted-YYYYMMDD-HHmmss.<ext>` name for a clipboard-synthesized file. */
export function pastedName(file: File): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ext = extensionFor(file);
  return `pasted-${date}-${time}${ext.length > 0 ? `.${ext}` : ""}`;
}

/**
 * Attachment metadata for a file the OS handed us (picker, drag, paste).
 *
 * Locally `webUtils.getPathForFile` (preload) yields the real on-disk path, and
 * carrying it is what makes the chip revealable and the file readable by an
 * agent. **Remotely that path is on the wrong machine**, so the bytes are
 * uploaded first and the attachment carries the *backend* path instead — same
 * shape, same consumers downstream.
 *
 * `chatId` is only needed for the remote upload (the backend stores per
 * conversation); locally it is ignored.
 */
export async function fileAttachment(
  file: File,
  chatId?: number,
): Promise<MessageAttachment> {
  const name = file.name || pastedName(file);
  if (isRemoteMode()) {
    if (chatId === undefined) {
      throw new Error(t("Could not attach the file."));
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return await imb.files.uploadAttachment(chatId, name, file.type, bytes);
  }
  const path = imb.files.getPath(file);
  return {
    name,
    size: file.size,
    type: file.type,
    ...(path ? { path } : {}),
  };
}

/**
 * Attachment metadata for one folder. A folder is attached by absolute path
 * only (main's directory dialog is the authoritative source, a drop resolves
 * the same way): no bytes are copied, so `size` is 0 and the chip has no
 * preview.
 */
export function folderAttachment(
  name: string,
  path: string,
): MessageAttachment {
  return {
    name: name.length > 0 ? name : path,
    size: 0,
    type: "folder",
    path,
    kind: "folder",
  };
}

/** One entry of a drop/choose operation: an OS file or an OS folder. */
export interface FileEntry {
  file: File;
  kind: "file" | "folder";
}

/**
 * Split an OS drop into file/folder entries.
 *
 * A `File` alone cannot be told apart from an empty file, so Chromium's entry
 * API is asked synchronously (`webkitGetAsEntry().isDirectory`); sources
 * without `items` (or with only string items) fall back to `files`, which can
 * only be regular files.
 */
export function dropEntries(dataTransfer: DataTransfer): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    let isDirectory = false;
    try {
      isDirectory = item.webkitGetAsEntry()?.isDirectory === true;
    } catch {
      // Some sources throw; treat the entry as a regular file.
      isDirectory = false;
    }
    entries.push({ file, kind: isDirectory ? "folder" : "file" });
  }
  if (entries.length === 0) {
    for (const file of Array.from(dataTransfer.files)) {
      entries.push({ file, kind: "file" });
    }
  }
  return entries;
}

/**
 * Turn file/folder entries into draft chips, keeping the first `limit` only
 * (the caller owns the cap warning and passes the free slots).
 *
 * A folder is only useful through its absolute path — the agent reads the
 * directory in place and the chip has no bytes to preview — so a folder whose
 * path cannot be resolved is counted in `failedFolders` instead of becoming a
 * dead chip. `webUtils.getPathForFile` yields `""` for JS-constructed files.
 */
export async function pendingFromEntries(
  entries: readonly FileEntry[],
  limit: number,
  chatId?: number,
): Promise<{ items: PendingAttachment[]; failedFolders: number }> {
  const items: PendingAttachment[] = [];
  let failedFolders = 0;
  for (const { file, kind } of entries.slice(0, Math.max(limit, 0))) {
    if (kind === "folder") {
      // A dropped folder is a *local* path. Remotely the agent cannot read it, so
      // it is reported instead of becoming a dead chip — the folder button goes
      // through the backend's browser (`chooseFolderAttachments`).
      if (isRemoteMode()) {
        failedFolders += 1;
        continue;
      }
      const path = imb.files.getPath(file);
      if (!path) {
        failedFolders += 1;
        continue;
      }
      items.push({
        id: nextAttachmentId(),
        attachment: folderAttachment(file.name || path, path),
      });
      continue;
    }
    try {
      items.push(toPendingAttachment(file, await fileAttachment(file, chatId)));
    } catch (err) {
      console.error("[attachment] upload failed:", err);
      failedFolders += 1;
    }
  }
  return { items, failedFolders };
}

/**
 * Ask main for folders through the native directory dialog (multi-select) and
 * return draft chips for them. Resolves `[]` when the boss cancels; throws when
 * the dialog itself fails, so the caller can show its own error.
 */
export async function chooseFolderAttachments(): Promise<PendingAttachment[]> {
  // Remote: the folder must be picked on the backend (the agent reads it there).
  if (isRemoteMode()) {
    const path = await chooseRemoteDirectory(
      t("Choose a folder on the server"),
    );
    if (path === null) return [];
    const name = path
      .split(/[\\/]/)
      .filter((part) => part.length > 0)
      .pop();
    return [
      {
        id: nextAttachmentId(),
        attachment: folderAttachment(name ?? path, path),
      },
    ];
  }
  const directories = await imb.files.chooseDirectories();
  if (!directories || directories.length === 0) return [];
  return directories.map((directory) => ({
    id: nextAttachmentId(),
    attachment: folderAttachment(directory.name, directory.path),
  }));
}

/** Whether a file's bytes are too large to be attached at all. */
export function isOversizedFile(file: File): boolean {
  return file.size > MAX_ATTACHMENT_BYTES;
}

/**
 * Persist a clipboard-synthesized file's bytes to `<dataRoot>/attachments/…`
 * so it has a real `path` (an agent cannot read a `blob:`-only file, and the
 * chip could not be revealed). Main chooses and sanitizes the name/location.
 */
export async function persistPastedFile(
  chatId: number,
  file: File,
): Promise<MessageAttachment> {
  const data = new Uint8Array(await file.arrayBuffer());
  return imb.files.savePastedFile(chatId, pastedName(file), file.type, data);
}

/** Build a chip for a file, minting a thumbnail URL for images. */
export function toPendingAttachment(
  file: File,
  attachment: MessageAttachment,
): PendingAttachment {
  const previewUrl = isImageFile(file) ? URL.createObjectURL(file) : undefined;
  return {
    id: nextAttachmentId(),
    attachment,
    ...(previewUrl ? { previewUrl } : {}),
  };
}

/** {@link discardPendingAttachment} for a whole list. */
export function discardPendingAttachments(
  items: readonly PendingAttachment[],
): void {
  for (const item of items) {
    discardPendingAttachment(item);
  }
}

/**
 * Release only the chip's thumbnail URL. Use it when the attachment is about to
 * be sent — the file on disk is now referenced by a message and must survive.
 */
export function revokePendingAttachment(item: PendingAttachment): void {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
}

/**
 * Release everything a chip owns: the thumbnail URL *and* the on-disk copy of a
 * pasted file (now unreferenced). Main verifies ownership, so a disk-backed user
 * file is never removed.
 */
export function discardPendingAttachment(item: PendingAttachment): void {
  revokePendingAttachment(item);
  if (item.attachment.path) {
    void imb.files.deletePastedFile(item.attachment.path);
  }
}

/**
 * Keep at most `cap - liveCount` of `items` and discard the rest.
 *
 * Re-checks against the live count (not a snapshot taken before an `await`) so
 * a concurrent add can never overshoot the cap. Discarded chips are revoked and
 * their pasted files removed — they were persisted before this decision.
 */
export function acceptWithinCap(
  items: readonly PendingAttachment[],
  liveCount: number,
  cap: number,
): PendingAttachment[] {
  const room = Math.max(cap - liveCount, 0);
  if (items.length <= room) return [...items];
  discardPendingAttachments(items.slice(room));
  return items.slice(0, room);
}
