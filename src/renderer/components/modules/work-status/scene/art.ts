import {
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * The art layer of the work-status rooms: every dimension, colour, material and
 * decorative prop lives here, and nowhere else.
 *
 * The scenes are procedural (no modelled assets) on purpose — the app ships no
 * 3D files, and a room has to be built from code for an arbitrary number of task
 * groups. Keeping the whole look in one module is what makes a later art pass a
 * one-file change: swap the palettes, the materials or a `build*` helper and the
 * scene code that composes them stays untouched.
 *
 * The look is an isometric diorama: an orthographic camera straight on with a 30°
 * pitch, and every room turned -45° about Y, so each room is seen from its
 * front-right corner with two walls — a back wall and a left wall — standing behind
 * the furniture while the grid on screen stays upright. Materials are matte and rounded (nothing glossy, no
 * sharp edges), the light is a soft studio rig, and colour comes from the room's
 * accent (pale walls, chair fabric) over a warm wood floor.
 */

/** Room shell, in world units (1 ≈ 40 cm). */
export const ROOM = {
  width: 16,
  depth: 13,
  wallHeight: 6.1,
  /**
   * The shell's one thickness: walls and floor are cut from the same slab, so the room
   * reads as a box with two faces removed — the floor's underside and the walls' outer
   * faces lie on one outline, with no base, ledge or seam between them.
   */
  shellThickness: 0.4,
} as const;

const YAW_DEG = 45;
const COS_YAW = Math.cos((YAW_DEG * Math.PI) / 180);

/**
 * The camera's look-down angle, in degrees.
 *
 * The boss asked for a *lower* default than the textbook isometric 35.26°: at 30° the
 * room shows more wall and the wall screen is easier to read, and the rows simply need
 * more world depth (a z step shrinks by `sin(pitch)` on screen). Both the camera and
 * the grid derive from this one number, so they cannot drift apart.
 */
const PITCH_DEG = 30;

/**
 * A room's footprint once it is yawed into its isometric pose: the 16 × 13
 * rectangle turned 45° is a 20.5 × 20.5 diamond in plan, and on screen it is that
 * diamond's width by `plan · sin(pitch) + wallHeight · cos(pitch)` tall.
 */
export const ROOM_FOOTPRINT = {
  /** Plan-space width and depth of the yawed room (the diamond's bounding box). */
  plan: (ROOM.width + ROOM.depth) * COS_YAW,
} as const;

/**
 * Room-to-room pitch, in world units.
 *
 * The board is an upright grid on screen (each room is yawed, the camera is not), so
 * the pitch has to clear the room's *yawed* footprint — its diamond is 20.5 wide in
 * plan even though the room itself is 16. A row step needs more world depth than a
 * column step because the camera looks down: a world z step of `d` only separates
 * rooms by `d · sin(pitch)` on screen.
 */
export const GRID = (() => {
  const rad = (PITCH_DEG * Math.PI) / 180;
  const screenHeight =
    ROOM_FOOTPRINT.plan * Math.sin(rad) + ROOM.wallHeight * Math.cos(rad);
  return {
    /** Clear air between two rooms of one row. */
    gapX: 5,
    /** Clear air between two rows. */
    gapZ: 4,
    pitchX: ROOM_FOOTPRINT.plan + 5,
    /** The screen-space room height, divided back out of the foreshortening. */
    pitchZ: screenHeight / Math.sin(rad) + 4,
    /** How tall a room is on screen (wide / tall), for choosing a row's length. */
    roomAspect: ROOM_FOOTPRINT.plan / screenHeight,
  } as const;
})();

/** Where things sit inside a room (local coordinates, +z toward the viewer). */
export const LAYOUT = {
  /**
   * Progress screen: embedded in the far wall, above the assistant's desk and
   * clear of the floor (it is a wall display, not a floor-standing board).
   */
  screen: {
    width: 12.6,
    /**
     * Height 4.9 centred on the wall: margins of 0.6 above the floor and 0.6 below
     * the wall top. That is the largest screen that is *both* vertically centred and
     * off the floor (a taller one cannot be both), and it still holds eight rows.
     */
    height: 4.9,
    y: ROOM.wallHeight / 2 + 0.15,
    z: -ROOM.depth / 2 + ROOM.shellThickness + 0.02,
  },
  /**
   * The assistant's desk, between the screen and the meeting table. Pushed towards
   * the screen so the orchestrator's corner reads as its own workstation instead of
   * a second seat at the meeting table.
   */
  assistantDesk: { width: 4.6, height: 1.05, depth: 1.9, y: 0, z: -2.6 },
  /**
   * The low sideboard against the window wall: long along the wall (z), shallow enough to
   * stand against the paint, and low enough to stay under the windows (sill 2.4).
   */
  sideboard: { length: 3.4, height: 1.9, depth: 1, z: -0.1 },
  /** The rug the assistant's desk stands on (a light rug with a thin border). */
  rug: { width: 8.2, height: 0.03, depth: 5.2, z: -3.0 },
  /**
   * The window wall (the one without the screen): **one window either side of the
   * middle and the clock in the middle**, symmetrical about the wall's centre. Both
   * windows are the same size and style, mirrored, with muntins dividing the glass.
   * They are recessed into the paint — no sill, no ledge, nothing to stand on.
   */
  windows: {
    sillY: 2.4,
    height: 2.9,
    /** Centres (`z` along the wall) and width; the pair is mirrored about z = 0. */
    z: 3.35,
    width: 3.2,
    /** The outer frame's bar thickness, and the slim muntins that divide the glass. */
    frameWidth: 0.16,
    muntinWidth: 0.12,
  },
  /**
   * The wall clock: **one**, centred between the two windows on the window wall (local
   * `along` is its `z` along that wall). It is a real clock — the stage drives its hands.
   */
  clock: { along: 0, y: 4.55, radius: 0.74 },
  /**
   * The long meeting table the employees sit around. Its width follows the
   * seating (`tableWidthFor`), so a two-person group does not sit at a table
   * built for ten.
   */
  table: { maxWidth: 10.6, minWidth: 5.2, height: 1.05, depth: 2.6, z: 2.6 },
  /** Seats along the long sides, per side, at most. */
  maxSeatsPerSide: 4,
} as const;

/**
 * Camera: straight on, and **every room yawed into its isometric pose**.
 *
 * Turning the camera 45° made the whole board diagonal (a honeycomb, with name
 * plates fighting the room behind). Instead the camera looks straight down +z and
 * each room is rotated -45° about Y: the room is still seen from its own corner at
 * 45°, so it looks exactly the same, while the grid stays upright on screen and a
 * plate can sit straight above its room.
 *
 * The pitch is the boss's "a bit lower" default (30°, not the textbook 35.26°): it
 * shows more of the walls and keeps the wall screen more readable, at the cost of
 * needing a deeper row pitch (a world z step shrinks by sin(pitch) on screen).
 * There is no user zoom: the frame fits the grid (bird's eye) or one room (focus).
 */
export const CAMERA = {
  /** The camera itself is not turned; the rooms are (see `roomYawDeg`). */
  azimuthDeg: 0,
  /** Every room is turned by this much so it reads as an isometric diorama. */
  roomYawDeg: -YAW_DEG,
  pitchDeg: PITCH_DEG,
  /** Breathing room around the whole grid. */
  birdFill: 1.06,
  /**
   * Focus: how much of the frame the room's contents take. The wall top may sit
   * just outside it — fitting the whole cuboid would pull back until the room
   * reads as a plan view and the wall screen shrinks below reading size.
   */
  focusFill: 1.0,
  /**
   * Where the focused camera looks, relative to the room's box centre. A touch
   * below the middle: the wall top is empty paint, the table is the subject.
   */
  focusTargetOffsetY: -0.5,
  /** Focus ↔ bird's-eye transition (ms). */
  transitionMs: 650,
  /**
   * How far a focused room can be **turned on its own axis** by dragging (radians).
   *
   * Dragging turns the room, not the camera: looking around inside a room is what the
   * gesture means, and a camera that swung sideways used to slide the neighbouring
   * rooms into the frame. The camera's pose is fixed while focused.
   */
  roomOrbitLimit: 0.6,
  /** Orthographic clipping range (the camera sits `distance` away). */
  near: 1,
  far: 2000,
  distance: 320,
} as const;

export interface LightRig {
  /** Hemisphere: sky above, bounced light from the floor below. */
  sky: number;
  ground: number;
  hemi: number;
  /** Main light: warm, high and to the front-right of the rooms. */
  key: number;
  keyIntensity: number;
  /** Fill: cool, low and to the front-left, keeps the shadow side readable. */
  fill: number;
  fillIntensity: number;
  /** Rim: separates the wall tops from the backdrop. */
  rim: number;
  rimIntensity: number;
  ambient: number;
  exposure: number;
}

/**
 * A studio rig per theme: one warm key (the only light that casts), one cool fill, a
 * rim from behind and the hemisphere pair. The key is deliberately shallow next to the
 * fill and the hemisphere: the shadows it throws are meant to ground the furniture, not
 * to draw dark stripes across a floor that is mostly mid-tone.
 */
export const LIGHTING: Record<"light" | "dark", LightRig> = {
  light: {
    sky: 0xffffff,
    ground: 0x9a8b7d,
    hemi: 1.0,
    key: 0xfff1dc,
    keyIntensity: 1.15,
    fill: 0xd6e6f6,
    fillIntensity: 0.55,
    rim: 0xffffff,
    rimIntensity: 0.42,
    ambient: 0.22,
    exposure: 1.0,
  },
  dark: {
    sky: 0xdfe6f0,
    ground: 0x24282e,
    hemi: 0.7,
    key: 0xffeedd,
    keyIntensity: 0.85,
    fill: 0xb9c8dc,
    fillIntensity: 0.55,
    rim: 0xe8eef8,
    rimIntensity: 0.32,
    ambient: 0.2,
    exposure: 1.0,
  },
};

/**
 * Shadow settings for the one directional light.
 *
 * A real shadow map is what stops furniture from looking pasted on the floor; it is
 * affordable now that the board holds twelve rooms and the bird's-eye view freezes
 * (the map is re-rendered only when something changes). One light covers the whole
 * board: `mapSize` 1024 over the board's ~150 world units in the bird's-eye view, and the
 * same map over a single ~32-unit room while focused — so the *fit* of the shadow camera
 * is what decides the softness, not these numbers alone (see `fitShadow` in the stage).
 */
export const SHADOW = {
  /**
   * 1024, deliberately small: with PCFSoft the softness comes from the map's texel
   * size, so a coarser map over the whole board is what turns "cut out with scissors"
   * into the soft blob the reference has. (`shadow.radius` is deliberately not set: it is
   * honoured by PCF and VSM, not by PCFSoft, so a value here would only mislead.)
   */
  mapSize: 1024,
  /** Extra world units around the fitted sphere, so nothing at the edge is clipped. */
  padding: 6,
  /**
   * Depth offset, in *normalised* depth: a fixed value is a different world-space offset
   * on every shadow camera, because the range it is expressed against is the camera's own
   * near→far span. The acne that would justify a bigger number is handled by `normalBias`
   * instead, which three applies in world units.
   */
  bias: -0.0006,
  /** World-unit offset along the surface normal: the acne guard, one texel is plenty. */
  normalBias: 0.03,
} as const;

/**
 * Where the lights stand, as unit directions from a room's centre.
 *
 * The key comes in over the **window wall** (the rooms' -x side): the windows are
 * emissive, so light falling from there is what the eye expects, and the shadows
 * fall away from the windows into the room.
 */
export const LIGHT_POSITIONS = {
  /**
   * A steep key (~70° above the floor): a low sun stretched every shadow across the
   * floor, which the boss read as "too long" — and it also fought the soft, grounded
   * look of the reference. The fill and rim stay low and soft.
   */
  key: new Vector3(-0.62, 2.4, 0.42).normalize(),
  fill: new Vector3(0.9, 0.5, 0.6).normalize(),
  rim: new Vector3(0.3, 0.5, -1).normalize(),
} as const;

export interface RoomPalette {
  /** Pale accent paint on both walls. */
  wall: number;
  /** Baseboard: a near-white step of the same paint. */
  wallTrim: number;
  /** The wall's **cut face** (its top edge), a clear step darker than the paint. */
  wallCap: number;
  /** The diorama base under the floor. */
  desk: number;
  deskTop: number;
  table: number;
  chair: number;
  chairFrame: number;
  /** The rug under the assistant's desk: a light field and its darker border. */
  rug: number;
  rugBorder: number;
  metal: number;
  screenBezel: number;
  screenFace: number;
  accent: number;

  laptop: number;
  mug: number;
}

/**
 * One palette per room, picked deterministically from the chat id, so a given
 * task group always looks the same (coming back to the board must not reshuffle
 * the room's identity).
 *
 * Only `accent` really differs: the walls are painted in a pale step of it and the
 * chair fabric carries a hint, which is what tells two rooms apart at a glance.
 * The wood and metal values are shared, so the board reads as one office.
 */
export const ROOM_PALETTES: readonly RoomPalette[] = [
  {
    wall: 0xffffff,
    wallTrim: 0xffffff,
    wallCap: 0xc9c4bc,
    desk: 0x4a3226,
    deskTop: 0x4a3226,
    table: 0xc8a271,
    chair: 0x5f6f7c,
    chairFrame: 0xe6e3dd,
    metal: 0x9aa3ac,
    screenBezel: 0x2b2f36,
    screenFace: 0x323943,
    accent: 0x07c160,
    rug: 0xdfe3dd,
    rugBorder: 0xc9cec7,
    laptop: 0xb9bec6,
    mug: 0xd9876a,
  },
  {
    wall: 0xffffff,
    wallTrim: 0xffffff,
    wallCap: 0xc9c4bc,
    desk: 0x4a3226,
    deskTop: 0x4a3226,
    table: 0xc8a271,
    chair: 0x5a6876,
    chairFrame: 0xe6e3dd,
    metal: 0x8e97a1,
    screenBezel: 0x262a31,
    screenFace: 0x2c333d,
    accent: 0x3f8cff,
    rug: 0xdde2e3,
    rugBorder: 0xc6cccd,
    laptop: 0xb2b8c0,
    mug: 0xe0b46a,
  },
  {
    wall: 0xffffff,
    wallTrim: 0xffffff,
    wallCap: 0xc9c4bc,
    desk: 0x4a3226,
    deskTop: 0x4a3226,
    table: 0xc8a271,
    chair: 0x6b5a49,
    chairFrame: 0xe8e3dc,
    metal: 0xa49a90,
    screenBezel: 0x2d2a27,
    screenFace: 0x352f2b,
    accent: 0xfa9d3c,
    rug: 0xe2e1d9,
    rugBorder: 0xcdcbc2,
    laptop: 0xc0bcb6,
    mug: 0x7fa8c9,
  },
  {
    wall: 0xffffff,
    wallTrim: 0xffffff,
    wallCap: 0xc9c4bc,
    desk: 0x4a3226,
    deskTop: 0x4a3226,
    table: 0xc8a271,
    chair: 0x59665c,
    chairFrame: 0xe6e5df,
    metal: 0x939d97,
    screenBezel: 0x272d2b,
    screenFace: 0x2e3634,
    accent: 0x8f6bd8,
    rug: 0xdee2dc,
    rugBorder: 0xc8cec6,
    laptop: 0xb4bab5,
    mug: 0xc98f8f,
  },
] as const;

export type HairStyle = "short" | "bob" | "bun" | "ponytail" | "curly" | "buzz";

export interface PersonPalette {
  skin: number;
  hair: number;
  hairStyle: HairStyle;
  shirt: number;
  /** Sleeve/placket blocks: a shade of the shirt, so the arms separate from it. */
  shirtDark: number;
  pants: number;
  shoes: number;
}

/** Skin tones, hair colours and the two clothing colours combined below. */
const SKIN_TONES = [
  0xf0c9a6, 0xe0b08c, 0xf6d6bb, 0xc99874, 0xecc4a4, 0xd0a279, 0xc78d63,
  0xf2cfae,
] as const;
const HAIR_COLORS = [
  0x2f2620, 0x171412, 0x7a5136, 0x3a2c22, 0xa89480, 0x5a4130,
] as const;
const HAIR_STYLES: readonly HairStyle[] = [
  "short",
  "bob",
  "bun",
  "ponytail",
  "curly",
  "short",
  "buzz",
  "bob",
];
const SHIRTS = [
  0x6f8fb0, 0xb08468, 0x7ba172, 0xa2768f, 0x8288b4, 0xd8ad57, 0x5f9c9c,
  0xb1705f, 0x6f7f9e, 0xe8e4dc,
] as const;
const PANTS = [0x3f4a58, 0x4d4436, 0x2f3a44, 0x5a4a5e, 0x6b6b6b] as const;
const SHOES = [0x2c2a28, 0x3b3230, 0x22242a] as const;

/** Darken a colour for its shaded blocks (sleeves, collars). */
function shade(hex: number, amount: number): number {
  return new Color(hex).lerp(new Color(0x000000), amount).getHex();
}

/**
 * Everyone in a room must be tellable apart, so the wardrobe is a *list* the room
 * seats people from rather than a per-person hash: hair colour walks with the
 * seat, shirt colour walks faster and the pants/hair style step slower, so the
 * crossing gives 48 looks before anything repeats exactly. Across rooms the
 * starting offset comes from a fresh shuffle (see `personPalettesFor`).
 */
export const PERSON_WARDROBE: readonly PersonPalette[] = Array.from(
  { length: 48 },
  (_unused, index) => {
    const shirt = SHIRTS[index % SHIRTS.length]!;
    return {
      skin: SKIN_TONES[index % SKIN_TONES.length]!,
      hair: HAIR_COLORS[(index * 5) % HAIR_COLORS.length]!,
      hairStyle: HAIR_STYLES[(index * 3) % HAIR_STYLES.length]!,
      shirt,
      shirtDark: shade(shirt, 0.24),
      pants: PANTS[(index * 2) % PANTS.length]!,
      shoes: SHOES[index % SHOES.length]!,
    };
  },
);

/** Deterministic pick that never depends on array order churn. */
function pick<T>(items: readonly T[], seed: number): T {
  const index = Math.abs(Math.trunc(seed)) % items.length;
  return items[index]!;
}

/** Width of the meeting table for `seatCount` people (2 per row of seats). */
export function tableWidthFor(seatCount: number): number {
  const perRow = Math.max(1, Math.ceil(Math.max(1, seatCount) / 2));
  return Math.min(
    LAYOUT.table.maxWidth,
    Math.max(LAYOUT.table.minWidth, 3.1 + perRow * 1.8),
  );
}

function sink(hex: number, toward: number, amount: number): number {
  return new Color(hex).lerp(new Color(toward), amount).getHex();
}

const DARK_SHELL = 0x30343a;
const DARK_INK = 0x22262b;

/**
 * Dark theme: the same rooms, sunk toward the app's dark chrome.
 *
 * Derived rather than hand-written as a second palette set, because a replica
 * would drift the moment a light palette is tuned. Only the *shell* goes dark —
 * the accent, the mugs and the screen glass keep their identity, which is what
 * makes a room still recognisable in the dark.
 */
function darkPalette(palette: RoomPalette): RoomPalette {
  return {
    wall: palette.wall,
    wallTrim: palette.wallTrim,
    wallCap: palette.wallCap,
    desk: sink(palette.desk, DARK_SHELL, 0.12),
    deskTop: sink(palette.deskTop, DARK_SHELL, 0.12),
    table: sink(palette.table, DARK_SHELL, 0.5),
    chair: sink(palette.chair, DARK_INK, 0.3),
    chairFrame: sink(palette.chairFrame, DARK_INK, 0.55),
    metal: sink(palette.metal, DARK_INK, 0.5),
    screenBezel: sink(palette.screenBezel, 0x0b0d10, 0.5),
    screenFace: sink(palette.screenFace, 0x0b0d10, 0.5),
    accent: palette.accent,
    rug: sink(palette.rug, DARK_INK, 0.62),
    rugBorder: sink(palette.rugBorder, DARK_INK, 0.62),
    laptop: sink(palette.laptop, DARK_SHELL, 0.62),
    mug: palette.mug,
  };
}

export function roomPaletteFor(chatId: number, dark = false): RoomPalette {
  const base = pick(ROOM_PALETTES, chatId * 7 + 3);
  const palette = dark ? darkPalette(base) : base;
  const accent = new Color(palette.accent);
  const accentHsl = { h: 0, s: 0, l: 0 };
  accent.getHSL(accentHsl);

  const paint = (saturation: number, lightness: number): number =>
    new Color().setHSL(accentHsl.h, saturation, lightness).getHex();

  // Both walls are painted in a *pale* step of the room's accent: an off-white
  // with a hint of the identity hue. A saturated wall competes with the wardrobe,
  // which has to stay the loudest thing on screen.
  const wallLight = 0.84;
  const wallDark = 0.29;
  // The chairs are the second-largest surface in a room, so they carry the accent
  // too — muted, roughly the wall's saturation and half its lightness, which reads
  // as "this room's colours" without competing with the wardrobe.
  const chairPaint = (saturation: number, lightness: number): number =>
    new Color().setHSL(accentHsl.h, saturation, lightness).getHex();
  return {
    ...palette,
    wall: paint(dark ? 0.5 : 0.62, dark ? wallDark : wallLight),
    // The baseboard is a near-white step of the paint: it is what makes a flat wall
    // meet the floor with a lit edge instead of a printed line.
    wallTrim: paint(dark ? 0.2 : 0.2, dark ? wallDark + 0.26 : 0.97),
    // The cut face is a *material* difference, not a black outline: a step darker and a
    // little more saturated than the paint, so the room's upper edge is legible on the
    // module's light grey backdrop (and stays legible in the dark theme).
    wallCap: paint(dark ? 0.34 : 0.4, dark ? wallDark + 0.12 : 0.62),
    chair: chairPaint(dark ? 0.26 : 0.3, dark ? 0.28 : 0.36),
    chairFrame: palette.chairFrame,
  };
}

/**
 * The looks of the people in one room, in seat order: a **freshly shuffled** deck
 * per room build, so everyone in the room is different (the guarantee the boss
 * cares about) and the line-up changes every time the room is rebuilt — that is
 * what he asked for over "the same board always looks the same".
 *
 * The shuffle uses `Math.random` on purpose: this is cosmetic, and a cached key
 * would reintroduce the repetition he complained about.
 */
export function personPalettesFor(seatCount: number): PersonPalette[] {
  const deck = [...PERSON_WARDROBE];
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[swap]] = [deck[swap]!, deck[index]!];
  }
  const result: PersonPalette[] = [];
  for (let index = 0; index < seatCount; index += 1) {
    result.push(deck[index % deck.length]!);
  }
  return result;
}

