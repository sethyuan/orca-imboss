import { Box3, OrthographicCamera, Vector3 } from "three";
import { CAMERA } from "./art";

/**
 * The camera rig: the isometric pose, two frames (the grid and one room) and the
 * move between them.
 *
 * The camera is **orthographic** and looks straight on (`CAMERA.azimuthDeg` is 0) with
 * a 30° pitch; the rooms are the ones that are turned, by `CAMERA.roomYawDeg`, so each
 * one still presents its front-right corner. Parallel edges stay parallel and a room
 * in the corner of the board looks exactly like a room in the middle — that is what
 * the reference art does, and it is what makes the two walls and the wall screen
 * read consistently no matter where a room sits in the grid.
 *
 * "Bird's-eye" frames the whole grid of rooms; "focus" frames one room. The only
 * difference between them is the target and how much of the view the subject
 * fills, which is what makes the move between them read as a camera flight into
 * the room rather than a jump cut.
 *
 * There is **no user zoom**: both frames are fitted to the subject (grid bounds /
 * room box) and recomputed on resize or when the room count changes. The wheel
 * does nothing in this module.
 */
export type RigMode = "bird" | "focus";

interface Pose {
  target: Vector3;
  /** Which way the camera sits from the target (a unit vector). */
  direction: Vector3;
  /** Visible world height of the frame (the frustum's top minus bottom). */
  height: number;
}

const DEG = Math.PI / 180;
const AZIMUTH = CAMERA.azimuthDeg * DEG;
const PITCH = CAMERA.pitchDeg * DEG;

/** Which way the camera looks at the subject (a unit vector). */
const VIEW_DIR = new Vector3(
  Math.sin(AZIMUTH) * Math.cos(PITCH),
  Math.sin(PITCH),
  Math.cos(AZIMUTH) * Math.cos(PITCH),
).normalize();

/** The camera's screen-right and screen-up axes for a given direction. */
function basisOf(direction: Vector3): { right: Vector3; up: Vector3 } {
  const right = new Vector3(direction.z, 0, -direction.x).normalize();
  const up = new Vector3().crossVectors(direction, right).normalize();
  return { right, up };
}

const CORNER = new Vector3();
const OFFSET = new Vector3();

/**
 * The visible height that makes `box` fill `fill` of the frame.
 *
 * Exact for an orthographic camera: project the eight corners onto the camera's
 * own axes and take the largest extents — no iteration, and it handles any aspect
 * ratio, any room count and any window size.
 */
