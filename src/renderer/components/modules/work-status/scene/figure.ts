import { Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from "three";
import type { RestKind } from "../state-machine";
import type { PersonPalette, SharedGeometry } from "./art";

/**
 * Procedural low-poly people, and every pose they can hold.
 *
 * A figure is a small rig of groups rather than a skinned mesh: procedural rigs
 * need no asset pipeline, cost nothing to build, and pose by rotating a handful
 * of nodes — which is all the rest animations (coffee, swivel, exercise) need.
 *
 * Poses are **absolute**: every frame starts from the rest pose and applies the
 * current state, so switching between animations can never accumulate drift.
 */

/**
 * Where a bubble is anchored: clearly above the head, not on it. An anchor at
 * head height let a two-line bubble cover the sender's head and shoulders.
 */
const HEAD_Y = 2.34;

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
  /**
   * `coffee` needs a mug in hand: the assistant and every employee
   * get one, so the animation never has to invent a prop mid-scene.
   */
  mugColor: number;
  /**
   * Left-handed people lift the other mug (see the room's `mugSide`): a second,
   * cheap way to tell two seated employees apart.
   */
  leftHanded?: boolean;
  /**
   * The chair this person sits on. The fabric carries the room's accent tint (see
   * `roomPaletteFor`), so a room's chairs are recognisably "that room's" while the
   * person's own wardrobe stays the loudest thing on screen.
   */
  chair?: { frame: number; fabric: number; metal: number };
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

function makeMesh(
  geometry: SharedGeometry,
  kind: keyof SharedGeometry,
  color: number,
  scale: [number, number, number],
  position?: [number, number, number],
): Mesh {
  // Cloth and skin are matte, nothing reflects: the figures must read as people,
  // not as painted blocks.
  const mesh = new Mesh(
    geometry[kind],
    new MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 }),
  );
  mesh.scale.set(...scale);
  if (position) mesh.position.set(...position);
  return mesh;
}

/**
 * A high-back ergonomic chair: five-star base with casters, gas lift, cushioned
 * seat, tall curved back with a lumbar pad, and two armrests.
 *
 * Returned as a list so the caller can parent all of it to the swivel node; the
 * first element is the seat cushion (the figure's own grounding reference).
 */
function buildChair(
  geometry: SharedGeometry,
  colors: { frame: number; fabric: number; metal: number },
): Mesh[] {
  // Cushioned seat first: the caller uses it as the figure's grounding reference
  // (raycast target and the "is this person" hit box).
  const seat = makeMesh(
    geometry,
    "slab",
    colors.fabric,
    [0.88, 1, 0.84],
    [0, 0.5, 0],
  );
  const parts: Mesh[] = [seat];

  // Five-star base: five arms around a hub, each with a caster underneath.
  parts.push(
    makeMesh(geometry, "cylinder", colors.metal, [0.5, 0.1, 0.5], [0, 0.12, 0]),
  );
  for (let index = 0; index < 5; index += 1) {
    const angle = (index / 5) * Math.PI * 2;
    const arm = makeMesh(
      geometry,
      "slab",
      colors.frame,
      [0.16, 1, 0.72],
      [Math.sin(angle) * 0.22, 0.1, Math.cos(angle) * 0.22],
    );
    arm.rotation.y = angle;
    parts.push(
      arm,
      makeMesh(
        geometry,
        "sphere",
        colors.metal,
        [0.16, 0.16, 0.16],
        [Math.sin(angle) * 0.44, 0.06, Math.cos(angle) * 0.44],
      ),
    );
  }

  // Gas lift.
  parts.push(
    makeMesh(
      geometry,
      "cylinder",
      colors.metal,
      [0.14, 0.5, 0.14],
      [0, 0.36, 0],
    ),
  );

  // Tall back panel + lumbar pad.
  //
  // The back is a **vertical** panel: thin in z, tall in y. `slab` is thin in y
  // (that is a seat or a table top), so using it here made the backrest a plate
  // lying flat behind the person — the bug the boss reported twice.
  const back = makeMesh(
    geometry,
    "box",
    colors.fabric,
    [0.84, 1.08, 0.12],
    [0, 1.02, -0.44],
  );
  back.rotation.x = -0.12;
  // The lumbar pad sits on the *front* face of the back (the side the occupant is
  // on), a little lower than the shoulder area.
  const lumbar = makeMesh(
    geometry,
    "box",
    colors.frame,
    [0.6, 0.32, 0.1],
    [0, 0.82, -0.31],
  );
  lumbar.rotation.x = -0.16;
  parts.push(back, lumbar);

  // Armrests: a post each side plus a pad on top.
  for (const side of [-1, 1]) {
    parts.push(
      makeMesh(
        geometry,
        "cylinder",
        colors.frame,
        [0.08, 0.28, 0.08],
        [side * 0.46, 0.64, -0.06],
      ),
      makeMesh(
        geometry,
        "slab",
        colors.frame,
        [0.16, 1, 0.52],
        [side * 0.46, 0.79, -0.02],
      ),
    );
  }

  return parts;
}