/**
 * Rounded boxes, one per named part.
 *
 * The diorama has no sharp edges: a chamfered corner is what separates "cartoon
 * furniture" from "painted boxes". Each part is built **once** for the whole
 * scene (they are all the same size — only people's colours and the table's width
 * vary), so this costs a few kilobytes of geometry no matter how many rooms are on
 * the board.
 */
export type RoundedPart =
  | "floor"
  | "screenBezel"
  | "deskTop"
  | "deskPanel"
  | "deskModesty"
  | "tableTop"
  | "tableLeg"
  | "tableFoot"
  | "chairSeat"
  | "chairBack"
  | "chairArmPad"
  | "chairLumbar"
  | "laptopBody"
  | "laptopLid"
  | "dispenserBody"
  | "dispenserTop"
  | "hip"
  | "chest"
  | "shoe"
  | "eyeBrow"
  | "rug"
  | "rugBorder";

const ROUNDED_PARTS: Record<
  RoundedPart,
  { size: readonly [number, number, number]; radius: number }
> = {
  floor: { size: [ROOM.width, ROOM.shellThickness, ROOM.depth], radius: 0 },
  screenBezel: {
    size: [LAYOUT.screen.width + 0.3, LAYOUT.screen.height + 0.3, 0.16],
    radius: 0.12,
  },
  deskTop: {
    size: [LAYOUT.assistantDesk.width, 0.16, LAYOUT.assistantDesk.depth],
    radius: 0.06,
  },
  deskPanel: { size: [0.16, 1.0, 1.6], radius: 0.06 },
  deskModesty: { size: [4.2, 0.62, 0.12], radius: 0.05 },
  tableTop: {
    size: [LAYOUT.table.maxWidth, 0.24, LAYOUT.table.depth],
    radius: 0.08,
  },
  tableLeg: { size: [0.26, 0.92, LAYOUT.table.depth * 0.78], radius: 0.07 },
  tableFoot: { size: [0.42, 0.08, LAYOUT.table.depth * 0.86], radius: 0.03 },
  chairSeat: { size: [0.92, 0.16, 0.88], radius: 0.08 },
  chairBack: { size: [0.78, 0.84, 0.16], radius: 0.07 },
  chairArmPad: { size: [0.17, 0.07, 0.52], radius: 0.03 },
  chairLumbar: { size: [0.62, 0.3, 0.12], radius: 0.05 },
  laptopBody: { size: [1.12, 0.08, 0.78], radius: 0.035 },
  laptopLid: { size: [1.08, 0.05, 0.74], radius: 0.025 },
  dispenserBody: { size: [0.62, 1.05, 0.52], radius: 0.07 },
  dispenserTop: { size: [0.66, 0.07, 0.56], radius: 0.03 },
  hip: { size: [0.62, 0.36, 0.46], radius: 0.14 },
  chest: { size: [0.72, 0.62, 0.48], radius: 0.16 },
  shoe: { size: [0.24, 0.14, 0.4], radius: 0.06 },
  eyeBrow: { size: [0.14, 0.035, 0.04], radius: 0.015 },
  rug: {
    size: [LAYOUT.rug.width, LAYOUT.rug.height, LAYOUT.rug.depth],
    radius: 0.06,
  },
  rugBorder: {
    size: [LAYOUT.rug.width + 0.36, LAYOUT.rug.height, LAYOUT.rug.depth + 0.36],
    radius: 0.08,
  },
};

