import {
  type BufferGeometry,
  Group,
  type Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from "three";
import type { RestKind } from "../state-machine";
import {
  buildChair,
  FIGURE,
  sharedMesh,
  sharedGeometrySet,
  type PersonPalette,
  type Placement,
  type RoomMaterials,
  type SharedGeometry,
} from "./art";

/**
 * Procedural cartoon people, and every pose they can hold.
 *
 * A figure is a small rig of groups rather than a skinned mesh: procedural rigs
 * need no asset pipeline, cost nothing to build, and pose by rotating a handful
 * of nodes — which is all the rest animations (coffee, swivel, exercise) need.
 *
 * Poses are **absolute**: every frame starts from the rest pose and applies the
 * current state, so switching between animations can never accumulate drift.
 *
 * The look follows the reference art: a big round head with two dots and brows, a
 * tapered torso split into shirt and trousers, capsule arms with hands, and
 * rounded legs. Everyone is the same height (see `FIGURE`); identity comes from
 * hair style, clothing colours and skin tone, and every part is one merged mesh per
 * material, so a room full of people stays inside its draw-call budget.
 */

export interface Figure {
  /** Root of the figure; the room places and orients it. */
  readonly root: Group;
  /** Anchor the HTML bubble is projected from (above the head, for bubbles). */
  readonly headAnchor: Object3D;
  /** Anchor for the hover card: exactly the top of the head. */
  readonly hoverAnchor: Object3D;
  /** Raycast target that maps a pointer hit back to this employee. */
  readonly pickTargets: Object3D[];
  /** Hand the mug over: the "coffee" animation shows it in the hand. */
  setHeldMug(mesh: Mesh): void;
  pose(input: FigurePose): void;
  dispose(): void;
}

export interface FigurePose {
  /** Wall-clock ms, used for the subtle idle/typing motion. */
  now: number;
  /**
   * `false` on the static bird's-eye board: hold the base seated pose — no
   * breathing, no rest animation. A frozen board should look like a photograph, not
   * like a paused video with one arm in the air.
   */
  animate: boolean;
  working: boolean;
  /** Rest animation in flight and its 0→1 progress. */
  rest: RestKind | null;
  restProgress: number;
}

interface Parts {
  swivel: Group;
  torso: Group;
  head: Group;
  armLeft: Group;
  armRight: Group;
}

export interface FigureOptions {
  palette: PersonPalette;
  geometry: SharedGeometry;
  /** The room's finishes (chair fabric/frame, metal). */
  materials: RoomMaterials;
  /**
   * Left-handed people lift the other mug (see the room's `mugSide`): a second,
   * cheap way to tell two seated employees apart.
   */
  leftHanded?: boolean;
  /**
   * The mug this person drinks from. It exists **only** while the "coffee"
   * animation plays, and only ever in the hand — nothing is left standing on the
   * desk (see `pose()`).
   */
  heldMug?: Mesh;
}

/** Smooth acceleration and deceleration, for the one full chair turn. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * One material per colour per figure (skin, hair, shirt, sleeves, trousers,
 * shoes, face), shared by every mesh of that person: the whole room's wardrobe
 * costs a handful of uniforms instead of one per body part.
 */
function personMaterials(palette: PersonPalette): Material[] {
  const matte = (color: number): Material =>
    new MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 });
  return [
    matte(palette.skin),
    matte(palette.hair),
    matte(palette.shirt),
    matte(palette.shirtDark),
    matte(palette.pants),
    matte(palette.shoes),
    matte(0x241f1c),
  ];
}

type PartList = Array<{ geometry: BufferGeometry; placement?: Placement }>;

/**
 * Hair: a spherical **cap** (never a full sphere — a ball of hair would swallow the
 * face) plus one or two style blocks behind/on top of it. The head faces +z, so
 * "back" is -z.
 */
