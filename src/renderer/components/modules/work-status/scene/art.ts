import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  type BufferGeometry,
  Shape,
  ShapeGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
  RepeatWrapping,
  SRGBColorSpace,
  type Material,
  type Texture,
} from "three";

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
 * The design language follows the app's: warm neutrals from the design system's
 * spine, one accent per room (identity, not decoration), no glossy materials, no
 * heavy shading — a calm, clean "office at rest" look.
 */

/** Room shell, in world units (1 ≈ 40 cm). */
export const ROOM = {
  width: 16,
  depth: 13,
  wallHeight: 5.2,
  wallThickness: 0.4,
  floorThickness: 0.3,
} as const;

/** Where things sit inside a room (local coordinates, +z toward the viewer). */
export const LAYOUT = {
  /** Progress screen: far wall, above the assistant's desk. */
  screen: {
    width: 8.6,
    height: 4.4,
    y: 3.0,
    z: -ROOM.depth / 2 + ROOM.wallThickness + 0.06,
  },
  /** The assistant's desk, between the screen and the meeting table. */
  assistantDesk: { width: 4.4, height: 1.05, depth: 1.8, y: 0, z: -1.6 },
  /**
   * The long meeting table the employees sit around. Its width follows the
   * seating (`tableWidthFor`), so a two-person group does not sit at a table
   * built for ten.
   */
  table: { maxWidth: 10.6, minWidth: 5.2, height: 1.05, depth: 2.6, z: 2.6 },
  /** Seats along the long sides, per side, at most. */
  maxSeatsPerSide: 4,
} as const;

/** Camera behaviour. */
export const CAMERA = {
  fov: 32,
  /** The boss asked for a 45° look-down onto every room. */
  pitchDeg: 45,
  /**
   * Focus distance: a multiple of the room's width. The screen has to stay
   * readable and the meeting table has to stay in frame, so the fit is not
   * "the whole cuboid" (that would pull back until the room reads as a plan
   * view) but "the room's contents".
   */
  focusDistanceFactor: 1.62,
  /** Height the focused camera looks at (between the screen and the table). */
  focusTargetY: 1.95,
  /** Breathing room around the whole grid. */
  birdFill: 1.1,
  /** Focus ↔ bird's-eye transition (ms). */
  transitionMs: 650,
  /**
   * Drag-to-look-around limits inside a focused room. Azimuth ±32° keeps the
   * camera in front of the room (the back wall never comes between it and the
   * seats); pitch stays between 30° and 64°, so it is never under the floor and
   * never overhead.
   */
  orbitAzimuthLimit: 0.56,
  orbitPitchRange: 0.33,
  orbitPitchMin: 0.52,
  orbitPitchMax: 1.12,
} as const;

/**
 * Light rig per theme. The dark room is dimmer and softer: the same intensities
 * would wash the sunk shell back to grey and lose the depth the palette just
 * gained.
 */
export const LIGHTING = {
  light: {
    sky: 0xffffff,
    ground: 0xc9c4bd,
    hemi: 1.25,
    sun: 0.6,
    ambient: 0.2,
  },
  dark: { sky: 0xdfe6f0, ground: 0x2c3036, hemi: 0.9, sun: 0.5, ambient: 0.14 },
} as const;

export interface RoomPalette {
  /** Carpet paint: the accent, darker and less saturated than the wall. */
  carpet: number;
  floor: number;
  wall: number;
  wallTrim: number;
  desk: number;
  deskTop: number;
  table: number;
  chair: number;
  metal: number;
  screenBezel: number;
  screenFace: number;
  accent: number;
  plant: number;
  plantPot: number;
  laptop: number;
  mug: number;
}

/**
 * One palette per room, picked deterministically from the chat id, so a given
 * task group always looks the same (coming back to the board must not reshuffle
 * the room's identity).
 */
export const ROOM_PALETTES: readonly RoomPalette[] = [
  {
    floor: 0xe2dcd1,
    carpet: 0xe2dcd1,
    wall: 0xf4f1ec,
    wallTrim: 0xded5c8,
    desk: 0xcfc4b4,
    deskTop: 0xb9ac99,
    table: 0xb7a894,
    chair: 0x5a6672,
    metal: 0x9aa3ac,
    screenBezel: 0x2b2f36,
    screenFace: 0x323943,
    accent: 0x07c160,
    plant: 0x5c8a5a,
    plantPot: 0xb98d6b,
    laptop: 0xb9bec6,
    mug: 0xd9876a,
  },
  {
    floor: 0xdde1e5,
    carpet: 0xdde1e5,
    wall: 0xf2f4f6,
    wallTrim: 0xd5dbe1,
    desk: 0xc3c8d0,
    deskTop: 0xaab1bb,
    table: 0xa9b1bd,
    chair: 0x4e5a66,
    metal: 0x8e97a1,
    screenBezel: 0x262a31,
    screenFace: 0x2c333d,
    accent: 0x3f8cff,
    plant: 0x4f7f63,
    plantPot: 0xa8907c,
    laptop: 0xb2b8c0,
    mug: 0xe0b46a,
  },
  {
    floor: 0xe5ded4,
    carpet: 0xe5ded4,
    wall: 0xf5f1ea,
    wallTrim: 0xe2d5c6,
    desk: 0xd3c5b2,
    deskTop: 0xbda98f,
    table: 0xbfa88c,
    chair: 0x69564a,
    metal: 0xa49a90,
    screenBezel: 0x2d2a27,
    screenFace: 0x352f2b,
    accent: 0xfa9d3c,
    plant: 0x6b8f4f,
    plantPot: 0xc09574,
    laptop: 0xc0bcb6,
    mug: 0x7fa8c9,
  },
  {
    floor: 0xdfe2dd,
    carpet: 0xdfe2dd,
    wall: 0xf3f4f1,
    wallTrim: 0xd9e0d7,
    desk: 0xbfc9bd,
    deskTop: 0xa4b1a5,
    table: 0xa6b3a7,
    chair: 0x53625b,
    metal: 0x939d97,
    screenBezel: 0x272d2b,
    screenFace: 0x2e3634,
    accent: 0x8f6bd8,
    plant: 0x4c8455,
    plantPot: 0xb08f74,
    laptop: 0xb4bab5,
    mug: 0xc98f8f,
  },
] as const;

