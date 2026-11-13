/**
 * Baking an annotated copy of a picture: the one place the marks become **pixels**.
 *
 * Why the renderer does this and not main: drawing text and circles needs a 2D
 * canvas, which the main process does not have. Why it needs IPC at all: `imb-file:`
 * deliberately withholds the pixels from the renderer (`<img>` may show a picture, a
 * canvas may not read it — see `src/main/imb-file-protocol.ts`), so the bytes arrive
 * through `files:readImageBytes`.
 *
 * The rules, all of them from the approved plan (`.pi/facts/image-annotation.md`
 * §3.6 / §3.4):
 * - **start from the original file, every time** — geometry lives in the annotation,
 *   the mark is replayed, so annotating a draft picture twice never stacks badges;
 * - downscale to a ≤2000px long edge *before* drawing, or the model's own profile
 *   shrinks the mark into a 1px line;
 * - one shared geometry function with the screen (`markGeometry`), so what the boss
 *   saw and what the model gets are the same proportions;
 * - PNG, because the badge is a digit: JPEG artifacts around white-on-red text are
 *   exactly the pixels the model has to read.
 */
import {
  BADGE_MIN_BAKE_PX,
  BAKE_MAX_LONG_EDGE,
  MARK_INK,
  REGION_FILL_OPACITY,
} from "@shared/constants/image-annotation";
import type { ImageMark, MessageAttachment } from "@shared/types";
import { markGeometry } from "./components/modules/chat/image-annotation/geometry";

/** One mark to burn in, with the ordinal the model will be told to answer. */
export interface BakeMark {
  mark: ImageMark;
  ordinal: number;
}

/** Where the pixels come from. */
export interface BakeSource {
  /** On-disk path, when the attachment has one (preferred: it is the original). */
  path?: string;
  /** Fallback URL (`blob:` for a draft chip's preview). */
  url?: string;
}

export interface BakeInput {
  source: BakeSource;
  marks: readonly BakeMark[];
  /** Chat the derived file belongs to (it is written under that attachments dir). */
  chatId: number;
  /** Suggested file name; main sanitizes it and prefixes nothing on its own. */
  fileName: string;
}

/** The derived attachment plus the pixel size the marks were drawn at. */
export interface BakeResult {
  attachment: MessageAttachment;
  width: number;
  height: number;
}

/**
 * Decode a `data:` URL into a blob.
 *
 * Deliberately not `fetch(dataUrl)`: the page's CSP has no `connect-src` for
 * `data:` (it is `default-src 'self'`), so fetching one is refused — which is the
 * kind of gap only a live run finds. Decoding base64 by hand has no such rule.
 */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("The picture could not be read.");
  const header = dataUrl.slice(0, comma);
  const mime = /^data:([^;]+)/.exec(header)?.[1] ?? "application/octet-stream";
  const base64 = dataUrl.slice(comma + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    bytes[at] = binary.charCodeAt(at);
  }
  return new Blob([bytes], { type: mime });
}

/** Read the picture the marks apply to. */
async function loadBitmap(source: BakeSource): Promise<ImageBitmap> {
  if (source.path !== undefined && source.path.length > 0) {
    const { dataUrl } = await imb.files.readImageBytes(source.path);
    return createImageBitmap(dataUrlToBlob(dataUrl));
  }
  if (source.url === undefined) {
    throw new Error("The picture has no readable source.");
  }
  if (source.url.startsWith("data:")) {
    return createImageBitmap(dataUrlToBlob(source.url));
  }
  // A `blob:` URL (a draft chip's preview) is same-origin and fetchable.
  const response = await fetch(source.url);
  if (!response.ok) throw new Error("The picture could not be read.");
  return createImageBitmap(await response.blob());
}

/** Scale factor that fits the picture into the bake's long-edge budget. */
function bakeScale(width: number, height: number): number {
  const longEdge = Math.max(width, height);
  return longEdge > BAKE_MAX_LONG_EDGE ? BAKE_MAX_LONG_EDGE / longEdge : 1;
}

