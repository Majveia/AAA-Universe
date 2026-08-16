/**
 * QUADSPHERE — the terrain body.
 *
 * Six cube faces, each a quadtree, each leaf a grid of vertices displaced by
 * `TerrainField`. Three problems have to be solved at once, and the solutions
 * interlock:
 *
 * PRECISION. A planet is 6.4·10⁶ m across and a float32 has 24 bits of mantissa,
 * so a vertex expressed in planet coordinates snaps to ~0.5 m — you would watch
 * the ground quantise under your feet. Every patch therefore stores its vertices
 * *relative to its own centre* and carries that centre on the Object3D. Three
 * composes modelViewMatrix on the CPU in doubles, so what reaches the shader is
 * already camera-relative and small.
 *
 * CRACKS. Two fixes, belt and braces. (a) CDLOD geomorphing: every vertex knows
 * where it would be one level coarser, and blends there as it approaches the
 * level's far range. Because the blend is driven by each vertex's own distance,
 * neighbouring patches agree exactly along shared edges, and a fully-morphed
 * patch *is* its parent's surface. (b) Skirts: a ring of vertices dropped
 * radially, which covers the residual seam when levels differ by more than one.
 *
 * HITCHES. A single deep patch is ~50 noise evaluations × 2000 vertices. Built
 * in one tick that is a dropped frame, so builds are jobs that run against a
 * wall-clock budget and resume next frame where they stopped. A patch is never
 * swapped in half-finished, and a parent stays visible until all four children
 * are ready — so the world is never holed, only occasionally coarse.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Material,
  Mesh,
  Sphere,
  Vector3,
} from 'three';
import type { TerrainField } from './TerrainField';

/* ═══════════════════════════════════════════════════════════════════════════
   Cube faces
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Bases chosen so that right × up = forward on all six faces. That single
 * property lets every patch share one index buffer with consistent winding.
 */
const FACES: { f: Vector3; r: Vector3; u: Vector3 }[] = [
  { f: new Vector3(1, 0, 0), r: new Vector3(0, 0, -1), u: new Vector3(0, 1, 0) },
  { f: new Vector3(-1, 0, 0), r: new Vector3(0, 0, 1), u: new Vector3(0, 1, 0) },
  { f: new Vector3(0, 1, 0), r: new Vector3(1, 0, 0), u: new Vector3(0, 0, -1) },
  { f: new Vector3(0, -1, 0), r: new Vector3(1, 0, 0), u: new Vector3(0, 0, 1) },
  { f: new Vector3(0, 0, 1), r: new Vector3(1, 0, 0), u: new Vector3(0, 1, 0) },
  { f: new Vector3(0, 0, -1), r: new Vector3(-1, 0, 0), u: new Vector3(0, 1, 0) },
];

const QUARTER_PI = Math.PI / 4;

/** Tangent warp: equalises cell area across a face. Without it the corners of
 *  each cube face carry ~3× the solid angle of the centre. */
function warp(x: number): number {
  return Math.tan(x * QUARTER_PI);
}

/** Unit direction from face-local cube coordinates in [-1,1]. */
function faceDir(face: number, u: number, v: number, out: Vector3): Vector3 {
  const F = FACES[face];
  const a = warp(u);
  const b = warp(v);
  out.set(
    F.f.x + F.r.x * a + F.u.x * b,
    F.f.y + F.r.y * a + F.u.y * b,
    F.f.z + F.r.z * a + F.u.z * b,
  );
  return out.normalize();
}

/* ═══════════════════════════════════════════════════════════════════════════
   Shared index buffers
   ═══════════════════════════════════════════════════════════════════════════ */

interface IndexSet {
  index: BufferAttribute;
  gridVerts: number;
  totalVerts: number;
}

const _indexCache = new Map<number, IndexSet>();

