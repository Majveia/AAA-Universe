/**
 * Procedural flora.
 *
 * There are no model files in ÆON and there never will be, so every plant on
 * every world is grown here from a recursive branch generator whose parameters
 * are read off the PlanetSpec:
 *
 *   gravity      → trunk thickness, branch droop, maximum height
 *   windSpeed    → flexibility, and how far a branch is allowed to lean
 *   palette      → leaf and bark colour, bioluminescent accents
 *   biodiversity → how many species, and how strange they are allowed to be
 *   klass        → morphology: broadleaf, conifer, sail, spiral, bulb, crystal
 *
 * The intent is that a botanist dropped on any two ÆON worlds could tell them
 * apart instantly. A high-gravity world grows squat, thick-limbed, down-swept
 * trees; a low-gravity world grows absurd cantilevered spires and tethered
 * floating bulbs that would snap under their own weight anywhere heavier.
 */

import { Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { Rng } from '../core/Rand';
import { BIOME_IDS } from '../api/Contracts';
import type { PlanetSpec } from '../universe/Types';
import {
  addBlade,
  addFan,
  addImpostorCross,
  extrudeBranch,
  icosphere,
  MeshBuf,
  tangentFrame,
  type Frame,
} from './Geo';

/* ═══════════════════════════════════════════════════════════════════════════
   Species description
   ═══════════════════════════════════════════════════════════════════════════ */

export type FloraLayer = 'ground' | 'under' | 'bush' | 'tree' | 'special';

export interface FloraSpecies {
  id: string;
  layer: FloraLayer;
  /** Bitmask over BIOME_IDS. */
  biomes: number;
  /** Linear-sRGB primary colour; per-instance jitter is applied on placement. */
  color: [number, number, number];
  colorVar: number;
  /** Metres, before per-instance scale. */
  height: number;
  /** Horizontal extent in metres, for collision and impostor sizing. */
  radius: number;
  /** Instance scale range. */
  scale: [number, number];
  /** Solid enough to walk into. */
  solid: boolean;
  /** 0–1 how strongly this species glows at night. */
  glow: number;
  /** Prefers wet ground (near ocean, high humidity). */
  wet: number;
  /** Max terrain slope, 0–1. */
  slopeMax: number;
  /** Built lazily per LOD. */
  lods: BufferGeometry[];
}

const B = BIOME_IDS;
const mask = (...ids: number[]): number => ids.reduce((a, i) => a | (1 << i), 0);

const ALL_LAND = mask(
  B.BEACH, B.DESERT, B.GRASSLAND, B.FOREST, B.JUNGLE, B.TAIGA, B.TUNDRA,
  B.GLACIER, B.ROCK, B.LAVA, B.SALT_FLAT, B.CRYSTAL, B.MUSHROOM, B.ALKALI, B.BADLANDS,
);
const VERDANT = mask(B.GRASSLAND, B.FOREST, B.JUNGLE, B.TAIGA);
const WARM_WET = mask(B.JUNGLE, B.FOREST);
const COLD = mask(B.TAIGA, B.TUNDRA, B.GLACIER);
const ARID = mask(B.DESERT, B.BADLANDS, B.SALT_FLAT, B.ROCK);

/* ═══════════════════════════════════════════════════════════════════════════
   Growth parameters
   ═══════════════════════════════════════════════════════════════════════════ */

export type LeafKind = 'blade' | 'frond' | 'fan' | 'needle' | 'disc' | 'bulb' | 'sail' | 'spike';

interface TreeParams {
  height: number;
  trunkRadius: number;
  levels: number;
  splits: number;
  splitAngle: number;
  splitSpread: number;
  /** Downward bend accumulated along a branch, radians per metre. */
  droop: number;
  /** Upward gravitropism — young shoots reaching for the star. */
  reach: number;
  curve: number;
  wander: number;
  lengthFalloff: number;
  radiusFalloff: number;
  flexibility: number;
  leaf: LeafKind;
  leafSize: number;
  leafCount: number;
  leafGlow: number;
  sides: number;
  /** Palms and tree-ferns: foliage only at the crown. */
  crownOnly: boolean;
  /** Conifers: this many branches per whorl, this many whorls. */
  whorl: number;
  whorls: number;
  /** Fraction of the trunk that is bare before the first branch. */
  clear: number;
}

const _up = new Vector3(0, 1, 0);

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/* ═══════════════════════════════════════════════════════════════════════════
   The recursive grower
   ═══════════════════════════════════════════════════════════════════════════ */

const _d = new Vector3();
const _r = new Vector3();
const _b = new Vector3();
const _tmp = new Vector3();
const _tmp2 = new Vector3();

function growBranch(
  buf: MeshBuf,
  rng: Rng,
  P: TreeParams,
  detail: number,
  start: Vector3,
  dirIn: Vector3,
  length: number,
  radius: number,
  level: number,
  swayBase: number,
  phase: number,
): void {
  const segs = detail === 0 ? Math.max(3, 8 - level * 2) : Math.max(2, 4 - level);
  const sides = Math.max(3, P.sides - level - (detail > 0 ? 1 : 0));

  const pos = _tmp.copy(start).clone();
  const dir = _d.copy(dirIn).normalize().clone();
  const right = new Vector3();
  const bit = new Vector3();
  tangentFrame(dir, right, bit);

  // A thin branch is a whip; a trunk is a mast. Sway at the tip scales with how
  // far this branch has fallen off the trunk's thickness.
  const thinness = clamp(1 - radius / Math.max(1e-4, P.trunkRadius), 0, 1);
  const swayTip = clamp(swayBase + (0.16 + 0.55 * thinness + 0.18 * level) * P.flexibility, swayBase, 1);

  const frames: Frame[] = [];
  const step = length / segs;
  const childAt: { pos: Vector3; dir: Vector3; t: number; sway: number }[] = [];

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const sway = swayBase + (swayTip - swayBase) * Math.pow(t, 1.55);
    frames.push({
      pos: pos.clone(),
      dir: dir.clone(),
      right: right.clone(),
      radius: radius * (1 - 0.86 * t) + radius * 0.06,
      t,
      sway,
      tint: 0,
      glow: 0,
    });

    if (i === segs) break;

    // Integrate the path. Droop pulls the branch down under its own weight;
    // reach pulls it back up toward the light. The balance between them is what
    // separates a willow from a poplar, and it falls out of gravity directly.
    const grav = -P.droop * step * (0.35 + t);
    const reach = P.reach * step * (1 - t * 0.5);
    dir.y += grav + reach * (1 - Math.abs(dir.y));
    _tmp2.copy(right).multiplyScalar(Math.sin(t * 6.28 * P.curve) * P.curve * step * 0.8);
    dir.add(_tmp2);
    dir.x += rng.range(-1, 1) * P.wander * step;
    dir.z += rng.range(-1, 1) * P.wander * step;
    dir.normalize();
    right.crossVectors(dir, bit).normalize();
    bit.crossVectors(right, dir).normalize();
    pos.addScaledVector(dir, step);

    if (level < P.levels && t >= P.clear) {
      childAt.push({ pos: pos.clone(), dir: dir.clone(), t, sway });
    }
  }

  extrudeBranch(buf, frames, sides, phase, true);

  /* ---- children ---- */
  if (level < P.levels && childAt.length > 0) {
    const wantSplits = detail === 0 ? P.splits : Math.max(1, P.splits - 1);
    const golden = 2.39996; // phyllotaxis: the angle real plants actually use
    let a = rng.next() * 6.283;
    for (let s = 0; s < wantSplits; s++) {
      const pick = childAt[Math.min(childAt.length - 1, Math.floor((s / wantSplits) * childAt.length + rng.range(0, 0.9)))];
      a += golden + rng.range(-0.4, 0.4);
      const spread = P.splitAngle + rng.range(-P.splitSpread, P.splitSpread);

      // Build the child direction by tilting the parent tangent away from itself.
      tangentFrame(pick.dir, _r, _b);
      _tmp2.copy(_r).multiplyScalar(Math.cos(a)).addScaledVector(_b, Math.sin(a));
      const cd = new Vector3()
        .copy(pick.dir)
        .multiplyScalar(Math.cos(spread))
        .addScaledVector(_tmp2, Math.sin(spread))
        .normalize();

      const cl = length * P.lengthFalloff * rng.range(0.72, 1.12) * (1 - pick.t * 0.35);
      const cr = radius * P.radiusFalloff * rng.range(0.78, 1.06);
      if (cl < 0.05 || cr < 0.004) continue;
      growBranch(buf, rng, P, detail, pick.pos, cd, cl, cr, level + 1, pick.sway, phase + s * 0.41 + level * 1.13);
    }
  }

  /* ---- foliage ---- */
  const isTip = level >= P.levels;
  const wantLeaves = P.crownOnly ? level === 0 && P.levels === 0 : isTip || (level === P.levels - 1 && !P.crownOnly && P.leafCount > 6);
  if (wantLeaves && P.leafCount > 0) {
    const n = detail === 0 ? P.leafCount : Math.max(2, Math.round(P.leafCount * 0.45));
    const golden = 2.39996;
    let a = rng.next() * 6.283;
    for (let i = 0; i < n; i++) {
      const t = P.crownOnly ? 1 : 0.32 + 0.68 * (i / Math.max(1, n - 1));
      const fi = Math.min(frames.length - 1, Math.floor(t * (frames.length - 1)));
      const fr = frames[fi];
      a += golden;
      tangentFrame(fr.dir, _r, _b);
      _tmp2.copy(_r).multiplyScalar(Math.cos(a)).addScaledVector(_b, Math.sin(a));
      const tilt = P.crownOnly ? rng.range(0.85, 1.35) : rng.range(0.5, 1.15);
      const ld = new Vector3()
        .copy(fr.dir)
        .multiplyScalar(Math.cos(tilt))
        .addScaledVector(_tmp2, Math.sin(tilt))
        .normalize();
      const side = new Vector3().crossVectors(ld, fr.dir).normalize();
      if (side.lengthSq() < 0.1) side.copy(_r);
      const sz = P.leafSize * rng.range(0.75, 1.3);
      addLeaf(buf, P.leaf, fr.pos, ld, side, sz, phase + i * 0.29, clamp(fr.sway + 0.18, 0, 1), P.leafGlow, detail, rng);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Leaves
   ═══════════════════════════════════════════════════════════════════════════ */

function addLeaf(
  buf: MeshBuf,
  kind: LeafKind,
  origin: Vector3,
  dir: Vector3,
  side: Vector3,
  size: number,
  phase: number,
  sway: number,
  glow: number,
  detail: number,
  rng: Rng,
): void {
  const segs = detail === 0 ? 3 : 2;
  switch (kind) {
    case 'blade':
      addBlade(buf, origin, dir, side, size, size * 0.16, segs, 0.45, phase, 0.72, 1.0, glow, 0.55);
      break;

    case 'disc':
      addFan(buf, origin, dir, side, size * 0.7, Math.PI * 1.9, detail === 0 ? 8 : 5, 0.22, phase, 0.8, 1.0, glow);
      break;

    case 'fan':
      addFan(buf, origin, dir, side, size, Math.PI * 0.95, detail === 0 ? 9 : 5, 0.35, phase, 0.7, 1.0, glow);
      break;

    case 'sail': {
      // A photosynthetic sail: one broad membrane held rigid by radial veins.
      addFan(buf, origin, dir, side, size * 1.6, Math.PI * 0.75, detail === 0 ? 11 : 6, 0.12, phase, 0.55, 1.0, glow);
      if (detail === 0) {
        const veins = 3;
        for (let v = 0; v < veins; v++) {
          const a = (v / (veins - 1) - 0.5) * Math.PI * 0.6;
          _tmp.copy(dir).multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a)).normalize();
          addBlade(buf, origin, _tmp, side, size * 1.55, size * 0.035, 2, 0.1, phase, 0.2, 0.4, glow * 1.6, 0.4);
        }
      }
      break;
    }

    case 'needle': {
      // A whorl of stiff needles — conifers, and anything that had to survive ice.
      const n = detail === 0 ? 7 : 4;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
        tangentFrame(dir, _r, _b);
        _tmp.copy(_r).multiplyScalar(Math.cos(a)).addScaledVector(_b, Math.sin(a));
        _tmp2.copy(dir).multiplyScalar(0.55).addScaledVector(_tmp, 0.85).normalize();
        addBlade(buf, origin, _tmp2, side, size, size * 0.055, 1, 0.12, phase, 0.8, 1.0, glow, 0.7);
      }
      break;
    }

    case 'frond': {
      // Pinnate: a rachis with paired leaflets. Ferns, palms, alien equivalents.
      const rachis: Frame[] = [];
      const n = detail === 0 ? 7 : 4;
      const d2 = _tmp.copy(dir).normalize().clone();
      const p2 = origin.clone();
      const rt = new Vector3();
      const bt = new Vector3();
      tangentFrame(d2, rt, bt);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        rachis.push({
          pos: p2.clone(),
          dir: d2.clone(),
          right: rt.clone(),
          radius: size * 0.022 * (1 - t * 0.8),
          t,
          sway: sway * (0.4 + 0.6 * t),
          tint: 0.15,
          glow: glow * 0.4,
        });
        d2.y -= 0.09;
        d2.normalize();
        p2.addScaledVector(d2, size / n);
      }
      extrudeBranch(buf, rachis, 3, phase, false);
      for (let i = 1; i <= n; i++) {
        const fr = rachis[i];
        const ls = size * 0.42 * Math.sin((i / n) * Math.PI * 0.95 + 0.3);
        for (const s of [-1, 1]) {
          _tmp2.copy(fr.dir).multiplyScalar(0.45).addScaledVector(side, 0.9 * s).normalize();
          addBlade(buf, fr.pos, _tmp2, fr.dir, ls, ls * 0.13, segs, 0.4, phase + i * 0.2, 0.75, 1.0, glow, 0.5);
        }
      }
      break;
    }

    case 'bulb': {
      // A gas bladder on a tether. Reads as impossible, which is the point.
      const tether: Frame[] = [];
      const d2 = _tmp.copy(dir).normalize().clone();
      const p2 = origin.clone();
      const rt = new Vector3();
      const bt = new Vector3();
      tangentFrame(d2, rt, bt);
      const n = detail === 0 ? 4 : 2;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        tether.push({
          pos: p2.clone(),
          dir: d2.clone(),
          right: rt.clone(),
          radius: size * 0.016,
          t,
          sway: sway * 0.5 + 0.5 * t,
          tint: 0.1,
          glow: glow * 0.5,
        });
        p2.addScaledVector(d2, size / n);
      }
      extrudeBranch(buf, tether, 3, phase, false);
      addSphere(buf, p2, size * 0.34, detail === 0 ? 1 : 0, 1.0, 1.0, phase, glow);
      break;
    }

    case 'spike':
    default:
      addBlade(buf, origin, dir, side, size * 0.8, size * 0.06, 1, 0.05, phase, 0.5, 0.9, glow, 0.8);
      break;
  }
}

