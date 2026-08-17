/**
 * Cities, towns, and the people who built them.
 *
 * This module owns everything a civilisation puts on a world's surface. It runs
 * in four stages, each one streamed across frames so that arriving over a
 * megacity never costs a dropped frame:
 *
 *   1. PLACEMENT (once, on attach) — score the whole sphere and decide where
 *      the settlements are. Cheap enough that every city on the planet exists
 *      as data from the moment you enter orbit, which is what the map, the HUD
 *      markers and the night-lights need.
 *   2. HEIGHTS — cache a grid of terrain samples under the settlement, because
 *      every parcel, kerb and lamppost needs the ground height and asking the
 *      planet's noise ten thousand times in one tick is not an option.
 *   3. LAYOUT — streets, districts, blocks, parcels, buildings, in 2-D.
 *   4. GEOMETRY — extrude it all into a handful of buffers.
 *
 * The whole city is then five draw calls: massing, roads, ground, holograms,
 * traffic. Everything that looks like detail — a hundred thousand windows, rain
 * streaks, lit rooms with furniture in them — is computed per fragment from the
 * façade coordinate. There is no texture anywhere in it.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshDepthMaterial,
  Points,
  RGBADepthPacking,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { DirectionalLight } from 'three';
import type { ICivilization, IPlanet, SettlementInfo, SystemContext } from '../api/Contracts';
import type { QualityProfile } from '../core/Settings';
import { clamp, saturate, smoothstep } from '../core/Noise';
import { Rng } from '../core/Rand';
import { Heightfield, TangentFrame, clamp01, mix } from './CivMath';
import { placeSettlements } from './Placement';
import { buildLayout, type Layout } from './Layout';
import { emitCity, type CityGeometry } from './Build';
import { makeGlyphTexture } from './Glyphs';
import {
  applyLighting,
  makeCityMaterial,
  makeGlowMaterial,
  makeGroundMaterial,
  makeHoloMaterial,
  makeLightsMaterial,
  makeRoadMaterial,
  makeTrafficMaterial,
  type CivLighting,
} from './Materials';
import type { Obstacle, Site } from './CivTypes';

type Stage = 'cold' | 'heights' | 'layout' | 'geometry' | 'ready';

interface Settlement {
  site: Site;
  info: SettlementInfo;
  stage: Stage;
  frame: TangentFrame | null;
  hf: Heightfield | null;
  layout: Layout | null;
  emitter: Generator<number, CityGeometry, void> | null;
  group: Group | null;
  obstacles: Obstacle[];
  /** Planet-local centre, for distance tests. */
  center: Vector3;
  /** 0–1 build progress, for the HUD if it ever wants it. */
  progress: number;
  disposables: (BufferGeometry | null)[];
}

/** Per-tier work budgets. A city must never cost more than a slice of a frame. */
interface Caps {
  maxBuildings: number;
  detail: number;
  traffic: number;
  signs: number;
  hfRes: number;
  /** Terrain samples per frame while caching heights. */
  heightPerFrame: number;
  /** How far out (in city radii) a settlement starts building. */
  range: number;
}

const CAPS_BY_TIER: Record<string, Caps> = {
  low: { maxBuildings: 320, detail: 0.0, traffic: 0, signs: 0, hfRes: 48, heightPerFrame: 220, range: 9 },
  medium: { maxBuildings: 900, detail: 0.45, traffic: 14, signs: 10, hfRes: 64, heightPerFrame: 420, range: 12 },
  high: { maxBuildings: 2100, detail: 1.0, traffic: 40, signs: 26, hfRes: 96, heightPerFrame: 900, range: 16 },
  ultra: { maxBuildings: 3600, detail: 1.4, traffic: 72, signs: 44, hfRes: 128, heightPerFrame: 1600, range: 20 },
};

export class Civilization implements ICivilization {
  readonly root = new Group();

  private planet: IPlanet | null = null;
  private sites: Site[] = [];
  private places: Settlement[] = [];
  private viewer = new Vector3();
  private caps: Caps = CAPS_BY_TIER.high;
  private time = 0;

