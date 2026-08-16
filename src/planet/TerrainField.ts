/**
 * THE HEIGHT FIELD.
 *
 * One function, written twice: once in TypeScript (physics, collision, scatter
 * placement, mesh building) and once in GLSL (shading, ocean depth, cloud
 * shadows). They are line-for-line ports of each other and every baked constant
 * is passed through `Math.fround` so the CPU sees exactly the float32 the GPU
 * sees. If these two ever disagree the player sinks through hillsides.
 *
 * Geology, in the order the planet built itself:
 *
 *   1. DOMAIN WARP    — coastlines are fractal, not circular. Warping the
 *                       sample point before the continental noise is the single
 *                       cheapest way to get fjords, peninsulas and inland seas.
 *   2. CONTINENTS     — one low-frequency fBm, thresholded at a level derived
 *                       analytically from `landFraction` so the requested land
 *                       area actually comes out.
 *   3. TECTONICS      — Worley cells are plates. Their boundaries are where all
 *                       the drama lives: convergent margins get mountain arcs,
 *                       divergent ones get rift valleys and trenches. This is
 *                       the step that makes terrain look *geological* rather
 *                       than merely noisy — mountains in arcs, not scattered.
 *   4. OROGENY        — ridged multifractal masked to those convergent arcs.
 *   5. EROSION        — the full-detail field is pulled toward its own low-pass
 *                       in concavities and left alone on crests. Sharp ridges,
 *                       smooth valley floors, filled basins — for free, because
 *                       the low-pass is a by-product of the LOD machinery.
 *                       Plus dendritic incision from a thin-crested ridged field.
 *   6. IMPACTS        — craters with flat floors, raised rims, ejecta blankets
 *                       and central peaks on the big ones.
 *   7. AEOLIAN        — transverse dune trains perpendicular to a prevailing wind.
 *   8. VOLCANISM      — shield cones with calderas and flank rilles.
 *
 * LEVEL OF DETAIL. Every evaluation takes `fmax`, the highest spatial frequency
 * (in cycles per planet radius) the caller can resolve. Octaves above it fade
 * out smoothly rather than being cut, which means a coarse evaluation is a
 * genuine low-pass of a fine one — that is what makes CDLOD geomorphing
 * invisible, and it is also what keeps the cost of distant patches near zero.
 */

import { snoise3, hash33 } from '../core/Noise';
import { Rng } from '../core/Rand';
import { BIOME_IDS } from '../api/Contracts';
import type { PlanetSpec } from '../universe/Types';

/* ═══════════════════════════════════════════════════════════════════════════
   Scalar helpers — exact twins of the GLSL built-ins
   ═══════════════════════════════════════════════════════════════════════════ */

