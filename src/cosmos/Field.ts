/**
 * The primordial density field.
 *
 * Structure in the real universe grows out of a Gaussian random field laid down
 * by inflation — every Fourier mode independent, phases uniformly random,
 * amplitudes drawn from the ΛCDM power spectrum P(k). Standard simulations
 * build that field on a grid and FFT it. We build it as an explicit sum of a
 * few hundred plane waves instead, which is the same object by definition (a
 * Gaussian field *is* a random-phase superposition) and has one enormous
 * advantage: it is analytic. A shader can evaluate δ(q) and the Zel'dovich
 * displacement Ψ(q) at any point in space without a grid, a transform, or a
 * megabyte of uploaded data — and the CPU can evaluate exactly the same field
 * for the node catalogue and get bit-comparable answers.
 *
 * Modes are sampled log-uniformly in |k| with amplitude
 *
 *     A(k) ∝ √( P(k) · k³ ) · Rayleigh
 *
 * because d³k = k³ dln k, so equal weight per e-fold of scale plus that factor
 * reproduces the continuous spectrum. The Rayleigh factor is what makes it a
 * genuine Gaussian realisation rather than a tidy sum of equal-amplitude waves:
 * some modes come out strong, some weak, and that is where the *diversity* of
 * the web — one dominant supercluster here, a great empty void there — comes
 * from. Change the seed and you get a different universe, not a rotation of the
 * same one.
 *
 * P(k) = k^n · T(k)², n = 0.965, with the BBKS transfer function. That gives
 * the real turnover at the matter–radiation equality scale (~150 Mpc), so the
 * biggest voids come out the size they should.
 */

import { Rng } from '../core/Rand';

/** Shape parameter Γ = Ωm·h expressed in Mpc⁻¹. Sets where P(k) turns over. */
const GAMMA_PER_MPC = 0.142;
/** Primordial spectral tilt (Planck). */
const SPECTRAL_INDEX = 0.965;

/** BBKS transfer function, squared. */
function transferSquared(k: number): number {
  const q = k / GAMMA_PER_MPC;
  const l = Math.log(1 + 2.34 * q) / (2.34 * q);
  const p = 1 + 3.89 * q + (16.1 * q) ** 2 + (5.46 * q) ** 3 + (6.71 * q) ** 4;
  const t = l * p ** -0.25;
  return t * t;
}

function powerSpectrum(k: number): number {
  return k ** SPECTRAL_INDEX * transferSquared(k);
}

export interface FieldOptions {
  /** Number of plane waves. 128 is already visually converged. */
  modes: number;
  /** Comoving box size, Mpc. */
  boxMpc: number;
  /** Longest wavelength, as a multiple of the box. >1 gives the shot a subject. */
  largestScale: number;
  /** Shortest wavelength, as a fraction of the box. */
  smallestScaleDiv: number;
  /** Target rms of δ at a = 1, over this mode range. ~1.3 ⇒ a properly
   *  nonlinear web with ~10 % of the mass collapsed today. */
  sigma: number;
}

export const DEFAULT_FIELD: FieldOptions = {
  modes: 128,
  boxMpc: 220,
  largestScale: 1.6,
  smallestScaleDiv: 26,
  sigma: 1.3,
};

/**
 * One realisation of the primordial field. Immutable once built.
 *
 * Conventions, so the CPU and the GPU never disagree:
 *   δ(q)  = Σ Aⱼ cos(kⱼ·q + φⱼ)
 *   Ψ(q)  = −Σ (Aⱼ/kⱼ²) kⱼ sin(kⱼ·q + φⱼ)      (so that ∇·Ψ = −δ)
 *   x(a)  = q + D(a)·Ψ(q)                       (the Zel'dovich approximation)
 */
export class PrimordialField {
  readonly opts: FieldOptions;
  /** Per mode: kx, ky, kz, amplitude. */
  readonly k: Float32Array;
  readonly amp: Float32Array;
  readonly phase: Float32Array;
  readonly count: number;
  /** rms of δ at D = 1 (the realised value, not the target). */
  readonly sigma: number;
  /** rms Zel'dovich displacement at D = 1, in Mpc. */
  readonly sigmaDisplacement: number;

  constructor(seed: number | string, opts: Partial<FieldOptions> = {}) {
    const o: FieldOptions = { ...DEFAULT_FIELD, ...opts };
    this.opts = o;
    const n = o.modes;
    this.count = n;
    this.k = new Float32Array(n * 3);
    this.amp = new Float32Array(n);
    this.phase = new Float32Array(n);

    const rng = new Rng(seed).fork('primordial');
    const kMin = (2 * Math.PI) / (o.largestScale * o.boxMpc);
    const kMax = (2 * Math.PI) / (o.boxMpc / o.smallestScaleDiv);
    const lnRange = Math.log(kMax / kMin);

    const mags = new Float64Array(n);
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      // Stratified log-uniform sampling: one mode per equal slice of ln k, with
      // jitter inside the slice. Stratifying matters at only 128 modes — pure
      // rejection sampling leaves visible gaps in the spectrum.
      const u = (i + rng.next()) / n;
      const kMag = kMin * Math.exp(lnRange * u);
      const dir = rng.onSphere();

      // Rayleigh amplitude: |a| with E[|a|²] = 1.
      const rayleigh = Math.sqrt(-Math.log(Math.max(rng.next(), 1e-9)));
      const a = Math.sqrt(powerSpectrum(kMag) * kMag ** 3) * rayleigh;

      this.k[i * 3] = dir.x * kMag;
      this.k[i * 3 + 1] = dir.y * kMag;
      this.k[i * 3 + 2] = dir.z * kMag;
      this.phase[i] = rng.range(0, Math.PI * 2);
      mags[i] = kMag;
      this.amp[i] = a;
      sumSq += a * a;
    }

