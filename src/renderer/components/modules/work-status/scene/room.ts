import {
  Box3,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  type Texture,
  Vector3,
} from "three";
import type { WorkRoom, WorkRoomMember } from "@shared/types";
import {
  LAYOUT,
  ROOM,
  buildContactShadow,
  buildLaptop,
  buildMug,
  buildNotepad,
  buildSunflower,
  buildWaterDispenser,
  buildAlocasia,
  createRoomMaterials,
  personPalettesFor,
  roomPaletteFor,
  tableWidthFor,
  type SharedGeometry,
} from "./art";
import { createFigure, type Figure } from "./figure";

/**
 * One task group as a room: shell, progress screen, the orchestrator's desk and
 * the meeting table with its seats.
 *
 * The room is rebuilt from scratch when its roster changes (people are seated in
 * a fixed order, so a joiner would otherwise have to shuffle everyone). Rebuilds
 * are rare and cheap; everything that changes every second — poses, bubbles,
 * which room is focused — is updated without touching the scene graph.
 */

export interface Seat {
  employeeId: number;
  member: WorkRoomMember;
  figure: Figure;
  /** Where the seat is, relative to the room group (for HUD projection). */
  position: Vector3;
  /** `1` = right-handed, `-1` = left-handed (mug side, animation arm). */
  mugSide: 1 | -1;
  /** Which way the seat faces (radians around Y). */
  rotationY: number;
}

export interface RoomHandle {
  chatId: number;
  group: Group;
  /** Centre and size of the room's bounding box (camera fitting). */
  center: Vector3;
  size: Vector3;
  /** World-space centre of the progress screen (CSS3D anchoring). */
  screenLocal: Vector3;
  seats: Seat[];
  /** Meshes that mean "this room" when picked (floor, desk, table). */
  pickTargets: Object3D[];
  /**
   * Meshes that mean "the room's progress screen" when picked. Separate from
   * `pickTargets` because the screen has its own action (open the group chat)
   * while the rest of the room is only a way to focus it.
   */
  screenTargets: Object3D[];
  /** Re-place the room in the grid (the grid changes with the room count). */
  place(x: number, z: number): void;
  /**
   * Draw the room's progress card on its screen. The grid renders it into a
   * texture (see `screen-texture.ts`); the focused room's CSS3D card covers it.
   */
  setScreenTexture(texture: Texture | null): void;
  dispose(): void;
}

interface SeatSlot {
  x: number;
  z: number;
  rotationY: number;
}

/**
 * Seats around the meeting table: the two long sides face each other over the
 * table, the two ends face inward. Order matters — it is how members are seated
 * (front row first, so the nearest people are the first ones the boss reads).
 */
function seatSlots(tableWidth: number, seatCount: number): SeatSlot[] {
  const slots: SeatSlot[] = [];
  const perSide = Math.min(
    LAYOUT.maxSeatsPerSide,
    Math.max(1, Math.ceil(Math.max(1, seatCount) / 2)),
  );
  const halfWidth = tableWidth / 2 - 0.9;
  const frontZ = LAYOUT.table.z + LAYOUT.table.depth / 2 + 1.2;
  const backZ = LAYOUT.table.z - LAYOUT.table.depth / 2 - 1.2;

  // A row is filled left to right before the next row starts: a group of three
  // sits together on the near side instead of being sprinkled over the table.
  for (let index = 0; index < perSide; index += 1) {
    const t = perSide === 1 ? 0.5 : index / (perSide - 1);
    const x = -halfWidth + t * halfWidth * 2;
    // Front row: backs to the viewer, facing the table (and the screen).
    slots.push({ x, z: frontZ, rotationY: Math.PI });
  }
  for (let index = 0; index < perSide; index += 1) {
    const t = perSide === 1 ? 0.5 : index / (perSide - 1);
    const x = -halfWidth + t * halfWidth * 2;
    slots.push({ x, z: backZ, rotationY: 0 });
  }
  const endX = tableWidth / 2 + 1.5;
  slots.push({ x: -endX, z: LAYOUT.table.z, rotationY: Math.PI / 2 });
  slots.push({ x: endX, z: LAYOUT.table.z, rotationY: -Math.PI / 2 });
  return slots;
}

