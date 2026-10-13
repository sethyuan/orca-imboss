import archiver from "archiver";
import { shell } from "electron";
import { createWriteStream, existsSync, statSync } from "fs";
import { copyFile, readFile } from "fs/promises";
import { basename, isAbsolute } from "path";
import { getMessageById } from "./db/messages";
import { showSaveDialog } from "./ipc/dialog";

/**
 * Asset file operations. The renderer never supplies a filesystem path: it
 * passes an `AssetRef` (`messageId`, `index`) and `resolveAssetPath` reads the
 * trusted on-disk location from the stored message — the same trust model as
 * `messages:revealAttachment`.
 */

/** Max bytes for a text/Markdown preview (1 MB). */
export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

/** Max bytes for a binary preview (image/PDF/audio/video) (25 MB). */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

/**
 * Resolve the absolute on-disk path of an attachment from its trusted locator.
 * Throws the same errors as `messages:revealAttachment` so both entry points
 * behave identically. Pass `requireExists: false` to resolve the stored path
 * without requiring the file to still be on disk (hiding a missing asset).
 */
export function resolveAssetPath(
  messageId: number,
  index: number,
  options: { requireExists?: boolean } = {},
): string {
  if (index < 0) {
    throw new Error("Attachment index must be non-negative.");
  }
  const message = getMessageById(messageId);
  if (!message) throw new Error("Message does not exist.");
  const attachments = message.attachments;
  if (!attachments || index >= attachments.length) {
    throw new Error("Attachment does not exist.");
  }
  const path = attachments[index].path;
  if (!path) throw new Error("Attachment location is unavailable.");
  if (!isAbsolute(path)) {
    throw new Error("Attachment location is invalid.");
  }
  if (options.requireExists !== false && !existsSync(path)) {
    throw new Error("Attachment file no longer exists.");
  }
  return path;
}

/**
 * Read a small text/Markdown file as UTF-8. Returns `null` when the path is
 * missing, not a regular file, or larger than `maxBytes`.
 */
export async function readAssetText(
  path: string,
  maxBytes = MAX_TEXT_PREVIEW_BYTES,
): Promise<string | null> {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.size > maxBytes) return null;
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read a binary file for inline preview. Returns `null` when the path is
 * missing, not a regular file, or larger than `maxBytes`.
 */
export async function readAssetBytes(
  path: string,
  maxBytes = MAX_PREVIEW_BYTES,
): Promise<Uint8Array | null> {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.size > maxBytes) return null;
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * Copy an asset to a user-chosen location. Returns the destination path, or
 * `null` when the save dialog is cancelled.
 */
export async function saveAssetAs(
  sourcePath: string,
  suggestedName: string,
): Promise<string | null> {
  const dest = await showSaveDialog({ defaultPath: suggestedName });
  if (!dest) return null;
  await copyFile(sourcePath, dest);
  return dest;
}

/**
 * Zip several assets into a user-chosen location. Non-existent / non-file
 * paths are skipped; when none remain the dialog never opens and `null` is
 * returned. Duplicate basenames are disambiguated with a `1_`, `2_`… prefix.
 */
export async function exportAssetsZip(paths: string[]): Promise<string | null> {
  const files = paths.filter((path) => {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat !== undefined && stat.isFile();
  });
  if (files.length === 0) return null;

  const dest = await showSaveDialog({
    defaultPath: "assets.zip",
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (!dest) return null;

  return new Promise<string>((resolve, reject) => {
    const output = createWriteStream(dest);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve(dest));
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);

    const used = new Set<string>();
    for (const path of files) {
      archive.file(path, { name: uniqueArchiveName(basename(path), used) });
    }
    void archive.finalize();
  });
}

/** Open an asset with the OS default application. */
export async function openAsset(path: string): Promise<void> {
  await shell.openPath(path);
}

/** Move an asset's file to the OS trash. */
export async function trashAsset(path: string): Promise<void> {
  await shell.trashItem(path);
}

/** Reveal an asset's file in the OS file manager. */
export function revealAsset(path: string): void {
  shell.showItemInFolder(path);
}

/** Deduplicate a basename within one archive with a `1_`, `2_`… prefix. */
function uniqueArchiveName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let counter = 1;
  let candidate = `${counter}_${name}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${counter}_${name}`;
  }
  used.add(candidate);
  return candidate;
}
