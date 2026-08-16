/**
 * The ΛCDM background — the clock the whole cosmic web runs on.
 *
 * Everything the simulation does in time comes from three functions of the
 * scale factor a:
 *
 *   E(a)  the Friedmann expansion rate, H(a) = H₀·E(a)
 *   D(a)  the linear growth factor — how much an overdensity has grown
 *   t(a)  the age of the universe at that epoch
 *
 * All three are integrated numerically once, at construction, into a table in
 * ln a and then interpolated. That costs about a millisecond and buys exact
 * agreement between the number on the HUD and the structure on screen.
 *
 * Parameters are Planck-like: Ωm = 0.31, ΩΛ = 0.69, H₀ = 67.7 km/s/Mpc. We
 * ignore radiation, which is a ~5 % correction to E(a) at our earliest epoch
 * (a = 0.02) and utterly negligible after that — and it would only shift the
 * age of a universe that has no structure in it yet.
 *
 * The interesting physics, and the reason the epoch scrubber is worth building,
 * is at the other end: D(a) *saturates*. Once Λ dominates, growth stops. Run
 * the clock forward past a = 2 and no new structure forms — the web you have is
 * the web you get, and expansion simply carries it apart forever.
 */

export const OMEGA_M = 0.31;
export const OMEGA_LAMBDA = 0.69;
export const H0_KM_S_MPC = 67.7;

/** 1 km/s/Mpc expressed in 1/Gyr. */
const KM_S_MPC_TO_PER_GYR = 1.02271e-3;

/** Hubble constant in 1/Gyr — the unit the simulation integrates in. */
export const H0_PER_GYR = H0_KM_S_MPC * KM_S_MPC_TO_PER_GYR;

/** Spherical-collapse threshold. A linear overdensity above this has collapsed. */
export const DELTA_C = 1.686;

const TABLE_N = 2048;
const LN_A_MIN = Math.log(1e-6);
const LN_A_MAX = Math.log(200);

export class Cosmology {
  /** Growth factor table, normalised so D(1) = 1. */
  private dTable = new Float64Array(TABLE_N + 1);
  /** Age table, in Gyr. */
  private tTable = new Float64Array(TABLE_N + 1);
  /** dD/dln a, needed for peculiar velocities (v ∝ Ḋ·S). */
  private dLogTable = new Float64Array(TABLE_N + 1);

  constructor() {
    const step = (LN_A_MAX - LN_A_MIN) / TABLE_N;

    // Both integrands are written per dln a and vanish as a → 0, so a plain
    // trapezoid from the bottom of the table is accurate without any special
    // handling of the singular-looking lower limit.
    //   growth:  ∫ da/(a E)³  →  a·(a E)⁻³ dln a
    //   age:     ∫ da/(a E)   →  a·(a E)⁻¹ dln a
    let growthIntegral = 0;
    let ageIntegral = 0;
    let prevG = 0;
    let prevT = 0;

    for (let i = 0; i <= TABLE_N; i++) {
      const a = Math.exp(LN_A_MIN + step * i);
      const e = this.expansionRate(a);
      const g = a / (a * e) ** 3;
      const t = a / (a * e);
      if (i > 0) {
        growthIntegral += 0.5 * step * (prevG + g);
        ageIntegral += 0.5 * step * (prevT + t);
      }
      prevG = g;
      prevT = t;
      // Unnormalised linear growth factor for a flat ΛCDM universe.
      this.dTable[i] = 2.5 * OMEGA_M * e * growthIntegral;
      this.tTable[i] = ageIntegral / H0_PER_GYR;
    }

    const dAtUnity = this.rawLookup(this.dTable, 1);
    for (let i = 0; i <= TABLE_N; i++) this.dTable[i] /= dAtUnity;

    // Logarithmic derivative by central difference — smooth enough to drive
    // velocities, and far simpler than differentiating the integral by hand.
    for (let i = 0; i <= TABLE_N; i++) {
      const lo = this.dTable[Math.max(0, i - 1)];
      const hi = this.dTable[Math.min(TABLE_N, i + 1)];
      const span = (Math.min(TABLE_N, i + 1) - Math.max(0, i - 1)) * step;
      this.dLogTable[i] = span > 0 ? (hi - lo) / span : 0;
    }
  }

  /** E(a) = H(a)/H₀. */
  expansionRate(a: number): number {
    return Math.sqrt(OMEGA_M / (a * a * a) + OMEGA_LAMBDA);
  }

  /** H(a) in 1/Gyr. */
  hubble(a: number): number {
    return H0_PER_GYR * this.expansionRate(a);
  }

  /** Linear growth factor, D(1) = 1. */
  growth(a: number): number {
    return this.rawLookup(this.dTable, a);
  }

  /** dD/dln a. */
  growthLogSlope(a: number): number {
    return this.rawLookup(this.dLogTable, a);
  }

  /** Ḋ = dD/dt in 1/Gyr — the coefficient of the Zel'dovich velocity field. */
  growthRate(a: number): number {
    return this.growthLogSlope(a) * this.hubble(a);
  }

  /** Age of the universe at a, in Gyr. */
  ageGyr(a: number): number {
    return this.rawLookup(this.tTable, a);
  }

  redshift(a: number): number {
    return 1 / a - 1;
  }

  private rawLookup(table: Float64Array, a: number): number {
    const lnA = Math.log(Math.max(a, 1e-12));
    const x = ((lnA - LN_A_MIN) / (LN_A_MAX - LN_A_MIN)) * TABLE_N;
    if (x <= 0) return table[0];
    if (x >= TABLE_N) return table[TABLE_N];
    const i = Math.floor(x);
    const f = x - i;
    return table[i] * (1 - f) + table[i + 1] * f;
  }
}