function sat(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function sstep(e0: number, e1: number, x: number): number {
  const t = sat((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
function fract(x: number): number {
  return x - Math.floor(x);
}
function fr(x: number): number {
  return Math.fround(x);
}

/** GLSL float literal from a number, guaranteed to parse as a float. */
function G(n: number): string {
  if (!Number.isFinite(n)) n = 0;
  let s = Math.fround(n).toPrecision(9);
  if (!/[.eE]/.test(s)) s += '.0';
  return s;
}

/* ---- allocation-free Worley, arithmetically identical to Noise.worley3 ---- */

let _wf1 = 0;
let _wf2 = 0;
const _wh: number[] = [0, 0, 0];

function worleyF(x: number, y: number, z: number, jitter: number): void {
  const bx = Math.floor(x);
  const by = Math.floor(y);
  const bz = Math.floor(z);
  let f1 = 1e9;
  let f2 = 1e9;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = bx + dx;
        const cy = by + dy;
        const cz = bz + dz;
        hash33(cx, cy, cz, _wh);
        const ex = cx + 0.5 + (_wh[0] - 0.5) * jitter - x;
        const ey = cy + 0.5 + (_wh[1] - 0.5) * jitter - y;
        const ez = cz + 0.5 + (_wh[2] - 0.5) * jitter - z;
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
  }
  _wf1 = f1;
  _wf2 = f2;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Band-limited fBm / ridged — the LOD-aware workhorses
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Octave `i` contributes with weight `clamp(fmax/f - 0.55, 0, 1)`: full strength
 * while the sampler can resolve it, fading to nothing as it approaches the
 * Nyquist limit. Normalisation uses the *full* octave count regardless, so a
 * low-`fmax` evaluation is a strict low-pass of a high-`fmax` one.
 */
function fbmL(x: number, y: number, z: number, f0: number, fmax: number, oct: number, lac: number, gain: number, invNorm: number): number {
  let f = f0;
  let amp = 1;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    if (i >= oct) break;
    const w = sat(fmax / f - 0.55);
    if (w <= 0) break;
    sum += amp * w * snoise3(x * f, y * f, z * f);
    f *= lac;
    amp *= gain;
  }
  return sum * invNorm;
}

function ridgedL(x: number, y: number, z: number, f0: number, fmax: number, oct: number, lac: number, gain: number, invNorm: number): number {
  let f = f0;
  let amp = 1;
  let sum = 0;
  let prev = 1;
  for (let i = 0; i < 12; i++) {
    if (i >= oct) break;
    const w = sat(fmax / f - 0.55);
    if (w <= 0) break;
    let n = 1 - Math.abs(snoise3(x * f, y * f, z * f));
    n *= n;
    n *= prev;
    prev = n;
    sum += amp * w * n;
    f *= lac;
    amp *= gain;
  }
  return sum * invNorm;
}

/** 1 / Σ gain^i for `oct` octaves — the LOD-independent normaliser. */
function normOf(oct: number, gain: number): number {
  let s = 0;
  let a = 1;
  for (let i = 0; i < oct; i++) {
    s += a;
    a *= gain;
  }
  return 1 / s;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Crater profile — shared by CPU and GPU
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * `x` is distance from the impact point in units of the crater radius. Support
 * ends at x = 1.55 so a crater never leaks out of its Worley cell (which would
 * pop as a hard edge). Reads as: flat-ish floor, sharp raised rim, ejecta
 * blanket fading outward, central rebound peak on the big ones.
 */
function craterProfile(x: number, peak: number): number {
  const bowl = -(1 - sstep(0.0, 0.78, x));
  let t = sat((x - 0.60) / 0.56);
  let rim = 4 * t * (1 - t);
  rim *= rim;
  let ej = sat(1 - (x - 0.92) / 0.62);
  ej = ej * ej * (x > 0.92 ? 1 : 0);
  let cp = sat(1 - x / 0.24);
  cp = cp * cp * peak;
  return bowl * 0.86 + rim * 0.44 + ej * 0.11 + cp;
}

/* ═══════════════════════════════════════════════════════════════════════════
   TerrainField
   ═══════════════════════════════════════════════════════════════════════════ */

export interface FieldSample {
  /** Normalised elevation, ×maxElevM = metres above the reference sphere. */
  hN: number;
  elevation: number;
  temperature: number;
  humidity: number;
  slope: number;
  nx: number;
  ny: number;
  nz: number;
  biome: number;
  underwater: number;
}

export class TerrainField {
  readonly spec: PlanetSpec;

  /* --- geometry --- */
  readonly R: number;
  readonly maxElev: number;
  /** Sea level as a normalised elevation (fraction of maxElev). */
  readonly datum: number;
  readonly hasOcean: boolean;
  /** Finest displaced wavelength, metres. */
  readonly lambdaMin: number;
  /** Frequency (cycles/radius) corresponding to `lambdaMin`. */
  readonly fmaxFull: number;

  /* --- baked float32 constants, mirrored verbatim into GLSL --- */
  private WF: number;
  private WA: number;
  private CF: number;
  private THR: number;
  private ABYSS: number;
  private LS: number; // land span above the datum
  private PF: number;
  private RF: number;
  private RS: number;
  private RSMOOTH: number;
  private RIVF: number;
  private EROS: number;
  private DF1: number;
  private DA1: number;
  private DF2: number;
  private DA2: number;
  private DF3: number;
  private DA3: number;
  private CRD: number;
  private CRF1: number;
  private CRR1: number;
  private CRA1: number;
  private CRF2: number;
  private CRR2: number;
  private CRA2: number;
  private DUC: number;
  private DUF: number;
  private DUA: number;
  private VOL: number;
  private VOF: number;
  private VOA: number;
  private WARM: number;
  private HUMB: number;

  /* octave normalisers */
  private NC: number;
  private NR: number;
  private NV: number;
  private ND1: number;
  private ND2: number;
  private ND3: number;
  private N3: number;

  /* seed offsets */
  private O: Float32Array; // 8 × vec3
  private WIND_A: Float32Array;
  private WIND_B: Float32Array;
  /** Spin axis in planet-local space; latitude is measured from it. */
  private AXIS: Float32Array;

  private _glsl: string | null = null;

  constructor(spec: PlanetSpec) {
    this.spec = spec;
    const t = spec.terrain;
    const rng = new Rng(spec.seed ^ 0x7e12a4b1);

    this.R = spec.radiusM;
    this.maxElev = t.maxElevationM;
    this.hasOcean = spec.ocean.present;
    this.datum = fr(this.hasOcean ? Math.min(0.92, Math.max(0.05, spec.ocean.level)) : 0);

    // Never displace finer than a few metres: below that the mesh cannot carry
    // it and the material's normal detail takes over.
    this.lambdaMin = fr(Math.min(14, Math.max(2.5, this.R * 7e-7)));
    this.fmaxFull = fr(this.R / this.lambdaMin);

    /* ---- continental ---- */
    this.CF = fr(Math.max(0.35, t.continentFreq));
    this.WF = fr(this.CF * 1.35);
    this.WA = fr((t.domainWarp * 0.46) / this.CF);
    // Analytic threshold: fBm here is near-Gaussian with σ ≈ 0.205, and the
    // logistic fit to the normal quantile is good to ~1% over 0.05–0.95.
    const lf = Math.min(0.97, Math.max(0.03, t.landFraction));
    this.THR = fr(0.205 * 0.5875 * Math.log((1 - lf) / lf));
    this.LS = fr(1 - this.datum);
    this.ABYSS = fr(this.hasOcean ? this.datum - (0.36 + 0.72 * this.datum) : -0.26);

    /* ---- tectonics ---- */
    // Worley at frequency f yields ≈ 12.57·f² cells over a unit sphere.
    this.PF = fr(0.282 * Math.sqrt(Math.max(3, t.plates)));

    /* ---- orogeny ---- */
    this.RF = fr(Math.max(1.2, t.ridgeFreq));
    this.RS = fr(Math.min(1, Math.max(0.05, t.ridgeStrength)));
    this.RSMOOTH = fr(this.RF * 3.1); // the low-pass reference used by erosion
    this.EROS = fr(Math.min(1, Math.max(0, t.erosion)));
    this.RIVF = fr(this.RF * 5.5);

    /* ---- detail bands, amplitudes normalised against maxElev ---- */
    this.DF1 = fr(this.RF * 64);
    this.DA1 = fr(Math.min(0.10, 900 / this.maxElev));
    this.DF2 = fr(this.R / 900);
    this.DA2 = fr(Math.min(0.05, 130 / this.maxElev));
    this.DF3 = fr(this.R / 60);
    this.DA3 = fr(Math.min(0.02, 9 / this.maxElev));

    /* ---- impacts ---- */
    this.CRD = fr(Math.min(1, Math.max(0, t.craterDensity)));
    this.CRF1 = fr(this.R / 42000); // basins, tens of km across
    this.CRR1 = fr(0.30);
    this.CRA1 = fr(Math.min(0.55, 2600 / this.maxElev));
    this.CRF2 = fr(this.R / 2600); // fresh craters, a few km across
    this.CRR2 = fr(0.26);
    this.CRA2 = fr(Math.min(0.22, 320 / this.maxElev));

    /* ---- aeolian ---- */
    this.DUC = fr(Math.min(1, Math.max(0, t.duneCoverage)));
    this.DUF = fr(this.R / 260);
    this.DUA = fr(Math.min(0.30, 42 / this.maxElev));

    /* ---- volcanism ---- */
    this.VOL = fr(Math.min(1, Math.max(0, t.volcanism)));
    this.VOF = fr(0.282 * Math.sqrt(Math.max(6, t.plates * 3.5)));
    this.VOA = fr(Math.min(0.9, 5200 / this.maxElev));

    /* ---- climate ---- */
    this.WARM = fr(sstep(175, 335, spec.tempK));
    const wet =
      spec.klass === 'jungle' || spec.klass === 'ocean' ? 0.30 :
      spec.klass === 'terran' ? 0.12 :
      spec.klass === 'desert' || spec.klass === 'barren' ? -0.34 :
      spec.klass === 'toxic' ? -0.10 : 0;
    this.HUMB = fr(0.46 + wet + (this.hasOcean ? 0.10 : -0.22));

    /* ---- normalisers ---- */
    this.NC = fr(normOf(7, 0.5));
    this.NR = fr(normOf(9, 0.5));
    this.NV = fr(normOf(5, 0.5));
    this.ND1 = fr(normOf(5, 0.5));
    this.ND2 = fr(normOf(4, 0.5));
    this.ND3 = fr(normOf(3, 0.5));
    this.N3 = fr(normOf(3, 0.5));

    /* ---- seeded offsets ---- */
    this.O = new Float32Array(8 * 3);
    for (let i = 0; i < 8; i++) {
      this.O[i * 3 + 0] = fr(rng.range(-90, 90));
      this.O[i * 3 + 1] = fr(rng.range(-90, 90));
      this.O[i * 3 + 2] = fr(rng.range(-90, 90));
    }

    const wa = rng.onSphere();
    const la = Math.hypot(wa.x, wa.y, wa.z) || 1;
    this.WIND_A = new Float32Array([fr(wa.x / la), fr(wa.y / la), fr(wa.z / la)]);
    // Second axis orthogonal to the first, for the secondary ripple train.
    let bx = -this.WIND_A[1];
    let by = this.WIND_A[0];
    let bz = fr(0.31);
    const lb = Math.hypot(bx, by, bz) || 1;
    this.WIND_B = new Float32Array([fr(bx / lb), fr(by / lb), fr(bz / lb)]);

    // Spin axis: Y tilted by the axial tilt. Latitude bands follow it.
    const ti = spec.axialTiltRad || 0;
    this.AXIS = new Float32Array([fr(Math.sin(ti)), fr(Math.cos(ti)), 0]);
  }

  /** Sea level radius in metres, or 0 when the world is dry. */
  seaLevelRadius(): number {
    return this.hasOcean ? this.R + this.datum * this.maxElev : 0;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     THE HEIGHT FUNCTION — normalised units, ×maxElev = metres
     ═════════════════════════════════════════════════════════════════════════ */

  heightN(x: number, y: number, z: number, fmax: number): number {
    /* 1 ── domain warp: the reason coastlines look drawn rather than stamped */
    const wf = this.WF;
    const O = this.O;
    const wx = snoise3(x * wf + O[0], y * wf + O[1], z * wf + O[2]);
    const wy = snoise3(x * wf + O[3], y * wf + O[4], z * wf + O[5]);
    const wz = snoise3(x * wf + O[6], y * wf + O[7], z * wf + O[8]);
    const qx = x + wx * this.WA;
    const qy = y + wy * this.WA;
    const qz = z + wz * this.WA;

    /* 2 ── continents */
    const c = fbmL(qx + O[9], qy + O[10], qz + O[11], this.CF, fmax, 7, 2.0, 0.5, this.NC);
    const cont = c - this.THR;
    const shelf = sstep(-0.42, -0.03, cont);
    const upland = sstep(0.0, 0.40, cont);
    let hBase = mix(this.ABYSS, this.datum - 0.035 * this.LS, shelf) + upland * this.LS * 0.30;

    /* 3 ── tectonics: plate boundaries are where mountains are allowed to be */
    const pf = this.PF;
    worleyF(x * pf + O[12], y * pf + O[13], z * pf + O[14], 0.85);
    let edge = 1 - sstep(0.0, 0.13, _wf2 - _wf1);
    edge *= edge;
    const reg = snoise3(x * pf * 0.6 + O[15], y * pf * 0.6 + O[16], z * pf * 0.6 + O[17]);
    const conv = sstep(-0.20, 0.28, reg);
    const oro = edge * conv;
    const rift = edge * (1 - conv);
    hBase += (oro * 0.55 - rift * 0.30) * this.LS;

    /* 4 ── orogeny: ridged multifractal, but only along convergent arcs */
    const mtn = sat(oro * 1.45 + upland * 0.40);
    const mg = this.RS * mtn * this.LS * 0.62;
    const rgF = ridgedL(qx + O[18], qy + O[19], qz + O[20], this.RF, fmax, 9, 2.03, 0.5, this.NR);
    const rgS = ridgedL(qx + O[18], qy + O[19], qz + O[20], this.RF, Math.min(fmax, this.RSMOOTH), 9, 2.03, 0.5, this.NR);
    const hFull = hBase + rgF * mg;
    const hSmooth = hBase + rgS * mg;

    /* 5 ── erosion: pull concavities toward the low-pass, leave crests sharp */
    const relief = hFull - hSmooth;
    const valley = 1 - sstep(-0.09 * this.LS, 0.015 * this.LS, relief);
    let h = mix(hFull, hSmooth - 0.02 * this.LS, this.EROS * valley * 0.8);

    if (this.EROS > 0.02) {
      // Thin-crested ridged field → dendritic channel network. Cubing isolates
      // the crest lines into narrow incisions instead of broad valleys.
      const riv = ridgedL(qx + O[21], qy + O[22], qz + O[23], this.RIVF, fmax, 5, 2.0, 0.5, this.NV);
      const chan = riv * riv * riv * riv * riv;
      const wet = sstep(0.0, 0.20, cont) * (1 - sstep(0.30 * this.LS + this.datum, 0.90 * this.LS + this.datum, h));
      h -= this.EROS * chan * 0.11 * this.LS * wet;
    }

    /* 6 ── multi-scale relief: three bands so the ground reads at every range */
    const rough = 0.30 + 0.70 * mtn;
    h += fbmL(qx + O[3], qy + O[4], qz + O[5], this.DF1, fmax, 5, 2.07, 0.5, this.ND1) * this.DA1 * rough;
    h += ridgedL(qx + O[6], qy + O[7], qz + O[8], this.DF2, fmax, 4, 2.11, 0.5, this.ND2) * this.DA2 * (0.35 + 0.65 * mtn);
    h += fbmL(qx + O[9], qy + O[10], qz + O[11], this.DF3, fmax, 3, 2.13, 0.5, this.ND3) * this.DA3;

    /* 7 ── impacts */
    if (this.CRD > 0.01) {
      h += this.craters(x, y, z, fmax);
    }

    /* 8 ── aeolian */
    if (this.DUC > 0.01) {
      h += this.dunes(x, y, z, fmax, upland);
    }

    /* 9 ── volcanism */
    if (this.VOL > 0.01) {
      h += this.volcano(x, y, z, fmax);
    }

    return h < -1.45 ? -1.45 : h > 1.15 ? 1.15 : h;
  }

  /** Craters, two size bands, accumulated over the 27 neighbouring cells. */
  private craters(x: number, y: number, z: number, fmax: number): number {
    let acc = 0;
    acc += this.craterLayer(x, y, z, fmax, this.CRF1, this.CRR1, this.CRA1, 24, 0.75, 0.55);
    acc += this.craterLayer(x, y, z, fmax, this.CRF2, this.CRR2, this.CRA2, 27, 0.42, 0.0);
    return acc;
  }

  private craterLayer(
    x: number, y: number, z: number, fmax: number,
    freq: number, rad: number, amp: number, ofs: number, thresh: number, peak: number,
  ): number {
    const w = sat(fmax / freq - 0.55);
    if (w <= 0) return 0;
    const O = this.O;
    const px = x * freq + O[ofs % 24];
    const py = y * freq + O[(ofs + 1) % 24];
    const pz = z * freq + O[(ofs + 2) % 24];
    const bx = Math.floor(px);
    const by = Math.floor(py);
    const bz = Math.floor(pz);
    let acc = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = bx + dx;
          const cy = by + dy;
          const cz = bz + dz;
          hash33(cx, cy, cz, _wh);
          // Density gates which cells ever received an impact.
          if (_wh[2] > this.CRD * thresh) continue;
          const ex = cx + 0.5 + (_wh[0] - 0.5) * 0.55 - px;
          const ey = cy + 0.5 + (_wh[1] - 0.5) * 0.55 - py;
          const ez = cz + 0.5 + (_wh[2] - 0.5) * 0.55 - pz;
          const r = rad * (0.45 + 0.9 * _wh[0]);
          const d = Math.sqrt(ex * ex + ey * ey + ez * ez) / r;
          if (d >= 1.55) continue;
          acc += craterProfile(d, peak * _wh[1]) * amp * (0.55 + 0.75 * _wh[1]);
        }
      }
    }
    return acc * w;
  }

  /** Transverse dune trains: sharp crest downwind, long windward slope. */
  private dunes(x: number, y: number, z: number, fmax: number, upland: number): number {
    const w = sat(fmax / this.DUF - 0.55);
    if (w <= 0) return 0;
    const O = this.O;
    const fN = fbmL(x + O[12], y + O[13], z + O[14], 2.6, fmax, 3, 2.0, 0.5, this.N3);
    let field = sstep(0.42 - this.DUC * 0.55, 0.86 - this.DUC * 0.55, fN * 0.5 + 0.5);
    field *= 1 - sstep(0.18, 0.62, upland);
    if (field <= 0.002) return 0;

    const A = this.WIND_A;
    const B = this.WIND_B;
    const drift = fbmL(x + O[15], y + O[16], z + O[17], this.DUF * 0.045, fmax, 3, 2.0, 0.5, this.N3);
    const phase = (x * A[0] + y * A[1] + z * A[2]) * this.DUF + drift * 5.0;
    const tri = Math.abs(fract(phase) * 2 - 1);
    const crest = Math.pow(1 - tri, 1.7);
    const ph2 = (x * B[0] + y * B[1] + z * B[2]) * this.DUF * 3.7;
    const rip = 0.16 * (1 - Math.abs(fract(ph2) * 2 - 1));
    return field * (crest + rip) * this.DUA * w;
  }

  /** Shield volcanoes: convex flanks, a caldera, and rilles down the sides. */
  private volcano(x: number, y: number, z: number, fmax: number): number {
    const w = sat(fmax / this.VOF - 0.55);
    if (w <= 0) return 0;
    const O = this.O;
    const f = this.VOF;
    const px = x * f + O[18];
    const py = y * f + O[19];
    const pz = z * f + O[20];
    const bx = Math.floor(px);
    const by = Math.floor(py);
    const bz = Math.floor(pz);
    let acc = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = bx + dx;
          const cy = by + dy;
          const cz = bz + dz;
          hash33(cx, cy, cz, _wh);
          if (_wh[2] > this.VOL * 0.35) continue;
          const ex = cx + 0.5 + (_wh[0] - 0.5) * 0.7 - px;
          const ey = cy + 0.5 + (_wh[1] - 0.5) * 0.7 - py;
          const ez = cz + 0.5 + (_wh[2] - 0.5) * 0.7 - pz;
          const r = 0.15 + 0.24 * _wh[0];
          const d = Math.sqrt(ex * ex + ey * ey + ez * ez) / r;
          if (d >= 1) continue;
          const t = 1 - d;
          const cone = t * t * (3 - 2 * t);
          const cald = sat(1 - d / 0.14);
          acc += this.VOA * (0.5 + 0.9 * _wh[1]) * (cone * cone - cald * cald * 0.6);
        }
      }
    }
    return acc * w;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Climate + biomes
     ═════════════════════════════════════════════════════════════════════════ */

  /** Sine of latitude measured from the spin axis. */
  latSin(x: number, y: number, z: number): number {
    const A = this.AXIS;
    return x * A[0] + y * A[1] + z * A[2];
  }

  temperature(x: number, y: number, z: number, hN: number): number {
    const s = this.latSin(x, y, z);
    const band = Math.pow(sat(1 - s * s), 0.55); // 1 at the equator, 0 at the poles
    const O = this.O;
    const regional = fbmL(x + O[21], y + O[22], z + O[23], 2.1, 6, 3, 2.0, 0.5, this.N3) * 0.10;
    // Lapse rate: only the part of the column above sea level cools.
    const lapse = sat((hN - this.datum) / Math.max(0.15, this.LS)) * 0.46;
    return sat(band * (0.30 + 0.85 * this.WARM) + regional - lapse + this.WARM * 0.12);
  }

  humidity(x: number, y: number, z: number, hN: number, temp: number): number {
    const s = this.latSin(x, y, z);
    const lat = Math.asin(Math.max(-1, Math.min(1, s)));
    // Hadley/Ferrel banding: wet equator, dry subtropics, damp mid-latitudes.
    const cells = 0.24 * Math.cos(lat * 5.6) * Math.pow(sat(1 - s * s), 0.4);
    const O = this.O;
    const n = fbmL(x + O[0], y + O[1], z + O[2], 3.3, 8, 4, 2.0, 0.5, this.ND2) * 0.42;
    // Rain shadow: high ground wrings the air out.
    const shadow = sat((hN - this.datum) / Math.max(0.2, this.LS)) * 0.30;
    // Cold air holds little water.
    return sat(this.HUMB + cells + n - shadow - (1 - temp) * 0.22);
  }

  biome(hN: number, slope: number, temp: number, hum: number, lat: number): number {
    const B = BIOME_IDS;
    const above = hN - this.datum;
    if (this.hasOcean && hN < this.datum) return B.OCEAN;
    if (slope > 0.62) return B.ROCK;
    if (this.hasOcean && above < 0.012 * this.LS) return B.BEACH;
    if (this.VOL > 0.55 && temp > 0.88 && above < 0.25 * this.LS) return B.LAVA;

    const k = this.spec.klass;
    if (k === 'exotic' && hum > 0.35) return B.CRYSTAL;
    if (k === 'toxic') return above > 0.5 * this.LS ? B.BADLANDS : B.ALKALI;

    if (temp < 0.16) return hum > 0.35 ? B.GLACIER : B.TUNDRA;
    if (temp < 0.32) return hum > 0.42 ? B.TAIGA : B.TUNDRA;
    if (temp > 0.72 && hum < 0.22) return above < 0.06 * this.LS && slope < 0.06 ? B.SALT_FLAT : B.DESERT;
    if (hum < 0.3) return slope > 0.32 ? B.BADLANDS : B.DESERT;
    if (temp > 0.62 && hum > 0.7) {
      return this.spec.life === 'fauna' || this.spec.life === 'sapient' ? (hum > 0.86 ? B.MUSHROOM : B.JUNGLE) : B.JUNGLE;
    }
    if (hum > 0.46) return B.FOREST;
    return B.GRASSLAND;
  }

  /** Full surface description. Normal is a central difference of `heightN`. */
  sample(x: number, y: number, z: number, out?: FieldSample): FieldSample {
    const o: FieldSample = out ?? ({} as FieldSample);
    const hN = this.heightN(x, y, z, this.fmaxFull);

    // Tangent basis at the direction, offset by half the finest wavelength.
    let ax = 0, ay = 0, az = 0;
    if (Math.abs(y) < 0.9) { ay = 1; } else { ax = 1; }
    let tx = ay * z - az * y;
    let ty = az * x - ax * z;
    let tz = ax * y - ay * x;
    let l = Math.hypot(tx, ty, tz) || 1;
    tx /= l; ty /= l; tz /= l;
    let bx = y * tz - z * ty;
    let by = z * tx - x * tz;
    let bz = x * ty - y * tx;
    l = Math.hypot(bx, by, bz) || 1;
    bx /= l; by /= l; bz /= l;

    const e = this.lambdaMin / this.R;
    const hpx = this.heightN(x + tx * e, y + ty * e, z + tz * e, this.fmaxFull);
    const hnx = this.heightN(x - tx * e, y - ty * e, z - tz * e, this.fmaxFull);
    const hpy = this.heightN(x + bx * e, y + by * e, z + bz * e, this.fmaxFull);
    const hny = this.heightN(x - bx * e, y - by * e, z - bz * e, this.fmaxFull);

    // dh/ds in metres per metre along each tangent.
    const gu = ((hpx - hnx) * this.maxElev) / (2 * e * this.R);
    const gv = ((hpy - hny) * this.maxElev) / (2 * e * this.R);

    // n = normalize(up - gu·t - gv·b)
    let nx = x - tx * gu - bx * gv;
    let ny = y - ty * gu - by * gv;
    let nz = z - tz * gu - bz * gv;
    l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;

    const cosT = sat(nx * x + ny * y + nz * z);
    o.hN = hN;
    o.elevation = hN * this.maxElev;
    o.nx = nx; o.ny = ny; o.nz = nz;
    o.slope = 1 - cosT;
    o.temperature = this.temperature(x, y, z, hN);
    o.humidity = this.humidity(x, y, z, hN, o.temperature);
    o.underwater = this.hasOcean && hN < this.datum ? 1 : 0;
    o.biome = this.biome(hN, o.slope, o.temperature, o.humidity, this.latSin(x, y, z));
    return o;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     GLSL twin
     ═════════════════════════════════════════════════════════════════════════ */

  /**
   * The same function, for the GPU. Constants are baked as literals from the
   * float32-rounded CPU values, so both sides evaluate identical arithmetic.
   * Requires GLSL_NOISE to be included first (its include guard makes that safe).
   */
  glsl(): string {
    if (this._glsl) return this._glsl;
    const O = this.O;
    const v3 = (i: number) => `vec3(${G(O[i * 3])}, ${G(O[i * 3 + 1])}, ${G(O[i * 3 + 2])})`;

    this._glsl = /* glsl */ `
#ifndef AEON_TERRAIN_INCLUDED
#define AEON_TERRAIN_INCLUDED

#define AE_R            ${G(this.R)}
#define AE_MAXELEV      ${G(this.maxElev)}
#define AE_DATUM        ${G(this.datum)}
#define AE_LS           ${G(this.LS)}
#define AE_HASOCEAN     ${this.hasOcean ? 1 : 0}
#define AE_FMAX_FULL    ${G(this.fmaxFull)}
#define AE_SEALEVEL_R   ${G(this.seaLevelRadius())}

const vec3 AE_O0 = ${v3(0)};
const vec3 AE_O1 = ${v3(1)};
const vec3 AE_O2 = ${v3(2)};
const vec3 AE_O3 = ${v3(3)};
const vec3 AE_O4 = ${v3(4)};
const vec3 AE_O5 = ${v3(5)};
const vec3 AE_O6 = ${v3(6)};
const vec3 AE_O7 = ${v3(7)};
const vec3 AE_WINDA = vec3(${G(this.WIND_A[0])}, ${G(this.WIND_A[1])}, ${G(this.WIND_A[2])});
const vec3 AE_WINDB = vec3(${G(this.WIND_B[0])}, ${G(this.WIND_B[1])}, ${G(this.WIND_B[2])});
const vec3 AE_AXIS  = vec3(${G(this.AXIS[0])}, ${G(this.AXIS[1])}, ${G(this.AXIS[2])});

float aeFbmL(vec3 d, float f0, float fmax, int oct, float lac, float gain, float invNorm){
  float f = f0, amp = 1.0, sum = 0.0;
  for (int i = 0; i < 12; i++){
    if (i >= oct) break;
    float w = clamp(fmax / f - 0.55, 0.0, 1.0);
    if (w <= 0.0) break;
    sum += amp * w * snoise(d * f);
    f *= lac; amp *= gain;
  }
  return sum * invNorm;
}

float aeRidgedL(vec3 d, float f0, float fmax, int oct, float lac, float gain, float invNorm){
  float f = f0, amp = 1.0, sum = 0.0, prev = 1.0;
  for (int i = 0; i < 12; i++){
    if (i >= oct) break;
    float w = clamp(fmax / f - 0.55, 0.0, 1.0);
    if (w <= 0.0) break;
    float n = 1.0 - abs(snoise(d * f));
    n *= n; n *= prev; prev = n;
    sum += amp * w * n;
    f *= lac; amp *= gain;
  }
  return sum * invNorm;
}

float aeCraterProfile(float x, float peak){
  float bowl = -(1.0 - smoothstep(0.0, 0.78, x));
  float t = clamp((x - 0.60) / 0.56, 0.0, 1.0);
  float rim = 4.0 * t * (1.0 - t);
  rim *= rim;
  float ej = clamp(1.0 - (x - 0.92) / 0.62, 0.0, 1.0);
  ej = ej * ej * step(0.92, x);
  float cp = clamp(1.0 - x / 0.24, 0.0, 1.0);
  cp = cp * cp * peak;
  return bowl * 0.86 + rim * 0.44 + ej * 0.11 + cp;
}

float aeCraterLayer(vec3 d, float fmax, float freq, float rad, float amp, vec3 ofs, float thresh, float peak){
  float w = clamp(fmax / freq - 0.55, 0.0, 1.0);
  if (w <= 0.0) return 0.0;
  vec3 p = d * freq + ofs;
  ivec3 b = ivec3(floor(p));
  float acc = 0.0;
  for (int dz = -1; dz <= 1; dz++)
  for (int dy = -1; dy <= 1; dy++)
  for (int dx = -1; dx <= 1; dx++){
    ivec3 c = b + ivec3(dx, dy, dz);
    vec3 h = hash33i(c);
    if (h.z > ${G(this.CRD)} * thresh) continue;
    vec3 e = vec3(c) + 0.5 + (h - 0.5) * 0.55 - p;
    float r = rad * (0.45 + 0.9 * h.x);
    float dd = length(e) / r;
    if (dd >= 1.55) continue;
    acc += aeCraterProfile(dd, peak * h.y) * amp * (0.55 + 0.75 * h.y);
  }
  return acc * w;
}

float aeDunes(vec3 d, float fmax, float upland){
  float w = clamp(fmax / ${G(this.DUF)} - 0.55, 0.0, 1.0);
  if (w <= 0.0) return 0.0;
  float fN = aeFbmL(d + AE_O4, 2.6, fmax, 3, 2.0, 0.5, ${G(this.N3)});
  float field = smoothstep(${G(0.42 - this.DUC * 0.55)}, ${G(0.86 - this.DUC * 0.55)}, fN * 0.5 + 0.5);
  field *= 1.0 - smoothstep(0.18, 0.62, upland);
  if (field <= 0.002) return 0.0;
  float drift = aeFbmL(d + AE_O5, ${G(this.DUF * 0.045)}, fmax, 3, 2.0, 0.5, ${G(this.N3)});
  float phase = dot(d, AE_WINDA) * ${G(this.DUF)} + drift * 5.0;
  float tri = abs(fract(phase) * 2.0 - 1.0);
  float crest = pow(1.0 - tri, 1.7);
  float ph2 = dot(d, AE_WINDB) * ${G(this.DUF * 3.7)};
  float rip = 0.16 * (1.0 - abs(fract(ph2) * 2.0 - 1.0));
  return field * (crest + rip) * ${G(this.DUA)} * w;
}

float aeVolcano(vec3 d, float fmax){
  float w = clamp(fmax / ${G(this.VOF)} - 0.55, 0.0, 1.0);
  if (w <= 0.0) return 0.0;
  vec3 p = d * ${G(this.VOF)} + AE_O6;
  ivec3 b = ivec3(floor(p));
  float acc = 0.0;
  for (int dz = -1; dz <= 1; dz++)
  for (int dy = -1; dy <= 1; dy++)
  for (int dx = -1; dx <= 1; dx++){
    ivec3 c = b + ivec3(dx, dy, dz);
    vec3 h = hash33i(c);
    if (h.z > ${G(this.VOL * 0.35)}) continue;
    vec3 e = vec3(c) + 0.5 + (h - 0.5) * 0.7 - p;
    float r = 0.15 + 0.24 * h.x;
    float dd = length(e) / r;
    if (dd >= 1.0) continue;
    float t = 1.0 - dd;
    float cone = t * t * (3.0 - 2.0 * t);
    float cald = clamp(1.0 - dd / 0.14, 0.0, 1.0);
    acc += ${G(this.VOA)} * (0.5 + 0.9 * h.y) * (cone * cone - cald * cald * 0.6);
  }
  return acc * w;
}

/** Normalised elevation. Multiply by AE_MAXELEV for metres. */
float aeHeightN(vec3 d, float fmax){
  vec3 wp = d * ${G(this.WF)};
  vec3 wv = vec3(snoise(wp + AE_O0), snoise(wp + AE_O1), snoise(wp + AE_O2));
  vec3 q = d + wv * ${G(this.WA)};

  float c = aeFbmL(q + AE_O3, ${G(this.CF)}, fmax, 7, 2.0, 0.5, ${G(this.NC)});
  float cont = c - ${G(this.THR)};
  float shelf  = smoothstep(-0.42, -0.03, cont);
  float upland = smoothstep(0.0, 0.40, cont);
  float hBase = mix(${G(this.ABYSS)}, ${G(this.datum - 0.035 * this.LS)}, shelf) + upland * ${G(this.LS * 0.30)};

  vec2 pw = worley(d * ${G(this.PF)} + AE_O4, 0.85);
  float edge = 1.0 - smoothstep(0.0, 0.13, pw.y - pw.x);
  edge *= edge;
  float reg = snoise(d * ${G(this.PF * 0.6)} + AE_O5);
  float conv = smoothstep(-0.20, 0.28, reg);
  float oro = edge * conv;
  float rift = edge * (1.0 - conv);
  hBase += (oro * 0.55 - rift * 0.30) * AE_LS;

  float mtn = clamp(oro * 1.45 + upland * 0.40, 0.0, 1.0);
  float mg = ${G(this.RS)} * mtn * AE_LS * 0.62;
  float rgF = aeRidgedL(q + AE_O6, ${G(this.RF)}, fmax, 9, 2.03, 0.5, ${G(this.NR)});
  float rgS = aeRidgedL(q + AE_O6, ${G(this.RF)}, min(fmax, ${G(this.RSMOOTH)}), 9, 2.03, 0.5, ${G(this.NR)});
  float hFull = hBase + rgF * mg;
  float hSmooth = hBase + rgS * mg;

  float relief = hFull - hSmooth;
  float valley = 1.0 - smoothstep(${G(-0.09 * this.LS)}, ${G(0.015 * this.LS)}, relief);
  float h = mix(hFull, hSmooth - ${G(0.02 * this.LS)}, ${G(this.EROS)} * valley * 0.8);

#if ${this.EROS > 0.02 ? 1 : 0}
  {
    float riv = aeRidgedL(q + AE_O7, ${G(this.RIVF)}, fmax, 5, 2.0, 0.5, ${G(this.NV)});
    float chan = riv * riv * riv * riv * riv;
    float wet = smoothstep(0.0, 0.20, cont) * (1.0 - smoothstep(${G(0.30 * this.LS + this.datum)}, ${G(0.90 * this.LS + this.datum)}, h));
    h -= ${G(this.EROS)} * chan * ${G(0.11 * this.LS)} * wet;
  }
#endif

  float rough = 0.30 + 0.70 * mtn;
  h += aeFbmL(q + AE_O1, ${G(this.DF1)}, fmax, 5, 2.07, 0.5, ${G(this.ND1)}) * ${G(this.DA1)} * rough;
  h += aeRidgedL(q + AE_O2, ${G(this.DF2)}, fmax, 4, 2.11, 0.5, ${G(this.ND2)}) * ${G(this.DA2)} * (0.35 + 0.65 * mtn);
  h += aeFbmL(q + AE_O3, ${G(this.DF3)}, fmax, 3, 2.13, 0.5, ${G(this.ND3)}) * ${G(this.DA3)};

#if ${this.CRD > 0.01 ? 1 : 0}
  h += aeCraterLayer(d, fmax, ${G(this.CRF1)}, ${G(this.CRR1)}, ${G(this.CRA1)}, AE_O0, 0.75, 0.55);
  h += aeCraterLayer(d, fmax, ${G(this.CRF2)}, ${G(this.CRR2)}, ${G(this.CRA2)}, AE_O1, 0.42, 0.0);
#endif
#if ${this.DUC > 0.01 ? 1 : 0}
  h += aeDunes(d, fmax, upland);
#endif
#if ${this.VOL > 0.01 ? 1 : 0}
  h += aeVolcano(d, fmax);
#endif

  return clamp(h, -1.45, 1.15);
}

float aeHeightM(vec3 d, float fmax){ return aeHeightN(d, fmax) * AE_MAXELEV; }

float aeLatSin(vec3 d){ return dot(d, AE_AXIS); }

float aeTemperature(vec3 d, float hN){
  float s = aeLatSin(d);
  float band = pow(clamp(1.0 - s * s, 0.0, 1.0), 0.55);
  float regional = aeFbmL(d + AE_O7, 2.1, 6.0, 3, 2.0, 0.5, ${G(this.N3)}) * 0.10;
  float lapse = clamp((hN - AE_DATUM) / ${G(Math.max(0.15, this.LS))}, 0.0, 1.0) * 0.46;
  return clamp(band * ${G(0.30 + 0.85 * this.WARM)} + regional - lapse + ${G(this.WARM * 0.12)}, 0.0, 1.0);
}

float aeHumidity(vec3 d, float hN, float temp){
  float s = aeLatSin(d);
  float lat = asin(clamp(s, -1.0, 1.0));
  float cells = 0.24 * cos(lat * 5.6) * pow(clamp(1.0 - s * s, 0.0, 1.0), 0.4);
  float n = aeFbmL(d + AE_O0, 3.3, 8.0, 4, 2.0, 0.5, ${G(this.ND2)}) * 0.42;
  float shadow = clamp((hN - AE_DATUM) / ${G(Math.max(0.2, this.LS))}, 0.0, 1.0) * 0.30;
  return clamp(${G(this.HUMB)} + cells + n - shadow - (1.0 - temp) * 0.22, 0.0, 1.0);
}

#endif
`;
    return this._glsl;
  }
}
