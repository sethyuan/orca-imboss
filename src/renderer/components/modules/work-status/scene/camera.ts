import { Box3, PerspectiveCamera, Vector3 } from "three";
import { CAMERA } from "./art";

/**
 * The camera rig: two poses and the move between them.
 *
 * "Bird's-eye" frames the whole grid of rooms; "focus" frames one room. Both are
 * the boss's 45° look-down, and the only difference between them is the target
 * and how much of the view the subject fills — which is what makes the move
 * between them read as a camera flight into the room rather than a jump cut.
 *
 * There is **no user zoom**: both distances are derived from the largest fit
 * (grid bounds / room width) and recomputed on resize or when the room count
 * changes. The wheel does nothing in this module.
 *
 * Fitting is done by projecting the subject's eight bounding-box corners and
 * scaling the distance until they just fit. That handles any aspect ratio, any
 * room count and any window size without hand-tuned numbers.
 */
export type RigMode = "bird" | "focus";

interface Pose {
  position: Vector3;
  target: Vector3;
}

const PITCH = (CAMERA.pitchDeg * Math.PI) / 180;
/** Unit vector from the subject toward the camera: 45° up, from the front (+z). */
const VIEW_DIR = new Vector3(0, Math.sin(PITCH), Math.cos(PITCH)).normalize();

const CORNER = new Vector3();

/** Distance at which `box` fills `fill` of the view (fill < 1 = closer). */
function fitDistance(
  camera: PerspectiveCamera,
  box: Box3,
  fill: number,
): number {
  const target = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  let distance = Math.max(size.length(), 1);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    camera.position.copy(target).addScaledVector(VIEW_DIR, distance);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    let extent = 0;
    for (let corner = 0; corner < 8; corner += 1) {
      CORNER.set(
        corner & 1 ? box.max.x : box.min.x,
        corner & 2 ? box.max.y : box.min.y,
        corner & 4 ? box.max.z : box.min.z,
      ).project(camera);
      extent = Math.max(extent, Math.abs(CORNER.x), Math.abs(CORNER.y));
    }
    if (!Number.isFinite(extent) || extent <= 0.0001) break;
    distance *= extent * fill;
  }
  return distance;
}

function poseFor(camera: PerspectiveCamera, box: Box3, fill: number): Pose {
  const target = box.getCenter(new Vector3());
  const distance = fitDistance(camera, box, fill);
  return {
    position: target.clone().addScaledVector(VIEW_DIR, distance),
    target,
  };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class CameraRig {
  readonly camera: PerspectiveCamera;

  mode: RigMode = "bird";

  private birdBox = new Box3(
    new Vector3(-8, 0, -6.5),
    new Vector3(8, 6.4, 6.5),
  );

  /** Focused room's box, kept so an orbit can re-frame it. */
  private focusBox: Box3 | null = null;
  /** Orbit offsets around the focused room (radians / degrees, see `orbit`). */
  private azimuth = 0;
  private pitchOffset = 0;

  private current: Pose = {
    position: new Vector3(0, 20, 20),
    target: new Vector3(0, 0, 0),
  };

  private from: Pose | null = null;
  private to: Pose | null = null;
  private startedAt = 0;
  private duration = 0;
  /** `prefers-reduced-motion`: flights are instant (see the design system). */
  private reducedMotion = false;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(CAMERA.fov, aspect, 0.5, 600);
    this.snapToBird();
  }

  setReducedMotion(reduce: boolean): void {
    this.reducedMotion = reduce;
    if (reduce && this.from !== null && this.to !== null) {
      this.current = { ...this.to };
      this.from = null;
      this.to = null;
      this.apply(this.current);
    }
  }

  setAspect(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // A resize changes the fit, so re-frame whatever is being shown.
    if (this.mode === "bird") this.snapToBird();
  }

  /** The grid changed (rooms added/removed/re-laid-out). */
  setBirdBox(box: Box3): void {
    this.birdBox = box;
    if (this.mode === "bird" && this.to === null) this.snapToBird();
  }

  /**
   * Frame one room: look at its middle and back off just far enough that the
   * screen (far wall) and the meeting table (near edge) both stay in shot.
   *
   * Deliberately not a bounding-box fit: the box includes the wall height, and
   * fitting all eight corners at a 45° pitch pulls the camera so far back that
   * the room reads as a floor plan instead of a room.
   */
  focusRoom(box: Box3, now: number): void {
    this.mode = "focus";
    // A freshly focused room always starts at the standard 45° view: an orbit is a
    // property of one visit, not of the room.
    this.focusBox = box.clone();
    this.azimuth = 0;
    this.pitchOffset = 0;
    this.transitionTo(this.focusPose(), CAMERA.transitionMs, now);
  }

  /**
   * Drag-to-look-around inside a focused room: azimuth orbits around the room,
   * pitch tilts the view. Both are clamped (`CAMERA.orbit*`) so the camera can
   * never drop under the floor, flip over the room, or swing behind the back wall.
   */
  orbit(azimuthDelta: number, pitchDelta: number): void {
    if (this.mode !== "focus" || this.focusBox === null) return;
    this.azimuth = Math.max(
      -CAMERA.orbitAzimuthLimit,
      Math.min(CAMERA.orbitAzimuthLimit, this.azimuth + azimuthDelta),
    );
    this.pitchOffset = Math.max(
      -CAMERA.orbitPitchRange,
      Math.min(CAMERA.orbitPitchRange, this.pitchOffset + pitchDelta),
    );
    // Direct manipulation: no transition, the room follows the pointer.
    this.from = null;
    this.to = null;
    this.current = this.focusPose();
    this.apply(this.current);
  }

  /** The focused room's pose with the current orbit applied. */
  private focusPose(): Pose {
    const box = this.focusBox ?? this.birdBox;
    const size = box.getSize(new Vector3());
    const target = box.getCenter(new Vector3());
    target.y = CAMERA.focusTargetY;
    const distance =
      Math.max(size.x, size.z * 0.9) * CAMERA.focusDistanceFactor;
    const pitch = Math.min(
      CAMERA.orbitPitchMax,
      Math.max(CAMERA.orbitPitchMin, Math.PI / 4 + this.pitchOffset),
    );
    const direction = new Vector3(
      Math.sin(this.azimuth) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(this.azimuth) * Math.cos(pitch),
    ).normalize();
    return {
      target,
      position: target.clone().addScaledVector(direction, distance),
    };
  }

  exitFocus(now: number): void {
    this.mode = "bird";
    this.focusBox = null;
    this.azimuth = 0;
    this.pitchOffset = 0;
    this.transitionTo(this.birdPose(), CAMERA.transitionMs, now);
  }

  /** Snap straight to the bird's-eye pose (first frame, resize, room change). */
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
      position: this.from.position.clone().lerp(this.to.position, eased),
      target: this.from.target.clone().lerp(this.to.target, eased),
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
    return poseFor(this.camera, this.birdBox, CAMERA.birdFill);
  }

  private transitionTo(pose: Pose, duration: number, now: number): void {
    if (this.reducedMotion) {
      this.current = {
        position: pose.position.clone(),
        target: pose.target.clone(),
      };
      this.from = null;
      this.to = null;
      this.apply(this.current);
      return;
    }
    this.from = {
      position: this.current.position.clone(),
      target: this.current.target.clone(),
    };
    this.to = pose;
    this.startedAt = now;
    this.duration = duration;
  }

  private apply(pose: Pose): void {
    this.camera.position.copy(pose.position);
    this.camera.lookAt(pose.target);
    this.camera.updateMatrixWorld();
  }
}
