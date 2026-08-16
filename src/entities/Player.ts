/**
 * The character controller.
 *
 * Walking on a sphere means there is no global "up" — up is wherever you are
 * standing, and it rotates under you as you move. Everything here works in the
 * local tangent frame: movement is projected onto the tangent plane, gravity
 * points at the planet centre, and the aim vector is re-orthogonalised against
 * the local up every frame so a long walk never accumulates roll.
 *
 * The feel is tuned around three forgiveness windows that cost almost nothing
 * and are the entire difference between "responsive" and "janky":
 *   • coyote time — you may still jump for 120 ms after walking off an edge
 *   • jump buffering — a jump pressed 120 ms early fires on landing
 *   • variable height — releasing early cuts the rise short
 */

import { Group, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type {
  CollisionProvider,
  IPlayer,
  IVehicle,
  PlayerState,
  SystemContext,
  ViewMode,
} from '../api/Contracts';
import { Rng } from '../core/Rand';
import { CameraRig } from './CameraRig';
import { CharacterMesh } from './CharacterMesh';
import { clamp, saturate, approach } from './Motion';

const COYOTE = 0.12;
const JUMP_BUFFER = 0.12;
/** Cosine of the steepest slope you can stand on (~52°). */
const SLOPE_LIMIT = Math.cos(0.91);

export class Player implements IPlayer {
  readonly root = new Group();
  readonly camera: PerspectiveCamera;
  readonly state: PlayerState;

  private rig: CameraRig;
  private mesh: CharacterMesh;
  private collision: CollisionProvider | null = null;

  private up = new Vector3(0, 1, 0);
  private aim = new Vector3(0, 0, -1);
  private pitch = 0;
  private coyote = 0;
  private buffered = 0;
  private jumpHeld = false;
  private controlEnabled = true;
  private stepTimer = 0;
  private wasGrounded = true;
  private fallSpeed = 0;

  constructor(seed = 1) {
    const rng = new Rng(seed);
    this.rig = new CameraRig(68);
    this.camera = this.rig.camera;
    this.mesh = new CharacterMesh(rng, 1.82, { shadows: true, lamp: true });
    this.root.add(this.mesh.root);

    this.state = {
      position: new Vector3(),
      velocity: new Vector3(),
      up: this.up,
      forward: this.aim,
      grounded: false,
      swimming: false,
      sprinting: false,
      crouching: false,
      fuel: 1,
      eyeHeight: this.mesh.eyeLocalY,
      view: 'third',
      speed: 0,
      vehicle: null,
    };
  }

  attach(collision: CollisionProvider): void {
    this.collision = collision;
  }

  spawnAt(direction: Vector3, headingRad = 0): void {
    if (!this.collision) return;
    const d = _a.copy(direction).normalize();
    const h = this.collision.heightAt(d);
    const sea = this.collision.seaLevelRadius();
    const r = Math.max(this.collision.radius + h, sea > 0 ? sea : -Infinity);
    this.state.position.copy(d).multiplyScalar(r + 0.05);
    this.state.velocity.set(0, 0, 0);
    this.up.copy(d);

    // Aim along a tangent, rotated by the requested heading.
    const ref = Math.abs(d.y) > 0.94 ? _b.set(1, 0, 0) : _b.set(0, 1, 0);
    this.aim.crossVectors(ref, this.up).normalize();
    _q.setFromAxisAngle(this.up, headingRad);
    this.aim.applyQuaternion(_q).normalize();
    this.pitch = 0;
    this.rig.reset();
    this.state.grounded = true;
    this.coyote = COYOTE;
  }

  setView(mode: ViewMode): void {
    this.state.view = mode;
    this.rig.setMode(mode);
  }

  toggleView(): void {
    this.rig.toggle();
    this.state.view = this.state.view === 'first' ? 'third' : 'first';
  }

  board(vehicle: IVehicle | null): void {
    this.state.vehicle = vehicle;
    vehicle?.setDriver(true);
    this.mesh.root.visible = !vehicle;
  }

  shake(amount: number, duration: number): void {
    this.rig.shake(amount, duration);
  }

  setControlEnabled(v: boolean): void {
    this.controlEnabled = v;
  }

  update(dt: number, ctx: SystemContext): void {
    if (!this.collision) return;
    const input = ctx.input;
    const g = this.collision.gravity;
    const p = this.state.position;
    const v = this.state.velocity;

    /* ---- frame ---- */
    this.up.copy(p).normalize();
    // Re-orthogonalise the aim against the new up. Without this, walking a
    // great circle slowly tips the horizon.
    this.aim.addScaledVector(this.up, -this.aim.dot(this.up));
    if (this.aim.lengthSq() < 1e-8) {
      const ref = Math.abs(this.up.y) > 0.94 ? _b.set(1, 0, 0) : _b.set(0, 1, 0);
      this.aim.crossVectors(ref, this.up);
    }
    this.aim.normalize();

    /* ---- look ---- */
    if (this.controlEnabled) {
      _q.setFromAxisAngle(this.up, -input.look.x);
      this.aim.applyQuaternion(_q).normalize();
      this.pitch = clamp(this.pitch - input.look.y, -1.45, 1.45);
      if (input.wheel !== 0) this.rig.zoom(input.wheel * 0.35);
      if (input.pinch !== 0) this.rig.zoom(-input.pinch * 1.4);
      if (input.pressed('toggleView')) this.toggleView();
    }

    /* ---- ground query ---- */
    const groundH = this.collision.heightAt(this.up);
    const groundR = this.collision.radius + groundH;
    const seaR = this.collision.seaLevelRadius();
    const dist = p.length();
    const feet = dist;
    const swimming = seaR > 0 && feet < seaR - 0.35;
    this.state.swimming = swimming;

    // Terrain normal by finite difference of the height field along two
    // tangents. Cheap, and it agrees with what the shader drew.
    const right = _c.crossVectors(this.aim, this.up).normalize();
    const e = 1.2;
    const hR = this.collision.heightAt(_d.copy(this.up).addScaledVector(right, e / this.collision.radius).normalize());
    const hF = this.collision.heightAt(_d.copy(this.up).addScaledVector(this.aim, e / this.collision.radius).normalize());
    const normal = _e
      .copy(this.up)
      .addScaledVector(right, -(hR - groundH) / e)
      .addScaledVector(this.aim, -(hF - groundH) / e)
      .normalize();
    const flatness = normal.dot(this.up);

    /* ---- intent ---- */
    const sprintHeld = input.isDown('sprint');
    const crouchHeld = input.isDown('crouch');
    this.state.sprinting = sprintHeld && !crouchHeld && !swimming;
    this.state.crouching = crouchHeld && !swimming;

    // Camera-relative movement: push forward, go where the camera looks. The
    // character then turns to face that direction rather than strafing.
    const camFwd = this.rig.facing(this.up, _f);
    const camRight = _g.crossVectors(camFwd, this.up).normalize().multiplyScalar(-1);
    const wish = _h.set(0, 0, 0);
    if (this.controlEnabled) {
      wish.addScaledVector(camFwd, input.move.y);
      wish.addScaledVector(camRight, -input.move.x);
    }
    const wishLen = Math.min(1, wish.length());
    if (wishLen > 1e-4) wish.normalize();

    const base = this.state.crouching ? 2.1 : this.state.sprinting ? 8.6 : 4.4;
    const targetSpeed = base * wishLen;

    /* ---- integrate ---- */
    const vUp = v.dot(this.up);
    const vTan = _i.copy(v).addScaledVector(this.up, -vUp);

    const grounded = !swimming && feet <= groundR + 0.22 && vUp <= 0.6;
    if (grounded) this.coyote = COYOTE;
    else this.coyote = Math.max(0, this.coyote - dt);

    if (swimming) {
      // Buoyancy plus heavy drag. Water should feel slow and safe.
      const submerge = saturate((seaR - feet) / 1.6);
      const buoy = g * 1.15 * submerge;
      v.addScaledVector(this.up, (buoy - g) * dt);
      const swimUp = (input.isDown('jump') ? 1 : 0) - (input.isDown('crouch') ? 1 : 0);
      v.addScaledVector(this.up, swimUp * 6.0 * dt);
      vTan.copy(v).addScaledVector(this.up, -v.dot(this.up));
      vTan.lerp(_j.copy(wish).multiplyScalar(3.2), 1 - Math.pow(0.02, dt));
      v.copy(vTan).addScaledVector(this.up, v.dot(this.up) * Math.pow(0.2, dt));
    } else {
      // Ground and air both accelerate toward the wish velocity; air just does
      // it far more slowly, which is what gives a jump commitment.
      const accel = grounded ? 42 : 7.5;
      const friction = grounded ? (wishLen > 0.02 ? 6 : 14) : 0.35;
      const target = _j.copy(wish).multiplyScalar(targetSpeed);
      const delta = _k.subVectors(target, vTan);
      const maxDelta = accel * dt;
      if (delta.length() > maxDelta) delta.setLength(maxDelta);
      vTan.add(delta);
      vTan.multiplyScalar(Math.max(0, 1 - friction * dt));

      let newVUp = vUp - g * dt;

      /* ---- jump ---- */
      if (this.controlEnabled && input.pressed('jump')) this.buffered = JUMP_BUFFER;
      this.buffered = Math.max(0, this.buffered - dt);
      const wantJump = this.buffered > 0 && this.coyote > 0;
      if (wantJump) {
        // Scale the impulse so jump *height* stays playable across gravities:
        // h = v²/2g, so v = √(2gh) with h held roughly constant.
        const targetHeight = 1.35;
        newVUp = Math.sqrt(2 * g * targetHeight);
        this.buffered = 0;
        this.coyote = 0;
        this.jumpHeld = true;
        ctx.services.audio?.play('jump');
      }
      if (this.jumpHeld && !input.isDown('jump') && newVUp > 0) {
        newVUp *= 0.45; // variable height: let go early, rise less
        this.jumpHeld = false;
      }
      if (newVUp <= 0) this.jumpHeld = false;

      /* ---- jetpack ---- */
      const jetting =
        this.controlEnabled && input.isDown('boost') && this.state.fuel > 0.01 && !grounded;
      if (jetting) {
        newVUp += g * 1.9 * dt;
        this.state.fuel = Math.max(0, this.state.fuel - dt * 0.32);
      } else if (grounded) {
        this.state.fuel = Math.min(1, this.state.fuel + dt * 0.55);
      }

      v.copy(vTan).addScaledVector(this.up, newVUp);
    }

    p.addScaledVector(v, dt);

    /* ---- resolve against the ground ---- */
    this.up.copy(p).normalize();
    const gh2 = this.collision.heightAt(this.up);
    const floor = this.collision.radius + gh2;
    const nowDist = p.length();
    let landed = false;
    if (!swimming && nowDist < floor) {
      p.copy(this.up).multiplyScalar(floor);
      const into = v.dot(this.up);
      if (into < 0) {
        this.fallSpeed = -into;
        v.addScaledVector(this.up, -into);
        landed = true;
      }
      // Too steep to stand: slide, and accelerate doing it.
      if (flatness < SLOPE_LIMIT) {
        const slide = _l.copy(this.up).addScaledVector(normal, -1 / Math.max(0.2, flatness)).normalize();
        v.addScaledVector(slide, g * 0.55 * dt);
      }
      this.state.grounded = true;
    } else {
      this.state.grounded = grounded && !swimming;
    }

    /* ---- obstacles ---- */
    if (this.collision.resolve) {
      const push = this.collision.resolve(p, 0.38, 1.8);
      if (push) {
        p.add(push);
        const n = _m.copy(push).normalize();
        const into = v.dot(n);
        if (into < 0) v.addScaledVector(n, -into);
      }
    }

    /* ---- landing feedback ---- */
    if (landed && !this.wasGrounded && this.fallSpeed > 3) {
      this.rig.impact(this.fallSpeed);
      ctx.services.audio?.play('land', { volume: saturate(this.fallSpeed / 18) });
    }
    this.wasGrounded = this.state.grounded;

    /* ---- footsteps ---- */
    const speed = v.length();
    this.state.speed = speed;
    if (this.state.grounded && speed > 0.6) {
      this.stepTimer -= dt * speed * (this.state.sprinting ? 0.42 : 0.55);
      if (this.stepTimer <= 0) {
        this.stepTimer = 1;
        ctx.services.audio?.play('footstep', { rate: 0.9 + Math.random() * 0.2 });
      }
    }

    /* ---- camera + mesh ---- */
    this.state.eyeHeight = this.mesh.eyeLocalY * (this.state.crouching ? 0.62 : 1);
    this.rig.setPrefs({
      fovDeg: ctx.services.prefs?.fovDeg ?? 68,
      headBob: ctx.services.prefs?.headBob ?? true,
    });
    this.rig.update(dt, {
      position: p,
      up: this.up,
      aimForward: this.aim,
      aimPitch: this.pitch,
      roll: 0,
      velocity: v,
      eyeHeight: this.state.eyeHeight,
      sprint: this.state.sprinting ? 1 : 0,
      moving: wishLen,
      grounded: this.state.grounded,
      swimming,
      riding: !!this.state.vehicle,
      refSpeed: 8.6,
      renderOrigin: _zero,
    });

    // Face the direction of travel; fall back to the aim when standing still.
    const faceDir = speed > 0.35 ? _n.copy(v).addScaledVector(this.up, -v.dot(this.up)).normalize() : this.aim;
    this.mesh.root.position.copy(p);
    this.mesh.update(dt, {
      speed,
      facing: faceDir,
      up: this.up,
      grounded: this.state.grounded,
      swimming: swimming ? 1 : 0,
      jetpack: input.isDown('boost') && !this.state.grounded ? 1 : 0,
      crouch: this.state.crouching ? 1 : 0,
      sprint: this.state.sprinting ? 1 : 0,
      verticalSpeed: v.dot(this.up),
      accelForward: 0,
      turnRate: 0,
      landing: landed ? 1 : 0,
    } as any);
    this.mesh.setViewBlend(this.state.view === 'first' ? 1 : 0);
  }

  dispose(): void {
    this.mesh.dispose();
  }
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _f = new Vector3();
const _g = new Vector3();
const _h = new Vector3();
const _i = new Vector3();
const _j = new Vector3();
const _k = new Vector3();
const _l = new Vector3();
const _m = new Vector3();
const _n = new Vector3();
const _q = new Quaternion();
const _zero = new Vector3(0, 0, 0);
