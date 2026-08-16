/**
 * Geometry plumbing for the civilisation subsystem.
 *
 * Three things live here, all of them boring on purpose:
 *
 *   TangentFrame  — a local east/north/up chart on the planet. Cities are laid
 *                   out flat, then bent onto the sphere when the vertices are
 *                   written. A 5 km megacity on a 6371 km world drops ~2 m from
 *                   centre to edge; ignore that and the far side of the city
 *                   floats, so we do the exponential map properly at build time
 *                   (it costs nothing — it happens once, off the frame budget).
 *
 *   Heightfield   — a cached grid of `IPlanet.heightAt` samples. Every parcel,
 *                   road and lamppost needs the ground height dozens of times;
 *                   sampling the planet's noise that often would be madness.
 *
 *   MeshBuilder   — a growable interleaved vertex sink. A whole city ends up in
 *                   two or three BufferGeometries, which is the only way to get
 *                   a city into tens of draw calls instead of tens of thousands.
 */

import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';
import type { IPlanet } from '../api/Contracts';
import type { Poly } from './CivTypes';

/* ═══════════════════════════════════════════════════════════════════════════
   Tangent frame
   ═══════════════════════════════════════════════════════════════════════════ */

const _v = new Vector3();
const _w = new Vector3();

export class TangentFrame {
  /** Unit direction of the frame origin from the planet centre. */
  readonly center = new Vector3();
  readonly east = new Vector3();
  readonly north = new Vector3();
  readonly up = new Vector3();
  /** Planet-local position of the frame origin (metres). */
  readonly origin = new Vector3();
  /** Reference sphere radius. */
  planetRadius = 1;
  /** Terrain elevation at the origin, metres above the reference sphere. */
  baseElev = 0;

  constructor(dir: Vector3, planetRadius: number, baseElev: number) {
    this.center.copy(dir).normalize();
    this.planetRadius = planetRadius;
    this.baseElev = baseElev;
    this.up.copy(this.center);
    // Any stable tangent basis will do, but it must be stable: derive it from
    // the world axes so the same site always produces the same street grid.
    const ref = Math.abs(this.center.y) > 0.94 ? _v.set(0, 0, 1) : _v.set(0, 1, 0);
    this.east.copy(ref).cross(this.center).normalize();
    this.north.copy(this.center).clone().cross(this.east).normalize();
    this.origin.copy(this.center).multiplyScalar(planetRadius + baseElev);
  }

  /** Rotate the frame about its up axis — lets a city face the sea. */
  rotate(rad: number): this {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const ex = this.east.x * c + this.north.x * s;
    const ey = this.east.y * c + this.north.y * s;
    const ez = this.east.z * c + this.north.z * s;
    const nx = this.north.x * c - this.east.x * s;
    const ny = this.north.y * c - this.east.y * s;
    const nz = this.north.z * c - this.east.z * s;
    this.east.set(ex, ey, ez);
    this.north.set(nx, ny, nz);
    return this;
  }

  /** Unit direction from the planet centre for a tangent-plane point. */
  dirFor(x: number, y: number, out: Vector3 = new Vector3()): Vector3 {
    const d = Math.sqrt(x * x + y * y);
    if (d < 1e-6) return out.copy(this.center);
    const t = d / this.planetRadius; // arc length → angle
    const ct = Math.cos(t);
    const st = Math.sin(t) / d;
    out.set(
      this.center.x * ct + (this.east.x * x + this.north.x * y) * st,
      this.center.y * ct + (this.east.y * x + this.north.y * y) * st,
      this.center.z * ct + (this.east.z * x + this.north.z * y) * st
    );
    return out.normalize();
  }

  /** Tangent-plane (x, y, z-above-datum-relative-to-origin) → planet-local. */
  toPlanet(x: number, y: number, z: number, out: Vector3 = new Vector3()): Vector3 {
    this.dirFor(x, y, out);
    return out.multiplyScalar(this.planetRadius + this.baseElev + z);
  }

  /**
   * Tangent-plane → the frame's own group space (origin at `origin`, axes
   * east/north/up). This is what goes into vertex buffers: small numbers, so
   * float32 keeps millimetre precision, with the curvature already baked in.
   */
  toGroup(x: number, y: number, z: number, out: Vector3 = new Vector3()): Vector3 {
    this.toPlanet(x, y, z, out);
    out.sub(this.origin);
    const gx = out.dot(this.east);
    const gy = out.dot(this.north);
    const gz = out.dot(this.up);
    return out.set(gx, gy, gz);
  }

