/**
 * The rover.
 *
 * Four raycast wheels, a spring-damper each, and a rigid body integrated by
 * hand — the classic arcade-sim setup, which is the right one here because the
 * ground is an analytic height field rather than a collision mesh, so a "ray
 * cast" is just one call to heightAt.
 *
 * The details that make it feel like a vehicle rather than a sliding box:
 * weight transfer (braking loads the front springs, which visibly pitches the
 * body), separate longitudinal and lateral tyre friction so it can be made to
 * slide, and a handbrake that kills rear grip on purpose.
 */

import { Group, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { CollisionProvider, IVehicle, SystemContext, VehicleKind } from '../api/Contracts';
import { Rng } from '../core/Rand';
import { buildRoverMesh, type RoverParts } from './RoverMesh';
import { clamp, saturate } from './Motion';

interface Wheel {
  /** Attachment point in body space. */
  local: Vector3;
  steer: boolean;
  drive: boolean;
  /** Current suspension compression, 0 = extended. */
  compression: number;
  lastCompression: number;
  grounded: boolean;
  spin: number;
  /** World-space contact normal. */
  normal: Vector3;
}

const REST = 0.42;
const TRAVEL = 0.34;
const STIFF = 46000;
const DAMP = 4200;

export class Rover implements IVehicle {
  readonly root = new Group();
  readonly kind: VehicleKind = 'rover';
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  seatOffset = new Vector3(0, 1.15, 0.1);

  private collision: CollisionProvider | null = null;
  private orientation = new Quaternion();
  private angular = new Vector3();
  private wheels: Wheel[] = [];
  private parts: RoverParts;
  private mass = 1400;
  private driving = false;
  private steerAngle = 0;
  private throttle = 0;
  private brake = 0;
  private health = 1;
  private accum = 0;

  constructor(seed = 7) {
    const rng = new Rng(seed);
    this.parts = buildRoverMesh(rng);
    this.root.add(this.parts.root);

    const hx = 0.92;
    const hz = 1.42;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      this.wheels.push({
        local: new Vector3(i % 2 === 0 ? -hx : hx, 0, front ? hz : -hz),
        steer: front,
        drive: true,
        compression: 0,
        lastCompression: 0,
        grounded: false,
        spin: 0,
        normal: new Vector3(0, 1, 0),
      });
    }
  }

  attach(collision: CollisionProvider): void {
    this.collision = collision;
  }

  setDriver(active: boolean): void {
    this.driving = active;
  }

  speed(): number {
    return this.velocity.length();
  }

  integrity(): number {
    return this.health;
  }

  placeAt(direction: Vector3, headingRad = 0): void {
    if (!this.collision) return;
    const d = _a.copy(direction).normalize();
    const h = this.collision.heightAt(d);
    this.position.copy(d).multiplyScalar(this.collision.radius + h + REST + 0.4);
    this.velocity.set(0, 0, 0);
    this.angular.set(0, 0, 0);

    const up = d;
    const ref = Math.abs(up.y) > 0.94 ? _b.set(1, 0, 0) : _b.set(0, 1, 0);
    const fwd = _c.crossVectors(ref, up).normalize().applyQuaternion(_q.setFromAxisAngle(up, headingRad));
    const right = _d.crossVectors(fwd, up).normalize();
    _m.makeBasis(right, up, _e.copy(fwd).multiplyScalar(-1));
    this.orientation.setFromRotationMatrix(_m);
  }

  update(dt: number, ctx: SystemContext): void {
    if (!this.collision) return;
    // Fixed substeps: suspension springs are stiff, and a variable step makes
    // stiff springs explode.
    this.accum = Math.min(this.accum + dt, 0.1);
    const h = 1 / 120;
    while (this.accum >= h) {
      this.step(h, ctx);
      this.accum -= h;
    }
    this.applyVisual(dt);
  }

  private step(dt: number, ctx: SystemContext): void {
    const col = this.collision!;
    const input = ctx.input;
    const up = _up.copy(this.position).normalize();
    const g = col.gravity;

    /* ---- controls ---- */
    if (this.driving) {
      const fwdIn = input.move.y + (input.throttle - input.reverse);
      this.throttle = clamp(fwdIn, -1, 1);
      this.brake = input.isDown('brake') ? 1 : 0;
      const steerTarget = -input.move.x;
      // Steering authority falls with speed, which is what stops a fast
      // vehicle from spinning out on a flick of the stick.
      const authority = 1 / (1 + this.speed() * 0.055);
      this.steerAngle += (steerTarget * 0.52 * authority - this.steerAngle) * Math.min(1, dt * 9);
    } else {
      this.throttle *= 0.9;
      this.brake = 1;
      this.steerAngle *= 0.9;
    }
    const handbrake = this.driving && input.isDown('handbrake');

    /* ---- body axes ---- */
    const bodyUp = _bu.set(0, 1, 0).applyQuaternion(this.orientation);
    const bodyFwd = _bf.set(0, 0, -1).applyQuaternion(this.orientation);
    const bodyRight = _br.set(1, 0, 0).applyQuaternion(this.orientation);

    const force = _force.set(0, 0, 0).addScaledVector(up, -g * this.mass);
    const torque = _torque.set(0, 0, 0);

    let groundedCount = 0;

    for (const w of this.wheels) {
      // Wheel attachment in world space.
      const wp = _wp.copy(w.local).applyQuaternion(this.orientation).add(this.position);
      const wDir = _wd.copy(wp).normalize();
      const groundR = col.radius + col.heightAt(wDir);
      const rayLen = REST + TRAVEL;
      // Distance from the attachment down to the ground along body-up.
      const alt = wp.length() - groundR;
      const contact = alt - 0.30; // wheel radius

      w.lastCompression = w.compression;
      if (contact < rayLen && contact > -0.6) {
        w.grounded = true;
        groundedCount++;
        w.compression = clamp(1 - contact / rayLen, 0, 1.4);

        const springF = STIFF * w.compression * 0.25;
        const vel = _wv.copy(this.velocity).add(_tmp.crossVectors(this.angular, _rel.copy(wp).sub(this.position)));
        const compressRate = (w.compression - w.lastCompression) / dt;
        const damperF = DAMP * clamp(compressRate, -12, 12) * 0.25;
        const susp = springF + damperF;

        force.addScaledVector(bodyUp, susp);
        torque.add(_tmp.crossVectors(_rel.copy(wp).sub(this.position), _tmp2.copy(bodyUp).multiplyScalar(susp)));

        /* ---- tyres ---- */
        // Steer this wheel's forward axis.
        const steer = w.steer ? this.steerAngle : 0;
        const wheelFwd = _wf.copy(bodyFwd).applyAxisAngle(bodyUp, steer).normalize();
        const wheelRight = _wr.crossVectors(wheelFwd, bodyUp).normalize();

        const vFwd = vel.dot(wheelFwd);
        const vLat = vel.dot(wheelRight);
        const load = susp / (this.mass * g) + 0.15;

        // Longitudinal: drive and brake.
        let long = 0;
        if (w.drive) {
          // Torque curve: strong off the line, tailing off with speed.
          const curve = 1 / (1 + Math.abs(vFwd) * 0.06);
          long += this.throttle * 5200 * curve * 0.25;
        }
        long -= vFwd * (this.brake > 0.5 ? 2600 : 220) * 0.25;

        // Lateral: the grip that makes it corner, reduced by the handbrake on
        // the rear axle so it can be deliberately broken loose.
        const rear = !w.steer;
        const gripScale = handbrake && rear ? 0.16 : 1;
        const lat = -vLat * 5200 * load * gripScale * 0.25;

        const tyre = _tyre.set(0, 0, 0).addScaledVector(wheelFwd, long).addScaledVector(wheelRight, lat);
        // Friction circle: a tyre has one budget of grip to spend.
        const maxF = 9000 * load;
        if (tyre.length() > maxF) tyre.setLength(maxF);

        force.add(tyre);
        torque.add(_tmp.crossVectors(_rel.copy(wp).sub(this.position), tyre));

        w.spin += (vFwd / 0.30) * dt;
        w.normal.copy(wDir);
      } else {
        w.grounded = false;
        w.compression = Math.max(0, w.compression - dt * 3);
      }
    }

    /* ---- integrate ---- */
    this.velocity.addScaledVector(force, dt / this.mass);
    // Drag and rolling resistance.
    this.velocity.multiplyScalar(Math.max(0, 1 - 0.35 * dt));

    const prevSpeed = this.velocity.length();
    this.position.addScaledVector(this.velocity, dt);

    // Angular: a crude inertia tensor is plenty for a boxy vehicle.
    const inertia = this.mass * 1.8;
    this.angular.addScaledVector(torque, dt / inertia);
    this.angular.multiplyScalar(Math.max(0, 1 - 3.4 * dt));
    const av = this.angular.length();
    if (av > 1e-5) {
      _q.setFromAxisAngle(_tmp.copy(this.angular).normalize(), av * dt);
      this.orientation.premultiply(_q).normalize();
    }

    /* ---- keep it out of the ground, and stay upright on the sphere ---- */
    const dir = _wd.copy(this.position).normalize();
    const floor = col.radius + col.heightAt(dir) + 0.22;
    if (this.position.length() < floor) {
      const impact = -this.velocity.dot(dir);
      this.position.copy(dir).multiplyScalar(floor);
      if (impact > 0) this.velocity.addScaledVector(dir, impact);
      if (impact > 9) {
        // Damage on a real slam, Pacific Drive style.
        this.health = Math.max(0, this.health - (impact - 9) * 0.012);
        ctx.services.audio?.play('rockfall', { volume: saturate(impact / 30) });
      }
    }

    // Gently re-align body-up toward the planet's up when grounded, so driving
    // over a hemisphere never tips into a slow roll.
    if (groundedCount >= 3) {
      const bu = _bu2.set(0, 1, 0).applyQuaternion(this.orientation);
      _q.setFromUnitVectors(bu, dir);
      this.orientation.premultiply(_q2.slerp(_q, Math.min(1, dt * 2.4))).normalize();
    }
    void prevSpeed;
  }

  private applyVisual(dt: number): void {
    this.root.position.copy(this.position);
    this.root.quaternion.copy(this.orientation);
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const m = this.parts.wheels[i];
      if (!m) continue;
      m.position.y = -REST + w.compression * TRAVEL * 0.9;
      m.rotation.set(0, w.steer ? this.steerAngle : 0, 0);
      if (this.parts.hubs[i]) this.parts.hubs[i].rotation.x = w.spin;
    }
    this.parts.setDamage?.(1 - this.health);
    this.parts.setLights?.(this.driving);
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
const _up = new Vector3();
const _bu = new Vector3();
const _bu2 = new Vector3();
const _bf = new Vector3();
const _br = new Vector3();
const _force = new Vector3();
const _torque = new Vector3();
const _wp = new Vector3();
const _wd = new Vector3();
const _wv = new Vector3();
const _wf = new Vector3();
const _wr = new Vector3();
const _rel = new Vector3();
const _tmp = new Vector3();
const _tmp2 = new Vector3();
const _tyre = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();