/**
 * Geometries shared by every room. One instanced-by-reference set keeps the
 * scene's memory flat no matter how many rooms are on the board; nothing here is
 * mutated after creation, so sharing is safe.
 */
export interface SharedGeometry {
  box: BoxGeometry;
  slab: BoxGeometry;
  cylinder: CylinderGeometry;
  cone: ConeGeometry;
  sphere: SphereGeometry;
  sphereLow: SphereGeometry;
  /** A spherical cap (the top ~46% of a sphere): the base of every hairstyle. */
  hairCap: SphereGeometry;
  capsule: CapsuleGeometry;
  disc: CircleGeometry;
  panel: PlaneGeometry;
  rounded: Record<RoundedPart, RoundedBoxGeometry>;
  /**
   * Merged part geometries, one per `sharedMesh` key.
   *
   * Nothing about a part's geometry depends on a room's palette — colours live in
   * the materials — so every room and every person can share one merged body, one
   * chair, one laptop. That is what keeps a 12-room board's vertex memory flat
   * (building them per figure reached ~600 MB of renderer memory and got the
   * renderer killed), and it also makes the second room much cheaper to build.
   */
  parts: Map<string, BufferGeometry>;
}

export function createSharedGeometry(): SharedGeometry {
  const rounded = {} as Record<RoundedPart, RoundedBoxGeometry>;
  for (const [name, spec] of Object.entries(ROUNDED_PARTS)) {
    rounded[name as RoundedPart] = new RoundedBoxGeometry(
      spec.size[0],
      spec.size[1],
      spec.size[2],
      1,
      spec.radius,
    );
  }
  return {
    box: new BoxGeometry(1, 1, 1),
    slab: new BoxGeometry(1, 0.12, 1),
    cylinder: new CylinderGeometry(0.5, 0.5, 1, 16),
    cone: new ConeGeometry(0.5, 1, 16),
    sphere: new SphereGeometry(0.5, 16, 12),
    sphereLow: new SphereGeometry(0.5, 8, 6),
    hairCap: new SphereGeometry(0.5, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.46),
    capsule: new CapsuleGeometry(0.5, 1, 5, 12),
    disc: new CircleGeometry(0.5, 24),
    panel: new PlaneGeometry(1, 1),
    rounded,
    parts: new Map<string, BufferGeometry>(),
  };
}

/** Everything `createSharedGeometry` owns, for disposal. */
export function sharedGeometrySet(
  geometry: SharedGeometry,
): Set<BufferGeometry> {
  const set = new Set<BufferGeometry>([
    geometry.box,
    geometry.slab,
    geometry.cylinder,
    geometry.cone,
    geometry.sphere,
    geometry.sphereLow,
    geometry.hairCap,
    geometry.capsule,
    geometry.disc,
    geometry.panel,
  ]);
  for (const value of Object.values(geometry.rounded)) set.add(value);
  for (const value of geometry.parts.values()) set.add(value);
  return set;
}

export interface Placement {
  /** Translation / Euler rotation / scale, in that order (metres, radians). */
  position?: readonly number[];
  rotation?: readonly number[];
  scale?: readonly number[];
}

function matrixOf(placement: Placement): Matrix4 {
  const [x = 0, y = 0, z = 0] = placement.position ?? [];
  const [rx = 0, ry = 0, rz = 0] = placement.rotation ?? [];
  const [sx = 1, sy = 1, sz = 1] = placement.scale ?? [];
  return new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromEuler(new Euler(rx, ry, rz)),
    new Vector3(sx, sy, sz),
  );
}

/**
 * Bake a list of placed copies of shared geometry into **one** mesh.
 *
 * A room is several hundred parts; one mesh per material is what keeps a
 * 12-room board inside its draw-call budget, and a room is built once per roster
 * change, so paying the merge at build time is the right trade. The merged
 * geometry belongs to the caller (the room disposes it), unlike the shared
 * source geometries.
 */
export function mergedMesh(
  material: Material,
  parts: ReadonlyArray<{ geometry: BufferGeometry; placement?: Placement }>,
): Mesh | null {
  if (parts.length === 0) return null;
  const copies = parts.map((part) => {
    const clone = part.geometry.clone();
    // Merging needs one shared attribute layout: the rounded boxes are
    // non-indexed and everything else is indexed, so flatten the indexed ones
    // rather than keeping two merge paths.
    const flat = clone.index === null ? clone : clone.toNonIndexed();
    if (flat !== clone) clone.dispose();
    if (part.placement) flat.applyMatrix4(matrixOf(part.placement));
    return flat;
  });
  const merged = mergeGeometries(copies, false);
  if (merged === null) {
    // Defensive: a mismatched attribute set would abort the merge, and dropping
    // the part entirely would silently deform the room. Keep the first copy.
    const first = copies[0]!;
    for (const copy of copies.slice(1)) copy.dispose();
    return new Mesh(first, material);
  }
  for (const copy of copies) copy.dispose();
  return new Mesh(merged, material);
}

