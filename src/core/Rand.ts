/**
 * Deterministic hashing + pseudo-random utilities.
 *
 * Everything in ÆON is generated from a single 32-bit universe seed. Any object
 * — a supercluster, a star, a moon, a boulder on a hillside — derives its own
 * seed by hashing its coordinates with its parent's seed. Nothing is stored;
 * everything is recomputed. That is what lets the universe be effectively
 * infinite while fitting in a few hundred kilobytes of code.
 */

/** 32-bit integer avalanche (Thomas Wang / MurmurHash3 finaliser). */
export function hashU32(x: number): number {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Combine an arbitrary number of integers into one well-mixed 32-bit hash. */
export function hashCombine(...vals: number[]): number {
  let h = 0x9e3779b9;
  for (let i = 0; i < vals.length; i++) {
    h = (h ^ hashU32((vals[i] | 0) + 0x9e3779b9 + (h << 6) + (h >>> 2))) >>> 0;
    h = hashU32(h);
  }
  return h >>> 0;
}

/** Hash a string to a 32-bit seed (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return hashU32(h);
}

/** Deterministic float in [0,1) from any integer key. */
export function hashFloat(...vals: number[]): number {
  return hashCombine(...vals) / 4294967296;
}

/**
 * Small, fast, high-quality PRNG (mulberry32). Seeded streams are reproducible
 * across machines and sessions, which is what makes the universe persistent.
 */
export class Rng {
  private s: number;

  constructor(seed: number | string = 1) {
    this.s = (typeof seed === 'string' ? hashString(seed) : hashU32(seed >>> 0)) >>> 0;
    if (this.s === 0) this.s = 0x6d2b79f5;
  }

  /** Fork a new independent stream — use this instead of sharing an Rng. */
  fork(salt: number | string = 0): Rng {
    const k = typeof salt === 'string' ? hashString(salt) : salt;
    return new Rng(hashCombine(this.s, k, 0x51ed270b));
  }

  /** Uniform float in [0,1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [a,b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Uniform integer in [a,b] inclusive. */
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal via Box–Muller. */
  normal(mean = 0, sigma = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return mean + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Power-law sample in [min,max] with exponent alpha. Used for stellar masses
   * (the Salpeter IMF, alpha ≈ -2.35), crater sizes, asteroid diameters, city
   * populations — nature is full of power laws.
   */
  powerLaw(min: number, max: number, alpha: number): number {
    const u = this.next();
    if (Math.abs(alpha + 1) < 1e-6) return min * Math.pow(max / min, u);
    const a1 = alpha + 1;
    return Math.pow(u * (Math.pow(max, a1) - Math.pow(min, a1)) + Math.pow(min, a1), 1 / a1);
  }

  /** Pick a uniformly random element. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }

  /** Pick by relative weights. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const e of entries) total += e[1];
    let r = this.next() * total;
    for (const e of entries) {
      r -= e[1];
      if (r <= 0) return e[0];
    }
    return entries[entries.length - 1][0];
  }

  /** In-place Fisher–Yates shuffle. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Uniform point on the unit sphere (Marsaglia). */
  onSphere(out: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }) {
    const u = this.range(-1, 1);
    const t = this.range(0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    out.x = r * Math.cos(t);
    out.y = u;
    out.z = r * Math.sin(t);
    return out;
  }

  /** Uniform point inside the unit disc. */
  inDisc(): [number, number] {
    const r = Math.sqrt(this.next());
    const t = this.next() * Math.PI * 2;
    return [r * Math.cos(t), r * Math.sin(t)];
  }
}

/** Convenience: a throwaway stream seeded by coordinates. */
export function rngAt(...coords: number[]): Rng {
  return new Rng(hashCombine(...coords));
}