  /** Planet-local position → tangent-plane (x, y, z). Inverse of `toGroup`. */
  toLocal(p: Vector3, out: Vector3 = new Vector3()): Vector3 {
    const r = p.length();
    _w.copy(p).multiplyScalar(r > 1e-9 ? 1 / r : 0);
    const cd = Math.max(-1, Math.min(1, _w.dot(this.center)));
    const ang = Math.acos(cd);
    const arc = ang * this.planetRadius;
    // Project onto the tangent basis and rescale to arc length.
    const ex = _w.dot(this.east);
    const ny = _w.dot(this.north);
    const len = Math.sqrt(ex * ex + ny * ny);
    const s = len > 1e-9 ? arc / len : 0;
    return out.set(ex * s, ny * s, r - this.planetRadius - this.baseElev);
  }

  /** A group-space direction (e.g. the sun) from a planet-local direction. */
  dirToGroup(d: Vector3, out: Vector3 = new Vector3()): Vector3 {
    return out.set(d.dot(this.east), d.dot(this.north), d.dot(this.up));
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Height cache
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A square grid of terrain heights around a settlement, filled incrementally so
 * a 128² grid (16 k `heightAt` calls) never lands in one frame.
 */
export class Heightfield {
  readonly res: number;
  readonly halfExtent: number;
  readonly data: Float32Array;
  readonly frame: TangentFrame;
  /** Sea level as an elevation above the reference sphere, or -Infinity. */
  seaElev: number;
  private cursor = 0;
  private minH = Infinity;
  private maxH = -Infinity;

  constructor(frame: TangentFrame, halfExtent: number, res: number, seaElev: number) {
    this.frame = frame;
    this.halfExtent = halfExtent;
    this.res = res;
    this.seaElev = seaElev;
    this.data = new Float32Array(res * res);
  }

  get complete(): boolean {
    return this.cursor >= this.res * this.res;
  }

  get min(): number {
    return this.minH;
  }
  get max(): number {
    return this.maxH;
  }

  /** Fill up to `count` cells. Returns true when the field is complete. */
  fill(planet: IPlanet, count: number): boolean {
    const n = this.res * this.res;
    const step = (this.halfExtent * 2) / (this.res - 1);
    const dir = new Vector3();
    const end = Math.min(n, this.cursor + count);
    for (let i = this.cursor; i < end; i++) {
      const gx = i % this.res;
      const gy = (i / this.res) | 0;
      const x = -this.halfExtent + gx * step;
      const y = -this.halfExtent + gy * step;
      this.frame.dirFor(x, y, dir);
      const h = planet.heightAt(dir);
      this.data[i] = h;
      if (h < this.minH) this.minH = h;
      if (h > this.maxH) this.maxH = h;
    }
    this.cursor = end;
    return this.cursor >= n;
  }

  /** Bilinear height at a tangent-plane point, clamped at the edges. */
  at(x: number, y: number): number {
    const r = this.res;
    const s = (r - 1) / (this.halfExtent * 2);
    let fx = (x + this.halfExtent) * s;
    let fy = (y + this.halfExtent) * s;
    fx = fx < 0 ? 0 : fx > r - 1.001 ? r - 1.001 : fx;
    fy = fy < 0 ? 0 : fy > r - 1.001 ? r - 1.001 : fy;
    const ix = fx | 0;
    const iy = fy | 0;
    const tx = fx - ix;
    const ty = fy - iy;
    const d = this.data;
    const i0 = iy * r + ix;
    const i1 = i0 + r;
    const a = d[i0] + (d[i0 + 1] - d[i0]) * tx;
    const b = d[i1] + (d[i1 + 1] - d[i1]) * tx;
    return a + (b - a) * ty;
  }

  /** 0 = flat, 1 = vertical. Central differences over one cell. */
  slopeAt(x: number, y: number): number {
    const e = (this.halfExtent * 2) / (this.res - 1);
    const dx = (this.at(x + e, y) - this.at(x - e, y)) / (2 * e);
    const dy = (this.at(x, y + e) - this.at(x, y - e)) / (2 * e);
    const g = Math.sqrt(dx * dx + dy * dy);
    return g / (1 + g);
  }

  underwater(x: number, y: number): boolean {
    return this.at(x, y) < this.seaElev;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Convex polygon utilities — the whole city plan is convex pieces
   ═══════════════════════════════════════════════════════════════════════════ */

export function polyArea(p: Poly): number {
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a * 0.5;
}

export function polyCentroid(p: Poly, out: [number, number] = [0, 0]): [number, number] {
  let cx = 0;
  let cy = 0;
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = p[i * 2];
    const y0 = p[i * 2 + 1];
    const x1 = p[j * 2];
    const y1 = p[j * 2 + 1];
    const cr = x0 * y1 - x1 * y0;
    a += cr;
    cx += (x0 + x1) * cr;
    cy += (y0 + y1) * cr;
  }
  if (Math.abs(a) < 1e-9) {
    cx = 0;
    cy = 0;
    for (let i = 0; i < n; i++) {
      cx += p[i * 2];
      cy += p[i * 2 + 1];
    }
    out[0] = cx / n;
    out[1] = cy / n;
    return out;
  }
  out[0] = cx / (3 * a);
  out[1] = cy / (3 * a);
  return out;
}

/** Clip a convex polygon to the half-plane `dot(p - o, n) <= 0`. */
export function polyClip(p: Poly, ox: number, oy: number, nx: number, ny: number): Poly {
  const out: Poly = [];
  const n = p.length / 2;
  if (n < 3) return out;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[i * 2];
    const ay = p[i * 2 + 1];
    const bx = p[j * 2];
    const by = p[j * 2 + 1];
    const da = (ax - ox) * nx + (ay - oy) * ny;
    const db = (bx - ox) * nx + (by - oy) * ny;
    if (da <= 0) out.push(ax, ay);
    if (da * db < 0) {
      const t = da / (da - db);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return out;
}

/** Shrink a convex polygon by `d` metres on every edge. */
export function polyInset(p: Poly, d: number): Poly {
  let out = p;
  const n = p.length / 2;
  const sign = polyArea(p) >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[i * 2];
    const ay = p[i * 2 + 1];
    const bx = p[j * 2];
    const by = p[j * 2 + 1];
    let ex = bx - ax;
    let ey = by - ay;
    const l = Math.hypot(ex, ey);
    if (l < 1e-6) continue;
    ex /= l;
    ey /= l;
    // Outward normal for a CCW polygon is (ey, -ex).
    const nx = ey * sign;
    const ny = -ex * sign;
    out = polyClip(out, ax + nx * -d, ay + ny * -d, nx, ny);
    if (out.length < 6) return [];
  }
  return out;
}

export interface OBB2 {
  x: number;
  y: number;
  ux: number;
  uy: number;
  hu: number;
  hv: number;
}

/** Minimum-area rectangle over a convex polygon (rotating calipers, brute). */
export function polyOBB(p: Poly): OBB2 {
  const n = p.length / 2;
  let best: OBB2 = { x: 0, y: 0, ux: 1, uy: 0, hu: 0, hv: 0 };
  let bestArea = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let ex = p[j * 2] - p[i * 2];
    let ey = p[j * 2 + 1] - p[i * 2 + 1];
    const l = Math.hypot(ex, ey);
    if (l < 1e-6) continue;
    ex /= l;
    ey /= l;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let k = 0; k < n; k++) {
      const u = p[k * 2] * ex + p[k * 2 + 1] * ey;
      const v = -p[k * 2] * ey + p[k * 2 + 1] * ex;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) * 0.5;
      const cv = (minV + maxV) * 0.5;
      best = {
        x: cu * ex - cv * ey,
        y: cu * ey + cv * ex,
        ux: ex,
        uy: ey,
        hu: (maxU - minU) * 0.5,
        hv: (maxV - minV) * 0.5,
      };
    }
  }
  return best;
}