/**
 * A merged mesh whose **geometry** is shared by every caller of the same key.
 *
 * `mergedMesh` bakes one geometry per call; a board of 12 rooms with seven people
 * in each would build ~1500 of them (each with its own vertex arrays in CPU *and*
 * GPU memory), which is exactly the load that got the renderer killed. Geometry does
 * not depend on the palette, so one merged body per part serves the whole board;
 * only the material differs per room/person.
 */
export function sharedMesh(
  library: SharedGeometry,
  key: string,
  material: Material,
  parts: ReadonlyArray<{ geometry: BufferGeometry; placement?: Placement }>,
): Mesh | null {
  const cached = library.parts.get(key);
  if (cached !== undefined) return new Mesh(cached, material);
  const mesh = mergedMesh(material, parts);
  if (mesh === null) return null;
  library.parts.set(key, mesh.geometry);
  return mesh;
}

export interface RoomMaterials {
  floor: Material;
  wall: Material;
  wallTrim: Material;
  wallCap: Material;
  desk: Material;
  deskTop: Material;
  table: Material;
  chair: Material;
  chairFrame: Material;
  metal: Material;
  /** The paper notepad's cover: a muted red, clearly not another wooden prop. */
  notepad: Material;
  dispenserBody: Material;
  dispenserDark: Material;
  dispenserBottle: Material;
  dispenserCup: Material;
  /** The corner palm: terracotta pot, soil, stems and two shades of frond. */
  palmPot: Material;
  palmSoil: Material;
  palmStem: Material;
  palmLeafDark: Material;
  palmLeafLight: Material;
  screenBezel: Material;
  screenFace: Material;
  /** The sideboard's book spines: three muted tones, so the shelves read as filled. */
  bookA: Material;
  bookB: Material;
  bookC: Material;
  /** The window wall: dark frames around glowing panes (they read as daylight). */
  windowFrame: Material;
  windowPane: Material;
  /** A faint glossy sheet over the glass. */
  windowSheen: Material;
  /** Wall clocks: dark rim, a painted face, and two hands in different colours. */
  clockRim: Material;
  clockFace: Material;
  clockHourHand: Material;
  clockMinuteHand: Material;
  /** The rug under the assistant's desk: a light field inside a darker border. */
  rug: Material;
  rugBorder: Material;
  /** The assistant's desk sunflower: yellow petals, dark seeds, thick green stem. */
  sunflowerPetal: Material;
  sunflowerDisc: Material;
  flowerStem: Material;
  flowerLeaf: Material;
  flowerPot: Material;
  flowerSoil: Material;
  laptop: Material;
  /** The keyboard plate / trackpad, a shade darker than the body. */
  laptopKeys: Material;
  mug: Material;
  shadow: Material;
  /** The bigger, fainter blob that seats a piece of furniture on the floor. */
  ambientShadow: Material;
  /** The baked corner darkening laid over the floor. */
  floorShade: Material;
}

/**
 * Surface finishes. Roughness/metalness is what stops the room from looking like
 * painted plastic: fabric and matte paint scatter light, metal reflects it, and a
 * few materials get a faint emissive lift (screens) so they read as *lit*, not
 * just coloured. Everything a later art pass wants to tune is here.
 */
const FINISH: Record<
  "matte" | "soft" | "wood" | "fabric" | "metal" | "glass" | "screen",
  { roughness: number; metalness: number }
> = {
  matte: { roughness: 1, metalness: 0 },
  soft: { roughness: 0.86, metalness: 0.02 },
  wood: { roughness: 0.7, metalness: 0.04 },
  fabric: { roughness: 0.98, metalness: 0 },
  metal: { roughness: 0.38, metalness: 0.72 },
  glass: { roughness: 0.3, metalness: 0.12 },
  screen: { roughness: 0.24, metalness: 0.1 },
};

function woodMaterial(species: WoodSpecies): MeshStandardMaterial {
  return new MeshStandardMaterial({
    map: woodTexture(species),
    roughness: 0.7,
    metalness: 0.03,
  });
}

function standard(
  color: number,
  finish: keyof typeof FINISH,
  emissive?: { color: number; intensity: number },
): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color,
    roughness: FINISH[finish].roughness,
    metalness: FINISH[finish].metalness,
  });
  if (emissive !== undefined) {
    material.emissive = new Color(emissive.color);
    material.emissiveIntensity = emissive.intensity;
  }
  return material;
}

export function createRoomMaterials(
  palette: RoomPalette,
  dark = false,
): RoomMaterials {
  return {
    // Warm planks: the whole room stands on it, and the two table species sit
    // clearly above and below it in lightness (floor mid, oak table light, walnut
    // desk dark), so furniture never dissolves into the floor.
    floor: plankMaterial(dark),
    // A faint vertical wash: walls are brighter near their top edge and sink into
    // their own shadow at the floor. This is the cheapest half of "it looks flat"
    // (the other half is the shadow map).
    wall: new MeshStandardMaterial({
      map: wallWashTexture(),
      color: palette.wall,
      roughness: 0.98,
      metalness: 0,
    }),
    wallTrim: standard(palette.wallTrim, "soft"),
    wallCap: standard(palette.wallCap, "soft"),
    desk: woodMaterial("walnut"),
    deskTop: woodMaterial("walnut"),
    table: woodMaterial("oak"),
    chair: standard(palette.chair, "fabric"),
    chairFrame: standard(palette.chairFrame, "soft"),
    metal: standard(palette.metal, "metal"),
    notepad: standard(0xb5443a, "soft"),
    // A white appliance body, dark recesses and a translucent blue bottle: reads as
    // "office water cooler" in both themes without picking up the room's accent.
    dispenserBody: standard(0xe8e8e6, "soft"),
    dispenserDark: standard(0x3a3d42, "soft"),
    dispenserBottle: new MeshStandardMaterial({
      color: 0x8fc4e8,
      roughness: 0.18,
      metalness: 0.05,
      transparent: true,
      opacity: 0.72,
    }),
    dispenserCup: standard(0xf2f2f0, "soft"),
    palmPot: standard(0xb4643f, "soft"),
    palmSoil: standard(0x2f2318, "matte"),
    palmStem: standard(0x7d8a4a, "matte"),
    palmLeafDark: new MeshStandardMaterial({
      color: 0x4d7a3a,
      roughness: 0.55,
      metalness: 0.02,
      side: DoubleSide,
    }),
    palmLeafLight: new MeshStandardMaterial({
      color: 0x8fae5e,
      roughness: 0.5,
      metalness: 0.02,
      side: DoubleSide,
    }),
    screenBezel: standard(palette.screenBezel, "glass"),
    // A laptop screen that is **off**: near black, no colour cast. (The wall screen
    // is its own textured material, see `room.ts`.)
    screenFace: standard(0x101215, "screen", { color: 0x000000, intensity: 0 }),
    bookA: standard(0x4a5b73, "soft"),
    bookB: standard(0x8d8f84, "soft"),
    bookC: standard(0xa8763f, "soft"),
    windowFrame: standard(0x2c3038, "soft"),
    windowSheen: new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.08,
      metalness: 0.1,
      transparent: true,
      opacity: 0.16,
    }),
    // Daylight through frosted glass: emissive rather than lit, because it *is* the
    // light source of the room in the reference.
    windowPane: new MeshStandardMaterial({
      color: 0xfff6e2,
      emissive: new Color(0xfff3d9),
      emissiveIntensity: dark ? 0.55 : 0.95,
      roughness: 0.4,
      metalness: 0,
    }),
    clockRim: standard(0x33373f, "soft"),
    clockFace: new MeshStandardMaterial({
      map: clockFaceTexture(),
      color: 0xffffff,
      roughness: 0.8,
      metalness: 0,
    }),
    // The two hands are told apart by colour as well as by length: the hour hand is near
    // black, the minute hand takes the room's accent (darkened, so it still reads on the
    // cream dial).
    clockHourHand: standard(dark ? 0x101216 : 0x24272d, "soft"),
    clockMinuteHand: standard(
      new Color(palette.accent)
        .lerp(new Color(0x000000), dark ? 0.35 : 0.15)
        .getHex(),
      "soft",
    ),
    rug: standard(palette.rug, "fabric"),
    rugBorder: standard(palette.rugBorder, "fabric"),
    sunflowerPetal: standard(0xf2b32c, "soft", {
      color: 0xf2b32c,
      intensity: 0.14,
    }),
    sunflowerDisc: standard(0x4a3220, "matte"),
    flowerStem: standard(0x4a7a3f, "matte"),
    flowerLeaf: standard(0x3f6e3a, "matte"),
    flowerPot: standard(0xd9cfc0, "soft"),
    flowerSoil: standard(0x342619, "matte"),
    laptop: standard(palette.laptop, "metal"),
    laptopKeys: standard(
      new Color(palette.laptop).multiplyScalar(0.55).getHex(),
      "soft",
    ),
    mug: standard(palette.mug, "glass"),
    // The floor's own ambient occlusion: the room's edges fall away from the light.
    floorShade: new MeshBasicMaterial({
      map: floorVignetteTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.5,
    }),
    shadow: new MeshBasicMaterial({
      map: softShadowTexture(0.3),
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    }),
    ambientShadow: new MeshBasicMaterial({
      map: softShadowTexture(0.16),
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    }),
  };
}

type WoodSpecies = "walnut" | "oak";

const WOOD: Record<
  WoodSpecies,
  { base: string; grain: string; grainAlt: string; repeat: [number, number] }
> = {
  walnut: {
    base: "#4a3226",
    grain: "#3a241a",
    grainAlt: "#5b4030",
    repeat: [2, 1],
  },
  oak: {
    base: "#c8a271",
    grain: "#ab8557",
    grainAlt: "#d8b78c",
    repeat: [4, 1],
  },
};

let WOOD_ANISOTROPY = 8;

export function setWoodAnisotropy(value: number): void {
  WOOD_ANISOTROPY = Math.max(1, Math.min(16, Math.floor(value)));
  for (const texture of WOOD_TEXTURES.values()) {
    texture.anisotropy = WOOD_ANISOTROPY;
    texture.needsUpdate = true;
  }
}

const WOOD_TEXTURES = new Map<WoodSpecies, Texture>();

/**
 * A wood-grain texture, drawn once per species and cached.
 *
 * Grain is long streaks along U with a few knots, at a resolution high enough to
 * survive the isometric view *and* a close focus shot: the anisotropy (set from the
 * renderer's capability) is what keeps the streaks from turning into noise when
 * the surface is seen at a grazing angle.
 */