export interface PersonPalette {
  skin: number;
  hair: number;
  shirt: number;
  shirtDark: number;
}

/** Skin tones, hair colours and shirts combined into a wardrobe below. */
const SKIN_TONES = [
  0xe8c4a2, 0xd9ab86, 0xf0d0b4, 0xc99874, 0xe9c9ae, 0xd7b192,
] as const;
const HAIR_COLORS = [
  0x3b2f2a, 0x1f1b19, 0x6a4a34, 0x2a2320, 0x9a8b7a, 0x4a3c34,
] as const;
const SHIRTS = [
  0x5f7f9e, 0x8f6f5a, 0x6d8f6a, 0x9a6a86, 0x7b7fa8, 0xa8834f, 0x5a8a8a,
  0x9d6a5a, 0x6a7a9a, 0x8a7a5a,
] as const;

/** Darken a shirt colour for its shaded blocks (shoulders, sleeves). */
function shade(hex: number, amount: number): number {
  return new Color(hex).lerp(new Color(0x000000), amount).getHex();
}

/**
 * Everyone in a room must be tellable apart, so the wardrobe is a *list* the room
 * seats people from (see `personPaletteFor`) rather than a per-person hash: hair
 * colour walks with the seat, shirt colour walks faster, and the crossing gives
 * 30 looks before anything repeats. Across rooms the starting offset comes from
 * the chat id, so two rooms do not look identical either.
 */
