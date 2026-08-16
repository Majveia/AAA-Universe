/**
 * GALAXY — 1 unit = 1 light year.
 *
 * The middle scale, and the navigation layer: you arrive from the cosmic web,
 * find the disc, and pick a star to fall into. It doubles as the star map, so
 * the same view that is a spectacle is also the thing you use to travel.
 */

import { AmbientLight, Color, MathUtils, Scene, Vector3 } from 'three';
import type { Realm, RealmContext } from '../core/Realm';
import { FlyCamera } from './FlyCamera';
import { GalaxyRenderer } from '../galaxy/GalaxyRenderer';
import type { IGalaxyRenderer, HudTarget } from '../api/Contracts';
import { makeGalaxy } from '../universe/Universe';
import type { GalaxySpec, StarSystemSpec } from '../universe/Types';
import { hashCombine } from '../core/Rand';

export interface GalaxyViewOptions {
  distance?: number;
  pitch?: number;
  yaw?: number;
}

export class GalaxyRealm implements Realm {
  readonly id = 'galaxy' as const;
  readonly camera: FlyCamera['camera'];
  readonly scene = new Scene();

  private fly = new FlyCamera(60, 1, 4e6);
  private renderer: IGalaxyRenderer | null = null;
  private spec: GalaxySpec | null = null;
  private orbit = { yaw: 0.4, pitch: 0.9, distance: 120000 };
  private autoDrift = 1;
  private timeInRealm = 0;
  private target: StarSystemSpec | null = null;
  private candidates: StarSystemSpec[] = [];
  private candidateIndex = 0;

  constructor() {
    this.camera = this.fly.camera;
    this.scene.background = new Color(0x000000);
    this.scene.add(new AmbientLight(0x0b1018, 0.3));
  }

  async enter(ctx: RealmContext, payload?: any): Promise<void> {
    const universe = ctx.services.universe;
    if (!this.spec) {
      // Which galaxy we land in is derived from where we dived in from, so
      // aiming at a different node genuinely takes you somewhere else.
      const from = payload?.fromCosmos as number[] | null;
      const seed = from
        ? hashCombine(universe.seed, Math.round(from[0] * 7), Math.round(from[1] * 11), Math.round(from[2] * 13))
        : hashCombine(universe.seed, 0x1a7);
      // The galaxy you start in is a barred spiral, like the one you are
      // reading this from. Every other galaxy is drawn from the real
      // distribution; this one is the establishing shot and gets to be the
      // shape everybody pictures when they hear the word.
      this.spec = makeGalaxy(seed, [0, 0, 0], from ? undefined : 'barred-spiral');
    }
    if (!this.renderer) {
      this.renderer = new GalaxyRenderer();
      this.renderer.setQuality(ctx.quality);
      this.scene.add(this.renderer.root);
    }
    this.renderer.build(this.spec);

    this.orbit.distance = this.spec.radiusLy * 1.9;
    this.timeInRealm = 0;
    this.autoDrift = 1;
    this.applyOrbit();

    // Pre-pick a handful of systems worth visiting so "next target" always
    // lands on something interesting rather than a random red dwarf.
    this.candidates = [];
    const home = universe.findHomeSystem();
    this.candidates.push(home);
    for (const s of universe.systemsNear(home.position[0], home.position[1], home.position[2], 120)) {
      if (s.notable && this.candidates.length < 12) this.candidates.push(s);
    }
    this.target = this.candidates[0] ?? null;

    const hud = ctx.services.hud;
    hud?.setContext('map');
    hud?.setLocation(this.spec.name, `${this.spec.type} · ${(this.spec.starCount / 1e9).toFixed(0)} billion stars`);
    hud?.titleCard(this.spec.name, `${describeType(this.spec.type)} · ${Math.round(this.spec.radiusLy / 1000)} kly across`);
    ctx.services.audio?.setMood('wonder', 0.6);
  }

