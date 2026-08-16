/**
 * The camera rig: first person, third person, and the 0.35 s blend between.
 *
 * This file is where "fluent and intuitive" is actually won or lost, so the
 * reasoning is worth writing down.
 *
 * **Nothing snaps.** Every quantity the player can perceive — arm length, FOV,
 * pivot height, look-ahead, collision push-in — is a critically damped spring
 * (`Damp1`/`Damp3`). Springs arrive without overshoot and behave identically at
 * 30 and 240 fps, which is why the camera feels the same on a phone and on a
 * 240 Hz monitor.
 *
 * **Aim is direct, the body is smoothed.** Mouse look writes the aim basis
 * with zero smoothing (any smoothing there reads as input lag and is instantly
 * disqualifying). The *rendered* orientation then trails the aim by ~35 ms,
 * which adds weight to fast turns without adding latency to slow ones. Reduced
 * motion turns the trail off entirely.
 *
 * **Third person leads, first person breathes.** In third person the arm leads
 * the direction of travel and lengthens with speed, so sprinting shows you more
 * of where you are going. In first person the camera bobs on the footstep
 * cadence and sways with breathing when idle.
 *
 * **The arm never clips.** The spring arm is sphere-marched against the terrain
 * height field: it pulls in immediately on contact (you must never see through
 * a hill) and eases back out over ~0.4 s (so cresting a ridge doesn't fire the
 * camera backwards).
 *
 * View toggling interpolates the arm length to 0 rather than cutting, which is
 * the single detail that makes a view switch read as AAA.
 */

import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { ViewMode } from '../api/Contracts';
import { Damp1, Damp3, DEG, TAU, clamp, saturate, shakeNoise, smoothstep, tangent } from './Motion';

/** Everything the rig needs from whatever it is attached to, per frame. */
export interface RigInput {
  /** Anchor position (feet on foot, seat on a vehicle), planet-local metres. */
  position: Vector3;
  /** Local up — radially outward, or the vehicle's up when riding. */
  up: Vector3;
  /** Unit tangent the player is aiming along. Written directly by look input. */
  aimForward: Vector3;
  /** Aim elevation, radians, + is up. */
  aimPitch: number;
  /** Roll of the whole view, radians — vehicles bank, the player does not. */
  roll: number;
  /** Planet-local velocity, m/s. */
  velocity: Vector3;
  /** Height of the eye above `position`. */
  eyeHeight: number;
  /** 0..1 sprint blend, drives FOV kick and arm extension. */
  sprint: number;
  /** 0..1 magnitude of movement intent — suppresses idle breathing sway. */
  moving: number;
  grounded: boolean;
  swimming: boolean;
  /** True while riding; the rig widens and drops bob. */
  riding: boolean;
  /** Reference speed for the dynamic FOV/arm, m/s. */
  refSpeed: number;
  /** Floating-origin offset: render position = planet-local − origin. */
  renderOrigin: Vector3;
}

export interface RigPrefs {
  fovDeg: number;
  headBob: boolean;
  reduceMotion: boolean;
}

const _f = new Vector3();
const _r = new Vector3();
const _u = new Vector3();
const _p = new Vector3();
const _q = new Vector3();
const _look = new Vector3();
const _tmp = new Vector3();
const _qa = new Quaternion();
const _bx = new Vector3();
const _by = new Vector3();
const _bz = new Vector3();
const _mat = new Matrix4();

export class CameraRig {
  readonly camera: PerspectiveCamera;

  mode: ViewMode = 'third';
  /** 0 = fully first person, 1 = fully third. Springs across a toggle. */
  private blend = new Damp1(1);
  /** 0 = over the shoulder, 1 = wide. Driven by wheel/pinch. */
  private zoomT = new Damp1(0.18);
  private zoomTarget = 0.18;

  private prefs: RigPrefs = { fovDeg: 68, headBob: true, reduceMotion: false };

  /** Smoothed pivot in planet-local metres. */
  private pivot = new Damp3();
  private pivotInit = false;
  /** Look-ahead offset, metres, in planet-local space. */
  private lead = new Damp3();
  private armLen = new Damp1(0);
  private armCollide = new Damp1(1);
  private fov = new Damp1(68);
  private shoulder = new Damp1(0);

  /** Rendered orientation, trailing the aim slightly. */
  private orient = new Quaternion();
  private orientInit = false;

