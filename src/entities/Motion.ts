/**
 * Motion primitives shared by the player, the camera rig and every vehicle.
 *
 * Two ideas do most of the work here.
 *
 * 1. **Critically damped smoothing.** Every "follow" in this subsystem — camera
 *    arm, FOV, eye height, body heading — uses `smoothDamp`. A naive
 *    `lerp(a, b, 0.1)` is frame-rate dependent and either overshoots or lags
 *    depending on the monitor. Critically damped springs arrive as fast as
 *    possible without overshoot, are stable at any dt, and are the single
 *    biggest reason a third-person camera reads as "expensive" rather than
 *    "student project".
 *
 * 2. **Tangent frames on a sphere.** The player walks on a ball of radius up to
 *    10⁷ m. "Up" is `normalize(position)` and it rotates under your feet as you
 *    walk. Storing a yaw scalar against a fixed world axis breaks at the poles
 *    and accumulates roll along a great circle. Instead we carry a *tangent
 *    forward vector* and re-orthogonalise it against the live up every frame,
 *    which is exact parallel transport for free.
 */

import { Matrix4, Quaternion, Vector3 } from 'three';
import { hashFloat } from '../core/Rand';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
/** Earth surface gravity — the reference every tuning constant is written against. */
export const G_EARTH = 9.81;

/* ═══════════════════════════════════════════════════════════════════════════
   Scalar helpers
   ═══════════════════════════════════════════════════════════════════════════ */

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function saturate(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return b === a ? 0 : saturate((v - a) / (b - a));
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
}

export function smootherstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0 || 1e-9));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function moveToward(cur: number, target: number, maxDelta: number): number {
  const d = target - cur;
  if (Math.abs(d) <= maxDelta) return target;
  return cur + Math.sign(d) * maxDelta;
}

/**
 * Frame-rate independent exponential approach. `rate` is in units of 1/second:
 * the value covers 63% of the remaining gap every 1/rate seconds. Unlike
 * `lerp(a, b, k)` this behaves identically at 30 and 240 fps.
 */
export function approach(cur: number, target: number, rate: number, dt: number): number {
  return target + (cur - target) * Math.exp(-rate * dt);
}

