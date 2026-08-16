/**
 * Cities, towns and the people who built them.
 *
 * Settlements are placed by scoring the world the way settlers would: flat
 * buildable ground, fresh water, coastal access, a temperate latitude. Sizes
 * follow a rank-size (Zipf) distribution, which is how real settlement systems
 * actually distribute — one dominant city, a couple of rivals, a long tail of
 * towns.
 *
 * Each city is generated as a radial street network with height falling off
 * from the centre, then built as instanced massing so a skyline costs a handful
 * of draw calls. Windows are emissive and individually hashed, so at night the
 * pattern looks lived-in rather than printed.
 */

import {
  BoxGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import type { ICivilization, IPlanet, SettlementInfo, SystemContext } from '../api/Contracts';
import type { QualityProfile } from '../core/Settings';
import { Rng, hashCombine } from '../core/Rand';
import { saturate, smoothstep } from '../core/Noise';
import { cityName } from '../universe/Names';

interface Settlement extends SettlementInfo {
  seed: number;
  built: boolean;
  group: Group | null;
  /** World-space centre, planet-local metres. */
  center: Vector3;
  style: string;
}

const KIND_BY_RANK: SettlementInfo['kind'][] = ['megacity', 'city', 'city', 'town', 'town', 'town', 'outpost'];

export class Civilization implements ICivilization {
  readonly root = new Group();

  private planet: IPlanet | null = null;
  private sites: Settlement[] = [];
  private viewer = new Vector3();
  private quality: QualityProfile | null = null;
  private materials: MeshStandardMaterial[] = [];
  private time = 0;

  attach(planet: IPlanet): void {
    this.dispose();
    this.planet = planet;
    const civ = planet.spec.civilization;
    if (!civ.present) return;

    const rng = new Rng(planet.spec.seed ^ 0x6c17);
    const R = planet.radius;

    /* ---- score candidate sites ---- */
    const candidates: { dir: Vector3; score: number }[] = [];
    const N = 2600;
    for (let i = 0; i < N; i++) {
      // Golden-angle spiral: even coverage of the sphere with no pole bunching.
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const t = i * 2.399963;
      const d = new Vector3(Math.cos(t) * r, y, Math.sin(t) * r);

      const s = planet.sampleSurface(d);
      if (s.underwater) continue;
      const h = s.elevation;
      const seaR = planet.seaLevelRadius();
      const above = seaR > 0 ? R + h - seaR : h;
      if (above < 1) continue;

      let score = 0;
      // Flat ground is buildable; cliffs are not.
      score += (1 - saturate(s.slope / 0.4)) * 5;
      // Temperate: people cluster where they neither freeze nor cook.
      score += (1 - Math.abs(s.temperature - 0.62) * 2.4) * 4;
      // Water access: the single strongest predictor of where cities are.
      if (seaR > 0) score += smoothstep(400, 30, above) * 5;
      // Some humidity, but not swamp.
      score += (1 - Math.abs(s.humidity - 0.55) * 2) * 2;
      // Avoid the extreme poles.
      score -= Math.abs(y) * 3;
      if (score > 0) candidates.push({ dir: d, score });
    }
    candidates.sort((a, b) => b.score - a.score);

    /* ---- place, with a minimum separation ---- */
    const want = Math.min(civ.cityCount, 24);
    const minSep = R * 0.05;
    let rank = 0;
    for (const c of candidates) {
      if (this.sites.length >= want) break;
      let ok = true;
      for (const s of this.sites) {
        if (c.dir.distanceTo(s.direction) * R < minSep) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      // Zipf: population of rank k is roughly P1/k.
      const pop = Math.max(120, Math.floor(civ.population / (rank + 1) / Math.max(1, want * 0.35)));
      const kind = KIND_BY_RANK[Math.min(rank, KIND_BY_RANK.length - 1)];
      const radius =
        kind === 'megacity' ? rng.range(1800, 4200)
        : kind === 'city' ? rng.range(900, 1900)
        : kind === 'town' ? rng.range(320, 780)
        : rng.range(90, 260);

      const h = planet.heightAt(c.dir);
      this.sites.push({
        name: cityName(rng, [c.dir.x * 1000, c.dir.y * 1000, c.dir.z * 1000]),
        direction: c.dir.clone(),
        radius,
        population: pop,
        kind,
        seed: hashCombine(planet.spec.seed, rank, 0x51ed),
        built: false,
        group: null,
        center: c.dir.clone().multiplyScalar(R + h),
        style: civ.style,
      });
      rank++;
    }
  }

  setViewer(localPosition: Vector3): void {
    this.viewer.copy(localPosition);
  }

  settlements(): SettlementInfo[] {
    return this.sites;
  }

  nearest(direction: Vector3): SettlementInfo | null {
    let best: Settlement | null = null;
    let bestD = Infinity;
    for (const s of this.sites) {
      const d = s.direction.distanceTo(direction);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    // Only claim you are "in" a place if you are actually near it.
    if (!best || !this.planet) return null;
    const metres = bestD * this.planet.radius;
    return metres < best.radius * 3 ? best : null;
  }

  update(dt: number, ctx: SystemContext): void {
    if (!this.planet) return;
    this.time += dt;
    const civ = this.planet.spec.civilization;

    // Build the nearest unbuilt city, one per frame at most.
    let target: Settlement | null = null;
    let bestD = Infinity;
    for (const s of this.sites) {
      const d = s.center.distanceTo(this.viewer);
      if (d < s.radius * 14 && !s.built && d < bestD) {
        bestD = d;
        target = s;
      }
      // Retire cities you have left, so a long flight does not accumulate them.
      if (s.built && d > s.radius * 22) this.demolish(s);
    }
    if (target) this.buildCity(target, civ);

    // Night lighting: windows come on as the sun goes down.
    const dir = _a.copy(this.viewer).normalize();
    const night = saturate(-this.sunDot(dir) * 2.4);
    for (const m of this.materials) {
      if ((m as any).__isWindow) m.emissiveIntensity = 0.05 + night * 2.6;
    }
  }

  private sunDot(dir: Vector3): number {
    // The realm drives the sun; approximate from the scene's directional light
    // if present, otherwise assume noon.
    const l = (this.root.parent?.children ?? []).find((o: any) => o.isDirectionalLight) as any;
    if (!l) return 1;
    return _b.copy(l.position).normalize().dot(dir);
  }

  private buildCity(s: Settlement, civ: any): void {
    const planet = this.planet!;
    const R = planet.radius;
    const rng = new Rng(s.seed);
    const group = new Group();

    const structure = new Color(...civ.structure);
    const neon = new Color(...civ.neon);

    const wall = new MeshStandardMaterial({ color: structure, roughness: 0.86, metalness: 0.06 });
    const trim = new MeshStandardMaterial({
      color: structure.clone().multiplyScalar(0.6),
      roughness: 0.7,
      metalness: 0.25,
    });
    const window = new MeshStandardMaterial({
      color: new Color(0.04, 0.04, 0.05),
      emissive: neon,
      emissiveIntensity: 1.4,
      roughness: 0.35,
      metalness: 0.1,
    });
    (window as any).__isWindow = true;
    this.materials.push(wall, trim, window);

    /* ---- tangent frame ---- */
    const up = s.direction.clone();
    const ref = Math.abs(up.y) > 0.94 ? _c.set(1, 0, 0) : _c.set(0, 1, 0);
    const tx = _d.crossVectors(ref, up).normalize().clone();
    const tz = _e.crossVectors(up, tx).normalize().clone();

    /* ---- lay out parcels on a radial street plan ---- */
    const density = this.quality?.scatterDensity ?? 1;
    const rings = Math.max(3, Math.round(s.radius / 90));
    const parcels: { x: number; z: number; w: number; d: number; rot: number; dist: number }[] = [];
    for (let ring = 1; ring <= rings; ring++) {
      const rr = (ring / rings) * s.radius;
      // Circumference grows with radius, so the outer rings hold more lots —
      // which is exactly why real radial cities have wedge-shaped blocks.
      const slots = Math.max(6, Math.round((2 * Math.PI * rr) / 46));
      for (let k = 0; k < slots; k++) {
        if (rng.next() > 0.62 * density + 0.25) continue;
        const a = (k / slots) * Math.PI * 2 + rng.range(-0.02, 0.02);
        const jitter = rng.range(-14, 14);
        const x = Math.cos(a) * (rr + jitter);
        const z = Math.sin(a) * (rr + jitter);
        parcels.push({
          x,
          z,
          w: rng.range(11, 26),
          d: rng.range(11, 26),
          rot: a + Math.PI / 2 + rng.range(-0.08, 0.08),
          dist: rr / s.radius,
        });
      }
    }
    if (!parcels.length) {
      s.built = true;
      s.group = group;
      return;
    }

    /* ---- massing ---- */
    const box = new BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0); // pivot at the base
    const count = parcels.length;
    const wallMesh = new InstancedMesh(box, wall, count);
    const winMesh = new InstancedMesh(box, window, count);
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;

    const tallest = s.kind === 'megacity' ? 210 : s.kind === 'city' ? 95 : s.kind === 'town' ? 22 : 9;
    let n = 0;
    for (const p of parcels) {
      // Height falls off from the centre with noise — the shape of every real
      // skyline, and the reason a city reads as a city from ten km out.
      const falloff = Math.pow(1 - p.dist, 1.7);
      let hgt = tallest * falloff * rng.range(0.35, 1.15) + rng.range(4, 10);
      if (civ.style === 'arcology') hgt *= p.dist < 0.25 ? 2.4 : 0.4;
      if (civ.style === 'nomadic') hgt = Math.min(hgt, 9);
      if (civ.style === 'hive') hgt *= rng.range(0.6, 1.5);
      hgt *= 1 - civ.decay * rng.range(0, 0.7);

      // Sit each building on the actual ground under it.
      _p.copy(up).addScaledVector(tx, p.x / R).addScaledVector(tz, p.z / R).normalize();
      const gh = planet.heightAt(_p);
      _p.multiplyScalar(R + gh);

      _q.setFromUnitVectors(_yAxis, _n.copy(_p).normalize());
      _q2.setFromAxisAngle(_yAxis, p.rot);
      _q.multiply(_q2);

      _m.compose(_p, _q, _s.set(p.w, hgt, p.d));
      wallMesh.setMatrixAt(n, _m);

      // A slightly inset, slightly shorter twin carries the lit windows.
      _m.compose(_p, _q, _s.set(p.w * 1.006, hgt * 0.94, p.d * 0.86));
      winMesh.setMatrixAt(n, _m);
      n++;
    }
    wallMesh.count = n;
    winMesh.count = n;
    wallMesh.instanceMatrix.needsUpdate = true;
    winMesh.instanceMatrix.needsUpdate = true;
    group.add(wallMesh, winMesh);

    /* ---- a landmark, so the place has a centre worth walking to ---- */
    if (s.kind === 'megacity' || s.kind === 'city') {
      const spire = new BoxGeometry(1, 1, 1);
      spire.translate(0, 0.5, 0);
      const m = new InstancedMesh(spire, trim, 1);
      _p.copy(up).normalize();
      const gh = planet.heightAt(_p);
      _p.multiplyScalar(R + gh);
      _q.setFromUnitVectors(_yAxis, up);
      _m.compose(_p, _q, _s.set(26, tallest * 2.1, 26));
      m.setMatrixAt(0, _m);
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = true;
      group.add(m);
    }

    this.root.add(group);
    s.group = group;
    s.built = true;
  }

  private demolish(s: Settlement): void {
    if (!s.group) return;
    this.root.remove(s.group);
    s.group.traverse((o: any) => o.geometry?.dispose?.());
    s.group = null;
    s.built = false;
  }

  collideCapsule(localPosition: Vector3, radius: number, height: number): Vector3 | null {
    // Buildings are boxes on a tangent plane; a cheap radial test against the
    // instanced centres is enough to stop the player walking through a wall.
    for (const s of this.sites) {
      if (!s.built || !s.group) continue;
      if (s.center.distanceTo(localPosition) > s.radius * 1.6) continue;
      for (const child of s.group.children) {
        const im = child as InstancedMesh;
        if (!(im as any).isInstancedMesh) continue;
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, _m);
          _p.setFromMatrixPosition(_m);
          _s.setFromMatrixScale(_m);
          const rr = Math.max(_s.x, _s.z) * 0.5;
          const d = _p.distanceTo(localPosition);
          if (d < rr + radius && d > 1e-4) {
            return _n.subVectors(localPosition, _p).normalize().multiplyScalar(rr + radius - d).clone();
          }
        }
        break; // walls only; the window shell is coincident
      }
    }
    return null;
  }

  setQuality(q: QualityProfile): void {
    this.quality = q;
  }

  dispose(): void {
    for (const s of this.sites) this.demolish(s);
    this.sites = [];
    for (const m of this.materials) m.dispose();
    this.materials = [];
  }
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _p = new Vector3();
const _n = new Vector3();
const _s = new Vector3();
const _yAxis = new Vector3(0, 1, 0);
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();