/** Rounded-rectangle path helper (older canvas builds have no `roundRect`). */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(left + r, top);
  ctx.lineTo(left + width - r, top);
  ctx.arcTo(left + width, top, left + width, top + r, r);
  ctx.lineTo(left + width, top + height - r);
  ctx.arcTo(left + width, top + height, left + width - r, top + height, r);
  ctx.lineTo(left + r, top + height);
  ctx.arcTo(left, top + height, left, top + height - r, r);
  ctx.lineTo(left, top + r);
  ctx.arcTo(left, top, left + r, top, r);
  ctx.closePath();
}

/** The badge: red disc, white ring, white digit — pressed onto the target. */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  centreX: number,
  centreY: number,
  geometry: ReturnType<typeof markGeometry>,
  ordinal: number,
): void {
  const radius = geometry.badge / 2;
  ctx.beginPath();
  ctx.arc(centreX, centreY, radius, 0, Math.PI * 2);
  ctx.fillStyle = MARK_INK;
  ctx.fill();
  ctx.lineWidth = geometry.badgeRing;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  // A sub-digit badge (a very small area) is a solid dot: a 2px glyph is noise.
  if (ordinal <= 0 || !geometry.showNumber) return;
  ctx.fillStyle = "#ffffff";
  ctx.font = `600 ${geometry.font.toFixed(1)}px -apple-system, "PingFang SC", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(ordinal), centreX, centreY);
}

/** Burn every mark into the context, sized for a picture of `size`. */
function drawMarks(
  ctx: CanvasRenderingContext2D,
  marks: readonly BakeMark[],
  size: { width: number; height: number },
): void {
  ctx.save();
  for (const entry of marks) {
    if (entry.mark.kind === "image") continue;
    const geometry = markGeometry(entry.mark, size, BADGE_MIN_BAKE_PX);
    ctx.strokeStyle = MARK_INK;
    ctx.lineWidth = geometry.stroke;
    if (entry.mark.kind === "region") {
      // The region is dimmed, not covered: the pixels being judged must stay
      // readable under the fill (a solid overlay hides exactly what the note is
      // about). Alpha, not `color-mix`: that is a CSS value, not a canvas one.
      ctx.fillStyle = `rgba(201, 58, 58, ${REGION_FILL_OPACITY})`;
      roundedRect(
        ctx,
        geometry.originX,
        geometry.originY,
        geometry.width,
        geometry.height,
        geometry.radius,
      );
      ctx.fill();
      ctx.stroke();
    } else {
      // The thin ring marks the pixel itself; the badge's corner sits on it, so the
      // mark points at the target instead of the neighbouring element (fact §2.5).
      ctx.beginPath();
      ctx.arc(
        geometry.originX,
        geometry.originY,
        geometry.pointRadius,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
    drawBadge(
      ctx,
      geometry.badgeBox.left + geometry.badgeBox.width / 2,
      geometry.badgeBox.top + geometry.badgeBox.height / 2,
      geometry,
      entry.ordinal,
    );
  }
  ctx.restore();
}

/**
 * Render the marked copy and store it as an attachment.
 *
 * Throws when the picture cannot be read or written; the caller's rule is that a
 * failed bake never blocks a send (the original goes out and the coordinates still
 * travel in the `[Comments]` block).
 */
export async function bakeAnnotatedCopy(input: BakeInput): Promise<BakeResult> {
  if (input.marks.length === 0) {
    throw new Error("Nothing to bake.");
  }
  const bitmap = await loadBitmap(input.source);
  try {
    const scale = bakeScale(bitmap.width, bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("The picture could not be prepared.");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    drawMarks(ctx, input.marks, { width, height });
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), "image/png");
    });
    if (blob === null) throw new Error("The picture could not be written.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const attachment = await imb.files.savePastedFile(
      input.chatId,
      input.fileName,
      "image/png",
      bytes,
    );
    return { attachment, width, height };
  } finally {
    bitmap.close();
  }
}

/** `shot.png` → `annotated-shot.png` (main resolves collisions and the extension). */
export function annotatedFileName(name: string): string {
  const base = name.replace(/^annotated-/, "");
  return `annotated-${base}`;
}
