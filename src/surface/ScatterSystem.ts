/**
 * Ground cover — grass, shrubs, rocks, trees, and whatever else this world grew.
 *
 * Placement is deterministic and storage-free: the sphere is diced into cells
 * by the cube-face addressing in Geo.ts, and each cell hashes to the same set
 * of positions forever. Walk away and come back and the same boulder is in the
 * same place, because it was never stored — only recomputed.
 *
 * Cells stream in and out around the viewer with a per-frame budget, so a
 * sprint across a meadow never stalls the frame.
 *
 * The wind is the thing that sells it. A single per-instance phase plus a
 * shared gust field means a whole field ripples in coherent waves instead of
 * every blade jittering on its own clock — which is the difference between
 * "grass" and "static mesh with a sine on it".
 */

import {
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import type { IPlanet, IScatterSystem, SystemContext } from '../api/Contracts';
import type { QualityProfile } from '../core/Settings';
import { Rng, hashCombine } from '../core/Rand';
import { buildFlora, type FloraSpecies } from './Flora';
import { cellKey, dirToFaceUV, faceUVToDir, type FaceUV } from './Geo';
import { EnvUniforms, GLSL_ENV_UNIFORMS, GLSL_SURFACE_LIB, env } from './Env';

/** Cell grid resolution per cube face. Cell size ≈ 2·R/GRID metres. */
/**
 * Target edge length of a scatter cell, metres. The grid is derived from this
 * and the planet's radius rather than being a fixed subdivision count: at a
 * fixed 1024 cells per cube face, a cell on an Earth-sized world is twenty-four
 * kilometres across, so a cell's worth of grass — capped at a few hundred
 * blades — spread out to roughly one blade per hectare and nothing was ever
 * visible from the ground.
 */
const CELL_TARGET_M = 96;
/** Cap on the index range cellKey can pack. */
const GRID_MAX = 2000000;

interface Cell {
  key: number;
  face: number;
  i: number;
  j: number;
  center: Vector3;
  meshes: InstancedMesh[];
  age: number;
}

export class ScatterSystem implements IScatterSystem {
  readonly root = new Group();

  private planet: IPlanet | null = null;
  private species: FloraSpecies[] = [];
  private cells = new Map<number, Cell>();
  private viewer = new Vector3();
  private wind = new Vector3(1, 0, 0);
  private quality: QualityProfile | null = null;
  private envU = new EnvUniforms();
  private material: MeshStandardMaterial | null = null;
  private cellSizeM = CELL_TARGET_M;
  private grid = 1024;
  private pending: { face: number; i: number; j: number; key: number; d2: number }[] = [];
  private time = 0;

  attach(planet: IPlanet): void {
    this.clear();
    this.planet = planet;
    this.species = buildFlora(planet.spec);
    this.grid = Math.min(GRID_MAX, Math.max(256, Math.round((2 * planet.radius) / CELL_TARGET_M)));
    this.cellSizeM = (2 * planet.radius) / this.grid;
    this.material = this.makeMaterial();
  }

  setViewer(localPosition: Vector3): void {
    this.viewer.copy(localPosition);
  }

  setWind(wind: Vector3): void {
    this.wind.copy(wind);
  }

  private makeMaterial(): MeshStandardMaterial {
    const mat = new MeshStandardMaterial({
      vertexColors: false,
      roughness: 0.86,
      metalness: 0,
      // Two-sided: leaves and blades are single quads, and a one-sided leaf
      // vanishes from half the angles you look at it from.
      side: 2,
      dithering: true,
    });

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.envU.u);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
${GLSL_ENV_UNIFORMS}
${GLSL_SURFACE_LIB}
attribute vec3 aOffset;
attribute vec4 aRot;      // quaternion, instance orientation
attribute vec2 aScale;    // uniform scale, phase
attribute vec3 aTint;
varying vec3 vTint;
varying float vHeightN;
varying vec3 vWorldPos;
`
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
  vTint = aTint;
  // Normalised height up the plant: the sway must be zero at the root and
  // maximal at the tip, or the whole thing slides across the ground.
  vHeightN = clamp(position.y / max(0.05, aScale.x), 0.0, 1.0);

  transformed *= aScale.x;
  transformed = aeonRotQ(aRot, transformed);

  {
    float gust = aeonGust(aOffset, normalize(uWind + vec3(1e-5)), length(uWind), uTime + aScale.y * 6.2831);
    float stiff = mix(1.0, 0.35, vHeightN);
    vec3 wdir = normalize(uWind + vec3(1e-5));
    float bend = gust * vHeightN * vHeightN / stiff;
    transformed += wdir * bend * aScale.x * 0.42;
    // A little cross-wind flutter, out of phase, so leaves shiver.
    vec3 side = normalize(cross(wdir, uUp));
    transformed += side * sin(uTime * 6.4 + aScale.y * 40.0) * vHeightN * aScale.x * 0.045 * min(1.0, length(uWind) * 0.25);
  }

  // Push the plant away from the player's feet, so walking through a meadow
  // parts it instead of clipping through it.
  {
    vec3 toP = aOffset - uPlayer;
    float d = length(toP);
    float push = 1.0 - smoothstep(0.0, 1.5, d);
    if (push > 0.001) transformed += normalize(toP + vec3(1e-5)) * push * vHeightN * 0.35;
  }

  transformed += aOffset;
  vWorldPos = transformed;
`
        )
        .replace(
          '#include <defaultnormal_vertex>',
          /* glsl */ `#include <defaultnormal_vertex>
  transformedNormal = normalize(aeonRotQ(aRot, objectNormal));
  transformedNormal = normalMatrix * transformedNormal;
`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
${GLSL_ENV_UNIFORMS}
${GLSL_SURFACE_LIB}
varying vec3 vTint;
varying float vHeightN;
varying vec3 vWorldPos;
`
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
  diffuseColor.rgb *= vTint;
  // Ambient occlusion by height: the base of a plant is in its own shadow.
  diffuseColor.rgb *= mix(0.55, 1.0, vHeightN);
`
        )
        .replace(
          '#include <dithering_fragment>',
          /* glsl */ `#include <dithering_fragment>
  // Aerial perspective, matched to the terrain's so plants never float free
  // of the landscape they are standing in.
  gl_FragColor.rgb = aeonAerial(gl_FragColor.rgb, length(vWorldPos - uViewer), normalize(vWorldPos - uViewer));
`
        );
    };
    mat.customProgramCacheKey = () => 'aeon-scatter';
    return mat;
  }

  update(dt: number, ctx: SystemContext): void {
    if (!this.planet || !this.material) return;
    this.time += dt;

    env.wind.copy(this.wind).normalize();
    env.windSpeed = this.wind.length();
    env.viewer.copy(this.viewer);
    env.time = this.time;
    this.envU.sync(_zero);
    (this.envU.u.uPlayer.value as Vector3).copy(this.viewer);

    const q = this.quality;
    const density = q?.scatterDensity ?? 1;
    if (density <= 0.001) return;

    // Draw radius: how far out we bother placing anything.
    const radiusM = 260 * (q?.scatterDistance ?? 1);
    const ring = Math.max(1, Math.ceil(radiusM / this.cellSizeM));

    /* ---- decide which cells should exist ---- */
    this.collectPending();

    // Strict per-frame budget. Streaming must never be the reason for a hitch,
    // but two cells a frame took most of a minute to fill the draw radius on a
    // machine already running at ten frames a second.
    const budget = q?.tier === 'ultra' ? 8 : q?.tier === 'high' ? 6 : q?.tier === 'potato' ? 2 : 4;
    for (let n = 0; n < budget && n < this.pending.length; n++) {
      const c = this.pending[n];
      this.buildCell(c.face, c.i, c.j, c.key, density);
    }

    /* ---- retire distant cells ---- */
    for (const [key, cell] of this.cells) {
      cell.age += dt;
      const d = cell.center.distanceTo(this.viewer);
      if (d > radiusM * 1.35) {
        for (const m of cell.meshes) {
          this.root.remove(m);
          m.geometry.dispose();
        }
        this.cells.delete(key);
      }
    }
  }

  /** Which cells around the viewer are missing, nearest first. */
  private collectPending(): void {
    const q = this.quality;
    const radiusM = 260 * (q?.scatterDistance ?? 1);
    const ring = Math.max(1, Math.ceil(radiusM / this.cellSizeM));
    const dir = _d.copy(this.viewer).normalize();
    dirToFaceUV(dir, _fuv);
    const ci = Math.floor(((_fuv.u + 1) * 0.5) * this.grid);
    const cj = Math.floor(((_fuv.v + 1) * 0.5) * this.grid);

    this.pending.length = 0;
    for (let dj = -ring; dj <= ring; dj++) {
      for (let di = -ring; di <= ring; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= this.grid || j >= this.grid) continue;
        const key = cellKey(_fuv.face, i, j);
        if (this.cells.has(key)) {
          this.cells.get(key)!.age = 0;
          continue;
        }
        const d2 = di * di + dj * dj;
        if (d2 > ring * ring) continue;
        this.pending.push({ face: _fuv.face, i, j, key, d2 });
      }
    }
    // Nearest first: what is in front of you appears before what is behind.
    this.pending.sort((a, b) => a.d2 - b.d2);
  }

  /** Diagnostic: how much has actually been placed around the viewer. */
  stats(): Record<string, number> {
    let meshes = 0;
    let instances = 0;
    for (const c of this.cells.values()) {
      meshes += c.meshes.length;
      for (const m of c.meshes) instances += (m as any).count ?? 0;
    }
    return {
      cells: this.cells.size,
      meshes,
      instances,
      cellSizeM: Math.round(this.cellSizeM),
      pending: this.pending.length,
    };
  }

  /**
   * Build every cell the viewer can see, right now, ignoring the per-frame
   * budget. Only for the screenshot harness and for a scripted landing, where
   * a second of hitch is preferable to a shot of empty ground.
   */
  prime(maxCells = 400): number {
    if (!this.planet || !this.material) return 0;
    const density = this.quality?.scatterDensity ?? 1;
    if (density <= 0.001) return 0;
    let built = 0;
    for (let pass = 0; pass < 24 && built < maxCells; pass++) {
      this.collectPending();
      if (!this.pending.length) break;
      for (const c of this.pending) {
        if (built >= maxCells) break;
        this.buildCell(c.face, c.i, c.j, c.key, density);
        built++;
      }
    }
    return built;
  }

  private buildCell(face: number, i: number, j: number, key: number, density: number): void {
    const planet = this.planet!;
    const R = planet.radius;
    const u = ((i + 0.5) / this.grid) * 2 - 1;
    const v = ((j + 0.5) / this.grid) * 2 - 1;
    faceUVToDir(face, u, v, _cd);
    const centerH = planet.heightAt(_cd);
    const center = _cd.clone().multiplyScalar(R + centerH);

    const cell: Cell = { key, face, i, j, center, meshes: [], age: 0 };
    this.cells.set(key, cell);

    const sample = planet.sampleSurface(_cd);
    if (sample.underwater) return;

    const rng = new Rng(hashCombine(planet.spec.seed, face, i, j));
    const biomeBit = 1 << sample.biome;

    // Tangent frame for this cell, so instances can be scattered in metres.
    const up = _cd.clone();
    const ref = Math.abs(up.y) > 0.94 ? _t1.set(1, 0, 0) : _t1.set(0, 1, 0);
    const tx = _t2.crossVectors(ref, up).normalize();
    const tz = _t3.crossVectors(up, tx).normalize();

    for (const sp of this.species) {
      if (!(sp.biomes & biomeBit)) continue;
      if (sample.slope > sp.slopeMax) continue;
      if (!sp.lods.length) continue;

      // Density per layer, per square metre, scaled by quality and humidity.
      const perM2 =
        sp.layer === 'ground' ? 0.55
        : sp.layer === 'under' ? 0.10
        : sp.layer === 'bush' ? 0.035
        : sp.layer === 'tree' ? 0.012
        : 0.004;
      const area = this.cellSizeM * this.cellSizeM;
      const wetBias = 1 + (sample.humidity - 0.5) * sp.wet * 1.4;
      let count = Math.floor(perM2 * area * density * Math.max(0, wetBias));
      if (count <= 0) continue;
      count = Math.min(count, 4000);

      const geo = sp.lods[0];
      const offsets = new Float32Array(count * 3);
      const rots = new Float32Array(count * 4);
      const scales = new Float32Array(count * 2);
      const tints = new Float32Array(count * 3);

      let placed = 0;
      for (let n = 0; n < count; n++) {
        const ox = (rng.next() - 0.5) * this.cellSizeM;
        const oz = (rng.next() - 0.5) * this.cellSizeM;
        _p.copy(up).addScaledVector(tx, ox / R).addScaledVector(tz, oz / R).normalize();
        const h = planet.heightAt(_p);
        const seaR = planet.seaLevelRadius();
        const r = R + h;
        if (seaR > 0 && r < seaR + 0.15) continue;

        _p.multiplyScalar(r);
        offsets[placed * 3] = _p.x;
        offsets[placed * 3 + 1] = _p.y;
        offsets[placed * 3 + 2] = _p.z;

        // Stand up along the local normal, with a random spin about it.
        _up2.copy(_p).normalize();
        _q1.setFromUnitVectors(_yAxis, _up2);
        _q2.setFromAxisAngle(_yAxis, rng.range(0, Math.PI * 2));
        _q1.multiply(_q2);
        // A slight random lean stops a field looking like a pin cushion.
        _q2.setFromAxisAngle(_xAxis, rng.normal(0, 0.06));
        _q1.multiply(_q2);
        rots[placed * 4] = _q1.x;
        rots[placed * 4 + 1] = _q1.y;
        rots[placed * 4 + 2] = _q1.z;
        rots[placed * 4 + 3] = _q1.w;

        scales[placed * 2] = rng.range(sp.scale[0], sp.scale[1]) * sp.height;
        scales[placed * 2 + 1] = rng.next();

        const jitter = 1 + rng.range(-sp.colorVar, sp.colorVar);
        tints[placed * 3] = sp.color[0] * jitter;
        tints[placed * 3 + 1] = sp.color[1] * jitter;
        tints[placed * 3 + 2] = sp.color[2] * jitter;
        placed++;
      }
      if (placed === 0) continue;

      const mesh = new InstancedMesh(geo, this.material!, placed);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // Instance transforms live entirely in the shader, so the matrix array
      // is identity and never uploaded per frame.
      mesh.frustumCulled = false;
      const g = mesh.geometry as any;
      g.setAttribute('aOffset', new InstancedBufferAttribute(offsets.subarray(0, placed * 3), 3));
      g.setAttribute('aRot', new InstancedBufferAttribute(rots.subarray(0, placed * 4), 4));
      g.setAttribute('aScale', new InstancedBufferAttribute(scales.subarray(0, placed * 2), 2));
      g.setAttribute('aTint', new InstancedBufferAttribute(tints.subarray(0, placed * 3), 3));
      mesh.castShadow = sp.layer === 'tree' || sp.layer === 'bush';
      mesh.receiveShadow = true;
      for (let n = 0; n < placed; n++) mesh.setMatrixAt(n, _identity);
      mesh.instanceMatrix.needsUpdate = true;

      this.root.add(mesh);
      cell.meshes.push(mesh);
    }
  }

  collideCapsule(localPosition: Vector3, radius: number, height: number): Vector3 | null {
    // Only trunks are solid, and only in the cell you are standing in — the
    // player can never be near enough to anything else for it to matter.
    if (!this.planet) return null;
    const dir = _d.copy(localPosition).normalize();
    dirToFaceUV(dir, _fuv);
    const i = Math.floor(((_fuv.u + 1) * 0.5) * this.grid);
    const j = Math.floor(((_fuv.v + 1) * 0.5) * this.grid);
    const cell = this.cells.get(cellKey(_fuv.face, i, j));
    if (!cell) return null;

    for (let mi = 0; mi < cell.meshes.length; mi++) {
      const mesh = cell.meshes[mi];
      const g = mesh.geometry as any;
      const off = g.getAttribute('aOffset');
      const sc = g.getAttribute('aScale');
      if (!off) continue;
      for (let n = 0; n < mesh.count; n++) {
        _p.set(off.getX(n), off.getY(n), off.getZ(n));
        const trunkR = Math.max(0.12, sc.getX(n) * 0.05);
        const d = _p.distanceTo(localPosition);
        const minD = trunkR + radius;
        if (d < minD && d > 1e-4) {
          return _push.subVectors(localPosition, _p).normalize().multiplyScalar(minD - d).clone();
        }
      }
    }
    return null;
  }

  setQuality(q: QualityProfile): void {
    const prev = this.quality?.scatterDensity;
    this.quality = q;
    // A density change invalidates every placed cell; drop them and let the
    // streamer refill at the new density.
    if (prev !== undefined && Math.abs(prev - q.scatterDensity) > 0.01) this.clear();
  }

  private clear(): void {
    for (const cell of this.cells.values()) {
      for (const m of cell.meshes) {
        this.root.remove(m);
        m.geometry.dispose();
      }
    }
    this.cells.clear();
  }

  dispose(): void {
    this.clear();
    this.material?.dispose();
    this.material = null;
    for (const sp of this.species) for (const g of sp.lods) g.dispose();
    this.species = [];
  }
}

const _d = new Vector3();
const _cd = new Vector3();
const _p = new Vector3();
const _up2 = new Vector3();
const _t1 = new Vector3();
const _t2 = new Vector3();
const _t3 = new Vector3();
const _push = new Vector3();
const _zero = new Vector3();
const _yAxis = new Vector3(0, 1, 0);
const _xAxis = new Vector3(1, 0, 0);
const _q1 = new Quaternion();
const _q2 = new Quaternion();
const _identity = new Matrix4();
const _fuv: FaceUV = { face: 0, u: 0, v: 0 };