function fitHeight(
  box: Box3,
  aspect: number,
  direction: Vector3,
  fill: number,
  target: Vector3,
): number {
  const { right, up } = basisOf(direction);
  let halfWidth = 0;
  let halfHeight = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    CORNER.set(
      corner & 1 ? box.max.x : box.min.x,
      corner & 2 ? box.max.y : box.min.y,
      corner & 4 ? box.max.z : box.min.z,
    );
    // Measured around the point the camera *looks at*, not around the box's own
    // centre: the focus target sits above the middle so the screen and the table
    // both stay in frame, and an off-centre target would otherwise crop the wall.
    OFFSET.subVectors(CORNER, target);
    halfWidth = Math.max(halfWidth, Math.abs(OFFSET.dot(right)));
    halfHeight = Math.max(halfHeight, Math.abs(OFFSET.dot(up)));
  }
  return (
    Math.max(halfHeight * 2, (halfWidth * 2) / Math.max(0.1, aspect)) * fill
  );
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class CameraRig {
  readonly camera: OrthographicCamera;

  mode: RigMode = "bird";

  private aspect: number;

  /** A stand-in for the board's bounds until the first snapshot arrives. */
  private birdBox = new Box3(
    new Vector3(-8, -0.4, -6.5),
    new Vector3(8, 6.1, 6.5),
  );

  /** Focused room's box, kept so a re-anchor can re-frame it. */
  private focusBox: Box3 | null = null;

  private current: Pose = {
    target: new Vector3(0, 0, 0),
    direction: VIEW_DIR.clone(),
    height: 40,
  };

  private from: Pose | null = null;
  private to: Pose | null = null;
  private startedAt = 0;
  private duration = 0;
  /** `prefers-reduced-motion`: flights are instant (see the design system). */
  private reducedMotion = false;

  constructor(aspect: number) {
    this.aspect = Math.max(0.1, aspect);
    this.camera = new OrthographicCamera(
      -10,
      10,
      10,
      -10,
      CAMERA.near,
      CAMERA.far,
    );
    this.snapToBird();
  }

  setReducedMotion(reduce: boolean): void {
    this.reducedMotion = reduce;
    if (reduce && this.from !== null && this.to !== null) {
      this.current = {
        target: this.to.target.clone(),
        direction: this.to.direction.clone(),
        height: this.to.height,
      };
      this.from = null;
      this.to = null;
      this.apply(this.current);
    }
  }

  setAspect(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    this.aspect = aspect;
    this.apply(this.current);
    // A resize changes the fit, so re-frame whatever is being shown.
    if (this.mode === "bird") this.snapToBird();
    else if (this.focusBox !== null) this.apply(this.focusPose());
  }

  /** The grid changed (rooms added/removed/re-laid-out). */
  setBirdBox(box: Box3): void {
    this.birdBox = box;
    if (this.mode === "bird" && this.to === null) this.snapToBird();
  }

  /**
   * Frame one room: look at its middle and fit its box, with `CAMERA.focusFill`
   * worth of breathing room. The wall top may sit just outside the frame — fitting
   * the whole cuboid would pull back until the wall screen shrinks below reading
   * size (see `CAMERA.focusFill`).
   */
  focusRoom(box: Box3, now: number): void {
    this.mode = "focus";
    this.focusBox = box.clone();
    this.transitionTo(this.focusPose(), CAMERA.transitionMs, now);
  }

  /**
   * Re-anchor the focused frame to a room that **moved on the board** (the grid is
   * re-laid out whenever a room appears or disappears, which shifts every position).
   *
   * Applied instantly and without a transition, so the room's place on screen does not
   * change at all: the camera target moves with the room, and the fit only depends on the
   * room's own box — a focused room must never be affected by what else is on the board.
   */
  refocus(box: Box3): void {
    if (this.mode !== "focus") return;
    if (this.focusBox !== null && this.focusBox.equals(box)) return;
    this.focusBox = box.clone();
    this.current = this.focusPose();
    this.from = null;
    this.to = null;
    this.apply(this.current);
  }

  /**
   * The focused room's frame. A property of the room alone: the pose never depends on
   * the board's grid, so a new room appearing cannot move the focused picture.
   *
   * There is no camera orbit while focused — dragging turns the *room* (see the stage)
   * — so the direction is always the isometric one.
   */
  private focusPose(): Pose {
    const box = this.focusBox ?? this.birdBox;
    const target = box.getCenter(new Vector3());
    target.y += CAMERA.focusTargetOffsetY;
    return {
      target,
      direction: VIEW_DIR.clone(),
      height: fitHeight(box, this.aspect, VIEW_DIR, CAMERA.focusFill, target),
    };
  }

  exitFocus(now: number): void {
    this.mode = "bird";
    this.focusBox = null;
    this.transitionTo(this.birdPose(), CAMERA.transitionMs, now);
  }

  /** Snap straight to the bird's-eye frame (first frame, resize, room change). */
  snapToBird(): void {
    this.mode = "bird";
    this.from = null;
    this.to = null;
    this.current = this.birdPose();
    this.apply(this.current);
  }

  /** Advance the flight; returns `true` while the camera is still moving. */
  update(now: number): boolean {
    if (this.to === null || this.from === null) return false;
    const span = Math.max(1, this.duration);
    const t = Math.min(1, Math.max(0, (now - this.startedAt) / span));
    const eased = easeInOut(t);
    this.current = {
      target: this.from.target.clone().lerp(this.to.target, eased),
      direction: this.from.direction
        .clone()
        .lerp(this.to.direction, eased)
        .normalize(),
      // Interpolating the height in log space keeps the flight's *relative* zoom
      // even: a linear lerp from a 100-unit grid frame to a 20-unit room frame
      // spends most of the animation already zoomed in.
      height: Math.exp(
        Math.log(this.from.height) +
          (Math.log(this.to.height) - Math.log(this.from.height)) * eased,
      ),
    };
    this.apply(this.current);
    if (t >= 1) {
      this.from = null;
      this.to = null;
      return false;
    }
    return true;
  }

  /** True while a flight is in progress (input that moves the camera waits). */
  get moving(): boolean {
    return this.to !== null;
  }

  private birdPose(): Pose {
    const target = this.birdBox.getCenter(new Vector3());
    target.y = 0;
    return {
      target,
      direction: VIEW_DIR.clone(),
      height: fitHeight(
        this.birdBox,
        this.aspect,
        VIEW_DIR,
        CAMERA.birdFill,
        target,
      ),
    };
  }

  private transitionTo(pose: Pose, duration: number, now: number): void {
    if (this.reducedMotion) {
      this.current = {
        target: pose.target.clone(),
        direction: pose.direction.clone(),
        height: pose.height,
      };
      this.from = null;
      this.to = null;
      this.apply(this.current);
      return;
    }
    this.from = {
      target: this.current.target.clone(),
      direction: this.current.direction.clone(),
      height: this.current.height,
    };
    this.to = pose;
    this.startedAt = now;
    this.duration = duration;
  }

  private apply(pose: Pose): void {
    const camera = this.camera;
    const halfHeight = pose.height / 2;
    const halfWidth = halfHeight * this.aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    camera.position
      .copy(pose.target)
      .addScaledVector(pose.direction, CAMERA.distance);
    camera.lookAt(pose.target);
    camera.updateMatrixWorld();
  }
}