/** Axis-aligned rectangle as a polygon. */
export function rectPoly(cx: number, cy: number, hx: number, hy: number, rot = 0): Poly {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const out: Poly = [];
  const cor = [
    [-hx, -hy],
    [hx, -hy],
    [hx, hy],
    [-hx, hy],
  ];
  for (const [x, y] of cor) out.push(cx + x * c - y * s, cy + x * s + y * c);
  return out;
}

/** Regular n-gon, optionally jittered per-vertex by a callback. */
export function ngonPoly(cx: number, cy: number, r: number, n: number, phase = 0, jitter?: (i: number) => number): Poly {
  const out: Poly = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const rr = jitter ? r * jitter(i) : r;
    out.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  return out;
}

export function polyContains(p: Poly, x: number, y: number): boolean {
  const n = p.length / 2;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cr = (p[j * 2] - p[i * 2]) * (y - p[i * 2 + 1]) - (p[j * 2 + 1] - p[i * 2 + 1]) * (x - p[i * 2]);
    if (cr > 1e-9) {
      if (sign < 0) return false;
      sign = 1;
    } else if (cr < -1e-9) {
      if (sign > 0) return false;
      sign = -1;
    }
  }
  return true;
}

/** Longest edge direction — the axis a parcel wants to be split across. */
export function polyLongAxis(p: Poly): [number, number, number] {
  const o = polyOBB(p);
  if (o.hu >= o.hv) return [o.ux, o.uy, o.hu * 2];
  return [-o.uy, o.ux, o.hv * 2];
}

