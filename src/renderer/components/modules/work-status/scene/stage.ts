import type { WorkRoom, WorkRoomsPayload } from "@shared/types";
import { employeeAvatarSrc } from "../../../employee-avatar/avatar-src";
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Object3D,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import {
  CSS3DObject,
  CSS3DRenderer,
} from "three/examples/jsm/renderers/CSS3DRenderer.js";
import {
  LAYOUT,
  LIGHTING,
  ROOM,
  createSharedGeometry,
  setWoodAnisotropy,
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
 * The 3D stage: one WebGL canvas, one CSS3D layer, one HTML HUD, and the rooms
 * of every in-progress task group.
 *
 * Deliberately imperative. React owns the module's chrome (header, fallback
 * grid, the progress card shown on a focused room's screen) and hands data in
 * through a small API; the scene itself is a render loop, because a 60 Hz
 * re-render of a React tree would dwarf the cost of drawing the rooms.
 *
 * What the boss asked for that shapes the code here:
 * - 45° bird's-eye over a grid of rooms, left click flies into a room, right
 *   click flies back (the wheel has no role: the boss disabled it entirely);
 * - bubbles over heads (working / last message) plus rest animations, which must
 *   not be cut short (that rule lives in `state-machine.ts`);
 * - the focused room's progress screen is a real DOM card (crisp text, clickable);
 * - nothing renders while the module is not on screen.
 */

export interface StageCallbacks {
  /** The focused room changed; `null` = back to the bird's-eye grid. */
  onFocusChange(chatId: number | null): void;
  /** The DOM element the focused room's progress card must be portalled into. */
  onScreenTarget(element: HTMLElement | null): void;
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

/** Screen (CSS3D) element size in CSS pixels; scaled down to the wall size. */
const SCREEN_CSS_WIDTH = 560;
const SCREEN_CSS_HEIGHT = 315;

/**
 * Room-to-room spacing (world units). Depth needs more than width: at a 45°
 * camera the near room's back wall reaches up the screen, and a tight row would
 * hide the row behind it.
 */
const ROOM_GAP_X = 5;
const ROOM_GAP_Z = 10;

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
  // Filmic response: the standard-material shell needs a little range so lit
  // surfaces and the self-lit screen read as different kinds of light.
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  // Wood grain seen at a grazing angle (a table top from the 45° camera) needs
  // anisotropic filtering, or the streaks alias into noise.
  setWoodAnisotropy(renderer.capabilities.getMaxAnisotropy());
  renderer.setClearColor(new Color(0x000000), 0);
  renderer.domElement.className = "imb-ws-canvas";
  container.appendChild(renderer.domElement);

  const cssRenderer = new CSS3DRenderer();
  cssRenderer.domElement.className = "imb-ws-css-layer";
  container.appendChild(cssRenderer.domElement);

  const hud = new HudLayer(container);
  const geometry = createSharedGeometry();
  const rig = new CameraRig(
    Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
  );

  // Two lights and no shadow maps: a room is read from a distance, and a depth
  // pass per room would cost more than the look is worth here.
  // One soft sky/ground pair plus a warm key light: enough shading to read the
  // volumes, no colour cast on the shell (the room's accent carries identity).
  let darkTheme = false;
  const hemi = new HemisphereLight(
    LIGHTING.light.sky,
    LIGHTING.light.ground,
    LIGHTING.light.hemi,
  );
  const sun = new DirectionalLight(0xfffaf2, LIGHTING.light.sun);
  sun.position.set(14, 22, 16);
  const ambient = new AmbientLight(0xffffff, LIGHTING.light.ambient);
  // A cool fill from the camera side keeps the shadowed faces readable; without
  // it the standard materials go muddy on the far side of every object.
  const fill = new DirectionalLight(0xdce6f2, 0.22);
  fill.position.set(-18, 10, 22);
  scene.add(hemi, sun, ambient, fill);

  function applyLighting(): void {
    const rig = darkTheme ? LIGHTING.dark : LIGHTING.light;
    hemi.color.setHex(rig.sky);
    hemi.groundColor.setHex(rig.ground);
    hemi.intensity = rig.hemi;
    sun.intensity = rig.sun;
    ambient.intensity = rig.ambient;
    fill.intensity = darkTheme ? 0.34 : 0.24;
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
  let hoverPerson: { chatId: number; employeeId: number } | null = null;
  let currentScreen: {
    chatId: number;
    object: CSS3DObject;
    element: HTMLDivElement;
  } | null = null;
  let rafId = 0;
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
    // `room depth` projects shorter than `room width` at 45°, so a room is
    // "wider" than it is tall on screen — hence the width/depth ratio below.
    const perRow = Math.round(
      Math.sqrt(count * aspect * (ROOM.width / ROOM.depth)),
    );
    return Math.max(1, Math.min(6, perRow));
  }

  function layoutGrid(): Box3 {
    const count = rooms.length;
    const columns = columnCount();
    const rows = Math.max(1, Math.ceil(count / columns));
    const pitchX = ROOM.width + ROOM_GAP_X;
    const pitchZ = ROOM.depth + ROOM_GAP_Z;
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
      // Fit the *contents*, not the wall tops: including the full wall height
      // would pull the camera back until the rooms shrink into the middle of
      // the pane. The wall top may sit just outside the frame.
      bounds.expandByPoint(
        new Vector3(x - ROOM.width / 2, 0, z - ROOM.depth / 2),
      );
      bounds.expandByPoint(
        new Vector3(x + ROOM.width / 2, 2.4, z + ROOM.depth / 2),
      );
    });

    // Frame at least two rooms wide: with one (or a couple of) task groups the
    // camera must not fly in to fill the pane — a single room would grow until its
    // name plate left the view, and the board would change scale as groups come
    // and go. The reference is the "two rooms" layout.
    const frameHalfWidth = Math.max(columns, 2) * pitchX * 0.5;
    const frameHalfDepth = Math.max(rows, 1) * pitchZ * 0.5;
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
    for (const room of rooms) {
      const entry = entries.get(room.chatId);
      if (!entry) continue;
      entry.handle.setScreenTexture(screens.get(room, darkTheme));
    }

    if (focusedChatId !== null && !entries.has(focusedChatId)) {
      // The room left the board (finished or deleted): do not stay focused on
      // nothing.
      exitFocus();
    }
    const bounds = layoutGrid();
    rig.setBirdBox(bounds);
    syncViews();
    buildScreen();
    hudDirty = true;
    needsRender = true;
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
          // Above the back wall, so the plate never covers the screen, and high
          // enough that it clears the room behind it on a dense board.
          anchor: entry.handle.group.localToWorld(
            new Vector3(0, ROOM.wallHeight + 3.1, -ROOM.depth / 2 + 0.2),
          ),
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

  // ── CSS3D screen of the focused room ─────────────────────────────────────

  function disposeScreen(): void {
    if (currentScreen === null) return;
    currentScreen.object.removeFromParent();
    currentScreen.element.remove();
    currentScreen = null;
    callbacks.onScreenTarget(null);
  }

  function buildScreen(): void {
    const entry = focusedChatId === null ? null : entries.get(focusedChatId);
    if (!entry) {
      disposeScreen();
      callbacks.onFocusChange(null);
      return;
    }
    if (
      currentScreen?.chatId === entry.room.chatId &&
      currentScreen.object.parent !== null
    ) {
      callbacks.onFocusChange(entry.room.chatId);
      return;
    }
    disposeScreen();
    const element = document.createElement("div");
    element.className = "imb-ws-screen";
    element.style.width = `${SCREEN_CSS_WIDTH}px`;
    element.style.height = `${SCREEN_CSS_HEIGHT}px`;
    const object = new CSS3DObject(element);
    object.position.copy(entry.handle.screenLocal);
    object.scale.set(
      LAYOUT.screen.width / SCREEN_CSS_WIDTH,
      LAYOUT.screen.height / SCREEN_CSS_HEIGHT,
      1,
    );
    entry.handle.group.add(object);
    currentScreen = { chatId: entry.room.chatId, object, element };
    callbacks.onScreenTarget(element);
    callbacks.onFocusChange(entry.room.chatId);
  }

  // ── interaction ─────────────────────────────────────────────────────────

  function updateHover(): void {
    if (!pointerInside) {
      hoverPerson = null;
      hoverRoomId = null;
      hoverScreenId = null;
      hud.setHover(null);
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
      needsRender = true;
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
    needsRender = true;
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
      if (entry.hover > 0) moving = true;
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
    roomBox.setFromCenterAndSize(
      entry.handle.group.position.clone().add(entry.handle.center),
      entry.handle.size,
    );
    rig.focusRoom(roomBox, performance.now());
    buildScreen();
    hudDirty = true;
    needsRender = true;
  }

  function exitFocus(): void {
    if (focusedChatId === null) return;
    drag = null;
    focusedChatId = null;
    rig.exitFocus(performance.now());
    disposeScreen();
    hudDirty = true;
    callbacks.onFocusChange(null);
    needsRender = true;
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
   * A left-button press is either a click or the start of a camera drag; which one
   * is decided by movement (`DRAG_THRESHOLD_PX`). Deciding on release is what lets
   * "drag to look around" and "click to open" share the same button.
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
        // Dragging right turns the room to the right; dragging down looks from
        // lower. Sensitivity in radians per pixel, clamped by the rig.
        rig.orbit(-dx * DRAG_ORBIT_SPEED, dy * DRAG_ORBIT_SPEED);
        renderer.domElement.style.cursor = "grabbing";
        needsRender = true;
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

  // ── frame loop ──────────────────────────────────────────────────────────

  function resize(): void {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width < 2 || height < 2) return;
    renderer.setSize(width, height, false);
    cssRenderer.setSize(width, height);
    rig.setAspect(width / height);
    needsRender = true;
  }

  const observer = new ResizeObserver(resize);
  observer.observe(container);

  function frame(): void {
    rafId = 0;
    if (disposed) return;
    // Not on screen: stop scheduling entirely. The module stays mounted (that is
    // what keeps the camera and focus), but nothing runs while it is hidden.
    if (!active) return;
    rafId = requestAnimationFrame(frame);
    const now = performance.now();

    let animating = false;
    if (rig.update(now)) animating = true;
    if (updateHoverAnimation()) animating = true;

    for (const [key, view] of views) {
      // Reduced motion: no rest animations at all (they are decoration), and the
      // views never need to animate.
      const next = reduceMotion ? view : tick(view, now);
      if (next !== view) {
        views.set(key, next);
        hudDirty = true;
      }
      if (!reduceMotion && (next.phase === "resting" || next.running)) {
        animating = true;
      }
    }

    if (animating || needsRender) {
      poseFigures(reduceMotion ? 0 : now);
      if (hudDirty) {
        syncHudContent();
        hudDirty = false;
      }
      hud.update(rig.camera);
      renderer.render(scene, rig.camera);
      cssRenderer.render(scene, rig.camera);
      needsRender = false;
    }
  }

  function startLoop(): void {
    if (disposed || rafId !== 0) return;
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop(): void {
    if (rafId === 0) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function onMotionPreference(): void {
    reduceMotion = motionQuery.matches;
    rig.setReducedMotion(reduceMotion);
    needsRender = true;
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

  function poseFigures(now: number): void {
    for (const entry of entries.values()) {
      for (const seat of entry.handle.seats) {
        const view = views.get(viewKey(entry.room.chatId, seat.employeeId));
        seat.figure.pose({
          now,
          working: view?.running === true && view.phase !== "resting",
          rest: view?.phase === "resting" ? (view.rest ?? null) : null,
          restProgress: view === undefined ? 0 : restProgress(view, now),
        });
      }
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
      cssRenderer.domElement.style.pointerEvents = next ? "" : "none";
      if (next) {
        resize();
        hudDirty = true;
        needsRender = true;
        startLoop();
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
      cssRenderer.domElement.remove();
      screens.dispose();
      scene.clear();
      for (const value of Object.values(geometry)) value.dispose();
    },
  };
}