function indexSetFor(res: number): IndexSet {
  const cached = _indexCache.get(res);
  if (cached) return cached;

  const gridVerts = res * res;
  const totalVerts = gridVerts + 4 * res;
  const quadTris = (res - 1) * (res - 1) * 2;
  const skirtTris = 4 * (res - 1) * 2;
  const idx = new Uint16Array((quadTris + skirtTris) * 3);
  let n = 0;

  const gi = (i: number, j: number) => i * res + j;

  for (let i = 0; i < res - 1; i++) {
    for (let j = 0; j < res - 1; j++) {
      const a = gi(i, j);
      const b = gi(i + 1, j);
      const c = gi(i, j + 1);
      const d = gi(i + 1, j + 1);
      idx[n++] = a; idx[n++] = b; idx[n++] = c;
      idx[n++] = b; idx[n++] = d; idx[n++] = c;
    }
  }

  // Skirt rings. Winding is per-edge so every strip faces outward and survives
  // backface culling — a culled skirt is a visible crack.
  const skirtBase = gridVerts;
  const edgeTop = (e: number, k: number): number =>
    e === 0 ? gi(0, k) : e === 1 ? gi(res - 1, k) : e === 2 ? gi(k, 0) : gi(k, res - 1);

  for (let e = 0; e < 4; e++) {
    const forward = e === 0 || e === 3; // (T0,T1,B0),(T1,B1,B0)
    for (let k = 0; k < res - 1; k++) {
      const t0 = edgeTop(e, k);
      const t1 = edgeTop(e, k + 1);
      const b0 = skirtBase + e * res + k;
      const b1 = skirtBase + e * res + k + 1;
      if (forward) {
        idx[n++] = t0; idx[n++] = t1; idx[n++] = b0;
        idx[n++] = t1; idx[n++] = b1; idx[n++] = b0;
      } else {
        idx[n++] = t0; idx[n++] = b0; idx[n++] = t1;
        idx[n++] = t1; idx[n++] = b0; idx[n++] = b1;
      }
    }
  }

  const set: IndexSet = { index: new BufferAttribute(idx, 1), gridVerts, totalVerts };
  _indexCache.set(res, set);
  return set;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Nodes and build jobs
   ═══════════════════════════════════════════════════════════════════════════ */

class QuadNode {
  face: number;
  level: number;
  u0: number; v0: number; u1: number; v1: number;
  centerDir = new Vector3();
  centerPos = new Vector3();
  /** Bounding sphere radius in metres around centerPos. */
  bound = 0;
  children: QuadNode[] | null = null;
  mesh: Mesh | null = null;
  job: BuildJob | null = null;
  /** Frame index this node was last selected — drives eviction. */
  touched = 0;
  parent: QuadNode | null = null;

  constructor(face: number, level: number, u0: number, v0: number, u1: number, v1: number, parent: QuadNode | null) {
    this.face = face;
    this.level = level;
    this.u0 = u0; this.v0 = v0; this.u1 = u1; this.v1 = v1;
    this.parent = parent;
  }

  get ready(): boolean {
    return this.mesh !== null;
  }
}

interface BuildJob {
  node: QuadNode;
  res: number;
  half: number;
  phase: number;
  row: number;
  fine: Float32Array;
  coarse: Float32Array;
  fmax: number;
  fmaxParent: number;
  cancelled: boolean;
  /** Priority — smaller is built sooner. Distance to the viewer, metres. */
  pri: number;
}

/* ═══════════════════════════════════════════════════════════════════════════
   QuadSphere
   ═══════════════════════════════════════════════════════════════════════════ */

export interface QuadSphereOptions {
  maxDepth: number;
  patchRes: number;
  budgetMsPerFrame: number;
  /** Screen-space error target in pixels. Lower = denser mesh. */
  pixelError: number;
  maxPatches: number;
}

export class QuadSphere {
  readonly root = new Group();
  readonly field: TerrainField;
  material: Material | null = null;
  /** Depth-pass twin, applied to every patch so shadows morph identically. */
  depthMaterial: Material | null = null;

  opts: QuadSphereOptions;

  /** Per-level CDLOD morph band [start, end] in metres. Uploaded as a uniform. */
  readonly lodMorph: Float32Array;
  /** Split distance per level, metres. */
  private ranges: Float32Array;

  /** Detail-noise anchor frequency; see `aDetail` in the terrain material. */
  readonly detailF0: number;

  private roots: QuadNode[] = [];
  private queue: BuildJob[] = [];
  private frame = 0;
  private patchCount = 0;
  private cam = new Vector3();
  private camLen = 0;
  private lodFactor = 4;
  private rMinSq = 0;

  private _d = new Vector3();
  private _p = new Vector3();
  private _tmp = new Vector3();
  private pins: { dir: Vector3; radius: number; resolve: () => void }[] = [];

  /** Rises monotonically as terrain appears; used by `isReady`. */
  builtEver = 0;

  constructor(field: TerrainField, opts: QuadSphereOptions) {
    this.field = field;
    this.opts = { ...opts };
    this.opts.patchRes |= 1;
    this.root.name = 'terrain';
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();

    this.lodMorph = new Float32Array(2 * (opts.maxDepth + 2));
    this.ranges = new Float32Array(opts.maxDepth + 2);
    this.detailF0 = field.R / 32;

    const rMin = field.R - 0.7 * field.maxElev;
    this.rMinSq = rMin * rMin;

    for (let f = 0; f < 6; f++) {
      const n = new QuadNode(f, 0, -1, -1, 1, 1, null);
      this.initNode(n);
      this.roots.push(n);
    }
  }

  /* ───────────────────────────── geometry of a node ───────────────────────── */

  private initNode(n: QuadNode): void {
    const uc = (n.u0 + n.u1) * 0.5;
    const vc = (n.v0 + n.v1) * 0.5;
    faceDir(n.face, uc, vc, n.centerDir);
    const hc = this.field.heightN(n.centerDir.x, n.centerDir.y, n.centerDir.z, this.fmaxFor(n.level) * 0.25);
    const r = this.field.R + hc * this.field.maxElev;
    n.centerPos.copy(n.centerDir).multiplyScalar(r);

    // Corner distance plus the full elevation envelope: conservative, and a
    // conservative bound only ever costs a few extra draw calls.
    faceDir(n.face, n.u0, n.v0, this._d);
    this._p.copy(this._d).multiplyScalar(this.field.R);
    const corner = this._p.distanceTo(this._tmp.copy(n.centerDir).multiplyScalar(this.field.R));
    n.bound = corner + this.field.maxElev * 1.3;
  }

  /** Highest resolvable frequency (cycles per radius) for a patch at `level`. */
  private fmaxFor(level: number): number {
    const arc = (Math.PI * 0.5 * this.field.R) / (1 << level);
    const spacing = arc / (this.opts.patchRes - 1);
    return Math.min(this.field.fmaxFull, this.field.R / (2 * spacing));
  }

  private patchArc(level: number): number {
    return (Math.PI * 0.5 * this.field.R) / (1 << level);
  }

  /* ───────────────────────────── per-frame update ─────────────────────────── */

  /**
   * @param camLocal camera position in planet-local metres
   * @param fovY     vertical field of view, radians
   * @param screenH  framebuffer height in pixels
   */
  update(camLocal: Vector3, fovY: number, screenH: number, dt: number): void {
    this.frame++;
    this.cam.copy(camLocal);
    this.camLen = this.cam.length();

    // Screen-space error → distance ranges. A patch is split when one of its
    // cells would project to more than `pixelError` pixels of vertical error.
    const tanHalf = Math.tan(Math.max(0.05, fovY) * 0.5);
    const res = this.opts.patchRes;
    // Split distance for a patch of arc A is A * lodFactor, where lodFactor is
    // how many patch-widths away one cell still projects to `pixelError` pixels:
    //   cellPx = (A / (res-1)) * screenH / (2 * tan(fov/2) * d)
    // Setting cellPx = pixelError and solving for d gives the factor below. The
    // extra 0.5 that used to be here halved every split distance and pinned the
    // whole terrain at its minimum subdivision.
    this.lodFactor = Math.min(
      16,
      Math.max(1.7, screenH / (2 * tanHalf * Math.max(0.5, this.opts.pixelError) * (res - 1))),
    );

    for (let l = 0; l <= this.opts.maxDepth + 1; l++) {
      this.ranges[l] = this.patchArc(Math.min(l, this.opts.maxDepth)) * this.lodFactor;
    }
    // Morph band: begin two thirds of the way out, complete just inside the
    // parent's split distance so a patch is always fully merged before it goes.
    for (let l = 0; l <= this.opts.maxDepth + 1; l++) {
      const r = this.ranges[Math.max(0, l - 1)];
      this.lodMorph[l * 2 + 0] = r * 0.66;
      this.lodMorph[l * 2 + 1] = r * 0.96;
    }

    for (const r of this.roots) this.select(r);
    this.resolvePins();
    this.runBuilds();
    this.evict();
  }

  /** Distance from the camera to the nearest point of a node's bounds. */
  private nodeDist(n: QuadNode): number {
    return Math.max(0, this.cam.distanceTo(n.centerPos) - n.bound);
  }

  /** Behind the planet? The horizon plane for a viewer C is dot(X,C) = r². */
  private overHorizon(n: QuadNode): boolean {
    if (this.camLen < this.field.R) return false;
    const d = n.centerPos.dot(this.cam) + n.bound * this.camLen;
    return d < this.rMinSq;
  }

  private select(n: QuadNode): void {
    if (this.overHorizon(n)) {
      this.hide(n);
      return;
    }
    n.touched = this.frame;

    const dist = this.nodeDist(n);
    const wantSplit = n.level < this.opts.maxDepth && dist < this.ranges[n.level];

    if (wantSplit) {
      if (!n.children) this.subdivide(n);
      const kids = n.children!;
      let allReady = true;
      for (const k of kids) {
        k.touched = this.frame;
        if (!k.ready) {
          allReady = false;
          this.request(k, this.nodeDist(k));
        }
      }
      if (allReady) {
        this.setVisible(n, false);
        for (const k of kids) this.select(k);
        return;
      }
      // Children are still baking: keep showing this level rather than a hole.
      // Their subtrees are still walked so deep detail can start early.
      for (const k of kids) if (k.ready) this.select(k);
    }

    this.request(n, dist);
    this.setVisible(n, true);
    if (n.children && !wantSplit) this.hideSubtree(n.children);
  }

  private hide(n: QuadNode): void {
    this.setVisible(n, false);
    if (n.children) this.hideSubtree(n.children);
  }

  private hideSubtree(kids: QuadNode[]): void {
    for (const k of kids) {
      this.setVisible(k, false);
      if (k.children) this.hideSubtree(k.children);
    }
  }

  private setVisible(n: QuadNode, v: boolean): void {
    if (n.mesh) n.mesh.visible = v;
  }

  private subdivide(n: QuadNode): void {
    const um = (n.u0 + n.u1) * 0.5;
    const vm = (n.v0 + n.v1) * 0.5;
    const l = n.level + 1;
    n.children = [
      new QuadNode(n.face, l, n.u0, n.v0, um, vm, n),
      new QuadNode(n.face, l, um, n.v0, n.u1, vm, n),
      new QuadNode(n.face, l, n.u0, vm, um, n.v1, n),
      new QuadNode(n.face, l, um, vm, n.u1, n.v1, n),
    ];
    for (const k of n.children) this.initNode(k);
  }

  /* ───────────────────────────── build queue ─────────────────────────────── */

  private request(n: QuadNode, dist: number): void {
    if (n.ready || n.job) {
      if (n.job) n.job.pri = Math.min(n.job.pri, dist);
      return;
    }
    const res = this.opts.patchRes;
    const half = (res - 1) / 2 + 1;
    const job: BuildJob = {
      node: n,
      res,
      half,
      phase: 0,
      row: 0,
      fine: new Float32Array((res + 2) * (res + 2)),
      coarse: new Float32Array(half * half),
      fmax: this.fmaxFor(n.level),
      fmaxParent: this.fmaxFor(Math.max(0, n.level - 1)),
      cancelled: false,
      pri: dist,
    };
    n.job = job;
    this.queue.push(job);
  }

  private runBuilds(): void {
    if (!this.queue.length) return;
    // Nearest first: the ground under the player matters more than the horizon.
    this.queue.sort((a, b) => a.pri - b.pri);

    const t0 = performance.now();
    const budget = this.opts.budgetMsPerFrame;
    let completed = 0;
    while (this.queue.length && performance.now() - t0 < budget) {
      const job = this.queue[0];
      if (job.cancelled || job.node.mesh) {
        job.node.job = null;
        this.queue.shift();
        continue;
      }
      if (this.advance(job, t0, budget)) {
        this.finish(job);
        this.queue.shift();
        completed++;
        if (completed >= Math.max(1, this.opts.maxPatches >> 6)) break;
      }
    }
  }

  /** Returns true when the job has produced everything it needs. */
  private advance(job: BuildJob, t0: number, budget: number): boolean {
    const F = this.field;
    const n = job.node;
    const res = job.res;
    const half = job.half;
    const du = (n.u1 - n.u0) / (res - 1);
    const dv = (n.v1 - n.v0) / (res - 1);
    const d = this._d;

    // Phase 0 — the parent's surface over this footprint. Half resolution, one
    // LOD band coarser: this is literally what the parent patch draws, which is
    // what makes the geomorph exact rather than approximate.
    if (job.phase === 0) {
      while (job.row < half) {
        const i = job.row;
        const u = n.u0 + du * (i * 2);
        for (let j = 0; j < half; j++) {
          const v = n.v0 + dv * (j * 2);
          faceDir(n.face, u, v, d);
          job.coarse[i * half + j] = F.heightN(d.x, d.y, d.z, job.fmaxParent);
        }
        job.row++;
        if (performance.now() - t0 >= budget) return false;
      }
      job.phase = 1;
      job.row = 0;
    }

    // Phase 1 — the patch itself, with a one-vertex apron so that every vertex
    // (edges included) gets a true central-difference normal.
    if (job.phase === 1) {
      const w = res + 2;
      while (job.row < w) {
        const i = job.row - 1;
        const u = n.u0 + du * i;
        for (let jj = 0; jj < w; jj++) {
          const j = jj - 1;
          const v = n.v0 + dv * j;
          faceDir(n.face, u, v, d);
          job.fine[job.row * w + jj] = F.heightN(d.x, d.y, d.z, job.fmax);
        }
        job.row++;
        if (performance.now() - t0 >= budget) return false;
      }
      job.phase = 2;
    }
    return true;
  }

  private finish(job: BuildJob): void {
    const F = this.field;
    const n = job.node;
    const res = job.res;
    const half = job.half;
    const w = res + 2;
    const iset = indexSetFor(res);
    const nv = iset.totalVerts;

    const pos = new Float32Array(nv * 3);
    const nor = new Float32Array(nv * 3);
    const dir4 = new Float32Array(nv * 4);
    const mor = new Float32Array(nv * 4);
    const det = new Float32Array(nv * 3);

    const du = (n.u1 - n.u0) / (res - 1);
    const dv = (n.v1 - n.v0) / (res - 1);
    const R = F.R;
    const ME = F.maxElev;
    const cx = n.centerPos.x;
    const cy = n.centerPos.y;
    const cz = n.centerPos.z;

    // Detail-noise anchor. Simplex noise here repeats every 289 units, so
    // subtracting a multiple of 289 leaves the value untouched while keeping the
    // per-vertex numbers small enough for float32 to carry millimetres.
    const F0 = this.detailF0;
    const kx = Math.round((n.centerDir.x * F0) / 289) * 289;
    const ky = Math.round((n.centerDir.y * F0) / 289) * 289;
    const kz = Math.round((n.centerDir.z * F0) / 289) * 289;

    const d = this._d;
    const p = this._p;
    const q = this._tmp;

    // Scratch for the two tangent differences used by the normals.
    const pxp = new Vector3();
    const pxn = new Vector3();
    const pyp = new Vector3();
    const pyn = new Vector3();
    const ta = new Vector3();
    const tb = new Vector3();
    const nrm = new Vector3();

    let elevMin = Infinity;
    let elevMax = -Infinity;
    let maxDist = 0;

    const posOf = (i: number, j: number, out: Vector3): Vector3 => {
      faceDir(n.face, n.u0 + du * i, n.v0 + dv * j, out);
      const h = job.fine[(i + 1) * w + (j + 1)] * ME;
      return out.multiplyScalar(R + h);
    };

    const level = n.level;

    for (let i = 0; i < res; i++) {
      for (let j = 0; j < res; j++) {
        const vi = i * res + j;
        const hN = job.fine[(i + 1) * w + (j + 1)];
        const elev = hN * ME;
        if (elev < elevMin) elevMin = elev;
        if (elev > elevMax) elevMax = elev;

        faceDir(n.face, n.u0 + du * i, n.v0 + dv * j, d);
        p.copy(d).multiplyScalar(R + elev);

        const lx = p.x - cx;
        const ly = p.y - cy;
        const lz = p.z - cz;
        pos[vi * 3] = lx;
        pos[vi * 3 + 1] = ly;
        pos[vi * 3 + 2] = lz;
        const dl = Math.sqrt(lx * lx + ly * ly + lz * lz);
        if (dl > maxDist) maxDist = dl;

        dir4[vi * 4] = d.x;
        dir4[vi * 4 + 1] = d.y;
        dir4[vi * 4 + 2] = d.z;
        dir4[vi * 4 + 3] = elev;

        det[vi * 3] = d.x * F0 - kx;
        det[vi * 3 + 1] = d.y * F0 - ky;
        det[vi * 3 + 2] = d.z * F0 - kz;

        // Central differences of the *same* height function the mesh uses, so
        // the lighting agrees with the silhouette exactly.
        posOf(i + 1, j, pxp);
        posOf(i - 1, j, pxn);
        posOf(i, j + 1, pyp);
        posOf(i, j - 1, pyn);
        ta.subVectors(pxp, pxn);
        tb.subVectors(pyp, pyn);
        nrm.crossVectors(ta, tb).normalize();
        if (nrm.dot(d) < 0) nrm.negate();
        nor[vi * 3] = nrm.x;
        nor[vi * 3 + 1] = nrm.y;
        nor[vi * 3 + 2] = nrm.z;

        // Morph target: bilinear interpolation of the parent's coarse surface,
        // exactly what the parent patch would draw here.
        const fi = i * 0.5;
        const fj = j * 0.5;
        const i0 = Math.min(half - 1, Math.floor(fi));
        const j0 = Math.min(half - 1, Math.floor(fj));
        const i1 = Math.min(half - 1, i0 + 1);
        const j1 = Math.min(half - 1, j0 + 1);
        const ti = fi - i0;
        const tj = fj - j0;
        const h00 = job.coarse[i0 * half + j0];
        const h10 = job.coarse[i1 * half + j0];
        const h01 = job.coarse[i0 * half + j1];
        const h11 = job.coarse[i1 * half + j1];
        const hp = (h00 * (1 - ti) + h10 * ti) * (1 - tj) + (h01 * (1 - ti) + h11 * ti) * tj;

        // The parent's vertex directions coincide with the even lattice, so the
        // interpolated surface is a straight-line blend of parent positions.
        q.copy(d).multiplyScalar(R + hp * ME);
        mor[vi * 4] = q.x - p.x;
        mor[vi * 4 + 1] = q.y - p.y;
        mor[vi * 4 + 2] = q.z - p.z;
        mor[vi * 4 + 3] = level;
      }
    }

    // Skirts: copy the border ring inward. Deep enough to bridge a two-level
    // difference, shallow enough never to poke through a neighbouring cliff.
    const skirt = Math.max(1.5, this.patchArc(level) * 0.045 + ME * 0.002);
    const base = iset.gridVerts;
    const edgeTop = (e: number, k: number): number =>
      e === 0 ? 0 * res + k : e === 1 ? (res - 1) * res + k : e === 2 ? k * res + 0 : k * res + (res - 1);

    for (let e = 0; e < 4; e++) {
      for (let k = 0; k < res; k++) {
        const src = edgeTop(e, k);
        const dst = base + e * res + k;
        const dx = dir4[src * 4];
        const dy = dir4[src * 4 + 1];
        const dz = dir4[src * 4 + 2];
        pos[dst * 3] = pos[src * 3] - dx * skirt;
        pos[dst * 3 + 1] = pos[src * 3 + 1] - dy * skirt;
        pos[dst * 3 + 2] = pos[src * 3 + 2] - dz * skirt;
        nor[dst * 3] = nor[src * 3];
        nor[dst * 3 + 1] = nor[src * 3 + 1];
        nor[dst * 3 + 2] = nor[src * 3 + 2];
        dir4[dst * 4] = dx;
        dir4[dst * 4 + 1] = dy;
        dir4[dst * 4 + 2] = dz;
        dir4[dst * 4 + 3] = dir4[src * 4 + 3] - skirt;
        mor[dst * 4] = mor[src * 4];
        mor[dst * 4 + 1] = mor[src * 4 + 1];
        mor[dst * 4 + 2] = mor[src * 4 + 2];
        mor[dst * 4 + 3] = level;
        det[dst * 3] = det[src * 3];
        det[dst * 3 + 1] = det[src * 3 + 1];
        det[dst * 3 + 2] = det[src * 3 + 2];
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('normal', new BufferAttribute(nor, 3));
    geo.setAttribute('aDir', new BufferAttribute(dir4, 4));
    geo.setAttribute('aMorph', new BufferAttribute(mor, 4));
    geo.setAttribute('aDetail', new BufferAttribute(det, 3));
    geo.setIndex(iset.index);
    geo.boundingSphere = new Sphere(new Vector3(0, 0, 0), maxDist + skirt + 1);

    const mesh = new Mesh(geo, this.material ?? undefined);
    mesh.position.copy(n.centerPos);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.frustumCulled = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.renderOrder = 0;
    if (this.depthMaterial) mesh.customDepthMaterial = this.depthMaterial;
    (mesh as any).userData.level = level;
    (mesh as any).userData.elev = [elevMin, elevMax];

    n.mesh = mesh;
    n.job = null;
    this.root.add(mesh);
    this.patchCount++;
    this.builtEver++;
  }

  /* ───────────────────────────── eviction ────────────────────────────────── */

  private evict(): void {
    if (this.patchCount <= this.opts.maxPatches) return;
    const stale: QuadNode[] = [];
    const visit = (n: QuadNode) => {
      if (n.mesh && this.frame - n.touched > 60) stale.push(n);
      if (n.children) for (const k of n.children) visit(k);
    };
    for (const r of this.roots) visit(r);
    stale.sort((a, b) => a.touched - b.touched);
    let over = this.patchCount - this.opts.maxPatches;
    for (const n of stale) {
      if (over <= 0) break;
      if (n.level === 0) continue; // roots are the last resort of the far view
      this.freeNode(n);
      over--;
    }
    // Drop whole subtrees that have gone quiet, so the tree does not grow
    // without bound during a long flight.
    const prune = (n: QuadNode) => {
      if (!n.children) return;
      let quiet = true;
      for (const k of n.children) {
        prune(k);
        if (k.mesh || k.children || this.frame - k.touched < 240) quiet = false;
      }
      if (quiet) n.children = null;
    };
    for (const r of this.roots) prune(r);
  }

  private freeNode(n: QuadNode): void {
    if (n.job) n.job.cancelled = true;
    n.job = null;
    if (!n.mesh) return;
    this.root.remove(n.mesh);
    n.mesh.geometry.dispose();
    n.mesh = null;
    this.patchCount--;
  }

  /* ───────────────────────────── detail pinning ──────────────────────────── */

  /** Force max detail around a direction and resolve once it genuinely exists. */
  ensureDetail(dir: Vector3, radiusM: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pins.push({ dir: dir.clone().normalize(), radius: Math.max(1, radiusM), resolve });
    });
  }

  private resolvePins(): void {
    if (!this.pins.length) return;
    const still: typeof this.pins = [];
    for (const pin of this.pins) {
      if (this.pinReady(pin.dir, pin.radius)) pin.resolve();
      else still.push(pin);
    }
    this.pins = still;
  }

  /** Walks toward the pin, forcing splits, and reports whether it is resident. */
  private pinReady(dir: Vector3, radiusM: number): boolean {
    // The level at which a patch is comparable to the requested radius.
    const target = Math.min(
      this.opts.maxDepth,
      Math.max(1, Math.ceil(Math.log2((Math.PI * 0.5 * this.field.R) / Math.max(radiusM, 1)))),
    );
    let ready = true;
    const walk = (n: QuadNode) => {
      if (n.centerDir.dot(dir) < Math.cos(Math.min(Math.PI, (n.bound * 2) / this.field.R + radiusM / this.field.R))) return;
      n.touched = this.frame;
      if (n.level >= target) {
        if (!n.ready) {
          ready = false;
          this.request(n, 0);
        }
        return;
      }
      if (!n.children) this.subdivide(n);
      for (const k of n.children!) walk(k);
    };
    for (const r of this.roots) walk(r);
    return ready;
  }

  /* ───────────────────────────── lifecycle ───────────────────────────────── */

  setMaterials(mat: Material, depth: Material | null): void {
    this.material = mat;
    this.depthMaterial = depth;
    const visit = (n: QuadNode) => {
      if (n.mesh) {
        n.mesh.material = mat;
        if (depth) n.mesh.customDepthMaterial = depth;
      }
      if (n.children) for (const k of n.children) visit(k);
    };
    for (const r of this.roots) visit(r);
  }

  setOptions(o: Partial<QuadSphereOptions>): void {
    const resChanged = o.patchRes !== undefined && (o.patchRes | 1) !== this.opts.patchRes;
    Object.assign(this.opts, o);
    this.opts.patchRes |= 1;
    if (resChanged) this.rebuildAll();
  }

  private rebuildAll(): void {
    for (const job of this.queue) job.cancelled = true;
    this.queue.length = 0;
    const visit = (n: QuadNode) => {
      this.freeNode(n);
      if (n.children) for (const k of n.children) visit(k);
    };
    for (const r of this.roots) visit(r);
  }

  stats(): { patches: number; queued: number; lodFactor: number } {
    return { patches: this.patchCount, queued: this.queue.length, lodFactor: this.lodFactor };
  }

  dispose(): void {
    for (const job of this.queue) job.cancelled = true;
    this.queue.length = 0;
    const visit = (n: QuadNode) => {
      this.freeNode(n);
      if (n.children) for (const k of n.children) visit(k);
      n.children = null;
    };
    for (const r of this.roots) visit(r);
    this.roots.length = 0;
    for (const pin of this.pins) pin.resolve();
    this.pins.length = 0;
    this.root.clear();
  }
}