    // Var[Σ A cos(k·q + φ)] = Σ A²/2 for random phases — normalise to the
    // requested σ so the epoch scrubber lands on a familiar-looking z = 0.
    const realisedSigma = Math.sqrt(sumSq / 2);
    const scale = o.sigma / realisedSigma;
    let dispSq = 0;
    for (let i = 0; i < n; i++) {
      this.amp[i] *= scale;
      const s = this.amp[i] / mags[i];
      dispSq += s * s;
    }
    this.sigma = o.sigma;
    // Ψ is one power of k softer than δ, so it is dominated by the largest
    // waves; this comes out near the real ~8 Mpc rms displacement at z = 0.
    this.sigmaDisplacement = Math.sqrt(dispSq / 2);
  }

  /** Linear overdensity at a Lagrangian point, at D = 1. */
  delta(x: number, y: number, z: number): number {
    let d = 0;
    for (let i = 0; i < this.count; i++) {
      const p = this.k[i * 3] * x + this.k[i * 3 + 1] * y + this.k[i * 3 + 2] * z + this.phase[i];
      d += this.amp[i] * Math.cos(p);
    }
    return d;
  }

  /** Zel'dovich displacement at a Lagrangian point, at D = 1, in Mpc. */
  displacement(x: number, y: number, z: number, out: [number, number, number]): [number, number, number] {
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let i = 0; i < this.count; i++) {
      const kx = this.k[i * 3];
      const ky = this.k[i * 3 + 1];
      const kz = this.k[i * 3 + 2];
      const k2 = kx * kx + ky * ky + kz * kz;
      const s = (this.amp[i] / k2) * Math.sin(kx * x + ky * y + kz * z + this.phase[i]);
      sx -= s * kx;
      sy -= s * ky;
      sz -= s * kz;
    }
    out[0] = sx;
    out[1] = sy;
    out[2] = sz;
    return out;
  }

  /**
   * δ on a regular cubic grid, evaluated with an angle-addition recurrence
   * instead of one `Math.cos` per sample per mode. The plane wave is separable,
   * so a mode contributes cos((kx·x)+(ky·y)+(kz·z)+φ) and we can carry the
   * rotation across each axis with a complex multiply — about twenty times
   * faster than the naive loop, which is the difference between a 40 ms boot
   * hitch and a one-second one.
   */
  deltaGrid(n: number, min: number, size: number): Float32Array {
    const out = new Float32Array(n * n * n);
    const cx = new Float64Array(n);
    const sx = new Float64Array(n);
    const cy = new Float64Array(n);
    const sy = new Float64Array(n);
    const cz = new Float64Array(n);
    const sz = new Float64Array(n);
    const step = size / n;

    for (let m = 0; m < this.count; m++) {
      const kx = this.k[m * 3];
      const ky = this.k[m * 3 + 1];
      const kz = this.k[m * 3 + 2];
      const a = this.amp[m];
      for (let i = 0; i < n; i++) {
        const p = min + (i + 0.5) * step;
        const ax = kx * p;
        cx[i] = Math.cos(ax);
        sx[i] = Math.sin(ax);
        const ay = ky * p;
        cy[i] = Math.cos(ay);
        sy[i] = Math.sin(ay);
        const az = kz * p + this.phase[m];
        cz[i] = Math.cos(az);
        sz[i] = Math.sin(az);
      }
      for (let iz = 0; iz < n; iz++) {
        const c1 = cz[iz];
        const s1 = sz[iz];
        for (let iy = 0; iy < n; iy++) {
          const c2 = c1 * cy[iy] - s1 * sy[iy];
          const s2 = s1 * cy[iy] + c1 * sy[iy];
          let o = (iz * n + iy) * n;
          for (let ix = 0; ix < n; ix++) {
            out[o + ix] += a * (c2 * cx[ix] - s2 * sx[ix]);
          }
        }
      }
    }
    return out;
  }

  /**
   * Pack the modes into a 2-row RGBA float texture for the shaders:
   *   row 0 → (kx, ky, kz, amplitude)
   *   row 1 → (phase, k², 0, 0)
   */
  toTextureData(): Float32Array {
    const data = new Float32Array(this.count * 2 * 4);
    for (let i = 0; i < this.count; i++) {
      const kx = this.k[i * 3];
      const ky = this.k[i * 3 + 1];
      const kz = this.k[i * 3 + 2];
      data[i * 4 + 0] = kx;
      data[i * 4 + 1] = ky;
      data[i * 4 + 2] = kz;
      data[i * 4 + 3] = this.amp[i];
      const j = (this.count + i) * 4;
      data[j + 0] = this.phase[i];
      data[j + 1] = kx * kx + ky * ky + kz * kz;
    }
    return data;
  }
}
