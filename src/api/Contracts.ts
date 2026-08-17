/**
 * MODULE CONTRACTS.
 *
 * ÆON is built by many hands working at once. This file is the treaty between
 * them: the realms (integration layer) know *only* these interfaces, and each
 * subsystem is free to be as elaborate as it likes behind one.
 *
 * Rules:
 *   1. Never change a signature here without updating every implementor.
 *   2. Every system owns its own scene objects and must fully clean up in
 *      `dispose()` — geometries, materials, textures, render targets.
 *   3. `update(dt, ctx)` is called once per frame. Do your own budgeting; the
 *      frame is 16 ms for everything, not 16 ms each.
 *   4. All positions passed across this boundary are in metres unless the name
 *      says otherwise, and are relative to the current floating origin.
 */

import type { Camera, Object3D, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import type { QualityProfile } from '../core/Settings';
import type { Input } from '../core/Input';
import type { PlanetSpec, StarSystemSpec, GalaxySpec, StarSpec, MoonSpec } from '../universe/Types';

/* ═══════════════════════════════════════════════════════════════════════════
   Common
   ═══════════════════════════════════════════════════════════════════════════ */

export interface SystemContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  input: Input;
  quality: QualityProfile;
  /** Seconds since boot. */
  time: number;
  /** Simulated in-world time, seconds. Can run far faster than real time. */
  simTime: number;
  services: Record<string, any>;
}

export interface Disposable {
  dispose(): void;
}

export interface Updatable {
  update(dt: number, ctx: SystemContext): void;
}

export interface QualityAware {
  setQuality(q: QualityProfile): void;
}

/* ═══════════════════════════════════════════════════════════════════════════
   COSMOS — the cosmic web  (owner: src/cosmos/*)
   ═══════════════════════════════════════════════════════════════════════════ */

export interface CosmicWebStats {
  /** Redshift being displayed, high → early universe. */
  redshift: number;
  /** Scale factor a(t), 1 = today. */
  scaleFactor: number;
  /** Age of the universe at the displayed epoch, in years. */
  ageYears: number;
  /** Number of particles being integrated. */
  particles: number;
  /** Fraction of mass in collapsed haloes — structure formation progress. */
  collapsedFraction: number;
}

