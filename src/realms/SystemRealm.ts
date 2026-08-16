/**
 * SYSTEM — interplanetary space. 1 unit = 1 metre.
 *
 * The hard problem here is scale. A star system is 10¹³ metres across and the
 * ship is 10¹ metres long, and both have to be on screen in the same frame
 * without the geometry tearing itself apart in Float32.
 *
 * Two mechanisms handle it:
 *   • FLOATING ORIGIN. The camera is pinned to the scene origin and every body
 *     is placed relative to it. Absolute positions live in JS numbers (which
 *     are doubles) and only the small relative offsets are ever handed to the
 *     GPU. Fly a billion kilometres and the vertices near you are still exact.
 *   • LOGARITHMIC DEPTH. Enabled on the renderer, so a cockpit rail at 0.5 m
 *     and a gas giant at 10¹² m can share a depth buffer without z-fighting.
 *
 * Time is the other axis you can travel along: the whole system is on real
 * Keplerian orbits, so accelerating time turns it into an orrery you can watch
 * evolve, and it is still deterministic when you slow back down.
 */

import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  Line,
  LineBasicMaterial,
  MathUtils,
  Points,
  PointsMaterial,
  Vector2,
  Scene,
  Vector3,
} from 'three';
import type { Realm, RealmContext } from '../core/Realm';
import { FlyCamera } from './FlyCamera';
import { StarRenderer } from './StarRenderer';
import { BodyRenderer } from './BodyRenderer';
import { orbitPolyline, orbitalPosition } from './Orbits';
import { AU, type PlanetSpec, type StarSystemSpec } from '../universe/Types';
import type { HudTarget } from '../api/Contracts';
import { Rng } from '../core/Rand';

interface BodyEntry {
  spec: PlanetSpec;
  renderer: BodyRenderer;
  /** Absolute position in system coordinates, metres. */
  absolute: Vector3;
  orbitLine: Line | null;
  built: boolean;
  /** Angular radius in radians as seen from the camera. */
  angular: number;
}

export interface SystemViewOptions {
  mode?: 'wide' | 'inner' | 'planet' | 'star';
  planetIndex?: number;
}

export class SystemRealm implements Realm {
  readonly id = 'system' as const;
  readonly scene = new Scene();
  readonly camera: FlyCamera['camera'];

  private fly = new FlyCamera(68, 0.2, 1e13);
  private spec: StarSystemSpec | null = null;
  private star = new StarRenderer();
  private bodies: BodyEntry[] = [];
  private belt: Points | null = null;
  private beltBase: Float32Array | null = null;

  /** Absolute camera position in system coordinates, metres (doubles). */
  private origin = new Vector3();
  private simTime = 0;
  private timeAccel = 1;
  private timeInRealm = 0;
  private sunColor: [number, number, number] = [1, 1, 1];
  private approachTarget: BodyEntry | null = null;

  constructor() {
    this.camera = this.fly.camera;
    this.scene.background = new Color(0x000000);
    // Interplanetary space is not lit by anything but the star, but a floor of
    // ambient keeps the unlit hemisphere from being a pure black cut-out.
    this.scene.add(new AmbientLight(0x0a0e18, 0.25));
    this.scene.add(this.star.root);
  }

