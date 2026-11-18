import { type Camera, Vector3 } from "three";

/**
 * The HTML layer that floats over the WebGL scene: employee bubbles, room name
 * plates and the hover card.
 *
 * Why DOM instead of textures: these are text. Text drawn into a canvas is either
 * blurry (small texture) or expensive (big texture per room), and it cannot be
 * styled by the design system, selected or clicked. A DOM layer positioned from
 * projected world coordinates keeps it crisp at any zoom and reuses the app's own
 * typography (and, for a bubble's body, the app's Markdown renderer).
 *
 * The HUD owns **positions**; React owns **content**. Each bubble and plate is an
 * empty host element the render loop moves, and React portals the real markup into
 * it (see `onTarget` callbacks) — so a bubble can be a Markdown block with a click
 * handler without React re-rendering at 60 Hz.
 */

export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

export interface HudBubble {
  /** Stable identity: one bubble per employee per room. */
  key: string;
  /** World position the bubble hangs from (above the employee's head). */
  anchor: Vector3;
  /** What the bubble shows — decided by the state machine, not by the snapshot. */
  kind: "working" | "message";
  content: string;
}

/** What React needs to render one bubble. */
export interface HudBubbleContent {
  kind: "working" | "message";
  content: string;
}

export interface HudRoomLabel {
  chatId: number;
  /** World position the plate hangs from (above the room's screen). */
  anchor: Vector3;
}

export interface HudHover {
  name: string;
  avatarUrl: string | null;
  anchor: Vector3;
}

const SCREEN = new Vector3();

/** Gap (CSS px) between the hover chip and the employee's head. */
const HOVER_GAP = 10;

/**
 * Where the hover chip goes: to the **left** of the employee, vertically centred
 * on them (above the head it collided with the message bubble). When the strip to
 * the left is narrower than the chip, it flips to the right side — the chip is
 * small but must never be clipped by the viewport edge.
 *
 * Pure math on purpose: the flip is the part that is hard to hit in a screenshot,
 * so it is tested directly.
 */
export function hoverChipPlacement(
  headX: number,
  chipWidth: number,
): { x: number; side: "left" | "right" } {
  const fitsLeft = headX - chipWidth - HOVER_GAP >= 0;
  return fitsLeft
    ? { x: headX - HOVER_GAP, side: "left" }
    : { x: headX + HOVER_GAP, side: "right" };
}

export class HudLayer {
  readonly root: HTMLDivElement;

  private readonly bubbleElements = new Map<string, HTMLDivElement>();
  private readonly bubbleContent = new Map<string, HudBubbleContent>();
  private readonly labelElements = new Map<number, HTMLDivElement>();
  private readonly hoverElement: HTMLDivElement;
  private readonly hoverAvatar: HTMLImageElement;
  private readonly hoverName: HTMLSpanElement;

  private bubbles: HudBubble[] = [];
  private labels: HudRoomLabel[] = [];
  private hover: HudHover | null = null;

  constructor(private readonly container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "imb-ws-hud";
    this.root.setAttribute("aria-hidden", "true");

    this.hoverElement = document.createElement("div");
    this.hoverElement.className = "imb-ws-hover";
    this.hoverAvatar = document.createElement("img");
    this.hoverAvatar.alt = "";
    this.hoverAvatar.className = "imb-ws-hover-avatar";
    this.hoverName = document.createElement("span");
    this.hoverName.className = "imb-ws-hover-name";
    this.hoverElement.append(this.hoverAvatar, this.hoverName);
    this.hoverElement.style.display = "none";
    this.root.appendChild(this.hoverElement);

    container.appendChild(this.root);
  }

  /**
   * Bubble hosts. `onTarget` hands each one to React together with the content it
   * must show (`null` when the bubble goes away), and is called again whenever the
   * content changes — the scene decides *what* a bubble says, so React never has
   * to guess it from a snapshot.
   */
  setBubbles(
    bubbles: HudBubble[],
    onTarget: (
      key: string,
      element: HTMLElement | null,
      content: HudBubbleContent | null,
    ) => void,
  ): void {
    this.bubbles = bubbles;
    const seen = new Set<string>();
    for (const bubble of bubbles) {
      seen.add(bubble.key);
      const content = { kind: bubble.kind, content: bubble.content };
      const existingElement = this.bubbleElements.get(bubble.key);
      if (existingElement === undefined) {
        const element = document.createElement("div");
        element.className = "imb-ws-bubble-anchor";
        this.root.appendChild(element);
        this.bubbleElements.set(bubble.key, element);
        onTarget(bubble.key, element, content);
        continue;
      }
      const previous = this.bubbleContent.get(bubble.key);
      if (
        previous === undefined ||
        previous.kind !== content.kind ||
        previous.content !== content.content
      ) {
        onTarget(bubble.key, existingElement, content);
      }
    }
    for (const [key, element] of this.bubbleElements) {
      if (seen.has(key)) continue;
      element.remove();
      this.bubbleElements.delete(key);
      onTarget(key, null, null);
    }
    for (const bubble of bubbles)
      this.bubbleContent.set(bubble.key, {
        kind: bubble.kind,
        content: bubble.content,
      });
    for (const key of this.bubbleContent.keys())
      if (!seen.has(key)) this.bubbleContent.delete(key);
  }

