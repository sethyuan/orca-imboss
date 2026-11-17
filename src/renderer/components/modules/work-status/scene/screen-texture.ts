import { CanvasTexture, SRGBColorSpace, type Texture } from "three";
import { t } from "@shared/l10n";
import type { WorkRoom, WorkRoomStep } from "@shared/types";

/**
 * The progress screens of the *grid*: one small canvas per room, painted like the
 * card the boss sees in the thread (title, one row per step with name, task and
 * status), then used as the screen's texture.
 *
 * Why a texture here and real DOM only for the focused room: a CSS3D element is
 * painted above the whole WebGL canvas, so putting one on every room means a far
 * room's card would cover the furniture of the near room in front of it. The boss
 * explicitly allowed the grid's progress display to not be real DOM, as long as it
 * *looks* like the card — so the grid gets a texture and the focused room keeps
 * the crisp, clickable DOM card.
 *
 * Cost control: one 512×288 canvas per room (≈0.6 MB of texture memory each, so
 * ~14 MB for a full 24-room board), redrawn **only when that room's card or the
 * theme changes** (see the signature).
 */

/** Texture resolution. A grid room's screen is ~80–300 px wide on screen. */
const TEXTURE_WIDTH = 512;
const TEXTURE_HEIGHT = 288;

/** Steps drawn on a grid screen; the rest collapse into a "+N" row. */
const MAX_PAINTED_STEPS = 6;

interface CanvasPalette {
  card: string;
  ink: string;
  inkMuted: string;
  line: string;
  done: string;
  busy: string;
  pending: string;
  accent: string;
}

/** The app's own token values, in the two themes the scene supports. */
const PALETTES: Record<"light" | "dark", CanvasPalette> = {
  light: {
    card: "#f7f7f7",
    ink: "#1a1a1a",
    inkMuted: "#888888",
    line: "#e0e0e0",
    done: "#07c160",
    busy: "#fab702",
    pending: "#b8b8b8",
    accent: "#07c160",
  },
  dark: {
    card: "#2c2c2c",
    ink: "#f7f7f7",
    inkMuted: "#999999",
    line: "#3a3a3a",
    done: "#4ecb71",
    busy: "#fab702",
    pending: "#6f6f6f",
    accent: "#4ecb71",
  },
};

const STATUS_LABEL: Record<WorkRoomStep["status"], string> = {
  done: "Done",
  busy: "In progress",
  pending: "Pending",
};

function statusColor(
  status: WorkRoomStep["status"],
  palette: CanvasPalette,
): string {
  if (status === "done") return palette.done;
  if (status === "busy") return palette.busy;
  return palette.pending;
}

function ellipsize(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number,
): string {
  if (context.measureText(value).width <= maxWidth) return value;
  let text = value;
  while (text.length > 1) {
    text = text.slice(0, -1);
    if (context.measureText(`${text}…`).width <= maxWidth) {
      return `${text}…`;
    }
  }
  return "…";
}