/** Displaced icosphere blob — bulbs, berries, mushroom caps, fruiting bodies. */
export function addSphere(
  buf: MeshBuf,
  center: Vector3,
  radius: number,
  subdiv: number,
  sway: number,
  tint: number,
  phase: number,
  glow: number,
  squashY = 1,
): void {
  const { positions, faces } = icosphere(subdiv);
  const base = buf.count;
  for (const p of positions) {
    buf.vert(
      center.x + p.x * radius,
      center.y + p.y * radius * squashY,
      center.z + p.z * radius,
      p.x, p.y, p.z,
      sway, tint, phase, glow,
    );
  }
  for (const f of faces) buf.tri(base + f[0], base + f[1], base + f[2]);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Small plants
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A tuft of grass. Everything about a grass field's readability lives in three
 * numbers: blade count (silhouette density), curve (the bow that catches light
 * on the outer edge) and the normal lift in addBlade (which stops a low camera
 * seeing a field of black cardboard).
 */
function buildGrassTuft(rng: Rng, detail: number, blades: number, height: number, width: number, curve: number, glow: number): MeshBuf {
  const buf = new MeshBuf();
  const n = detail === 0 ? blades : Math.max(1, Math.round(blades * 0.4));
  const segs = detail === 0 ? 3 : 1;
  const origin = new Vector3();
  const dir = new Vector3();
  const side = new Vector3();
  for (let i = 0; i < n; i++) {
    const a = rng.next() * 6.283;
    const rad = rng.next() * 0.06 * height;
    origin.set(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    const lean = rng.range(0.06, 0.3);
    const la = rng.next() * 6.283;
    dir.set(Math.cos(la) * lean, 1, Math.sin(la) * lean).normalize();
    side.set(-Math.sin(la), 0, Math.cos(la));
    const h = height * rng.range(0.62, 1.15);
    addBlade(buf, origin, dir, side, h, width * rng.range(0.8, 1.25), segs, curve * rng.range(0.7, 1.4), i * 0.37, 0.55, 1.0, glow, 0.85);
  }
  return buf;
}

/** A low rosette — succulents, alien cabbages, ice lichen. */
function buildRosette(rng: Rng, detail: number, leaves: number, size: number, thick: number, kind: LeafKind, glow: number): MeshBuf {
  const buf = new MeshBuf();
  const n = detail === 0 ? leaves : Math.max(3, Math.round(leaves * 0.5));
  const origin = new Vector3();
  const dir = new Vector3();
  const side = new Vector3();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.283 + rng.range(-0.2, 0.2);
    const tilt = rng.range(0.55, 1.15);
    dir.set(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt)).normalize();
    side.set(-Math.sin(a), 0, Math.cos(a));
    if (kind === 'fan') addFan(buf, origin, dir, side, size, 0.9, detail === 0 ? 6 : 4, 0.3, i * 0.31, 0.6, 1.0, glow);
    else addBlade(buf, origin, dir, side, size, size * thick, detail === 0 ? 3 : 2, 0.55, i * 0.31, 0.6, 1.0, glow, 0.6);
  }
  return buf;
}