  async enter(ctx: RealmContext, payload?: any): Promise<void> {
    const universe = ctx.services.universe;
    const spec: StarSystemSpec = payload?.system ?? universe.findHomeSystem();
    if (this.spec?.seed !== spec.seed) this.build(spec, ctx);

    this.timeInRealm = 0;
    this.timeAccel = payload?.timeAccel ?? 1;

    // Arrive above the ecliptic looking down the system, with the star off to
    // one side — a composition, not a coordinate.
    const anchor = this.bodies.length ? this.bodies[Math.min(1, this.bodies.length - 1)] : null;
    const d = anchor ? anchor.spec.orbit.a : 1.4 * AU;
    this.origin.set(d * 0.75, d * 0.42, d * 0.95);
    this.fly.position.set(0, 0, 0);
    this.fly.velocity.set(0, 0, 0);
    this.fly.baseSpeed = 2.4e5;
    this.fly.scaleHint = 1;
    this.fly.throttle = 0;
    this.updateBodies(0);
    this.fly.lookAt(this.toLocal(this.bodies[0]?.absolute ?? new Vector3(), new Vector3()));

    const hud = ctx.services.hud;
    hud?.setContext('space');
    hud?.setLocation(spec.name, describeStar(spec));
    hud?.titleCard(spec.name, `${spec.stars.length > 1 ? `${spec.stars.length} stars` : describeStar(spec)} · ${spec.planets.length} worlds`);
    ctx.services.audio?.setMood('drift', 0.55);
    ctx.services.audio?.setAmbience('vacuum', 0.5);
  }

  private build(spec: StarSystemSpec, ctx: RealmContext): void {
    this.teardown();
    this.spec = spec;

    const primary = spec.stars[0];
    this.star.build(primary);
    this.sunColor = primary.color;

    for (const p of spec.planets) {
      const entry: BodyEntry = {
        spec: p,
        renderer: new BodyRenderer(),
        absolute: new Vector3(),
        orbitLine: null,
        built: false,
        angular: 0,
      };
      // Orbit traces are drawn immediately: they give the system a readable
      // structure before you can resolve any of the planets as discs.
      const pts = orbitPolyline(p.orbit, 320);
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(pts, 3));
      const mat = new LineBasicMaterial({
        color: new Color(0.18, 0.30, 0.44),
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      });
      entry.orbitLine = new Line(geo, mat);
      this.scene.add(entry.orbitLine);
      this.bodies.push(entry);
    }