export function createFigure(options: FigureOptions): Figure {
  const { palette, geometry } = options;
  const root = new Group();

  // Everything that swivels with the chair (chair + occupant) hangs off this.
  const swivel = new Group();
  root.add(swivel);

  // A neutral dark chair reads as "office chair" in every palette, so it is not
  // part of the per-person wardrobe. It is built here (rather than as a room prop)
  // because the "swivel" animation turns chair *and* occupant together.
  const chairParts = buildChair(
    geometry,
    options.chair ?? { frame: 0x4a545f, fabric: 0x39424c, metal: 0x8b939c },
  );
  swivel.add(...chairParts);
  const seat = chairParts[0]!;

  const torso = new Group();
  torso.position.y = 0.55;
  swivel.add(torso);

  const body = makeMesh(
    geometry,
    "box",
    palette.shirt,
    [0.62, 0.86, 0.42],
    [0, 0.62, 0],
  );
  // Shoulders: a slightly wider, darker block gives the figure a silhouette
  // that reads at bird's-eye distance without any texture.
  const shoulders = makeMesh(
    geometry,
    "box",
    palette.shirtDark,
    [0.74, 0.2, 0.46],
    [0, 0.98, 0],
  );
  torso.add(body, shoulders);

  const head = new Group();
  head.position.y = 1.16;
  const skull = makeMesh(geometry, "sphere", palette.skin, [0.46, 0.5, 0.46]);
  const hair = makeMesh(
    geometry,
    "sphere",
    palette.hair,
    [0.49, 0.44, 0.49],
    [0, 0.09, -0.02],
  );
  head.add(skull, hair);
  torso.add(head);

  const armLeft = new Group();
  armLeft.position.set(-0.32, 0.92, 0.02);
  armLeft.rotation.x = -0.55;
  armLeft.add(
    makeMesh(
      geometry,
      "cylinder",
      palette.shirtDark,
      [0.17, 0.56, 0.17],
      [0, -0.24, 0],
    ),
  );

  const armRight = new Group();
  armRight.position.set(0.32, 0.92, 0.02);
  armRight.rotation.x = -0.55;
  armRight.add(
    makeMesh(
      geometry,
      "cylinder",
      palette.shirtDark,
      [0.17, 0.56, 0.17],
      [0, -0.24, 0],
    ),
  );

  const leftHanded = options.leftHanded === true;
  torso.add(armLeft, armRight);

  // The desk mug is the object the "coffee" animation lifts (no second mug hidden
  // in the hand): it keeps its own parent and rest transform, and the pose moves
  // it toward the hand while the arm is up. `heldMug` is optional so a figure can
  // exist without one.
  let heldMug = options.heldMug ?? null;
  const hand = leftHanded ? armLeft : armRight;
  const handGrip = new Object3D();
  handGrip.position.set(0, -0.58, 0.1);
  hand.add(handGrip);
  const handWorld = new Vector3();
  const mugLocal = new Vector3();

  const headAnchor = new Object3D();
  headAnchor.position.set(0, HEAD_Y, 0);
  root.add(headAnchor);
  // The top of the head (not the bubble anchor, which sits above it): the hover
  // card aligns its *top edge* here, per the boss's annotation.
  const hoverAnchor = new Object3D();
  hoverAnchor.position.set(0, 2.02, 0);
  root.add(hoverAnchor);

  const parts: Parts = { swivel, torso, head, armLeft, armRight };

  return {
    root,
    headAnchor,
    hoverAnchor,
    // Everything on the chair plus the body reads as "this person" when picked.
    pickTargets: [seat, ...chairParts, body, shoulders, skull, hair],
    setHeldMug(mesh: Mesh): void {
      heldMug = mesh;
    },
    pose(input: FigurePose): void {
      const t = input.now / 1000;
      // Base pose: seated, leaning slightly toward the desk, hands on the keys.
      parts.swivel.rotation.y = 0;
      parts.torso.position.y = 0.55 + Math.sin(t * 1.4) * 0.012;
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
        const arm = leftHanded ? parts.armLeft : parts.armRight;
        arm.rotation.x = -0.55 - 1.15 * envelope;
        arm.rotation.z =
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
      root.traverse((child) => {
        if (
          child instanceof Mesh &&
          child.material instanceof MeshStandardMaterial
        ) {
          child.material.dispose();
        }
      });
    },
  };
}
