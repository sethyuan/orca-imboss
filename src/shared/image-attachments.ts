/**
 * Image-attachment helpers shared by the renderer (which decides whether to
 * preview an attachment as an image) and the main process (which gates the
 * `imb-file:` protocol handler by extension). Keeping the whitelist in one place
 * stops the two sides from drifting: an attachment the renderer previews must be
 * one main is willing to serve.
 *
 * Only raster formats are previewable. SVG is deliberately excluded even though
 * it is `image/*`, because an SVG can carry script/markup we do not want to
 * hand to the renderer.
 */

/** Extension → canonical MIME for the raster formats we inline-preview. */
const EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
};

/** Declared MIME types we accept for an inline preview. */
const MIME_WHITELIST = new Set(Object.values(EXT_TO_MIME));

/**
 * Canonical MIME for an attachment we can inline-preview, or `null` when it is
 * not a previewable image. Prefers the declared MIME when it is on the
 * whitelist, otherwise falls back to the file extension.
 */
export function previewImageMime(type: string, name: string): string | null {
  const declared = (type ?? "").trim().toLowerCase();
  if (MIME_WHITELIST.has(declared)) return declared;
  const ext = /\.([a-z0-9]+)$/i.exec(name ?? "")?.[1]?.toLowerCase();
  return ext ? (EXT_TO_MIME[ext] ?? null) : null;
}

/** True when an attachment should be rendered as an image preview. */
export function isPreviewableImage(type: string, name: string): boolean {
  return previewImageMime(type, name) !== null;
}

/**
 * True when a file extension (without the dot, any case) is one this app is
 * willing to serve as an image. Shared by the `imb-file:` handler, which only
 * ever has the path (no declared MIME).
 */
export function isPreviewableImageExtension(ext: string): boolean {
  return EXT_TO_MIME[ext.trim().toLowerCase()] !== undefined;
}

/**
 * MIME type for a served image path, or `application/octet-stream` when the
 * extension is unknown. Used by the remote `imb-file:` handler, which streams
 * bytes and therefore has to declare a content type.
 */
export function imageMimeForPath(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return (ext !== undefined && EXT_TO_MIME[ext]) || "application/octet-stream";
}

/** True when a path's extension is a previewable image format. */
export function isPreviewableImagePath(path: string): boolean {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1];
  return ext !== undefined && isPreviewableImageExtension(ext);
}
