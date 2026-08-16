/**
 * SURFACE — one world, from high orbit to a footprint in the sand.
 *
 * This realm owns a single planet and everything living on it. It deliberately
 * spans orbit *and* ground rather than splitting them, because the descent is
 * the best thing in this kind of game and a loading screen in the middle of it
 * would be a crime. The terrain quadtree, the atmosphere and the ocean are the
 * same objects at 400 km and at 4 m; only the camera and the control scheme
 * change, and they cross-fade.
 *
 * Coordinates are planet-local metres with the planet centre at the origin.
 * Everything the player can touch sits within a few thousand metres of the
 * floating origin, so Float32 never has to represent a planetary radius.
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  MathUtils,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import type { Realm, RealmContext } from '../core/Realm';
import { FlyCamera } from './FlyCamera';
import { orbitalPosition } from './Orbits';
import { Planet } from '../planet/Planet';
import { ScatterSystem } from '../surface/ScatterSystem';
import { Wildlife } from '../surface/Wildlife';
import { Weather } from '../surface/Weather';
import { Civilization } from '../civ/Civilization';
import { Player } from '../entities/Player';
import { Rover } from '../entities/Rover';
import type {
  CollisionProvider,
  HudTarget,
  ICivilization,
  IPlanet,
  IScatterSystem,
  IVehicle,
  IWeather,
  IWildlife,
  SystemContext,
} from '../api/Contracts';
import type { PlanetSpec, StarSystemSpec } from '../universe/Types';

type Mode = 'orbit' | 'ground';

export interface PlanetViewOptions {
  mode?: 'orbit' | 'limb' | 'vista' | 'ground' | 'city' | 'night' | 'ocean';
}

export class SurfaceRealm implements Realm {
  readonly id = 'surface' as const;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(68, 1, 0.1, 1e10);

  private fly = new FlyCamera(68, 0.1, 1e10);
  private planet: IPlanet | null = null;
  private scatter: IScatterSystem | null = null;
  private wildlife: IWildlife | null = null;
  private weather: IWeather | null = null;
  private civ: ICivilization | null = null;
  private player: Player | null = null;
  private rover: IVehicle | null = null;

  private spec: PlanetSpec | null = null;
  private system: StarSystemSpec | null = null;
  private mode: Mode = 'orbit';
  private simTime = 0;
  private timeInRealm = 0;
  private aspect = 1;

  private sun = new DirectionalLight(0xffffff, 3.0);
  private ambient = new AmbientLight(0x101828, 0.6);
  /** Direction from the planet centre toward the star, planet-local. */
  private sunDir = new Vector3(1, 0, 0);
  private sunColor: [number, number, number] = [1, 1, 1];
  private landingDir = new Vector3(0, 1, 0);
  private titleShown = false;

  constructor() {
    this.scene.background = new Color(0x000000);
    this.scene.add(this.ambient);
    this.sun.castShadow = true;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
  }

  async enter(ctx: RealmContext, payload?: any): Promise<void> {
    const universe = ctx.services.universe;
    const system: StarSystemSpec = payload?.system ?? universe.findHomeSystem();
    const spec: PlanetSpec =
      payload?.planet ??
      system.planets.find((p) => p.klass === 'terran') ??
      system.planets.find((p) => p.notable) ??
      system.planets[0];

    if (!spec) throw new Error('No planet to land on');

    this.simTime = payload?.simTime ?? 0;
    this.timeInRealm = 0;
    this.titleShown = false;
    this.system = system;

    if (this.spec?.seed !== spec.seed) {
      await this.buildWorld(spec, ctx);
    }
    this.spec = spec;

    const approach = payload?.approachDir
      ? new Vector3(...(payload.approachDir as number[])).normalize()
      : new Vector3(0.4, 0.35, 0.85).normalize();
    this.landingDir.copy(approach);

    this.mode = 'orbit';
    this.fly.position.copy(approach).multiplyScalar(spec.radiusM * 3.0);
    this.fly.velocity.set(0, 0, 0);
    this.fly.baseSpeed = spec.radiusM * 0.08;
    this.fly.minDistanceTo = { center: new Vector3(0, 0, 0), radius: spec.radiusM + spec.terrain.maxElevationM + 40 };
    this.fly.lookAt(new Vector3(0, 0, 0));

    this.updateSun();

    const hud = ctx.services.hud;
    hud?.setContext('orbit');
    hud?.setLocation(spec.name, describe(spec));
    ctx.services.audio?.setMood('arrival', 0.7);
  }

  private async buildWorld(spec: PlanetSpec, ctx: RealmContext): Promise<void> {
    this.teardown();

    this.planet = new Planet(spec);
    this.planet.setQuality(ctx.quality);
    this.scene.add(this.planet.root);

    const collision: CollisionProvider = {
      heightAt: (d) => this.planet!.heightAt(d),
      resolve: (p, r, h) => {
        const a = this.civ?.collideCapsule(p, r, h) ?? null;
        if (a) return a;
        return this.scatter?.collideCapsule(p, r, h) ?? null;
      },
      seaLevelRadius: () => this.planet!.seaLevelRadius(),
      radius: spec.radiusM,
      gravity: spec.gravity,
    };

    // Surface systems only exist on worlds you can stand on. A gas giant gets
    // the atmosphere and the clouds and nothing else, which is correct.
    const landable = spec.klass !== 'gas-giant' && spec.klass !== 'ice-giant';
    if (landable) {
      this.scatter = new ScatterSystem();
      this.scatter.attach(this.planet);
      this.scatter.setQuality(ctx.quality);
      this.scene.add(this.scatter.root);

      if (spec.life === 'fauna' || spec.life === 'sapient') {
        this.wildlife = new Wildlife();
        this.wildlife.attach(this.planet);
        this.wildlife.setQuality(ctx.quality);
        this.scene.add(this.wildlife.root);
      }

      if (spec.civilization.present) {
        this.civ = new Civilization();
        this.civ.attach(this.planet);
        this.civ.setQuality(ctx.quality);
        this.scene.add(this.civ.root);
      }

      this.player = new Player();
      this.player.attach(collision);
      this.scene.add(this.player.root);

      this.rover = new Rover();
      this.rover.attach(collision);
      this.scene.add(this.rover.root);
    }

    if (spec.atmosphere.present) {
      this.weather = new Weather();
      this.weather.attach(this.planet);
      this.weather.setQuality(ctx.quality);
      this.scene.add(this.weather.root);
    }
  }

  update(dt: number, ctx: RealmContext): void {
    if (!this.planet || !this.spec) return;
    this.timeInRealm += dt;
    this.simTime += dt;
    const input = ctx.input;

    this.updateSun();

    const sysCtx: SystemContext = {
      renderer: ctx.renderer,
      scene: this.scene,
      camera: this.camera,
      input,
      quality: ctx.quality,
      time: ctx.time,
      simTime: this.simTime,
      services: ctx.services,
    };

    /* ---- mode transitions ---- */
    const camLocal = this.mode === 'ground' && this.player ? this.player.state.position : this.fly.position;
    const altitude = camLocal.length() - this.spec.radiusM - this.planet.heightAt(_dir.copy(camLocal).normalize());

    if (this.mode === 'orbit') {
      this.fly.update(dt, input);
      // Speed scales with altitude: a gentle hover close in, a fast cruise
      // out at three radii, with no gear change to think about.
      this.fly.baseSpeed = MathUtils.clamp(Math.abs(altitude) * 0.35, 12, this.spec.radiusM * 0.5);
      this.camera.position.copy(this.fly.position);
      this.camera.quaternion.copy(this.fly.orientation);
      this.camera.fov = this.fly.camera.fov;
      this.camera.updateProjectionMatrix();

      // Landing: hold the descent low enough and the player takes over on foot.
      const canLand = this.player && altitude < 220;
      if (canLand && (input.pressed('interact') || input.pressed('enter') || altitude < 25)) {
        this.land(ctx);
      }
      ctx.services.hud?.setVitals({ speed: this.fly.velocity.length(), altitude });
    } else if (this.player) {
      this.player.update(dt, sysCtx);
      this.rover?.update(dt, sysCtx);
      const pc = this.player.camera;
      this.camera.position.copy(pc.position);
      this.camera.quaternion.copy(pc.quaternion);
      this.camera.fov = pc.fov;
      this.camera.updateProjectionMatrix();

      if (input.pressed('warp')) this.takeOff(ctx);
      ctx.services.hud?.setVitals({
        speed: this.player.state.speed,
        altitude,
        fuel: this.player.state.fuel,
        temperature: this.weather?.state().temperature,
      });
    }

    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();

    /* ---- world systems ---- */
    this.planet.setViewer(this.camera.position);
    this.planet.setSun(this.sunDir, this.sunColor, sunIntensity(this.spec, this.system));
    this.planet.update(dt, sysCtx);

    if (this.scatter) {
      this.scatter.setViewer(this.camera.position);
      const w = this.weather?.state().wind ?? _wind.set(1, 0, 0).multiplyScalar(this.spec.atmosphere.windSpeed);
      this.scatter.setWind(w);
      this.scatter.update(dt, sysCtx);
    }
    if (this.wildlife) {
      this.wildlife.setViewer(this.camera.position);
      this.wildlife.update(dt, sysCtx);
    }
    if (this.civ) {
      this.civ.setViewer(this.camera.position);
      this.civ.update(dt, sysCtx);
    }
    if (this.weather) {
      this.weather.setViewer(this.camera.position);
      this.weather.update(dt, sysCtx);
    }

    this.updateHud(ctx, altitude);

    if (input.pressed('map')) ctx.engine.goto('system', { system: this.system, timeAccel: 1 }, 1.8);
  }

  /** Put the player on the ground beneath the camera and switch control. */
  private land(ctx: RealmContext): void {
    if (!this.player || !this.spec) return;
    const dir = _dir.copy(this.fly.position).normalize();
    this.landingDir.copy(dir);
    this.player.spawnAt(dir);
    this.rover?.placeAt(dir);
    this.mode = 'ground';
    ctx.services.hud?.setContext('foot');
    ctx.services.audio?.setMood('wonder', 0.5);
    ctx.services.audio?.play('landing_gear');
    if (!this.titleShown) {
      this.titleShown = true;
      ctx.services.hud?.titleCard(this.spec.name, describe(this.spec));
    }
  }

  private takeOff(ctx: RealmContext): void {
    if (!this.spec) return;
    const p = this.player?.state.position ?? this.fly.position;
    this.fly.position.copy(p).normalize().multiplyScalar(this.spec.radiusM + 3000);
    this.fly.velocity.set(0, 0, 0);
    this.fly.lookAt(new Vector3(0, 0, 0));
    this.mode = 'orbit';
    ctx.services.hud?.setContext('orbit');
    ctx.services.audio?.play('engine_start');
  }

  /**
   * The star's direction in planet-local space, accounting for the planet's
   * position on its orbit and its axial tilt. This is what gives the world a
   * real day/night cycle and real seasons rather than a light on a timer.
   */
  private updateSun(): void {
    if (!this.spec || !this.system) return;
    orbitalPosition(this.spec.orbit, this.simTime, _sunPos);
    // Toward the star, which sits at the system origin.
    this.sunDir.copy(_sunPos).multiplyScalar(-1).normalize();

    // Axial tilt: rotate the sun direction into the planet's own frame.
    const tilt = this.spec.axialTiltRad;
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    const y = this.sunDir.y * ct - this.sunDir.z * st;
    const z = this.sunDir.y * st + this.sunDir.z * ct;
    this.sunDir.y = y;
    this.sunDir.z = z;

    // The planet's own rotation carries the terminator around.
    const spin = this.spec.rotationPhase + (this.simTime / this.spec.rotationS) * Math.PI * 2;
    const cs = Math.cos(spin);
    const ss = Math.sin(spin);
    const x = this.sunDir.x * cs - this.sunDir.z * ss;
    const z2 = this.sunDir.x * ss + this.sunDir.z * cs;
    this.sunDir.x = x;
    this.sunDir.z = z2;
    this.sunDir.normalize();

    const st0 = this.system.stars[0];
    this.sunColor = st0.color;
    const intensity = sunIntensity(this.spec, this.system);

    // Place the shadow-casting light relative to the camera so the cascade
    // covers what the player can actually see rather than the whole planet.
    const anchor = this.camera.position;
    this.sun.position.copy(anchor).addScaledVector(this.sunDir, 4000);
    this.sun.target.position.copy(anchor);
    this.sun.color.setRGB(st0.color[0], st0.color[1], st0.color[2]);
    this.sun.intensity = intensity * 3.0;

    // Ambient stands in for sky bounce: blue and strong under a thick
    // atmosphere, almost nothing on an airless rock.
    const a = this.spec.atmosphere;
    const air = a.present ? Math.min(1.4, a.surfacePressurePa / 101325) : 0;
    this.ambient.color.setRGB(
      0.08 + a.tint[0] * 0.35 * air,
      0.10 + a.tint[1] * 0.40 * air,
      0.16 + a.tint[2] * 0.55 * air
    );
    this.ambient.intensity = 0.15 + air * 0.85;
  }

  private updateHud(ctx: RealmContext, altitude: number): void {
    const hud = ctx.services.hud;
    if (!hud || !this.spec) return;

    const targets: HudTarget[] = [];
    if (this.civ) {
      for (const s of this.civ.settlements()) {
        const world = _tmp.copy(s.direction).multiplyScalar(this.spec.radiusM + this.planet!.heightAt(s.direction));
        const d = world.distanceTo(this.camera.position);
        if (d < 400000) {
          targets.push({
            position: world,
            label: s.name,
            sub: s.kind,
            kind: 'settlement',
            distance: d,
            important: s.kind === 'megacity' || s.kind === 'city',
          });
        }
      }
    }
    hud.setTargets(targets);

    const w = this.weather?.state();
    const localName = this.civ?.nearest(_dir.copy(this.camera.position).normalize())?.name;
    const sub =
      this.mode === 'ground'
        ? `${localName ? `${localName} · ` : ''}${w ? describeWeather(w) : describe(this.spec)}`
        : `${describe(this.spec)} · ${formatAltitude(altitude)}`;
    hud.setLocation(this.spec.name, sub);
  }

  resize(w: number, h: number): void {
    this.aspect = w / h;
    this.fly.setAspect(this.aspect);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  setQuality(q: any): void {
    this.planet?.setQuality(q);
    this.scatter?.setQuality(q);
    this.wildlife?.setQuality(q);
    this.weather?.setQuality(q);
    this.civ?.setQuality(q);
  }

  locationLabel(): string {
    return this.spec?.name ?? 'Unknown world';
  }

  /** Harness hook: pose the camera for a specific screenshot. */
  async debugView(o: PlanetViewOptions = {}): Promise<void> {
    if (!this.spec || !this.planet) return;
    const mode = o.mode ?? 'orbit';
    const R = this.spec.radiusM;

    if (mode === 'orbit' || mode === 'limb') {
      this.mode = 'orbit';
      const d = mode === 'limb' ? R * 1.35 : R * 2.6;
      this.fly.position.set(0.55, 0.30, 0.78).normalize().multiplyScalar(d);
      // Frame the terminator: look slightly off-centre so the lit crescent
      // and the atmospheric limb are both in shot.
      const aim = mode === 'limb' ? new Vector3(0, 0, 0) : new Vector3(R * 0.15, 0, 0);
      this.fly.lookAt(aim);
      this.camera.position.copy(this.fly.position);
      this.camera.quaternion.copy(this.fly.orientation);
      return;
    }

    // Ground shots: pick a direction that suits the subject, force the terrain
    // to stream in, then stand the player on it.
    const dir = await this.pickGroundSpot(mode);
    await this.planet.ensureDetail(dir, 2500);
    if (this.player) {
      this.player.spawnAt(dir, 0.6);
      this.player.setView(mode === 'ground' ? 'first' : 'third');
      this.mode = 'ground';
      this.rover?.placeAt(dir);
    } else {
      this.mode = 'orbit';
      const h = this.planet.heightAt(dir);
      this.fly.position.copy(dir).multiplyScalar(R + h + 120);
      this.fly.lookAt(new Vector3(0, 0, 0).addScaledVector(dir, R + h).add(new Vector3(300, 0, 300)));
    }

    // Put the sun where it flatters the subject.
    if (mode === 'night') this.simTime += this.spec.rotationS * 0.5;
    else if (mode === 'city' || mode === 'ocean') this.simTime += this.spec.rotationS * 0.04;
  }

  private async pickGroundSpot(mode: string): Promise<Vector3> {
    const R = this.spec!.radiusM;
    if (mode === 'city' && this.civ) {
      const s = this.civ.settlements();
      if (s.length) {
        const best = s.reduce((a, b) => (b.population > a.population ? b : a));
        // Stand outside the city looking in, so the skyline reads.
        const d = best.direction.clone();
        const tangent = new Vector3(0, 1, 0).cross(d).normalize();
        return d.addScaledVector(tangent, (best.radius * 1.9) / R).normalize();
      }
    }
    // Search for a spot that suits the shot: a coastline for 'ocean', high
    // relief for 'vista', anything solid otherwise.
    let best = new Vector3(0.3, 0.5, 0.8).normalize();
    let bestScore = -Infinity;
    const sea = this.planet!.seaLevelRadius();
    for (let i = 0; i < 900; i++) {
      const t = i * 2.399963; // golden-angle spiral: even coverage of a sphere
      const y = 1 - (i / 899) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const d = new Vector3(Math.cos(t) * r, y, Math.sin(t) * r);
      const h = this.planet!.heightAt(d);
      const alt = R + h - sea;
      let score = 0;
      if (mode === 'ocean') score = -Math.abs(alt - 8) + Math.abs(y) * -400;
      else if (mode === 'vista') score = alt * 0.6 - Math.abs(y) * 3000;
      else if (mode === 'night') score = alt > 0 ? 1000 - Math.abs(y) * 2000 : -1e9;
      else score = alt > 2 ? alt * 0.2 - Math.abs(y) * 1200 : -1e9;
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    return best;
  }

  private teardown(): void {
    for (const s of [this.scatter, this.wildlife, this.weather, this.civ]) {
      if (!s) continue;
      this.scene.remove(s.root);
      s.dispose();
    }
    this.scatter = null;
    this.wildlife = null;
    this.weather = null;
    this.civ = null;
    if (this.player) {
      this.scene.remove(this.player.root);
      this.player.dispose();
      this.player = null;
    }
    if (this.rover) {
      this.scene.remove(this.rover.root);
      this.rover.dispose();
      this.rover = null;
    }
    if (this.planet) {
      this.scene.remove(this.planet.root);
      this.planet.dispose();
      this.planet = null;
    }
  }

  dispose(): void {
    this.teardown();
  }
}

const _dir = new Vector3();
const _tmp = new Vector3();
const _wind = new Vector3();
const _sunPos = new Vector3();

/** Insolation relative to Earth, gently compressed so nothing blows out. */
function sunIntensity(p: PlanetSpec, s: StarSystemSpec | null): number {
  if (!s) return 1;
  const flux = s.stars[0].luminosityW / (4 * Math.PI * p.orbit.a * p.orbit.a);
  return MathUtils.clamp(Math.pow(flux / 1361, 0.42), 0.12, 3.2);
}

function describe(p: PlanetSpec): string {
  const bits: string[] = [p.klass.replace('-', ' ')];
  bits.push(`${(p.gravity / 9.81).toFixed(2)}g`);
  if (p.atmosphere.present) bits.push(`${(p.atmosphere.surfacePressurePa / 1000).toFixed(0)} kPa`);
  else bits.push('no atmosphere');
  bits.push(`${(p.tempK - 273.15).toFixed(0)}°C`);
  return bits.join(' · ');
}

function describeWeather(w: { precipitationType: string; cloudiness: number; storm: number; aurora: number }): string {
  if (w.storm > 0.5) return 'electrical storm';
  if (w.precipitationType !== 'none') return w.precipitationType;
  if (w.aurora > 0.4) return 'aurora';
  if (w.cloudiness > 0.7) return 'overcast';
  if (w.cloudiness > 0.35) return 'scattered cloud';
  return 'clear';
}

function formatAltitude(m: number): string {
  if (m > 1e6) return `${(m / 1e6).toFixed(1)} Mm`;
  if (m > 1000) return `${(m / 1000).toFixed(1)} km`;
  return `${m.toFixed(0)} m`;
}