export interface ICosmicWeb extends Updatable, Disposable, QualityAware {
  readonly root: Object3D;
  /** Advance or rewind cosmic time. `rate` is in units of "×real time". */
  setTimeRate(rate: number): void;
  /** Jump to a given scale factor, 0.02 (early) → 1 (today) → >1 (future). */
  setEpoch(scaleFactor: number): void;
  stats(): CosmicWebStats;
  /** World position of the densest node near a ray — used for "dive in". */
  pickNode(origin: Vector3, direction: Vector3): Vector3 | null;
  /** Nearest node to a point, for the camera to orbit. */
  nearestNode(p: Vector3): Vector3 | null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   GALAXY  (owner: src/galaxy/*)
   ═══════════════════════════════════════════════════════════════════════════ */

export interface IGalaxyRenderer extends Updatable, Disposable, QualityAware {
  readonly root: Object3D;
  /** Build (or rebuild) for a galaxy spec. Units: 1 unit = 1 light year. */
  build(spec: GalaxySpec): void;
  /** Highlight a system the player has targeted. */
  setTarget(positionLy: Vector3 | null): void;
  /** Systems visible near a point, for the map UI. */
  systemsNear(positionLy: Vector3, radiusLy: number): StarSystemSpec[];
}

/**
 * The deep-sky backdrop seen from inside a star system: the Milky Way band,
 * distant galaxies, the zodiacal light. Rendered on a sky sphere.
 */
export interface ISkybox extends Updatable, Disposable, QualityAware {
  readonly root: Object3D;
  /** Rebuild for a viewpoint inside the given galaxy. */
  build(galaxy: GalaxySpec, positionLy: [number, number, number]): void;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PLANET  (owner: src/planet/*)
   ═══════════════════════════════════════════════════════════════════════════ */

/** Everything the surface systems need to know about a point on a world. */
export interface SurfaceSample {
  /** Elevation above the reference sphere, metres. Negative = below datum. */
  elevation: number;
  /** Outward surface normal in planet-local space. */
  normal: Vector3;
  /** 0–1 slope, 0 = flat, 1 = vertical. */
  slope: number;
  /** 0–1 temperature (0 = polar/frozen, 1 = equatorial/hot). */
  temperature: number;
  /** 0–1 humidity. */
  humidity: number;
  /** Resolved biome id — see BIOME_IDS. */
  biome: number;
  /** True if this point is under the ocean surface. */
  underwater: boolean;
}

export const BIOME_IDS = {
  OCEAN: 0,
  BEACH: 1,
  DESERT: 2,
  GRASSLAND: 3,
  FOREST: 4,
  JUNGLE: 5,
  TAIGA: 6,
  TUNDRA: 7,
  GLACIER: 8,
  ROCK: 9,
  LAVA: 10,
  SALT_FLAT: 11,
  CRYSTAL: 12,
  MUSHROOM: 13,
  ALKALI: 14,
  BADLANDS: 15,
} as const;

export type BiomeId = (typeof BIOME_IDS)[keyof typeof BIOME_IDS];

/**
 * The planet. Owns terrain LOD, atmosphere, ocean and clouds.
 *
 * The critical method is `sampleSurface` — it must agree with what the terrain
 * shader draws, to within a few centimetres, or the player will float and sink.
 */
export interface IPlanet extends Updatable, Disposable, QualityAware {
  readonly root: Object3D;
  readonly spec: PlanetSpec;
  /** Reference sphere radius, metres. */
  readonly radius: number;

  /**
   * Height of the terrain along a unit direction from the planet centre,
   * in metres above the reference sphere. Must be cheap: called by physics
   * several times per frame per entity.
   */
  heightAt(direction: Vector3): number;

  /** Full surface description at a direction. Slower; call sparingly. */
  sampleSurface(direction: Vector3): SurfaceSample;

  /**
   * Force the highest LOD to be resident around a point (the player, a landing
   * site) and resolve when the terrain there is actually built. Used to avoid
   * landing inside a low-resolution hill.
   */
  ensureDetail(direction: Vector3, radiusM: number): Promise<void>;

  /** Set the star direction and colour for lighting and scattering. */
  setSun(directionWorld: Vector3, colorLinear: [number, number, number], intensity: number): void;

  /** Camera position in planet-local metres, called every frame before update. */
  setViewer(localPosition: Vector3): void;

  /**
   * Live cloud cover, 0–1, from the weather system. The orbital deck and the
   * ground-level sky are the same phenomenon at two distances and must not
   * disagree; this is the one channel that keeps them in step.
   */
  setWeather(cloudiness: number): void;

  /** True once enough terrain exists that the world is safe to stand on. */
  isReady(): boolean;

  /** Sea level radius in metres, or 0 if no ocean. */
  seaLevelRadius(): number;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SURFACE LIFE  (owner: src/surface/*)
   ═══════════════════════════════════════════════════════════════════════════ */

export interface IScatterSystem extends Updatable, Disposable, QualityAware {
  readonly root: Object3D;
  /** Attach to a planet; the system pulls terrain data through IPlanet. */
  attach(planet: IPlanet): void;
  /** Viewer position in planet-local metres. Drives streaming. */
  setViewer(localPosition: Vector3): void;
  /** Wind vector in planet-local space; drives sway. */
  setWind(wind: Vector3): void;
  /** Approximate collision radius of the nearest solid scatter, for the player. */
  collideCapsule(localPosition: Vector3, radius: number, height: number): Vector3 | null;
}

export interface IWildlife extends Updatable, Disposable, QualityAware {
  readonly root: Object3D;
  attach(planet: IPlanet): void;
  setViewer(localPosition: Vector3): void;
  /** Count of creatures currently simulated, for the HUD. */
  population(): number;
}

export interface WeatherState {
  /** 0–1 cloud cover. */
  cloudiness: number;
  /** 0–1 precipitation intensity. */
  precipitation: number;
  /** 'none' | 'rain' | 'snow' | 'dust' | 'ash' | 'acid' */
  precipitationType: string;
  /** Wind vector, planet-local, m/s. */
  wind: Vector3;
  /** 0–1 fog. */
  fog: number;
  /** 0–1 lightning activity. */
  storm: number;
  /** Local temperature, K. */
  temperature: number;
  /** 0-1 aurora intensity at the viewer's latitude. */
  aurora: number;
}

export interface IWeather extends Updatable, Disposable, QualityAware {
  readonly root: Object3D;
  attach(planet: IPlanet): void;
  setViewer(localPosition: Vector3): void;
  state(): WeatherState;
  /** Force a weather event (used by the photo mode and for drama). */
  force(type: string, intensity: number): void;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CIVILISATION  (owner: src/civ/*)
   ═══════════════════════════════════════════════════════════════════════════ */

export interface SettlementInfo {
  name: string;
  /** Unit direction from the planet centre. */
  direction: Vector3;
  /** Metres. */
  radius: number;
  population: number;
  kind: 'megacity' | 'city' | 'town' | 'outpost' | 'monument' | 'ruin' | 'farm' | 'port';
}

export interface ICivilization extends Updatable, Disposable, QualityAware {
  readonly root: Object3D;
  attach(planet: IPlanet): void;
  setViewer(localPosition: Vector3): void;
  /** All settlements on this world, for the map and for orbital night lights. */
  settlements(): SettlementInfo[];
  /** Nearest settlement to a direction, for HUD labels. */
  nearest(direction: Vector3): SettlementInfo | null;
  /** Collision against building shells. Returns push-out vector or null. */
  collideCapsule(localPosition: Vector3, radius: number, height: number): Vector3 | null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PLAYER + VEHICLES  (owner: src/entities/*)
   ═══════════════════════════════════════════════════════════════════════════ */

export type ViewMode = 'first' | 'third';

export interface PlayerState {
  /** Position in planet-local metres. */
  position: Vector3;
  /** Velocity, m/s, planet-local. */
  velocity: Vector3;
  /** Up vector (radially outward from the planet). */
  up: Vector3;
  /** Forward vector on the tangent plane. */
  forward: Vector3;
  grounded: boolean;
  swimming: boolean;
  sprinting: boolean;
  crouching: boolean;
  /** 0–1 jetpack fuel. */
  fuel: number;
  /** Height of the eye above the feet, metres. */
  eyeHeight: number;
  view: ViewMode;
  /** Speed in m/s, for the HUD. */
  speed: number;
  /** Current vehicle, if riding one. */
  vehicle: IVehicle | null;
}

/** Terrain/obstacle queries the controller needs. Provided by the realm. */
export interface CollisionProvider {
  /** Ground height along a direction, metres above the reference sphere. */
  heightAt(direction: Vector3): number;
  /** Optional obstacle resolution; return a push-out vector. */
  resolve?(localPosition: Vector3, radius: number, height: number): Vector3 | null;
  /** Sea level radius, or 0. */
  seaLevelRadius(): number;
  /** Planet radius, metres. */
  radius: number;
  /** Surface gravity, m/s². */
  gravity: number;
}

export interface IPlayer extends Updatable, Disposable {
  readonly root: Object3D;
  readonly state: PlayerState;
  readonly camera: PerspectiveCamera;
  attach(collision: CollisionProvider): void;
  /** Place the player at a direction on the sphere, standing on the ground. */
  spawnAt(direction: Vector3, headingRad?: number): void;
  setView(mode: ViewMode): void;
  toggleView(): void;
  /** Enter/leave a vehicle. */
  board(vehicle: IVehicle | null): void;
  /** Camera shake impulse, for impacts and thunder. */
  shake(amount: number, duration: number): void;
  /** Freeze input (cutscenes, menus). */
  setControlEnabled(v: boolean): void;
}

export type VehicleKind = 'rover' | 'hoverbike' | 'starship';

export interface IVehicle extends Updatable, Disposable {
  readonly root: Object3D;
  readonly kind: VehicleKind;
  readonly position: Vector3;
  readonly velocity: Vector3;
  /** Local-space seat position for the camera when riding. */
  seatOffset: Vector3;
  attach(collision: CollisionProvider): void;
  setDriver(active: boolean): void;
  /** Speed in m/s for the HUD. */
  speed(): number;
  /** 0–1 integrity; Pacific Drive-style damage state. */
  integrity(): number;
  /** Place it on the ground at a direction. */
  placeAt(direction: Vector3, headingRad?: number): void;
}

export interface IStarship extends IVehicle {
  /** 0 = landed, 1 = orbit, used to blend flight models. */
  altitudeFactor(): number;
  requestTakeoff(): void;
  requestLanding(direction: Vector3): void;
  /** Engage the warp drive toward a target system. */
  warpTo(target: StarSystemSpec): void;
  isWarping(): boolean;
}

/* ═══════════════════════════════════════════════════════════════════════════
   UI  (owner: src/ui/*)
   ═══════════════════════════════════════════════════════════════════════════ */

export interface HudTarget {
  /** World-space position to anchor the marker to. */
  position: Vector3;
  label: string;
  sub?: string;
  kind: 'planet' | 'moon' | 'star' | 'settlement' | 'ship' | 'waypoint' | 'creature' | 'anomaly';
  /** Distance in metres, formatted by the HUD. */
  distance?: number;
  important?: boolean;
}

export interface IHud extends Disposable {
  readonly element: HTMLElement;
  update(dt: number, ctx: SystemContext): void;
  setVisible(v: boolean): void;
  /** Diegetic markers projected into screen space. */
  setTargets(targets: HudTarget[]): void;
  /** Bottom-left location string, e.g. "Aureth II · Shattered Coast". */
  setLocation(primary: string, secondary?: string): void;
  /** Transient message, e.g. "Atmospheric entry" or an objective. */
  toast(text: string, durationS?: number): void;
  /**
   * Contextual action prompt — what the interact button would do right now.
   * Safe to call every frame with the same string; null clears it.
   */
  setPrompt(text: string | null, key?: string): void;
  /** Big cinematic title card, used on arrival at a new world. */
  titleCard(title: string, subtitle?: string): void;
  /** Vital readouts. */
  setVitals(v: { speed?: number; altitude?: number; fuel?: number; integrity?: number; oxygen?: number; temperature?: number }): void;
  /** Which control scheme to display. */
  setContext(mode: 'space' | 'orbit' | 'foot' | 'vehicle' | 'cosmos' | 'map'): void;
  /** Scanner overlay toggle. */
  setScanning(active: boolean): void;
  /** 0–1 warp/transition veil. */
  setVeil(v: number): void;
}

/* ═══════════════════════════════════════════════════════════════════════════
   AUDIO  (owner: src/audio/*)
   ═══════════════════════════════════════════════════════════════════════════ */

export type MusicMood = 'cosmos' | 'drift' | 'arrival' | 'wonder' | 'tension' | 'settlement' | 'storm' | 'night' | 'silence';

export interface IAudio extends Disposable {
  /** Must be called from a user gesture. */
  resume(): Promise<void>;
  update(dt: number, ctx: SystemContext): void;
  setMood(mood: MusicMood, intensity?: number): void;
  /** One-shot sound effect by name. */
  play(name: string, opts?: { volume?: number; rate?: number; position?: Vector3 }): void;
  /** Continuous ambience bed, cross-faded. */
  setAmbience(name: string, intensity: number): void;
  setMusicVolume(v: number): void;
  setSfxVolume(v: number): void;
  /** Low-pass everything (underwater, helmet, interior). */
  setMuffle(amount: number): void;
  readonly ready: boolean;
}