  /** Footstep-synced bob. */
  private bobPhase = 0;
  private bobAmp = new Damp1(0);
  /** Landing dip: a spring the impact kicks, then relaxes. */
  private dip = new Damp1(0);
  private dipVel = 0;
  private pitchOffset = new Damp1(0);

  private shakeAmp = 0;
  private shakeT = 0;
  private shakeDur = 1;
  private seed = 0x51a7;

  private time = 0;

  constructor(fovDeg = 68) {
    this.camera = new PerspectiveCamera(fovDeg, 1, 0.06, 2.5e11);
    this.camera.matrixAutoUpdate = true;
    this.prefs.fovDeg = fovDeg;
    this.fov.set(fovDeg);
  }

  /**
   * Terrain clearance probe used by the arm's sphere-march: given a planet-local
   * point, return metres above the ground (negative = buried). The owner wires
   * this to its CollisionProvider.
   */
  probe: ((p: Vector3) => number) | null = null;

  setPrefs(p: Partial<RigPrefs>): void {
    Object.assign(this.prefs, p);
    if (p.fovDeg !== undefined) this.camera.fov = p.fovDeg;
  }

  setMode(m: ViewMode): void {
    this.mode = m;
  }

  toggle(): void {
    this.mode = this.mode === 'first' ? 'third' : 'first';
  }

  /** 0 = first person on screen right now, 1 = third. Mid-blend is fractional. */
  get viewBlend(): number {
    return this.blend.value;
  }

  /** Wheel/pinch: continuous over-the-shoulder → wide. */
  zoom(delta: number): void {
    this.zoomTarget = saturate(this.zoomTarget + delta);
    // Zooming all the way in past the shoulder drops you into first person —
    // one continuous gesture across the whole range, no mode button needed.
    if (this.zoomTarget <= 0.001 && this.mode === 'third') {
      this.mode = 'first';
      this.zoomTarget = 0.14;
    }
  }

  /** Decaying noise shake. Repeat calls accumulate rather than restart. */
  shake(amount: number, duration = 0.45): void {
    if (this.prefs.reduceMotion) amount *= 0.25;
    this.shakeAmp = Math.min(1.6, this.shakeAmp + amount);
    this.shakeDur = Math.max(this.shakeDur * (this.shakeT > 0 ? 1 : 0), duration);
    this.shakeT = this.shakeDur;
  }

  /** Landing dip — kick the spring in proportion to the impact speed. */
  impact(speedMs: number): void {
    const s = saturate(speedMs / 22);
    this.dipVel -= s * 6.2;
    this.pitchOffset.impulse(-s * 3.4);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Snap every spring to its target — used on spawn and after a teleport. */
  reset(): void {
    this.pivotInit = false;
    this.orientInit = false;
    this.armCollide.set(1);
    this.bobPhase = 0;
    this.shakeAmp = 0;
    this.shakeT = 0;
    this.dip.set(0);
    this.dipVel = 0;
  }

  update(dt: number, s: RigInput): void {
    this.time += dt;
    const rm = this.prefs.reduceMotion;

    /* ── view blend ─────────────────────────────────────────────────────
       Springing this with a 0.13 s time constant settles in ~0.35 s, which
       is the window where a view change reads as a move rather than a cut. */
    const wantThird = this.mode === 'third' ? 1 : 0;
    this.blend.step(wantThird, 0.13, dt);
    const b = this.blend.value;

    this.zoomT.step(this.zoomTarget, 0.16, dt);
    const z = this.zoomT.value;

    /* ── speed terms ──────────────────────────────────────────────────── */
    const up = _u.copy(s.up).normalize();
    tangent(s.velocity, up, _tmp, s.aimForward);
    const tanSpeed = s.velocity.clone().addScaledVector(up, -s.velocity.dot(up)).length();
    const speedRef = Math.max(tanSpeed, s.refSpeed);
    const fast = saturate(speedRef / (s.riding ? 34 : 9.5));

    /* ── pivot: shoulder height, with look-ahead ──────────────────────── */
    // The pivot rides slightly above the eye in third person so the character
    // sits low in frame and you can see the ground you are about to cross.
    const pivotH = s.eyeHeight * (1 - b) + b * (s.eyeHeight * 0.94 + 0.18 + z * 0.55);
    _p.copy(s.position).addScaledVector(up, pivotH);

    if (!this.pivotInit) {
      this.pivot.set(_p);
      this.lead.set(_q.set(0, 0, 0));
      this.pivotInit = true;
    }
    // First person must be rigid to the head; third person gets real follow lag.
    this.pivot.step(_p, 0.001 + b * 0.075, dt);

    // Look-ahead: the arm leads travel, and leads further when sprinting.
    _q.set(0, 0, 0);
    if (b > 0.01 && tanSpeed > 0.4 && !rm) {
      tangent(s.velocity, up, _f, s.aimForward);
      const leadM = Math.min(tanSpeed * 0.14, 1.5) * (0.45 + s.sprint * 0.75) * b;
      _q.copy(_f).multiplyScalar(leadM);
    }
    this.lead.step(_q, 0.34, dt);

    /* ── look direction ───────────────────────────────────────────────── */
    tangent(s.aimForward, up, _f);
    _r.crossVectors(_f, up).normalize();
    const pitch = clamp(s.aimPitch, -88 * DEG, 88 * DEG);
    _look.copy(_f).multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch)).normalize();

