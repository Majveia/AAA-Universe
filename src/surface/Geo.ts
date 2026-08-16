/**
 * Geometry plumbing for everything that grows on a planet.
 *
 * Two jobs live here:
 *   1. `MeshBuf` — a plain array vertex accumulator with the extra channels the
 *      scatter shaders need (sway weight, tint, per-branch phase, glow mask).
 *      Plants and rocks are built once per planet, so clarity beats cleverness.
 *   2. Sphere ↔ cube-face cell addressing. Scatter placement must be stable
 *      *globally* — the same boulder in the same riverbed a year later — so
 *      cells are indexed off an equi-angular cube map of the planet rather than
 *      off a tangent plane that follows the player around.
 */

import {
  BufferAttribute,
  BufferGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Vector3,
} from 'three';

/* ═══════════════════════════════════════════════════════════════════════════
   Vertex accumulator
   ═══════════════════════════════════════════════════════════════════════════ */

export class MeshBuf {
  pos: number[] = [];
  nrm: number[] = [];
  /** 0 at the anchored base, 1 at the most flexible tip. Drives wind sway. */
  sway: number[] = [];
  /** 0–1 blend between the species' two colours. */
  tint: number[] = [];
  /** Per-branch phase offset so limbs of the same plant don't move in lockstep. */
  phase: number[] = [];
  /** 0–1 bioluminescence mask. */
  glow: number[] = [];
  idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vert(
    px: number, py: number, pz: number,
    nx: number, ny: number, nz: number,
    sway: number, tint: number, phase: number, glow: number,
  ): number {
    const i = this.pos.length / 3;
    this.pos.push(px, py, pz);
    this.nrm.push(nx, ny, nz);
    this.sway.push(sway);
    this.tint.push(tint);
    this.phase.push(phase);
    this.glow.push(glow);
    return i;
  }

