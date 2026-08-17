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
  Quaternion,
  Scene,
  Vector3,
} from 'three';
import type { Realm, RealmContext } from '../core/Realm';
import { FlyCamera } from './FlyCamera';
import { orbitalPosition } from './Orbits';
import { Planet } from '../planet/Planet';
import { Skybox } from '../galaxy/Skybox';
import { ScatterSystem } from '../surface/ScatterSystem';
import { Wildlife } from '../surface/Wildlife';
import { Weather } from '../surface/Weather';
import { Civilization } from '../civ/Civilization';
import { Player } from '../entities/Player';
import { Rover } from '../entities/Rover';
import { Starship } from '../entities/Starship';
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
import { makeGalaxy } from '../universe/Universe';
import { hashCombine } from '../core/Rand';
import type { QualityProfile } from '../core/Settings';
import type { PlanetSpec, StarSystemSpec } from '../universe/Types';

/**
 * Where the player is.
 *
 *   ship   — flying, from four radii out down to a landing on the gear
 *   ground — on foot, or riding the rover
 *   orbit  — the free camera. Gameplay never enters it; it exists for worlds
 *            with no surface to stand on, and for the screenshot harness.
 */
type Mode = 'ship' | 'ground' | 'orbit';

export interface PlanetViewOptions {
  mode?: 'orbit' | 'limb' | 'vista' | 'ground' | 'city' | 'night' | 'ocean';
  /** How long to wait for terrain to stream in before posing anyway, ms. */
  detailTimeoutMs?: number;
}