/** Stem, calyx, petals, glowing pistil. Small, but it is what you notice. */
function buildFlower(rng: Rng, detail: number, height: number, petalSize: number, petals: number, glow: number): MeshBuf {
  const buf = new MeshBuf();
  const stem: Frame[] = [];
  const p = new Vector3();
  const d = new Vector3(rng.range(-0.14, 0.14), 1, rng.range(-0.14, 0.14)).normalize();
  const r = new Vector3();
  const b = new Vector3();
  tangentFrame(d, r, b);
  const segs = detail === 0 ? 4 : 2;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    stem.push({ pos: p.clone(), dir: d.clone(), right: r.clone(), radius: height * 0.014 * (1 - t * 0.4), t, sway: Math.pow(t, 1.4), tint: 0.1, glow: 0 });
    d.x += rng.range(-0.05, 0.05);
    d.z += rng.range(-0.05, 0.05);
    d.normalize();
    p.addScaledVector(d, height / segs);
  }
  extrudeBranch(buf, stem, 3, 0.5, false);

  const n = detail === 0 ? petals : Math.max(3, petals - 2);
  const side = new Vector3();
  const pd = new Vector3();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.283;
    const tilt = 0.85;
    pd.set(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt)).normalize();
    side.set(-Math.sin(a), 0, Math.cos(a));
    addBlade(buf, p, pd, side, petalSize, petalSize * 0.42, 2, 0.5, i * 0.4, 0.85, 1.0, glow * 0.5, 0.6);
  }
  addSphere(buf, p, petalSize * 0.22, 0, 1.0, 1.0, 0.5, Math.max(glow, 0.85), 0.8);
  return buf;
}

/** A mushroom: swollen stalk, revolved cap, gill fringe underneath. */
function buildMushroom(rng: Rng, detail: number, height: number, capRadius: number, glow: number): MeshBuf {
  const buf = new MeshBuf();
  const segs = detail === 0 ? 7 : 4;
  const sides = detail === 0 ? 8 : 5;
  const stalk: Frame[] = [];
  const p = new Vector3();
  const d = new Vector3(rng.range(-0.1, 0.1), 1, rng.range(-0.1, 0.1)).normalize();
  const r = new Vector3();
  const b = new Vector3();
  tangentFrame(d, r, b);
  const baseR = capRadius * rng.range(0.16, 0.3);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    // Waisted profile: fat at the ground, pinched, flaring into the cap.
    const rr = baseR * (1.0 - 0.55 * Math.sin(t * Math.PI * 0.9)) * (1 + t * t * 0.5);
    stalk.push({ pos: p.clone(), dir: d.clone(), right: r.clone(), radius: rr, t, sway: Math.pow(t, 2.0) * 0.5, tint: 0.05, glow: glow * 0.25 });
    d.x += rng.range(-0.03, 0.03);
    d.normalize();
    p.addScaledVector(d, height / segs);
  }
  extrudeBranch(buf, stalk, sides, 0.2, false);

  // Cap: a revolved profile so the rim curls under, catching a rim light.
  const rings = detail === 0 ? 6 : 3;
  const capSides = detail === 0 ? 12 : 7;
  const ringIdx: number[] = [];
  const top = p.clone();
  for (let ri = 0; ri <= rings; ri++) {
    const t = ri / rings;
    const rad = capRadius * Math.sin(t * Math.PI * 0.62);
    const y = Math.cos(t * Math.PI * 0.5) * capRadius * 0.55 - (t > 0.8 ? (t - 0.8) * capRadius * 0.9 : 0);
    const start = buf.count;
    ringIdx.push(start);
    for (let s = 0; s <= capSides; s++) {
      const a = (s / capSides) * 6.283;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      buf.vert(
        top.x + nx * rad, top.y + y, top.z + nz * rad,
        nx * 0.5, 0.8, nz * 0.5,
        0.55, 1.0, 0.2, glow * (t > 0.75 ? 1.0 : 0.35),
      );
    }
    if (ri > 0) {
      const a0 = ringIdx[ri - 1];
      const a1 = ringIdx[ri];
      for (let s = 0; s < capSides; s++) buf.quad(a0 + s, a1 + s, a1 + s + 1, a0 + s + 1);
    }
  }
  // Gills: the underside is where the light lives on a glowing world.
  if (detail === 0) {
    const gills = 14;
    const dirv = new Vector3();
    const sidev = new Vector3();
    for (let i = 0; i < gills; i++) {
      const a = (i / gills) * 6.283;
      dirv.set(Math.cos(a), -0.12, Math.sin(a)).normalize();
      sidev.set(-Math.sin(a), 0, Math.cos(a));
      _tmp.copy(top).add(new Vector3(0, capRadius * 0.14, 0));
      addBlade(buf, _tmp, dirv, sidev, capRadius * 0.9, capRadius * 0.02, 1, 0.1, i * 0.3, 0.9, 1.0, Math.max(glow, 0.6), 0.2);
    }
  }
  return buf;
}