export interface RoomBuildOptions {
  /** Dark theme: same rooms, sunk toward the app's dark chrome. */
  dark: boolean;
}

export function buildRoom(
  room: WorkRoom,
  geometry: SharedGeometry,
  options: RoomBuildOptions,
): RoomHandle {
  const palette = roomPaletteFor(room.chatId, options.dark);
  const materials = createRoomMaterials(palette, options.dark);
  const group = new Group();
  const pickTargets: Object3D[] = [];
  const screenTargets: Object3D[] = [];
  const figures: Figure[] = [];

  // ── shell ────────────────────────────────────────────────────────────────
  const floor = new Mesh(geometry.floor, materials.floor);
  floor.position.y = -ROOM.floorThickness / 2;
  group.add(floor);
  pickTargets.push(floor);

  const wall = new Mesh(geometry.wall, materials.wall);
  wall.position.set(0, ROOM.wallHeight / 2, -ROOM.depth / 2);
  group.add(wall);

  const trim = new Mesh(geometry.wall, materials.wallTrim);
  trim.scale.set(1, 0.12, 0.7);
  trim.position.set(0, ROOM.wallHeight, -ROOM.depth / 2);
  group.add(trim);

  // Baseboard: the line that makes a flat wall read as a wall.
  const baseboard = new Mesh(geometry.box, materials.wallTrim);
  baseboard.scale.set(ROOM.width, 0.3, 0.1);
  baseboard.position.set(
    0,
    0.15,
    -ROOM.depth / 2 + ROOM.wallThickness / 2 + 0.04,
  );
  group.add(baseboard);

  // ── progress screen ──────────────────────────────────────────────────────
  const bezel = new Mesh(geometry.box, materials.screenBezel);
  bezel.scale.set(
    LAYOUT.screen.width + 0.36,
    LAYOUT.screen.height + 0.36,
    0.16,
  );
  bezel.position.set(0, LAYOUT.screen.y, LAYOUT.screen.z);
  group.add(bezel);
  screenTargets.push(bezel);

  // The screen's picture is a texture of the progress card, not a lit surface:
  // `MeshBasicMaterial` keeps it readable and unaffected by the room's lighting
  // (a display emits its own light). It starts as the plain screen colour and the
  // stage swaps in a painted texture for every room.
  const screenMaterial = new MeshBasicMaterial({ color: 0xffffff });
  const screenFace = new Mesh(
    new PlaneGeometry(LAYOUT.screen.width, LAYOUT.screen.height),
    screenMaterial,
  );
  screenFace.position.set(0, LAYOUT.screen.y, LAYOUT.screen.z + 0.09);
  group.add(screenFace);
  screenTargets.push(screenFace);

  // A thin accent strip under the screen: the room's identity colour, and the
  // one place it is allowed to be saturated.
  const screenLocal = new Vector3(0, LAYOUT.screen.y, LAYOUT.screen.z + 0.1);

  function setScreenTexture(texture: Texture | null): void {
    if (texture === null) {
      screenMaterial.map = null;
      screenMaterial.color.setHex(0x2f353d);
    } else {
      screenMaterial.map = texture;
      screenMaterial.color.setHex(0xffffff);
    }
    screenMaterial.needsUpdate = true;
  }

  // ── the orchestrator's desk ──────────────────────────────────────────────
  const desk = LAYOUT.assistantDesk;
  const desktop = new Mesh(geometry.box, materials.deskTop);
  desktop.scale.set(desk.width, 0.16, desk.depth);
  desktop.position.set(0, desk.height, desk.z);
  group.add(desktop);
  pickTargets.push(desktop);

  // Four square legs, inset from the corners and flush with the top's underside,
  // plus a stretcher along the back: a desk needs to look like it stands, not like
  // it is balanced on two blades.
  const deskLegInsetX = 0.42;
  const deskLegInsetZ = desk.depth / 2 - 0.22;
  for (const sideX of [-1, 1]) {
    for (const sideZ of [-1, 1]) {
      const leg = new Mesh(geometry.box, materials.desk);
      leg.scale.set(0.18, desk.height - 0.02, 0.18);
      leg.position.set(
        sideX * (desk.width / 2 - deskLegInsetX),
        (desk.height - 0.02) / 2,
        desk.z + sideZ * deskLegInsetZ,
      );
      group.add(leg);
    }
  }
  const deskStretcher = new Mesh(geometry.box, materials.desk);
  deskStretcher.scale.set(desk.width - deskLegInsetX * 2, 0.12, 0.14);
  deskStretcher.position.set(0, desk.height * 0.35, desk.z - deskLegInsetZ);
  group.add(deskStretcher);

  const deskTopY = desk.height + 0.08;
  const deskLaptop = buildLaptop(geometry, materials);
  // The screen faces whoever uses it: the assistant sits behind the desk (at -z of
  // the laptop), so the laptop is turned 180° from its default (+z) orientation.
  deskLaptop.position.set(0, deskTopY, desk.z);
  deskLaptop.rotation.y = Math.PI;
  group.add(deskLaptop);

  // Paper notepad + pen on the *right* end of the desk (the boss moved them across
  // and turned them around), with a red cover so they read as a notebook rather
  // than as another wooden pad.
  const deskNotepad = buildNotepad(
    geometry,
    materials.notepad,
    materials.metal,
  );
  deskNotepad.forEach((part, index) => {
    part.position.set(
      // Toward the desk's right corner *and* back toward the assistant's edge: the
      // previous spot sat close enough to the outer edge to look about to fall off.
      index === 0 ? desk.width / 2 - 0.6 : desk.width / 2 - 0.95,
      deskTopY + 0.012 + (index === 0 ? 0 : 0.05),
      desk.z - 0.35,
    );
    // Turned 180° from the old placement (the spine now points the other way).
    part.rotation.y = Math.PI - 0.18;
  });
  group.add(...deskNotepad);

  const deskMug = buildMug(geometry, materials.mug);
  deskMug.position.set(desk.width / 2 - 0.7, deskTopY, desk.z + 0.2);
  deskMug.visible = false;
  group.add(deskMug);

  // A potted sunflower on the desk — a different object from the floor plants.
  const deskFlower = buildSunflower(geometry, materials);
  for (const part of deskFlower) {
    // Moved into the corner the notepad used to sit in, clear of its new place.
    part.position.x += -desk.width / 2 + 0.55;
    part.position.z += desk.z + 0.35;
    part.position.y += deskTopY;
  }
  group.add(...deskFlower);

  // ── meeting table ────────────────────────────────────────────────────────
  const seatCount = room.members.filter(
    (member) => !member.orchestrator,
  ).length;
  const tableWidth = tableWidthFor(seatCount);
  const table = new Mesh(geometry.box, materials.table);
  table.scale.set(tableWidth, 0.24, LAYOUT.table.depth);
  table.position.set(0, LAYOUT.table.height, LAYOUT.table.z);
  group.add(table);
  pickTargets.push(table);

  // Two trestle legs (slabs across the depth, inset from each end) joined by a
  // long stretcher: the shape a long meeting table actually has, and it reads as
  // stable from every angle.
  const tableLegHeight = LAYOUT.table.height - 0.26;
  const tableLegInsetX = Math.min(1.6, tableWidth * 0.22);
  for (const side of [-1, 1]) {
    const leg = new Mesh(geometry.box, materials.metal);
    leg.scale.set(0.22, tableLegHeight, LAYOUT.table.depth * 0.82);
    leg.position.set(
      side * (tableWidth / 2 - tableLegInsetX),
      tableLegHeight / 2,
      LAYOUT.table.z,
    );
    group.add(leg);

    // A foot pad under each trestle: the contact point, so nothing looks floating.
    const foot = new Mesh(geometry.box, materials.metal);
    foot.scale.set(0.34, 0.06, LAYOUT.table.depth * 0.9);
    foot.position.set(
      side * (tableWidth / 2 - tableLegInsetX),
      0.03,
      LAYOUT.table.z,
    );
    group.add(foot);
  }
  const tableStretcher = new Mesh(geometry.box, materials.metal);
  tableStretcher.scale.set(
    Math.max(0.5, tableWidth - tableLegInsetX * 2 - 0.2),
    0.1,
    0.16,
  );
  tableStretcher.position.set(0, tableLegHeight * 0.3, LAYOUT.table.z);
  group.add(tableStretcher);

  // ── seats ────────────────────────────────────────────────────────────────
  const slots = seatSlots(tableWidth, seatCount);
  const employees = room.members.filter((member) => !member.orchestrator);
  const orchestrator =
    room.members.find((member) => member.orchestrator) ?? null;
  const seats: Seat[] = [];
  // One shuffled wardrobe per room build: everyone inside differs, and the line-up
  // changes the next time the room is built.
  const wardrobe = personPalettesFor(
    Math.max(
      1,
      room.members.filter((member) => !member.orchestrator).length + 1,
    ),
  );

  function seat(
    member: WorkRoomMember,
    x: number,
    z: number,
    rotationY: number,
    seatIndex: number,
  ): Seat {
    // The wardrobe is walked by seat, not hashed per employee, so the people in
    // one room never share a look (see `personPaletteFor`).
    const paletteOf = wardrobe[seatIndex % wardrobe.length]!;
    // Left-handed every other seat: the mug on the table moves to that side and
    // the "coffee" animation lifts the other hand, which is one more way to tell
    // two seated people apart.
    const leftHanded = seatIndex % 2 === 1;
    const figure = createFigure({
      palette: paletteOf,
      geometry,
      mugColor: palette.mug,
      leftHanded,
      chair: {
        fabric: palette.chair,
        frame: palette.wallTrim,
        metal: palette.metal,
      },
    });
    figure.root.position.set(x, 0.06, z);
    figure.root.rotation.y = rotationY;
    group.add(figure.root);
    figures.push(figure);

    const shadow = buildContactShadow(geometry, materials.shadow, 1.35);
    shadow.position.set(x, ROOM.floorThickness / 2 + 0.01, z);
    group.add(shadow);

    return {
      employeeId: member.employeeId,
      member,
      figure,
      position: new Vector3(x, 0, z),
      mugSide: leftHanded ? -1 : 1,
      rotationY,
    };
  }

  if (orchestrator !== null) {
    // The orchestrator sits behind its desk, facing the viewer (the boss asked
    // for the assistant to look at the camera).
    const deskSeat = seat(
      orchestrator,
      0,
      desk.z - desk.depth / 2 - 1.15,
      0,
      0,
    );
    // Its mug is the one on the desk: the "coffee" animation picks that one up.
    deskSeat.figure.setHeldMug(deskMug);
    seats.push(deskSeat);
  }

  employees.forEach((member, index) => {
    const slot = slots[index % slots.length]!;
    // More members than seats: reuse the slots in a second ring, pushed out a
    // little, so nobody is dropped from the room.
    const ring = Math.floor(index / slots.length);
    const spread = ring * 1.15;
    const dirX = slot.x === 0 ? 0 : Math.sign(slot.x);
    const zOffset = slot.z > LAYOUT.table.z ? spread : -spread;
    seats.push(
      seat(
        member,
        slot.x + dirX * spread,
        slot.z + zOffset,
        slot.rotationY,
        // +1: the orchestrator took seat 0.
        index + 1,
      ),
    );
  });

  // Laptops for the seated employees (the orchestrator already has one).
  //
  // Everything is derived from the seat's own facing, so end seats and both sides
  // of the table work without special cases: `forward` points from the person
  // toward the table, the laptop sits on that line, and its screen faces back at
  // the person (the laptop's lid faces -z at rotation 0, so `rotation.y` is the
  // seat's own rotation).
  for (const item of seats) {
    if (item.member.orchestrator) continue;
    const forward = new Vector3(
      Math.sin(item.rotationY),
      0,
      Math.cos(item.rotationY),
    );
    const side = new Vector3(forward.z, 0, -forward.x);
    const surfaceY = LAYOUT.table.height + 0.12;
    const laptopPos = item.position.clone().addScaledVector(forward, 1.65);

    const laptop = buildLaptop(geometry, materials);
    // Positioned on the table between the occupant and the table centre, turned so
    // the screen faces the occupant (see `buildLaptop`: at rotation 0 the display
    // faces -z, so the laptop takes the seat's own facing rotation).
    laptop.position.set(laptopPos.x, surfaceY, laptopPos.z);
    // `+π`: the laptop's own default faces +z, while `forward` points away from the
    // occupant — so the screen ends up facing the person who sits there.
    laptop.rotation.y = item.rotationY + Math.PI;
    group.add(laptop);

    // The mug sits beside the laptop, on the owner's handed side.
    const mugPos = item.position
      .clone()
      .addScaledVector(forward, 1.15)
      .addScaledVector(side, item.mugSide * 0.62);
    // The mug exists only for the "coffee" animation, and only in the hand: it is
    // hidden here, and `pose()` puts it at the hand anchor while drinking.
    const mug = buildMug(geometry, materials.mug);
    mug.position.set(mugPos.x, surfaceY, mugPos.z);
    mug.visible = false;
    group.add(mug);
    item.figure.setHeldMug(mug);
  }

  // ── decor ────────────────────────────────────────────────────────────────
  // The corner plant: an Alocasia, at the room's right-front corner.
  const corner = buildAlocasia(geometry, materials);
  corner.position.set(ROOM.width / 2 - 1.5, 0, ROOM.depth / 2 - 1.6);
  corner.rotation.y = -0.4;
  group.add(corner);

  // Water dispenser in the left-front corner, its front turned toward the plant in
  // the opposite corner (per the boss's annotation).
  const dispenser = buildWaterDispenser(geometry, materials);
  dispenser.position.set(-ROOM.width / 2 + 1.5, 0, ROOM.depth / 2 - 1.6);
  // The model faces +z at rotation 0; the plant sits toward +x, so a quarter turn
  // aims the front at it.
  dispenser.rotation.y = Math.PI / 2;
  group.add(dispenser);

  const bounds = new Box3(
    new Vector3(-ROOM.width / 2, 0, -ROOM.depth / 2),
    new Vector3(ROOM.width / 2, ROOM.wallHeight, ROOM.depth / 2),
  );
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());

  return {
    chatId: room.chatId,
    group,
    center,
    size,
    screenLocal,
    seats,
    pickTargets,
    screenTargets,
    place(x: number, z: number): void {
      group.position.set(x, 0, z);
    },
    setScreenTexture,
    dispose(): void {
      for (const figure of figures) figure.dispose();
      figures.length = 0;
      // Per-room materials and the few inline planes die with the room; the
      // shared geometry set is owned by the stage and survives every rebuild.
      const sharedGeometry = new Set<unknown>(Object.values(geometry));
      const seen = new Set<Mesh["material"]>();
      group.traverse((child) => {
        if (!(child instanceof Mesh)) return;
        const list = Array.isArray(child.material)
          ? child.material
          : [child.material];
        for (const material of list) {
          if (seen.has(material)) continue;
          seen.add(material);
          material.dispose();
        }
        if (!sharedGeometry.has(child.geometry)) child.geometry.dispose();
      });
      group.clear();
    },
  };
}

/** Room identity for change detection: rebuild only when the seating changes. */
export function roomSignature(room: WorkRoom): string {
  return `${room.chatId}|${room.members
    .map((member) => `${member.employeeId}${member.orchestrator ? "*" : ""}`)
    .join(",")}`;
}
