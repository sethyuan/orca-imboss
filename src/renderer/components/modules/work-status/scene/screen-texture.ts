import { CanvasTexture, SRGBColorSpace, type Texture } from "three";
import { t } from "@shared/l10n";
import type { WorkRoom, WorkRoomStep } from "@shared/types";
import { LAYOUT } from "./art";

/**
 * The wall screen is a **texture on the screen mesh**, not DOM.
 *
 * Why: anything painted in the DOM sits above the whole WebGL canvas, so a card would
 * cover whatever stands in front of the screen (the orchestrator's head, when the camera
 * turned). A screen is embedded in the wall — the things in front of it must occlude it —
 * so the card has to be part of the 3D scene. One painter serves two resolutions: the
 * grid's small screens and the focused room's big one.
 */
export type ScreenResolution = "grid" | "focus";

/**
 * The progress screens: one canvas per room, painted like the card the boss sees in the
 * thread (title, one row per step with name, task and status), then used as the screen's
 * texture. The focused room gets a bigger canvas of the same painter — every room on the
 * board, focused or not, is painted this way.
 *
 * Cost control: one canvas per room (≈0.3 MB of texture memory at the grid resolution, so
 * ~4 MB for a full 12-room board and one more for the focused room), redrawn **only when
 * that room's card or the theme changes** (see the signature).
 */

/**
 * Texture resolutions. The canvas matches the wall screen's own aspect
 * (`LAYOUT.screen`), so the card is not stretched when it is painted onto it.
 *
 * - `grid`: a room on the board is ~80–300 px wide on screen; 640 px is plenty.
 * - `focus`: the same wall fills ~500 CSS px (~1000 device px at 2×), so 1280 px keeps
 *   the focused card's text crisp.
 */
const RESOLUTIONS: Record<ScreenResolution, number> = {
  grid: 640,
  focus: 1280,
};

/**
 * Rows the screen shows at most. The boss asked for "title + the last eight rows";
 * eight rows fit at this type size, and anything beyond is truncated — no scrollbar,
 * and never a half-drawn row (the "+N" line gets its own slot).
 */