/** Wrap to (-π, π]. */
export function wrapPi(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/**
 * Unity-style critically damped smoothing. `velRef` is a single-element array
 * used as an in/out parameter for the spring velocity.
 */
export function smoothDamp(
  cur: number,
  target: number,
  velRef: { v: number },
  smoothTime: number,
  dt: number,
  maxSpeed = Infinity
): number {
  smoothTime = Math.max(1e-4, smoothTime);
  const omega = 2 / smoothTime;
  const x = omega * dt;
  // Padé approximant of exp(-x): stable for any dt, no exp() call.
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const original = target;
  let change = cur - target;
  const maxChange = maxSpeed * smoothTime;
  change = clamp(change, -maxChange, maxChange);
  target = cur - change;
  const temp = (velRef.v + omega * change) * dt;
  velRef.v = (velRef.v - omega * temp) * exp;
  let out = target + (change + temp) * exp;
  // Kill the tiny overshoot the approximation can produce near arrival.
  if (original - cur > 0 === out > original) {
    out = original;
    velRef.v = (out - original) / dt;
  }
  return out;
}

/** A damped scalar with its own spring velocity. */
export class Damp1 {
  value: number;
  private vel = { v: 0 };

  constructor(v = 0) {
    this.value = v;
  }

  set(v: number): void {
    this.value = v;
    this.vel.v = 0;
  }

  step(target: number, smoothTime: number, dt: number, maxSpeed = Infinity): number {
    this.value = smoothDamp(this.value, target, this.vel, smoothTime, dt, maxSpeed);
    return this.value;
  }

  /** Kick the spring directly — used for landing dips and recoil. */
  impulse(v: number): void {
    this.vel.v += v;
  }

  get velocity(): number {
    return this.vel.v;
  }
}

/** A damped Vector3. Component-wise springs; that is what a camera arm wants. */
export class Damp3 {
  readonly value = new Vector3();
  private vx = { v: 0 };
  private vy = { v: 0 };
  private vz = { v: 0 };

  constructor(v?: Vector3) {
    if (v) this.value.copy(v);
  }

  set(v: Vector3): void {
    this.value.copy(v);
    this.vx.v = 0;
    this.vy.v = 0;
    this.vz.v = 0;
  }

  step(target: Vector3, smoothTime: number, dt: number, maxSpeed = Infinity): Vector3 {
    this.value.x = smoothDamp(this.value.x, target.x, this.vx, smoothTime, dt, maxSpeed);
    this.value.y = smoothDamp(this.value.y, target.y, this.vy, smoothTime, dt, maxSpeed);
    this.value.z = smoothDamp(this.value.z, target.z, this.vz, smoothTime, dt, maxSpeed);
    return this.value;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Spherical-world frames
   ═══════════════════════════════════════════════════════════════════════════ */

const _a = new Vector3();
const _b = new Vector3();
const _m = new Matrix4();

/**
 * Project `v` onto the plane with normal `up` and normalise it. If `v` is
 * (near) parallel to up — looking straight down at your boots — fall back to
 * `hint`, then to an arbitrary but stable perpendicular, so the frame never
 * collapses and the camera never spins wildly at the singularity.
 */
export function tangent(v: Vector3, up: Vector3, out: Vector3, hint?: Vector3): Vector3 {
  out.copy(v).addScaledVector(up, -v.dot(up));
  if (out.lengthSq() > 1e-12) return out.normalize();
  if (hint) {
    out.copy(hint).addScaledVector(up, -hint.dot(up));
    if (out.lengthSq() > 1e-12) return out.normalize();
  }
  // Any stable perpendicular: cross with the least-aligned cardinal axis.
  const ax = Math.abs(up.x);
  const ay = Math.abs(up.y);
  const az = Math.abs(up.z);
  _a.set(ax < ay && ax < az ? 1 : 0, ay <= ax && ay < az ? 1 : 0, az <= ax && az <= ay ? 1 : 0);
  return out.crossVectors(up, _a).normalize();
}

/**
 * Build an orientation whose +Y is `up` and whose -Z is `forward` (three.js
 * convention). `forward` is re-projected onto the tangent plane first, which is
 * what keeps roll from drifting as you walk a great circle.
 */
export function orientFromUpForward(up: Vector3, forward: Vector3, out: Quaternion): Quaternion {
  tangent(forward, up, _a);
  // right = forward × up, for a right-handed (X=right, Y=up, Z=back) basis.
  _b.crossVectors(_a, up).normalize();
  _m.makeBasis(_b, up, _a.clone().negate());
  return out.setFromRotationMatrix(_m);
}

/** Signed angle from `a` to `b` measured about `axis`, in (-π, π]. */
export function signedAngle(a: Vector3, b: Vector3, axis: Vector3): number {
  const c = _a.crossVectors(a, b);
  return Math.atan2(c.dot(axis), a.dot(b));
}

/**
 * Rotate the tangent vector `dir` toward `target` about `up`, by at most
 * `maxRad`. Both are assumed tangent to `up`.
 */
export function rotateTangentToward(dir: Vector3, target: Vector3, up: Vector3, maxRad: number): void {
  const ang = signedAngle(dir, target, up);
  const step = clamp(ang, -maxRad, maxRad);
  dir.applyAxisAngle(up, step);
  tangent(dir, up, dir);
}

/**
 * Surface normal at a point on the sphere, by central differences of the height
 * field on the tangent plane. `step` is in metres — small enough to catch a
 * boulder, large enough not to sample noise hash aliasing.
 */
export function surfaceNormal(
  position: Vector3,
  heightAt: (dir: Vector3) => number,
  radius: number,
  step: number,
  out: Vector3
): Vector3 {
  const up = _up1.copy(position).normalize();
  tangent(_ref.set(0, 1, 0), up, _t1, _ref2.set(1, 0, 0));
  _t2.crossVectors(up, _t1).normalize();

  const inv = 1 / Math.max(1e-6, position.length());
  // Offsetting on the tangent plane then renormalising is an exact great-circle
  // step to first order, which is all we need at metre scales on a 10⁶ m ball.
  const h = (tx: number, ty: number) => {
    _p.copy(up).addScaledVector(_t1, tx * inv).addScaledVector(_t2, ty * inv).normalize();
    return heightAt(_p);
  };

  const hx = h(step, 0) - h(-step, 0);
  const hy = h(0, step) - h(0, -step);
  // Gradient of radius over the tangent plane → normal = up - ∇h.
  out.copy(up).addScaledVector(_t1, -hx / (2 * step)).addScaledVector(_t2, -hy / (2 * step));
  return out.normalize();
}

const _up1 = new Vector3();
const _t1 = new Vector3();
const _t2 = new Vector3();
const _p = new Vector3();
const _ref = new Vector3();
const _ref2 = new Vector3();

/* ═══════════════════════════════════════════════════════════════════════════
   Noise for shake and idle sway
   ═══════════════════════════════════════════════════════════════════════════ */

/** Smooth 1D value noise in [-1,1]. Deterministic — no Math.random anywhere. */
export function vnoise1(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hashFloat(i, seed) * 2 - 1;
  const b = hashFloat(i + 1, seed) * 2 - 1;
  return a + (b - a) * u;
}

/** Two octaves — enough structure that shake reads as impact, not as jitter. */
export function shakeNoise(t: number, seed: number): number {
  return vnoise1(t, seed) * 0.72 + vnoise1(t * 2.37 + 11.3, seed ^ 0x9e37) * 0.28;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Fixed-step accumulator
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Vehicle physics is only stable at a fixed dt: springs, tyre slip and the
 * quaternion integrator all explode if the frame hitches. This runs the sim at
 * a constant rate and caps the catch-up so a 500 ms stall (shader compile,
 * terrain build) does not spiral into a 60-substep death loop.
 */
export class FixedStep {
  private acc = 0;
  /** 0..1 position between the last two sim states, for render interpolation. */
  alpha = 0;

  constructor(
    readonly dt = 1 / 120,
    readonly maxSteps = 8
  ) {}

  run(frameDt: number, fn: (h: number) => void): void {
    this.acc += Math.min(frameDt, this.dt * this.maxSteps);
    let n = 0;
    while (this.acc >= this.dt && n < this.maxSteps) {
      fn(this.dt);
      this.acc -= this.dt;
      n++;
    }
    if (n === this.maxSteps) this.acc = 0;
    this.alpha = this.acc / this.dt;
  }

  reset(): void {
    this.acc = 0;
    this.alpha = 0;
  }
}
