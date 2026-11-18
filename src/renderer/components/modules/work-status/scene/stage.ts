import { t } from "@shared/l10n";
import type { WorkRoom, WorkRoomsPayload } from "@shared/types";
import { employeeAvatarSrc } from "../../../employee-avatar/avatar-src";
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  NeutralToneMapping,
  PCFSoftShadowMap,
  Object3D,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import {
  CAMERA,
  GRID,
  LIGHT_POSITIONS,
  LIGHTING,
  ROOM,
  ROOM_FOOTPRINT,
  SHADOW,
  createSharedGeometry,
  setWoodAnisotropy,
  sharedGeometrySet,
} from "./art";
import { CameraRig } from "./camera";
import { HudLayer, type HudBubble, type HudRoomLabel } from "./hud";
import { buildRoom, roomSignature, type RoomHandle } from "./room";
import { ScreenTextureCache } from "./screen-texture";
import {
  bubbleOf,
  createView,
  restProgress,
  setBubble,
  setRunning,
  tick,
  viewKey,
  type EmployeeView,
} from "../state-machine";

/**
 * The 3D stage: one WebGL canvas, one HTML HUD, and the rooms
 * of every in-progress task group.
 *
 * Deliberately imperative. React owns the module's chrome (header, name plates,
 * bubbles, fallback grid) and hands data in through a small API; the scene itself is a
 * render loop, because a 60 Hz re-render of a React tree would dwarf the cost of drawing
 * the rooms.
 *
 * What the boss asked for that shapes the code here:
 * - an isometric bird's-eye over a grid of rooms, left click flies into a room, Escape
 *   (or a click outside it) flies back; the wheel has no role, the boss disabled it;
 * - bubbles over heads (working / last message) plus rest animations, which must not be
 *   cut short (that rule lives in `state-machine.ts`);
 * - the progress card is painted **onto the wall screen** in both views, so the furniture
 *   in front of it occludes it;
 * - the board is static unless something changes: nothing is drawn while the module is
 *   not on screen, and a still bird's-eye view draws no frames at all.
 */

export interface StageCallbacks {
  /** The focused room changed; `null` = back to the bird's-eye grid. */
  onFocusChange(chatId: number | null): void;
  /**
   * A room's name plate host was created (`element`) or removed (`null`): React
   * renders the plate itself, so it can be a `Tooltip` trigger with the full
   * title.
   */
  onPlateTarget(chatId: number, element: HTMLElement | null): void;
  /**
   * An employee bubble's host was created (`element`) or removed (`null`): React
   * renders the bubble (Markdown body, click to expand).
   */
  onBubbleTarget(
    key: string,
    element: HTMLElement | null,
    content: { kind: "working" | "message"; content: string } | null,
  ): void;
  openRoom(chatId: number): void;
  openSession(chatId: number, employeeId: number): void;
  /** The GPU context is gone for good: the module must switch to its 2D board. */
  onContextLost(): void;
}

export interface WorkStatusStage {
  setRooms(payload: WorkRoomsPayload): void;
  /** Light/dark theme: rebuilds the rooms with the matching palette. */
  setTheme(dark: boolean): void;
  setActive(active: boolean): void;
  focusRoom(chatId: number): void;
  exitFocus(): void;
  dispose(): void;
}

/**
 * How long a bird's-eye frame may sleep for when the only thing that can change is a
 * bubble or a rest animation running out: the exact next expiry, so nothing has to
 * poll. Data changes wake it immediately (a snapshot, a message, a hover).
 */
const IDLE_EVENT_SLACK_MS = 30;

/**
 * How far above a room's own silhouette its name plate floats, along the camera's up
 * axis: about half a plate height plus a little air.
 */
const PLATE_LIFT = 1.35;

/**
 * Room-to-room pitch (world units, derived in `GRID`): each room is yawed into its
 * isometric pose, so the pitch has to clear the room's yawed footprint — 20.5 in
 * plan — and the rows need more depth because the camera looks down.
 */
const ROOM_PITCH_X = GRID.pitchX;
const ROOM_PITCH_Z = GRID.pitchZ;

/**
 * Hover feedback: the whole room lifts a little and grows a touch.
 *
 * No sway: the boss asked for the slow rocking to go, and a moving target is also
 * harder to click. Deliberately subtle — the board is read at a glance, so a hover
 * must say "this one" without pulling the eye off the other rooms.
 */
const HOVER_LIFT = 0.6;
const HOVER_SCALE = 0.02;
/** Per-frame approach rate toward the hover target (0…1). */
const HOVER_EASE = 0.16;

/** Movement (CSS px) that turns a left-button press into a camera drag. */
const DRAG_THRESHOLD_PX = 4;
/** Orbit sensitivity: radians per CSS pixel of drag. */
const DRAG_ORBIT_SPEED = 0.005;

interface RoomEntry {
  room: WorkRoom;
  handle: RoomHandle;
  signature: string;
  /** 0 = resting, 1 = fully lifted; eased every frame. */
  hover: number;
}

/** WebGL availability probe — the module falls back to a 2D board without it. */
export function isWebglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context =
      canvas.getContext("webgl2") ?? canvas.getContext("webgl") ?? null;
    // Release the probe context immediately: browsers cap how many live WebGL
    // contexts a page may hold, and this one is never drawn into.
    (context as WebGLRenderingContext | null)
      ?.getExtension("WEBGL_lose_context")
      ?.loseContext();
    return context !== null;
  } catch {
    return false;
  }
}

