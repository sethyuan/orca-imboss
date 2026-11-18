import type { WorkRoom, WorkRoomMember } from "@shared/types";
import {
  Box3,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
  type Object3D,
  type Texture,
} from "three";
import {
  CAMERA,
  FIGURE,
  LAYOUT,
  ROOM,
  SHADOW_OFFSET,
  DECAL_Y,
  buildContactShadow,
  buildLaptop,
  buildMug,
  buildNotepad,
  buildPalm,
  buildRug,
  buildSideboard,
  buildSunflower,
  buildWallClock,
  buildWaterDispenser,
  buildWindows,
  createRoomMaterials,
  personPalettesFor,
  roomPaletteFor,
  sharedGeometrySet,
  sharedMesh,
  tableWidthFor,
  type SharedGeometry,
} from "./art";
import { createFigure, type Figure } from "./figure";

/**
 * One task group as a room: the diorama shell (floor, two walls), the
 * progress screen, the orchestrator's desk and the meeting table with its seats.
 *
 * The room is rebuilt from scratch when its roster changes (people are seated in a
 * fixed order, so a joiner would otherwise have to shuffle everyone). Rebuilds are
 * rare and cheap; everything that changes every second — poses, bubbles, which room
 * is focused — is updated without touching the scene graph.
 *
 * The look is composed from `art.ts` only: the parts here are *placed*, and every
 * dimension/colour/material comes from the art layer. Static furniture is merged
 * per material, so a room with a dozen people is a few dozen draw calls rather
 * than a few hundred.
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
  /** The screen face's four world-space corners (the DOM proxy projects them). */
  screenRect(): Vector3[];
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
   * texture (see `screen-texture.ts`) at a higher resolution while the room is focused.
   */
  setScreenTexture(texture: Texture | null): void;
  /** Put the wall clocks at `hours:minutes` (the stage drives them). */
  setClockTime(hours: number, minutes: number): void;
  /** The room's world-space bounding box, for the camera and the name plate. */
  worldBox(): Box3;
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
  // A cut-open box: two walls (back and left — the camera looks in from the
  // front-right corner), no ceiling, no third wall, and **no base**. The walls'
  // thickness sits *inside* the room's footprint, so their outer faces are flush with the
  // floor slab's outer edges and the whole thing is one rectangular solid with two faces
  // removed — which is what every wall-mounted part is placed against (the screen, the
  // windows, the clock, the sideboard).
  const halfWidth = ROOM.width / 2;
  const halfDepth = ROOM.depth / 2;
  const thickness = ROOM.shellThickness;
  /** The walls' inner faces: the paint the room is measured from. */
  const innerX = -halfWidth + thickness;
  const innerZ = -halfDepth + thickness;
  /**
   * A hair of inset on the wall ends that face the room's open sides. There a wall's end
   * face lies in the same plane as the floor slab's side face, and two coplanar faces that
   * overlap z-fight into a bright sliver — exactly the "gap" that showed on both sides of
   * the floor.
   */
  const endInset = 0.02;
  /** Height of the wall's cut face: the darker cap along the top edge. */
  const capHeight = 0.16;
  const bodyHeight = ROOM.wallHeight - capHeight;

  const floor = new Mesh(geometry.rounded.floor, materials.floor);
  floor.position.y = -ROOM.shellThickness / 2;
  group.add(floor);
  pickTargets.push(floor);

  // The room's own ambient occlusion: a soft darkening toward the floor's edges,
  // which is what makes the floor read as enclosed rather than as a floating slab.
  const floorShade = new Mesh(geometry.panel, materials.floorShade);
  floorShade.rotation.x = -Math.PI / 2;
  floorShade.scale.set(ROOM.width, ROOM.depth, 1);
  floorShade.position.y = 0.008;
  floorShade.renderOrder = -2;
  group.add(floorShade);

  // The two walls are boxes **tiled without overlap**: the side wall owns the corner
  // column and the back wall starts at the side wall's inner face, so no two walls share a
  // face and nothing is left uncovered. (The corner notch between the two caps was a
  // 0.2 × 0.2 column that neither wall owned.)
  const sideWallPlan = {
    centreX: -halfWidth + thickness / 2,
    centreZ: -endInset / 2,
    spanX: thickness,
    spanZ: ROOM.depth - endInset,
  };
  const backWallPlan = {
    centreX: (innerX + halfWidth - endInset) / 2,
    centreZ: -halfDepth + thickness / 2,
    spanX: halfWidth - endInset - innerX,
    spanZ: thickness,
  };
  const wallBoxes = sharedMesh(geometry, "shell:walls", materials.wall, [
    {
      geometry: geometry.box,
      placement: {
        position: [
          sideWallPlan.centreX,
          bodyHeight / 2,
          sideWallPlan.centreZ,
        ] as const,
        scale: [sideWallPlan.spanX, bodyHeight, sideWallPlan.spanZ] as const,
      },
    },
    {
      geometry: geometry.box,
      placement: {
        position: [
          backWallPlan.centreX,
          bodyHeight / 2,
          backWallPlan.centreZ,
        ] as const,
        scale: [backWallPlan.spanX, bodyHeight, backWallPlan.spanZ] as const,
      },
    },
  ]);
  if (wallBoxes !== null) {
    group.add(wallBoxes);
    // The walls are the room's surfaces: in an isometric view they are most of what a
    // room shows, so leaving them inert made a click on the room do nothing whenever the
    // pointer happened to be over a wall.
    pickTargets.push(wallBoxes);
  }

  // The walls' **cut faces**: the top 0.16 of each wall in its own darker material, so the
  // room's upper edge reads against the module's light backdrop (and stays legible in the
  // dark theme) without a black outline.
  const wallCap = sharedMesh(geometry, "shell:wallCaps", materials.wallCap, [
    {
      geometry: geometry.box,
      placement: {
        position: [
          sideWallPlan.centreX,
          bodyHeight + capHeight / 2,
          sideWallPlan.centreZ,
        ] as const,
        scale: [sideWallPlan.spanX, capHeight, sideWallPlan.spanZ] as const,
      },
    },
    {
      geometry: geometry.box,
      placement: {
        position: [
          backWallPlan.centreX,
          bodyHeight + capHeight / 2,
          backWallPlan.centreZ,
        ] as const,
        scale: [backWallPlan.spanX, capHeight, backWallPlan.spanZ] as const,
      },
    },
  ]);
  if (wallCap !== null) group.add(wallCap);

  // The baseboard: a paler step at the wall's foot, its bottom sunk into the floor slab
  // (two coplanar faces there would read as a gap) and its two runs butted rather than
  // overlapped at the corner.
  const skirting = 0.07;
  const baseboardParts = [
    {
      geometry: geometry.box,
      placement: {
        position: [backWallPlan.centreX, 0.11, innerZ + skirting / 2] as const,
        scale: [backWallPlan.spanX, 0.26, skirting] as const,
      },
    },
    {
      geometry: geometry.box,
      placement: {
        position: [
          innerX + skirting / 2,
          0.11,
          (innerZ + skirting + halfDepth - endInset) / 2,
        ] as const,
        scale: [
          skirting,
          0.26,
          halfDepth - endInset - innerZ - skirting,
        ] as const,
      },
    },
  ];
  const baseboard = sharedMesh(
    geometry,
    "shell:baseboard",
    materials.wallTrim,
    baseboardParts,
  );
  if (baseboard !== null) group.add(baseboard);

  // ── progress screen ──────────────────────────────────────────────────────
  // Embedded in the wall: a thin frame sitting almost flush with the paint, high
  // enough that it never reaches the floor. Its picture is a **texture of the
  // progress card** (`MeshBasicMaterial`, so the display emits its own light and reads
  // unharmed by the room's lighting), painted at a higher resolution while the room is
  // focused. A texture, not DOM, is what lets whatever stands in front of the screen
  // occlude the card.
  const bezel = new Mesh(geometry.rounded.screenBezel, materials.screenBezel);
  bezel.position.set(0, LAYOUT.screen.y, LAYOUT.screen.z);
  group.add(bezel);
  screenTargets.push(bezel);

  const screenMaterial = new MeshBasicMaterial({ color: 0xffffff });
  const screenFace = new Mesh(
    new PlaneGeometry(LAYOUT.screen.width, LAYOUT.screen.height),
    screenMaterial,
  );
  screenFace.position.set(0, LAYOUT.screen.y, LAYOUT.screen.z + 0.09);
  group.add(screenFace);
  screenTargets.push(screenFace);

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
  const desktop = new Mesh(geometry.rounded.deskTop, materials.deskTop);
  desktop.position.set(0, desk.height, desk.z);
  group.add(desktop);
  pickTargets.push(desktop);

  // A panel-end desk: two side panels and a modesty board, all in the dark walnut
  // of the top, so it reads as one piece of furniture from every angle.
  const deskBody = sharedMesh(geometry, "desk:body", materials.desk, [
    ...[-1, 1].map((side) => ({
      geometry: geometry.rounded.deskPanel,
      placement: {
        position: [
          side * (desk.width / 2 - 0.18),
          (desk.height - 0.08) / 2,
          desk.z,
        ] as const,
      },
    })),
    {
      geometry: geometry.rounded.deskModesty,
      placement: {
        position: [
          0,
          desk.height - 0.42,
          desk.z - desk.depth / 2 + 0.22,
        ] as const,
      },
    },
  ]);
  if (deskBody !== null) group.add(deskBody);

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
      // Toward the desk's right corner *and* back toward the assistant's edge.
      index === 0 ? desk.width / 2 - 0.6 : desk.width / 2 - 0.95,
      deskTopY + 0.012 + (index === 0 ? 0 : 0.05),
      desk.z - 0.35,
    );
    // Turned round to face the assistant behind the desk, with a slight skew so it does
    // not look machine-aligned.
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

  const deskShadow = buildContactShadow(
    geometry,
    materials.ambientShadow,
    3.6,
    0.7,
  );
  deskShadow.position.x += SHADOW_OFFSET.x;
  deskShadow.position.z += desk.z + SHADOW_OFFSET.z;
  group.add(deskShadow);

  // ── meeting table ────────────────────────────────────────────────────────
  const seatCount = room.members.filter(
    (member) => !member.orchestrator,
  ).length;
  const tableWidth = tableWidthFor(seatCount);
  const table = new Mesh(geometry.rounded.tableTop, materials.table);
  // The one rounded part with a variable size: a narrower group sits at a narrower
  // table, and the corner radius distortion at these widths is imperceptible.
  table.scale.set(tableWidth / LAYOUT.table.maxWidth, 1, 1);
  table.position.set(0, LAYOUT.table.height, LAYOUT.table.z);
  group.add(table);
  pickTargets.push(table);

  // Two trestle legs joined by a stretcher, each on a foot pad: the shape a long
  // meeting table actually has, and it reads as stable from every angle.
  const tableLegHeight = LAYOUT.table.height - 0.26;
  const tableLegInsetX = Math.min(1.6, tableWidth * 0.22);
  const legParts: Array<{
    geometry: typeof geometry.box;
    placement: {
      position: readonly [number, number, number];
      scale?: readonly [number, number, number];
    };
  }> = [];
  for (const side of [-1, 1]) {
    legParts.push({
      geometry: geometry.rounded.tableLeg,
      placement: {
        position: [
          side * (tableWidth / 2 - tableLegInsetX),
          tableLegHeight / 2,
          LAYOUT.table.z,
        ],
        scale: [1, tableLegHeight / 0.92, 1],
      },
    });
    legParts.push({
      geometry: geometry.rounded.tableFoot,
      placement: {
        position: [
          side * (tableWidth / 2 - tableLegInsetX),
          0.04,
          LAYOUT.table.z,
        ],
      },
    });
  }
  legParts.push({
    geometry: geometry.box,
    placement: {
      position: [0, tableLegHeight * 0.3, LAYOUT.table.z],
      scale: [Math.max(0.5, tableWidth - tableLegInsetX * 2 - 0.2), 0.1, 0.16],
    },
  });
  // The key carries the width: the legs and the stretcher are placed from
  // `tableWidth`, so sharing one geometry across every room would make a two-person
  // table wear the legs of the first (wide) table that was built. Widths are a
  // handful of discrete values, so the cache stays small.
  const tableLegs = sharedMesh(
    geometry,
    `table:legs:${tableWidth.toFixed(2)}`,
    materials.metal,
    legParts,
  );
  if (tableLegs !== null) group.add(tableLegs);

  const tableShadow = buildContactShadow(
    geometry,
    materials.ambientShadow,
    Math.max(3.6, tableWidth * 0.52),
    0.62,
  );
  tableShadow.position.x += SHADOW_OFFSET.x * 0.5;
  tableShadow.position.z += LAYOUT.table.z + SHADOW_OFFSET.z;
  group.add(tableShadow);

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
    // one room never share a look (see `personPalettesFor`).
    const paletteOf = wardrobe[seatIndex % wardrobe.length]!;
    // Left-handed every other seat: the mug on the table moves to that side and
    // the "coffee" animation lifts the other hand, which is one more way to tell
    // two seated people apart.
    const leftHanded = seatIndex % 2 === 1;
    const figure = createFigure({
      palette: paletteOf,
      geometry,
      materials,
      leftHanded,
    });
    figure.root.position.set(x, FIGURE.rootY, z);
    figure.root.rotation.y = rotationY;
    group.add(figure.root);
    figures.push(figure);

    const shadow = buildContactShadow(geometry, materials.shadow, 1.3, 1.15);
    shadow.position.set(
      x + SHADOW_OFFSET.x * 0.4,
      DECAL_Y,
      z + SHADOW_OFFSET.z * 0.4,
    );
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
    const surfaceY = LAYOUT.table.height + 0.1;
    const laptopPos = item.position.clone().addScaledVector(forward, 1.65);

    const laptop = buildLaptop(geometry, materials);
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
  // The big-leaf plant now stands on the right-hand floor, by the screen wall (the boss
  // moved it there and put the sideboard in the corner it used to occupy).
  const corner = buildPalm(geometry, materials);
  const palmX = ROOM.width / 2 - 1;
  const palmZ = -ROOM.depth / 2 + 2.5;
  corner.position.set(palmX, 0, palmZ);
  corner.rotation.y = -0.5;
  group.add(corner);
  pickTargets.push(corner);
  const plantShadow = buildContactShadow(
    geometry,
    materials.ambientShadow,
    1.35,
    1.1,
  );
  plantShadow.position.set(
    palmX + SHADOW_OFFSET.x * 0.5,
    DECAL_Y,
    palmZ + SHADOW_OFFSET.z * 0.5,
  );
  group.add(plantShadow);

  // The sideboard along the window wall: long, low, under the windows (the boss's
  // reference), clear of the water dispenser and of the meeting table.
  const sideboard = buildSideboard(geometry, materials);
  sideboard.position.set(
    -ROOM.width / 2 + ROOM.shellThickness + LAYOUT.sideboard.depth / 2 + 0.05,
    0,
    LAYOUT.sideboard.z,
  );
  group.add(sideboard);
  pickTargets.push(sideboard);

  // The window wall (the one without the screen): two glowing windows fill it, with the
  // wall clock between them.
  const windows = buildWindows(geometry, materials);
  group.add(windows);
  pickTargets.push(windows);
  const clock = buildWallClock(geometry, materials, LAYOUT.clock.radius);
  // Hung on the wall's inner face, half of its rim sunk into the paint, and turned so
  // the dial faces +x — into the room.
  clock.group.position.set(innerX + 0.05, LAYOUT.clock.y, LAYOUT.clock.along);
  clock.group.rotation.y = Math.PI / 2;
  group.add(clock.group);
  pickTargets.push(clock.group);

  // The rug under the assistant's desk.
  const rug = buildRug(geometry, materials);
  group.add(rug);
  pickTargets.push(rug);

  // Water dispenser in the left-front corner, its front turned toward the plant in
  // the opposite corner (per the boss's annotation).
  const dispenser = buildWaterDispenser(geometry, materials);
  dispenser.position.set(-ROOM.width / 2 + 1.6, 0, ROOM.depth / 2 - 1.7);
  // The model faces +z at rotation 0; the plant sits toward +x, so a quarter turn
  // aims the front at it.
  dispenser.rotation.y = Math.PI / 2;
  group.add(dispenser);
  const dispenserShadow = buildContactShadow(
    geometry,
    materials.ambientShadow,
    1.15,
    1.1,
  );
  dispenserShadow.position.set(
    -ROOM.width / 2 + 1.6 + SHADOW_OFFSET.x * 0.4,
    DECAL_Y,
    ROOM.depth / 2 - 1.7 + SHADOW_OFFSET.z * 0.4,
  );
  group.add(dispenserShadow);

  // Every room is yawed into its isometric pose: the camera looks straight on, the
  // room is turned -45°, so the room reads exactly as before while the *grid* stays
  // upright on screen (see `CAMERA.roomYawDeg`).
  group.rotation.y = (CAMERA.roomYawDeg * Math.PI) / 180;

  // Shadows. Everything loose — furniture, people, plants, props — casts; the room's own
  // **container** does not. A wall, its cut face, the baseboard, the floor, the screen and
  // the windows are the box the room sits in: their shadows can only land on another part
  // of that box, which is how the cap overhanging the paint drew a slanted band down the
  // wall. The container only receives, and its volumes come from the baked AO instead
  // (`wallWashTexture` on the paint, `floorVignetteTexture` on the floor).
  const container: Object3D[] = [
    floor,
    floorShade,
    windows,
    bezel,
    screenFace,
    rug,
    clock.group,
  ];
  for (const optional of [wallBoxes, wallCap, baseboard]) {
    if (optional !== null) container.push(optional);
  }
  for (const part of container) part.userData.noShadow = true;
  group.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.castShadow = child.userData.noShadow !== true;
    child.receiveShadow = true;
  });
  for (const part of container) {
    part.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.castShadow = false;
    });
  }

  const worldBoxValue = new Box3();

  return {
    chatId: room.chatId,
    group,
    seats,
    pickTargets,
    screenTargets,
    place(x: number, z: number): void {
      group.position.set(x, 0, z);
      group.updateMatrixWorld(true);
      worldBoxValue.setFromObject(group);
    },
    worldBox(): Box3 {
      return worldBoxValue;
    },
    screenRect(): Vector3[] {
      const halfWidth = LAYOUT.screen.width / 2;
      const halfHeight = LAYOUT.screen.height / 2;
      const z = LAYOUT.screen.z + 0.09;
      // Around the screen's own centre (`LAYOUT.screen.y`), not the room's floor: a
      // quad built around y = 0 put the DOM proxy down on the desk.
      return [
        [-halfWidth, LAYOUT.screen.y - halfHeight],
        [halfWidth, LAYOUT.screen.y - halfHeight],
        [halfWidth, LAYOUT.screen.y + halfHeight],
        [-halfWidth, LAYOUT.screen.y + halfHeight],
      ].map(([x, y]) => group.localToWorld(new Vector3(x!, y!, z)));
    },
    setClockTime(hours: number, minutes: number): void {
      clock.setTime(hours, minutes);
    },
    setScreenTexture,
    dispose(): void {
      // Figures own their material/geometry cleanup (so a figure is usable outside a
      // room), which means they must leave the graph first: the traversal below
      // would otherwise dispose the same objects a second time and make `seen` look
      // like it was guarding something.
      for (const figure of figures) {
        figure.dispose();
        figure.root.removeFromParent();
      }
      figures.length = 0;
      // Per-room materials and the merged geometries die with the room; the
      // shared geometry set is owned by the stage and survives every rebuild.
      const shared = sharedGeometrySet(geometry);
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
        if (!shared.has(child.geometry)) child.geometry.dispose();
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