/** A ribbed columnar cactus with areole spines. */
function buildColumn(rng: Rng, detail: number, height: number, radius: number, ribs: number, arms: number, glow: number): MeshBuf {
  const buf = new MeshBuf();
  const segs = detail === 0 ? 10 : 5;
  const sides = detail === 0 ? Math.max(6, ribs) : 6;

  const column = (base: Vector3, dir: Vector3, h: number, rad: number, phase: number): Vector3 => {
    const frames: Frame[] = [];
    const p = base.clone();
    const d = dir.clone().normalize();
    const r = new Vector3();
    const b = new Vector3();
    tangentFrame(d, r, b);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const taper = 1 - Math.pow(t, 3.2) * 0.72;
      frames.push({ pos: p.clone(), dir: d.clone(), right: r.clone(), radius: rad * taper, t, sway: t * 0.16, tint: 0.9, glow });
      d.y += 0.02;
      d.normalize();
      p.addScaledVector(d, h / segs);
    }
    extrudeBranch(buf, frames, sides, phase, true);
    return p;
  };

  const tip = column(new Vector3(), _up, height, radius, 0.1);
  for (let a = 0; a < arms; a++) {
    const ang = rng.next() * 6.283;
    const t = rng.range(0.25, 0.55);
    const base = new Vector3(Math.cos(ang) * radius * 0.7, height * t, Math.sin(ang) * radius * 0.7);
    const d = new Vector3(Math.cos(ang) * 0.9, 0.5, Math.sin(ang) * 0.9).normalize();
    column(base, d, height * rng.range(0.3, 0.5), radius * 0.7, a * 0.7);
  }
  if (detail === 0) {
    const spines = 26;
    const dirv = new Vector3();
    const sidev = new Vector3();
    for (let i = 0; i < spines; i++) {
      const a = rng.next() * 6.283;
      const y = rng.range(0.08, 0.95) * height;
      const rad = radius * (1 - Math.pow(y / height, 3.2) * 0.72);
      _tmp.set(Math.cos(a) * rad, y, Math.sin(a) * rad);
      dirv.set(Math.cos(a), 0.25, Math.sin(a)).normalize();
      sidev.set(-Math.sin(a), 0, Math.cos(a));
      addBlade(buf, _tmp, dirv, sidev, radius * 0.45, radius * 0.02, 1, 0, i * 0.2, 0.05, 0.2, 0, 0.9);
    }
  }
  void tip;
  return buf;
}

/**
 * A spiral frond: a stem that coils as it climbs, leaflets on the outside of
 * the curve. Nothing on Earth looks like this, which is exactly why it belongs
 * on a world with a strange sun.
 */
function buildSpiral(rng: Rng, detail: number, height: number, coils: number, radius: number, leafSize: number, glow: number): MeshBuf {
  const buf = new MeshBuf();
  const segs = detail === 0 ? 34 : 16;
  const frames: Frame[] = [];
  const prev = new Vector3();
  const cur = new Vector3();
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = t * coils * 6.283;
    const rr = radius * (1 - t) * (1 - t);
    cur.set(Math.cos(a) * rr, height * t, Math.sin(a) * rr);
    const dir = i === 0 ? new Vector3(0, 1, 0) : new Vector3().subVectors(cur, prev).normalize();
    const right = new Vector3();
    const bb = new Vector3();
    tangentFrame(dir, right, bb);
    frames.push({ pos: cur.clone(), dir, right, radius: radius * 0.09 * (1 - t * 0.7), t, sway: Math.pow(t, 1.3), tint: 0.15, glow: glow * 0.3 });
    prev.copy(cur);
  }
  extrudeBranch(buf, frames, detail === 0 ? 5 : 3, 0.3, true);

  const n = detail === 0 ? 16 : 7;
  const side = new Vector3();
  for (let i = 0; i < n; i++) {
    const fi = Math.floor((i / n) * (frames.length - 1) * 0.95) + 1;
    const fr = frames[fi];
    _tmp.copy(fr.pos).normalize();
    _tmp.y = 0.35;
    _tmp.normalize();
    side.crossVectors(_tmp, fr.dir).normalize();
    addBlade(buf, fr.pos, _tmp, side, leafSize * (1 - fr.t * 0.5), leafSize * 0.2, detail === 0 ? 3 : 1, 0.55, i * 0.33, 0.75, 1.0, glow, 0.5);
  }
  return buf;
}

/** A crystalline growth: clustered tapered prisms. Alive on exotic worlds. */
function buildCrystalCluster(rng: Rng, detail: number, height: number, shards: number, glow: number): MeshBuf {
  const buf = new MeshBuf();
  const n = detail === 0 ? shards : Math.max(2, Math.round(shards * 0.5));
  const sides = 5;
  for (let s = 0; s < n; s++) {
    const a = rng.next() * 6.283;
    const lean = rng.range(0.1, 0.55);
    const h = height * rng.range(0.35, 1.0);
    const w = h * rng.range(0.07, 0.17);
    const base = new Vector3(Math.cos(a) * height * 0.18 * rng.next(), 0, Math.sin(a) * height * 0.18 * rng.next());
    const dir = new Vector3(Math.cos(a) * lean, 1, Math.sin(a) * lean).normalize();
    const right = new Vector3();
    const bit = new Vector3();
    tangentFrame(dir, right, bit);
    const frames: Frame[] = [];
    const steps = 3;
    const p = base.clone();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      frames.push({
        pos: p.clone(),
        dir: dir.clone(),
        right: right.clone(),
        radius: w * (1 - t * 0.88),
        t,
        sway: 0,
        tint: 1,
        // Crystal light sits in the body, brightest toward the tip.
        glow: glow * (0.35 + 0.65 * t),
      });
      p.addScaledVector(dir, h / steps);
    }
    extrudeBranch(buf, frames, sides, 0, true);
  }
  return buf;
}

/** Kelp / tube-coral: a limp ribbon that only makes sense underwater. */
function buildKelp(rng: Rng, detail: number, height: number, width: number, glow: number): MeshBuf {
  const buf = new MeshBuf();
  const blades = detail === 0 ? 5 : 2;
  const origin = new Vector3();
  const dir = new Vector3();
  const side = new Vector3();
  for (let i = 0; i < blades; i++) {
    const a = rng.next() * 6.283;
    dir.set(Math.cos(a) * 0.28, 1, Math.sin(a) * 0.28).normalize();
    side.set(-Math.sin(a), 0, Math.cos(a));
    addBlade(buf, origin, dir, side, height * rng.range(0.7, 1.15), width, detail === 0 ? 6 : 3, 0.75, i * 0.4, 0.6, 1.0, glow, 0.4);
  }
  return buf;
}