  private mats: {
    city: ShaderMaterial;
    road: ShaderMaterial;
    ground: ShaderMaterial;
    holo: ShaderMaterial;
    traffic: ShaderMaterial;
    glow: ShaderMaterial;
    lights: ShaderMaterial;
  } | null = null;
  private glyphs: ReturnType<typeof makeGlyphTexture> | null = null;
  private depthMat = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

  /** The view from orbit: every settlement as a cloud of its own lights. */
  private orbitalLights: Points | null = null;
  private lighting: CivLighting = {
    sunDir: new Vector3(0, 1, 0),
    sunColor: new Color(1, 1, 1),
    sunIntensity: 3,
    skyColor: new Color(0.28, 0.42, 0.72),
    groundColor: new Color(0.12, 0.1, 0.09),
    night: 0,
    fogColor: new Color(0.42, 0.52, 0.66),
    fogDensity: 1 / 9000,
    time: 0,
    structure: new Color(0.32, 0.32, 0.34),
    neon: new Color(0.2, 1.6, 2.4),
    decay: 0.05,
    detail: 1,
    wetness: 0,
  };
  private sunLight: DirectionalLight | null = null;
  private matList: ShaderMaterial[] = [];

  attach(planet: IPlanet): void {
    this.dispose();
    this.planet = planet;
    const civ = planet.spec.civilization;
    if (!civ.present) return;

    this.sites = placeSettlements(planet, civ, this.caps.hfRes >= 96 ? 3400 : 1800);
    if (!this.sites.length) return;

    this.glyphs = makeGlyphTexture(planet.spec.seed ^ 0x9e37);
    this.mats = {
      city: makeCityMaterial(),
      road: makeRoadMaterial(),
      ground: makeGroundMaterial(),
      holo: makeHoloMaterial(this.glyphs),
      traffic: makeTrafficMaterial(),
      glow: makeGlowMaterial(),
      lights: makeLightsMaterial(),
    };
    this.matList = [
      this.mats.city,
      this.mats.road,
      this.mats.ground,
      this.mats.holo,
      this.mats.traffic,
      this.mats.glow,
    ];

    const R = planet.radius;
    for (const s of this.sites) {
      const center = s.dir.clone().multiplyScalar(R + s.elevation);
      this.places.push({
        site: s,
        info: {
          name: s.name,
          direction: s.dir,
          radius: s.radius,
          population: s.population,
          kind: s.kind,
        },
        stage: 'cold',
        frame: null,
        hf: null,
        layout: null,
        emitter: null,
        group: null,
        obstacles: [],
        center,
        progress: 0,
        disposables: [],
      });
    }

    this.buildOrbitalLights();
  }

  setViewer(localPosition: Vector3): void {
    this.viewer.copy(localPosition);
  }

  settlements(): SettlementInfo[] {
    return this.places.map((s) => s.info);
  }

