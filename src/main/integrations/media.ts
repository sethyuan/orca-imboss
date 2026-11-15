import { mkdir, rm, writeFile } from "fs/promises";
import { basename, extname, join } from "path";
import { INTEGRATION_PLATFORMS } from "@shared/constants/integrations";
import { MAX_ATTACHMENT_BYTES } from "@shared/constants/attachments";
import type { IntegrationPlatform, MessageAttachment } from "@shared/types";
import { getIntegrationsMediaDir } from "../data-dir";
import type { InboundMedia } from "./types";

/**
 * Inbound platform media storage: `<dataRoot>/integrations/media/<platform>/
 * <chatId>/<file>`. Files are downloaded lazily (after the sender passes the
 * owner check) and removed when the owning chat is deleted.
 */

/** Sanitize an untrusted filename (no path separators / traversal). */
export function safeFileName(name: string): string {
  const base = basename(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  const trimmed = base.trim();
  if (trimmed.length === 0 || trimmed === "." || trimmed === "..") {
    return "file";
  }
  return trimmed.slice(0, 200);
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  csv: "text/csv",
  md: "text/markdown",
  html: "text/html",
  txt: "text/plain",
  zip: "application/zip",
  gz: "application/gzip",
  json: "application/json",
};

/** Best-effort MIME type from a filename extension. */
export function mimeByFileName(name: string): string {
  const ext = extname(name).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Directory holding one chat's downloaded media. */
export function chatMediaDir(
  platform: IntegrationPlatform,
  chatId: number,
): string {
  return join(getIntegrationsMediaDir(), platform, String(chatId));
}

/**
 * Largest inbound file we keep: the DB rejects a bigger attachment row, which
 * would drop the whole message (text included), so oversized platform files are
 * skipped instead.
 */
const MAX_INBOUND_FILE_BYTES = MAX_ATTACHMENT_BYTES;

/** Platform CDN downloads are bounded: a hung request must not stall a session. */
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;

/**
 * Download an untrusted platform media URL into `targetDir`, bounded in time and
 * size. Returns null (never throws) when the file is unavailable, too large, or
 * the transfer fails, so one bad attachment cannot lose the message text.
 */
export async function downloadInboundFile(
  url: string,
  targetDir: string,
  fileName: string,
): Promise<{ path: string; size: number } | null> {
  const name = safeFileName(fileName);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(
      `[integrations] media download failed (${name}):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
  if (!response.ok || !response.body) {
    console.warn(
      `[integrations] media download rejected (${name}): HTTP ${response.status}`,
    );
    return null;
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_INBOUND_FILE_BYTES) {
    console.warn(
      `[integrations] media skipped (${name}): ${declared} bytes exceeds ${MAX_INBOUND_FILE_BYTES}`,
    );
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      size += value.byteLength;
      // The declared length can lie (or be absent): cap the bytes we keep.
      if (size > MAX_INBOUND_FILE_BYTES) {
        console.warn(
          `[integrations] media skipped (${name}): exceeds ${MAX_INBOUND_FILE_BYTES} bytes`,
        );
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    console.warn(
      `[integrations] media download aborted (${name}):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return null;
  const target = join(targetDir, name);
  await writeFile(target, Buffer.concat(chunks, size));
  return { path: target, size };
}

/** Download and attach all inbound media; failures degrade to no attachment. */
export async function saveInboundMedia(
  platform: IntegrationPlatform,
  chatId: number,
  media: InboundMedia[],
): Promise<MessageAttachment[]> {
  if (media.length === 0) return [];
  const dir = chatMediaDir(platform, chatId);
  await mkdir(dir, { recursive: true });
  const attachments: MessageAttachment[] = [];
  for (const item of media) {
    try {
      const saved = await item.save(dir);
      if (!saved) continue;
      attachments.push({
        name: item.fileName,
        size: saved.size,
        type: item.mime,
        path: saved.path,
      });
    } catch (err) {
      console.error(
        "[integrations] failed to download inbound media:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return attachments;
}

/**
 * Delete every platform's media directory for a chat. Called from `chats:delete`
 * (the platform subdir is unknown there, so all are attempted).
 */
export async function deleteMediaForChat(chatId: number): Promise<void> {
  const root = getIntegrationsMediaDir();
  await Promise.all(
    INTEGRATION_PLATFORMS.map((platform) =>
      rm(join(root, platform, String(chatId)), {
        recursive: true,
        force: true,
      }).catch(() => undefined),
    ),
  );
}