export const PERSON_WARDROBE: readonly PersonPalette[] = Array.from(
  { length: 30 },
  (_unused, index) => {
    const shirt = SHIRTS[index % SHIRTS.length]!;
    return {
      skin: SKIN_TONES[index % SKIN_TONES.length]!,
      hair: HAIR_COLORS[(index * 5) % HAIR_COLORS.length]!,
      shirt,
      shirtDark: shade(shirt, 0.22),
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

/**
 * Dark theme: the same rooms, sunk toward the app's dark chrome.
 *
 * Derived rather than hand-written as a second palette set, because a replica
 * would drift the moment a light palette is tuned. Only the *shell* goes dark —
 * the accent, the mugs and the screen glass keep their identity, which is what
 * makes a room still recognisable in the dark.
 */
const DARK_SHELL = 0x30343a;
const DARK_INK = 0x22262b;

function sink(hex: number, toward: number, amount: number): number {
  return new Color(hex).lerp(new Color(toward), amount).getHex();
}

function darkPalette(palette: RoomPalette): RoomPalette {
  return {
    floor: sink(palette.floor, DARK_SHELL, 0.9),
    carpet: sink(palette.carpet, DARK_SHELL, 0.9),
    wall: sink(palette.wall, DARK_SHELL, 0.8),
    wallTrim: sink(palette.wallTrim, DARK_INK, 0.78),
    desk: sink(palette.desk, DARK_SHELL, 0.7),
    deskTop: sink(palette.deskTop, DARK_SHELL, 0.6),
    table: sink(palette.table, DARK_SHELL, 0.6),
    chair: sink(palette.chair, DARK_INK, 0.3),
    metal: sink(palette.metal, DARK_INK, 0.5),
    screenBezel: sink(palette.screenBezel, 0x0b0d10, 0.5),
    screenFace: sink(palette.screenFace, 0x0b0d10, 0.5),
    accent: palette.accent,
    plant: sink(palette.plant, DARK_INK, 0.5),
    plantPot: sink(palette.plantPot, DARK_INK, 0.5),
    laptop: sink(palette.laptop, DARK_SHELL, 0.62),
    mug: palette.mug,
  };
}

/**
 * The room's accent is carried by **surfaces that already exist**, never by an
 * added shape: the wall is painted in a low-saturation step of the accent and the
 * chair fabric carries a hint of it. That is what makes two rooms tellable apart
 * at a glance without reviving the two "colour block" decorations the boss had
 * removed (a panel on the wall, a bar under the screen).
 *
 * Amounts are deliberately small: the wardrobe has to stay the loudest thing in
 * the room, so the tint must never compete with a shirt.
 */
function tintWithAccent(hex: number, accent: number, amount: number): number {
  // Shift the *hue* toward the room's accent and keep the surface's own lightness
  // and saturation. Blending RGB toward a saturated accent (the obvious way) turns
  // a dark theme's floor into a saturated colour block; a hue shift only changes
  // which family of neutral the surface belongs to, which is exactly "a room you
  // can tell apart, not a patch of colour".
  const base = new Color(hex);
  const target = new Color(accent);
  const from = { h: 0, s: 0, l: 0 };
  const to = { h: 0, s: 0, l: 0 };
  base.getHSL(from);
  target.getHSL(to);
  let delta = to.h - from.h;
  // Take the short way round the hue circle.
  if (delta > 0.5) delta -= 1;
  if (delta < -0.5) delta += 1;
  const hue = (from.h + delta * amount + 1) % 1;
  // A whisper of the accent's saturation, never more than the surface had plus a
  // little: a grey wall stays a grey wall, just a warmer/cooler one.
  const saturation = from.s + (to.s - from.s) * amount * 0.25;
  return base
    .setHSL(hue, Math.max(0, Math.min(1, saturation)), from.l)
    .getHex();
}

export function roomPaletteFor(chatId: number, dark = false): RoomPalette {
  const base = pick(ROOM_PALETTES, chatId * 7 + 3);
  const palette = dark ? darkPalette(base) : base;
  const accent = new Color(palette.accent);
  const accentHsl = { h: 0, s: 0, l: 0 };
  accent.getHSL(accentHsl);

  // Walls are *painted* in the room's accent: a low-saturation, mid-lightness paint
  // rather than a saturated colour block. The baseboard/trim keeps a slightly
  // darker step of the same paint, which is what keeps the wall reading as a
  // surface with depth instead of a flat fill.
  const paint = (saturation: number, lightness: number): number =>
    new Color().setHSL(accentHsl.h, saturation, lightness).getHex();

  return {
    ...palette,
    // Dark theme: the same paint, but a dark, only-faintly-coloured one. Saturated
    // walls at that lightness read as glowing colour bands, not as a room.
    wall: paint(dark ? 0.16 : 0.3, dark ? 0.27 : 0.84),
    wallTrim: paint(dark ? 0.16 : 0.28, dark ? 0.34 : 0.74),
    // The carpet shares the wall's hue but is clearly *darker and calmer* in the
    // light theme (and a step lighter in the dark one), so the painted wall and the
    // textile floor never merge into one surface.
    carpet: paint(dark ? 0.2 : 0.32, dark ? 0.3 : 0.58),
    // The chair fabric keeps a hint of the accent too, since it is read up close.
    chair: tintWithAccent(palette.chair, palette.accent, dark ? 0.5 : 0.7),
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
 * Geometries shared by every room. One instanced-by-reference set keeps the
 * scene's memory flat no matter how many rooms are on the board; nothing here is
 * mutated after creation, so sharing is safe.
 */
export interface SharedGeometry {
  floor: BoxGeometry;
  wall: BoxGeometry;
  panel: PlaneGeometry;
  box: BoxGeometry;
  slab: BoxGeometry;
  cylinder: CylinderGeometry;
  sphere: SphereGeometry;
  disc: CircleGeometry;
}

export function createSharedGeometry(): SharedGeometry {
  return {
    floor: new BoxGeometry(ROOM.width, ROOM.floorThickness, ROOM.depth),
    wall: new BoxGeometry(ROOM.width, ROOM.wallHeight, ROOM.wallThickness),
    panel: new PlaneGeometry(1, 1),
    box: new BoxGeometry(1, 1, 1),
    slab: new BoxGeometry(1, 0.12, 1),
    cylinder: new CylinderGeometry(0.5, 0.5, 1, 14),
    sphere: new SphereGeometry(0.5, 16, 12),
    disc: new CircleGeometry(0.5, 20),
  };
}

export interface RoomMaterials {
  floor: Material;
  wall: Material;
  wallTrim: Material;
  desk: Material;
  deskTop: Material;
  table: Material;
  chair: Material;
  metal: Material;
  /** The paper notepad's cover: a muted red, clearly not another wooden prop. */
  notepad: Material;
  dispenserBody: Material;
  dispenserDark: Material;
  dispenserBottle: Material;
  dispenserCup: Material;
  alocasiaPot: Material;
  alocasiaSoil: Material;
  alocasiaStem: Material;
  alocasiaRing: Material;
  alocasiaPetiole: Material;
  alocasiaLeaf: Material;
  screenBezel: Material;
  screenFace: Material;
  plant: Material;
  plantPot: Material;
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
}

/**
 * Surface finishes. Roughness/metalness is what stops the room from looking like
 * painted plastic: fabric and matte paint scatter light, metal reflects it, and a
 * few materials get a faint emissive lift (screens, the accent bar) so they read
 * as *lit*, not just coloured. Everything a later art pass wants to tune is here.
 */
const FINISH: Record<
  "matte" | "soft" | "wood" | "fabric" | "metal" | "glass" | "screen",
  { roughness: number; metalness: number }
> = {
  matte: { roughness: 0.95, metalness: 0 },
  soft: { roughness: 0.82, metalness: 0.03 },
  wood: { roughness: 0.62, metalness: 0.06 },
  fabric: { roughness: 0.97, metalness: 0 },
  metal: { roughness: 0.34, metalness: 0.8 },
  glass: { roughness: 0.28, metalness: 0.15 },
  screen: { roughness: 0.22, metalness: 0.1 },
};

/** A wood surface: the species' grain as a map, mid-roughness so it never shines. */
function woodMaterial(species: WoodSpecies): MeshStandardMaterial {
  return new MeshStandardMaterial({
    map: woodTexture(species),
    roughness: 0.62,
    metalness: 0.02,
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
    // Carpet in the room's own accent: same hue family as the painted wall, but
    // darker and less saturated, and visibly *textured* — wall smooth, floor fuzzy.
    floor: new MeshStandardMaterial({
      map: carpetTexture(dark ? "dark" : "light"),
      color: palette.carpet,
      roughness: 0.98,
      metalness: 0,
    }),
    wall: standard(palette.wall, "matte"),
    wallTrim: standard(palette.wallTrim, "soft"),
    // Two species, not one brown at two brightnesses: a dark walnut desk and a
    // light oak meeting table. The grain is a cached texture; roughness stays
    // mid-high so the streaks never sparkle.
    desk: woodMaterial("walnut"),
    deskTop: woodMaterial("walnut"),
    table: woodMaterial("oak"),
    chair: standard(palette.chair, "fabric"),
    metal: standard(palette.metal, "metal"),
    notepad: standard(0xb5443a, "soft"),
    // A white appliance body, dark recesses and a translucent blue bottle: reads as
    // "office water cooler" in both themes without picking up the room's accent.
    dispenserBody: standard(0xe8e8e6, "soft"),
    dispenserDark: standard(0x3a3d42, "soft"),
    dispenserBottle: new MeshStandardMaterial({
      color: 0x8fc4e8,
      roughness: 0.15,
      metalness: 0.05,
      transparent: true,
      opacity: 0.72,
    }),
    dispenserCup: standard(0xf2f2f0, "soft"),
    // The alocasia: dark terracotta pot, rough grey-brown ringed stems, waxy
    // (low-roughness) deep green blades with a pale vein map.
    alocasiaPot: standard(0x6b4632, "soft"),
    alocasiaSoil: standard(0x2f2318, "matte"),
    alocasiaStem: standard(0x8a7458, "matte"),
    alocasiaRing: standard(0x6d5a44, "matte"),
    alocasiaPetiole: standard(0x3f6f36, "soft"),
    alocasiaLeaf: new MeshStandardMaterial({
      map: leafVeinTexture(),
      color: 0xffffff,
      roughness: 0.35,
      metalness: 0.02,
      side: DoubleSide,
    }),
    screenBezel: standard(palette.screenBezel, "glass"),
    // Screen glass: used by the laptops' display. The room's wall screen is a
    // textured basic material (see `screen-texture.ts`), not this one.
    screenFace: standard(palette.screenFace, "screen", {
      color: palette.screenFace,
      intensity: 0.55,
    }),
    plant: standard(palette.plant, "matte"),
    plantPot: standard(palette.plantPot, "soft"),
    // A sunflower, not foliage: yellow petals around a dark seed disc, thick green
    // stem, pale ceramic pot. Fixed colours (not per room), so it always reads as
    // "the assistant's sunflower" rather than as another plant.
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
    // Contact shadows: a soft radial falloff instead of the shadow map (a depth
    // pass per room would cost more than the look is worth on a 24-room board).
    shadow: new MeshBasicMaterial({
      map: softShadowTexture(),
      transparent: true,
      // Soft grounding shadow. The boss asked what the darker patch under a chair
      // is (it is this disc); it is kept — it is what stops a chair from looking
      // like it floats — but weakened so it never reads as a stain on the floor.
      opacity: 0.26,
      depthWrite: false,
    }),
  };
}

/**
 * Species of wood the two tables are made of. The desk is a dark walnut (deep,
 * slightly cool brown), the meeting table a light oak (warm, much lighter) — two
 * clearly different species rather than one brown at two brightnesses.
 */
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

/** Anisotropy the renderer can afford; set once by the stage (`setWoodAnisotropy`). */
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
 * survive a 45° view *and* a close focus shot: the anisotropy (set from the
 * renderer's capability) is what keeps the streaks from turning into noise when
 * the surface is seen at a grazing angle, which is exactly how a table top is
 * seen from the bird's-eye camera.
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

    // Long streaks along U, at a handful of spacings, so the grain reads as wood
    // rather than as stripes.
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let index = 0; index < 900; index += 1) {
      const y = random() * height;
      const thickness = 0.6 + random() * 2.2;
      context.strokeStyle = random() > 0.45 ? spec.grain : spec.grainAlt;
      context.globalAlpha = 0.1 + random() * 0.35;
      context.lineWidth = thickness;
      context.beginPath();
      // A slightly wavy line: real grain is never perfectly straight.
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
    context.globalAlpha = 0.5;
    for (const [cx, cy] of [
      [width * 0.24, height * 0.62],
      [width * 0.68, height * 0.33],
    ] as const) {
      for (let ring = 0; ring < 5; ring += 1) {
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

/**
 * A short-pile carpet: coarse grain plus short random fibres (drawn as tiny
 * dashes), which is what makes it read as *fabric* next to the smooth painted
 * wall. Generated once per theme in neutral grey; each room tints it with its own
 * accent through the material's colour, so the grain stays identical and the hue
 * is per room.
 */
function carpetTexture(species: "light" | "dark"): Texture {
  const cached = CARPET_TEXTURES.get(species);
  if (cached !== undefined) return cached;

  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  let seed = species === "dark" ? 13 : 29;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  if (context !== null) {
    context.fillStyle = species === "dark" ? "#8f8f8f" : "#cfcec9";
    context.fillRect(0, 0, size, size);

    // Coarse per-pixel grain: a big, high-frequency amplitude is what the eye
    // reads as pile rather than as a smooth surface.
    const image = context.getImageData(0, 0, size, size);
    for (let index = 0; index < image.data.length; index += 4) {
      const jitter = (random() - 0.5) * 46;
      for (const channel of [0, 1, 2]) {
        image.data[index + channel] = Math.max(
          0,
          Math.min(255, image.data[index + channel]! + jitter),
        );
      }
    }
    context.putImageData(image, 0, 0);

    // Short fibres: little dashes in random directions, so the weave is visible at
    // close range and turns at grazing angles instead of streaking like wood.
    for (let index = 0; index < 2600; index += 1) {
      const x = random() * size;
      const y = random() * size;
      const length = 2 + random() * 5;
      const angle = random() * Math.PI * 2;
      context.strokeStyle = random() > 0.5 ? "#ffffff" : "#5c5c5c";
      context.globalAlpha = 0.12 + random() * 0.3;
      context.lineWidth = 0.8 + random() * 1.2;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(
        x + Math.cos(angle) * length,
        y + Math.sin(angle) * length,
      );
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  // Dense repeat: the fibres must be small on screen, or they look like sticks.
  texture.repeat.set(9, 8);
  texture.anisotropy = WOOD_ANISOTROPY;
  CARPET_TEXTURES.set(species, texture);
  return texture;
}

const CARPET_TEXTURES = new Map<"light" | "dark", Texture>();

let LEAF_TEXTURE: Texture | null = null;

/**
 * The blade's colour and veins: deep green with a lighter midrib and lateral
 * veins. Drawn once, shared by every leaf; the waxy finish comes from the
 * material's low roughness, not from the texture.
 */
function leafVeinTexture(): Texture {
  if (LEAF_TEXTURE !== null) return LEAF_TEXTURE;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context !== null) {
    // Leaf silhouette runs vertically through the texture (base at the bottom).
    context.fillStyle = "#1f4a24";
    context.fillRect(0, 0, size, size);

    context.strokeStyle = "#9fce8f";
    context.lineWidth = 5;
    context.beginPath();
    context.moveTo(size / 2, size - 6);
    context.lineTo(size / 2, 8);
    context.stroke();

    context.lineWidth = 2.2;
    for (let index = 0; index < 7; index += 1) {
      const y = size - 30 - index * 30;
      context.beginPath();
      context.moveTo(size / 2, y);
      context.quadraticCurveTo(size * 0.2, y - 26, 14, y - 52);
      context.stroke();
      context.beginPath();
      context.moveTo(size / 2, y);
      context.quadraticCurveTo(size * 0.8, y - 26, size - 14, y - 52);
      context.stroke();
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = WOOD_ANISOTROPY;
  LEAF_TEXTURE = texture;
  return texture;
}

let SHADOW_TEXTURE: Texture | null = null;

/** A cached radial-gradient disc: the soft "grounding" blob under furniture. */
function softShadowTexture(): Texture {
  if (SHADOW_TEXTURE !== null) return SHADOW_TEXTURE;
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
    gradient.addColorStop(0.55, "rgba(0,0,0,0.22)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  SHADOW_TEXTURE = texture;
  return texture;
}

/** Soft ground shadow under one object. */
export function buildContactShadow(
  geometry: SharedGeometry,
  material: Material,
  radius: number,
): Mesh {
  const mesh = new Mesh(geometry.disc, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.scale.set(radius, radius, 1);
  mesh.position.y = ROOM.floorThickness / 2 + 0.012;
  mesh.renderOrder = -1;
  return mesh;
}

/**
 * A laptop, opened toward whoever is using it: one integrated model — a body with
 * the keyboard and trackpad **inset flush** into its top, a hinge along the back
 * edge, and a lid that turns about that hinge so the screen can never come apart
 * from the body.
 *
 * At rotation 0 the laptop serves a person standing at **+z**: the trackpad is on
 * that side, and the lid's tilt makes the display (on the lid's inner face) look
 * toward +z as well. Callers therefore turn the group by
 * `seatRotation + π` — the seat's forward vector points *away* from its occupant.
 * The lid opens to `LAPTOP_OPEN_DEG` = 100°, a touch past vertical, which is how a
 * laptop is actually used.
 */
export const LAPTOP_OPEN_DEG = 100;

export function buildLaptop(
  geometry: SharedGeometry,
  materials: RoomMaterials,
): Group {
  // One group per laptop: the caller places and *yaws* this group, so the screen's
  // facing is decided by the object's own rotation (yawing each part separately
  // cannot change where a tilted lid points — that was the orientation bug).
  const laptop = new Group();

  // The body: 1.12 wide, 0.09 thick, 0.78 deep, resting on y = 0.
  const body = new Mesh(geometry.box, materials.laptop);
  body.scale.set(1.12, 0.09, 0.78);

  // Keyboard and trackpad are *panels set into* the body's top face: a millimetre
  // or two proud at most, never blocks standing on it.
  const keyboard = new Mesh(geometry.box, materials.laptopKeys);
  keyboard.scale.set(1.0, 0.012, 0.36);
  keyboard.position.set(0, 0.045, -0.13);
  const trackpad = new Mesh(geometry.box, materials.laptopKeys);
  trackpad.scale.set(0.34, 0.008, 0.16);
  trackpad.position.set(0, 0.044, 0.24);

  // The hinge bar along the body's back edge…
  const hingeBar = new Mesh(geometry.cylinder, materials.metal);
  hingeBar.scale.set(0.06, 1.0, 0.06);
  hingeBar.rotation.z = Math.PI / 2;
  hingeBar.position.set(0, 0.045, -0.38);

  // …and the lid, parented to a pivot *at* that edge, so its bottom edge is the
  // hinge: no gap, no floating screen whatever the opening angle is.
  const pivot = new Group();
  pivot.position.set(0, 0.045, -0.38);
  pivot.rotation.x = -(LAPTOP_OPEN_DEG * Math.PI) / 180;

  const lid = new Mesh(geometry.box, materials.laptop);
  // Extends along +z from the pivot in its own frame; after the tilt it stands up
  // and leans back by (100° − 90°).
  lid.scale.set(1.08, 0.05, 0.74);
  lid.position.set(0, 0, 0.37);

  // The display sits on the lid's **inner** face (the one facing the base when
  // closed, so the one the user looks at when open).
  const display = new Mesh(geometry.box, materials.screenFace);
  display.scale.set(0.98, 0.02, 0.66);
  display.position.set(0, -0.033, 0.37);
  pivot.add(lid, display);

  laptop.add(body, keyboard, trackpad, hingeBar, pivot);
  return laptop;
}

/**
 * A water dispenser: a floor-standing body with a drip tray and two taps, a big
 * translucent bottle on top, and a small cup stack beside it. Built facing **+z**;
 * the room turns it toward whatever it should face.
 */
export function buildWaterDispenser(
  geometry: SharedGeometry,
  materials: RoomMaterials,
): Group {
  const group = new Group();

  const body = new Mesh(geometry.box, materials.dispenserBody);
  body.scale.set(0.62, 1.05, 0.52);
  body.position.y = 0.55;

  const top = new Mesh(geometry.box, materials.dispenserBody);
  top.scale.set(0.66, 0.06, 0.56);
  top.position.y = 1.1;

  // Tap recess: a dark inset on the front face with two little taps.
  const recess = new Mesh(geometry.box, materials.dispenserDark);
  recess.scale.set(0.4, 0.34, 0.1);
  recess.position.set(0, 0.72, 0.25);
  const tray = new Mesh(geometry.box, materials.metal);
  tray.scale.set(0.44, 0.04, 0.16);
  tray.position.set(0, 0.5, 0.3);
  const tapHot = new Mesh(geometry.cylinder, materials.dispenserDark);
  tapHot.scale.set(0.06, 0.12, 0.06);
  tapHot.position.set(-0.1, 0.62, 0.3);
  const tapCold = new Mesh(geometry.cylinder, materials.dispenserDark);
  tapCold.scale.set(0.06, 0.12, 0.06);
  tapCold.position.set(0.1, 0.62, 0.3);

  // The bottle sits **mouth-down** in the seat on top of the machine (a bottle
  // standing upright cannot feed the taps): wide shoulder high, base up, thin neck
  // going down into a collar, with a seal ring where they meet.
  const seat = new Mesh(geometry.cylinder, materials.dispenserDark);
  seat.scale.set(0.34, 0.08, 0.34);
  seat.position.y = 1.14;

  const collar = new Mesh(geometry.cylinder, materials.dispenserBottle);
  collar.scale.set(0.2, 0.16, 0.2);
  collar.position.y = 1.25;

  const seal = new Mesh(geometry.cylinder, materials.dispenserCup);
  seal.scale.set(0.24, 0.03, 0.24);
  seal.position.y = 1.33;

  // Body: shoulder near the neck, base at the very top.
  const bottle = new Mesh(geometry.cylinder, materials.dispenserBottle);
  bottle.scale.set(0.48, 0.62, 0.48);
  bottle.position.y = 1.68;

  const shoulder = new Mesh(geometry.cylinder, materials.dispenserBottle);
  shoulder.scale.set(0.3, 0.14, 0.3);
  shoulder.position.y = 1.37;

  // The base, now facing up: a slightly wider disc with a raised rim.
  const base = new Mesh(geometry.cylinder, materials.dispenserDark);
  base.scale.set(0.5, 0.05, 0.5);
  base.position.y = 2.0;

  // A small cup stack on the side: the detail that says "drinking water".
  for (let index = 0; index < 3; index += 1) {
    const cup = new Mesh(geometry.cylinder, materials.dispenserCup);
    cup.scale.set(0.12, 0.06, 0.12);
    cup.position.set(0.42, 1.14 + index * 0.06, 0.1);
    group.add(cup);
  }

  group.add(
    body,
    top,
    recess,
    tray,
    tapHot,
    tapCold,
    seat,
    collar,
    seal,
    shoulder,
    bottle,
    base,
  );
  return group;
}

/**
 * The corner plant: an **Alocasia** (滴水观音) rather than a generic bush.
 *
 * Built from the reference: three thick, ringed pseudostems of different heights
 * leaning slightly outward out of a dark terracotta pot, each ending in long
 * petioles with large heart/arrow-shaped leaves. The leaves are real silhouettes
 * (`Shape` → `ShapeGeometry`, double-sided) carrying a small canvas texture with a
 * pale midrib and lateral veins, and they are glossy (low roughness) so they read
 * as the waxy leaves of the reference rather than as flat green plates.
 */
export function buildAlocasia(
  geometry: SharedGeometry,
  materials: RoomMaterials,
): Group {
  const plant = new Group();

  const pot = new Mesh(geometry.cylinder, materials.alocasiaPot);
  pot.scale.set(0.78, 0.62, 0.78);
  pot.position.y = 0.31;
  const rim = new Mesh(geometry.cylinder, materials.alocasiaPot);
  rim.scale.set(0.84, 0.08, 0.84);
  rim.position.y = 0.6;
  const soil = new Mesh(geometry.cylinder, materials.alocasiaSoil);
  soil.scale.set(0.72, 0.04, 0.72);
  soil.position.y = 0.62;
  plant.add(pot, rim, soil);

  const stems: Array<{ x: number; z: number; height: number; lean: number }> = [
    { x: -0.16, z: 0.04, height: 1.05, lean: -0.06 },
    { x: 0.14, z: -0.05, height: 0.92, lean: 0.1 },
    { x: 0.02, z: 0.14, height: 0.74, lean: 0.03 },
  ];

  for (const [index, stem] of stems.entries()) {
    // Pseudostem: thick, upright, slightly leaning, with rings of old leaf scars.
    const trunk = new Mesh(geometry.cylinder, materials.alocasiaStem);
    trunk.scale.set(0.15, stem.height, 0.15);
    trunk.position.set(
      stem.x + (stem.lean * stem.height) / 2,
      0.62 + stem.height / 2,
      stem.z,
    );
    trunk.rotation.z = stem.lean;
    plant.add(trunk);

    for (let ring = 0; ring < 4; ring += 1) {
      const scar = new Mesh(geometry.cylinder, materials.alocasiaRing);
      scar.scale.set(0.163, 0.02, 0.163);
      scar.position.set(
        stem.x + stem.lean * stem.height * (0.2 + ring * 0.2),
        0.62 + stem.height * (0.25 + ring * 0.19),
        stem.z,
      );
      scar.rotation.z = stem.lean;
      plant.add(scar);
    }

    // Two or three petioles out of the stem top, each with one leaf.
    const topY = 0.62 + stem.height;
    const topX = stem.x + stem.lean * stem.height;
    const leaves: Array<[number, number, number]> = [
      [-0.34 - index * 0.04, 0.5, 0.9],
      [0.3 + index * 0.05, 0.42, 0.78],
      [0.02, -0.34, 0.62],
    ];
    leaves.forEach(([dx, dz, size], leafIndex) => {
      // A short thick petiole rising outward from the stem top.
      const length = 0.62 + leafIndex * 0.06;
      const petiole = new Mesh(geometry.cylinder, materials.alocasiaPetiole);
      petiole.scale.set(0.05, length, 0.05);
      const direction = new Vector3(dx, 0, dz).normalize();
      const midX = topX + direction.x * length * 0.45;
      const midZ = stem.z + direction.z * length * 0.45;
      petiole.position.set(midX, topY + length * 0.4, midZ);
      petiole.rotation.z = -direction.x * 0.9;
      petiole.rotation.x = direction.z * 0.9;
      plant.add(petiole);

      const leaf = new Mesh(alocasiaLeafGeometry(), materials.alocasiaLeaf);
      const scale = size * (leafIndex === 2 ? 0.62 : 1);
      leaf.scale.set(scale, scale, scale);
      leaf.position.set(
        topX + direction.x * length * 1.05,
        topY + length * 0.85,
        stem.z + direction.z * length * 1.05,
      );
      // The blade is built in the XY plane (normal +z), so lay it down to face
      // outward and slightly up — otherwise it is seen edge-on and reads as a
      // sliver. The yaw turns it away from the stem.
      leaf.rotation.set(
        -Math.PI / 2 + 0.55 + leafIndex * 0.08,
        Math.atan2(dx, dz),
        0,
      );
      plant.add(leaf);
    });
  }

  return plant;
}

let ALOCASIA_LEAF: BufferGeometry | null = null;

/**
 * A heart/arrow-shaped leaf blade as flat geometry: wide rounded lobes at the
 * base, a pointed tip, and slightly wavy margins. Shared by every leaf.
 */
function alocasiaLeafGeometry(): BufferGeometry {
  if (ALOCASIA_LEAF !== null) return ALOCASIA_LEAF;
  const shape = new Shape();
  shape.moveTo(0, -0.5);
  shape.bezierCurveTo(-0.42, -0.42, -0.56, -0.05, -0.42, 0.2);
  shape.bezierCurveTo(-0.3, 0.38, -0.12, 0.46, 0, 0.52);
  shape.bezierCurveTo(0.12, 0.46, 0.3, 0.38, 0.42, 0.2);
  shape.bezierCurveTo(0.56, -0.05, 0.42, -0.42, 0, -0.5);
  ALOCASIA_LEAF = new ShapeGeometry(shape, 24);
  return ALOCASIA_LEAF;
}

/**
 * A potted **sunflower** for the assistant's desk: a thick green stem, a few large
 * leaves, and a head with a dark-brown seed disc inside a ring of yellow petals.
 * Deliberately a different object from the room's floor plants (which stay leafy
 * and green): the yellow head is unmistakable at focus distance.
 */
export function buildSunflower(
  geometry: SharedGeometry,
  materials: RoomMaterials,
): Mesh[] {
  const parts: Mesh[] = [];

  const pot = new Mesh(geometry.cylinder, materials.flowerPot);
  pot.scale.set(0.42, 0.4, 0.42);
  pot.position.y = 0.2;
  const rim = new Mesh(geometry.cylinder, materials.flowerPot);
  rim.scale.set(0.46, 0.06, 0.46);
  rim.position.y = 0.4;
  const soil = new Mesh(geometry.cylinder, materials.flowerSoil);
  soil.scale.set(0.38, 0.04, 0.38);
  soil.position.y = 0.42;
  parts.push(pot, rim, soil);

  // A thick stem, slightly leaning, with a couple of large leaves on short stalks.
  // Kept short on purpose: a trimmed desk sunflower, whose head sits just above a
  // seated person's laptop rather than towering over the desk.
  const stemHeight = 0.62;
  const lean = 0.1;
  const stem = new Mesh(geometry.cylinder, materials.flowerStem);
  stem.scale.set(0.1, stemHeight, 0.1);
  stem.position.set(0, 0.42 + stemHeight / 2, 0);
  stem.rotation.z = lean;
  parts.push(stem);

  // Leaves along the stem: heights are fractions of it, so they stay attached if
  // the stem is retuned.
  for (const [height, side] of [
    [0.34, -1],
    [0.5, 1],
    [0.2, 1],
  ] as const) {
    const leaf = new Mesh(geometry.sphere, materials.flowerLeaf);
    // Flat, wide, heart-ish: a squashed sphere reads as a large leaf at this size.
    leaf.scale.set(0.3, 0.05, 0.2);
    leaf.position.set(side * 0.3, 0.42 + height, 0.06);
    leaf.rotation.set(0.2, 0, side * -0.35);
    const stalk = new Mesh(geometry.cylinder, materials.flowerStem);
    stalk.scale.set(0.04, 0.3, 0.04);
    stalk.position.set(side * 0.16, 0.42 + height - 0.05, 0.03);
    stalk.rotation.z = side * -1.1;
    parts.push(stalk, leaf);
  }

  // The head: dark seed disc, a ring of petals behind it, and a second, shorter
  // ring offset by half a step so the petals read as staggered layers.
  const headY = 0.42 + stemHeight + 0.05;
  const headX = lean * stemHeight;
  const disc = new Mesh(geometry.cylinder, materials.sunflowerDisc);
  disc.scale.set(0.34, 0.08, 0.34);
  disc.position.set(headX, headY, 0);
  disc.rotation.x = Math.PI / 2.6;
  parts.push(disc);

  for (const [radius, count, petals, y] of [
    [0.36, 10, 0.2, 0],
    [0.44, 8, 0.16, -0.03],
  ] as const) {
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2 + (y === 0 ? 0 : 0.3);
      const petal = new Mesh(geometry.sphere, materials.sunflowerPetal);
      petal.scale.set(petals, 0.05, 0.1);
      petal.position.set(
        headX + Math.cos(angle) * radius,
        headY + y,
        Math.sin(angle) * radius,
      );
      petal.rotation.y = -angle;
      parts.push(petal);
    }
  }

  return parts;
}

/** A notepad + pen: small, cheap, and it breaks up a bare desktop. */ /** A notepad + pen: small, cheap, and it breaks up a bare desktop. */
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