/** How close you have to be to a vehicle before you can get into it. */
const BOARD_RANGE = 9;

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
  private ship: Starship | null = null;
  private sky = new Skybox();

  private spec: PlanetSpec | null = null;
  private system: StarSystemSpec | null = null;
  private mode: Mode = 'orbit';
  private simTime = 0;
  private timeInRealm = 0;
  private aspect = 1;
  /** Set while the warp drive is spooling, so we only leave the realm once. */
  private departing = false;
  private shipCamPos = new Vector3();
  private shipCamQuat = new Quaternion();
  private shipView: 'first' | 'third' = 'third';

  private sun = new DirectionalLight(0xffffff, 3.0);
  private ambient = new AmbientLight(0x101828, 0.6);
  /** Direction from the planet centre toward the star, planet-local. */
  private sunDir = new Vector3(1, 0, 0);
  private sunColor: [number, number, number] = [1, 1, 1];
  private landingDir = new Vector3(0, 1, 0);
  private titleShown = false;
  private hudRef: any = null;
  private quality: QualityProfile | null = null;
  /** Non-zero when an offline consumer has asked terrain to stream flat out. */
  private streamBudget = 0;
  /** Settlement the next ground shot should face, if any. */
  private lookAtSite: Vector3 | null = null;

  constructor() {
    this.scene.background = new Color(0x000000);
    this.scene.add(this.sky.root);
    this.scene.add(this.ambient);
    // Configured in updateSun once we know where the player is standing.
    this.sun.castShadow = false;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
  }

  async enter(ctx: RealmContext, payload?: any): Promise<void> {
    const universe = ctx.services.universe;
    const system: StarSystemSpec = payload?.system ?? universe.findHomeSystem();
    // Prefer somewhere landable: a gas or ice giant has no surface, so
    // defaulting to one makes every surface view an empty sky.
    const landable = (p: PlanetSpec) => p.klass !== 'gas-giant' && p.klass !== 'ice-giant';
    const pickFrom = (sys: StarSystemSpec): PlanetSpec | undefined =>
      sys.planets.find((p) => p.klass === 'terran') ??
      sys.planets.find((p) => landable(p) && p.notable) ??
      sys.planets.find(landable);

    let chosen = payload?.planet as PlanetSpec | undefined;
    let host = system;
    if (!chosen) {
      chosen = pickFrom(system);
      if (!chosen) {
        // Some systems are all gas. Rather than drop the player onto a world
        // with no surface, look outward until we find one worth standing on.
        const near = universe.systemsNear(
          system.position[0], system.position[1], system.position[2], 260, 240
        ) as StarSystemSpec[];
        // Rank by how good a world the system offers, not by whether the
        // system is flagged interesting: the first landable rock in the list
        // was beating a temperate ocean world four light years further out.
        let bestScore = -1;
        for (const s of near) {
          const c = pickFrom(s);
          if (!c) continue;
          const score = worldScore(c);
          if (score > bestScore) {
            bestScore = score;
            chosen = c;
            host = s;
            if (score >= 100) break; // a terran world; nothing beats it
          }
        }
      }
    }
    const spec: PlanetSpec = chosen ?? system.planets[0];

    if (!spec) throw new Error('No planet to land on');

    this.simTime = payload?.simTime ?? 0;
    this.timeInRealm = 0;
    this.titleShown = false;
    this.system = host;

    if (this.spec?.seed !== spec.seed) {
      await this.buildWorld(spec, ctx);
    }
    this.spec = spec;

    const approach = payload?.approachDir
      ? new Vector3(...(payload.approachDir as number[])).normalize()
      : new Vector3(0.4, 0.35, 0.85).normalize();
    this.landingDir.copy(approach);

    this.departing = false;
    this.fly.position.copy(approach).multiplyScalar(spec.radiusM * 3.0);
    this.fly.velocity.set(0, 0, 0);
    this.fly.baseSpeed = spec.radiusM * 0.08;
    this.fly.minDistanceTo = { center: new Vector3(0, 0, 0), radius: spec.radiusM + spec.terrain.maxElevationM + 40 };
    this.fly.lookAt(new Vector3(0, 0, 0));

    if (this.ship) {
      // Arrive under way, nose down toward the world, high enough that the
      // atmosphere is still a line on the horizon rather than a wall.
      this.mode = 'ship';
      this.ship.position.copy(approach).multiplyScalar(spec.radiusM + Math.max(90000, spec.atmosphere.thicknessM * 1.6));
      this.ship.velocity.copy(approach).multiplyScalar(-260);
      this.ship.setAtmosphere(spec.atmosphere.thicknessM, spec.atmosphere.present);
      this.ship.setDriver(true);
      this.ship.enterFlight();
      this.ship.faceToward(new Vector3(0, 0, 0));
      this.player?.board(null);
    } else {
      this.mode = 'orbit';
    }

    this.updateSun();

    // The deep sky is the host galaxy seen from inside, using the same seed the
    // galaxy realm uses, so flying down from the map does not change the sky.
    this.sky.build(
      makeGalaxy(hashCombine(universe.seed, 0x1a7), [0, 0, 0], 'barred-spiral'),
      host.position as [number, number, number]
    );
    this.sky.setQuality(ctx.quality);

    const hud = ctx.services.hud;
    this.hudRef = hud ?? null;
    hud?.setContext('orbit');
    hud?.setLocation(spec.name, describe(spec));
    ctx.services.audio?.setMood('arrival', 0.7);
  }

  private async buildWorld(spec: PlanetSpec, ctx: RealmContext): Promise<void> {
    this.teardown();

    this.planet = new Planet(spec);
    this.planet.setQuality(ctx.quality);
    if (this.streamBudget > 0) (this.planet as any).setBuildBudget?.(this.streamBudget);
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

      this.rover = new Rover(hashCombine(spec.seed, 0x0e7));
      this.rover.attach(collision);
      this.scene.add(this.rover.root);

      // One ship per world, seeded from it — so the hull you fly is a constant
      // across a session but every save has its own.
      this.ship = new Starship(hashCombine(spec.seed, 0x5417));
      this.ship.attach(collision);
      this.ship.setAtmosphere(spec.atmosphere.thicknessM, spec.atmosphere.present);
      this.scene.add(this.ship.root);
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
    const camLocal =
      this.mode === 'ground' && this.player ? this.player.state.position
      : this.mode === 'ship' && this.ship ? this.ship.position
      : this.fly.position;
    const altitude = camLocal.length() - this.spec.radiusM - this.planet.heightAt(_dir.copy(camLocal).normalize());

    if (this.mode === 'ship' && this.ship) {
      this.updateShip(dt, ctx, sysCtx, altitude);
    } else if (this.mode === 'orbit') {
      this.fly.update(dt, input);
      // Speed scales with altitude: a gentle hover close in, a fast cruise
      // out at three radii, with no gear change to think about.
      this.fly.baseSpeed = MathUtils.clamp(Math.abs(altitude) * 0.35, 12, this.spec.radiusM * 0.5);
      this.camera.position.copy(this.fly.position);
      this.camera.quaternion.copy(this.fly.orientation);
      this.camera.fov = this.fly.camera.fov;
      this.camera.updateProjectionMatrix();
      ctx.services.hud?.setVitals({ speed: this.fly.velocity.length(), altitude });
    } else if (this.player) {
      this.updateOnFoot(dt, ctx, sysCtx, altitude);
    }

    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();

    /* ---- world systems ---- */
    this.planet.setViewer(this.camera.position);
    this.planet.setSun(this.sunDir, this.sunColor, this.sun.intensity);
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
      // The orbital cloud deck and the ground-level weather are the same
      // system seen from two distances; keep them agreeing.
      this.planet.setWeather(this.weather.state().cloudiness);
    }

    /* ---- deep sky ---- */
    this.sky.update(dt, sysCtx);
    if (this.system) {
      const st = this.system.stars[0];
      // Angular radius of the star from this orbit — half a degree from Earth,
      // and genuinely enormous from a close-orbiting world.
      this.sky.setSun(this.sunDir, this.sunColor, this.sun.intensity, st.radiusM / Math.max(1, this.spec.orbit.a));
    }
    // Stars wash out under a lit sky and come back at dusk, and they are always
    // there once you climb above most of the air.
    const air = this.spec.atmosphere;
    const aboveAir = air.present
      ? MathUtils.clamp((altitude - air.thicknessM * 0.3) / Math.max(1, air.thicknessM * 0.5), 0, 1)
      : 1;
    const se = this.sunDir.dot(_dir.copy(this.camera.position).normalize());
    this.sky.setOpacity(Math.max(aboveAir, MathUtils.clamp((0.05 - se) / 0.17, 0, 1)));

    this.updateHud(ctx, altitude);
    this.updateAmbience(ctx, altitude);

    if (input.pressed('map')) ctx.engine.goto('system', { system: this.system, timeAccel: 1 }, 1.8);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Flying
     ═══════════════════════════════════════════════════════════════════════ */

  private updateShip(dt: number, ctx: RealmContext, sysCtx: SystemContext, altitude: number): void {
    const ship = this.ship!;
    const input = ctx.input;
    ship.update(dt, sysCtx);

    ship.cameraPose(dt, this.shipCamPos, this.shipCamQuat, this.shipView);
    this.camera.position.copy(this.shipCamPos);
    this.camera.quaternion.copy(this.shipCamQuat);
    this.camera.fov = 62 + ship.fovBoost();
    this.camera.updateProjectionMatrix();

    if (input.pressed('toggleView')) this.shipView = this.shipView === 'third' ? 'first' : 'third';

    const hud = ctx.services.hud;
    hud?.setContext(altitude > 6000 ? 'space' : 'vehicle');
    hud?.setVitals({
      speed: ship.speed(),
      altitude,
      integrity: ship.integrity(),
      temperature: this.weather?.state().temperature,
    });

    /* ---- disembark ---- */
    if (ship.isLanded()) {
      if (!this.titleShown && this.spec) {
        this.titleShown = true;
        ctx.services.audio?.setMood('wonder', 0.5);
        ctx.services.hud?.titleCard(this.spec.name, describe(this.spec));
      }
      hud?.setPrompt('step outside');
      if (input.pressed('interact') || input.pressed('enter')) this.disembark(ctx);
    } else if (altitude < 400 && ship.speed() < 45) {
      hud?.setPrompt('gear down — descend to set down', 'S');
    } else {
      hud?.setPrompt(null);
    }

    /* ---- leaving the world ---- */
    const af = ship.altitudeFactor();
    if (input.pressed('warp') && this.system) {
      if (af > 0.85) ship.warpTo(this.system);
      else hud?.toast('Too deep in the well — climb clear of the atmosphere', 2.6);
    }
    const charge = ship.warpProgress();
    if (charge > 0.001) {
      hud?.setPrompt(`warp drive ${(charge * 100).toFixed(0)}%`, 'J');
      hud?.setVeil(charge * 0.35);
      if (charge < 0.06) ctx.services.audio?.play('warp_charge');
    }
    if (ship.isWarping() && !this.departing) {
      this.departing = true;
      ctx.services.audio?.play('warp_jump');
      ctx.engine.goto('system', { system: this.system, simTime: this.simTime, fromPlanet: this.spec }, 2.0);
    }
    // Climbing out without the drive still gets you back to the system view.
    if (!this.departing && this.timeInRealm > 3 && altitude > this.spec!.radiusM * 3.4 && this.system) {
      this.departing = true;
      ctx.engine.goto('system', { system: this.system, simTime: this.simTime, fromPlanet: this.spec }, 1.8);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     On foot
     ═══════════════════════════════════════════════════════════════════════ */

  private updateOnFoot(dt: number, ctx: RealmContext, sysCtx: SystemContext, altitude: number): void {
    const player = this.player!;
    const input = ctx.input;
    player.update(dt, sysCtx);
    this.rover?.update(dt, sysCtx);
    // The ship still simulates while you are out of it: its legs settle onto
    // terrain that streams in after you have already walked away from it.
    this.ship?.update(dt, sysCtx);

    const pc = player.camera;
    this.camera.position.copy(pc.position);
    this.camera.quaternion.copy(pc.quaternion);
    this.camera.fov = pc.fov;
    this.camera.updateProjectionMatrix();

    const hud = ctx.services.hud;
    const riding = player.state.vehicle;

    /* ---- boarding ---- */
    if (riding) {
      hud?.setContext('vehicle');
      hud?.setVitals({
        speed: riding.speed(),
        altitude,
        integrity: riding.integrity(),
        temperature: this.weather?.state().temperature,
      });
      hud?.setPrompt('get out');
      if (input.pressed('interact')) {
        player.board(null);
        // Step out beside the vehicle rather than inside it.
        const up = _dir.copy(riding.position).normalize();
        const side = _tmp.set(1, 0, 0).applyQuaternion(riding.root.quaternion).multiplyScalar(3.2);
        player.state.position.copy(riding.position).add(side).addScaledVector(up, 0.5);
        ctx.services.audio?.play('landing_gear');
      }
      return;
    }

    hud?.setContext('foot');
    hud?.setVitals({
      speed: player.state.speed,
      altitude,
      fuel: player.state.fuel,
      temperature: this.weather?.state().temperature,
    });

    const p = player.state.position;
    const nearRover = this.rover && p.distanceTo(this.rover.position) < BOARD_RANGE;
    const nearShip = this.ship && p.distanceTo(this.ship.position) < BOARD_RANGE + 6;

    if (nearShip) {
      hud?.setPrompt('board the ship');
      if (input.pressed('interact')) this.boardShip(ctx);
    } else if (nearRover) {
      hud?.setPrompt('drive');
      if (input.pressed('interact')) {
        player.board(this.rover);
        ctx.services.audio?.play('engine_start');
      }
    } else if (this.ship) {
      hud?.setPrompt('call the ship', 'J');
      // J calls the ship down to you from anywhere: walking home across four
      // kilometres of tundra is not the fantasy.
      if (input.pressed('warp')) {
        this.ship.requestLanding(_dir.copy(p).normalize());
        if (this.ship.isLanded()) this.ship.requestTakeoff();
        hud?.toast('Ship inbound', 2.4);
      }
    } else {
      hud?.setPrompt(null);
    }
  }

  /** Climb in, and take the ship off the ground if it is sitting on it. */
  private boardShip(ctx: RealmContext): void {
    if (!this.ship || !this.player) return;
    this.mode = 'ship';
    this.player.board(null);
    this.ship.setDriver(true);
    this.shipView = 'third';
    ctx.services.hud?.setContext('vehicle');
    ctx.services.audio?.play('engine_start');
    ctx.services.audio?.setMood('drift', 0.5);
  }

  /** Put the player on the ground beside the ship and hand over control. */
  private disembark(ctx: RealmContext): void {
    if (!this.player || !this.spec || !this.ship) return;
    // Step out to one side of the hull, then put the feet back on the ground:
    // the offset is a chord across the sphere and would otherwise leave the
    // player standing seven metres above or below the terrain.
    const side = _tmp.set(1, 0, 0).applyQuaternion(this.ship.root.quaternion).multiplyScalar(7);
    const dir = _dir.copy(this.ship.position).add(side).normalize();
    this.landingDir.copy(dir);
    this.player.spawnAt(dir, Math.atan2(side.z, side.x));

    // The rover comes down with the ship, parked a little further out.
    if (this.rover && this.rover.position.distanceTo(this.ship.position) > 3000) {
      this.rover.placeAt(
        _tmp2.copy(this.ship.position).addScaledVector(side, 2.4).normalize(),
        0.8
      );
    }
    this.ship.setDriver(false);
    this.mode = 'ground';
    ctx.services.hud?.setContext('foot');
    ctx.services.audio?.setMood('wonder', 0.5);
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

    // One tight shadow cascade, parked on the camera.
    //
    // A DirectionalLight's default shadow camera is a ten-metre box; on a world
    // 11,000 km across every fragment lands outside it and samples as fully
    // shadowed, which renders the whole planet black — which is why this was
    // switched off. The fix is not a bigger box (a planet-wide one has no
    // usable depth precision) but a small one that follows the player. Beyond
    // its range the terrain still shades itself by its own normal, and at that
    // distance aerial perspective has washed the contrast out anyway.
    const anchor = this.camera.position;
    const wantShadow = !!this.quality?.shadows && this.mode === 'ground';
    this.sun.castShadow = wantShadow;
    if (wantShadow) {
      const S = SHADOW_SPAN;
      const sc = this.sun.shadow.camera;
      sc.left = -S; sc.right = S; sc.top = S; sc.bottom = -S;
      sc.near = S * 0.25; sc.far = S * 4.5;
      sc.updateProjectionMatrix();
      // Snap the light to the texel grid, or the shadow crawls and shimmers
      // over the ground every time the player takes a step.
      const texel = (2 * S) / this.sun.shadow.mapSize.x;
      const q = (v: number) => Math.round(v / texel) * texel;
      _tmp.set(q(anchor.x), q(anchor.y), q(anchor.z));
      this.sun.position.copy(_tmp).addScaledVector(this.sunDir, S * 2.2);
      this.sun.target.position.copy(_tmp);
      this.sun.shadow.bias = -0.00035;
      // In metres, because these coordinates are metres: offset the sample
      // along the normal rather than in depth, which is what actually kills
      // acne on ground this coarsely tessellated.
      this.sun.shadow.normalBias = 0.75;
    } else {
      this.sun.position.copy(anchor).addScaledVector(this.sunDir, 4000);
      this.sun.target.position.copy(anchor);
    }
    this.sun.color.setRGB(st0.color[0], st0.color[1], st0.color[2]);
    // three's Lambert BRDF divides by pi, so multiplying the irradiance by pi
    // makes a surface of albedo A return radiance A under full sun. That is the
    // normalisation the AgX curve is set up for; at 3.0 every world came out
    // two stops under and read as a night shot.
    this.sun.intensity = intensity * Math.PI * 1.35;

    // Ambient stands in for sky bounce: blue and strong under a thick
    // atmosphere, almost nothing on an airless rock — and it has to follow the
    // sun down. A directional light is not occluded by the planet it is
    // lighting, so without this the night side kept a full daylight sky term
    // and every night shot came out as blue afternoon.
    const a = this.spec.atmosphere;
    const air = a.present ? Math.min(1.4, a.surfacePressurePa / 101325) : 0;
    const se = this.sunDir.dot(_dir.copy(this.camera.position).normalize());
    // Civil twilight: the sky stays lit for a while after the sun has set,
    // because the air above you is still in sunlight.
    const day = MathUtils.clamp((se + 0.14) / 0.26, 0, 1);
    // Low sun reddens the sky bounce: the short wavelengths have already been
    // scattered out of the beam before it reaches the air overhead.
    const warm = 1 - MathUtils.clamp(se / 0.25, 0, 1);
    this.ambient.color.setRGB(
      (0.08 + a.tint[0] * 0.35 * air) * (1 + warm * 0.85),
      (0.10 + a.tint[1] * 0.40 * air) * (1 + warm * 0.18),
      (0.16 + a.tint[2] * 0.55 * air) * (1 - warm * 0.42)
    );
    // Airglow and starlight keep the night from being an absolute void.
    const nightFloor = 0.006 + air * 0.010;
    this.ambient.intensity = (0.15 + air * 0.85) * intensity * Math.PI * 0.32 * (nightFloor + (1 - nightFloor) * day);
  }

  /**
   * What the world sounds like from here.
   *
   * Four beds, cross-faded by where the player is rather than by a trigger
   * volume: vacuum above the air, wind on the surface, surf near the water,
   * and a city when you are inside one. The intensity is the mix, so walking
   * out of a city is a fade rather than a cut.
   */
  private updateAmbience(ctx: RealmContext, altitude: number): void {
    const audio = ctx.services.audio;
    if (!audio || !this.spec) return;
    const air = this.spec.atmosphere;
    // Above most of the air there is nothing to carry sound.
    const airFrac = air.present
      ? MathUtils.clamp(1 - altitude / Math.max(1, air.thicknessM * 0.55), 0, 1)
      : 0;
    if (airFrac < 0.08) {
      audio.setAmbience('vacuum', 0.55);
      return;
    }

    const dir = _dir.copy(this.camera.position).normalize();
    const near = this.civ?.nearest(dir);
    if (near && altitude < 900) {
      audio.setAmbience('city', airFrac * (near.kind === 'megacity' || near.kind === 'city' ? 0.7 : 0.4));
      return;
    }

    // Standing near the waterline: the sea is the loudest thing on any coast.
    const sea = this.planet?.seaLevelRadius() ?? 0;
    if (sea > 0 && altitude < 240) {
      const above = this.camera.position.length() - sea;
      if (above < 90) {
        audio.setAmbience('surf', airFrac * MathUtils.clamp(1 - above / 90, 0.25, 1) * 0.8);
        return;
      }
    }

    const w = this.weather?.state();
    if (w && w.precipitation > 0.25 && w.precipitationType === 'rain') {
      audio.setAmbience('rain', airFrac * w.precipitation);
      return;
    }
    const windy = w ? MathUtils.clamp(w.wind.length() / 22, 0.2, 1) : 0.4;
    audio.setAmbience(this.spec.life === 'flora' || this.spec.life === 'fauna' ? 'forest' : 'wind', airFrac * windy * 0.75);
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

  /**
   * Harness hook: let terrain, scatter and cities stream as fast as they can.
   * Trades frame rate for a finished world, which is the right trade when
   * nobody is playing and something is about to take a photograph.
   */
  setStreamBudget(msPerFrame: number): void {
    // Sticky: the harness sets this before any world exists, and every planet
    // built afterwards has to inherit it or the request quietly does nothing.
    this.streamBudget = msPerFrame;
    (this.planet as any)?.setBuildBudget?.(msPerFrame);
  }

  /** Diagnostic: what the planet stack is actually doing. */
  setPlainTerrain(v: boolean): void {
    (this.planet as any)?.setPlainTerrain?.(v);
  }

  setLayer(layer: any, v: boolean): void {
    (this.planet as any)?.setLayerVisible?.(layer, v);
  }

  debugPlanet(): any {
    return {
      hasPlanet: !!this.planet,
      mode: this.mode,
      spec: this.spec?.name,
      klass: this.spec?.klass,
      terrain: (this.planet as any)?.stats?.(),
      scatter: (this.scatter as any)?.stats?.() ?? null,
      wildlife: (this.wildlife as any)?.stats?.() ?? null,
      civ: (this.civ as any)?.stats?.() ?? null,
      weather: this.weather?.state ? summariseWeather(this.weather.state()) : null,
      player: this.player
        ? {
            alt: Math.round(this.player.state.position.length() - (this.spec?.radiusM ?? 0)),
            grounded: this.player.state.grounded,
            view: this.player.state.view,
            speed: Number(this.player.state.velocity.length().toFixed(2)),
          }
        : null,
      ship: this.ship
        ? {
            alt: Math.round(this.ship.altitude()),
            landed: this.ship.isLanded(),
            speed: Number(this.ship.speed().toFixed(1)),
            integrity: Number(this.ship.integrity().toFixed(2)),
          }
        : null,
      camDist: this.camera.position.length(),
      radius: this.spec?.radiusM,
    };
  }

  resize(w: number, h: number): void {
    this.aspect = w / h;
    this.fly.setAspect(this.aspect);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  setQuality(q: QualityProfile): void {
    this.quality = q;
    this.sun.shadow.mapSize.set(
      q.tier === 'ultra' ? 4096 : q.tier === 'high' ? 2048 : 1024,
      q.tier === 'ultra' ? 4096 : q.tier === 'high' ? 2048 : 1024
    );
    this.sun.shadow.map?.dispose();
    (this.sun.shadow as any).map = null;
    this.sky.setQuality(q);
    this.planet?.setQuality(q);
    if (this.streamBudget > 0) (this.planet as any)?.setBuildBudget?.(this.streamBudget);
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
      ctxHud(this)?.setContext('orbit');
      const d = mode === 'limb' ? R * 1.35 : R * 2.6;
      this.fly.position.set(0.55, 0.30, 0.78).normalize().multiplyScalar(d);
      // A planet lit head-on is a flat disc. Wind the clock until the star sits
      // off to one side, so the shot has a terminator, raked relief along it,
      // and a lit limb — the three things that make a world look spherical.
      this.frameSun(mode === 'limb' ? 2.15 : 1.10);
      // Look slightly off-centre so the lit crescent and the atmospheric limb
      // are both in shot.
      const aim = mode === 'limb' ? new Vector3(0, 0, 0) : new Vector3(R * 0.15, 0, 0);
      this.fly.lookAt(aim);
      this.camera.position.copy(this.fly.position);
      this.camera.quaternion.copy(this.fly.orientation);
      return;
    }

    // Ground shots: pick a direction that suits the subject, force the terrain
    // to stream in, then stand the player on it.
    const dir = await this.pickGroundSpot(mode);
    // Race the stream against a deadline. A patch on a world this size costs
    // real work to generate, and the pin asks for a full LOD chain down to
    // metre scale — on a slow machine that is minutes, and an `await` that
    // never returns is indistinguishable from a crash to whatever is driving
    // us. Take the terrain that arrived and pose the shot anyway: a coarse
    // landscape is a usable picture, a black screen is not.
    await Promise.race([
      this.planet.ensureDetail(dir, 2500),
      new Promise<void>((r) => setTimeout(r, o.detailTimeoutMs ?? 45000)),
    ]);
    // Fill the scatter around the landing site before the shot rather than
    // streaming it in over the next minute.
    this.scatter?.setViewer(_tmp.copy(dir).multiplyScalar(R + this.planet.heightAt(dir)));
    // Enough cells to fill the near field of a shot; the rest streams in during
    // the settle. Asking for hundreds here blocks for minutes and buys nothing
    // a camera can see.
    (this.scatter as any)?.prime?.(72, 6000);

    if (this.player) {
      // Face the subject. A fixed heading pointed the camera into the scenery
      // as often as at the thing the shot is named after.
      const heading = this.lookAtSite ? headingFromTo(dir, this.lookAtSite) : 0.6;
      this.player.spawnAt(dir, heading);
      this.player.setView(mode === 'ground' ? 'first' : 'third');
      this.mode = 'ground';
      this.player.board(null);
      ctxHud(this)?.setContext('foot');
      // Park the ship and the rover where the player set down, so a surface
      // shot has something human-made in it to give the landscape a scale.
      // Park them off to the side of the shot, not down the middle of it.
      const tangent = new Vector3(0, 1, 0).cross(dir).normalize();
      this.ship?.placeAt(_tmp2.copy(dir).addScaledVector(tangent, 26 / R).normalize(), heading + 1.9);
      this.rover?.placeAt(_tmp2.copy(dir).addScaledVector(tangent, 9 / R).normalize(), heading + 0.7);
    } else {
      this.mode = 'orbit';
      const h = this.planet.heightAt(dir);
      this.fly.position.copy(dir).multiplyScalar(R + h + 120);
      this.fly.lookAt(new Vector3(0, 0, 0).addScaledVector(dir, R + h).add(new Vector3(300, 0, 300)));
    }

    // Put the sun where it flatters the subject. Raking light is what gives
    // terrain its form; a sun overhead flattens the best landscape ever made.
    const elevDeg =
      mode === 'night' ? -14 :
      // Low enough to rake the façades and throw long shadows down the
      // streets, high enough that the place is not a silhouette.
      mode === 'city' ? 11 :
      mode === 'ocean' ? 9 :
      mode === 'vista' ? 13 : 26;
    this.frameSunAt(dir, (elevDeg * Math.PI) / 180);
  }

  /**
   * Wind the planet's rotation until the star sits at a given elevation above
   * the local horizon at `dir`. Same scan as frameSun, measured against the
   * ground's own up vector instead of the camera's.
   */
  private frameSunAt(dir: Vector3, wantElev: number): void {
    if (!this.spec) return;
    // A local, not a shared scratch vector: `updateSun` writes `_tmp` when it
    // snaps the shadow camera to the texel grid, so holding `_tmp` across the
    // call replaced this up vector with a planet-scale position on the first
    // iteration and every ground shot has been scanning against garbage.
    const up = dir.clone().normalize();
    const day = this.spec.rotationS;
    const t0 = this.simTime;
    let best = t0;
    let bestErr = Infinity;
    for (let i = 0; i < 288; i++) {
      this.simTime = t0 + (i / 288) * day;
      this.updateSun();
      const elev = Math.asin(MathUtils.clamp(this.sunDir.dot(up), -1, 1));
      const err = Math.abs(elev - wantElev);
      if (err < bestErr) {
        bestErr = err;
        best = this.simTime;
      }
    }
    this.simTime = best;
    this.updateSun();
  }

  /**
   * Wind the planet's rotation until the star sits `want` radians away from the
   * camera's own direction from the centre. Scanning a full day in 240 steps is
   * exact enough — the sun moves 1.5 degrees per step — and it means the shot
   * list can ask for "a terminator" without hard-coding a time of day per world.
   */
  private frameSun(want: number): void {
    if (!this.spec) return;
    // Local for the same reason as `frameSunAt`: nothing survives `updateSun`.
    const camDir = this.fly.position.clone().normalize();
    const day = this.spec.rotationS;
    const t0 = this.simTime;
    let best = t0;
    let bestErr = Infinity;
    for (let i = 0; i < 240; i++) {
      this.simTime = t0 + (i / 240) * day;
      this.updateSun();
      const err = Math.abs(Math.acos(MathUtils.clamp(this.sunDir.dot(camDir), -1, 1)) - want);
      if (err < bestErr) {
        bestErr = err;
        best = this.simTime;
      }
    }
    this.simTime = best;
    this.updateSun();
  }

  private async pickGroundSpot(mode: string): Promise<Vector3> {
    const R = this.spec!.radiusM;
    if (mode === 'city' && this.civ) {
      const s = this.civ.settlements();
      if (s.length) {
        const best = s.reduce((a, b) => (b.population > a.population ? b : a));
        // Stand outside the city looking in, so the skyline reads against sky
        // rather than against more city. Just over one radius out: far enough
        // for the whole silhouette, close enough that the towers still have
        // some size on screen.
        this.lookAtSite = best.direction.clone();
        const d = best.direction.clone();
        const tangent = new Vector3(0, 1, 0).cross(d).normalize();
        // Just inside the edge, looking toward the middle. Standing right out
        // in the fields puts the whole place on the horizon at four pixels
        // tall; from the last block in you get near buildings for scale and
        // the core behind them, which is what a skyline actually is.
        return d.addScaledVector(tangent, (best.radius * 0.82) / R).normalize();
      }
    }
    this.lookAtSite = null;
    // Two passes. A coarse golden-angle sweep gets the altitude band and the
    // local relief from cheap height lookups, and only the survivors pay for a
    // full surface sample (five height evaluations each) to check that the
    // ground there is actually somewhere a person would want to stand.
    const sea = this.planet!.seaLevelRadius();
    const alt = (d: Vector3) => R + this.planet!.heightAt(d) - (sea || R);

    // What each shot is looking for, in metres above the waterline.
    const band: Record<string, [number, number]> =
      { ocean: [2, 30], vista: [120, 1400], night: [20, 900], ground: [20, 700] };
    const [lo, hi] = band[mode] ?? band.ground;

    const N = 1400;
    const cands: { d: Vector3; score: number }[] = [];
    const probe = new Vector3();
    for (let i = 0; i < N; i++) {
      const t = i * 2.399963; // golden angle: even coverage of a sphere
      const y = 1 - (i / (N - 1)) * 2;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const d = new Vector3(Math.cos(t) * rr, y, Math.sin(t) * rr);
      const a = alt(d);
      if (mode === 'ocean') {
        // A coastline: right at the waterline, and not at the pole.
        if (a < -40 || a > 90) continue;
        cands.push({ d, score: -Math.abs(a - 10) - Math.abs(y) * 300 });
        continue;
      }
      if (a < 4) continue; // underwater, or the beach itself

      // Relief within roughly ten kilometres. This is what decides whether the
      // shot has mountains in it or is a featureless plain — and it is the
      // single term that separates a vista from a parking lot.
      const up = d;
      const ref = Math.abs(up.y) > 0.9 ? _dir.set(1, 0, 0) : _dir.set(0, 1, 0);
      const tx = probe.copy(ref).cross(up).normalize();
      const e = 9000 / R;
      let rMin = Infinity;
      let rMax = -Infinity;
      for (let k = 0; k < 4; k++) {
        const ang = (k * Math.PI) / 2;
        const off = _tmp
          .copy(up)
          .addScaledVector(tx, Math.cos(ang) * e)
          .addScaledVector(_wind.copy(up).cross(tx), Math.sin(ang) * e)
          .normalize();
        const h = alt(off);
        rMin = Math.min(rMin, h);
        rMax = Math.max(rMax, h);
      }
      const relief = rMax - rMin;

      // A soft window on altitude rather than a hard cut, so a world whose
      // land all sits above the band still returns its least-bad spot.
      const inBand = a >= lo && a <= hi ? 1 : 1 / (1 + Math.abs(a < lo ? lo - a : a - hi) / 600);
      let score = inBand * 1000;
      if (mode === 'vista') score += Math.min(relief, 3000) * 0.55;
      else score += Math.min(relief, 900) * 0.25;
      // Keep away from the poles: the shot wants weather and life, not ice.
      score -= Math.abs(y) * 260;
      cands.push({ d, score });
    }

    cands.sort((a, b) => b.score - a.score);
    if (!cands.length) return new Vector3(0.3, 0.5, 0.8).normalize();
    if (mode === 'ocean') return cands[0].d;

    // Second pass: among the best few, prefer ground that is alive and not a
    // cliff face. `sampleSurface` is expensive, so only forty of them run it.
    let best = cands[0].d;
    let bestScore = -Infinity;
    for (const c of cands.slice(0, 40)) {
      const sm = this.planet!.sampleSurface(c.d);
      if (sm.underwater) continue;
      let sc = c.score;
      sc += sm.temperature * sm.humidity * 900;      // somewhere things grow
      sc -= Math.max(0, sm.slope - 0.35) * 2200;     // standing, not clinging
      if (sc > bestScore) {
        bestScore = sc;
        best = c.d;
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
    if (this.ship) {
      this.scene.remove(this.ship.root);
      this.ship.dispose();
      this.ship = null;
    }
    if (this.planet) {
      this.scene.remove(this.planet.root);
      this.planet.dispose();
      this.planet = null;
    }
  }

  dispose(): void {
    this.sky.dispose();
    this.teardown();
  }
}

/**
 * Heading at `from` that points along the great circle toward `to`, in the same
 * convention `Player.spawnAt` uses: zero is the reference tangent, positive is
 * a rotation about the local up.
 */
function headingFromTo(from: Vector3, to: Vector3): number {
  const up = _hUp.copy(from).normalize();
  const ref = Math.abs(up.y) > 0.94 ? _hRef.set(1, 0, 0) : _hRef.set(0, 1, 0);
  const base = _hBase.crossVectors(ref, up).normalize();
  const right = _hRight.crossVectors(up, base).normalize();
  const toward = _hTo.copy(to).addScaledVector(up, -to.dot(up));
  if (toward.lengthSq() < 1e-12) return 0;
  toward.normalize();
  return Math.atan2(toward.dot(right), toward.dot(base));
}

/** The HUD lives on the engine's service bag; debugView has no ctx of its own. */
function ctxHud(realm: any): { setContext(m: string): void } | null {
  return realm.hudRef ?? null;
}

/** Half-extent of the shadowed box around the player, metres. */
const SHADOW_SPAN = 130;

const _dir = new Vector3();
const _tmp = new Vector3();
const _wind = new Vector3();
const _tmp2 = new Vector3();
const _sunPos = new Vector3();
const _hUp = new Vector3();
const _hRef = new Vector3();
const _hBase = new Vector3();
const _hRight = new Vector3();
const _hTo = new Vector3();

/** Insolation relative to Earth, gently compressed so nothing blows out. */
function sunIntensity(p: PlanetSpec, s: StarSystemSpec | null): number {
  if (!s) return 1;
  const flux = s.stars[0].luminosityW / (4 * Math.PI * p.orbit.a * p.orbit.a);
  return MathUtils.clamp(Math.pow(flux / 1361, 0.42), 0.12, 3.2);
}

/**
 * How good a world is to arrive at, for the purpose of picking a default.
 * Ordered by what a person would rather be standing on, not by rarity.
 */
function summariseWeather(w: any): Record<string, number | string> {
  return {
    cloud: Number((w.cloudiness ?? 0).toFixed(2)),
    precip: w.precipitationType ?? 'none',
    storm: Number((w.storm ?? 0).toFixed(2)),
    aurora: Number((w.aurora ?? 0).toFixed(2)),
  };
}

function worldScore(p: PlanetSpec): number {
  const byClass: Record<string, number> = {
    terran: 100, ocean: 82, jungle: 78, tundra: 60,
    desert: 48, exotic: 44, glacial: 34, toxic: 24, molten: 18, barren: 10,
  };
  let s = byClass[p.klass] ?? 12;
  if (p.ocean.present) s += 10;
  if (p.atmosphere.present) s += 8;
  if (p.life === 'fauna' || p.life === 'sapient') s += 12;
  if (p.civilization.present) s += 6;
  return s;
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