function woodTexture(species: WoodSpecies): Texture {
  const cached = WOOD_TEXTURES.get(species);
  if (cached !== undefined) return cached;

  const spec = WOOD[species];
  const width = 512;
  const height = 512;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context !== null) {
    context.fillStyle = spec.base;
    context.fillRect(0, 0, width, height);

    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    // Long streaks along U, at a handful of spacings, so the grain reads as wood
    // rather than as stripes.
    for (let index = 0; index < 900; index += 1) {
      const y = random() * height;
      const thickness = 0.6 + random() * 2.2;
      context.strokeStyle = random() > 0.45 ? spec.grain : spec.grainAlt;
      context.globalAlpha = 0.1 + random() * 0.35;
      context.lineWidth = thickness;
      context.beginPath();
      context.moveTo(0, y);
      let cursor = 0;
      while (cursor < width) {
        const step = 40 + random() * 90;
        const wobble = (random() - 0.5) * 3.5;
        context.lineTo(cursor + step, y + wobble);
        cursor += step;
      }
      context.stroke();
    }

    // A couple of knots, drawn as soft concentric ellipses.
    {
      context.globalAlpha = 0.4;
      for (const [cx, cy] of [
        [width * 0.24, height * 0.62],
        [width * 0.68, height * 0.33],
      ] as const) {
        for (let ring = 0; ring < 4; ring += 1) {
          context.strokeStyle = ring % 2 === 0 ? spec.grain : spec.grainAlt;
          context.lineWidth = 2;
          context.beginPath();
          context.ellipse(
            cx,
            cy,
            10 + ring * 7,
            5 + ring * 4,
            0.3,
            0,
            Math.PI * 2,
          );
          context.stroke();
        }
      }
    }

    context.globalAlpha = 1;
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(spec.repeat[0], spec.repeat[1]);
  texture.anisotropy = WOOD_ANISOTROPY;
  WOOD_TEXTURES.set(species, texture);
  return texture;
}

let WALL_WASH: Texture | null = null;

/** Wall paint with a soft vertical wash: full strength at the cap, darker at the floor. */
function wallWashTexture(): Texture {
  if (WALL_WASH !== null) return WALL_WASH;
  const width = 8;
  const height = 256;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context !== null) {
    const gradient = context.createLinearGradient(0, 0, 0, height);
    // Canvas y runs down: the wall's top is y = 0.
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.6, "#faf8f6");
    gradient.addColorStop(1, "#e9e3dc");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  WALL_WASH = texture;
  return texture;
}

let FLOOR_VIGNETTE: Texture | null = null;

/** A transparent-centre, dark-edge wash for the floor: the room's own AO. */
function floorVignetteTexture(): Texture {
  if (FLOOR_VIGNETTE !== null) return FLOOR_VIGNETTE;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context !== null) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      size * 0.2,
      size / 2,
      size / 2,
      size * 0.62,
    );
    gradient.addColorStop(0, "rgba(0,0,0,0)");
    gradient.addColorStop(1, "rgba(0,0,0,0.34)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  FLOOR_VIGNETTE = texture;
  return texture;
}

const PLANK_TEXTURES = new Map<"light" | "dark", Texture>();

/**
 * The floor of the reference room: **light, wide boards**, not a parquet.
 *
 * Long planks running along one axis with staggered joints, a pale beige palette and
 * a low-contrast grain — the floor is the calm surface under the furniture, and it has
 * to sit *lighter* than the walnut desk and clearly apart from the oak meeting table.
 */
function plankTexture(dark: boolean): Texture {
  const key = dark ? "dark" : "light";
  const cached = PLANK_TEXTURES.get(key);
  if (cached !== undefined) return cached;

  const size = 1024;
  const boards = 6;
  const board = size / boards;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context !== null) {
    const palette = dark
      ? {
          base: "#6a5540",
          alt: "#5f4c39",
          seam: "#443528",
          grain: "rgba(30,20,10,0.20)",
        }
      : {
          base: "#e0cbac",
          alt: "#d8c2a1",
          seam: "#bda684",
          grain: "rgba(140,105,66,0.16)",
        };
    context.fillStyle = palette.seam;
    context.fillRect(0, 0, size, size);

    let seed = 23;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    for (let row = 0; row < boards; row += 1) {
      const y = row * board;
      // Long boards: the joint of one row is offset from the next, like a real floor.
      const offset = (row % 2 === 0 ? 0 : 0.37) * size;
      const tone = random() > 0.45 ? palette.base : palette.alt;
      context.fillStyle = tone;
      context.fillRect(0, y + 1.5, size, board - 3);

      // Grain: long, nearly straight streaks along the board.
      context.save();
      context.beginPath();
      context.rect(0, y + 1.5, size, board - 3);
      context.clip();
      context.strokeStyle = palette.grain;
      for (let line = 0; line < 26; line += 1) {
        const ly = y + 2 + random() * (board - 4);
        context.lineWidth = 0.7 + random() * 2.2;
        context.globalAlpha = 0.25 + random() * 0.5;
        context.beginPath();
        context.moveTo(0, ly);
        let cursor = 0;
        while (cursor < size) {
          const step = 90 + random() * 180;
          context.lineTo(cursor + step, ly + (random() - 0.5) * 3);
          cursor += step;
        }
        context.stroke();
      }
      // The joint at the end of this board, offset per row.
      context.globalAlpha = 1;
      context.fillStyle = palette.seam;
      context.fillRect(offset, y + 1.5, 3, board - 3);
      context.restore();
    }
    // Seams between the boards themselves.
    context.globalAlpha = 0.85;
    context.fillStyle = palette.seam;
    for (let row = 0; row <= boards; row += 1) {
      context.fillRect(0, row * board - 1.5, size, 3);
    }
    context.globalAlpha = 1;
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  // Six boards per tile; the floor is ~13 units deep, so two tiles give a board about
  // 1.1 units wide — wide boards, as in the reference.
  texture.repeat.set(1.2, 2);
  texture.anisotropy = WOOD_ANISOTROPY;
  PLANK_TEXTURES.set(key, texture);
  return texture;
}

function plankMaterial(dark: boolean): MeshStandardMaterial {
  return new MeshStandardMaterial({
    map: plankTexture(dark),
    color: 0xffffff,
    roughness: 0.7,
    metalness: 0.02,
  });
}

let CLOCK_FACE: Texture | null = null;