const MAX_PAINTED_STEPS = 8;

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
  width: number,
  height: number,
): void {
  // The screen's own surface: no card, no border, no rounded corners — the boss
  // wanted the card to *be* the screen. Everything is laid out from the top-left.
  const unit = width / 430;
  const padding = Math.round(18 * unit);
  const left = padding;
  const contentWidth = width - padding * 2;

  context.clearRect(0, 0, width, height);
  context.fillStyle = palette.card;
  context.fillRect(0, 0, width, height);
  context.textBaseline = "top";
  context.textAlign = "left";

  if (room.progress === null) {
    context.fillStyle = palette.ink;
    context.font = `600 ${Math.round(20 * unit)}px system-ui, -apple-system, sans-serif`;
    context.fillText(
      ellipsize(context, room.title, contentWidth),
      left,
      Math.round(height / 2 - 24 * unit),
    );
    context.fillStyle = palette.inkMuted;
    context.font = `400 ${Math.round(16 * unit)}px system-ui, -apple-system, sans-serif`;
    context.fillText(
      t("No progress yet"),
      left,
      Math.round(height / 2 + 4 * unit),
    );
    return;
  }

  // Title.
  const titleTop = Math.round(14 * unit);
  context.fillStyle = palette.inkMuted;
  context.font = `500 ${Math.round(15 * unit)}px system-ui, -apple-system, sans-serif`;
  context.fillText(
    ellipsize(context, room.progress.title, contentWidth),
    left,
    titleTop,
  );

  // Hairline under the title: the card's only rule (no frame, no radius).
  const ruleY = titleTop + Math.round(24 * unit);
  context.fillStyle = palette.line;
  context.fillRect(left, ruleY, contentWidth, Math.max(1, Math.round(unit)));

  // Steps: **the newest ones**, and the row budget is measured, not assumed. A card
  // grows downwards, so "the bottom of the card" is the newest work — the boss asked
  // for exactly that, and showing the *oldest* rows would be the wrong end.
  const rowTop = ruleY + Math.round(8 * unit);
  const rowHeight = Math.round(14 * unit);
  const nameSize = Math.round(11.5 * unit);
  const taskSize = Math.round(11 * unit);
  const tagSize = Math.round(10 * unit);
  const bottom = height - Math.round(6 * unit);
  const allSteps = room.progress.steps;
  const rowsThatFit = Math.max(0, Math.floor((bottom - rowTop) / rowHeight));
  // When rows are left over, one of the slots has to be the "+N" line itself.
  const needsSummary = allSteps.length > rowsThatFit;
  const maxRows = needsSummary ? Math.max(0, rowsThatFit - 1) : rowsThatFit;
  const visible = Math.min(allSteps.length, MAX_PAINTED_STEPS, maxRows);
  const steps = allSteps.slice(-visible);

  for (const [index, step] of steps.entries()) {
    const y = rowTop + index * rowHeight;

    context.fillStyle = statusColor(step.status, palette);
    context.beginPath();
    context.arc(
      left + Math.round(4 * unit),
      y + Math.round(4.5 * unit),
      Math.round(3 * unit),
      0,
      Math.PI * 2,
    );
    context.fill();

    const nameLeft = left + Math.round(13 * unit);
    context.font = `600 ${nameSize}px system-ui, -apple-system, sans-serif`;
    context.fillStyle = palette.ink;
    const name = ellipsize(context, step.name, contentWidth * 0.26);
    context.fillText(name, nameLeft, y);
    const nameWidth = context.measureText(name).width + Math.round(6 * unit);

    const label = t(STATUS_LABEL[step.status] ?? step.status);
    context.font = `500 ${tagSize}px system-ui, -apple-system, sans-serif`;
    const tagWidth = context.measureText(label).width;

    // One continuous string per row: name · task • status. A right-aligned status
    // column lands several rows lower once the wall is seen at an angle.
    context.font = `400 ${taskSize}px system-ui, -apple-system, sans-serif`;
    context.fillStyle = palette.inkMuted;
    const task = ellipsize(
      context,
      `· ${step.task}`,
      Math.max(0, contentWidth - nameWidth - tagWidth - Math.round(24 * unit)),
    );
    context.fillText(task, nameLeft + nameWidth, y);
    const taskWidth = context.measureText(task).width + Math.round(8 * unit);

    context.font = `500 ${tagSize}px system-ui, -apple-system, sans-serif`;
    context.fillStyle = statusColor(step.status, palette);
    context.fillText(label, nameLeft + nameWidth + taskWidth, y);
  }

  const hidden = allSteps.length - steps.length;
  if (hidden > 0) {
    context.fillStyle = palette.inkMuted;
    context.font = `400 ${tagSize}px system-ui, -apple-system, sans-serif`;
    context.fillText(
      `+${hidden}`,
      left + Math.round(13 * unit),
      rowTop + steps.length * rowHeight,
    );
  }
}

/** What the paint depends on: any change here means the texture must be redrawn. */
function signatureOf(
  room: WorkRoom,
  dark: boolean,
  resolution: ScreenResolution,
): string {
  const steps = room.progress?.steps ?? [];
  return [
    room.chatId,
    resolution,
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
  resolution: ScreenResolution;
}

export class ScreenTextureCache {
  private readonly cache = new Map<string, CachedScreen>();

  /**
   * The screen texture for `room` at `resolution`, repainted only when its content,
   * the theme or the resolution changed. The caller owns the room's material and
   * just swaps `map`.
   */
  get(room: WorkRoom, dark: boolean, resolution: ScreenResolution): Texture {
    const key = `${room.chatId}:${resolution}`;
    const width = RESOLUTIONS[resolution];
    const height = Math.round(
      (width * LAYOUT.screen.height) / LAYOUT.screen.width,
    );
    const signature = signatureOf(room, dark, resolution);
    const existing = this.cache.get(key);
    if (existing !== undefined && existing.signature === signature) {
      return existing.texture;
    }

    const canvas =
      existing?.texture.image instanceof HTMLCanvasElement
        ? (existing.texture.image as HTMLCanvasElement)
        : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d");
    if (context !== null) {
      paintCard(
        context,
        room,
        PALETTES[dark ? "dark" : "light"],
        width,
        height,
      );
    }

    if (existing !== undefined) {
      existing.texture.needsUpdate = true;
      existing.signature = signature;
      return existing.texture;
    }

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 8;
    this.cache.set(key, { texture, signature, resolution });
    return texture;
  }

  /** Drop a room's textures (its room left the board). */
  release(chatId: number): void {
    for (const resolution of ["grid", "focus"] as const) {
      const key = `${chatId}:${resolution}`;
      const cached = this.cache.get(key);
      if (cached === undefined) continue;
      cached.texture.dispose();
      this.cache.delete(key);
    }
  }

  dispose(): void {
    for (const cached of this.cache.values()) cached.texture.dispose();
    this.cache.clear();
  }
}