function hairParts(
  geometry: SharedGeometry,
  style: PersonPalette["hairStyle"],
): PartList {
  const r = FIGURE.headRadius;
  const cap = (
    scale: [number, number, number],
    y: number,
    z = 0,
  ): {
    geometry: BufferGeometry;
    placement: Placement;
  } => ({
    geometry: geometry.hairCap,
    placement: { position: [0, y, z], scale },
  });
  const blob = (
    scale: [number, number, number],
    y: number,
    z = 0,
  ): { geometry: BufferGeometry; placement: Placement } => ({
    geometry: geometry.sphere,
    placement: { position: [0, y, z], scale },
  });

  switch (style) {
    case "bob":
      return [
        cap([r * 2.32, r * 2.34, r * 2.32], 0),
        // The back of the bob, down to the collar.
        blob([r * 1.9, r * 1.9, r * 1.2], -r * 0.15, -r * 0.5),
      ];
    case "bun":
      return [
        cap([r * 2.26, r * 2.28, r * 2.26], 0),
        blob([r * 0.95, r * 0.95, r * 0.95], r * 0.28, -r * 0.78),
      ];
    case "ponytail":
      return [
        cap([r * 2.26, r * 2.28, r * 2.26], 0),
        {
          geometry: geometry.capsule,
          placement: {
            position: [0, -r * 0.2, -r * 0.85],
            scale: [r * 0.42, r * 0.42, r * 0.42],
            rotation: [0.34, 0, 0],
          },
        },
      ];
    case "curly":
      return [
        cap([r * 2.3, r * 2.32, r * 2.3], 0),
        blob([r * 0.86, r * 0.86, r * 0.86], r * 0.5, -r * 0.24),
        blob([r * 0.76, r * 0.76, r * 0.76], r * 0.46, r * 0.3),
        blob([r * 0.82, r * 0.82, r * 0.82], r * 0.2, -r * 0.62),
      ];
    case "buzz":
      return [cap([r * 2.16, r * 2.2, r * 2.16], 0.01)];
    case "short":
    default:
      return [
        cap([r * 2.3, r * 2.3, r * 2.3], 0),
        blob([r * 1.7, r * 1.1, r * 0.9], -r * 0.2, -r * 0.6),
      ];
  }
}