function paintCard(
  context: CanvasRenderingContext2D,
  room: WorkRoom,
  palette: CanvasPalette,
): void {
  const width = TEXTURE_WIDTH;
  const height = TEXTURE_HEIGHT;
  const padding = 26;

  context.clearRect(0, 0, width, height);
  context.fillStyle = palette.card;
  context.fillRect(0, 0, width, height);

  // The card's own surface, inset from the screen's edge (the same inset the DOM
  // card has inside its frame).
  const inset = 14;
  context.fillStyle = palette.card;
  context.strokeStyle = palette.line;
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(inset, inset, width - inset * 2, height - inset * 2, 14);
  context.stroke();

  const left = inset + padding * 0.5;
  const contentWidth = width - left * 2;

  if (room.progress === null) {
    context.fillStyle = palette.ink;
    context.font = "600 26px system-ui, -apple-system, sans-serif";
    context.textBaseline = "top";
    context.fillText(
      ellipsize(context, room.title, contentWidth),
      left,
      height / 2 - 34,
    );
    context.fillStyle = palette.inkMuted;
    context.font = "400 20px system-ui, -apple-system, sans-serif";
    context.fillText(t("No progress yet"), left, height / 2 + 2);
    return;
  }

  // Title row.
  context.fillStyle = palette.inkMuted;
  context.font = "500 20px system-ui, -apple-system, sans-serif";
  context.textBaseline = "top";
  context.fillText(
    ellipsize(context, room.progress.title, contentWidth),
    left,
    inset + 26,
  );

  // Accent rule under the title (the card's identity, same role as the wall bar).
  context.fillStyle = palette.accent;
  context.fillRect(left, inset + 58, 64, 4);

  // Step rows.
  const steps = room.progress.steps.slice(0, MAX_PAINTED_STEPS);
  const rowTop = inset + 84;
  const rowHeight = 30;
  for (const [index, step] of steps.entries()) {
    const y = rowTop + index * rowHeight;
    if (y + rowHeight > height - inset - 12) break;

    // Status dot, then the employee's name in ink, the task in muted ink.
    context.fillStyle = statusColor(step.status, palette);
    context.beginPath();
    context.arc(left + 6, y + 9, 5, 0, Math.PI * 2);
    context.fill();

    context.font = "600 17px system-ui, -apple-system, sans-serif";
    context.fillStyle = palette.ink;
    const name = step.name;
    context.fillText(
      ellipsize(context, name, contentWidth * 0.34),
      left + 20,
      y,
    );
    const nameWidth = Math.min(
      contentWidth * 0.34,
      context.measureText(name).width + 10,
    );

    context.font = "400 17px system-ui, -apple-system, sans-serif";
    context.fillStyle = palette.inkMuted;
    const taskWidth = contentWidth - nameWidth - 120;
    context.fillText(
      `· ${ellipsize(context, step.task, taskWidth)}`,
      left + 20 + nameWidth,
      y,
    );

    const label = t(STATUS_LABEL[step.status] ?? step.status);
    context.font = "500 15px system-ui, -apple-system, sans-serif";
    context.fillStyle = palette.inkMuted;
    context.textAlign = "right";
    context.fillText(label, left + contentWidth - 14, y + 1);
    context.textAlign = "left";
  }

  if (room.progress.steps.length > steps.length) {
    context.fillStyle = palette.inkMuted;
    context.font = "400 15px system-ui, -apple-system, sans-serif";
    context.fillText(
      `+${room.progress.steps.length - steps.length}`,
      left + 20,
      rowTop + steps.length * rowHeight + 2,
    );
  }
}

/** What the paint depends on: any change here means the texture must be redrawn. */
function signatureOf(room: WorkRoom, dark: boolean): string {
  const steps = room.progress?.steps ?? [];
  return [
    room.chatId,
    dark ? "dark" : "light",
    room.title,
    room.progress?.messageId ?? "none",
    room.progress?.title ?? "",
    steps.map((step) => `${step.name}:${step.task}:${step.status}`).join("|"),
  ].join("\u0000");
}

interface CachedScreen {
  texture: CanvasTexture;
  signature: string;
}

export class ScreenTextureCache {
  private readonly cache = new Map<number, CachedScreen>();

  /**
   * The screen texture for `room`, repainted only when its content or the theme
   * changed. The caller owns the room's material and just swaps `map`.
   */
  get(room: WorkRoom, dark: boolean): Texture {
    const signature = signatureOf(room, dark);
    const existing = this.cache.get(room.chatId);
    if (existing !== undefined && existing.signature === signature) {
      return existing.texture;
    }

    const canvas = existing?.texture.image as HTMLCanvasElement | undefined;
    const target =
      canvas instanceof HTMLCanvasElement
        ? canvas
        : Object.assign(document.createElement("canvas"), {
            width: TEXTURE_WIDTH,
            height: TEXTURE_HEIGHT,
          });
    const context = target.getContext("2d");
    if (context !== null) {
      paintCard(context, room, PALETTES[dark ? "dark" : "light"]);
    }

    if (existing !== undefined) {
      existing.texture.needsUpdate = true;
      existing.signature = signature;
      return existing.texture;
    }

    const texture = new CanvasTexture(target);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 4;
    this.cache.set(room.chatId, { texture, signature });
    return texture;
  }

  /** Drop a room's texture (its room left the board). */
  release(chatId: number): void {
    const cached = this.cache.get(chatId);
    if (cached === undefined) return;
    cached.texture.dispose();
    this.cache.delete(chatId);
  }

  dispose(): void {
    for (const cached of this.cache.values()) cached.texture.dispose();
    this.cache.clear();
  }
}