  nearest(direction: Vector3): SettlementInfo | null {
    if (!this.planet) return null;
    let best: Settlement | null = null;
    let bestD = Infinity;
    for (const s of this.places) {
      const d = s.site.dir.distanceTo(direction);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best) return null;
    // Only claim you are "in" a place if you are actually inside its reach.
    return bestD * this.planet.radius < best.site.radius * 2.2 ? best.info : null;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Frame
     ═══════════════════════════════════════════════════════════════════════ */

  update(dt: number, ctx: SystemContext): void {
    if (!this.planet || !this.mats) return;
    this.time += dt;

    this.updateLighting(ctx);

    // One settlement is streamed at a time, nearest first. Building two cities
    // at once halves the rate at which either becomes visible, which is exactly
    // the wrong trade — you want the one in front of you finished.
    let target: Settlement | null = null;
    let bestD = Infinity;
    for (const s of this.places) {
      const d = s.center.distanceTo(this.viewer);
      const buildAt = s.site.radius * this.caps.range + 6000;
      const dropAt = buildAt * 2.1 + 12000;
      if (s.stage !== 'cold' && d > dropAt) {
        this.demolish(s);
        continue;
      }
      if (d > buildAt || s.stage === 'ready') continue;
      if (d < bestD) {
        bestD = d;
        target = s;
      }
    }
    if (target) this.advance(target);
  }

  /** Push one settlement forward by roughly one frame's worth of work. */
  private advance(s: Settlement): void {
    const planet = this.planet!;
    const civ = planet.spec.civilization;

    switch (s.stage) {
      case 'cold': {
        const elev = planet.heightAt(s.site.dir);
        s.site.elevation = elev;
        s.center.copy(s.site.dir).multiplyScalar(planet.radius + elev);
        const frame = new TangentFrame(s.site.dir, planet.radius, elev);
        // A port faces its water; everything else keeps the world's own axes.
        if (s.site.coastal > 0.3) frame.rotate(Math.atan2(s.site.waterDirY, s.site.waterDirX));
        const seaR = planet.seaLevelRadius();
        s.frame = frame;
        s.hf = new Heightfield(
          frame,
          s.site.radius * 1.45,
          this.caps.hfRes,
          seaR > 0 ? seaR - planet.radius : -Infinity
        );
        s.stage = 'heights';
        break;
      }
      case 'heights': {
        if (s.hf!.fill(planet, this.caps.heightPerFrame)) {
          s.stage = 'layout';
          s.progress = 0.25;
        } else {
          s.progress = 0.25 * (0.2 + 0.8 * s.progress);
        }
        break;
      }
      case 'layout': {
        s.layout = buildLayout(s.site, civ, s.hf!, {
          maxBuildings: Math.round(this.caps.maxBuildings * sizeShare(s.site)),
          detail: this.caps.detail,
          traffic: Math.round(this.caps.traffic * sizeShare(s.site)),
        });
        s.emitter = emitCity(s.layout, s.hf!, civ, {
          detail: this.caps.detail,
          traffic: this.caps.traffic,
          signs: this.caps.signs,
        });
        s.stage = 'geometry';
        s.progress = 0.35;
        break;
      }
      case 'geometry': {
        const r = s.emitter!.next();
        if (r.done) {
          this.install(s, r.value);
          s.stage = 'ready';
          s.progress = 1;
        } else {
          s.progress = 0.35 + 0.6 * (r.value as number);
        }
        break;
      }
      default:
        break;
    }
  }

  /** Hang the finished buffers off a group oriented into the tangent frame. */
  private install(s: Settlement, geo: CityGeometry): void {
    const m = this.mats!;
    const f = s.frame!;
    const g = new Group();
    // The group's basis maps (east, north, up) → planet-local, so every shader
    // that asks for `modelMatrix * vec3(0,0,1)` gets the real local up.
    g.matrixAutoUpdate = false;
    g.matrix.makeBasis(f.east, f.north, f.up);
    g.matrix.setPosition(f.origin);
    g.matrixWorldNeedsUpdate = true;

    const add = (geom: BufferGeometry | null, mat: ShaderMaterial, order: number, shadows: boolean) => {
      if (!geom) return;
      const mesh = new Mesh(geom, mat);
      mesh.renderOrder = order;
      mesh.frustumCulled = true;
      if (shadows) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.customDepthMaterial = this.depthMat;
      }
      g.add(mesh);
      s.disposables.push(geom);
    };

    add(geo.ground, m.ground, 0, false);
    add(geo.road, m.road, 1, false);
    add(geo.city, m.city, 2, true);
    if (geo.traffic) {
      const mesh = new Mesh(geo.traffic, m.traffic);
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      g.add(mesh);
      s.disposables.push(geo.traffic);
    }
    add(geo.holo, m.holo, 8, false);

    // The light-pollution dome. Only worth it over somewhere big enough to
    // make one, and it is half of why a city at night reads as a city.
    if (s.layout && s.layout.skylineHeight > 18 && s.site.population > 4000) {
      const r = s.site.radius * 1.5;
      const dome = new SphereGeometry(r, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);
      // The sphere is built +Y up; the group is +Z up. Rotate it once, here.
      dome.rotateX(-Math.PI / 2);
      dome.scale(1, 1, Math.min(0.55, (s.layout.skylineHeight * 7) / r));
      const mesh = new Mesh(dome, m.glow);
      mesh.renderOrder = 9;
      g.add(mesh);
      s.disposables.push(dome);
    }

    s.obstacles = geo.obstacles;
    s.group = g;
    this.root.add(g);
  }