/* ═══════════════════════════════════════════════════════════════════════════
   Mesh builder
   ═══════════════════════════════════════════════════════════════════════════ */

class Buf {
  data: Float32Array;
  len = 0;
  constructor(cap = 4096) {
    this.data = new Float32Array(cap);
  }
  need(n: number): void {
    if (this.len + n <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data.subarray(0, this.len));
    this.data = next;
  }
  push2(a: number, b: number): void {
    this.need(2);
    this.data[this.len++] = a;
    this.data[this.len++] = b;
  }
  push3(a: number, b: number, c: number): void {
    this.need(3);
    this.data[this.len++] = a;
    this.data[this.len++] = b;
    this.data[this.len++] = c;
  }
  push4(a: number, b: number, c: number, d: number): void {
    this.need(4);
    this.data[this.len++] = a;
    this.data[this.len++] = b;
    this.data[this.len++] = c;
    this.data[this.len++] = d;
  }
  view(): Float32Array {
    return this.data.subarray(0, this.len);
  }
}

class IBuf {
  data: Uint32Array;
  len = 0;
  constructor(cap = 8192) {
    this.data = new Uint32Array(cap);
  }
  push3(a: number, b: number, c: number): void {
    if (this.len + 3 > this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data.subarray(0, this.len));
      this.data = next;
    }
    this.data[this.len++] = a;
    this.data[this.len++] = b;
    this.data[this.len++] = c;
  }
  view(): Uint32Array {
    return this.data.subarray(0, this.len);
  }
}

/**
 * Interleaved sink for city geometry.
 *
 * `uv` is not a texture coordinate: it is (metres along the façade, metres above
 * the building base). The façade shader draws floors, bays and windows straight
 * out of it, so a thousand buildings share one material and no texture exists.
 */
export class MeshBuilder {
  private pos = new Buf(1 << 14);
  private nor = new Buf(1 << 14);
  private uvs = new Buf(1 << 13);
  private fac = new Buf(1 << 14);
  private inf = new Buf(1 << 14);
  private idx = new IBuf(1 << 15);
  /** Current attribute state, applied to every vertex pushed. */
  private f0 = 3.2;
  private f1 = 3.6;
  private f2 = 0.5;
  private f3 = 0.5;
  private i0 = 0;
  private i1 = 0;
  private i2 = 1;
  private i3 = 0;
  frame: TangentFrame | null = null;
  private tmp = new Vector3();
  vertexCount = 0;

  constructor(frame: TangentFrame | null = null) {
    this.frame = frame;
  }

  /** floorHeight, bayWidth, litProbability, per-building hash in [0,1). */
  setFacade(floorH: number, bay: number, lit: number, seed01: number): void {
    this.f0 = floorH;
    this.f1 = bay;
    this.f2 = lit;
    this.f3 = seed01;
  }

  /** styleId, decay, ambient occlusion, material family. */
  setInfo(styleId: number, decay: number, ao: number, matId: number): void {
    this.i0 = styleId;
    this.i1 = decay;
    this.i2 = ao;
    this.i3 = matId;
  }

  setAO(ao: number): void {
    this.i2 = ao;
  }

  /**
   * Push a vertex given in tangent-plane metres. Positions are bent onto the
   * sphere; normals are not — over a city the frame rotates by at most a
   * hundredth of a degree, which no lighting model can see.
   */
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    if (this.frame) {
      this.frame.toGroup(x, y, z, this.tmp);
      this.pos.push3(this.tmp.x, this.tmp.y, this.tmp.z);
    } else {
      this.pos.push3(x, y, z);
    }
    this.nor.push3(nx, ny, nz);
    this.uvs.push2(u, v);
    this.fac.push4(this.f0, this.f1, this.f2, this.f3);
    this.inf.push4(this.i0, this.i1, this.i2, this.i3);
    return this.vertexCount++;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push3(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push3(a, b, c);
    this.idx.push3(a, c, d);
  }

  get empty(): boolean {
    return this.vertexCount === 0 || this.idx.len === 0;
  }

  /** Hand the accumulated buffers to the GPU. The builder is spent afterwards. */
  toGeometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos.view()), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor.view()), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uvs.view()), 2));
    g.setAttribute('aFacade', new BufferAttribute(new Float32Array(this.fac.view()), 4));
    g.setAttribute('aInfo', new BufferAttribute(new Float32Array(this.inf.view()), 4));
    g.setIndex(new BufferAttribute(new Uint32Array(this.idx.view()), 1));
    g.computeBoundingSphere();
    if (!g.boundingSphere) g.boundingSphere = new Sphere(new Vector3(), 1);
    return g;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Small numeric helpers
   ═══════════════════════════════════════════════════════════════════════════ */

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep01(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