/** A wall clock's dial: cream face, minute ticks, thicker hour ticks, no numerals. */
function clockFaceTexture(): Texture {
  if (CLOCK_FACE !== null) return CLOCK_FACE;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const centre = size / 2;
  if (context !== null) {
    context.fillStyle = "#f7f1e2";
    context.fillRect(0, 0, size, size);
    context.translate(centre, centre);
    for (let tick = 0; tick < 60; tick += 1) {
      const hour = tick % 5 === 0;
      context.strokeStyle = hour ? "#2a2b30" : "#8d8b85";
      context.lineWidth = hour ? 4.5 : 2;
      context.beginPath();
      context.moveTo(0, -centre * 0.86);
      context.lineTo(0, -centre * (hour ? 0.74 : 0.79));
      context.stroke();
      context.rotate((Math.PI * 2) / 60);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = WOOD_ANISOTROPY;
  CLOCK_FACE = texture;
  return texture;
}

const SHADOW_TEXTURES = new Map<number, Texture>();

/** A cached radial-gradient disc: the soft "grounding" blob under objects. */
function softShadowTexture(inner: number): Texture {
  const cached = SHADOW_TEXTURES.get(inner);
  if (cached !== undefined) return cached;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context !== null) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, "rgba(0,0,0,0.55)");
    gradient.addColorStop(inner, "rgba(0,0,0,0.2)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  SHADOW_TEXTURES.set(inner, texture);
  return texture;
}

/**
 * Soft ground shadow under one object. `along` stretches the blob along the key
 * light's ground direction, so the shadow leans the way the light does instead of
 * being a perfect circle under every chair.
 */
export function buildContactShadow(
  geometry: SharedGeometry,
  material: Material,
  radius: number,
  along = 1,
): Mesh {
  const mesh = new Mesh(geometry.disc, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.scale.set(radius, radius * along, 1);
  mesh.position.y = DECAL_Y;
  mesh.renderOrder = -1;
  // A painted shadow that also *cast* a shadow drew a hard, opaque disc of its own.
  mesh.userData.noShadow = true;
  return mesh;
}

/**
 * Height of the painted ground shadows: just above the rug's top face (0.051), so one
 * decal lands on the bare floor and on the rug without being buried by either. They used
 * to sit at `shellThickness / 2`, i.e. 0.2 above the floor — in an isometric projection
 * that reads as a shadow hovering next to the object instead of under it.
 */
export const DECAL_Y = 0.06;

/** Which way the key light's ground shadow falls (see `LIGHT_POSITIONS.key`). */
export const SHADOW_OFFSET = new Vector3(-0.36, 0, -0.2);

export const LAPTOP_OPEN_DEG = 100;

/**
 * A laptop, opened toward whoever is using it: one integrated model — a rounded
 * body with the keyboard and trackpad inset flush into its top, a hinge along the
 * back edge, and a lid that turns about that hinge so the screen can never come
 * apart from the body.
 *
 * At rotation 0 the laptop serves a person standing at **+z**: the trackpad is on
 * that side, and the lid's tilt makes the display (on the lid's inner face) look
 * toward +z as well. Callers therefore turn the group by
 * `seatRotation + π` — the seat's forward vector points *away* from its occupant.
 */
export function buildLaptop(
  library: SharedGeometry,
  materials: RoomMaterials,
): Group {
  const laptop = new Group();
  const geometry = library;

  const body: Array<{ geometry: BufferGeometry; placement?: Placement }> = [
    {
      geometry: geometry.rounded.laptopBody,
      placement: { position: [0, 0, 0] },
    },
  ];
  const bodyMesh = sharedMesh(library, "laptop:body", materials.laptop, body);
  if (bodyMesh !== null) laptop.add(bodyMesh);

  const keys = sharedMesh(library, "laptop:keys", materials.laptopKeys, [
    {
      geometry: geometry.box,
      placement: {
        position: [0, 0.042, -0.13],
        scale: [1.0, 0.012, 0.36],
      },
    },
    {
      geometry: geometry.box,
      placement: { position: [0, 0.041, 0.24], scale: [0.34, 0.008, 0.16] },
    },
  ]);
  if (keys !== null) laptop.add(keys);

  const hinge = new Mesh(geometry.cylinder, materials.metal);
  hinge.scale.set(0.05, 1.0, 0.05);
  hinge.rotation.z = Math.PI / 2;
  hinge.position.set(0, 0.045, -0.38);
  laptop.add(hinge);

  // The lid is parented to a pivot *at* the hinge edge, so its bottom edge is the
  // hinge: no gap, no floating screen whatever the opening angle is.
  const pivot = new Group();
  pivot.position.set(0, 0.045, -0.38);
  pivot.rotation.x = -(LAPTOP_OPEN_DEG * Math.PI) / 180;

  const lidMesh = sharedMesh(library, "laptop:lid", materials.laptop, [
    {
      geometry: geometry.rounded.laptopLid,
      placement: { position: [0, 0, 0.37] },
    },
  ]);
  if (lidMesh !== null) pivot.add(lidMesh);

  // The display sits on the lid's **inner** face (the one facing the base when
  // closed, so the one the user looks at when open).
  const display = new Mesh(geometry.box, materials.screenFace);
  display.scale.set(0.98, 0.02, 0.66);
  display.position.set(0, -0.032, 0.37);
  pivot.add(display);

  laptop.add(pivot);
  return laptop;
}

/**
 * An ergonomic chair: five-star base with casters, gas lift, cushioned seat, tall
 * curved back with a lumbar pad, and two armrests. Built as three merged meshes
 * (fabric / frame / metal) — it is the single most numerous object in the scene,
 * and one draw call per material is what pays for the extra furniture detail.
 *
 * Returned as a list so the caller can parent all of it to the swivel node; the
 * first element is the seat cushion (the figure's own grounding reference).
 */
export function buildChair(
  library: SharedGeometry,
  materials: RoomMaterials,
): Mesh[] {
  const geometry = library;
  // Cushioned seat first: the caller uses it as the figure's grounding reference
  // (raycast target and the "is this person" hit box).
  const seat = new Mesh(geometry.rounded.chairSeat, materials.chair);
  seat.position.set(0, 0.5, 0);

  // The back is a **vertical** panel (thin in z, tall in y) leaning back slightly,
  // with the lumbar pad on the side the occupant is on.
  const fabric = sharedMesh(library, "chair:fabric", materials.chair, [
    {
      geometry: geometry.rounded.chairBack,
      placement: { position: [0, 1.03, -0.42], rotation: [-0.12, 0, 0] },
    },
  ]);

  const frameParts: Array<{ geometry: BufferGeometry; placement?: Placement }> =
    [
      {
        geometry: geometry.rounded.chairLumbar,
        placement: { position: [0, 0.84, -0.28], rotation: [-0.16, 0, 0] },
      },
    ];
  // Armrests: a post each side plus a rounded pad on top.
  for (const side of [-1, 1]) {
    frameParts.push(
      {
        geometry: geometry.cylinder,
        placement: {
          position: [side * 0.47, 0.66, -0.04],
          scale: [0.1, 0.3, 0.1],
        },
      },
      {
        geometry: geometry.rounded.chairArmPad,
        placement: { position: [side * 0.47, 0.82, 0] },
      },
    );
  }

  const metalParts: Array<{ geometry: BufferGeometry; placement?: Placement }> =
    [
      {
        geometry: geometry.cylinder,
        placement: { position: [0, 0.14, 0], scale: [0.52, 0.1, 0.52] },
      },
      {
        geometry: geometry.cylinder,
        placement: { position: [0, 0.36, 0], scale: [0.15, 0.46, 0.15] },
      },
    ];
  for (let index = 0; index < 5; index += 1) {
    const angle = (index / 5) * Math.PI * 2;
    metalParts.push(
      {
        geometry: geometry.box,
        placement: {
          position: [Math.sin(angle) * 0.24, 0.1, Math.cos(angle) * 0.24],
          rotation: [0, angle, 0],
          scale: [0.16, 0.1, 0.46],
        },
      },
      {
        geometry: geometry.sphereLow,
        placement: {
          position: [Math.sin(angle) * 0.46, 0.07, Math.cos(angle) * 0.46],
          scale: [0.16, 0.14, 0.16],
        },
      },
    );
  }

  const frame = sharedMesh(
    library,
    "chair:frame",
    materials.chairFrame,
    frameParts,
  );
  const metal = sharedMesh(library, "chair:metal", materials.metal, metalParts);
  const parts: Mesh[] = [seat];
  if (fabric !== null) parts.push(fabric);
  if (frame !== null) parts.push(frame);
  if (metal !== null) parts.push(metal);
  return parts;
}

/**
 * A water dispenser: a floor-standing body with a drip tray and two taps, a big
 * translucent bottle on top, and a small cup stack beside it. Built facing **+z**;
 * the room turns it toward whatever it should face.
 */
export function buildWaterDispenser(
  library: SharedGeometry,
  materials: RoomMaterials,
): Group {
  const geometry = library;
  const group = new Group();

  const bodyParts = [
    {
      geometry: geometry.rounded.dispenserBody,
      placement: { position: [0, 0.55, 0] } as Placement,
    },
    {
      geometry: geometry.rounded.dispenserTop,
      placement: { position: [0, 1.1, 0] } as Placement,
    },
  ];
  const body = sharedMesh(
    library,
    "dispenser:body",
    materials.dispenserBody,
    bodyParts,
  );
  if (body !== null) group.add(body);

  const darkParts = [
    // Tap recess on the front face, its two taps and the seat the bottle sits in.
    {
      geometry: geometry.box,
      placement: {
        position: [0, 0.72, 0.25],
        scale: [0.4, 0.34, 0.1],
      },
    },
    {
      geometry: geometry.cylinder,
      placement: { position: [-0.1, 0.62, 0.3], scale: [0.06, 0.12, 0.06] },
    },
    {
      geometry: geometry.cylinder,
      placement: { position: [0.1, 0.62, 0.3], scale: [0.06, 0.12, 0.06] },
    },
    {
      geometry: geometry.cylinder,
      placement: { position: [0, 1.13, 0], scale: [0.36, 0.06, 0.36] },
    },
    // The bottle's base, facing up: a slightly wider disc, so the bottle still
    // reads as "upside down" rather than as a plain canister.
    {
      geometry: geometry.cylinder,
      placement: { position: [0, 1.84, 0], scale: [0.52, 0.05, 0.52] },
    },
  ];
  const dark = sharedMesh(
    library,
    "dispenser:dark",
    materials.dispenserDark,
    darkParts,
  );
  if (dark !== null) group.add(dark);

  const tray = new Mesh(geometry.box, materials.metal);
  tray.scale.set(0.44, 0.04, 0.16);
  tray.position.set(0, 0.5, 0.3);
  group.add(tray);

  // The bottle sits **mouth-down directly on the machine**: the body's own rim
  // rests on the dark seat plate, the wide base faces up.
  const bottle = new Mesh(geometry.cylinder, materials.dispenserBottle);
  bottle.scale.set(0.5, 0.66, 0.5);
  bottle.position.y = 1.49;
  group.add(bottle);

  // A small cup stack on the side: the detail that says "drinking water".
  const cups: Array<{ geometry: BufferGeometry; placement?: Placement }> = [];
  for (let index = 0; index < 3; index += 1) {
    cups.push({
      geometry: geometry.cylinder,
      placement: {
        position: [0.42, 1.14 + index * 0.06, 0.1],
        scale: [0.12, 0.06, 0.12],
      },
    });
  }
  const cupStack = sharedMesh(
    library,
    "dispenser:cups",
    materials.dispenserCup,
    cups,
  );
  if (cupStack !== null) group.add(cupStack);
  return group;
}

/**
 * The corner plant of the reference: a **tall, open clump** in a terracotta pot.
 *
 * Six stems of different heights rise from the pot; each ends in one long blade that
 * leans outward and slightly up, with a couple of lower blades filling the base. The
 * blades are broad and pointed (two overlapping flattened segments, so each one curves),
 * and the stems stay *inside* their own leaf so nothing reads as a bare rod.
 */
export function buildPalm(
  library: SharedGeometry,
  materials: RoomMaterials,
): Group {
  const geometry = library;
  const plant = new Group();

  const potParts = [
    {
      geometry: geometry.cylinder,
      placement: { position: [0, 0.34, 0], scale: [0.7, 0.68, 0.7] },
    },
    {
      geometry: geometry.cylinder,
      placement: { position: [0, 0.66, 0], scale: [0.8, 0.12, 0.8] },
    },
  ];
  const pot = sharedMesh(library, "palm:pot", materials.palmPot, potParts);
  if (pot !== null) plant.add(pot);
  const soil = new Mesh(geometry.cylinder, materials.palmSoil);
  soil.scale.set(0.66, 0.05, 0.66);
  soil.position.y = 0.68;
  plant.add(soil);

  const darkParts: Array<{ geometry: BufferGeometry; placement?: Placement }> =
    [];
  const lightParts: Array<{ geometry: BufferGeometry; placement?: Placement }> =
    [];
  const stemParts: Array<{ geometry: BufferGeometry; placement?: Placement }> =
    [];

  // Stem + blade pairs: height, lean, blade length and the angle it fans to.
  const shoots: Array<{
    angle: number;
    stem: number;
    lean: number;
    blade: number;
    shade: 0 | 1;
  }> = [
    { angle: 0.2, stem: 1.5, lean: 0.14, blade: 1.85, shade: 0 },
    { angle: 1.25, stem: 1.15, lean: 0.26, blade: 1.7, shade: 1 },
    { angle: 2.3, stem: 1.62, lean: 0.08, blade: 1.9, shade: 1 },
    { angle: 3.35, stem: 0.95, lean: 0.36, blade: 1.55, shade: 0 },
    { angle: 4.3, stem: 1.35, lean: 0.2, blade: 1.8, shade: 0 },
    { angle: 5.3, stem: 1.05, lean: 0.3, blade: 1.6, shade: 1 },
    { angle: 2.8, stem: 0.8, lean: 0.44, blade: 1.35, shade: 0 },
  ];

  for (const shoot of shoots) {
    const dx = Math.cos(shoot.angle);
    const dz = Math.sin(shoot.angle);
    const baseY = 0.68;
    // A slim stem leaning outward; the blade grows out of its tip, so the stem stops
    // a little short of the leaf and is hidden by it.
    const topY = baseY + shoot.stem * Math.cos(shoot.lean);
    const topR = shoot.stem * Math.sin(shoot.lean);
    const tipX = dx * topR;
    const tipZ = dz * topR;
    stemParts.push({
      geometry: geometry.cylinder,
      placement: {
        position: [tipX * 0.5, (baseY + topY) / 2 - 0.06, tipZ * 0.5],
        scale: [0.065, shoot.stem * 0.92, 0.065],
        rotation: [dz * shoot.lean, 0, -dx * shoot.lean],
      },
    });

    const target = shoot.shade === 0 ? darkParts : lightParts;
    // The blade: two segments, both tilted **up** out of the stem's tip (the tilt is
    // applied before the azimuth, so the leaf rises outward instead of lying flat).
    const tilt = 0.42;
    const length = shoot.blade;
    const seg = (
      along: number,
      segmentLength: number,
      segmentTilt: number,
      thickness: number,
      width: number,
    ): void => {
      const dirX = dx * Math.cos(segmentTilt);
      const dirY = Math.sin(segmentTilt);
      const dirZ = dz * Math.cos(segmentTilt);
      target.push({
        geometry: geometry.sphere,
        placement: {
          position: [
            tipX + dirX * along,
            topY + dirY * along,
            tipZ + dirZ * along,
          ],
          rotation: [0, -shoot.angle, segmentTilt],
          scale: [segmentLength, thickness, width],
        },
      });
    };
    // Broad, fleshy blades: wide enough to read from above, thick enough not to look
    // like paper when seen edge-on.
    seg(length * 0.3, length * 0.64, tilt, 0.12, length * 0.3);
    seg(length * 0.72, length * 0.58, tilt * 0.4, 0.1, length * 0.24);
  }

  for (const [key, material, parts] of [
    ["palm:stems", materials.palmStem, stemParts],
    ["palm:leavesDark", materials.palmLeafDark, darkParts],
    ["palm:leavesLight", materials.palmLeafLight, lightParts],
  ] as const) {
    const mesh = sharedMesh(library, key, material, parts);
    if (mesh !== null) plant.add(mesh);
  }

  return plant;
}

/**
 * A wall clock: dark rim, painted dial, hour and minute hands.
 *
 * The hands are returned so the stage can drive them from the local time — they are
 * *real* clocks, which is what the boss asked for; in the frozen bird's-eye view
 * they simply stay at the time of the last drawn frame.
 */
export interface WallClock {
  group: Group;
  setTime(hours: number, minutes: number): void;
}

export function buildWallClock(
  library: SharedGeometry,
  materials: RoomMaterials,
  radius: number,
): WallClock {
  const geometry = library;
  const group = new Group();

  // A round rim: a short cylinder with its axis along +z, so its cap faces out of
  // the wall (a box rim reads as a framed picture, not as a clock).
  const rim = new Mesh(geometry.cylinder, materials.clockRim);
  rim.rotation.x = Math.PI / 2;
  rim.scale.set(radius * 2.16, radius * 0.18, radius * 2.16);
  group.add(rim);

  const face = new Mesh(geometry.disc, materials.clockFace);
  face.scale.set(radius * 2, radius * 2, 1);
  face.position.z = radius * 0.1;
  group.add(face);

  // Hands: a unit box whose bottom end is the pivot, so rotating the pivot swings
  // the hand like a real one.
  const hand = (
    length: number,
    width: number,
    z: number,
    material: Material,
  ): Group => {
    const pivot = new Group();
    pivot.position.z = z;
    const mesh = new Mesh(geometry.box, material);
    mesh.scale.set(width, length, radius * 0.05);
    mesh.position.y = length / 2;
    pivot.add(mesh);
    group.add(pivot);
    return pivot;
  };
  const hourPivot = hand(
    radius * 0.56,
    radius * 0.12,
    radius * 0.16,
    materials.clockHourHand,
  );
  const minutePivot = hand(
    radius * 0.82,
    radius * 0.07,
    radius * 0.2,
    materials.clockMinuteHand,
  );

  const pin = new Mesh(geometry.sphereLow, materials.clockHourHand);
  pin.scale.set(radius * 0.16, radius * 0.16, radius * 0.1);
  pin.position.z = radius * 0.24;
  group.add(pin);

  return {
    group,
    setTime(hours: number, minutes: number): void {
      const minuteAngle = (minutes / 60) * Math.PI * 2;
      const hourAngle = (((hours % 12) + minutes / 60) / 12) * Math.PI * 2;
      // Negative: a clock's hand turns clockwise, and +z faces out of the wall.
      minutePivot.rotation.z = -minuteAngle;
      hourPivot.rotation.z = -hourAngle;
    },
  };
}

/**
 * The window wall: two windows with dark frames and glowing panes.
 *
 * The window is **recessed into the wall**: the glass sits in the wall's plane and the
 * frame is a thin border around it, not a box standing proud of the paint (a
 * protruding sill read as a shelf, and the boss wants them embedded).
 */
export function buildWindows(
  library: SharedGeometry,
  materials: RoomMaterials,
): Group {
  const geometry = library;
  const group = new Group();
  const frameParts: Array<{ geometry: BufferGeometry; placement?: Placement }> =
    [];
  const paneParts: Array<{ geometry: BufferGeometry; placement?: Placement }> =
    [];
  const sheenParts: Array<{ geometry: BufferGeometry; placement?: Placement }> =
    [];
  // Mirror-symmetric pair: the same window at -z and +z.
  // The wall's **inner** face: the shell's thickness sits inside the room's footprint, so
  // the glass is recessed a hair behind the paint and the frame stands slightly proud.
  const originX = -ROOM.width / 2 + ROOM.shellThickness;
  const panes = [LAYOUT.windows.z, -LAYOUT.windows.z].map((z) => ({
    z,
    width: LAYOUT.windows.width,
  }));
  for (const pane of panes) {
    const { width } = pane;
    const { height, sillY, frameWidth, muntinWidth } = LAYOUT.windows;
    // Every bar is measured from the same rectangle, so the corners close exactly and
    // the muntins end on the frame's *centrelines*:
    //  - the outer rectangle's centrelines are at ±(width/2 + frameWidth/2),
    //    ±(height/2 + frameWidth/2) around the window's centre,
    //  - the top/bottom bars span the outer width, the side bars span the inner height
    //    (so they butt into each other instead of crossing),
    //  - the muntins span centreline to centreline.
    const frameX = originX + 0.055;
    const midY = sillY + height / 2;
    const outerHalfWidth = width / 2 + frameWidth;
    const outerHalfHeight = height / 2 + frameWidth;
    const barDepth = 0.05;
    // Top and bottom bars (full outer width).
    for (const dy of [-1, 1]) {
      frameParts.push({
        geometry: geometry.box,
        placement: {
          position: [
            frameX,
            midY + dy * (outerHalfHeight - frameWidth / 2),
            pane.z,
          ],
          scale: [barDepth, frameWidth, outerHalfWidth * 2],
        },
      });
    }
    // Left and right bars (inner height, so they butt into the horizontal bars).
    for (const dz of [-1, 1]) {
      frameParts.push({
        geometry: geometry.box,
        placement: {
          position: [
            frameX,
            midY,
            pane.z + dz * (outerHalfWidth - frameWidth / 2),
          ],
          scale: [barDepth, height, frameWidth],
        },
      });
    }
    // Muntins: two vertical, one horizontal, each spanning centreline to centreline.
    for (const offset of [-width / 4, width / 4]) {
      frameParts.push({
        geometry: geometry.box,
        placement: {
          position: [frameX + 0.002, midY, pane.z + offset],
          scale: [barDepth - 0.005, height + frameWidth, muntinWidth],
        },
      });
    }
    frameParts.push({
      geometry: geometry.box,
      placement: {
        // Halfway up: three columns and two equal rows — a regular 3 × 2 grid, every
        // bar the same thickness.
        position: [frameX + 0.002, midY, pane.z],
        scale: [barDepth - 0.005, muntinWidth, width + frameWidth],
      },
    });

    // The glass: just in front of the paint (inside the wall it would be hidden) and
    // slightly behind the frame's face, so it reads as recessed.
    paneParts.push({
      geometry: geometry.box,
      placement: {
        position: [originX + 0.02, midY, pane.z],
        scale: [0.04, height, width],
      },
    });
    sheenParts.push({
      geometry: geometry.box,
      placement: {
        position: [originX + 0.045, midY, pane.z],
        scale: [0.015, height * 0.94, width * 0.94],
      },
    });
  }

  const frames = sharedMesh(
    library,
    "window:frames",
    materials.windowFrame,
    frameParts,
  );
  if (frames !== null) group.add(frames);
  const glass = sharedMesh(
    library,
    "window:panes",
    materials.windowPane,
    paneParts,
  );
  if (glass !== null) group.add(glass);
  const sheen = sharedMesh(
    library,
    "window:sheen",
    materials.windowSheen,
    sheenParts,
  );
  if (sheen !== null) group.add(sheen);
  return group;
}

/**
 * A low, long **open sideboard** for the window wall, from the reference: pale oak top
 * with a small overhang, a dark body with two open shelves, a few loose books standing on
 * them and one or two small objects on top. Low enough to sit under the windows.
 */
export function buildSideboard(
  library: SharedGeometry,
  materials: RoomMaterials,
): Group {
  const geometry = library;
  const group = new Group();
  const size = LAYOUT.sideboard;

  // The body: two end panels, a back panel and the middle shelf between them.
  const bodyParts: Array<{ geometry: BufferGeometry; placement?: Placement }> =
    [
      {
        geometry: geometry.box,
        placement: {
          position: [0, size.height / 2, size.length / 2 - 0.04],
          scale: [size.depth - 0.04, size.height, 0.08],
        },
      },
      {
        geometry: geometry.box,
        placement: {
          position: [0, size.height / 2, -size.length / 2 + 0.04],
          scale: [size.depth - 0.04, size.height, 0.08],
        },
      },
      {
        // The back panel closes the side of the cabinet that stands against the wall
        // (local -x), so the two open shelves face into the room.
        geometry: geometry.box,
        placement: {
          position: [-size.depth / 2 + 0.03, size.height / 2, 0],
          scale: [0.06, size.height, size.length],
        },
      },
      {
        geometry: geometry.box,
        placement: {
          position: [0, size.height * 0.42, 0],
          scale: [size.depth - 0.06, 0.07, size.length - 0.12],
        },
      },
    ];
  const body = sharedMesh(library, "sideboard:body", materials.desk, bodyParts);
  if (body !== null) group.add(body);

  const top = sharedMesh(library, "sideboard:top", materials.table, [
    {
      geometry: geometry.box,
      placement: {
        position: [0, size.height + 0.045, 0],
        scale: [size.depth + 0.1, 0.09, size.length + 0.1],
      },
    },
  ]);
  if (top !== null) group.add(top);

  // Books: a handful of **loose** spines standing on the two open shelves, in small
  // clusters with real air between them — the boss wants a shelf that happens to hold some
  // books, not a packed bookcase. Each book is its own slab (own width, height and tone),
  // and nothing is coplanar with a neighbour: equal blocks in a row read as cardboard
  // boxes, and two shared faces z-fight as the room turns.
  const panelThickness = 0.08;
  const shelfThickness = 0.07;
  const innerLength = size.length - panelThickness * 2 - 0.1;
  const bookDepth = 0.26;
  const backPanelX = -size.depth / 2 + 0.06;
  const shelfMidY = size.height * 0.42;
  const compartments = [
    { baseY: 0.02, headroom: shelfMidY - shelfThickness / 2 - 0.02 },
    {
      baseY: shelfMidY + shelfThickness / 2 + 0.01,
      headroom: size.height - (shelfMidY + shelfThickness / 2) - 0.02,
    },
  ];
  // Deterministic scatter (mulberry32): the shelf must look the same on every rebuild.
  let seed = 0x2f6e2b1;
  const random = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const bookTones = [materials.bookA, materials.bookB, materials.bookC];
  const spines: Array<
    Array<{ geometry: BufferGeometry; placement?: Placement }>
  > = [[], [], []];
  for (const compartment of compartments) {
    // Two or three clusters per shelf, each of one to three books, with a wide gap
    // between the clusters.
    let z = -innerLength / 2 + 0.1 + random() * 0.3;
    let cluster = 0;
    while (z < innerLength / 2 - 0.25) {
      const books = 1 + Math.floor(random() * 3);
      for (let index = 0; index < books; index += 1) {
        const width = 0.1 + random() * 0.09;
        if (z + width > innerLength / 2) break;
        const height = Math.min(compartment.headroom, 0.44 + random() * 0.34);
        spines[Math.floor(random() * bookTones.length)]!.push({
          geometry: geometry.box,
          placement: {
            position: [
              backPanelX + bookDepth / 2,
              compartment.baseY + height / 2,
              z + width / 2,
            ],
            scale: [bookDepth, height, width],
          },
        });
        // A hair of air between two books of one cluster.
        z += width + 0.014;
      }
      z += 0.34 + random() * 0.5;
      cluster += 1;
      if (cluster >= 3) break;
    }
  }
  for (const [tone, material] of bookTones.entries()) {
    const mesh = sharedMesh(
      library,
      `sideboard:books:${tone}`,
      material,
      spines[tone]!,
    );
    if (mesh === null) continue;
    // Books do not cast: inside a compartment their shadow is only a dark smear, and the
    // soft edges of the map at board scale turned the row into a flickering texture.
    mesh.userData.noShadow = true;
    group.add(mesh);
  }

  // A dark speaker and a pen cup on top, like the reference.
  const props: Array<{ geometry: BufferGeometry; placement?: Placement }> = [
    {
      // A plain unit box: the screen bezel's rounded part is metres wide, so scaling it
      // down still left a 6-unit dark slab sticking out of the cabinet.
      geometry: geometry.box,
      placement: {
        position: [-0.08, size.height + 0.215, -size.length / 2 + 0.5],
        scale: [0.5, 0.34, 0.42],
      },
    },
    {
      geometry: geometry.cylinder,
      placement: {
        position: [0.06, size.height + 0.2, size.length / 2 - 0.6],
        scale: [0.26, 0.3, 0.26],
      },
    },
  ];
  const propMesh = sharedMesh(
    library,
    "sideboard:props",
    materials.metal,
    props,
  );
  if (propMesh !== null) group.add(propMesh);

  return group;
}

/** The rug the assistant's desk stands on: a light field inside a darker border. */
export function buildRug(
  library: SharedGeometry,
  materials: RoomMaterials,
): Group {
  const geometry = library;
  const group = new Group();
  const border = new Mesh(geometry.rounded.rugBorder, materials.rugBorder);
  border.position.set(0, LAYOUT.rug.height / 2 + 0.004, LAYOUT.rug.z);
  group.add(border);
  const inner = new Mesh(geometry.rounded.rug, materials.rug);
  inner.position.set(0, LAYOUT.rug.height + 0.006, LAYOUT.rug.z);
  group.add(inner);
  return group;
}

/**
 * A potted **sunflower** for the assistant's desk: a thick green stem, a few large
 * leaves, and a head with a dark-brown seed disc inside a ring of yellow petals.
 * Deliberately a different object from the room's floor plants (which stay leafy
 * and green): the yellow head is unmistakable at focus distance.
 */
export function buildSunflower(
  library: SharedGeometry,
  materials: RoomMaterials,
): Mesh[] {
  const geometry = library;
  const potParts = [
    {
      geometry: geometry.cylinder,
      placement: { position: [0, 0.2, 0], scale: [0.42, 0.4, 0.42] },
    },
    {
      geometry: geometry.cylinder,
      placement: { position: [0, 0.4, 0], scale: [0.46, 0.06, 0.46] },
    },
  ];
  const meshes: Mesh[] = [];
  const pot = sharedMesh(library, "flower:pot", materials.flowerPot, potParts);
  if (pot !== null) meshes.push(pot);
  const soil = new Mesh(geometry.cylinder, materials.flowerSoil);
  soil.scale.set(0.38, 0.04, 0.38);
  soil.position.y = 0.42;
  meshes.push(soil);

  // A thick stem, slightly leaning, with a couple of large leaves on short stalks.
  // Kept short on purpose: a trimmed desk sunflower, whose head sits just above a
  // seated person's laptop rather than towering over the desk.
  const stemHeight = 0.62;
  const lean = 0.1;
  const stemParts = [
    {
      geometry: geometry.cylinder,
      placement: {
        position: [0, 0.42 + stemHeight / 2, 0],
        scale: [0.1, stemHeight, 0.1],
        rotation: [0, 0, lean],
      },
    },
  ];
  const leafParts: Array<{ geometry: BufferGeometry; placement?: Placement }> =
    [];
  for (const [height, side] of [
    [0.34, -1],
    [0.5, 1],
    [0.2, 1],
  ] as const) {
    leafParts.push({
      geometry: geometry.sphereLow,
      placement: {
        position: [side * 0.3, 0.42 + height, 0.06],
        rotation: [0.2, 0, side * -0.35],
        scale: [0.3, 0.05, 0.2],
      },
    });
    stemParts.push({
      geometry: geometry.cylinder,
      placement: {
        position: [side * 0.16, 0.42 + height - 0.05, 0.03],
        scale: [0.04, 0.3, 0.04],
        rotation: [0, 0, side * -1.1],
      },
    });
  }
  const stem = sharedMesh(
    library,
    "flower:stem",
    materials.flowerStem,
    stemParts,
  );
  if (stem !== null) meshes.push(stem);
  const leaves = sharedMesh(
    library,
    "flower:leaves",
    materials.flowerLeaf,
    leafParts,
  );
  if (leaves !== null) meshes.push(leaves);

  // The head: dark seed disc, a ring of petals behind it, and a second, shorter
  // ring offset by half a step so the petals read as staggered layers.
  const headY = 0.42 + stemHeight + 0.05;
  const headX = lean * stemHeight;
  const disc = new Mesh(geometry.cylinder, materials.sunflowerDisc);
  disc.scale.set(0.34, 0.08, 0.34);
  disc.position.set(headX, headY, 0);
  disc.rotation.x = Math.PI / 2.6;
  meshes.push(disc);

  const petalParts: Array<{ geometry: BufferGeometry; placement?: Placement }> =
    [];
  for (const [radius, count, petals, y] of [
    [0.36, 10, 0.2, 0],
    [0.44, 8, 0.16, -0.03],
  ] as const) {
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2 + (y === 0 ? 0 : 0.3);
      petalParts.push({
        geometry: geometry.sphereLow,
        placement: {
          position: [
            headX + Math.cos(angle) * radius,
            headY + y,
            Math.sin(angle) * radius,
          ],
          rotation: [0, -angle, 0],
          scale: [petals, 0.05, 0.1],
        },
      });
    }
  }
  const petals = sharedMesh(
    library,
    "flower:petals",
    materials.sunflowerPetal,
    petalParts,
  );
  if (petals !== null) meshes.push(petals);
  return meshes;
}

/** A notepad + pen: small, cheap, and it breaks up a bare desktop. */
export function buildNotepad(
  geometry: SharedGeometry,
  padMaterial: Material,
  penMaterial: Material,
): Mesh[] {
  const pad = new Mesh(geometry.slab, padMaterial);
  pad.scale.set(0.5, 1, 0.66);
  const pen = new Mesh(geometry.cylinder, penMaterial);
  pen.scale.set(0.05, 0.5, 0.05);
  pen.rotation.z = Math.PI / 2.2;
  pen.position.set(0.34, 0.06, 0.12);
  return [pad, pen];
}

/** Coffee mug (also the prop the "coffee" rest animation lifts). */
export function buildMug(geometry: SharedGeometry, material: Material): Mesh {
  const mug = new Mesh(geometry.cylinder, material);
  mug.scale.set(0.16, 0.22, 0.16);
  mug.position.y = 0.11;
  return mug;
}

/**
 * The figure's proportions and anchors, in one place with the rest of the art.
 *
 * Everyone is the same height on purpose (the boss's call): the difference between
 * two people comes from hair, clothing and colour, never from their size, so a
 * bubble and a hover card sit at the same height for everybody.
 */
export const FIGURE = {
  /** The figure's root, sitting on the floor at the casters. */
  rootY: 0.06,
  /** Top of the chair cushion: thighs sit on this, not inside it. */
  seatTopY: 0.58,
  hipY: 0.6,
  shoulderY: 1.26,
  headY: 1.56,
  /** Radius of the (slightly squashed) head sphere. */
  headRadius: 0.34,
  /** Bubble anchor: clearly above the head, not on it. */
  headAnchorY: 2.3,
  /** Hover card anchor: the top of the head. */
  hoverAnchorY: 1.96,
  /** Where the hand is, relative to the shoulder joint. */
  handGripY: -0.6,
  handGripZ: 0.12,
} as const;