    /* ── arm length ───────────────────────────────────────────────────── */
    // Over-the-shoulder (1.9 m) → wide (7.4 m), plus a speed stretch so the
    // world opens up as you accelerate.
    const base = 1.9 + z * 5.5 + (s.riding ? 2.6 + z * 2.0 : 0);
    const wantArm = b * (base + fast * (s.riding ? 3.2 : 1.35));
    // Extending is leisurely; retracting (toggling to first person) is quicker,
    // so the blend into first person feels decisive rather than mushy.
    this.armLen.step(wantArm, wantArm > this.armLen.value ? 0.2 : 0.11, dt);

    const wantShoulder = b * (1 - smoothstep(0.2, 0.75, z)) * 0.58;
    this.shoulder.step(wantShoulder, 0.18, dt);

    /* ── collision: sphere-march the arm ──────────────────────────────── */
    const pivotWorld = this.pivot.value;
    _p.copy(pivotWorld).add(this.lead.value);
    // Desired camera sits behind the look direction and off the shoulder.
    const desiredArm = this.armLen.value;
    let frac = 1;
    if (desiredArm > 0.05 && this.probe) {
      const steps = 8;
      const radius = 0.34;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        _q.copy(_p)
          .addScaledVector(_look, -desiredArm * t)
          .addScaledVector(_r, this.shoulder.value * t)
          .addScaledVector(up, 0.05 * t);
        const clear = this.probe(_q);
        if (clear < radius) {
          // Back off to just before the offending sample.
          frac = Math.max(0, (i - 1) / steps - 0.04);
          break;
        }
      }
    }
    // Pull in now, push out later: the classic asymmetry. A snap outward is
    // far more noticeable (and nauseating) than a snap inward.
    if (frac < this.armCollide.value) this.armCollide.step(frac, 0.02, dt);
    else this.armCollide.step(frac, 0.42, dt);
    const arm = desiredArm * this.armCollide.value;

    /* ── bob, sway, dip ───────────────────────────────────────────────── */
    // Footstep cadence: stride grows with speed, so the bob frequency tracks
    // the animation's actual foot plants rather than drifting against them.
    const stride = clamp(0.78 + tanSpeed * 0.085, 0.78, 1.95);
    const cadence = s.grounded && !s.swimming ? tanSpeed / stride : 0;
    this.bobPhase = (this.bobPhase + cadence * Math.PI * dt) % TAU;

    const bobWanted =
      this.prefs.headBob && !rm && s.grounded && !s.swimming && !s.riding
        ? saturate(tanSpeed / 5.5) * (1 - b) * (1 + s.sprint * 0.45)
        : 0;
    this.bobAmp.step(bobWanted, 0.16, dt);
    const ba = this.bobAmp.value;

    // Vertical dips twice per cycle (once per foot plant); lateral once.
    const bobY = -0.031 * ba * (0.5 - 0.5 * Math.cos(this.bobPhase * 2));
    const bobX = 0.023 * ba * Math.sin(this.bobPhase);
    const bobRoll = 0.011 * ba * Math.sin(this.bobPhase);

    // Idle breathing: sub-degree, slow, and it is the difference between
    // "paused game" and "someone is standing here".
    const idle = (1 - saturate(s.moving)) * (1 - b) * (rm ? 0 : 1);
    const breathY = Math.sin(this.time * 0.95) * 0.0075 * idle;
    const breathYaw = Math.sin(this.time * 0.63 + 1.7) * 0.0032 * idle;
    const breathPitch = Math.sin(this.time * 0.81 + 0.4) * 0.0041 * idle;

    // Landing dip as a real (under-damped) spring so it rebounds once.
    this.dipVel += (-this.dip.value * 46 - this.dipVel * 8.4) * dt;
    this.dip.value += this.dipVel * dt;
    this.pitchOffset.step(0, 0.12, dt);

    /* ── shake ────────────────────────────────────────────────────────── */
    let shX = 0;
    let shY = 0;
    let shRoll = 0;
    if (this.shakeT > 0) {
      this.shakeT = Math.max(0, this.shakeT - dt);
      const k = this.shakeT / Math.max(1e-3, this.shakeDur);
      const a = this.shakeAmp * k * k;
      const t = this.time * 24;
      shX = shakeNoise(t, this.seed) * a * 0.16;
      shY = shakeNoise(t + 37.1, this.seed ^ 0x77) * a * 0.16;
      shRoll = shakeNoise(t * 0.7 + 91.7, this.seed ^ 0x1d) * a * 0.05;
      if (this.shakeT <= 0) this.shakeAmp = 0;
    }

    /* ── assemble position ────────────────────────────────────────────── */
    _p.copy(pivotWorld)
      .add(this.lead.value)
      .addScaledVector(_look, -arm)
      .addScaledVector(_r, this.shoulder.value * this.armCollide.value)
      .addScaledVector(up, this.dip.value + bobY + breathY)
      .addScaledVector(_r, bobX + shX)
      .addScaledVector(up, shY);

    // Underwater the camera sits a little further back and lower — a cheap
    // trick that reads as "you are in a different medium".
    if (s.swimming) _p.addScaledVector(up, -0.12).addScaledVector(_look, -0.18);

    this.camera.position.copy(_p).sub(s.renderOrigin);

    /* ── assemble orientation ─────────────────────────────────────────── */
    const totalPitch = pitch + this.pitchOffset.value * 0.06 + breathPitch;
    _look.copy(_f).multiplyScalar(Math.cos(totalPitch)).addScaledVector(up, Math.sin(totalPitch)).normalize();
    if (breathYaw !== 0) _look.applyAxisAngle(up, breathYaw).normalize();

    // Basis: -Z looks along `_look`, +Y is local up, rolled by bob + bank.
    _bz.copy(_look).negate();
    _bx.crossVectors(up, _bz).normalize();
    _by.crossVectors(_bz, _bx);
    const roll = s.roll + bobRoll + shRoll;
    if (roll !== 0) {
      _bx.applyAxisAngle(_bz, roll);
      _by.applyAxisAngle(_bz, roll);
    }
    _qa.setFromRotationMatrix(_mat.makeBasis(_bx, _by, _bz));

    if (!this.orientInit) {
      this.orient.copy(_qa);
      this.orientInit = true;
    } else {
      // ~35 ms of trail on foot, ~70 ms in third person. Enough to feel weight,
      // far below the ~80 ms where mouse look starts to feel disconnected.
      const rate = rm ? 1e4 : 34 - b * 16;
      this.orient.slerp(_qa, 1 - Math.exp(-rate * dt));
    }
    this.camera.quaternion.copy(this.orient);

    /* ── FOV ──────────────────────────────────────────────────────────── */
    // Sprint kick is deliberately small: 5° reads as exertion, 15° reads as a
    // bug. Speed adds a little more in third person and a lot in a vehicle.
    const kick = s.sprint * 5.0 + fast * (s.riding ? 13 : b * 4.0);
    const wantFov = this.prefs.fovDeg + (rm ? kick * 0.35 : kick) + (s.swimming ? -4 : 0);
    this.fov.step(wantFov, 0.28, dt);
    if (Math.abs(this.camera.fov - this.fov.value) > 0.004) {
      this.camera.fov = this.fov.value;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Unit tangent the camera is facing, for camera-relative movement. */
  facing(up: Vector3, out: Vector3): Vector3 {
    out.set(0, 0, -1).applyQuaternion(this.orient);
    return tangent(out, up, out);
  }
}
