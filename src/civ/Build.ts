/**
 * Turning a plan into triangles.
 *
 * Every building in a city ends up in one BufferGeometry and one draw call,
 * which is only possible because the façade material reads its own detail out
 * of `uv` — metres along the wall, metres above the base — instead of out of a
 * texture. So the job here is narrow and mechanical: extrude convex polygons,
 * write honest façade coordinates, and bake the ambient occlusion that a
 * shadow map at this scale can never give us.
 *
 * The parts that are art rather than plumbing:
 *   • SETBACKS. A tower that steps in as it rises has a silhouette. A prism
 *     does not. Two extra masses per tall building buy the whole skyline.
 *   • PLINTHS. Buildings sit on their highest ground corner and fill down to
 *     their lowest, so a hillside town terraces instead of floating.
 *   • BASE OCCLUSION. Street level is dark and roofs are bright. Without this
 *     a city is a field of evenly-lit boxes no matter how good the shader is.
 */

import { BufferAttribute, InstancedBufferAttribute, InstancedBufferGeometry } from 'three';
import type { BufferGeometry } from 'three';
import { MeshBuilder, type Heightfield, polyCentroid, polyInset, polyOBB, clamp01, mix, smoothstep01 } from './CivMath';
import type { BuildingParams, Lane, Obstacle, Poly, StreetSeg } from './CivTypes';
import { MAT_GLASS, MAT_METAL, STYLE_ID } from './CivTypes';
import type { GroundPatch, Layout, Prop } from './Layout';
import type { CivilizationSpec } from '../universe/Types';
import { Rng } from '../core/Rand';

/** Everything one settlement hands to the renderer. */
export interface CityGeometry {
  city: BufferGeometry | null;
  road: BufferGeometry | null;
  ground: BufferGeometry | null;
  holo: BufferGeometry | null;
  traffic: InstancedBufferGeometry | null;
  obstacles: Obstacle[];
  /** Emissive point sources for the orbital night-lights cloud. */
  lightPoints: { x: number; y: number; z: number; size: number; tint: [number, number, number] }[];
}

/* ═══════════════════════════════════════════════════════════════════════════
   Buildings
   ═══════════════════════════════════════════════════════════════════════════ */

/** Base occlusion: dark in the street canyon, open at the top. */
function wallAO(zAboveBase: number): number {
  return mix(0.30, 1.0, smoothstep01(0, 14, zAboveBase));
}

/**
 * Extrude a convex polygon between two heights, writing façade coordinates.
 * `uOffset` keeps the running wall coordinate continuous across the stack, so
 * window bays line up from the plinth to the parapet.
 */
function extrude(
  mb: MeshBuilder,
  poly: Poly,
  z0: number,
  z1: number,
  facadeBase: number,
  uOffset: number,
  aoScale = 1
): number {
  const n = poly.length / 2;
  let u = uOffset;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2];
    const ay = poly[i * 2 + 1];
    const bx = poly[j * 2];
    const by = poly[j * 2 + 1];
    let ex = bx - ax;
    let ey = by - ay;
    const len = Math.hypot(ex, ey);
    if (len < 0.05) continue;
    ex /= len;
    ey /= len;
    // Outward normal of a CCW polygon.
    const nx = ey;
    const ny = -ex;

    const v0 = z0 - facadeBase;
    const v1 = z1 - facadeBase;
    mb.setAO(wallAO(v0) * aoScale);
    const a0 = mb.vertex(ax, ay, z0, nx, ny, 0, u, v0);
    const b0 = mb.vertex(bx, by, z0, nx, ny, 0, u + len, v0);
    mb.setAO(wallAO(v1) * aoScale);
    const b1 = mb.vertex(bx, by, z1, nx, ny, 0, u + len, v1);
    const a1 = mb.vertex(ax, ay, z1, nx, ny, 0, u, v1);
    mb.quad(a0, b0, b1, a1);
    u += len;
  }
  return u;
}