  /**
   * Name plates: the HUD owns their *position* (they follow a 3D anchor), React
   * owns their *content* — a plate is a real `Tooltip` trigger, and a tooltip
   * cannot be built out of imperatively written text.
   */
  setRoomLabels(
    labels: HudRoomLabel[],
    onTarget: (chatId: number, element: HTMLElement | null) => void,
  ): void {
    this.labels = labels;
    const seen = new Set<number>();
    for (const label of labels) {
      seen.add(label.chatId);
      if (this.labelElements.has(label.chatId)) continue;
      const element = document.createElement("div");
      element.className = "imb-ws-roomlabel-anchor";
      this.root.appendChild(element);
      this.labelElements.set(label.chatId, element);
      onTarget(label.chatId, element);
    }
    for (const [chatId, element] of this.labelElements) {
      if (seen.has(chatId)) continue;
      element.remove();
      this.labelElements.delete(chatId);
      onTarget(chatId, null);
    }
  }

  setHover(hover: HudHover | null): void {
    this.hover = hover;
    if (hover === null) {
      this.hoverElement.style.display = "none";
      return;
    }
    this.hoverElement.style.display = "";
    if (this.hoverName.textContent !== hover.name) {
      this.hoverName.textContent = hover.name;
    }
    if (hover.avatarUrl === null) {
      this.hoverAvatar.style.display = "none";
    } else {
      this.hoverAvatar.style.display = "";
      if (this.hoverAvatar.getAttribute("src") !== hover.avatarUrl) {
        this.hoverAvatar.setAttribute("src", hover.avatarUrl);
      }
    }
  }

  /** Re-place everything for the current camera. Called once per rendered frame. */
  update(camera: Camera): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width <= 0 || height <= 0) return;

    for (const bubble of this.bubbles) {
      const element = this.bubbleElements.get(bubble.key);
      if (!element) continue;
      const point = this.project(camera, bubble.anchor, width, height);
      if (!point.visible) {
        element.style.display = "none";
        continue;
      }
      element.style.display = "";
      // The bubble hangs from the anchor (just above the head) and keeps its tail
      // on it: the anchor is in screen space, so the tail always points at the
      // employee whatever the camera does.
      element.style.transform = `translate(-50%, calc(-100% - 10px)) translate(${point.x}px, ${point.y}px)`;
    }

    for (const label of this.labels) {
      const element = this.labelElements.get(label.chatId);
      if (!element) continue;
      const point = this.project(camera, label.anchor, width, height);
      if (!point.visible) {
        element.style.display = "none";
        continue;
      }
      element.style.display = "";
      element.style.transform = `translate(-50%, -50%) translate(${point.x}px, ${point.y}px)`;
    }

    if (this.hover !== null) {
      const point = this.project(camera, this.hover.anchor, width, height);
      this.hoverElement.style.display = point.visible ? "" : "none";
      if (point.visible) {
        // To the employee's **left**, vertically centred on the person: above the
        // head it collided with the message bubble. When that would push the chip
        // off the left edge it flips to the right side instead of being clipped.
        const chipWidth = this.hoverElement.offsetWidth || 96;
        const placement = hoverChipPlacement(point.x, chipWidth);
        // The card's **top edge** sits on the anchor (the top of the head), not its
        // centre: vertically centred it floated above the person.
        const transform =
          placement.side === "left"
            ? `translate(-100%, 0) translate(${placement.x}px, ${point.y}px)`
            : `translate(0, 0) translate(${placement.x}px, ${point.y}px)`;
        if (this.hoverElement.style.transform !== transform) {
          this.hoverElement.style.transform = transform;
        }
      }
    }
  }

  dispose(): void {
    this.root.remove();
    this.bubbleElements.clear();
    this.bubbleContent.clear();
    this.labelElements.clear();
    this.bubbles = [];
    this.labels = [];
    this.hover = null;
  }

  private project(
    camera: Camera,
    world: Vector3,
    width: number,
    height: number,
  ): ScreenPoint {
    SCREEN.copy(world).project(camera);
    return {
      x: (SCREEN.x * 0.5 + 0.5) * width,
      // Behind the camera projects to mirrored coordinates instead of nothing.
      visible: SCREEN.z < 1 && SCREEN.z > -1,
      y: (-SCREEN.y * 0.5 + 0.5) * height,
    };
  }
}
