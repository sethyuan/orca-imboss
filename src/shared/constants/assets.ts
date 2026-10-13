import type { AssetCategory } from "@shared/types/assets";

/** Categories in display order, used by the library's type filter. */
export const ASSET_CATEGORIES: readonly AssetCategory[] = [
  "image",
  "document",
  "sheet",
  "archive",
  "media",
  "other",
];

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
  "avif",
  "heic",
  "heif",
  "tif",
  "tiff",
]);

const SHEET_EXTS = new Set([
  "csv",
  "tsv",
  "xls",
  "xlsx",
  "xlsm",
  "ods",
  "numbers",
]);

const ARCHIVE_EXTS = new Set([
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "rar",
  "7z",
  "zst",
]);

const MEDIA_EXTS = new Set([
  "mp3",
  "wav",
  "ogg",
  "oga",
  "m4a",
  "aac",
  "flac",
  "opus",
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mkv",
  "avi",
  "wmv",
]);

const DOCUMENT_EXTS = new Set([
  "pdf",
  "doc",
  "docx",
  "odt",
  "rtf",
  "txt",
  "md",
  "markdown",
  "log",
  "ppt",
  "pptx",
  "odp",
  "key",
  "pages",
  "epub",
  "json",
  "xml",
  "yaml",
  "yml",
  "html",
  "htm",
  "tex",
]);

/** Lowercased extension (without the dot) of a filename, or "". */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Classify an attachment into a broad category. Prefers the MIME type (which
 * the producers store) and falls back to the file extension; anything
 * unrecognised is `other`.
 */
export function assetCategoryOf(name: string, mime: string): AssetCategory {
  const type = (mime || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/") || type.startsWith("audio/")) return "media";
  if (type === "application/pdf") return "document";
  if (
    type.includes("spreadsheet") ||
    type.includes("excel") ||
    type.includes("csv")
  ) {
    return "sheet";
  }
  if (
    type.includes("zip") ||
    type.includes("compressed") ||
    type.includes("gzip") ||
    type.includes("tar") ||
    type.includes("x-7z") ||
    type.includes("rar")
  ) {
    return "archive";
  }
  if (type.startsWith("text/")) return "document";

  const ext = extensionOf(name);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (SHEET_EXTS.has(ext)) return "sheet";
  if (ARCHIVE_EXTS.has(ext)) return "archive";
  if (MEDIA_EXTS.has(ext)) return "media";
  if (DOCUMENT_EXTS.has(ext)) return "document";
  return "other";
}