/** Flat cap over a convex polygon, fanned from the centroid. */
function capPoly(mb: MeshBuilder, poly: Poly, z: number, nz: number, ao: number): void {
  const n = poly.length / 2;
  if (n < 3) return;
  const c: [number, number] = [0, 0];
  polyCentroid(poly, c);
  mb.setAO(ao);
  const ci = mb.vertex(c[0], c[1], z, 0, 0, nz, c[0], c[1]);
  const first = mb.vertex(poly[0], poly[1], z, 0, 0, nz, poly[0], poly[1]);
  let prev = first;
  for (let i = 1; i <= n; i++) {
    const k = i % n;
    const cur = i === n ? first : mb.vertex(poly[k * 2], poly[k * 2 + 1], z, 0, 0, nz, poly[k * 2], poly[k * 2 + 1]);
    if (nz > 0) mb.tri(ci, prev, cur);
    else mb.tri(ci, cur, prev);
    prev = cur;
  }
}

/** Hipped roof: the top polygon pulled toward its centroid and lifted. */
function hipRoof(mb: MeshBuilder, poly: Poly, z: number, rise: number, ao: number): void {
  const n = poly.length / 2;
  const c: [number, number] = [0, 0];
  polyCentroid(poly, c);
  mb.setAO(ao);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2];
    const ay = poly[i * 2 + 1];
    const bx = poly[j * 2];
    const by = poly[j * 2 + 1];
    // Face normal of the slope, in tangent space.
    let ex = bx - ax;
    let ey = by - ay;
    const len = Math.hypot(ex, ey) || 1;
    ex /= len;
    ey /= len;
    const outX = ey;
    const outY = -ex;
    const nl = Math.hypot(outX * rise, outY * rise, len);
    const nx = (outX * rise) / nl;
    const ny = (outY * rise) / nl;
    const nz = len / nl;
    const a = mb.vertex(ax, ay, z, nx, ny, nz, 0, 0);
    const b = mb.vertex(bx, by, z, nx, ny, nz, len, 0);
    const t = mb.vertex(c[0], c[1], z + rise, nx, ny, nz, len * 0.5, rise);
    mb.tri(a, b, t);
  }
}

/** A dome over the inscribed circle of the top polygon. */
function dome(mb: MeshBuilder, cx: number, cy: number, r: number, z: number, height: number, ao: number): void {
  const rings = 6;
  const seg = 14;
  mb.setAO(ao);
  let prev: number[] = [];
  for (let ri = 0; ri <= rings; ri++) {
    const t = ri / rings;
    const rr = r * Math.cos((t * Math.PI) / 2);
    const zz = z + height * Math.sin((t * Math.PI) / 2);
    const row: number[] = [];
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      const nx = Math.cos(a) * Math.cos((t * Math.PI) / 2);
      const ny = Math.sin(a) * Math.cos((t * Math.PI) / 2);
      const nz = Math.sin((t * Math.PI) / 2);
      row.push(mb.vertex(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, zz, nx, ny, nz, (a * r), height * t));
    }
    if (ri > 0) for (let s = 0; s < seg; s++) mb.quad(prev[s], prev[s + 1], row[s + 1], row[s]);
    prev = row;
  }
}

/**
 * One building: plinth, massing stack with setbacks, roof, and whatever the
 * archetype adds on top.
 */