    // Asteroid belt: instanced points on their own slightly randomised orbits.
    const beltSpec = spec.belts[0];
    if (beltSpec?.present) {
      const rng = new Rng(spec.seed ^ 0x8e11);
      const n = Math.min(beltSpec.count, ctx.quality.particleBudget);
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const a = rng.range(beltSpec.innerM, beltSpec.outerM);
        const th = rng.range(0, Math.PI * 2);
        const inc = rng.normal(0, beltSpec.spread);
        pos[i * 3] = Math.cos(th) * a;
        pos[i * 3 + 1] = Math.sin(inc) * a * 0.5;
        pos[i * 3 + 2] = Math.sin(th) * a;
      }
      this.beltBase = pos;
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(pos.slice(), 3));
      const mat = new PointsMaterial({
        color: new Color(...beltSpec.color),
        size: 4e7,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      });
      this.belt = new Points(geo, mat);
      this.scene.add(this.belt);
    }
  }

  update(dt: number, ctx: RealmContext): void {
    if (!this.spec) return;
    this.timeInRealm += dt;
    const input = ctx.input;

    /* ---- time acceleration: turn the system into an orrery ---- */
    if (input.keyPressed('Period')) this.timeAccel = Math.min(1e7, this.timeAccel * 6);
    if (input.keyPressed('Comma')) this.timeAccel = Math.max(1, this.timeAccel / 6);
    this.simTime += dt * this.timeAccel;

    /* ---- flight ---- */
    // Speed scales with the distance to the nearest body, so the same stick
    // deflection is a gentle approach up close and a cruise between planets.
    let nearest = Infinity;
    for (const b of this.bodies) {
      nearest = Math.min(nearest, this.origin.distanceTo(b.absolute) - b.spec.radiusM);
    }
    nearest = Math.min(nearest, this.origin.length() - this.spec.stars[0].radiusM);
    this.fly.baseSpeed = MathUtils.clamp(Math.abs(nearest) * 0.4, 60, 4e8);

    this.fly.update(dt, input);
    // Fold the camera's local drift back into the absolute origin and re-pin
    // the camera to zero. This is the floating origin, once per frame.
    this.origin.add(this.fly.position);
    this.fly.position.set(0, 0, 0);
    this.camera.position.set(0, 0, 0);
    this.fly.setAspect(ctx.engine.aspect);

    this.updateBodies(dt);

    /* ---- star ---- */
    const starLocal = this.toLocal(new Vector3(0, 0, 0), new Vector3());
    this.star.root.position.copy(starLocal);
    const size = ctx.renderer.getDrawingBufferSize(_sz);
    const pixPerRad = size.y * 0.5 / Math.tan((this.camera.fov * Math.PI) / 360);
    this.star.update(dt, this.camera.position, pixPerRad);

    /* ---- HUD ---- */
    const hud = ctx.services.hud;
    if (hud) {
      const targets: HudTarget[] = [];
      for (const b of this.bodies) {
        const local = this.toLocal(b.absolute, new Vector3());
        targets.push({
          position: local,
          label: b.spec.name,
          sub: describePlanet(b.spec),
          kind: 'planet',
          distance: this.origin.distanceTo(b.absolute) - b.spec.radiusM,
          important: b.spec.notable,
        });
      }
      hud.setTargets(targets);
      hud.setVitals({ speed: this.fly.velocity.length() });
      const accel = this.timeAccel > 1 ? ` · time ×${formatBig(this.timeAccel)}` : '';
      hud.setLocation(this.spec.name, `${describeStar(this.spec)}${accel}`);
    }

    /* ---- approach and descent ---- */
    this.approachTarget = null;
    for (const b of this.bodies) {
      const d = this.origin.distanceTo(b.absolute);
      // Hand over to the planet realm at four radii: far enough out that both
      // renderers look identical, so the swap is invisible.
      if (d < b.spec.radiusM * 4.5) {
        this.approachTarget = b;
        break;
      }
    }
    if (this.approachTarget) {
      hud?.toast(`Approaching ${this.approachTarget.spec.name} — press E to enter orbit`, 2);
      if (input.pressed('interact') || input.pressed('enter')) {
        const dir = new Vector3().subVectors(this.origin, this.approachTarget.absolute).normalize();
        ctx.engine.goto(
          'surface',
          {
            planet: this.approachTarget.spec,
            system: this.spec,
            approachDir: dir.toArray(),
            simTime: this.simTime,
          },
          1.8
        );
      }
    }

    if (input.pressed('map')) ctx.engine.goto('galaxy', undefined, 2.0);
  }

  /** Recompute every body's absolute position and refresh its renderer LOD. */
  private updateBodies(dt: number): void {
    if (!this.spec) return;
    const starIntensity = 1.0;

    for (const b of this.bodies) {
      orbitalPosition(b.spec.orbit, this.simTime, b.absolute);

      const local = this.toLocal(b.absolute, _tmpA);
      const dist = local.length();
      b.angular = Math.atan2(b.spec.radiusM, Math.max(1, dist));

      // Build the sphere only once the body is big enough to be worth it —
      // below about a pixel and a half, the HUD marker is doing the work.
      const wantMesh = b.angular > 0.0012;
      if (wantMesh && !b.built) {
        const segs = b.angular > 0.05 ? 128 : b.angular > 0.01 ? 96 : 48;
        b.renderer.build(b.spec, segs);
        this.scene.add(b.renderer.root);
        b.built = true;
      } else if (!wantMesh && b.built) {
        this.scene.remove(b.renderer.root);
        b.renderer.dispose();
        b.built = false;
      }

      if (b.built) {
        b.renderer.root.position.copy(local);
        const sunDir = new Vector3().sub(b.absolute).normalize(); // toward the star
        b.renderer.setSun(sunDir, this.sunColor, starIntensity);
        b.renderer.update(dt, this.simTime);
      }

      if (b.orbitLine) {
        // The trace is drawn in absolute coordinates, so it only needs the
        // origin offset — no per-vertex work, however far you travel.
        b.orbitLine.position.set(-this.origin.x, -this.origin.y, -this.origin.z);
        const m = b.orbitLine.material as LineBasicMaterial;
        // Fade traces out when you are close enough to see the real thing.
        m.opacity = MathUtils.clamp(0.30 - b.angular * 3.5, 0.0, 0.30);
        b.orbitLine.visible = m.opacity > 0.004;
      }
    }

    if (this.belt) this.belt.position.set(-this.origin.x, -this.origin.y, -this.origin.z);
  }

  private toLocal(absolute: Vector3, out: Vector3): Vector3 {
    return out.subVectors(absolute, this.origin);
  }

  resize(w: number, h: number): void {
    this.fly.setAspect(w / h);
  }

  setQuality(): void {
    /* bodies rebuild themselves by distance; nothing tier-specific to do */
  }

  locationLabel(): string {
    return this.spec?.name ?? 'Deep space';
  }

  debugView(o: SystemViewOptions = {}): void {
    if (!this.spec || !this.bodies.length) return;
    const mode = o.mode ?? 'wide';
    const idx = o.planetIndex ?? Math.max(0, this.bodies.findIndex((b) => b.spec.notable));
    const target = this.bodies[Math.min(idx, this.bodies.length - 1)];
    this.updateBodies(0);

    if (mode === 'wide') {
      const d = (this.bodies[this.bodies.length - 1]?.spec.orbit.a ?? AU) * 1.1;
      this.origin.set(d * 0.5, d * 0.55, d * 0.75);
      this.fly.lookAt(this.toLocal(new Vector3(0, 0, 0), new Vector3()));
    } else if (mode === 'star') {
      const r = this.spec.stars[0].radiusM;
      this.origin.set(r * 6, r * 1.5, r * 6);
      this.fly.lookAt(this.toLocal(new Vector3(0, 0, 0), new Vector3()));
    } else {
      const r = target.spec.radiusM;
      const off = new Vector3(1, 0.35, 1).normalize().multiplyScalar(r * (mode === 'planet' ? 3.2 : 8));
      this.origin.copy(target.absolute).add(off);
      this.fly.lookAt(this.toLocal(target.absolute, new Vector3()));
    }
    this.fly.position.set(0, 0, 0);
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.copy(this.fly.orientation);
    this.updateBodies(0);
    this.camera.updateMatrixWorld();
  }

  private teardown(): void {
    for (const b of this.bodies) {
      if (b.built) this.scene.remove(b.renderer.root);
      b.renderer.dispose();
      if (b.orbitLine) {
        this.scene.remove(b.orbitLine);
        b.orbitLine.geometry.dispose();
        (b.orbitLine.material as LineBasicMaterial).dispose();
      }
    }
    this.bodies = [];
    if (this.belt) {
      this.scene.remove(this.belt);
      this.belt.geometry.dispose();
      (this.belt.material as PointsMaterial).dispose();
      this.belt = null;
    }
  }

  dispose(): void {
    this.teardown();
    this.star.dispose();
  }
}

const _tmpA = new Vector3();
const _sz = new Vector2();

function describeStar(s: StarSystemSpec): string {
  const st = s.stars[0];
  if (st.compact) return st.compact.kind.replace('-', ' ');
  return `${st.spectral}${st.subclass} ${st.luminosityClass} · ${(st.tempK / 1000).toFixed(1)} kK`;
}

function describePlanet(p: PlanetSpec): string {
  const bits = [p.klass.replace('-', ' ')];
  if (p.life === 'sapient') bits.push('inhabited');
  else if (p.life !== 'none') bits.push('life detected');
  if (p.moons.length) bits.push(`${p.moons.length} ${p.moons.length === 1 ? 'moon' : 'moons'}`);
  return bits.join(' · ');
}

function formatBig(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return n.toFixed(0);
}
