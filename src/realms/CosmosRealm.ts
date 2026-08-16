/**
 * COSMOS — the opening. 1 unit = 1 megaparsec.
 *
 * The player arrives here first, hanging in the dark while the largest
 * structure in the universe assembles itself out of almost-nothing. There is
 * no HUD to speak of, no objective, and nothing to shoot. The intent is that
 * for the first thirty seconds you just watch.
 *
 * Control is deliberately soft: the camera is already drifting when you arrive,
 * and your input blends into that drift rather than snatching it away.
 */

import {
  AmbientLight,
  Color,
  MathUtils,
  Scene,
  Vector3,
} from 'three';
import type { Realm, RealmContext } from '../core/Realm';
import { FlyCamera } from './FlyCamera';
import { CosmicWeb } from '../cosmos/CosmicWeb';
import type { ICosmicWeb } from '../api/Contracts';

export interface CosmosViewOptions {
  epoch?: number;
  distance?: number;
  pitch?: number;
  yaw?: number;
}

export class CosmosRealm implements Realm {
  readonly id = 'cosmos' as const;
  readonly scene = new Scene();
  readonly camera: FlyCamera['camera'];

  private fly = new FlyCamera(62, 0.02, 1e6);
  private web: ICosmicWeb | null = null;
  private orbit = { yaw: 0.7, pitch: 0.32, distance: 320 };
  private autoDrift = 1;
  private entered = false;
  private timeInRealm = 0;
  private epochTarget = 1;
  private epochCurrent = 0.06;
  private scrubbing = false;
  private hintShown = false;

  constructor() {
    this.camera = this.fly.camera;
    this.scene.background = new Color(0x000000);
    // A whisper of ambient so the darkest filaments are not pure black — on
    // OLED, a true zero next to a bright node reads as a hole in the screen.
    this.scene.add(new AmbientLight(0x0a1020, 0.35));
  }

  async enter(ctx: RealmContext): Promise<void> {
    if (!this.web) {
      this.web = new CosmicWeb();
      this.web.setQuality(ctx.quality);
      this.scene.add(this.web.root);
    }
    this.entered = true;
    this.timeInRealm = 0;

    // Start early and let it run forward: the first thing the player sees is
    // the universe becoming lumpy, which is the whole story of cosmology.
    this.epochCurrent = 0.055;
    this.epochTarget = 1.0;
    this.web.setEpoch(this.epochCurrent);
    this.web.setTimeRate(1);

    this.applyOrbit();

    const hud = ctx.services.hud;
    hud?.setContext('cosmos');
    hud?.setLocation('The Observable Universe', 'z ≈ 17 · structure forming');
    ctx.services.audio?.setMood('cosmos', 0.55);
    ctx.services.audio?.setAmbience('vacuum', 0.6);
  }

  exit(): void {
    this.entered = false;
  }