  update(dt: number, ctx: RealmContext): void {
    if (!this.renderer || !this.spec) return;
    this.timeInRealm += dt;
    const input = ctx.input;

    const hasInput = input.move.lengthSq() > 0.001 || input.look.lengthSq() > 1e-7 || input.wheel !== 0 || input.pinch !== 0;
    this.autoDrift = hasInput ? Math.max(0, this.autoDrift - dt * 1.6) : Math.min(1, this.autoDrift + dt * 0.1);

    this.orbit.yaw += dt * (0.01 + 0.03 * this.autoDrift);
    this.orbit.yaw -= input.look.x * 1.5;
    this.orbit.pitch = MathUtils.clamp(this.orbit.pitch - input.look.y * 1.5, -1.5, 1.5);
    const zoom = -input.wheel * 0.13 + input.pinch * -0.5 - input.move.y * dt * 1.1;
    this.orbit.distance = MathUtils.clamp(
      this.orbit.distance * Math.exp(zoom),
      this.spec.radiusLy * 0.06,
      this.spec.radiusLy * 8
    );
    this.applyOrbit();
    this.fly.setAspect(ctx.engine.aspect);

    this.renderer.update(dt, {
      renderer: ctx.renderer,
      scene: this.scene,
      camera: this.camera,
      input: ctx.input,
      quality: ctx.quality,
      time: ctx.time,
      simTime: ctx.time,
      services: ctx.services,
    });

    /* ---- target cycling ---- */
    if (input.pressed('nextTarget') && this.candidates.length) {
      this.candidateIndex = (this.candidateIndex + 1) % this.candidates.length;
      this.target = this.candidates[this.candidateIndex];
      ctx.services.audio?.play('ui_select');
    }
    if (input.pressed('prevTarget') && this.candidates.length) {
      this.candidateIndex = (this.candidateIndex - 1 + this.candidates.length) % this.candidates.length;
      this.target = this.candidates[this.candidateIndex];
      ctx.services.audio?.play('ui_select');
    }
    if (this.target) {
      this.renderer.setTarget(new Vector3(...this.target.position));
    }

    /* ---- HUD markers ---- */
    const hud = ctx.services.hud;
    if (hud) {
      const targets: HudTarget[] = [];
      for (const s of this.candidates.slice(0, 10)) {
        targets.push({
          position: new Vector3(...s.position),
          label: s.name,
          sub: describeSystem(s),
          kind: 'star',
          important: s === this.target,
        });
      }
      hud.setTargets(targets);
      if (this.target) {
        hud.setLocation(this.spec.name, `Target: ${this.target.name} · ${describeSystem(this.target)}`);
      }
    }

    if (input.pressed('enter') || input.pressed('interact')) {
      if (this.target) {
        ctx.services.audio?.play('warp_jump');
        ctx.engine.goto('system', { system: this.target }, 2.4);
      }
    }
    if (input.pressed('map')) {
      ctx.engine.goto('cosmos', undefined, 2.0);
    }
  }

  private applyOrbit(): void {
    const cp = Math.cos(this.orbit.pitch);
    const dir = new Vector3(Math.cos(this.orbit.yaw) * cp, Math.sin(this.orbit.pitch), Math.sin(this.orbit.yaw) * cp);
    this.fly.position.copy(dir).multiplyScalar(this.orbit.distance);
    this.fly.lookAt(new Vector3(0, 0, 0));
    this.camera.position.copy(this.fly.position);
    this.camera.quaternion.copy(this.fly.orientation);
    this.camera.updateMatrixWorld();
  }

  resize(w: number, h: number): void {
    this.fly.setAspect(w / h);
  }

  setQuality(q: any): void {
    this.renderer?.setQuality(q);
  }

  locationLabel(): string {
    return this.spec?.name ?? 'Galaxy';
  }

  /** Diagnostic: what the harness is actually looking at. */
  debugGalaxy(): Record<string, any> {
    if (!this.spec) return { built: false };
    return {
      name: this.spec.name,
      type: this.spec.type,
      arms: this.spec.arms,
      armPitch: Number(this.spec.armPitch.toFixed(3)),
      barFraction: Number(this.spec.barFraction.toFixed(3)),
      radiusLy: Math.round(this.spec.radiusLy),
      distance: Math.round(this.orbit.distance),
      ...((this.renderer as GalaxyRenderer | null)?.stats() ?? {}),
    };
  }

  debugView(o: GalaxyViewOptions = {}): void {
    if (o.distance !== undefined) this.orbit.distance = o.distance;
    if (o.pitch !== undefined) this.orbit.pitch = o.pitch;
    if (o.yaw !== undefined) this.orbit.yaw = o.yaw;
    this.autoDrift = 0;
    this.applyOrbit();
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = null;
  }
}

function describeType(t: string): string {
  const M: Record<string, string> = {
    spiral: 'Spiral galaxy',
    'barred-spiral': 'Barred spiral galaxy',
    elliptical: 'Elliptical galaxy',
    lenticular: 'Lenticular galaxy',
    irregular: 'Irregular galaxy',
    dwarf: 'Dwarf galaxy',
    ring: 'Ring galaxy',
  };
  return M[t] ?? 'Galaxy';
}

function describeSystem(s: StarSystemSpec): string {
  const st = s.stars[0];
  const kind = st.compact
    ? st.compact.kind.replace('-', ' ')
    : `${st.spectral}${st.subclass} ${st.luminosityClass}`;
  const worlds = s.planets.length === 1 ? '1 world' : `${s.planets.length} worlds`;
  const life = s.planets.find((p) => p.life === 'sapient' || p.life === 'post-sapient');
  return life ? `${kind} · ${worlds} · signals detected` : `${kind} · ${worlds}`;
}