  vertV(p: Vector3, n: Vector3, sway: number, tint: number, phase: number, glow: number): number {
    return this.vert(p.x, p.y, p.z, n.x, n.y, n.z, sway, tint, phase, glow);
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Bounding radius in the XZ plane and total height, used for LOD + collision. */
  bounds(): { radius: number; height: number; base: number } {
    let r = 0;
    let hi = -1e9;
    let lo = 1e9;
    for (let i = 0; i < this.pos.length; i += 3) {
      const x = this.pos[i];
      const y = this.pos[i + 1];
      const z = this.pos[i + 2];
      const d = Math.sqrt(x * x + z * z);
      if (d > r) r = d;
      if (y > hi) hi = y;
      if (y < lo) lo = y;
    }
    return { radius: r, height: hi - Math.min(0, lo), base: lo };
  }

  toGeometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('aSway', new BufferAttribute(new Float32Array(this.sway), 1));
    g.setAttribute('aTint', new BufferAttribute(new Float32Array(this.tint), 1));
    g.setAttribute('aPhase', new BufferAttribute(new Float32Array(this.phase), 1));
    g.setAttribute('aGlow', new BufferAttribute(new Float32Array(this.glow), 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Empty geometry with the right attribute set — for layers with nothing to draw. */
export function emptyGeometry(): BufferGeometry {
  const b = new MeshBuf();
  b.vert(0, 0, 0, 0, 1, 0, 0, 0, 0, 0);
  b.vert(0, 0, 0, 0, 1, 0, 0, 0, 0, 0);
  b.vert(0, 0, 0, 0, 1, 0, 0, 0, 0, 0);
  b.tri(0, 1, 2);
  return b.toGeometry();
}

/* ═══════════════════════════════════════════════════════════════════════════
   Branch extrusion
   ═══════════════════════════════════════════════════════════════════════════ */

export interface Frame {
  pos: Vector3;
  /** Along-branch tangent, normalised. */
  dir: Vector3;
  right: Vector3;
  radius: number;
  /** 0–1 along the branch. */
  t: number;
  sway: number;
  tint: number;
  glow: number;
}

const _u = new Vector3();
const _v = new Vector3();
const _n = new Vector3();
const _p = new Vector3();

/**
 * Extrude a ring-swept tube along a frame list. Rings are stitched with a
 * shared seam vertex pair (duplicated) so normals stay smooth around the trunk.
 */
export function extrudeBranch(buf: MeshBuf, frames: Frame[], sides: number, phase: number, capTip: boolean): void {
  if (frames.length < 2) return;
  const ringStart: number[] = [];

  for (let f = 0; f < frames.length; f++) {
    const fr = frames[f];
    _u.copy(fr.right);
    _v.crossVectors(fr.dir, _u).normalize();
    const base = buf.count;
    ringStart.push(base);
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      _n.set(_u.x * ca + _v.x * sa, _u.y * ca + _v.y * sa, _u.z * ca + _v.z * sa).normalize();
      _p.copy(fr.pos).addScaledVector(_n, fr.radius);
      buf.vertV(_p, _n, fr.sway, fr.tint, phase, fr.glow);
    }
  }

  for (let f = 0; f < frames.length - 1; f++) {
    const a0 = ringStart[f];
    const a1 = ringStart[f + 1];
    for (let s = 0; s < sides; s++) {
      buf.quad(a0 + s, a0 + s + 1, a1 + s + 1, a1 + s);
    }
  }

  if (capTip) {
    const last = frames[frames.length - 1];
    const c = buf.vertV(last.pos, last.dir, last.sway, last.tint, phase, last.glow);
    const a0 = ringStart[frames.length - 1];
    for (let s = 0; s < sides; s++) buf.tri(a0 + s, a0 + s + 1, c);
  }
}

/** A flat, double-sided, tapered blade — grass, leaves, fins, kelp fronds. */
export function addBlade(
  buf: MeshBuf,
  origin: Vector3,
  dir: Vector3,
  side: Vector3,
  length: number,
  width: number,
  segments: number,
  curve: number,
  phase: number,
  tint0: number,
  tint1: number,
  glow: number,
  normalLift: number,
): void {
  const rows: number[][] = [];
  const up = _n.copy(dir).normalize();
  const bend = _u.crossVectors(side, up).normalize();

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // Blades bow over: the tip droops along `bend` proportional to t².
    _p.copy(origin)
      .addScaledVector(up, length * t)
      .addScaledVector(bend, curve * length * t * t);
    const w = width * (1 - t * t * 0.92);
    const sway = Math.pow(t, 1.55);
    const tt = tint0 + (tint1 - tint0) * t;

    // Normals lifted toward the blade's own up: a plain flat normal makes a
    // field of grass read as dark cardboard from a low camera.
    _v.copy(bend).multiplyScalar(-1).addScaledVector(up, normalLift).normalize();

    const a = buf.vert(
      _p.x - side.x * w, _p.y - side.y * w, _p.z - side.z * w,
      _v.x, _v.y, _v.z, sway, tt, phase, glow,
    );
    const b = buf.vert(
      _p.x + side.x * w, _p.y + side.y * w, _p.z + side.z * w,
      _v.x, _v.y, _v.z, sway, tt, phase, glow,
    );
    rows.push([a, b]);
  }

  for (let i = 0; i < segments; i++) {
    const [a0, b0] = rows[i];
    const [a1, b1] = rows[i + 1];
    buf.quad(a0, b0, b1, a1);
    // Back faces, so a blade reads from both sides without double-sided
    // rendering (which would break the dithered LOD discard ordering).
    buf.quad(a1, b1, b0, a0);
  }
}

/** A fan / palmate leaf: a half-disc of triangles with a drooping rim. */
export function addFan(
  buf: MeshBuf,
  origin: Vector3,
  dir: Vector3,
  side: Vector3,
  radius: number,
  spreadRad: number,
  rays: number,
  droop: number,
  phase: number,
  tint0: number,
  tint1: number,
  glow: number,
): void {
  const up = new Vector3().copy(dir).normalize();
  const bend = new Vector3().crossVectors(side, up).normalize();
  const nrm = new Vector3().copy(bend).multiplyScalar(-1);
  const c = buf.vertV(origin, nrm, 0.1, tint0, phase, glow);
  const rim: number[] = [];
  for (let i = 0; i <= rays; i++) {
    const a = (i / rays - 0.5) * spreadRad;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    _p.copy(origin)
      .addScaledVector(up, radius * ca)
      .addScaledVector(side, radius * sa)
      .addScaledVector(bend, droop * radius * ca * ca);
    rim.push(buf.vertV(_p, nrm, 0.9, tint1, phase, glow));
  }
  for (let i = 0; i < rays; i++) {
    buf.tri(c, rim[i], rim[i + 1]);
    buf.tri(c, rim[i + 1], rim[i]);
  }
}

/** Crossed quads used as a far impostor. The shader carves the silhouette. */
export function addImpostorCross(
  buf: MeshBuf,
  height: number,
  radius: number,
  planes: number,
  tint: number,
  glow: number,
): void {
  for (let p = 0; p < planes; p++) {
    const a = (p / planes) * Math.PI;
    const sx = Math.cos(a);
    const sz = Math.sin(a);
    const nx = -sz;
    const nz = sx;
    const y0 = height * 0.02;
    const y1 = height;
    const v0 = buf.vert(-sx * radius, y0, -sz * radius, nx, 0.35, nz, 0.0, tint, p * 0.37, glow);
    const v1 = buf.vert(sx * radius, y0, sz * radius, nx, 0.35, nz, 0.0, tint, p * 0.37, glow);
    const v2 = buf.vert(sx * radius, y1, sz * radius, nx, 0.35, nz, 0.65, tint, p * 0.37, glow);
    const v3 = buf.vert(-sx * radius, y1, -sz * radius, nx, 0.35, nz, 0.65, tint, p * 0.37, glow);
    buf.quad(v0, v1, v2, v3);
    buf.quad(v3, v2, v1, v0);
  }
}

/**
 * Deformed icosphere — the basis of every rock, boulder and pebble. Written as
 * a subdivided icosahedron by hand so the displacement can run per-vertex with
 * a seeded field, and so the tint channel can carry the cavity term.
 */
export function icosphere(subdiv: number): { positions: Vector3[]; faces: [number, number, number][] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const positions: Vector3[] = [
    new Vector3(-1, t, 0), new Vector3(1, t, 0), new Vector3(-1, -t, 0), new Vector3(1, -t, 0),
    new Vector3(0, -1, t), new Vector3(0, 1, t), new Vector3(0, -1, -t), new Vector3(0, 1, -t),
    new Vector3(t, 0, -1), new Vector3(t, 0, 1), new Vector3(-t, 0, -1), new Vector3(-t, 0, 1),
  ].map((v) => v.normalize());

  let faces: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (let s = 0; s < subdiv; s++) {
    const mid = new Map<number, number>();
    const next: [number, number, number][] = [];
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 100000 + b : b * 100000 + a;
      const hit = mid.get(key);
      if (hit !== undefined) return hit;
      const v = new Vector3().addVectors(positions[a], positions[b]).normalize();
      positions.push(v);
      const i = positions.length - 1;
      mid.set(key, i);
      return i;
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  return { positions, faces };
}

/** Recompute smooth normals from the index buffer. */
export function recomputeNormals(buf: MeshBuf): void {
  const n = buf.count;
  const acc = new Float32Array(n * 3);
  for (let i = 0; i < buf.idx.length; i += 3) {
    const a = buf.idx[i] * 3;
    const b = buf.idx[i + 1] * 3;
    const c = buf.idx[i + 2] * 3;
    const ax = buf.pos[a], ay = buf.pos[a + 1], az = buf.pos[a + 2];
    const e1x = buf.pos[b] - ax, e1y = buf.pos[b + 1] - ay, e1z = buf.pos[b + 2] - az;
    const e2x = buf.pos[c] - ax, e2y = buf.pos[c + 1] - ay, e2z = buf.pos[c + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    acc[a] += nx; acc[a + 1] += ny; acc[a + 2] += nz;
    acc[b] += nx; acc[b + 1] += ny; acc[b + 2] += nz;
    acc[c] += nx; acc[c + 1] += ny; acc[c + 2] += nz;
  }
  for (let i = 0; i < n; i++) {
    const x = acc[i * 3], y = acc[i * 3 + 1], z = acc[i * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    buf.nrm[i * 3] = x / l;
    buf.nrm[i * 3 + 1] = y / l;
    buf.nrm[i * 3 + 2] = z / l;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Instancing
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Wrap a base geometry as instanced, *sharing* the caller's instance attributes.
 * Every LOD of a scatter layer references the same attribute objects, so one
 * upload feeds all of them and an instance never has to be moved between LODs —
 * the vertex shader decides which LOD draws it.
 */
export function toInstanced(
  base: BufferGeometry,
  attrs: Record<string, InstancedBufferAttribute>,
): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  for (const name of Object.keys(base.attributes)) {
    g.setAttribute(name, base.attributes[name]);
  }
  if (base.index) g.setIndex(base.index);
  for (const name of Object.keys(attrs)) g.setAttribute(name, attrs[name]);
  g.boundingSphere = base.boundingSphere ? base.boundingSphere.clone() : null;
  return g;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Sphere ↔ cube cell addressing
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Equi-angular cube map. The tangent warp keeps cell areas within ~1.3× of each
 * other across a face instead of the 5.2× a naive cube map gives, so grass
 * density does not visibly change as you walk toward a face corner.
 */
const WARP = Math.PI / 4;

function warp(u: number): number {
  return Math.tan(u * WARP);
}
function unwarp(x: number): number {
  return Math.atan(x) / WARP;
}

/** face → [normal axis, u axis, v axis] as signed axis indices. */
const FACE_N: Vector3[] = [
  new Vector3(1, 0, 0), new Vector3(-1, 0, 0),
  new Vector3(0, 1, 0), new Vector3(0, -1, 0),
  new Vector3(0, 0, 1), new Vector3(0, 0, -1),
];
const FACE_U: Vector3[] = [
  new Vector3(0, 0, -1), new Vector3(0, 0, 1),
  new Vector3(1, 0, 0), new Vector3(1, 0, 0),
  new Vector3(1, 0, 0), new Vector3(-1, 0, 0),
];
const FACE_V: Vector3[] = [
  new Vector3(0, 1, 0), new Vector3(0, 1, 0),
  new Vector3(0, 0, 1), new Vector3(0, 0, -1),
  new Vector3(0, 1, 0), new Vector3(0, 1, 0),
];

export interface FaceUV {
  face: number;
  u: number;
  v: number;
}

export function dirToFaceUV(d: Vector3, out: FaceUV): FaceUV {
  const ax = Math.abs(d.x);
  const ay = Math.abs(d.y);
  const az = Math.abs(d.z);
  let face: number;
  if (ax >= ay && ax >= az) face = d.x >= 0 ? 0 : 1;
  else if (ay >= az) face = d.y >= 0 ? 2 : 3;
  else face = d.z >= 0 ? 4 : 5;

  const n = FACE_N[face];
  const uA = FACE_U[face];
  const vA = FACE_V[face];
  const denom = d.x * n.x + d.y * n.y + d.z * n.z;
  const inv = 1 / (Math.abs(denom) < 1e-9 ? 1e-9 : denom);
  const u = (d.x * uA.x + d.y * uA.y + d.z * uA.z) * inv;
  const v = (d.x * vA.x + d.y * vA.y + d.z * vA.z) * inv;
  out.face = face;
  out.u = unwarp(u);
  out.v = unwarp(v);
  return out;
}

export function faceUVToDir(face: number, u: number, v: number, out: Vector3): Vector3 {
  const n = FACE_N[face];
  const uA = FACE_U[face];
  const vA = FACE_V[face];
  const wu = warp(u);
  const wv = warp(v);
  out.set(
    n.x + uA.x * wu + vA.x * wv,
    n.y + uA.y * wu + vA.y * wv,
    n.z + uA.z * wu + vA.z * wv,
  );
  return out.normalize();
}

/** Pack a cell address into one safe integer for Map keys. 3 + 21 + 21 bits. */
export function cellKey(face: number, i: number, j: number): number {
  return face * 4398046511104 + (i & 0x1fffff) * 2097152 + (j & 0x1fffff);
}

/**
 * Build an orthonormal tangent frame around `up`. The choice of reference axis
 * flips near the poles to avoid a degenerate cross product.
 */
export function tangentFrame(up: Vector3, tangent: Vector3, bitangent: Vector3): void {
  const ref = Math.abs(up.y) < 0.92 ? UP_REF : SIDE_REF;
  tangent.crossVectors(ref, up);
  const l = tangent.length();
  if (l < 1e-6) tangent.set(1, 0, 0);
  else tangent.multiplyScalar(1 / l);
  bitangent.crossVectors(up, tangent).normalize();
}

const UP_REF = new Vector3(0, 1, 0);
const SIDE_REF = new Vector3(1, 0, 0);