export function createWorkStatusStage(
  container: HTMLElement,
  callbacks: StageCallbacks,
): WorkStatusStage {
  const scene = new Scene();

  const renderer = new WebGLRenderer({
    antialias: false,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // Neutral tone mapping, not ACES: the cartoon look wants the artist's colours
  // back, and a filmic curve greys them out.
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = LIGHTING.light.exposure;
  // Wood grain seen at a grazing angle (a table top from the isometric camera)
  // needs anisotropic filtering, or the streaks alias into noise.
  setWoodAnisotropy(renderer.capabilities.getMaxAnisotropy());
  renderer.setClearColor(new Color(0x000000), 0);
  // Shadows: one directional light with a single map over the whole board. The map is
  // frozen while the bird's-eye view is static and refreshed in a focused room, so the
  // depth pass costs almost nothing (see the frame loop).
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.domElement.className = "imb-ws-canvas";
  container.appendChild(renderer.domElement);

  // The focused room's screen is a **texture on the screen mesh**, so the things in
  // front of the wall occlude it. Only an invisible rectangle is left in the DOM: it
  // gives the screen a focusable, named target for assistive tech (and a stable
  // geometric handle for the tests).
  const screenProxy = document.createElement("div");
  // `.imb-ws-screen` is the name the app (and its tests) already use for "the
  // focused room's screen"; the extra class says it is only a proxy for it now.
  screenProxy.className = "imb-ws-screen imb-ws-screen-proxy";
  screenProxy.style.display = "none";

  const hud = new HudLayer(container);
  const geometry = createSharedGeometry();
  const rig = new CameraRig(
    Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
  );

  // A studio rig: one warm key from the window wall (it casts the shadow), a cool
  // fill from the other side, a rim to lift the wall tops, and the hemisphere pair.
  let darkTheme = false;
  const hemi = new HemisphereLight(
    LIGHTING.light.sky,
    LIGHTING.light.ground,
    LIGHTING.light.hemi,
  );
  const key = new DirectionalLight(0xfff3e2, LIGHTING.light.keyIntensity);
  key.position.copy(LIGHT_POSITIONS.key).multiplyScalar(40);
  key.castShadow = true;
  key.shadow.mapSize.set(SHADOW.mapSize, SHADOW.mapSize);
  key.shadow.bias = SHADOW.bias;
  key.shadow.normalBias = SHADOW.normalBias;
  const fill = new DirectionalLight(0xdce8f5, LIGHTING.light.fillIntensity);
  fill.position.copy(LIGHT_POSITIONS.fill).multiplyScalar(40);
  const rim = new DirectionalLight(0xffffff, LIGHTING.light.rimIntensity);
  rim.position.copy(LIGHT_POSITIONS.rim).multiplyScalar(40);
  const ambient = new AmbientLight(0xffffff, LIGHTING.light.ambient);
  scene.add(hemi, key, fill, rim, ambient);

  /**
   * Radius of the shadow camera that covers one room, from any turn of it: the room's
   * circumscribed circle in plan (`width` / `depth` diagonal) plus padding. It is a
   * constant, never measured from the room's box — a turned room has a wider
   * axis-aligned box, and re-measuring it would rescale the map under the floor while the
   * room turns (the shadow creeps and its softness changes mid-drag).
   */
  const FOCUS_SHADOW_RADIUS =
    Math.hypot(ROOM.width, ROOM.depth) / 2 + SHADOW.padding;

  /**
   * Point the key light's shadow camera at a **sphere** (`centre`, `radius`).
   *
   * A directional light's shadow camera is a 10 × 10 box at the world origin by default,
   * so on a board ~160 units across only the room that happened to sit near the origin got
   * a shadow map at all — that is why most objects had no shadow, and why the delivered
   * screenshots (rooms away from the origin) showed none. The camera is therefore fitted
   * to the whole board for the bird's-eye view and to one room while focused.
   */
  function fitShadow(centre: Vector3, radius: number): void {
    key.target.position.copy(centre);
    key.target.updateMatrixWorld();
    key.position
      .copy(centre)
      .addScaledVector(LIGHT_POSITIONS.key, radius * 2.5);
    const camera = key.shadow.camera;
    camera.left = -radius;
    camera.right = radius;
    camera.top = radius;
    camera.bottom = -radius;
    camera.near = radius * 0.5;
    camera.far = radius * 6;
    camera.updateProjectionMatrix();
  }

  const shadowCentre = new Vector3();
  const shadowSize = new Vector3();

  /** Fit the map to the whole board (bird's-eye) or to the focused room. */
  function fitShadowTo(box: Box3, focused: boolean): void {
    box.getCenter(shadowCentre);
    if (focused) {
      fitShadow(shadowCentre, FOCUS_SHADOW_RADIUS);
      return;
    }
    box.getSize(shadowSize);
    fitShadow(shadowCentre, shadowSize.length() / 2 + SHADOW.padding);
  }

  function applyLighting(): void {
    const rig = darkTheme ? LIGHTING.dark : LIGHTING.light;
    hemi.color.setHex(rig.sky);
    hemi.groundColor.setHex(rig.ground);
    hemi.intensity = rig.hemi;
    key.color.setHex(rig.key);
    key.intensity = rig.keyIntensity;
    fill.color.setHex(rig.fill);
    fill.intensity = rig.fillIntensity;
    rim.color.setHex(rig.rim);
    rim.intensity = rig.rimIntensity;
    ambient.intensity = rig.ambient;
    renderer.toneMappingExposure = rig.exposure;
  }

  const roomsRoot = new Group();
  scene.add(roomsRoot);

  const screens = new ScreenTextureCache();
  /**
   * What each room had on the wall when it was first shown: `chatId →
   * employeeId → messageId`.
   *
   * The boss does not want a freshly opened board to replay the back-catalogue of
   * notify messages — a room's *first* presentation is history, and only messages
   * that arrive afterwards are worth a bubble. The baseline is remembered per
   * room while the room is on the board (so hiding the module and coming back
   * changes nothing), and dropped together with the room: a room that left the
   * board and comes back is a new presentation, so its old messages are history
   * again.
   */
  const bubbleBaseline = new Map<number, Map<number, number>>();
  const entries = new Map<number, RoomEntry>();
  const views = new Map<string, EmployeeView>();
  const pickables: Object3D[] = [];
  const screenPickables: Object3D[] = [];

  /** Mesh/group → owner, so a raycast hit can be turned back into a person. */
  const personOwners = new Map<
    Object3D,
    { chatId: number; employeeId: number }
  >();

  let rooms: WorkRoom[] = [];
  let active = false;
  let focusedChatId: number | null = null;
  let hoverRoomId: number | null = null;
  /** The hovered room's progress screen (a different click action). */
  let hoverScreenId: number | null = null;
  /**
   * How far the focused room has been turned on its own axis by dragging (radians).
   * The camera stays put; the room turns.
   */
  let focusYaw = 0;
  let hoverPerson: { chatId: number; employeeId: number } | null = null;
  let currentScreen: { chatId: number; label: string } | null = null;
  let rafId = 0;
  /** Pending wake-up for a static board (see `frame`). */
  let wakeTimer = 0;
  let disposed = false;
  let needsRender = true;
  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduceMotion = motionQuery.matches;
  /** The HUD's content (not its positions) must be rebuilt from the views. */
  let hudDirty = true;
  let pointer = new Vector2();
  let pointerInside = false;
  /** In-progress left-button press: a click until it moves past the threshold. */
  let drag: {
    pointerId: number;
    x: number;
    y: number;
    moved: boolean;
  } | null = null;

  const raycaster = new Raycaster();
  const worldAnchor = new Vector3();
  const roomBox = new Box3();

  // ── rooms ───────────────────────────────────────────────────────────────

  /**
   * Columns are chosen for the *pane*, not for a square: a wide window fits more
   * rooms side by side, which is also what keeps the name plates of one row from
   * covering the rooms behind it.
   */
  function columnCount(): number {
    const count = Math.max(1, rooms.length);
    const width = container.clientWidth;
    const height = container.clientHeight;
    const aspect =
      width > 1 && height > 1
        ? Math.min(3, Math.max(0.6, width / height))
        : 1.6;
    // On screen a room is a diamond, `(width + depth) · cos45` wide and
    // `(width + depth) · sin45 · sin(pitch) + wallHeight · cos(pitch)` tall — so it
    // reads almost square rather than "wider than tall". `GRID.roomAspect` is that
    // shape's width/height, which is what the pane has to fit. A wide window fits
    // more rooms side by side.
    const perRow = Math.round(Math.sqrt((count * aspect) / GRID.roomAspect));
    // At least two across once there are two rooms: the board is framed for a
    // 2×1 reference, so adding the second room must not re-scale the first one
    // (the "size is fixed, not fitted to the count" rule).
    const minColumns = count > 1 ? 2 : 1;
    return Math.max(minColumns, Math.min(6, perRow));
  }

  function layoutGrid(): Box3 {
    const count = rooms.length;
    const columns = columnCount();
    const rows = Math.max(1, Math.ceil(count / columns));
    const pitchX = ROOM_PITCH_X;
    const pitchZ = ROOM_PITCH_Z;
    const totalDepth = rows * pitchZ;
    const bounds = new Box3();

    rooms.forEach((room, index) => {
      const entry = entries.get(room.chatId);
      if (!entry) return;
      const column = index % columns;
      const row = Math.floor(index / columns);
      // A last row with fewer rooms is centred instead of hanging off the left
      // edge, so the board looks arranged rather than accidentally short.
      const roomsInRow = Math.min(columns, count - row * columns);
      const rowWidth = roomsInRow * pitchX;
      const x = -rowWidth / 2 + pitchX * (column + 0.5);
      // Row 0 is the nearest row (biggest z) so the reading order runs
      // left-to-right, front-to-back — like reading a page.
      const z = totalDepth / 2 - pitchZ * (row + 0.5);
      entry.handle.place(x, z);
      // The frame covers the *whole* diorama (walls included) in its **yawed**
      // footprint: the room is turned 45°, so what on screen is a 20.5 × 20.5
      // diamond, not a 16 × 13 rectangle.
      const half = ROOM_FOOTPRINT.plan / 2;
      bounds.expandByPoint(new Vector3(x - half, 0, z - half));
      bounds.expandByPoint(new Vector3(x + half, ROOM.wallHeight, z + half));
    });

    // Frame at least two rooms wide: with one (or a couple of) task groups the
    // camera must not fly in to fill the pane — a single room would grow until its
    // name plate left the view, and the board would change scale as groups come
    // and go. The reference is "two rooms and the gap between them" — framing two
    // full pitches would grow with the grid spacing and shrink a single room.
    const frameHalfWidth = (Math.max(columns, 2) * pitchX - GRID.gapX) * 0.5;
    const frameHalfDepth = (Math.max(rows, 1) * pitchZ - GRID.gapZ) * 0.5;
    bounds.expandByPoint(new Vector3(-frameHalfWidth, 0, -frameHalfDepth));
    bounds.expandByPoint(new Vector3(frameHalfWidth, 0, frameHalfDepth));
    return bounds;
  }

  function disposeEntry(entry: RoomEntry): void {
    // The focused room's screen card is a DOM element parented to the room group.
    // Disposing the group would detach it while the portal still points at it
    // (the card would vanish until the room is refocused), so drop the screen
    // first and let `buildScreen()` recreate it in the new group.
    if (currentScreen !== null && currentScreen.chatId === entry.room.chatId) {
      disposeScreen();
    }
    roomsRoot.remove(entry.handle.group);
    for (const target of entry.handle.pickTargets) {
      const index = pickables.indexOf(target);
      if (index >= 0) pickables.splice(index, 1);
    }
    for (const target of entry.handle.screenTargets) {
      const index = screenPickables.indexOf(target);
      if (index >= 0) screenPickables.splice(index, 1);
    }
    for (const seat of entry.handle.seats) {
      for (const mesh of seat.figure.pickTargets) personOwners.delete(mesh);
    }
    entry.handle.dispose();
    screens.release(entry.room.chatId);
  }

  /** Dispose every room (theme change, teardown): the next `syncRooms` rebuilds. */
  function dropAllRooms(): void {
    if (currentScreen !== null) disposeScreen();
    for (const entry of entries.values()) disposeEntry(entry);
    entries.clear();
    bubbleBaseline.clear();
    pickables.length = 0;
    screenPickables.length = 0;
    personOwners.clear();
  }

  function syncRooms(): void {
    const seen = new Set<number>();
    for (const room of rooms) {
      seen.add(room.chatId);
      const signature = roomSignature(room);
      const existing = entries.get(room.chatId);
      if (existing && existing.signature === signature) {
        existing.room = room;
        continue;
      }
      if (existing) disposeEntry(existing);
      const handle = buildRoom(room, geometry, { dark: darkTheme });
      roomsRoot.add(handle.group);
      for (const target of handle.pickTargets) pickables.push(target);
      for (const target of handle.screenTargets) screenPickables.push(target);
      for (const seat of handle.seats) {
        for (const mesh of seat.figure.pickTargets) {
          personOwners.set(mesh, {
            chatId: room.chatId,
            employeeId: seat.employeeId,
          });
        }
      }
      entries.set(room.chatId, { room, handle, signature, hover: 0 });
    }
    for (const [chatId, entry] of entries) {
      if (seen.has(chatId)) continue;
      disposeEntry(entry);
      entries.delete(chatId);
    }

    // Every room's screen shows its progress card, drawn into a cached texture
    // (repainted only when that room's card or the theme changed).
    paintScreens();

    if (focusedChatId !== null && !entries.has(focusedChatId)) {
      // The room left the board (finished or deleted): do not stay focused on
      // nothing.
      exitFocus();
    }
    const bounds = layoutGrid();
    rig.setBirdBox(bounds);
    // The grid is re-laid out on every snapshot, which moves rooms around the board.
    // While a room is focused its frame must only depend on *that* room, so re-anchor the
    // camera to its new position instantly (a new room on the board used to shift the
    // focused view sideways).
    if (focusedChatId !== null) {
      const focused = entries.get(focusedChatId);
      if (focused) {
        rig.refocus(focused.handle.worldBox());
        fitShadowTo(focused.handle.worldBox(), true);
      }
    } else {
      fitShadowTo(bounds, false);
    }
    syncViews();
    buildScreen();
    hudDirty = true;
    invalidate();
  }

  function syncViews(): void {
    const now = performance.now();
    const seen = new Set<string>();
    const roomIds = new Set<number>();
    for (const room of rooms) {
      roomIds.add(room.chatId);
      // First snapshot this room appears in: whatever notify messages already
      // exist are the room's history, not news.
      if (!bubbleBaseline.has(room.chatId)) {
        bubbleBaseline.set(
          room.chatId,
          new Map(
            room.bubbles.map(
              (bubble) => [bubble.employeeId, bubble.messageId] as const,
            ),
          ),
        );
      }
      const bubbleByEmployee = new Map(
        room.bubbles.map((bubble) => [bubble.employeeId, bubble] as const),
      );
      for (const member of room.members) {
        const key = viewKey(room.chatId, member.employeeId);
        seen.add(key);
        const bubble = bubbleByEmployee.get(member.employeeId) ?? null;
        const baseline = bubbleBaseline.get(room.chatId);
        const isNew =
          bubble !== null &&
          baseline !== undefined &&
          baseline.get(member.employeeId) !== bubble.messageId;
        // A message that was already there when the room first appeared is only
        // recorded as seen — it never becomes a bubble.
        const message =
          bubble === null || !isNew
            ? null
            : { messageId: bubble.messageId, content: bubble.content };
        // Each message counts as news exactly once; the bubble's own lifetime is
        // the state machine's business from here on.
        if (isNew && bubble !== null) {
          baseline.set(member.employeeId, bubble.messageId);
        }
        const existing = views.get(key);
        if (existing === undefined) {
          views.set(
            key,
            createView(
              room.chatId,
              member.employeeId,
              member.running,
              message,
              now,
            ),
          );
          continue;
        }
        const next = setBubble(
          setRunning(existing, member.running, now),
          message,
          now,
        );
        if (next !== existing) views.set(key, next);
      }
    }
    for (const key of views.keys()) {
      if (!seen.has(key)) views.delete(key);
    }
    for (const chatId of bubbleBaseline.keys()) {
      if (!roomIds.has(chatId)) bubbleBaseline.delete(chatId);
    }
  }

  /** A room's own bounds in its local frame (the yaw and the lift come from the group). */
  const plateLocalBox = new Box3(
    new Vector3(-ROOM.width / 2, -ROOM.shellThickness, -ROOM.depth / 2),
    new Vector3(ROOM.width / 2, ROOM.wallHeight, ROOM.depth / 2),
  );
  const plateBox = new Box3();
  const plateRight = new Vector3();
  const plateUp = new Vector3();
  const plateForward = new Vector3();
  const plateCorner = new Vector3();
  const plateCentre = new Vector3();

  /**
   * Where a room's name plate hangs.
   *
   * The boss wants it **centred over the room as the room appears on screen**, not over
   * the back wall (which sits off to one side of a yawed room, so the plate landed
   * sideways of the room). The anchor is the room's world centre moved *only* along the
   * camera's own up axis: an orthographic projection keeps the screen x unchanged while
   * the screen y rises — so the plate is horizontally centred by construction and sits
   * clear above the room's silhouette.
   */
  function plateAnchorFor(entry: RoomEntry): Vector3 {
    // The room's box is recomputed from its *current* transform, so the plate rides the
    // hover lift with the room (a cached box would leave the plate behind).
    const box = plateBox
      .copy(plateLocalBox)
      .applyMatrix4(entry.handle.group.matrixWorld);
    box.getCenter(plateCentre);
    rig.camera.matrixWorld.extractBasis(plateRight, plateUp, plateForward);
    let top = Number.NEGATIVE_INFINITY;
    for (let corner = 0; corner < 8; corner += 1) {
      plateCorner.set(
        corner & 1 ? box.max.x : box.min.x,
        corner & 2 ? box.max.y : box.min.y,
        corner & 4 ? box.max.z : box.min.z,
      );
      top = Math.max(top, plateCorner.clone().sub(plateCentre).dot(plateUp));
    }
    return plateCentre.clone().addScaledVector(plateUp, top + PLATE_LIFT);
  }

  // ── HUD content ─────────────────────────────────────────────────────────

  function syncHudContent(): void {
    const bubbles: HudBubble[] = [];
    const plates: HudRoomLabel[] = [];
    const singleRoom =
      focusedChatId !== null ? (entries.get(focusedChatId) ?? null) : null;

    for (const room of rooms) {
      const entry = entries.get(room.chatId);
      if (!entry) continue;
      const visible =
        singleRoom === null || singleRoom.room.chatId === room.chatId;
      if (singleRoom === null) {
        plates.push({
          chatId: room.chatId,
          anchor: plateAnchorFor(entry),
        });
      }
      if (!visible) continue;
      for (const seat of entry.handle.seats) {
        const key = viewKey(room.chatId, seat.employeeId);
        const view = views.get(key);
        if (!view) continue;
        const bubble = bubbleOf(view);
        if (bubble === null) continue;
        seat.figure.headAnchor.getWorldPosition(worldAnchor);
        bubbles.push({
          key,
          kind: bubble.kind,
          content: bubble.content ?? "",
          // A clone per bubble: the HUD keeps the anchor across frames, and the
          // shared `worldAnchor` is overwritten by the next seat.
          anchor: worldAnchor.clone(),
        });
      }
    }

    hud.setBubbles(bubbles, callbacks.onBubbleTarget);
    hud.setRoomLabels(plates, callbacks.onPlateTarget);
  }

  // ── the focused room's screen ───────────────────────────────────────────

  /** Re-paint every screen (the focused one at the higher resolution). */
  function paintScreens(): void {
    for (const room of rooms) {
      const entry = entries.get(room.chatId);
      if (!entry) continue;
      entry.handle.setScreenTexture(
        screens.get(
          room,
          darkTheme,
          room.chatId === focusedChatId ? "focus" : "grid",
        ),
      );
    }
  }

  function disposeScreen(): void {
    if (currentScreen === null) return;
    screenProxy.removeAttribute("role");
    screenProxy.removeAttribute("tabindex");
    screenProxy.removeAttribute("aria-label");
    screenProxy.remove();
    currentScreen = null;
  }

  function buildScreen(): void {
    const entry = focusedChatId === null ? null : entries.get(focusedChatId);
    if (!entry) {
      disposeScreen();
      callbacks.onFocusChange(null);
      return;
    }
    currentScreen = { chatId: entry.room.chatId, label: entry.room.title };
    // The proxy sits where the screen projects and offers the one action the screen
    // has, to assistive tech and to the keyboard (the pointer goes through the canvas
    // raycast, so this element must not intercept it).
    screenProxy.setAttribute("role", "button");
    screenProxy.setAttribute("tabindex", "0");
    screenProxy.setAttribute(
      "aria-label",
      `${t("Open task group")}: ${entry.room.title}`,
    );
    screenProxy.style.display = "block";
    container.appendChild(screenProxy);
    callbacks.onFocusChange(entry.room.chatId);
  }

  function onScreenProxyKey(event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (currentScreen === null) return;
    event.preventDefault();
    callbacks.openRoom(currentScreen.chatId);
  }

  /** Place the invisible proxy over the screen's projection (once per drawn frame). */
  function updateScreenProxy(): void {
    if (currentScreen === null) return;
    const entry = entries.get(currentScreen.chatId);
    if (!entry) return;
    const rect = entry.handle.screenRect();
    const camera = rig.camera;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const corner of rect) {
      worldAnchor.copy(corner).project(camera);
      const x = (worldAnchor.x * 0.5 + 0.5) * container.clientWidth;
      const y = (-worldAnchor.y * 0.5 + 0.5) * container.clientHeight;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    screenProxy.style.left = `${minX}px`;
    screenProxy.style.top = `${minY}px`;
    screenProxy.style.width = `${Math.max(1, maxX - minX)}px`;
    screenProxy.style.height = `${Math.max(1, maxY - minY)}px`;
  }

  // ── interaction ─────────────────────────────────────────────────────────

  function updateHover(): void {
    if (!pointerInside) {
      hoverPerson = null;
      hoverRoomId = null;
      hoverScreenId = null;
      hud.setHover(null);
      // The pointer left the board: a lifted room has to come back down, and on a
      // static board nothing else would ask for that frame.
      invalidate();
      return;
    }
    raycaster.setFromCamera(pointer, rig.camera);
    const personHits = raycaster.intersectObjects(
      [...personOwners.keys()],
      false,
    );
    const person = personHits[0]?.object;
    hoverPerson = (person && personOwners.get(person)) || null;
    if (hoverPerson !== null) {
      const room = rooms.find((item) => item.chatId === hoverPerson!.chatId);
      const member = room?.members.find(
        (item) => item.employeeId === hoverPerson!.employeeId,
      );
      const entry = entries.get(hoverPerson.chatId);
      const seat = entry?.handle.seats.find(
        (item) => item.employeeId === hoverPerson!.employeeId,
      );
      if (member && seat) {
        seat.figure.hoverAnchor.getWorldPosition(worldAnchor);
        hud.setHover({
          name: member.name,
          avatarUrl: employeeAvatarSrc({
            id: member.employeeId,
            avatar: member.avatar,
            avatarVersion: member.avatarVersion,
          }),
          anchor: worldAnchor.clone(),
        });
      }
    } else {
      hud.setHover(null);
    }

    const screenHit = raycaster.intersectObjects(screenPickables, false)[0]
      ?.object;
    hoverScreenId = null;
    if (screenHit !== undefined) {
      for (const entry of entries.values()) {
        if (entry.handle.screenTargets.includes(screenHit)) {
          hoverScreenId = entry.room.chatId;
          break;
        }
      }
    }

    const roomHits = raycaster.intersectObjects(pickables, false);
    const hitRoom = roomHits[0]?.object;
    let hoveredRoom: number | null = null;
    if (hitRoom !== undefined) {
      for (const entry of entries.values()) {
        if (entry.handle.pickTargets.includes(hitRoom)) {
          hoveredRoom = entry.room.chatId;
          break;
        }
      }
    }
    // Hovering a person whose room is not focused highlights that room: from the
    // grid the click target *is* the room, so the affordance has to say so.
    if (
      hoveredRoom === null &&
      hoverPerson !== null &&
      hoverPerson.chatId !== focusedChatId
    ) {
      hoveredRoom = hoverPerson.chatId;
    }
    if (hoveredRoom !== hoverRoomId) {
      hoverRoomId = hoveredRoom;
      invalidate();
    }
    // Pointer only where a click does something: the grid (focus), a person, or
    // the wall screen (open the group). Inside a focused room the floor and the
    // furniture are inert, so they keep the default cursor.
    const actionable =
      hoverPerson !== null ||
      (hoverScreenId !== null && hoverScreenId === focusedChatId) ||
      (focusedChatId === null &&
        (hoverRoomId !== null || hoverScreenId !== null));
    renderer.domElement.style.cursor = actionable ? "pointer" : "default";
    invalidate();
  }

  /**
   * Ease every room toward its hover animation and apply it. Returns true while
   * something is still moving, so the loop keeps drawing.
   */
  function updateHoverAnimation(): boolean {
    let moving = false;
    for (const entry of entries.values()) {
      const target =
        entry.room.chatId === hoverRoomId && entry.room.chatId !== focusedChatId
          ? 1
          : 0;
      const next = entry.hover + (target - entry.hover) * HOVER_EASE;
      const settled = Math.abs(target - next) < 0.004;
      entry.hover = settled ? target : next;
      if (!settled) moving = true;

      const { group } = entry.handle;
      group.position.y = entry.hover * HOVER_LIFT;
      // Reduced motion keeps the lift (a static offset, no animation) and drops
      // the scale, which would otherwise be a second visual change.
      group.scale.setScalar(1 + (reduceMotion ? 0 : entry.hover * HOVER_SCALE));
      if (next !== entry.hover) hudDirty = true;
    }
    // The plates and bubbles are anchored to world positions, so a lifted room
    // has to move them too — otherwise the room floats out from under its name.
    if (moving) hudDirty = true;
    return moving;
  }

  function focusRoom(chatId: number): void {
    const entry = entries.get(chatId);
    if (!entry) return;
    drag = null;
    focusedChatId = chatId;
    hoverRoomId = null;
    focusYaw = 0;
    // The room is yawed, so its box is the yawed footprint, not the local rectangle.
    roomBox.copy(entry.handle.worldBox());
    rig.focusRoom(roomBox, performance.now());
    fitShadowTo(roomBox, true);
    buildScreen();
    paintScreens();
    // A focused room animates again, and its shadow map is re-rendered per frame
    // (one room, so the depth pass is cheap).
    hudDirty = true;
    invalidate();
    startLoop();
  }

  function exitFocus(): void {
    if (focusedChatId === null) return;
    drag = null;
    const entry = entries.get(focusedChatId);
    if (entry !== undefined) {
      // Back to the board's own pose for this room.
      entry.handle.group.rotation.y = (CAMERA.roomYawDeg * Math.PI) / 180;
    }
    focusYaw = 0;
    focusedChatId = null;
    rig.exitFocus(performance.now());
    disposeScreen();
    paintScreens();
    hudDirty = true;
    callbacks.onFocusChange(null);
    invalidate();
  }

  /**
   * Click semantics (boss's decision):
   * - bird's-eye: a person, the screen or any room surface **focuses** that room;
   * - focused room: a person opens their agent session, the wall screen opens the
   *   task group, and everything else (floor, desks, empty space) does nothing —
   *   leaving is an explicit action (right click / the header's back button), never
   *   a side effect of a stray click.
   */
  function handleClick(): void {
    if (focusedChatId === null) {
      const targetRoom = hoverPerson?.chatId ?? hoverScreenId ?? hoverRoomId;
      if (targetRoom !== null && targetRoom !== undefined)
        focusRoom(targetRoom);
      return;
    }
    if (hoverPerson !== null && hoverPerson.chatId === focusedChatId) {
      callbacks.openSession(hoverPerson.chatId, hoverPerson.employeeId);
      return;
    }
    if (hoverScreenId === focusedChatId) {
      callbacks.openRoom(focusedChatId);
    }
  }

  /**
   * A left-button press is either a click or the start of a room turn; which one is
   * decided by movement (`DRAG_THRESHOLD_PX`). Deciding on release is what lets "drag to
   * turn the focused room" and "click to open something" share the same button.
   */
  function onPointerDown(event: PointerEvent): void {
    // Left button only: the context menu owns the right button.
    if (event.button !== 0) return;
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    if (focusedChatId !== null) {
      renderer.domElement.setPointerCapture?.(event.pointerId);
    }
  }

  function onPointerUp(event: PointerEvent): void {
    const started = drag;
    drag = null;
    if (started === null) return;
    if (renderer.domElement.hasPointerCapture?.(started.pointerId) === true) {
      renderer.domElement.releasePointerCapture(started.pointerId);
    }
    if (started.moved) {
      // A drag is not a click: none of the click actions fire.
      renderer.domElement.style.cursor = "default";
      updateHover();
      return;
    }
    handleClick();
  }

  function onPointerMove(event: PointerEvent): void {
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    if (drag !== null && focusedChatId !== null) {
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        drag.moved = true;
        // While dragging there is no hover: the room must not lift or highlight
        // under a pointer that is rotating the camera.
        hoverPerson = null;
        hoverRoomId = null;
        hoverScreenId = null;
        hud.setHover(null);
      }
      if (drag.moved) {
        drag.x = event.clientX;
        drag.y = event.clientY;
        // Dragging turns the **room**, not the camera: a camera that swung sideways
        // dragged the neighbouring rooms into the frame. Only the horizontal drag is
        // used — the camera's pitch is fixed while focused.
        const entry = entries.get(focusedChatId);
        if (entry !== null && entry !== undefined) {
          // Drag direction == turn direction: dragging right turns the room to the
          // right (a positive yaw about +Y reads as "to the right" from the camera).
          focusYaw = Math.max(
            -CAMERA.roomOrbitLimit,
            Math.min(CAMERA.roomOrbitLimit, focusYaw + dx * DRAG_ORBIT_SPEED),
          );
          entry.handle.group.rotation.y =
            (CAMERA.roomYawDeg * Math.PI) / 180 + focusYaw;
          hudDirty = true;
        }
        renderer.domElement.style.cursor = "grabbing";
        invalidate();
        return;
      }
    }

    pointer = new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    pointerInside = true;
    updateHover();
  }

  function onPointerLeave(): void {
    pointerInside = false;
    updateHover();
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    exitFocus();
  }

  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("pointercancel", onPointerUp);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerleave", onPointerLeave);
  renderer.domElement.addEventListener("contextmenu", onContextMenu);
  screenProxy.addEventListener("keydown", onScreenProxyKey);

  // ── frame loop ──────────────────────────────────────────────────────────
  //
  // Two modes, one loop:
  // - **focused**: the loop runs continuously (breathing, rest animations, the clocks
  //   ticking, hover easing, camera flights);
  // - **bird's-eye**: nothing animates. The loop draws a frame when something
  //   *changes* — a snapshot, a bubble, a hover, a camera flight — and then sleeps
  //   until the next scheduled event (a bubble's 8 s window ending, a rest animation
  //   finishing). Data never waits for a polling tick: every change calls
  //   `invalidate()` directly.
  function focusedNow(): boolean {
    return focusedChatId !== null;
  }

  /** Something changed: draw a frame, and wake the loop if it is asleep. */
  function invalidate(): void {
    needsRender = true;
    if (wakeTimer !== 0) {
      window.clearTimeout(wakeTimer);
      wakeTimer = 0;
    }
    startLoop();
  }

  /** The next moment a view can change on its own (bubble expiry / rest end). */
  function nextViewEvent(now: number): number {
    let next = Number.POSITIVE_INFINITY;
    for (const view of views.values()) {
      if (view.phase === "message")
        next = Math.min(next, view.messageExpiresAt);
      else if (view.phase === "resting") next = Math.min(next, view.restEndsAt);
    }
    return next > now ? next : now;
  }

  function resize(): void {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width < 2 || height < 2) return;
    renderer.setSize(width, height, false);
    rig.setAspect(width / height);
    needsRender = true;
    startLoop();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(container);

  function drawFrame(now: number, animate: boolean): boolean {
    let animating = false;
    if (rig.update(now)) animating = true;
    if (updateHoverAnimation()) animating = true;

    for (const [key, view] of views) {
      // Reduced motion: no rest animations at all (they are decoration).
      // Bird's-eye: only the phases that must be *finished* are ticked — an idle
      // employee does not start a rest animation while the board is frozen, because
      // nothing would animate it.
      if (reduceMotion) continue;
      if (!animate && view.phase === "idle") continue;
      const next = tick(view, now);
      if (next !== view) {
        views.set(key, next);
        hudDirty = true;
      }
      // "Running" is a *state*, not an animation: on a static board it must not keep
      // the loop awake (the whole point of freezing the bird's-eye view).
    }

    if (!animate && !animating && !needsRender) return false;

    const liveliness = animate && !reduceMotion;
    poseFigures(liveliness ? now : 0, liveliness);
    // The clocks are set on **every** drawn frame, in both modes: a room's first frame
    // has to show the real time (a frozen bird's-eye frame that showed 0:00 was a bug),
    // and because a still board only draws when something changes, "set on every frame"
    // means "frozen at the moment of that frame" — exactly the boss's rule.
    updateClocks();
    if (hudDirty) {
      syncHudContent();
      hudDirty = false;
    }
    hud.update(rig.camera);
    updateScreenProxy();
    // The shadow map is re-rendered here, on demand: every frame in a focused room,
    // and once per change while the board is static.
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, rig.camera);
    needsRender = false;
    // Only real motion keeps the loop awake: a focused room (always animating), a
    // camera flight, or a hover lift still easing.
    return animate || animating;
  }

  function frame(): void {
    rafId = 0;
    if (disposed) return;
    if (!active) return;
    const now = performance.now();
    const keepGoing = drawFrame(now, focusedNow());
    if (keepGoing && active) {
      rafId = requestAnimationFrame(frame);
      return;
    }
    // Static board: sleep until the next thing that can change by itself.
    if (!focusedNow()) {
      const next = nextViewEvent(now);
      if (Number.isFinite(next)) {
        wakeTimer = window.setTimeout(
          () => {
            wakeTimer = 0;
            invalidate();
          },
          Math.max(0, next - now) + IDLE_EVENT_SLACK_MS,
        );
      }
    }
  }

  function startLoop(): void {
    if (disposed || rafId !== 0 || !active) return;
    if (!focusedNow() && wakeTimer !== 0) {
      // A wake-up is already scheduled; that is enough for a static board.
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop(): void {
    if (wakeTimer !== 0) {
      window.clearTimeout(wakeTimer);
      wakeTimer = 0;
    }
    if (rafId === 0) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function onMotionPreference(): void {
    reduceMotion = motionQuery.matches;
    rig.setReducedMotion(reduceMotion);
    invalidate();
  }

  function onContextLost(event: Event): void {
    // A lost context cannot be rebuilt here (all geometry and materials belong to
    // it): the module falls back to the 2D board, which carries the same data.
    event.preventDefault();
    if (disposed) return;
    stopLoop();
    callbacks.onContextLost();
  }

  motionQuery.addEventListener("change", onMotionPreference);
  renderer.domElement.addEventListener("webglcontextlost", onContextLost);

  /**
   * Pose every figure. In a focused room they breathe and play their rest
   * animations; on a static board they hold the base pose (`animate: false`).
   */
  function poseFigures(now: number, animate: boolean): void {
    for (const entry of entries.values()) {
      for (const seat of entry.handle.seats) {
        const view = views.get(viewKey(entry.room.chatId, seat.employeeId));
        seat.figure.pose({
          now,
          animate,
          working: view?.running === true && view.phase !== "resting",
          rest:
            animate && view?.phase === "resting" ? (view.rest ?? null) : null,
          restProgress:
            animate && view !== undefined ? restProgress(view, now) : 0,
        });
      }
    }
  }

  /**
   * The wall clocks show the machine's local time.
   *
   * They are driven only while the loop is animating: on a static board the hands
   * stay where the last animated frame left them (the boss's "freeze in the
   * bird's-eye"), and a focused room sets them again on its first frame.
   */
  function updateClocks(): void {
    // The **wall clock**, not `performance.now()`: the frame timestamp is the page's
    // uptime, so `new Date(performance.now())` reads as "1970-01-01 00:<uptime>" and the
    // hands showed the uptime (a 38-minute-old session showed 8:38) instead of the time.
    const date = new Date();
    const hours = date.getHours();
    const minutes = date.getMinutes() + date.getSeconds() / 60;
    for (const entry of entries.values()) {
      entry.handle.setClockTime(hours, minutes);
    }
  }

  return {
    setRooms(payload: WorkRoomsPayload): void {
      rooms = payload.rooms;
      syncRooms();
    },
    setTheme(next: boolean): void {
      if (darkTheme === next) return;
      darkTheme = next;
      applyLighting();
      // Palettes are baked into a room's materials, so the rooms are rebuilt —
      // and they must be *dropped* first: `syncRooms` keeps a room whose roster
      // signature did not change, which would leave the light materials in place.
      dropAllRooms();
      syncRooms();
    },
    setActive(next: boolean): void {
      if (active === next) return;
      active = next;
      renderer.domElement.style.pointerEvents = next ? "" : "none";
      if (next) {
        resize();
        hudDirty = true;
        invalidate();
      } else {
        stopLoop();
      }
    },
    focusRoom,
    exitFocus,
    dispose(): void {
      disposed = true;
      stopLoop();
      motionQuery.removeEventListener("change", onMotionPreference);
      renderer.domElement.removeEventListener(
        "webglcontextlost",
        onContextLost,
      );
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      disposeScreen();
      for (const entry of entries.values()) disposeEntry(entry);
      entries.clear();
      hud.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      screenProxy.removeEventListener("keydown", onScreenProxyKey);
      screenProxy.remove();
      screens.dispose();
      scene.clear();
      for (const value of sharedGeometrySet(geometry)) value.dispose();
    },
  };
}