  private demolish(s: Settlement): void {
    if (s.group) {
      this.root.remove(s.group);
      s.group.traverse((o: any) => {
        if (o.isMesh || o.isPoints) o.geometry?.dispose?.();
      });
    }
    for (const d of s.disposables) d?.dispose();
    s.disposables = [];
    s.group = null;
    s.layout = null;
    s.emitter = null;
    s.hf = null;
    s.frame = null;
    s.obstacles = [];
    s.stage = 'cold';
    s.progress = 0;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Lighting
     ═══════════════════════════════════════════════════════════════════════ */

  /**
   * The civ shaders do their own lighting, so they need the same sun the rest
   * of the world is using. Rather than add a channel to the module contract for
   * one subsystem, we read the realm's own directional light out of the scene —
   * it is the authority, and this way the city can never disagree with the
   * terrain about where the sun is.
   */
  private updateLighting(ctx: SystemContext): void {
    if (!this.planet || !this.mats) return;
    const spec = this.planet.spec;
    const civ = spec.civilization;
    const L = this.lighting;

    if (!this.sunLight || !this.sunLight.parent) {
      this.sunLight = null;
      for (const o of ctx.scene.children) {
        if ((o as any).isDirectionalLight) {
          this.sunLight = o as DirectionalLight;
          break;
        }
      }
    }

    const up = _v0.copy(this.viewer).normalize();
    if (this.sunLight) {
      L.sunDir.copy(this.sunLight.position).sub(this.sunLight.target.position).normalize();
      L.sunColor.copy(this.sunLight.color);
      // three's Lambert divides by π and the realm pre-multiplies by it; undo
      // that here, because this shader's `aeon_light` does not.
      L.sunIntensity = this.sunLight.intensity / Math.PI;
    }

    const sunUp = L.sunDir.dot(up);
    // Civil twilight is long: the sky stays lit well after the sun has gone.
    L.night = 1 - smoothstep(-0.16, 0.10, sunUp);

    const air = spec.atmosphere;
    const tint = air.present ? air.tint : ([0.1, 0.12, 0.16] as const);
    const density = air.present ? clamp(air.surfacePressurePa / 101325, 0.05, 2) : 0;
    // Sky bounce: blue and strong under thick air, nearly nothing on a rock,
    // and it reddens and fades as the sun goes down.
    const day = saturate((sunUp + 0.14) / 0.26);
    const warm = 1 - saturate(sunUp / 0.25);
    const sky = 0.55 * density * (0.05 + 0.95 * day) * L.sunIntensity;
    L.skyColor.setRGB(
      (0.05 + tint[0] * 0.9) * sky * (1 + warm * 0.9),
      (0.07 + tint[1] * 1.0) * sky * (1 + warm * 0.2),
      (0.11 + tint[2] * 1.3) * sky * (1 - warm * 0.45)
    );
    L.groundColor.setRGB(
      spec.palette.lowland[0] * sky * 0.35,
      spec.palette.lowland[1] * sky * 0.35,
      spec.palette.lowland[2] * sky * 0.35
    );

    // Aerial perspective has to match the terrain's or the city floats in
    // front of the landscape. Thicker air, shorter visibility.
    L.fogColor.copy(L.skyColor).multiplyScalar(1.35);
    L.fogDensity = density > 0.02 ? 1 / mix(45000, 9000, clamp01(density)) : 1 / 400000;

    L.time = this.time;
    L.structure.setRGB(civ.structure[0], civ.structure[1], civ.structure[2]);
    L.neon.setRGB(civ.neon[0], civ.neon[1], civ.neon[2]);
    L.decay = civ.decay;
    L.detail = clamp01(this.caps.detail);
    L.wetness = spec.ocean.present ? 0.28 : 0.04;

    applyLighting(this.matList, L);

    const lm = this.mats.lights.uniforms;
    lm.uNight.value = L.night;
    lm.uTime.value = this.time;
    const size = ctx.renderer.getDrawingBufferSize(_size);
    // Angular size → pixels, so a city subtends the same on screen at any FOV.
    lm.uPixelScale.value = (size.y * 0.5) / Math.tan((ctx.camera.fov * Math.PI) / 360);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Orbital night lights
     ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Every settlement as a spray of lights in planet-local space. This exists
   * from the moment you arrive, long before any city is built — a dark world
   * with a scatter of orange constellations on its night side is the single
   * best "someone lives here" cue there is, and it costs one draw call.
   */
  private buildOrbitalLights(): void {
    const planet = this.planet!;
    const civ = planet.spec.civilization;
    const R = planet.radius;

    const per = (s: Site) =>
      Math.min(900, Math.max(12, Math.round(Math.sqrt(s.population) * 1.6 * (0.4 + civ.techLevel))));
    let total = 0;
    for (const s of this.sites) total += per(s);
    if (!total) return;

    const pos = new Float32Array(total * 3);
    const size = new Float32Array(total);
    const tint = new Float32Array(total * 3);
    const seed = new Float32Array(total);

    const neon = civ.neon;
    let k = 0;
    for (const s of this.sites) {
      const rng = new Rng(s.seed ^ 0x11117);
      const n = per(s);
      const frame = new TangentFrame(s.dir, R, s.elevation);
      const dark = s.kind === 'ruin' ? 0.12 : 1;
      for (let i = 0; i < n; i++) {
        // Radially concentrated: a city is far brighter at its core, and the
        // outskirts trail off rather than ending at a circle.
        const rr = Math.pow(rng.next(), 1.9) * s.radius * 1.25;
        const a = rng.range(0, Math.PI * 2);
        const x = Math.cos(a) * rr;
        const y = Math.sin(a) * rr;
        frame.toPlanet(x, y, 20, _v1);
        pos[k * 3] = _v1.x;
        pos[k * 3 + 1] = _v1.y;
        pos[k * 3 + 2] = _v1.z;
        // Core lights are big and warm; the edges are small and sodium.
        const core = 1 - rr / (s.radius * 1.25);
        size[k] = (s.radius * 0.05 + 40) * (0.35 + core * 1.5) * rng.range(0.6, 1.5) * dark;
        const cool = rng.next() < 0.12 * civ.techLevel;
        tint[k * 3] = cool ? neon[0] * 0.7 + 0.2 : mix(1.0, 1.0, core);
        tint[k * 3 + 1] = cool ? neon[1] * 0.7 + 0.2 : mix(0.52, 0.74, core);
        tint[k * 3 + 2] = cool ? neon[2] * 0.7 + 0.2 : mix(0.18, 0.42, core);
        seed[k] = rng.next();
        k++;
      }
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aSize', new BufferAttribute(size, 1));
    g.setAttribute('aTint', new BufferAttribute(tint, 3));
    g.setAttribute('aSeed', new BufferAttribute(seed, 1));
    g.computeBoundingSphere();

    const p = new Points(g, this.mats!.lights);
    p.frustumCulled = false;
    p.renderOrder = 12;
    // Blending is additive and depth-tested against the terrain, so lights on
    // the far side of the world are correctly hidden by the planet itself.
    (this.mats!.lights as any).blending = AdditiveBlending;
    this.orbitalLights = p;
    this.root.add(p);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Collision
     ═══════════════════════════════════════════════════════════════════════ */

  collideCapsule(localPosition: Vector3, radius: number, height: number): Vector3 | null {
    for (const s of this.places) {
      if (s.stage !== 'ready' || !s.frame || !s.obstacles.length) continue;
      if (s.center.distanceTo(localPosition) > s.site.radius * 1.8) continue;

      const p = s.frame.toLocal(localPosition, _v2);
      const px = p.x;
      const py = p.y;
      const pz = p.z;

      for (const o of s.obstacles) {
        // Vertical first: cheapest rejection, and it lets the player stand on
        // a roof without being shoved off it.
        if (pz > o.z1 || pz + height < o.z0) continue;
        const dx = px - o.x;
        const dy = py - o.y;
        if (dx * dx + dy * dy > (o.hu + o.hv + radius) * (o.hu + o.hv + radius)) continue;

        // Into the box's own axes, then the standard 2-D box push-out.
        const u = dx * o.ux + dy * o.uy;
        const v = -dx * o.uy + dy * o.ux;
        const eu = o.hu + radius - Math.abs(u);
        const ev = o.hv + radius - Math.abs(v);
        if (eu <= 0 || ev <= 0) continue;

        // Leave along the shallower axis: that is the wall you actually hit.
        let nu = 0;
        let nv = 0;
        if (eu < ev) nu = u >= 0 ? eu : -eu;
        else nv = v >= 0 ? ev : -ev;

        const gx = nu * o.ux - nv * o.uy;
        const gy = nu * o.uy + nv * o.ux;
        return _v3
          .copy(s.frame.east)
          .multiplyScalar(gx)
          .addScaledVector(s.frame.north, gy)
          .clone();
      }
    }
    return null;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Housekeeping
     ═══════════════════════════════════════════════════════════════════════ */

  setQuality(q: QualityProfile): void {
    const next = CAPS_BY_TIER[q.tier] ?? CAPS_BY_TIER.high;
    const changed = next.maxBuildings !== this.caps.maxBuildings;
    this.caps = next;
    if (this.mats) this.mats.city.uniforms.uInterior.value = q.tier === 'low' ? 0 : 1;
    // A tier change mid-flight rebuilds what is already up, but only what is
    // up — the rest simply builds at the new budget when you get there.
    if (changed) for (const s of this.places) if (s.stage === 'ready') this.demolish(s);
  }

  /** Diagnostic, for the screenshot harness. */
  stats(): Record<string, unknown> {
    return {
      sites: this.sites.length,
      built: this.places.filter((s) => s.stage === 'ready').length,
      building: this.places.find((s) => s.stage !== 'cold' && s.stage !== 'ready')?.site.name ?? null,
      progress: Number((this.places.find((s) => s.stage !== 'cold' && s.stage !== 'ready')?.progress ?? 0).toFixed(2)),
      buildings: this.places.reduce((a, s) => a + (s.layout?.buildings.length ?? 0), 0),
      night: Number(this.lighting.night.toFixed(2)),
    };
  }

  dispose(): void {
    for (const s of this.places) this.demolish(s);
    this.places = [];
    this.sites = [];
    if (this.orbitalLights) {
      this.root.remove(this.orbitalLights);
      this.orbitalLights.geometry.dispose();
      this.orbitalLights = null;
    }
    if (this.mats) {
      for (const m of Object.values(this.mats)) m.dispose();
      this.mats = null;
    }
    this.matList = [];
    this.glyphs?.dispose();
    this.glyphs = null;
    this.sunLight = null;
    this.planet = null;
  }
}

/**
 * How much of the global building budget one settlement deserves. A hamlet next
 * to a megacity should not get the same allowance just for being in range.
 */
function sizeShare(s: Site): number {
  return clamp01(
    s.kind === 'megacity' ? 1 :
    s.kind === 'city' ? 0.6 :
    s.kind === 'port' ? 0.45 :
    s.kind === 'town' ? 0.22 :
    s.kind === 'ruin' ? 0.2 :
    s.kind === 'farm' ? 0.1 : 0.08
  );
}

const _v0 = new Vector3();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _size = new Vector2();