  update(dt: number, ctx: RealmContext): void {
    if (!this.web) return;
    this.timeInRealm += dt;

    const input = ctx.input;

    /* ---- epoch scrubbing: the single best toy in the realm ---- */
    const scrubIn = (input.key('KeyE') ? 1 : 0) - (input.key('KeyQ') ? 1 : 0);
    if (scrubIn !== 0) {
      this.scrubbing = true;
      this.epochTarget = MathUtils.clamp(this.epochTarget * Math.pow(2.2, scrubIn * dt), 0.03, 3.2);
    }
    // Left alone, cosmic time keeps running forward at a stately pace.
    if (!this.scrubbing) this.epochTarget = Math.min(1.6, this.epochTarget + dt * 0.012);
    // Log-space easing: equal visual change per unit time across 2 decades.
    const le = Math.log(this.epochCurrent);
    const lt = Math.log(this.epochTarget);
    this.epochCurrent = Math.exp(MathUtils.lerp(le, lt, 1 - Math.pow(0.06, dt)));
    this.web.setEpoch(this.epochCurrent);

    /* ---- camera ---- */
    const hasInput =
      input.move.lengthSq() > 0.001 ||
      input.look.lengthSq() > 1e-7 ||
      input.wheel !== 0 ||
      input.pinch !== 0;
    if (hasInput) this.autoDrift = Math.max(0, this.autoDrift - dt * 1.6);
    else this.autoDrift = Math.min(1, this.autoDrift + dt * 0.12);

    // A slow, always-present orbit. Even under full player control a fraction
    // of it survives, which keeps the frame from ever going static.
    const driftRate = 0.018 + 0.05 * this.autoDrift;
    this.orbit.yaw += dt * driftRate;
    this.orbit.pitch += Math.sin(this.timeInRealm * 0.07) * dt * 0.012;

    this.orbit.yaw -= input.look.x * 1.6;
    this.orbit.pitch = MathUtils.clamp(this.orbit.pitch - input.look.y * 1.6, -1.45, 1.45);
    const zoom = -input.wheel * 0.14 + input.pinch * -0.5 - input.move.y * dt * 0.9;
    this.orbit.distance = MathUtils.clamp(this.orbit.distance * Math.exp(zoom), 12, 900);

    this.applyOrbit();
    this.fly.setAspect(ctx.engine.aspect);
    this.camera.updateMatrixWorld();

    this.web.update(dt, {
      renderer: ctx.renderer,
      scene: this.scene,
      camera: this.camera,
      input: ctx.input,
      quality: ctx.quality,
      time: ctx.time,
      simTime: ctx.time,
      services: ctx.services,
    });

    /* ---- HUD ---- */
    const hud = ctx.services.hud;
    if (hud) {
      const s = this.web.stats();
      hud.setLocation(
        'The Observable Universe',
        `z ≈ ${s.redshift.toFixed(2)} · ${formatAge(s.ageYears)} · ${(s.collapsedFraction * 100).toFixed(1)}% collapsed`
      );
      if (!this.hintShown && this.timeInRealm > 7) {
        this.hintShown = true;
        hud.toast('Q / E to run cosmic time backward and forward', 6);
      }
      if (this.timeInRealm > 16 && this.timeInRealm - dt <= 16) {
        hud.toast('Look into a bright node and press Enter to fall in', 7);
      }
    }

    ctx.services.audio?.setMood('cosmos', 0.4 + 0.35 * MathUtils.clamp(this.epochCurrent, 0, 1));

    /* ---- dive into a supercluster ---- */
    if (input.pressed('enter') || input.pressed('interact')) {
      const dir = this.fly.forward();
      const node = this.web.pickNode(this.fly.position, dir) ?? this.web.nearestNode(this.fly.position);
      ctx.services.audio?.play('warp_charge');
      ctx.engine.goto('galaxy', { fromCosmos: node ? node.toArray() : null }, 2.6);
    }
  }

  private applyOrbit(): void {
    const cp = Math.cos(this.orbit.pitch);
    const dir = new Vector3(
      Math.cos(this.orbit.yaw) * cp,
      Math.sin(this.orbit.pitch),
      Math.sin(this.orbit.yaw) * cp
    );
    this.fly.position.copy(dir).multiplyScalar(this.orbit.distance);
    this.fly.lookAt(new Vector3(0, 0, 0));
    this.camera.position.copy(this.fly.position);
    this.camera.quaternion.copy(this.fly.orientation);
  }

  resize(w: number, h: number): void {
    this.fly.setAspect(w / h);
  }

  setQuality(q: any): void {
    this.web?.setQuality(q);
  }

  locationLabel(): string {
    return 'The Observable Universe';
  }

  /** Harness hook — put the camera somewhere specific for a screenshot. */
  debugView(o: CosmosViewOptions = {}): void {
    if (o.epoch !== undefined) {
      this.epochCurrent = o.epoch;
      this.epochTarget = o.epoch;
      this.scrubbing = true;
      this.web?.setEpoch(o.epoch);
    }
    if (o.distance !== undefined) this.orbit.distance = o.distance;
    if (o.pitch !== undefined) this.orbit.pitch = o.pitch;
    if (o.yaw !== undefined) this.orbit.yaw = o.yaw;
    this.autoDrift = 0;
    this.applyOrbit();
  }

  dispose(): void {
    this.web?.dispose();
    this.web = null;
  }
}

function formatAge(years: number): string {
  if (years < 1e6) return `${Math.round(years / 1e3)} kyr`;
  if (years < 1e9) return `${(years / 1e6).toFixed(0)} Myr`;
  return `${(years / 1e9).toFixed(2)} Gyr`;
}