/** Coral fan: a branching plane, thin and lace-like. */
function buildCoralFan(rng: Rng, detail: number, size: number, glow: number): MeshBuf {
  const buf = new MeshBuf();
  const P: TreeParams = {
    height: size,
    trunkRadius: size * 0.05,
    levels: detail === 0 ? 4 : 2,
    splits: 2,
    splitAngle: 0.55,
    splitSpread: 0.2,
    droop: 0.0,
    reach: 0.5,
    curve: 0.2,
    wander: 0.05,
    lengthFalloff: 0.72,
    radiusFalloff: 0.6,
    flexibility: 0.35,
    leaf: 'spike',
    leafSize: size * 0.1,
    leafCount: detail === 0 ? 3 : 0,
    leafGlow: glow,
    sides: 4,
    crownOnly: false,
    whorl: 0,
    whorls: 0,
    clear: 0.15,
  };
  growBranch(buf, rng, P, detail, new Vector3(), _up, size * 0.55, size * 0.05, 0, 0, 0);
  return buf;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Tree assembly
   ═══════════════════════════════════════════════════════════════════════════ */

function buildTree(rng: Rng, P: TreeParams, detail: number): MeshBuf {
  const buf = new MeshBuf();
  if (P.whorl > 0) {
    // Conifer: a straight leader with whorls of near-horizontal branches whose
    // length falls off toward the top, giving the classic conic silhouette.
    const segs = detail === 0 ? 12 : 6;
    const frames: Frame[] = [];
    const p = new Vector3();
    const d = new Vector3(rng.range(-0.03, 0.03), 1, rng.range(-0.03, 0.03)).normalize();
    const r = new Vector3();
    const b = new Vector3();
    tangentFrame(d, r, b);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      frames.push({ pos: p.clone(), dir: d.clone(), right: r.clone(), radius: P.trunkRadius * (1 - t * 0.93), t, sway: t * t * 0.35 * P.flexibility, tint: 0, glow: 0 });
      d.x += rng.range(-0.012, 0.012);
      d.z += rng.range(-0.012, 0.012);
      d.normalize();
      p.addScaledVector(d, P.height / segs);
    }
    extrudeBranch(buf, frames, Math.max(4, P.sides - 1), 0, true);

    const whorls = detail === 0 ? P.whorls : Math.max(2, Math.round(P.whorls * 0.55));
    const per = detail === 0 ? P.whorl : Math.max(3, P.whorl - 2);
    for (let w = 0; w < whorls; w++) {
      const t = P.clear + (1 - P.clear) * (w / whorls);
      const fi = Math.min(frames.length - 1, Math.floor(t * (frames.length - 1)));
      const fr = frames[fi];
      const len = P.height * 0.42 * Math.pow(1 - t, 0.85) + P.height * 0.04;
      const a0 = rng.next() * 6.283;
      for (let i = 0; i < per; i++) {
        const a = a0 + (i / per) * 6.283;
        const droopA = 0.15 + t * 0.35 + P.droop * 0.1;
        const dir = new Vector3(Math.cos(a), -droopA, Math.sin(a)).normalize();
        growBranch(buf, rng, { ...P, levels: detail === 0 ? 1 : 0, splits: 2, leafCount: P.leafCount }, detail, fr.pos, dir, len, P.trunkRadius * 0.24 * (1 - t * 0.6), 1, fr.sway, w * 0.7 + i * 0.21);
      }
    }
    return buf;
  }

  growBranch(buf, rng, P, detail, new Vector3(), _up, P.height, P.trunkRadius, 0, 0, 0);
  return buf;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Species generation from a PlanetSpec
   ═══════════════════════════════════════════════════════════════════════════ */

interface FloraCtx {
  gravity: number;
  wind: number;
  veg: [number, number, number];
  vegAlt: [number, number, number];
  glowColor: [number, number, number];
  glowStrength: number;
  biodiversity: number;
  klass: string;
  temp: number;
}

function jitterColor(rng: Rng, c: [number, number, number], amt: number): [number, number, number] {
  return [
    Math.max(0.008, c[0] * rng.range(1 - amt, 1 + amt)),
    Math.max(0.008, c[1] * rng.range(1 - amt, 1 + amt)),
    Math.max(0.008, c[2] * rng.range(1 - amt, 1 + amt)),
  ];
}

/**
 * Build the whole botanical set for a world. Species count follows
 * biodiversity; morphology follows klass; every dimension is scaled by gravity
 * so a 0.3 g world genuinely grows taller, thinner things.
 */
export function buildFlora(spec: PlanetSpec, seedSalt = 0): FloraSpecies[] {
  const rng = new Rng((spec.seed ^ 0x5f3a91) + seedSalt);
  const out: FloraSpecies[] = [];
  if (spec.life === 'none') {
    return out;
  }

  const C: FloraCtx = {
    gravity: Math.max(0.05, spec.gravity),
    wind: spec.atmosphere.windSpeed,
    veg: spec.palette.vegetation,
    vegAlt: spec.palette.vegetationAlt,
    glowColor: spec.palette.emissive,
    glowStrength: spec.palette.emissiveStrength,
    biodiversity: spec.biodiversity,
    klass: spec.klass,
    temp: spec.tempK,
  };

  // Gravity is the single most legible physical parameter in a silhouette.
  // g⁻⁰·⁵ on height and g⁺⁰·⁴ on thickness is not rigorous but it reads right:
  // low-g worlds grow spindly cathedral trees, high-g worlds grow bunkers.
  const gH = Math.pow(9.81 / C.gravity, 0.5);
  const gT = Math.pow(C.gravity / 9.81, 0.4);
  const droopBase = 0.18 * (C.gravity / 9.81);
  const flex = clamp(0.35 + C.wind / 24, 0.3, 1.5) / Math.pow(C.gravity / 9.81, 0.35);
  const glow = C.glowStrength > 0.02 ? clamp(C.glowStrength, 0, 1) : 0;

  const speciesCount = Math.max(2, Math.round(2 + C.biodiversity * 7));
  const hasFlora = spec.life !== 'microbial';

  /* ---- ground cover ---- */
  if (hasFlora) {
    const grassKinds = Math.max(1, Math.round(1 + C.biodiversity * 2.4));
    for (let i = 0; i < grassKinds; i++) {
      const h = clamp(0.28 * gH * rng.range(0.6, 1.9), 0.12, 2.6);
      const col = jitterColor(rng, i % 2 === 0 ? C.veg : C.vegAlt, 0.22);
      out.push({
        id: `grass${i}`,
        layer: 'ground',
        biomes: i === 0 ? mask(B.GRASSLAND, B.FOREST, B.JUNGLE, B.TAIGA, B.TUNDRA, B.BEACH) : VERDANT | mask(B.TUNDRA),
        color: col,
        colorVar: 0.24,
        height: h,
        radius: h * 0.35,
        scale: [0.72, 1.5],
        solid: false,
        glow: glow * 0.25,
        wet: 0.4,
        slopeMax: 0.72,
        lods: [],
      });
      out[out.length - 1].lods = buildLods(() => buildGrassTuft(rng.fork(i), 0, 5, h, h * 0.045, 0.42, glow * 0.25), () => buildGrassTuft(rng.fork(i), 1, 5, h, h * 0.05, 0.42, glow * 0.25), null, h, h * 0.35);
    }

    // Wind-catching reeds near water, and a low flower for colour accents.
    const reedH = clamp(1.1 * gH, 0.4, 4.0);
    out.push({
      id: 'reed',
      layer: 'ground',
      biomes: mask(B.BEACH, B.GRASSLAND, B.JUNGLE, B.FOREST),
      color: jitterColor(rng, C.vegAlt, 0.2),
      colorVar: 0.2,
      height: reedH,
      radius: reedH * 0.18,
      scale: [0.8, 1.35],
      solid: false,
      glow: glow * 0.2,
      wet: 0.95,
      slopeMax: 0.35,
      lods: buildLods(
        () => buildGrassTuft(rng.fork(91), 0, 7, reedH, reedH * 0.012, 0.16, glow * 0.2),
        () => buildGrassTuft(rng.fork(91), 1, 7, reedH, reedH * 0.016, 0.16, glow * 0.2),
        null, reedH, reedH * 0.18,
      ),
    });

    const flowerColors: [number, number, number][] = [
      [1.15, 0.75, 0.2], [0.9, 0.25, 0.45], [0.45, 0.5, 1.3], [1.2, 1.15, 0.5], [0.85, 0.3, 1.1],
    ];
    const fcount = C.biodiversity > 0.35 ? 2 : 1;
    for (let i = 0; i < fcount; i++) {
      const h = clamp(0.34 * gH * rng.range(0.7, 1.5), 0.1, 1.6);
      out.push({
        id: `flower${i}`,
        layer: 'ground',
        biomes: VERDANT | mask(B.TUNDRA, B.BEACH),
        color: jitterColor(rng, rng.pick(flowerColors), 0.25),
        colorVar: 0.3,
        height: h,
        radius: h * 0.3,
        scale: [0.8, 1.4],
        solid: false,
        glow: Math.max(glow * 0.8, 0.12),
        wet: 0.5,
        slopeMax: 0.5,
        lods: buildLods(
          () => buildFlower(rng.fork(120 + i), 0, h, h * 0.34, 6, Math.max(glow, 0.2)),
          () => buildFlower(rng.fork(120 + i), 1, h, h * 0.34, 6, Math.max(glow, 0.2)),
          null, h, h * 0.3,
        ),
      });
    }
  }

  /* ---- undergrowth: ferns, rosettes, alien oddities ---- */
  if (hasFlora) {
    const fernH = clamp(0.9 * gH, 0.3, 4);
    out.push({
      id: 'fern',
      layer: 'under',
      biomes: WARM_WET | mask(B.TAIGA),
      color: jitterColor(rng, C.veg, 0.18),
      colorVar: 0.2,
      height: fernH,
      radius: fernH * 0.7,
      scale: [0.7, 1.5],
      solid: false,
      glow: glow * 0.3,
      wet: 0.8,
      slopeMax: 0.6,
      lods: buildLods(
        () => buildFernClump(rng.fork(31), 0, fernH, flex, glow * 0.3),
        () => buildFernClump(rng.fork(31), 1, fernH, flex, glow * 0.3),
        null, fernH, fernH * 0.7,
      ),
    });

    const rosH = clamp(0.45 * gH, 0.15, 2);
    out.push({
      id: 'rosette',
      layer: 'under',
      biomes: ARID | mask(B.TUNDRA, B.ALKALI, B.GRASSLAND),
      color: jitterColor(rng, C.vegAlt, 0.25),
      colorVar: 0.25,
      height: rosH,
      radius: rosH * 1.1,
      scale: [0.7, 1.6],
      solid: false,
      glow: glow * 0.35,
      wet: 0.15,
      slopeMax: 0.55,
      lods: buildLods(
        () => buildRosette(rng.fork(32), 0, 9, rosH, 0.14, 'blade', glow * 0.35),
        () => buildRosette(rng.fork(32), 1, 9, rosH, 0.14, 'blade', glow * 0.35),
        null, rosH, rosH * 1.1,
      ),
    });

    if (C.biodiversity > 0.4 || C.klass === 'exotic' || C.klass === 'toxic') {
      const spH = clamp(1.6 * gH, 0.5, 7);
      out.push({
        id: 'spiralfrond',
        layer: 'under',
        biomes: ALL_LAND & ~mask(B.GLACIER),
        color: jitterColor(rng, C.vegAlt, 0.3),
        colorVar: 0.3,
        height: spH,
        radius: spH * 0.5,
        scale: [0.7, 1.5],
        solid: false,
        glow: Math.max(glow, 0.25),
        wet: 0.4,
        slopeMax: 0.6,
        lods: buildLods(
          () => buildSpiral(rng.fork(33), 0, spH, 2.4, spH * 0.35, spH * 0.22, Math.max(glow, 0.25)),
          () => buildSpiral(rng.fork(33), 1, spH, 2.4, spH * 0.35, spH * 0.22, Math.max(glow, 0.25)),
          null, spH, spH * 0.5,
        ),
      });
    }
  }

  /* ---- bushes ---- */
  if (hasFlora) {
    const bushH = clamp(1.5 * gH * rng.range(0.7, 1.3), 0.4, 6);
    const bushP: TreeParams = {
      height: bushH * 0.55,
      trunkRadius: bushH * 0.035 * gT,
      levels: 3,
      splits: 3,
      splitAngle: 0.72,
      splitSpread: 0.3,
      droop: droopBase * 1.4,
      reach: 0.55,
      curve: 0.35,
      wander: 0.25,
      lengthFalloff: 0.68,
      radiusFalloff: 0.6,
      flexibility: flex * 1.2,
      leaf: C.klass === 'tundra' || C.klass === 'glacial' ? 'needle' : 'blade',
      leafSize: bushH * 0.16,
      leafCount: 9,
      leafGlow: glow * 0.4,
      sides: 5,
      crownOnly: false,
      whorl: 0,
      whorls: 0,
      clear: 0.05,
    };
    out.push({
      id: 'bush',
      layer: 'bush',
      biomes: VERDANT | mask(B.TUNDRA, B.BADLANDS, B.BEACH),
      color: jitterColor(rng, C.veg, 0.2),
      colorVar: 0.22,
      height: bushH,
      radius: bushH * 0.7,
      scale: [0.65, 1.6],
      solid: false,
      glow: glow * 0.4,
      wet: 0.5,
      slopeMax: 0.65,
      lods: buildLods(
        () => buildTree(rng.fork(41), bushP, 0),
        () => buildTree(rng.fork(41), bushP, 1),
        () => impostor(bushH, bushH * 0.6, 2, glow * 0.4),
        bushH, bushH * 0.7,
      ),
    });

    if (ARID) {
      const cactH = clamp(2.4 * gH * rng.range(0.6, 1.4), 0.6, 10);
      out.push({
        id: 'column',
        layer: 'bush',
        biomes: ARID | mask(B.ALKALI),
        color: jitterColor(rng, C.vegAlt, 0.22),
        colorVar: 0.2,
        height: cactH,
        radius: cactH * 0.16,
        scale: [0.6, 1.6],
        solid: true,
        glow: glow * 0.3,
        wet: 0.05,
        slopeMax: 0.45,
        lods: buildLods(
          () => buildColumn(rng.fork(42), 0, cactH, cactH * 0.11 * gT, 8, 2, glow * 0.3),
          () => buildColumn(rng.fork(42), 1, cactH, cactH * 0.11 * gT, 8, 2, glow * 0.3),
          () => impostor(cactH, cactH * 0.18, 2, glow * 0.3),
          cactH, cactH * 0.16,
        ),
      });
    }
  }

  /* ---- trees ---- */
  if (spec.life === 'flora' || spec.life === 'fauna' || spec.life === 'sapient' || spec.life === 'post-sapient') {
    const treeKinds = clamp(Math.round(1 + C.biodiversity * 3.4), 1, 4);
    const morphology = treeMorphologies(C, rng);
    for (let i = 0; i < treeKinds; i++) {
      const m = morphology[i % morphology.length];
      const h = clamp(m.height * gH * rng.range(0.75, 1.35), 1.2, 90);
      const P: TreeParams = {
        height: h,
        trunkRadius: h * m.thick * gT,
        levels: m.levels,
        splits: m.splits,
        splitAngle: m.splitAngle,
        splitSpread: 0.28,
        droop: droopBase * m.droop,
        reach: m.reach,
        curve: m.curve,
        wander: 0.12,
        lengthFalloff: m.lengthFalloff,
        radiusFalloff: 0.62,
        flexibility: flex * m.flex,
        leaf: m.leaf,
        leafSize: h * m.leafSize,
        leafCount: m.leafCount,
        leafGlow: glow * m.glow,
        sides: 6,
        crownOnly: m.crownOnly,
        whorl: m.whorl,
        whorls: m.whorls,
        clear: m.clear,
      };
      const col = jitterColor(rng, i % 2 === 0 ? C.veg : C.vegAlt, 0.2);
      const rad = h * m.crownRadius;
      out.push({
        id: `tree${i}`,
        layer: 'tree',
        biomes: m.biomes,
        color: col,
        colorVar: 0.18,
        height: h,
        radius: rad,
        scale: [0.7, 1.45],
        solid: true,
        glow: glow * m.glow,
        wet: m.wet,
        slopeMax: 0.62,
        lods: buildLods(
          () => buildTree(rng.fork(200 + i), P, 0),
          () => buildTree(rng.fork(200 + i), P, 1),
          () => impostor(h, rad, 3, glow * m.glow),
          h, rad,
        ),
      });
    }
  }

  /* ---- biome specials ---- */
  const mushH = clamp(6 * gH * rng.range(0.5, 1.6), 1.5, 40);
  out.push({
    id: 'mushroomtower',
    layer: 'special',
    biomes: mask(B.MUSHROOM, B.JUNGLE),
    color: jitterColor(rng, glow > 0.05 ? C.glowColor : C.vegAlt, 0.3),
    colorVar: 0.28,
    height: mushH,
    radius: mushH * 0.55,
    scale: [0.5, 1.8],
    solid: true,
    glow: Math.max(glow, 0.55),
    wet: 0.85,
    slopeMax: 0.5,
    lods: buildLods(
      () => buildMushroom(rng.fork(300), 0, mushH * 0.75, mushH * 0.5, Math.max(glow, 0.55)),
      () => buildMushroom(rng.fork(300), 1, mushH * 0.75, mushH * 0.5, Math.max(glow, 0.55)),
      () => impostor(mushH, mushH * 0.5, 2, Math.max(glow, 0.55)),
      mushH, mushH * 0.55,
    ),
  });

  const crysH = clamp(7 * gH * rng.range(0.5, 1.7), 1.5, 60);
  out.push({
    id: 'crystal',
    layer: 'special',
    biomes: mask(B.CRYSTAL, B.ROCK, B.GLACIER, B.SALT_FLAT, B.BADLANDS),
    color: [C.glowColor[0] * 0.35 + 0.06, C.glowColor[1] * 0.35 + 0.07, C.glowColor[2] * 0.35 + 0.1],
    colorVar: 0.2,
    height: crysH,
    radius: crysH * 0.35,
    scale: [0.4, 1.9],
    solid: true,
    glow: Math.max(glow, 0.7),
    wet: 0,
    slopeMax: 0.75,
    lods: buildLods(
      () => buildCrystalCluster(rng.fork(301), 0, crysH, 6, Math.max(glow, 0.7)),
      () => buildCrystalCluster(rng.fork(301), 1, crysH, 6, Math.max(glow, 0.7)),
      () => impostor(crysH, crysH * 0.3, 2, Math.max(glow, 0.7)),
      crysH, crysH * 0.35,
    ),
  });

  if (spec.ocean.present) {
    const coralH = clamp(2.2 * gH, 0.6, 9);
    out.push({
      id: 'coral',
      layer: 'special',
      biomes: mask(B.OCEAN, B.BEACH),
      color: jitterColor(rng, [C.glowColor[0] * 0.5 + 0.25, C.glowColor[1] * 0.3 + 0.12, C.glowColor[2] * 0.4 + 0.3], 0.35),
      colorVar: 0.35,
      height: coralH,
      radius: coralH * 0.8,
      scale: [0.5, 1.7],
      solid: false,
      glow: Math.max(glow, 0.4),
      wet: 1,
      slopeMax: 0.7,
      lods: buildLods(
        () => buildCoralFan(rng.fork(302), 0, coralH, Math.max(glow, 0.4)),
        () => buildCoralFan(rng.fork(302), 1, coralH, Math.max(glow, 0.4)),
        null, coralH, coralH * 0.8,
      ),
    });
    const kelpH = clamp(5 * gH, 1, 22);
    out.push({
      id: 'kelp',
      layer: 'special',
      biomes: mask(B.OCEAN),
      color: jitterColor(rng, C.vegAlt, 0.25),
      colorVar: 0.25,
      height: kelpH,
      radius: kelpH * 0.2,
      scale: [0.6, 1.6],
      solid: false,
      glow: glow * 0.5,
      wet: 1,
      slopeMax: 0.6,
      lods: buildLods(
        () => buildKelp(rng.fork(303), 0, kelpH, kelpH * 0.035, glow * 0.5),
        () => buildKelp(rng.fork(303), 1, kelpH, kelpH * 0.04, glow * 0.5),
        null, kelpH, kelpH * 0.2,
      ),
    });
  }

  // Sail plants: a toxic-world signature. A single membrane held into the wind.
  if (C.klass === 'toxic' || C.klass === 'exotic' || C.biodiversity > 0.6) {
    const sailH = clamp(4 * gH * rng.range(0.6, 1.5), 1, 26);
    const sailP: TreeParams = {
      height: sailH * 0.8,
      trunkRadius: sailH * 0.02 * gT,
      levels: 1,
      splits: 2,
      splitAngle: 0.5,
      splitSpread: 0.15,
      droop: droopBase * 0.4,
      reach: 0.9,
      curve: 0.2,
      wander: 0.06,
      lengthFalloff: 0.55,
      radiusFalloff: 0.55,
      flexibility: flex * 1.5,
      leaf: 'sail',
      leafSize: sailH * 0.3,
      leafCount: 3,
      leafGlow: Math.max(glow, 0.3),
      sides: 5,
      crownOnly: false,
      whorl: 0,
      whorls: 0,
      clear: 0.4,
    };
    out.push({
      id: 'sail',
      layer: 'special',
      biomes: ALL_LAND & ~mask(B.GLACIER, B.LAVA),
      color: jitterColor(rng, C.vegAlt, 0.3),
      colorVar: 0.3,
      height: sailH,
      radius: sailH * 0.4,
      scale: [0.6, 1.6],
      solid: true,
      glow: Math.max(glow, 0.3),
      wet: 0.3,
      slopeMax: 0.55,
      lods: buildLods(
        () => buildTree(rng.fork(304), sailP, 0),
        () => buildTree(rng.fork(304), sailP, 1),
        () => impostor(sailH, sailH * 0.4, 2, Math.max(glow, 0.3)),
        sailH, sailH * 0.4,
      ),
    });
  }

  // Tethered floating bulbs — only credible where gravity is genuinely low.
  if (C.gravity < 7.5 && spec.atmosphere.present && hasFlora) {
    const bulbH = clamp(5 * gH * rng.range(0.7, 1.5), 1.5, 40);
    const bulbP: TreeParams = {
      height: bulbH * 0.5,
      trunkRadius: bulbH * 0.015 * gT,
      levels: 2,
      splits: 3,
      splitAngle: 0.6,
      splitSpread: 0.3,
      droop: -0.25, // negative droop: the whole plant is buoyant
      reach: 1.4,
      curve: 0.3,
      wander: 0.18,
      lengthFalloff: 0.7,
      radiusFalloff: 0.6,
      flexibility: flex * 2.2,
      leaf: 'bulb',
      leafSize: bulbH * 0.22,
      leafCount: 5,
      leafGlow: Math.max(glow, 0.5),
      sides: 4,
      crownOnly: false,
      whorl: 0,
      whorls: 0,
      clear: 0.25,
    };
    out.push({
      id: 'bulb',
      layer: 'special',
      biomes: ALL_LAND & ~mask(B.LAVA),
      color: jitterColor(rng, glow > 0.05 ? C.glowColor : C.veg, 0.3),
      colorVar: 0.3,
      height: bulbH,
      radius: bulbH * 0.45,
      scale: [0.55, 1.7],
      solid: false,
      glow: Math.max(glow, 0.5),
      wet: 0.4,
      slopeMax: 0.7,
      lods: buildLods(
        () => buildTree(rng.fork(305), bulbP, 0),
        () => buildTree(rng.fork(305), bulbP, 1),
        () => impostor(bulbH, bulbH * 0.45, 2, Math.max(glow, 0.5)),
        bulbH, bulbH * 0.45,
      ),
    });
  }

  void speciesCount;
  return out;
}

function buildFernClump(rng: Rng, detail: number, h: number, flex: number, glow: number): MeshBuf {
  const buf = new MeshBuf();
  const n = detail === 0 ? 6 : 3;
  const origin = new Vector3();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.283 + rng.range(-0.3, 0.3);
    const tilt = rng.range(0.5, 0.95);
    const dir = new Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt)).normalize();
    const side = new Vector3(-Math.sin(a), 0, Math.cos(a));
    addLeaf(buf, 'frond', origin, dir, side, h * rng.range(0.8, 1.15), i * 0.4, clamp(0.55 * flex, 0, 1), glow, detail, rng);
  }
  return buf;
}

