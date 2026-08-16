/**
 * The free-flight camera used in the space-scale realms.
 *
 * Two things make a space camera feel good rather than nauseating:
 *   1. Speed that scales with how far you are from the nearest thing. Flying
 *      between planets at walking pace is unbearable; flying past a moon at
 *      interplanetary speed is unreadable. So the throttle is geometric and
 *      the base speed tracks the distance to whatever you're near.
 *   2. Momentum. Instantly-stopping cameras feel like a level editor. A little
 *      inertia, and a lot of angular damping, makes it feel like mass.
 */

import { Euler, MathUtils, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { Input } from '../core/Input';

const _q = new Quaternion();
const _v = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _m = new Matrix4();

export class FlyCamera {
  readonly camera: PerspectiveCamera;
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly orientation = new Quaternion();

  /** Base speed in units/s at throttle 0. */
  baseSpeed = 1;
  /** Geometric throttle, -6..+6. Each step is ×2.2. */
  throttle = 0;
  /** Multiplier applied on top; realms set this from local scale. */
  scaleHint = 1;

  /** 0 = arcade (velocity follows input), 1 = Newtonian (thrust only). */
  newtonian = 0;
  damping = 3.2;
  rollEnabled = true;

  /** Set by the realm to keep the camera out of a body. */
  minDistanceTo: { center: Vector3; radius: number } | null = null;

  private pitch = 0;
  private yaw = 0;
  private roll = 0;
  private angVel = new Vector3();
  private targetFov: number;
  private smoothSpeed = 0;

  constructor(fovDeg = 68, near = 0.1, far = 1e13) {
    this.camera = new PerspectiveCamera(fovDeg, 1, near, far);
    this.targetFov = fovDeg;
  }

  setAspect(a: number): void {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  lookAt(target: Vector3): void {
    // Matrix4.lookAt gives a camera-style basis: -Z points from eye to target.
    // Object3D.lookAt does NOT — for anything that is not a camera or a light
    // it builds the opposite orientation, so using it here aimed every realm's
    // camera 180 degrees away from its subject and rendered a black screen.
    _m.lookAt(this.position, target, this.camera.up);
    this.orientation.setFromRotationMatrix(_m);
  }

  /** Current speed in units/s including the throttle multiplier. */
  speed(): number {
    return this.baseSpeed * this.scaleHint * Math.pow(2.2, this.throttle);
  }

  update(dt: number, input: Input): void {
    /* ---- throttle ---- */
    if (input.wheel !== 0) this.throttle = MathUtils.clamp(this.throttle - input.wheel * 0.6, -6, 8);
    if (input.pinch !== 0) this.throttle = MathUtils.clamp(this.throttle + input.pinch * 2.5, -6, 8);
    if (input.isDown('boost')) this.throttle = Math.min(8, this.throttle + dt * 2.2);
    if (input.isDown('brake')) this.throttle = Math.max(-6, this.throttle - dt * 2.2);

    /* ---- rotation ---- */
    // Angular velocity rather than direct assignment, so the camera has a
    // little inertia in the turn — this is most of the "feels like a ship".
    const lookGain = 3.4;
    this.angVel.x += -input.look.y * lookGain;
    this.angVel.y += -input.look.x * lookGain;
    if (this.rollEnabled) {
      const rollIn = (input.isDown('rollRight') ? 1 : 0) - (input.isDown('rollLeft') ? 1 : 0);
      this.angVel.z += rollIn * dt * 3.0;
    }
    const angDamp = Math.pow(0.0008, dt);
    this.angVel.multiplyScalar(angDamp);

    this.pitch += this.angVel.x * dt;
    this.yaw += this.angVel.y * dt;
    this.roll += this.angVel.z * dt;

    // Build the rotation incrementally in local space so there is no gimbal
    // lock and no artificial "up" — you can loop over the top forever.
    _q.setFromEuler(new Euler(this.angVel.x * dt, this.angVel.y * dt, this.angVel.z * dt, 'YXZ'));
    this.orientation.multiply(_q);
    this.orientation.normalize();

    /* ---- translation ---- */
    _fwd.set(0, 0, -1).applyQuaternion(this.orientation);
    _right.set(1, 0, 0).applyQuaternion(this.orientation);
    _up.set(0, 1, 0).applyQuaternion(this.orientation);

    const s = this.speed();
    _v.set(0, 0, 0);
    _v.addScaledVector(_fwd, input.move.y);
    _v.addScaledVector(_right, input.move.x);
    const vert = (input.isDown('jump') || input.isDown('ascend') ? 1 : 0) - (input.isDown('crouch') || input.isDown('descend') ? 1 : 0);
    _v.addScaledVector(_up, vert);
    if (_v.lengthSq() > 1) _v.normalize();

    if (this.newtonian > 0.5) {
      this.velocity.addScaledVector(_v, s * dt * 2.2);
    } else {
      // Arcade: exponential approach to the commanded velocity. Feels direct
      // but never snaps, which is what makes long flights comfortable.
      const target = _v.multiplyScalar(s);
      const k = 1 - Math.pow(0.0015, dt * this.damping);
      this.velocity.lerp(target, k);
    }

    this.position.addScaledVector(this.velocity, dt);

    /* ---- keep out of solid bodies ---- */
    if (this.minDistanceTo) {
      const d = this.position.distanceTo(this.minDistanceTo.center);
      if (d < this.minDistanceTo.radius) {
        _v.subVectors(this.position, this.minDistanceTo.center).normalize();
        this.position.copy(this.minDistanceTo.center).addScaledVector(_v, this.minDistanceTo.radius);
        // Kill only the inward component so grazing the surface still slides.
        const inward = this.velocity.dot(_v);
        if (inward < 0) this.velocity.addScaledVector(_v, -inward);
      }
    }

    /* ---- speed-reactive FOV: the cheapest sensation of velocity there is ---- */
    const spd = this.velocity.length();
    this.smoothSpeed = MathUtils.lerp(this.smoothSpeed, spd / Math.max(1e-6, s), 1 - Math.pow(0.01, dt));
    this.camera.fov = MathUtils.lerp(this.camera.fov, this.targetFov + this.smoothSpeed * 9, 1 - Math.pow(0.02, dt));
    this.camera.updateProjectionMatrix();

    this.camera.position.copy(this.position);
    this.camera.quaternion.copy(this.orientation);
    this.camera.updateMatrixWorld();
  }

  setFov(deg: number): void {
    this.targetFov = deg;
  }

  forward(out = new Vector3()): Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.orientation);
  }
}