export function emitBuilding(mb: MeshBuilder, b: BuildingParams, datum: number, obstacles: Obstacle[], lights: CityGeometry['lightPoints'], neon: [number, number, number]): void {
  const rng = new Rng(Math.round(b.seed * 4294967295));
  const bay = 2.4 + rng.range(0, 2.4) + (b.matId === MAT_GLASS ? 1.4 : 0);
  mb.setFacade(b.floorHeight, bay, b.litProb, b.seed);
  mb.setInfo(STYLE_ID[b.style], b.decay, 1, b.matId);

  const base = b.base - datum;
  const bottom = b.baseMin - datum - 0.6;
  const top = base + b.height;

  /* ── plinth: fill the gap between the ground and the ground floor ─────── */
  if (base - bottom > 0.15) {
    mb.setInfo(STYLE_ID[b.style], b.decay, 1, b.matId);
    extrude(mb, b.poly, bottom, base, base, 0, 0.55);
  }

  /* ── massing stack ────────────────────────────────────────────────────── */
  // Tall buildings step in. Two setbacks is enough to read as a tower rather
  // than a column, and a third never survives the silhouette at distance.
  const setbacks = b.height > 90 ? 3 : b.height > 42 ? 2 : 1;
  let poly = b.poly;
  let z = base;
  let u = 0;
  const obb0 = polyOBB(b.poly);
  const minHalf = Math.min(obb0.hu, obb0.hv);

  for (let i = 0; i < setbacks; i++) {
    // Each mass takes a decreasing share of what is left, so the proportions
    // stay classical: a big shaft, a shorter shoulder, a small crown.
    const remaining = top - z;
    const share = i === setbacks - 1 ? 1 : rng.range(0.5, 0.72);
    const zTop = z + remaining * share;
    u = extrude(mb, poly, z, zTop, base, u);
    z = zTop;
    if (i < setbacks - 1) {
      const inset = Math.min(minHalf * 0.28, rng.range(1.2, 3.6));
      const next = polyInset(poly, inset);
      if (next.length < 6) break;
      // Cap the exposed shoulder of the mass we just left behind.
      capPoly(mb, poly, z, 1, 0.72);
      poly = next;
    }
  }

  /* ── roof ─────────────────────────────────────────────────────────────── */
  const rc: [number, number] = [0, 0];
  polyCentroid(poly, rc);
  const ro = polyOBB(poly);
  const rMin = Math.min(ro.hu, ro.hv);

  if (b.roof === 1 && rMin > 1.2) {
    hipRoof(mb, poly, z, Math.min(rMin * 0.85, b.floorHeight * 1.1), 0.95);
  } else if (b.roof === 4 && rMin > 2.5) {
    capPoly(mb, poly, z, 1, 0.9);
    dome(mb, rc[0], rc[1], rMin * 0.82, z, rMin * 1.05, 0.95);
  } else {
    capPoly(mb, poly, z, 1, 0.95);
    // Parapet: a low wall around the roof edge. It costs eight triangles and
    // it is the difference between "roof" and "the top face of a box".
    const parapet = b.roof === 3 ? 0.5 : rng.range(0.6, 1.3);
    if (rMin > 1.0) {
      mb.setInfo(STYLE_ID[b.style], b.decay, 0.85, b.matId);
      extrude(mb, poly, z, z + parapet, base, u, 0.85);
      capPoly(mb, poly, z + parapet, 1, 0.9);
      const inner = polyInset(poly, 0.35);
      if (inner.length >= 6) capPoly(mb, inner, z, -1, 0.4);
    }
    // Rooftop plant: a couple of boxes so the roofscape is not a plane.
    if (b.roof !== 3 && rMin > 4 && rng.chance(0.7)) {
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i++) {
        const hw = rng.range(1.2, Math.min(3.5, rMin * 0.5));
        const px = rc[0] + rng.range(-rMin * 0.45, rMin * 0.45);
        const py = rc[1] + rng.range(-rMin * 0.45, rMin * 0.45);
        const hh = rng.range(1.4, 3.6);
        const box = [px - hw, py - hw, px + hw, py - hw, px + hw, py + hw, px - hw, py + hw];
        mb.setInfo(STYLE_ID[b.style], b.decay, 0.8, MAT_METAL);
        extrude(mb, box, z + parapet * 0.4, z + parapet * 0.4 + hh, base, 0, 0.8);
        capPoly(mb, box, z + parapet * 0.4 + hh, 1, 0.9);
      }
    }
    // Saw-tooth monitor lights over a shed: the industrial roofline.
    if (b.roof === 3 && ro.hu > 6) {
      const strips = Math.min(6, Math.floor(ro.hu / 5));
      for (let i = 0; i < strips; i++) {
        const t = ((i + 0.5) / strips) * 2 - 1;
        const cx = ro.x + ro.ux * (t * ro.hu);
        const cy = ro.y + ro.uy * (t * ro.hu);
        const hw = 1.1;
        const strip = [
          cx - ro.ux * hw + ro.uy * ro.hv, cy - ro.uy * hw - ro.ux * ro.hv,
          cx + ro.ux * hw + ro.uy * ro.hv, cy + ro.uy * hw - ro.ux * ro.hv,
          cx + ro.ux * hw - ro.uy * ro.hv, cy + ro.uy * hw + ro.ux * ro.hv,
          cx - ro.ux * hw - ro.uy * ro.hv, cy - ro.uy * hw + ro.ux * ro.hv,
        ];
        mb.setInfo(STYLE_ID[b.style], b.decay, 0.9, MAT_GLASS);
        extrude(mb, strip, z + 0.4, z + 1.9, base, 0, 0.9);
        capPoly(mb, strip, z + 1.9, 1, 1);
      }
    }
  }

  /* ── a mast on the landmark, so the city has a horizon marker ─────────── */
  if (b.landmark && rMin > 1.5) {
    const mh = b.height * 0.28 + 12;
    const hw = Math.max(0.5, rMin * 0.12);
    const mast = [rc[0] - hw, rc[1] - hw, rc[0] + hw, rc[1] - hw, rc[0] + hw, rc[1] + hw, rc[0] - hw, rc[1] + hw];
    mb.setInfo(STYLE_ID[b.style], b.decay * 0.4, 0.95, MAT_METAL);
    extrude(mb, mast, z, z + mh, base, 0, 0.95);
    capPoly(mb, mast, z + mh, 1, 1);
    lights.push({ x: rc[0], y: rc[1], z: z + mh + 1, size: 26, tint: [1.6, 0.25, 0.15] });
  }

  /* ── collision + orbital light ────────────────────────────────────────── */
  obstacles.push({
    x: b.x,
    y: b.y,
    ux: b.ux,
    uy: b.uy,
    hu: b.hu,
    hv: b.hv,
    z0: bottom,
    z1: top,
  });

  // One light point per building, brightness from how lit its windows are.
  if (b.litProb > 0.05) {
    const warm = b.district === 'core' || b.district === 'market';
    lights.push({
      x: b.x,
      y: b.y,
      z: base + b.height * 0.5,
      size: Math.max(6, Math.sqrt(b.hu * b.hv) * (2 + b.litProb * 5)),
      tint: warm
        ? [1.0, 0.72 + b.litProb * 0.2, 0.42]
        : [neon[0] * 0.35 + 0.6, neon[1] * 0.3 + 0.6, neon[2] * 0.4 + 0.5],
    });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Roads
   ═══════════════════════════════════════════════════════════════════════════ */

export function emitRoads(
  mb: MeshBuilder,
  streets: StreetSeg[],
  hf: Heightfield,
  datum: number,
  civ: CivilizationSpec,
  detail = 1
): void {
  const tech = clamp01(civ.techLevel);
  // Alleys outnumber avenues ten to one and are invisible from anywhere but on
  // top of them, so they are the first thing the detail budget drops. Without
  // this a city spends four times as many triangles on tarmac as on buildings.
  const maxLevel = detail > 0.75 ? 3 : detail > 0.3 ? 2 : 1;
  for (let si = 0; si < streets.length; si++) {
    const s = streets[si];
    if (s.level > maxLevel) continue;
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const len = Math.hypot(dx, dy);
    if (len < 7) continue;
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;
    const hw = s.width * 0.5;

    mb.setFacade(hw, tech, 0, (si * 0.61803) % 1);
    mb.setInfo(0, civ.decay, 1, s.level === 0 ? 0 : 0);

    // Subdivide along the length so the ribbon follows the ground rather than
    // cutting through it. Arterials get the finer step; an alley is short
    // enough that two spans track the terrain to within a few centimetres.
    const steps = Math.max(1, Math.ceil(len / (s.level === 0 ? 11 : 26)));
    let prevL = -1;
    let prevR = -1;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * len;
      const cx = s.ax + ux * t;
      const cy = s.ay + uy * t;
      const lx = cx + px * hw;
      const ly = cy + py * hw;
      const rx = cx - px * hw;
      const ry = cy - py * hw;
      // The carriageway is graded: it takes the average of its two edges, which
      // is what stops a road twisting like a ribbon over rough ground.
      const z = (hf.at(lx, ly) + hf.at(rx, ry)) * 0.5 - datum + 0.05;
      mb.setAO(1);
      const a = mb.vertex(lx, ly, z, 0, 0, 1, -1, t);
      const b = mb.vertex(rx, ry, z, 0, 0, 1, 1, t);
      if (i > 0) mb.quad(prevL, prevR, b, a);
      prevL = a;
      prevR = b;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Ground
   ═══════════════════════════════════════════════════════════════════════════ */

export function emitGround(mb: MeshBuilder, patches: GroundPatch[], hf: Heightfield, datum: number, civ: CivilizationSpec): void {
  for (const p of patches) {
    const poly = p.poly;
    const n = poly.length / 2;
    if (n < 3) continue;
    const c: [number, number] = [0, 0];
    polyCentroid(poly, c);
    mb.setFacade(p.param, 0, 0, p.seed);
    mb.setInfo(0, civ.decay, 1, p.kind);
    mb.setAO(1);

    const uvOf = (x: number, y: number): [number, number] => (p.kind === 4 ? [x - c[0], y - c[1]] : [x, y]);

    // Fan the polygon, subdividing each rib so the slab follows the terrain.
    const [cu, cv] = uvOf(c[0], c[1]);
    const zc = hf.at(c[0], c[1]) - datum + 0.03;
    const ci = mb.vertex(c[0], c[1], zc, 0, 0, 1, cu, cv);
    const ring: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = poly[i * 2];
      const y = poly[i * 2 + 1];
      const [u, v] = uvOf(x, y);
      ring.push(mb.vertex(x, y, hf.at(x, y) - datum + 0.03, 0, 0, 1, u, v));
    }
    for (let i = 0; i < n; i++) mb.tri(ci, ring[i], ring[(i + 1) % n]);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Props — lamps, antennas, tanks, statues
   ═══════════════════════════════════════════════════════════════════════════ */

/** A rectangular prism helper in tangent space, rotated about its own centre. */
function post(mb: MeshBuilder, x: number, y: number, z0: number, z1: number, hw: number, hd: number, rot: number, ao: number): void {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const poly: Poly = [];
  for (const [dx, dy] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as const) {
    poly.push(x + dx * c - dy * s, y + dx * s + dy * c);
  }
  mb.setAO(ao);
  extrude(mb, poly, z0, z1, z0, 0, ao);
  capPoly(mb, poly, z1, 1, ao);
}

export function emitProps(
  mb: MeshBuilder,
  holo: MeshBuilder,
  props: Prop[],
  datum: number,
  civ: CivilizationSpec,
  lights: CityGeometry['lightPoints']
): void {
  const neon = civ.neon;
  for (const p of props) {
    const z = p.z - datum;
    switch (p.kind) {
      case 'lamp': {
        const h = 5.2 * p.scale;
        mb.setFacade(3.2, 3.2, 0, p.seed);
        mb.setInfo(STYLE_ID[civ.style], civ.decay, 1, MAT_METAL);
        post(mb, p.x, p.y, z, z + h, 0.09 * p.scale, 0.09 * p.scale, p.rot, 0.8);
        // The head: a short arm cantilevered over the carriageway.
        const ax = p.x + Math.cos(p.rot + Math.PI / 2) * 0.0;
        post(mb, ax, p.y, z + h - 0.18, z + h, 0.5 * p.scale, 0.14 * p.scale, p.rot, 0.9);
        // Two crossed additive quads under the head make it a light source.
        holoQuad(holo, ax, p.y, z + h - 0.3, 1.5 * p.scale, 0.8 * p.scale, p.rot, 3, 0.9, p.seed);
        holoQuad(holo, ax, p.y, z + h - 0.3, 1.5 * p.scale, 0.8 * p.scale, p.rot + Math.PI / 2, 3, 0.9, p.seed);
        lights.push({ x: p.x, y: p.y, z: z + h, size: 3.5, tint: [1.0, 0.78, 0.5] });
        break;
      }
      case 'sign': {
        const h = 7 * p.scale;
        mb.setInfo(STYLE_ID[civ.style], civ.decay, 1, MAT_METAL);
        post(mb, p.x, p.y, z, z + h, 0.16, 0.16, p.rot, 0.8);
        holoQuad(holo, p.x, p.y, z + h + 1.6 * p.scale, 5.5 * p.scale, 3.2 * p.scale, p.rot, 0, 1.0, p.seed);
        lights.push({ x: p.x, y: p.y, z: z + h, size: 7, tint: [neon[0], neon[1], neon[2]] });
        break;
      }
      case 'beacon': {
        mb.setInfo(STYLE_ID[civ.style], 0, 1, MAT_METAL);
        post(mb, p.x, p.y, z, z + 1.1, 0.18, 0.18, p.rot, 0.9);
        holoQuad(holo, p.x, p.y, z + 1.4, 1.2, 0.9, p.rot, 3, 1.6, p.seed);
        holoQuad(holo, p.x, p.y, z + 1.4, 1.2, 0.9, p.rot + Math.PI / 2, 3, 1.6, p.seed);
        lights.push({ x: p.x, y: p.y, z: z + 1.4, size: 4, tint: [1.4, 0.5, 0.2] });
        break;
      }
      case 'antenna':
      case 'pylon': {
        const h = (p.kind === 'pylon' ? 42 : 16) * p.scale;
        mb.setInfo(STYLE_ID[civ.style], civ.decay, 1, MAT_METAL);
        post(mb, p.x, p.y, z, z + h, 0.7 * p.scale, 0.7 * p.scale, p.rot, 0.85);
        post(mb, p.x, p.y, z + h, z + h * 1.4, 0.16 * p.scale, 0.16 * p.scale, p.rot, 0.95);
        lights.push({ x: p.x, y: p.y, z: z + h * 1.4, size: 14, tint: [1.6, 0.22, 0.12] });
        break;
      }
      case 'tank': {
        const r = 3.4 * p.scale;
        const poly: Poly = [];
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          poly.push(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
        }
        mb.setInfo(STYLE_ID[civ.style], civ.decay, 1, MAT_METAL);
        mb.setAO(0.85);
        extrude(mb, poly, z, z + 7 * p.scale, z, 0, 0.85);
        dome(mb, p.x, p.y, r, z + 7 * p.scale, r * 0.45, 0.95);
        break;
      }
      case 'statue': {
        mb.setInfo(STYLE_ID[civ.style], civ.decay, 1, MAT_METAL);
        post(mb, p.x, p.y, z, z + 2.2 * p.scale, 1.2 * p.scale, 1.2 * p.scale, p.rot, 0.7);
        post(mb, p.x, p.y, z + 2.2 * p.scale, z + 6 * p.scale, 0.45 * p.scale, 0.45 * p.scale, p.rot, 0.9);
        break;
      }
      case 'tree': {
        // A civic tree: trunk plus two stacked canopies. The scatter system owns
        // wild flora, but a street needs its own or the paving reads as a car park.
        const h = 4.5 * p.scale;
        mb.setInfo(STYLE_ID[civ.style], 0.1, 1, 4 /* timber */);
        post(mb, p.x, p.y, z, z + h * 0.55, 0.16 * p.scale, 0.16 * p.scale, p.rot, 0.75);
        mb.setInfo(STYLE_ID[civ.style], 0.1, 1, 6 /* fabric — soft, matte */);
        const r = 1.5 * p.scale;
        const ring: Poly = [];
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2 + p.rot;
          ring.push(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
        }
        mb.setAO(0.8);
        extrude(mb, ring, z + h * 0.5, z + h * 0.78, z, 0, 0.8);
        hipRoof(mb, ring, z + h * 0.78, h * 0.42, 0.95);
        break;
      }
    }
  }
}

/** One additive quad in the holo buffer. `kind` matches the holo shader. */
function holoQuad(
  mb: MeshBuilder,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  rot: number,
  kind: number,
  bright: number,
  seed: number
): void {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const hw = w * 0.5;
  const hh = h * 0.5;
  mb.setFacade(kind === 0 ? 0.35 : 0.0, Math.floor(seed * 8), bright, seed);
  mb.setInfo(kind, 0, 1, 0);
  const nx = -s;
  const ny = c;
  const p0 = mb.vertex(x - c * hw, y - s * hw, z - hh, nx, ny, 0, 0, 0);
  const p1 = mb.vertex(x + c * hw, y + s * hw, z - hh, nx, ny, 0, 1, 0);
  const p2 = mb.vertex(x + c * hw, y + s * hw, z + hh, nx, ny, 0, 1, 1);
  const p3 = mb.vertex(x - c * hw, y - s * hw, z + hh, nx, ny, 0, 0, 1);
  mb.quad(p0, p1, p2, p3);
}

/** Façade signage on the buildings that would carry it. */
export function emitFacadeSigns(holo: MeshBuilder, buildings: BuildingParams[], datum: number, rng: Rng, budget: number): void {
  let placed = 0;
  for (const b of buildings) {
    if (placed >= budget) break;
    if (b.district !== 'core' && b.district !== 'market') continue;
    if (!rng.chance(b.district === 'market' ? 0.5 : 0.25)) continue;
    const base = b.base - datum;
    // Hang it off the long face, a couple of storeys up.
    const nx = -b.uy;
    const ny = b.ux;
    const z = base + Math.min(b.height * 0.65, b.floorHeight * rng.range(1.6, 5));
    const w = Math.min(b.hu * 1.6, 14);
    const side = rng.chance(0.5) ? 1 : -1;
    holoQuad(
      holo,
      b.x + nx * (b.hv + 0.5) * side,
      b.y + ny * (b.hv + 0.5) * side,
      z,
      w,
      w * rng.range(0.22, 0.5),
      Math.atan2(b.uy, b.ux),
      0,
      rng.range(0.7, 1.5),
      b.seed
    );
    placed++;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Traffic
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The vehicle model, shared by every instance: a body, two headlights, two
 * tail lights. `aPart` selects the shading branch per vertex, so one draw call
 * carries both the metal and the light sources.
 */
function vehicleGeometry(): { pos: Float32Array; nor: Float32Array; uv: Float32Array; part: Float32Array; idx: Uint16Array } {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const part: number[] = [];
  const idx: number[] = [];

  // Model space: x lateral, y forward, z up — the traffic shader's convention.
  const box = (hx: number, hy: number, hz: number, cz: number, p: number) => {
    const v = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
      [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    ];
    const faces: [number, number, number, number, number[]][] = [
      [0, 1, 2, 3, [0, 0, -1]],
      [4, 7, 6, 5, [0, 0, 1]],
      [0, 4, 5, 1, [0, -1, 0]],
      [2, 6, 7, 3, [0, 1, 0]],
      [1, 5, 6, 2, [1, 0, 0]],
      [3, 7, 4, 0, [-1, 0, 0]],
    ];
    for (const [a, b, c, d, n] of faces) {
      const s = pos.length / 3;
      for (const k of [a, b, c, d]) {
        pos.push(v[k][0], v[k][1], v[k][2] + cz);
        nor.push(n[0], n[1], n[2]);
        part.push(p);
      }
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(s, s + 1, s + 2, s, s + 2, s + 3);
    }
  };

  box(0.9, 2.3, 0.55, 0.55, 0);   // body
  box(0.62, 1.1, 0.34, 1.42, 0);  // cabin
  box(0.34, 0.06, 0.14, 0.72, 1); // headlights (one bar; cheaper than two)
  box(0.44, 0.06, 0.1, 0.78, 2);  // tail bar
  // Move the light bars to the ends of the body.
  const n = pos.length / 3;
  for (let i = 0; i < n; i++) {
    if (part[i] === 1) pos[i * 3 + 1] += 2.3;
    else if (part[i] === 2) pos[i * 3 + 1] -= 2.3;
  }

  return {
    pos: new Float32Array(pos),
    nor: new Float32Array(nor),
    uv: new Float32Array(uv),
    part: new Float32Array(part),
    idx: new Uint16Array(idx),
  };
}

export function emitTraffic(lanes: Lane[], datum: number, civ: CivilizationSpec, seed: number): InstancedBufferGeometry | null {
  let total = 0;
  for (const l of lanes) total += l.count;
  if (total === 0) return null;

  const model = vehicleGeometry();
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(model.pos, 3));
  g.setAttribute('normal', new BufferAttribute(model.nor, 3));
  g.setAttribute('uv', new BufferAttribute(model.uv, 2));
  g.setAttribute('aPart', new BufferAttribute(model.part, 1));
  g.setIndex(new BufferAttribute(model.idx, 1));

  const A = new Float32Array(total * 3);
  const B = new Float32Array(total * 3);
  const L = new Float32Array(total * 4);
  const T = new Float32Array(total * 3);
  const rng = new Rng(seed ^ 0x71a4);
  let k = 0;
  for (const lane of lanes) {
    for (let i = 0; i < lane.count; i++) {
      A[k * 3] = lane.ax;
      A[k * 3 + 1] = lane.ay;
      A[k * 3 + 2] = lane.az - datum;
      B[k * 3] = lane.bx;
      B[k * 3 + 1] = lane.by;
      B[k * 3 + 2] = lane.bz - datum;
      L[k * 4] = lane.arc;
      L[k * 4 + 1] = (i / lane.count + rng.range(-0.03, 0.03) + 1) % 1;
      L[k * 4 + 2] = lane.speed * rng.range(0.88, 1.14);
      L[k * 4 + 3] = lane.air > 0.5 ? rng.range(-3, 3) : rng.range(-0.5, 0.5);
      // Vehicles are painted; the civilisation's neon leaks into the fleet.
      const t = rng.next();
      T[k * 3] = mix(0.5, civ.neon[0], t * 0.5) + rng.range(-0.1, 0.1);
      T[k * 3 + 1] = mix(0.52, civ.neon[1], t * 0.5) + rng.range(-0.1, 0.1);
      T[k * 3 + 2] = mix(0.56, civ.neon[2], t * 0.5) + rng.range(-0.1, 0.1);
      k++;
    }
  }
  g.setAttribute('aA', new InstancedBufferAttribute(A, 3));
  g.setAttribute('aB', new InstancedBufferAttribute(B, 3));
  g.setAttribute('aLane', new InstancedBufferAttribute(L, 4));
  g.setAttribute('aTint', new InstancedBufferAttribute(T, 3));
  g.instanceCount = total;
  g.computeBoundingSphere();
  return g;
}

/* ═══════════════════════════════════════════════════════════════════════════
   The whole settlement
   ═══════════════════════════════════════════════════════════════════════════ */

export interface EmitCaps {
  detail: number;
  traffic: number;
  signs: number;
}

/**
 * Emit every buffer for one settlement. Runs as a generator so the caller can
 * spend it a few milliseconds at a time — a megacity is 200 k triangles and
 * building it in one tick would drop a frame the player would feel.
 */
export function* emitCity(layout: Layout, hf: Heightfield, civ: CivilizationSpec, caps: EmitCaps): Generator<number, CityGeometry, void> {
  const frame = hf.frame;
  const datum = frame.baseElev;

  const cityB = new MeshBuilder(frame);
  const roadB = new MeshBuilder(frame);
  const groundB = new MeshBuilder(frame);
  const holoB = new MeshBuilder(frame);
  const obstacles: Obstacle[] = [];
  const lightPoints: CityGeometry['lightPoints'] = [];

  emitGround(groundB, layout.ground, hf, datum, civ);
  yield 0.1;
  emitRoads(roadB, layout.streets, hf, datum, civ, caps.detail);
  yield 0.2;

  const n = layout.buildings.length;
  const chunk = Math.max(24, Math.ceil(n / 14));
  for (let i = 0; i < n; i += chunk) {
    const end = Math.min(n, i + chunk);
    for (let k = i; k < end; k++) emitBuilding(cityB, layout.buildings[k], datum, obstacles, lightPoints, civ.neon);
    yield 0.2 + 0.6 * (end / n);
  }

  emitProps(cityB, holoB, layout.props, datum, civ, lightPoints);
  yield 0.9;
  emitFacadeSigns(holoB, layout.buildings, datum, new Rng(layout.site.seed ^ 0x515), caps.signs);

  const traffic = emitTraffic(layout.lanes, datum, civ, layout.site.seed);
  yield 1;

  return {
    city: cityB.empty ? null : cityB.toGeometry(),
    road: roadB.empty ? null : roadB.toGeometry(),
    ground: groundB.empty ? null : groundB.toGeometry(),
    holo: holoB.empty ? null : holoB.toGeometry(),
    traffic,
    obstacles,
    lightPoints,
  };
}