function impostor(height: number, radius: number, planes: number, glow: number): MeshBuf {
  const buf = new MeshBuf();
  addImpostorCross(buf, height, radius, planes, 1.0, glow);
  return buf;
}

function buildLods(
  hi: () => MeshBuf,
  mid: () => MeshBuf,
  far: (() => MeshBuf) | null,
  height: number,
  radius: number,
): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  out.push(hi().toGeometry());
  out.push(mid().toGeometry());
  if (far) out.push(far().toGeometry());
  void height;
  void radius;
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Morphology tables
   ═══════════════════════════════════════════════════════════════════════════ */

interface Morphology {
  height: number;
  thick: number;
  levels: number;
  splits: number;
  splitAngle: number;
  droop: number;
  reach: number;
  curve: number;
  lengthFalloff: number;
  flex: number;
  leaf: LeafKind;
  leafSize: number;
  leafCount: number;
  crownOnly: boolean;
  whorl: number;
  whorls: number;
  clear: number;
  crownRadius: number;
  glow: number;
  wet: number;
  biomes: number;
}

const BROADLEAF: Morphology = {
  height: 14, thick: 0.035, levels: 3, splits: 3, splitAngle: 0.62, droop: 1.0, reach: 0.55,
  curve: 0.25, lengthFalloff: 0.72, flex: 1.0, leaf: 'blade', leafSize: 0.045, leafCount: 14,
  crownOnly: false, whorl: 0, whorls: 0, clear: 0.32, crownRadius: 0.42, glow: 0.3, wet: 0.6, biomes: VERDANT,
};
const CONIFER: Morphology = {
  height: 20, thick: 0.026, levels: 1, splits: 2, splitAngle: 0.5, droop: 0.8, reach: 0.3,
  curve: 0.1, lengthFalloff: 0.6, flex: 0.55, leaf: 'needle', leafSize: 0.02, leafCount: 10,
  crownOnly: false, whorl: 6, whorls: 8, clear: 0.14, crownRadius: 0.24, glow: 0.2, wet: 0.5, biomes: COLD | mask(B.FOREST),
};
const PALM: Morphology = {
  height: 12, thick: 0.02, levels: 0, splits: 0, splitAngle: 0.4, droop: 1.6, reach: 0.8,
  curve: 0.55, lengthFalloff: 0.6, flex: 1.6, leaf: 'frond', leafSize: 0.4, leafCount: 9,
  crownOnly: true, whorl: 0, whorls: 0, clear: 0.9, crownRadius: 0.35, glow: 0.25, wet: 0.85,
  biomes: mask(B.BEACH, B.JUNGLE),
};
const CANOPY: Morphology = {
  height: 32, thick: 0.03, levels: 4, splits: 3, splitAngle: 0.5, droop: 0.7, reach: 0.85,
  curve: 0.18, lengthFalloff: 0.7, flex: 0.8, leaf: 'disc', leafSize: 0.03, leafCount: 18,
  crownOnly: false, whorl: 0, whorls: 0, clear: 0.55, crownRadius: 0.4, glow: 0.35, wet: 0.9,
  biomes: mask(B.JUNGLE, B.FOREST),
};
const SCRUB: Morphology = {
  height: 5, thick: 0.05, levels: 3, splits: 4, splitAngle: 0.85, droop: 1.5, reach: 0.35,
  curve: 0.4, lengthFalloff: 0.62, flex: 0.7, leaf: 'spike', leafSize: 0.05, leafCount: 8,
  crownOnly: false, whorl: 0, whorls: 0, clear: 0.1, crownRadius: 0.55, glow: 0.2, wet: 0.1,
  biomes: ARID | mask(B.GRASSLAND, B.BADLANDS),
};
const SPIRE: Morphology = {
  height: 26, thick: 0.016, levels: 2, splits: 2, splitAngle: 0.35, droop: 0.25, reach: 1.5,
  curve: 0.6, lengthFalloff: 0.75, flex: 1.8, leaf: 'sail', leafSize: 0.06, leafCount: 7,
  crownOnly: false, whorl: 0, whorls: 0, clear: 0.4, crownRadius: 0.2, glow: 0.55, wet: 0.4,
  biomes: ALL_LAND & ~mask(B.GLACIER, B.LAVA),
};
const WEEPER: Morphology = {
  height: 16, thick: 0.03, levels: 3, splits: 4, splitAngle: 0.9, droop: 2.6, reach: 0.2,
  curve: 0.5, lengthFalloff: 0.78, flex: 1.9, leaf: 'blade', leafSize: 0.05, leafCount: 16,
  crownOnly: false, whorl: 0, whorls: 0, clear: 0.4, crownRadius: 0.5, glow: 0.3, wet: 0.8,
  biomes: VERDANT | mask(B.BEACH),
};

function treeMorphologies(C: FloraCtx, rng: Rng): Morphology[] {
  const pool: Morphology[] = [];
  switch (C.klass) {
    case 'jungle':
      pool.push(CANOPY, PALM, BROADLEAF, WEEPER);
      break;
    case 'terran':
      pool.push(BROADLEAF, CONIFER, WEEPER, PALM);
      break;
    case 'tundra':
    case 'glacial':
      pool.push(CONIFER, SCRUB);
      break;
    case 'desert':
      pool.push(SCRUB, SPIRE, PALM);
      break;
    case 'ocean':
      pool.push(PALM, WEEPER, CANOPY);
      break;
    case 'toxic':
      pool.push(SPIRE, SCRUB, WEEPER);
      break;
    case 'exotic':
      pool.push(SPIRE, CANOPY, WEEPER);
      break;
    default:
      pool.push(SCRUB, SPIRE);
      break;
  }
  // A high-biodiversity world gets one wildcard morphology from outside its
  // comfort zone — the "why is that here?" plant that makes a place memorable.
  if (C.biodiversity > 0.62) pool.push(rng.pick([SPIRE, WEEPER, CANOPY, CONIFER, PALM]));
  return rng.shuffle(pool.slice());
}
