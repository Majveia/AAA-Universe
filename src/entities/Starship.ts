/**
 * The starship.
 *
 * One vehicle has to work at two scales that have nothing in common: a VTOL
 * landing on a hillside in a crosswind, and a burn between planets. Rather than
 * bolt two flight models together, this is a single rigid body whose *medium*
 * changes — air density falls off exponentially with altitude, and every
 * aerodynamic term is multiplied by it. High up, the drag, the weathervaning
 * and the wing lift all fade to zero on their own and what is left is thrust
 * and gravity, which is exactly right.
 *
 * Three deliberate pieces of assistance, because a simulator nobody can land is
 * not a game:
 *   • HOVER. Below sixty metres with the gear down, the belly jets cancel most
 *     of gravity. You descend by choosing to, not by fighting.
 *   • LEVELLING. With no roll input in atmosphere, the ship rolls its own
 *     horizon back level. Real fly-by-wire does this and nobody notices.
 *   • WEATHERVANING. In air, velocity is pulled toward the nose. It is why a
 *     turn *goes* somewhere instead of drifting sideways.
 *
 * Local axes, as everywhere else in `entities/`: **-Z is forward**, +Y is up.
 */

import { Group, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type {
  CollisionProvider,
  IStarship,
  SystemContext,
  VehicleKind,
} from '../api/Contracts';
import type { StarSystemSpec } from '../universe/Types';
import { Rng } from '../core/Rand';
import { buildShipMesh, type ShipParts } from './ShipMesh';
import { clamp, saturate, approach } from './Motion';

/** Height of the belly above the ground when standing on the gear. */
const GEAR_HEIGHT = 2.35;
/** Below this altitude the hover jets take over; above it, wings and thrust. */
const HOVER_BAND = 70;
/** Main engine acceleration at full throttle, m/s². Roughly 4 g. */
const MAIN_ACCEL = 42;

export class Starship implements IStarship {
  readonly root = new Group();
  readonly kind: VehicleKind = 'starship';
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  seatOffset = new Vector3(0, 0.55, -2.2);

  readonly orientation = new Quaternion();

  private collision: CollisionProvider | null = null;
  private parts: ShipParts;
  private driving = false;
  private angVel = new Vector3();
  private throttle = 0;
  private hoverOut = 0;
  private gear = 1;
  private landed = true;
  private health = 1;
  private time = 0;
  private lightsOn = true;

  /** Scale height of the atmosphere in metres, 0 for an airless world. */
  private airScale = 0;
  /** Altitude at which the air is effectively gone. */
  private airTop = 1;

  private warpCharge = 0;
  private warpTarget: StarSystemSpec | null = null;

  private autoLandDir: Vector3 | null = null;

  /** Smoothed chase-camera state, so the view lags the ship like a real rig. */
  private camPos = new Vector3();
  private camQuat = new Quaternion();
  private camInit = false;
  private camDistance = 1;

  constructor(seed = 3) {
    this.parts = buildShipMesh(new Rng(seed));
    this.root.add(this.parts.root);
    this.camDistance = this.parts.length * 1.55;
  }

  attach(collision: CollisionProvider): void {
    this.collision = collision;
  }

  /** The realm tells the ship what it is flying through. */
  setAtmosphere(thicknessM: number, present: boolean): void {
    this.airTop = present ? Math.max(1000, thicknessM) : 1;
    // An exponential atmosphere is ~gone after four scale heights.
    this.airScale = present ? this.airTop / 4 : 0;
  }

  setDriver(active: boolean): void {
    this.driving = active;
    this.parts.setLights(this.lightsOn);
  }

  speed(): number {
    return this.velocity.length();
  }

  integrity(): number {
    return this.health;
  }

  isLanded(): boolean {
    return this.landed;
  }

  /** 0 = on the ground, 1 = above the atmosphere. */
  altitudeFactor(): number {
    return saturate(this.altitude() / this.airTop);
  }

  altitude(): number {
    if (!this.collision) return 0;
    const r = this.position.length();
    const dir = _up.copy(this.position).normalize();
    return r - (this.collision.radius + this.collision.heightAt(dir));
  }

  placeAt(direction: Vector3, headingRad = 0): void {
    if (!this.collision) return;
    const d = _a.copy(direction).normalize();
    const h = this.collision.heightAt(d);
    this.position.copy(d).multiplyScalar(this.collision.radius + h + GEAR_HEIGHT);
    this.velocity.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.landed = true;
    this.gear = 1;
    this.throttle = 0;
    this.setLevel(d, headingRad);
    this.applyVisual(0);
  }

  /** Orient with +Y along `up` and the nose along a heading in the tangent plane. */
  private setLevel(up: Vector3, headingRad: number): void {
    const ref = Math.abs(up.y) > 0.94 ? _b.set(1, 0, 0) : _b.set(0, 1, 0);
    const fwd = _c.crossVectors(ref, up).normalize().applyQuaternion(_q1.setFromAxisAngle(up, headingRad));
    const right = _d.crossVectors(fwd, up).normalize();
    // Object basis: +X right, +Y up, +Z back (because -Z is forward).
    _m.makeBasis(right, up, _e.copy(fwd).multiplyScalar(-1));
    this.orientation.setFromRotationMatrix(_m);
  }

  /** Point the nose at a planet-local target, keeping the roll sensible. */
  faceToward(target: Vector3): void {
    _c.subVectors(target, this.position);
    if (_c.lengthSq() < 1e-6) return;
    _c.normalize();
    const up = _up.copy(this.position).normalize();
    _d.crossVectors(_c, up);
    if (_d.lengthSq() < 1e-8) _d.set(1, 0, 0);
    _d.normalize();
    _e.crossVectors(_d, _c).normalize();
    // Object basis: +X right, +Y up, +Z back.
    _m.makeBasis(_d, _e, _b.copy(_c).multiplyScalar(-1));
    this.orientation.setFromRotationMatrix(_m);
    this.camInit = false;
  }

  /** Drop straight into flight: used when arriving in the realm under way. */
  enterFlight(): void {
    this.landed = false;
    this.gear = 0;
    this.autoLandDir = null;
    this.warpCharge = 0;
    this.warpTarget = null;
    this.camInit = false;
    this.health = Math.max(this.health, 0.35);
    this.parts.setDamage(1 - this.health);
  }

  requestTakeoff(): void {
    if (!this.landed) return;
    this.landed = false;
    this.gear = 1;
    // A shove, so the ship visibly unsticks rather than creeping upward.
    const up = _up.copy(this.position).normalize();
    this.velocity.addScaledVector(up, 6);
  }

  requestLanding(direction: Vector3): void {
    this.autoLandDir = direction.clone().normalize();
  }

  warpTo(target: StarSystemSpec): void {
    // You cannot fold space inside a gravity well with air in it, which is a
    // convenient piece of physics because it also makes you fly somewhere.
    if (this.altitudeFactor() < 0.85) return;
    this.warpTarget = target;
  }

  isWarping(): boolean {
    return this.warpCharge > 0.999;
  }

  /** 0–1 spool-up, for the HUD and the realm's transition. */
  warpProgress(): number {
    return this.warpCharge;
  }

  warpDestination(): StarSystemSpec | null {
    return this.warpTarget;
  }

  cancelWarp(): void {
    this.warpTarget = null;
    this.warpCharge = 0;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Frame
     ═══════════════════════════════════════════════════════════════════════ */

  update(dt: number, ctx: SystemContext): void {
    if (!this.collision) return;
    this.time += dt;
    const input = ctx.input;
    const col = this.collision;

    const up = _up.copy(this.position).normalize();
    const r = Math.max(1, this.position.length());
    const groundR = col.radius + col.heightAt(up);
    const alt = r - groundR;

    // Inverse-square gravity, so a high orbit is genuinely cheaper to hold.
    const g = col.gravity * (col.radius / r) * (col.radius / r);
    // Exponential atmosphere. Everything aerodynamic scales by this one number.
    const rho = this.airScale > 0 ? Math.exp(-Math.max(0, alt) / this.airScale) : 0;

    /* ── controls ─────────────────────────────────────────────────────────── */
    let fwdCmd = 0;
    let vertCmd = 0;
    let rollCmd = 0;
    let boost = 0;
    let brake = 0;
    if (this.driving) {
      fwdCmd = clamp(input.move.y + (input.throttle - input.reverse), -1, 1);
      vertCmd = (input.isDown('jump') || input.isDown('ascend') ? 1 : 0) - (input.isDown('crouch') || input.isDown('descend') ? 1 : 0);
      rollCmd = (input.isDown('rollRight') ? 1 : 0) - (input.isDown('rollLeft') ? 1 : 0) + input.move.x * 0.75;
      boost = input.isDown('boost') ? 1 : 0;
      brake = input.isDown('brake') ? 1 : 0;
      if (input.pressed('lightToggle')) {
        this.lightsOn = !this.lightsOn;
        this.parts.setLights(this.lightsOn);
      }
    }

    /* ── attitude ─────────────────────────────────────────────────────────── */
    // Angular velocity rather than direct assignment: a ship has inertia in the
    // turn, and that inertia is most of what makes it feel like a ship.
    if (this.driving && !this.landed) {
      const authority = 2.6;
      this.angVel.x += -input.look.y * authority;
      this.angVel.y += -input.look.x * authority;
      this.angVel.z += rollCmd * dt * 2.4;
    }
    this.angVel.multiplyScalar(Math.pow(0.0025, dt));

    if (!this.landed) {
      _q1.set(this.angVel.x * dt * 0.5, this.angVel.y * dt * 0.5, this.angVel.z * dt * 0.5, 1).normalize();
      this.orientation.multiply(_q1).normalize();

      // Fly-by-wire: with no roll command, in air, roll the horizon back level.
      if (rho > 0.02 && Math.abs(rollCmd) < 0.05) {
        const right = _d.set(1, 0, 0).applyQuaternion(this.orientation);
        const err = right.dot(up);
        _q1.setFromAxisAngle(_c.set(0, 0, 1).applyQuaternion(this.orientation), err * Math.min(1, dt * 2.2 * rho));
        this.orientation.premultiply(_q1).normalize();
      }
    }

    const fwd = _f.set(0, 0, -1).applyQuaternion(this.orientation);
    const shipUp = _gv.set(0, 1, 0).applyQuaternion(this.orientation);

    /* ── forces ───────────────────────────────────────────────────────────── */
    const accel = _acc.set(0, 0, 0);

    // Main engines. The afterburner is worth having because it is the only
    // thing that makes leaving a big world feel like an effort.
    const wantThrottle = Math.max(0, fwdCmd) * (1 + boost * 1.6);
    this.throttle = approach(this.throttle, wantThrottle, 3.2, dt);
    accel.addScaledVector(fwd, this.throttle * MAIN_ACCEL);
    if (fwdCmd < 0) accel.addScaledVector(fwd, fwdCmd * MAIN_ACCEL * 0.35);

    // Hover jets: they hold the ship up near the ground so a landing is a
    // decision rather than a fight, and they fade out as you climb away.
    const nearGround = saturate(1 - alt / HOVER_BAND);
    const hoverAuth = nearGround * (this.gear > 0.5 ? 1 : 0.45);
    const hoverCmd = saturate(hoverAuth * (0.86 + vertCmd * 0.6));
    this.hoverOut = approach(this.hoverOut, this.landed ? 0 : hoverCmd, 4.5, dt);
    accel.addScaledVector(up, this.hoverOut * g * 1.25);
    // Manual vertical thrust, available at any altitude.
    accel.addScaledVector(up, vertCmd * g * 0.9 + (vertCmd > 0 ? vertCmd * 4 : 0));

    // Gravity.
    accel.addScaledVector(up, -g);

    // Wing lift: a real lifting surface, so flying fast in air holds you up and
    // a stall drops you. It is what makes atmospheric flight feel different.
    const speed = this.velocity.length();
    if (rho > 0.001 && speed > 1) {
      const aoa = clamp(fwd.dot(_h.copy(this.velocity).multiplyScalar(1 / speed)), -1, 1);
      const lift = rho * speed * speed * 2.4e-4 * Math.max(0, aoa);
      accel.addScaledVector(shipUp, Math.min(lift, g * 2.2));
    }

    this.velocity.addScaledVector(accel, dt);

    /* ── drag and weathervaning ───────────────────────────────────────────── */
    if (rho > 0.0005) {
      const k = rho * (0.0016 + brake * 0.02);
      const s2 = this.velocity.length();
      this.velocity.multiplyScalar(Math.max(0, 1 - k * s2 * dt - rho * 0.12 * dt));
      // Pull the velocity vector toward the nose. Without this a ship in air
      // slides sideways through turns and reads as a floating camera.
      const s3 = this.velocity.length();
      if (s3 > 0.5) {
        this.velocity.lerp(_h.copy(fwd).multiplyScalar(s3), 1 - Math.pow(0.06, dt * rho * 2.4));
      }
    } else if (brake > 0) {
      // Retro-thrust in vacuum: not free, but available.
      this.velocity.multiplyScalar(Math.max(0, 1 - 0.9 * dt));
    }

    if (!this.landed) this.position.addScaledVector(this.velocity, dt);

    /* ── autoland ─────────────────────────────────────────────────────────── */
    if (this.autoLandDir && !this.landed) {
      const target = _h.copy(this.autoLandDir).multiplyScalar(groundR + GEAR_HEIGHT + 30);
      const toward = _i.subVectors(target, this.position);
      const d = toward.length();
      if (d > 4) {
        this.velocity.lerp(toward.multiplyScalar(Math.min(40, d) / d), 1 - Math.pow(0.2, dt));
      } else {
        this.autoLandDir = null;
      }
      this.gear = 1;
    }

    /* ── ground contact ───────────────────────────────────────────────────── */
    const nowUp = _up.copy(this.position).normalize();
    const nowGround = col.radius + col.heightAt(nowUp);
    const nowAlt = this.position.length() - nowGround;

    if (this.landed) {
      // Stay parked, and stay parked *level* — the ground under a leg can move
      // when the terrain LOD refines.
      this.position.copy(nowUp).multiplyScalar(nowGround + GEAR_HEIGHT);
      this.velocity.set(0, 0, 0);
      const right = _d.set(1, 0, 0).applyQuaternion(this.orientation);
      const fwdFlat = _c.crossVectors(nowUp, right).normalize();
      _m.makeBasis(_d.crossVectors(fwdFlat, nowUp).normalize(), nowUp, _e.copy(fwdFlat).multiplyScalar(-1));
      _q2.setFromRotationMatrix(_m);
      this.orientation.slerp(_q2, Math.min(1, dt * 3));
      if (this.driving && (vertCmd > 0.5 || this.throttle > 0.2)) this.requestTakeoff();
    } else if (nowAlt < GEAR_HEIGHT) {
      const into = -this.velocity.dot(nowUp);
      this.position.copy(nowUp).multiplyScalar(nowGround + GEAR_HEIGHT);
      const lateral = _i.copy(this.velocity).addScaledVector(nowUp, this.velocity.dot(nowUp)).length();
      const levelish = _gv.set(0, 1, 0).applyQuaternion(this.orientation).dot(nowUp);

      if (this.gear > 0.5 && into < 9 && lateral < 14 && levelish > 0.72) {
        this.landed = true;
        this.velocity.set(0, 0, 0);
        this.autoLandDir = null;
        ctx.services.audio?.play('landing_gear');
      } else {
        // A bad arrival costs you. Pacific Drive taught everyone this lesson.
        this.velocity.addScaledVector(nowUp, into * 1.3);
        this.velocity.multiplyScalar(0.55);
        if (into > 6) {
          this.health = Math.max(0, this.health - (into - 6) * 0.02);
          this.parts.setDamage(1 - this.health);
          ctx.services.audio?.play('rockfall', { volume: saturate(into / 40) });
        }
      }
    }

    /* ── gear ─────────────────────────────────────────────────────────────── */
    // Legs come up once you are clearly leaving, and go down on approach.
    const wantGear = this.landed || nowAlt < 140 || !!this.autoLandDir ? 1 : 0;
    this.gear = approach(this.gear, wantGear, 0.8, dt);

    /* ── warp ─────────────────────────────────────────────────────────────── */
    if (this.warpTarget && this.altitudeFactor() > 0.8) {
      this.warpCharge = Math.min(1, this.warpCharge + dt * 0.42);
      // The drive pulls the ship forward as it spools: the jump *starts* before
      // it finishes, which is the only way a warp ever feels like acceleration.
      this.velocity.addScaledVector(fwd, this.warpCharge * this.warpCharge * 260 * dt);
    } else if (this.warpCharge > 0) {
      this.warpCharge = Math.max(0, this.warpCharge - dt * 1.4);
      if (this.warpCharge === 0) this.warpTarget = null;
    }

    this.applyVisual(dt);
  }

  private applyVisual(dt: number): void {
    this.root.position.copy(this.position);
    this.root.quaternion.copy(this.orientation);
    this.parts.setThrust(saturate(this.throttle * 0.75 + this.warpCharge * 0.9));
    this.parts.setHover(this.hoverOut);
    this.parts.setGear(this.gear);
    this.parts.setWarp(this.warpCharge);
    this.parts.update(this.time);
    void dt;
  }

  /**
   * Where the chase camera should be. The rig trails the ship and swings wide
   * with speed, and it is smoothed independently of the ship's own attitude so
   * a roll reads as the *world* rotating, not the camera.
   */
  cameraPose(dt: number, outPos: Vector3, outQuat: Quaternion, view: 'first' | 'third' = 'third'): void {
    const up = _gv.set(0, 1, 0).applyQuaternion(this.orientation);
    const fwd = _f.set(0, 0, -1).applyQuaternion(this.orientation);

    if (view === 'first') {
      outPos.copy(this.position).addScaledVector(up, 0.62).addScaledVector(fwd, 2.1);
      outQuat.copy(this.orientation);
      this.camInit = false;
      return;
    }

    const speedT = saturate(this.velocity.length() / 320);
    const back = this.camDistance * (1 + speedT * 0.55);
    const rise = this.camDistance * 0.30;
    _i.copy(this.position).addScaledVector(fwd, -back).addScaledVector(up, rise);

    if (!this.camInit) {
      this.camPos.copy(_i);
      this.camQuat.copy(this.orientation);
      this.camInit = true;
    } else {
      // Position lags more than orientation: that difference is the whole feel.
      this.camPos.lerp(_i, 1 - Math.pow(0.0006, dt));
      this.camQuat.slerp(this.orientation, 1 - Math.pow(0.00004, dt));
    }

    outPos.copy(this.camPos);
    // Always look at a point slightly ahead of the ship, so the nose sits low
    // in frame and you can see where you are going.
    _a.copy(this.position).addScaledVector(fwd, this.camDistance * 1.4).addScaledVector(up, this.camDistance * 0.08);
    _e.set(0, 1, 0).applyQuaternion(this.camQuat);
    _m.lookAt(outPos, _a, _e);
    outQuat.setFromRotationMatrix(_m);
  }

  /** Field-of-view kick with speed — the cheapest sensation of velocity. */
  fovBoost(): number {
    return MathUtils.clamp(this.velocity.length() / 90, 0, 1) * 12 + this.warpCharge * 22;
  }

  dispose(): void {
    this.parts.dispose();
  }
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _f = new Vector3();
const _gv = new Vector3();
const _h = new Vector3();
const _i = new Vector3();
const _up = new Vector3();
const _acc = new Vector3();
const _q1 = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();