export function createFigure(options: FigureOptions): Figure {
  const { palette, geometry, materials } = options;
  const root = new Group();
  const own = personMaterials(palette);
  const [skin, hairColor, shirt, sleeve, pants, shoes, face] = own as [
    Material,
    Material,
    Material,
    Material,
    Material,
    Material,
    Material,
  ];

  // Everything that swivels with the chair (chair + occupant) hangs off this.
  const swivel = new Group();
  root.add(swivel);

  // Chair: three merged meshes. Its materials belong to the room, so they are not
  // disposed with the figure.
  const chairParts = buildChair(geometry, materials);
  swivel.add(...chairParts);
  const seat = chairParts[0]!;
  const pick: Object3D[] = [...chairParts];

  // ── torso ────────────────────────────────────────────────────────────────
  const torso = new Group();
  torso.position.y = FIGURE.hipY;
  swivel.add(torso);

  const hip = sharedMesh(geometry, "figure:hip", pants, [
    {
      geometry: geometry.rounded.hip,
      placement: { position: [0, 0.04, 0] },
    },
  ]);
  if (hip !== null) {
    torso.add(hip);
    pick.push(hip);
  }

  const chest = sharedMesh(geometry, "figure:chest", shirt, [
    {
      geometry: geometry.rounded.chest,
      placement: { position: [0, 0.42, 0] },
    },
    // A collar block in the shirt's own colour reads as clothing at this scale.
    {
      geometry: geometry.cylinder,
      placement: { position: [0, 0.7, 0], scale: [0.34, 0.1, 0.34] },
    },
  ]);
  if (chest !== null) {
    torso.add(chest);
    pick.push(chest);
  }

  // ── head ─────────────────────────────────────────────────────────────────
  const head = new Group();
  head.position.y = FIGURE.headY - FIGURE.hipY;
  torso.add(head);

  const r = FIGURE.headRadius;
  const skull = sharedMesh(geometry, "figure:skull", skin, [
    {
      geometry: geometry.sphere,
      // A touch wider than tall and slightly narrower front-to-back: a cartoon
      // head, not a ball.
      placement: { position: [0, 0, 0], scale: [r * 2.02, r * 2.08, r * 1.96] },
    },
  ]);
  if (skull !== null) {
    head.add(skull);
    pick.push(skull);
  }

  const hair = sharedMesh(
    geometry,
    `figure:hair:${palette.hairStyle}`,
    hairColor,
    hairParts(geometry, palette.hairStyle),
  );
  if (hair !== null) {
    head.add(hair);
    pick.push(hair);
  }

  // Face: two dots and a brow each, all in one dark mesh.
  const faceMesh = sharedMesh(geometry, "figure:face", face, [
    {
      geometry: geometry.sphereLow,
      placement: {
        position: [-r * 0.36, -r * 0.04, r * 0.88],
        scale: [r * 0.3, r * 0.32, r * 0.16],
      },
    },
    {
      geometry: geometry.sphereLow,
      placement: {
        position: [r * 0.36, -r * 0.04, r * 0.88],
        scale: [r * 0.3, r * 0.32, r * 0.16],
      },
    },
    {
      geometry: geometry.rounded.eyeBrow,
      placement: {
        position: [-r * 0.38, r * 0.32, r * 0.84],
        rotation: [0, 0, -0.14],
      },
    },
    {
      geometry: geometry.rounded.eyeBrow,
      placement: {
        position: [r * 0.38, r * 0.32, r * 0.84],
        rotation: [0, 0, 0.14],
      },
    },
  ]);
  if (faceMesh !== null) head.add(faceMesh);

  // ── arms ─────────────────────────────────────────────────────────────────
  // A capsule sleeve with a skin hand at its end. The capsule's own length is 2
  // world units at scale 1 (length + both caps), so a 0.62 arm is scale 0.31.
  const arm = (side: -1 | 1): Group => {
    const group = new Group();
    group.position.set(side * 0.34, FIGURE.shoulderY - FIGURE.hipY, 0.02);
    group.rotation.x = -0.55;
    const limb = sharedMesh(geometry, "figure:arm", sleeve, [
      {
        geometry: geometry.capsule,
        placement: { position: [0, -0.31, 0], scale: [0.19, 0.31, 0.19] },
      },
    ]);
    if (limb !== null) group.add(limb);
    const hand = sharedMesh(geometry, "figure:hand", skin, [
      {
        geometry: geometry.sphereLow,
        placement: { position: [0, -0.64, 0.04], scale: [0.17, 0.18, 0.17] },
      },
    ]);
    if (hand !== null) group.add(hand);
    return group;
  };

  const armLeft = arm(-1);
  const armRight = arm(1);
  torso.add(armLeft, armRight);

  // ── legs ─────────────────────────────────────────────────────────────────
  // Thighs forward over the seat, shins down, shoes on the floor: the reference
  // figures are clearly sitting, and their feet anchor them to the room.
  // The leg is one continuous chain: hip → thigh (forward, slightly down) → knee →
  // shin (straight down) → ankle → shoe. Every joint *overlaps* its neighbour, so no
  // pose or camera angle can show a gap between the pieces (that was the "broken leg"
  // the boss spotted).
  const kneeY = FIGURE.seatTopY + 0.02;
  const kneeZ = 0.5;
  // Below the shoe's top surface: the shin ends *inside* the shoe, so the joint can
  // never show a gap.
  const ankleY = 0.13;
  const legs = sharedMesh(geometry, "figure:legs", pants, [
    ...[-0.21, 0.21].flatMap((x) => [
      // Thigh: a capsule lying along z, its back end buried in the hip block and its
      // front end at the knee.
      {
        geometry: geometry.capsule,
        placement: {
          position: [x, kneeY + 0.05, (kneeZ - 0.02) / 2],
          rotation: [Math.PI / 2, 0, 0],
          scale: [0.19, (kneeZ + 0.04) / 2, 0.19],
        },
      },
      // Shin: vertical, from just above the knee down to inside the shoe.
      {
        geometry: geometry.capsule,
        placement: {
          position: [x, (kneeY + 0.06 + ankleY) / 2, kneeZ],
          scale: [0.15, (kneeY + 0.06 - ankleY) / 2, 0.15],
        },
      },
    ]),
  ]);
  if (legs !== null) swivel.add(legs);

  const shoesMesh = sharedMesh(geometry, "figure:shoes", shoes, [
    {
      geometry: geometry.rounded.shoe,
      placement: { position: [-0.21, 0.13, kneeZ + 0.05] },
    },
    {
      geometry: geometry.rounded.shoe,
      placement: { position: [0.21, 0.13, kneeZ + 0.05] },
    },
  ]);
  if (shoesMesh !== null) swivel.add(shoesMesh);

  const leftHanded = options.leftHanded === true;

  // The desk mug is the object the "coffee" animation lifts (no second mug hidden
  // in the hand): it keeps its own parent and rest transform, and the pose moves
  // it toward the hand while the arm is up. `heldMug` is optional so a figure can
  // exist without one.
  let heldMug = options.heldMug ?? null;
  const drinkingArm = leftHanded ? armLeft : armRight;
  const handGrip = new Object3D();
  handGrip.position.set(0, FIGURE.handGripY, FIGURE.handGripZ);
  drinkingArm.add(handGrip);
  const handWorld = new Vector3();
  const mugLocal = new Vector3();

  const headAnchor = new Object3D();
  headAnchor.position.set(0, FIGURE.headAnchorY, 0);
  root.add(headAnchor);
  // The top of the head (not the bubble anchor, which sits above it): the hover
  // card aligns its *top edge* here, per the boss's annotation.
  const hoverAnchor = new Object3D();
  hoverAnchor.position.set(0, FIGURE.hoverAnchorY, 0);
  root.add(hoverAnchor);

  const parts: Parts = { swivel, torso, head, armLeft, armRight };
  const torsoBaseY = FIGURE.hipY;

  return {
    root,
    headAnchor,
    hoverAnchor,
    // Everything on the chair plus the body reads as "this person" when picked.
    pickTargets: pick.length > 0 ? pick : [seat],
    setHeldMug(mesh: Mesh): void {
      heldMug = mesh;
    },
    pose(input: FigurePose): void {
      const t = input.now / 1000;
      // Base pose: seated, leaning slightly toward the desk, hands on the keys.
      parts.swivel.rotation.y = 0;
      parts.torso.position.y =
        torsoBaseY + (input.animate ? Math.sin(t * 1.4) * 0.012 : 0);
      parts.torso.rotation.x = input.working ? 0.06 : 0.1;
      parts.head.rotation.set(0.04, 0, 0);
      parts.armLeft.rotation.set(-0.55, 0, 0.16);
      parts.armRight.rotation.set(-0.55, 0, -0.16);

      if (input.working) {
        // Working is a *static* seated pose: hands resting on the desk, no swinging
        // (the boss asked for it). Only the torso keeps a barely visible breathing
        // offset, which is applied above for everyone.
        parts.armLeft.rotation.set(-0.62, 0, 0.2);
        parts.armRight.rotation.set(-0.62, 0, -0.2);
      }

      const rest = input.rest;
      if (rest === null) {
        // No animation → no mug anywhere.
        if (heldMug !== null) heldMug.visible = false;
        return;
      }
      // Ease in and out of every rest animation, so it never snaps.
      const p = input.restProgress;
      const envelope = Math.sin(Math.PI * Math.min(1, Math.max(0, p)));

      if (heldMug !== null && rest !== "coffee") {
        heldMug.visible = false;
      }

      if (rest === "coffee") {
        const liftingArm = leftHanded ? parts.armLeft : parts.armRight;
        liftingArm.rotation.x = -0.55 - 1.15 * envelope;
        liftingArm.rotation.z =
          (leftHanded ? 0.16 : -0.16) + (leftHanded ? 0.22 : -0.22) * envelope;
        parts.head.rotation.x = 0.04 - 0.18 * envelope;

        // The mug appears **in the hand** — no travel from the desk: it is only
        // ever at the hand anchor, with a very short scale pop at each end so it
        // is not a hard cut. Nothing is left on the desk between animations.
        if (heldMug !== null && heldMug.parent !== null) {
          handGrip.getWorldPosition(handWorld);
          heldMug.parent.worldToLocal(handWorld);
          mugLocal.copy(handWorld);
          heldMug.position.copy(mugLocal);
          // A very short pop in and out (≈6% of the animation at each end): the mug
          // is already "in the hand" as the arm starts to lift, and gone as it
          // lands — nothing travels from the desk.
          const appear = Math.min(1, envelope / 0.06, (1 - envelope) / 0.06);
          const scale = Math.max(0.0001, Math.min(1, appear));
          heldMug.scale.set(0.16 * scale, 0.22 * scale, 0.16 * scale);
          heldMug.visible = envelope > 0.004;
        }
      } else if (rest === "swivel") {
        // One full turn, clockwise, eased at both ends. `pose()` resets the
        // rotation to 0 at the top of every frame, so the chair cannot keep a
        // residual angle when the animation ends.
        const turn = p <= 0 ? 0 : p >= 1 ? 1 : easeInOut(p);
        parts.swivel.rotation.y = -Math.PI * 2 * turn;
        parts.armLeft.rotation.x = -0.45;
        parts.armRight.rotation.x = -0.45;
      } else {
        // Health exercise: one hand on the hip, the other raised overhead, the waist
        // twists and the body leans toward the hip side. The hand on the hip is the
        // person's **drinking hand** (`leftHanded`), i.e. the same side as their mug
        // and their coffee animation — one consistent "dominant hand" per person.
        const hipArm = leftHanded ? parts.armLeft : parts.armRight;
        const raisedArm = leftHanded ? parts.armRight : parts.armLeft;
        const side = leftHanded ? 1 : -1;
        hipArm.rotation.set(-0.55 - 1.5 * envelope, 0, side * 0.55 * envelope);
        raisedArm.rotation.set(
          -0.55 - 2.35 * envelope,
          0,
          -side * 0.22 * envelope,
        );
        // Waist twist + lean toward the hip arm, and the head follows.
        parts.torso.rotation.y = side * 0.32 * envelope;
        parts.torso.rotation.z = side * 0.2 * envelope;
        parts.torso.rotation.x = 0.1 - 0.1 * envelope;
        parts.head.rotation.z = side * 0.12 * envelope;
        parts.head.rotation.x = 0.04 - 0.16 * envelope;
      }
    },
    dispose(): void {
      for (const material of own) material.dispose();
      // The merged part geometries belong to this figure; the shared set belongs to
      // the stage and must survive. The chair's seat is a shared rounded part, so
      // this is not a theoretical distinction — a blind traverse would dispose it
      // once per rebuilt figure.
      const shared = sharedGeometrySet(geometry);
      root.traverse((child) => {
        if (child instanceof Mesh && !shared.has(child.geometry)) {
          child.geometry.dispose();
        }
      });
    },
  };
}
