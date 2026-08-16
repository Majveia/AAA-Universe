/**
 * The structural model of a galaxy — shared by every renderer in this module.
 *
 * One place defines *where the light is*, and both the CPU (which places a
 * million individual stars) and the GPU (which raymarches the smooth,
 * unresolved component and the dust) read it from here. If they disagree, the
 * point stars float in front of a glow that does not match them and the whole
 * illusion collapses.
 *
 * The profiles are the real ones:
 *
 *   disc      ρ ∝ exp(-r/h_r) · sech²(z/h_z)      — an isothermal sheet
 *   bulge     Hernquist ρ ∝ a/(m(m+a)³)          — projects to de Vaucouleurs R^¼
 *   arms      r = r₀·e^(θ·tan p)                  — logarithmic spirals
 *   rotation  v(r) = v∞·r/√(r²+r_c²)              — rises, then goes flat
 *
 * The flat rotation curve is the whole reason we believe in dark matter, and it
 * is also why a galaxy looks alive: Ω(r) = v(r)/r falls off as 1/r, so the
 * inner disc laps the outer disc. Spiral arms cannot be made of fixed stars or
 * they would wind into mush in a couple of rotations (the "winding problem").
 * They are density waves — a standing pattern rotating at its own Ω_p, with
 * stars streaming through it, bunching up as they cross. That is modelled
 * literally here: star positions are drawn from an *axisymmetric* disc, and the
 * vertex shader applies the density-wave bunching against the live pattern
 * phase. The arms therefore never wind up, and individual stars visibly slide
 * through them.
 *
 * Blue arms are not a stylistic choice either. O and B stars live ~10 Myr —
 * less than the time to cross an arm — so they are born in the shock and die in
 * it, never drifting away. Hence: young population co-rotates with the pattern,
 * old population orbits differentially.
 */

import { Rng } from '../core/Rand';
import { clamp, lerp, saturate } from '../core/Noise';
import { blackbodyRGB } from '../universe/Universe';
import type { GalaxySpec } from '../universe/Types';

/* ═══════════════════════════════════════════════════════════════════════════
   Populations
   ═══════════════════════════════════════════════════════════════════════════ */

/** Kinematic class of a star. Drives how the vertex shader moves it. */
export const POP = {
  /** Old thin disc: differential rotation + density-wave bunching. */
  DISC: 0,
  /** O/B and their nurseries: born in the arm, dead before they leave it. */
  YOUNG: 1,
  /** Bulge and bar: rigid-body rotation with the pattern. */
  BULGE: 2,
  /** Halo, globulars: pressure supported, barely rotating at all. */
  HALO: 3,
} as const;

export const GTYPE = {
  SPIRAL: 0,
  ELLIPTICAL: 1,
  LENTICULAR: 2,
  IRREGULAR: 3,
  DWARF: 4,
  RING: 5,
} as const;

export interface StarSample {
  x: number;
  y: number;
  z: number;
  /** Linear sRGB, 0–1. */
  r: number;
  g: number;
  b: number;
  /** Relative luminosity. Spans ~4 decades; drives size and HDR intensity. */
  lum: number;
  pop: number;
}

export interface GlobularCluster {
  x: number;
  y: number;
  z: number;
  /** Half-mass radius, ly. */
  radiusLy: number;
  /** Colour of the integrated light — old, metal-poor, yellow-orange. */
  color: [number, number, number];
  lum: number;
}

interface PopMix {
  disc: number;
  young: number;
  bulge: number;
  bar: number;
  halo: number;
  globular: number;
  ring: number;
  clump: number;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Model
   ═══════════════════════════════════════════════════════════════════════════ */

export class GalaxyModel {
  readonly spec: GalaxySpec;
  readonly typeId: number;

  /** Optical radius, ly. */
  readonly radius: number;
  /** Disc scale length h_r. The disc fades to nothing by ~4.5 h_r. */
  readonly hr: number;
  /** Stellar scale height h_z. */
  readonly hz: number;
  /** Dust settles into a thinner layer than the stars — this is why dust lanes
   *  read as *sharp* dark threads against a diffuse glow. */
  readonly dustHz: number;

  readonly barLen: number;
  readonly barAngle: number;
  /** Hernquist scale radius; R_eff ≈ 1.8153 a. */
  readonly bulgeA: number;
  /** Bulge/spheroid flattening c/a. */
  readonly bulgeQ: number;

  readonly arms: number;
  /** tan(pitch angle) — the b in r = r₀e^(bθ). */
  readonly armB: number;
  /** Radius where the arms start: the end of the bar, or the bulge edge. */
  readonly armR0: number;
  readonly armStrength: number;
  /** Density-wave orbit-bunching amplitude; 0.55 ⇒ ~2.2× arm contrast. */
  readonly armBunch: number;

  readonly ringR: number;
  readonly ringW: number;

  /** Ω(r) = omegaA / √(r² + rc²), radians per second of *display* time. */
  readonly omegaA: number;
  readonly rc: number;
  /** Pattern speed: Ω at the corotation radius. */
  readonly patternOmega: number;
  readonly corotation: number;

  /** 0–1 normalised star-formation rate; drives blue-ness and HII count. */
  readonly sfrNorm: number;
  readonly dustAmount: number;
  readonly agn: number;

  readonly discColor: [number, number, number];
  readonly armColor: [number, number, number];
  readonly coreColor: [number, number, number];
  readonly dustColor: [number, number, number];

  readonly clusters: GlobularCluster[] = [];
  /** Irregular galaxies are built out of a handful of chaotic clumps. */
  readonly clumps: { x: number; y: number; z: number; r: number }[] = [];

  private mix: PopMix;
  private rngSeed: number;

  constructor(spec: GalaxySpec) {
    this.spec = spec;
    const rng = new Rng(spec.seed ^ 0x9d21);
    this.rngSeed = spec.seed >>> 0;

    const t = spec.type;
    this.typeId =
      t === 'elliptical' ? GTYPE.ELLIPTICAL
      : t === 'lenticular' ? GTYPE.LENTICULAR
      : t === 'irregular' ? GTYPE.IRREGULAR
      : t === 'dwarf' ? GTYPE.DWARF
      : t === 'ring' ? GTYPE.RING
      : GTYPE.SPIRAL;

    const R = spec.radiusLy;
    this.radius = R;
    this.hr = R * 0.22;
    this.hz = Math.max(spec.thicknessLy, R * 0.004);
    this.dustHz = this.hz * 0.42;

    this.barLen = spec.barFraction > 0 ? spec.barFraction * R : 0;
    this.barAngle = rng.range(0, Math.PI * 2);

    const reff = Math.max(spec.bulgeFraction, 0.03) * R * (this.typeId === GTYPE.ELLIPTICAL ? 1.0 : 1.0);
    this.bulgeA = reff / 1.8153;
    this.bulgeQ =
      this.typeId === GTYPE.ELLIPTICAL ? rng.range(0.45, 0.92)
      : this.typeId === GTYPE.DWARF ? rng.range(0.6, 0.95)
      : rng.range(0.55, 0.78);

    this.arms = spec.arms;
    this.armB = Math.tan(clamp(spec.armPitch, 0.08, 0.7));
    this.armR0 = Math.max(this.barLen * 1.02, R * 0.07);
    this.sfrNorm = saturate(spec.sfr / 14);
    this.armStrength = lerp(0.5, 2.4, this.sfrNorm);
    this.armBunch = clamp(0.28 + this.sfrNorm * 0.4, 0.2, 0.62);

    this.ringR = R * rng.range(0.52, 0.7);
    this.ringW = R * rng.range(0.07, 0.13);

    // Display rotation. The physical angular velocity (~1e-15 rad/s) would take
    // 200 million years to show anything, so it is remapped onto a scale where
    // the half-light radius comes round in a quarter of an hour. The *shape*
    // of the curve is untouched, which is what the eye actually reads.
    this.rc = R * 0.055;
    const rHalf = R * 0.4;
    const spin = clamp(spec.angularVel / 1.5e-15, 0.55, 1.9);
    const omegaHalf = 0.0052 * spin;
    this.omegaA = omegaHalf * Math.sqrt(rHalf * rHalf + this.rc * this.rc);
    this.corotation = R * 0.55;
    this.patternOmega = this.omegaA / Math.sqrt(this.corotation * this.corotation + this.rc * this.rc);

    this.dustAmount =
      this.typeId === GTYPE.ELLIPTICAL ? 0.03
      : this.typeId === GTYPE.LENTICULAR ? 0.22
      : this.typeId === GTYPE.DWARF ? 0.25
      : this.typeId === GTYPE.IRREGULAR ? 0.7
      : lerp(0.55, 1.25, this.sfrNorm);
    this.agn = spec.agn;

    // Population colours. `armColor` from the spec is already youth-shifted;
    // the disc between the arms is an older, redder mixture, and the bulge is
    // old and metal-rich, which in practice means yellow.
    this.armColor = [spec.armColor[0], spec.armColor[1], spec.armColor[2]];
    this.coreColor = [spec.coreColor[0], spec.coreColor[1], spec.coreColor[2]];
    this.dustColor = [spec.dustColor[0], spec.dustColor[1], spec.dustColor[2]];
    const old: [number, number, number] = [1.06, 0.86, 0.62];
    this.discColor = [
      lerp(old[0], this.armColor[0], 0.35),
      lerp(old[1], this.armColor[1], 0.35),
      lerp(old[2], this.armColor[2], 0.35),
    ];

    this.mix = this.populationMix();
    this.buildClusters(rng.fork('gc'));
    this.buildClumps(rng.fork('clump'));
  }

  /* ───────────────────────── structure helpers ───────────────────────── */

  /** Angular velocity at radius r, rad/s of display time. */
  omega(r: number): number {
    return this.omegaA / Math.sqrt(r * r + this.rc * this.rc);
  }

  /** Azimuth of the arm ridge at radius r, in the pattern frame. */
  armAngle(r: number): number {
    return Math.log(Math.max(r, this.armR0 * 0.35) / this.armR0) / this.armB;
  }

  private populationMix(): PopMix {
    const z: PopMix = { disc: 0, young: 0, bulge: 0, bar: 0, halo: 0, globular: 0, ring: 0, clump: 0 };
    switch (this.typeId) {
      case GTYPE.ELLIPTICAL:
        return { ...z, bulge: 0.9, halo: 0.075, globular: 0.025 };
      case GTYPE.LENTICULAR:
        return { ...z, disc: 0.6, bulge: 0.31, halo: 0.06, globular: 0.03 };
      case GTYPE.IRREGULAR:
        return { ...z, clump: 0.52, disc: 0.18, young: 0.22, halo: 0.07, globular: 0.01 };
      case GTYPE.DWARF:
        return { ...z, bulge: 0.5, clump: 0.2, young: 0.09, halo: 0.2, globular: 0.01 };
      case GTYPE.RING:
        return { ...z, ring: 0.56, bulge: 0.24, halo: 0.1, young: 0.08, globular: 0.02 };
      default: {
        const bar = this.barLen > 0 ? 0.13 : 0;
        return {
          ...z,
          disc: 0.54 - bar * 0.4,
          young: 0.13 + this.sfrNorm * 0.05,
          bulge: 0.16 - bar * 0.5,
          bar,
          halo: 0.04,
          globular: 0.025,
        };
      }
    }
  }

  private buildClusters(rng: Rng): void {
    // Ellipticals are surrounded by thousands of globulars; spirals by a couple
    // of hundred. They are the oldest things in the galaxy and they sit in the
    // halo because that is where they formed, before the disc settled.
    const n =
      this.typeId === GTYPE.ELLIPTICAL ? rng.int(180, 320)
      : this.typeId === GTYPE.DWARF ? rng.int(6, 24)
      : rng.int(70, 160);
    for (let i = 0; i < n; i++) {
      // Halo number density ∝ r^-3.5 ⇒ dN/dr ∝ r^-1.5.
      const r = rng.powerLaw(this.radius * 0.05, this.radius * 1.5, -1.55);
      const d = rng.onSphere();
      // Mild flattening toward the disc for the metal-rich subpopulation.
      const flat = rng.chance(0.3) ? 0.45 : 1.0;
      const temp = rng.range(3900, 5400);
      const c = blackbodyRGB(temp);
      this.clusters.push({
        x: d.x * r,
        y: d.y * r * flat,
        z: d.z * r,
        radiusLy: rng.range(12, 60),
        color: [c[0], c[1] * 0.97, c[2] * 0.85],
        lum: rng.range(0.4, 3.2),
      });
    }
  }

  private buildClumps(rng: Rng): void {
    if (this.typeId !== GTYPE.IRREGULAR && this.typeId !== GTYPE.DWARF) return;
    const n = this.typeId === GTYPE.IRREGULAR ? rng.int(5, 11) : rng.int(3, 7);
    for (let i = 0; i < n; i++) {
      const r = this.radius * Math.pow(rng.next(), 0.6) * 0.8;
      const th = rng.range(0, Math.PI * 2);
      this.clumps.push({
        x: Math.cos(th) * r,
        y: rng.normal(0, this.radius * 0.12),
        z: Math.sin(th) * r * rng.range(0.6, 1.2),
        r: this.radius * rng.range(0.12, 0.34),
      });
    }
  }

  /* ───────────────────────── position sampling ───────────────────────── */

  /** Inverse-CDF sample of an exponential disc surface density Σ ∝ e^(-r/h). */
  private expDiscRadius(rng: Rng, h: number, rmax: number): number {
    const xmax = rmax / h;
    const umax = 1 - (1 + xmax) * Math.exp(-xmax);
    const u = rng.next() * umax;
    let x = 1.6;
    for (let i = 0; i < 30; i++) {
      const e = Math.exp(-x);
      const f = 1 - (1 + x) * e - u;
      const df = x * e;
      if (df < 1e-9) break;
      const nx = x - f / df;
      x = nx < 0 ? x * 0.5 : nx;
      if (Math.abs(f) < 1e-7) break;
    }
    return Math.min(x, xmax) * h;
  }

  /** sech²(z/h) has CDF ½(1+tanh(z/h)) — invert it directly. */
  private sech2Height(rng: Rng, h: number): number {
    const u = clamp(rng.next(), 1e-4, 1 - 1e-4);
    return h * 0.5 * Math.log((1 + (2 * u - 1)) / (1 - (2 * u - 1)));
  }

  /** Hernquist: M(<m) = m²/(m+a)² inverts in closed form. */
  private hernquistRadius(rng: Rng, a: number, rmax: number): number {
    const u = clamp(rng.next(), 0, 0.9995);
    const s = Math.sqrt(u);
    return Math.min(a * (s / Math.max(1e-4, 1 - s)), rmax);
  }

  /** Pick a population by weight. */
  private choosePop(rng: Rng): keyof PopMix {
    const m = this.mix;
    let r = rng.next();
    const keys: (keyof PopMix)[] = ['disc', 'young', 'bulge', 'bar', 'halo', 'globular', 'ring', 'clump'];
    for (const k of keys) {
      r -= m[k];
      if (r <= 0) return k;
    }
    return 'disc';
  }

  /**
   * Draw one star. Positions are *axisymmetric* for the disc — the spiral arms
   * are applied live in the vertex shader as orbit bunching, so that they
   * cannot wind up no matter how long the galaxy turns.
   */
  sample(rng: Rng, out: StarSample): StarSample {
    const kind = this.choosePop(rng);
    const R = this.radius;

    switch (kind) {
      case 'young': {
        // Born in the shock: within a fraction of an arm width of the ridge.
        const r = clamp(this.expDiscRadius(rng, this.hr * 1.15, R * 1.05), this.armR0, R * 1.05);
        const armIdx = this.arms > 0 ? rng.int(0, this.arms - 1) : 0;
        const base = this.arms > 0 ? this.armAngle(r) + (armIdx * Math.PI * 2) / this.arms : rng.range(0, Math.PI * 2);
        // Arm width narrows inward — the shock is tighter where the gas is denser.
        const width = (this.arms > 0 ? 0.16 : 3.0) * (1 + (R * 0.35) / Math.max(r, R * 0.05));
        const th = base + rng.normal(0, width) + rng.normal(0, 0.05);
        // Young stars have not had time to be scattered out of the gas layer.
        const y = this.sech2Height(rng, this.hz * 0.45);
        out.x = Math.cos(th) * r;
        out.y = y;
        out.z = Math.sin(th) * r;
        out.pop = POP.YOUNG;
        this.paint(rng, out, 'young');
        return out;
      }
      case 'bulge': {
        const m = this.hernquistRadius(rng, this.bulgeA, R * 1.4);
        const d = rng.onSphere();
        out.x = d.x * m;
        out.y = d.y * m * this.bulgeQ;
        out.z = d.z * m;
        out.pop = POP.BULGE;
        this.paint(rng, out, 'old');
        return out;
      }
      case 'bar': {
        // A boxy/peanut bar: |x/a|^c + |z/b|^c + |y/c|^c ≤ 1 with c ≈ 2.6.
        // Boxiness is the signature of the vertical buckling instability that
        // makes real bars, and it is what stops this looking like a cigar.
        let bx = 0;
        let by = 0;
        let bz = 0;
        for (let i = 0; i < 12; i++) {
          bx = rng.range(-1, 1);
          by = rng.range(-1, 1);
          bz = rng.range(-1, 1);
          const m =
            Math.pow(Math.abs(bx), 2.6) + Math.pow(Math.abs(bz / 0.3), 2.6) + Math.pow(Math.abs(by / 0.22), 2.6);
          if (m <= 1) break;
        }
        const shrink = Math.pow(rng.next(), 0.28);
        const a = this.barLen;
        const px = bx * a * shrink;
        const py = by * a * shrink;
        const pz = bz * a * shrink;
        const ca = Math.cos(this.barAngle);
        const sa = Math.sin(this.barAngle);
        out.x = px * ca - pz * sa;
        out.y = py;
        out.z = px * sa + pz * ca;
        out.pop = POP.BULGE;
        this.paint(rng, out, 'old');
        return out;
      }
      case 'halo': {
        const r = rng.powerLaw(R * 0.06, R * 1.8, -1.6);
        const d = rng.onSphere();
        out.x = d.x * r;
        out.y = d.y * r;
        out.z = d.z * r;
        out.pop = POP.HALO;
        this.paint(rng, out, 'ancient');
        return out;
      }
      case 'globular': {
        const c = this.clusters.length ? this.clusters[rng.int(0, this.clusters.length - 1)] : null;
        if (!c) {
          out.x = out.y = out.z = 0;
          out.pop = POP.HALO;
          this.paint(rng, out, 'ancient');
          return out;
        }
        // Plummer sphere: r = a/√(u^(-2/3) − 1).
        const u = clamp(rng.next(), 1e-3, 0.999);
        const rr = c.radiusLy / Math.sqrt(Math.pow(u, -2 / 3) - 1);
        const d = rng.onSphere();
        out.x = c.x + d.x * rr;
        out.y = c.y + d.y * rr;
        out.z = c.z + d.z * rr;
        out.pop = POP.HALO;
        this.paint(rng, out, 'ancient');
        return out;
      }
      case 'ring': {
        const r = this.ringR + rng.normal(0, this.ringW * 0.6);
        const th = rng.range(0, Math.PI * 2);
        out.x = Math.cos(th) * r;
        out.y = this.sech2Height(rng, this.hz * 0.8);
        out.z = Math.sin(th) * r;
        out.pop = POP.YOUNG;
        this.paint(rng, out, rng.chance(0.55) ? 'young' : 'disc');
        return out;
      }
      case 'clump': {
        const c = this.clumps.length ? this.clumps[rng.int(0, this.clumps.length - 1)] : null;
        const g = () => rng.normal(0, 1);
        if (c) {
          out.x = c.x + g() * c.r * 0.5;
          out.y = c.y + g() * c.r * 0.32;
          out.z = c.z + g() * c.r * 0.5;
        } else {
          out.x = g() * R * 0.4;
          out.y = g() * R * 0.15;
          out.z = g() * R * 0.4;
        }
        out.pop = rng.chance(0.35) ? POP.YOUNG : POP.DISC;
        this.paint(rng, out, out.pop === POP.YOUNG ? 'young' : 'disc');
        return out;
      }
      default: {
        const r = this.expDiscRadius(rng, this.hr, R * 1.15);
        const th = rng.range(0, Math.PI * 2);
        // The disc thickens outward (real, and it softens the edge nicely).
        const flare = 1 + (r / R) * 0.9;
        out.x = Math.cos(th) * r;
        out.y = this.sech2Height(rng, this.hz * flare);
        out.z = Math.sin(th) * r;
        out.pop = POP.DISC;
        this.paint(rng, out, 'disc');
        return out;
      }
    }
  }

  /**
   * Colour and luminosity from an IMF-weighted population.
   *
   * A rendered point is not one star, it is a luminosity-weighted draw from the
   * population — we are painting where the *light* is, not where the mass is.
   * That is why red dwarfs, which are 75% of all stars, barely appear: they
   * contribute almost nothing to what a telescope sees.
   */
  private paint(rng: Rng, out: StarSample, kind: 'young' | 'disc' | 'old' | 'ancient'): void {
    let lum: number;
    let temp: number;

    if (kind === 'young') {
      // O/B/A. L ∝ M^3.5 and T ∝ M^0.54, so T ∝ L^0.154 along the main sequence.
      lum = rng.powerLaw(1.5, 900, -1.32);
      temp = 5772 * Math.pow(lum, 0.155) * rng.range(0.94, 1.08);
      if (rng.chance(0.02)) {
        // A red supergiant among the blue ones — every OB association has one,
        // and the colour contrast is what sells the association as real.
        temp = rng.range(3300, 4300);
        lum *= rng.range(1.5, 6);
      }
    } else if (kind === 'disc') {
      lum = rng.powerLaw(0.05, 55, -1.55);
      temp = 5772 * Math.pow(lum, 0.152) * rng.range(0.92, 1.06);
      if (rng.chance(0.022)) {
        temp = rng.range(3400, 4700);
        lum = rng.range(60, 700); // red giant branch
      }
    } else if (kind === 'old') {
      lum = rng.powerLaw(0.05, 26, -1.7);
      temp = 5300 * Math.pow(lum, 0.14) * rng.range(0.9, 1.03);
      if (rng.chance(0.05)) {
        temp = rng.range(3300, 4500);
        lum = rng.range(70, 900);
      }
    } else {
      // Metal-poor and twelve billion years old: nothing blue survives.
      lum = rng.powerLaw(0.05, 14, -1.75);
      temp = 5000 * Math.pow(lum, 0.13) * rng.range(0.9, 1.02);
      if (rng.chance(0.06)) {
        temp = rng.range(3600, 4600);
        lum = rng.range(60, 600);
      }
    }

    temp = clamp(temp, 2400, 42000);
    const c = blackbodyRGB(temp);
    out.r = c[0];
    out.g = c[1];
    out.b = c[2];
    out.lum = lum;
  }

  /* ───────────────────────── HII regions ───────────────────────── */

  /**
   * Giant molecular cloud complexes lit from inside by the OB stars that just
   * formed there. They trace the arms better than anything else in a galaxy,
   * and their Hα magenta against the blue of the arm is the single most
   * recognisable colour signature in astrophotography.
   */
  sampleHII(rng: Rng, out: StarSample): StarSample {
    const R = this.radius;
    if (this.typeId === GTYPE.RING) {
      const r = this.ringR + rng.normal(0, this.ringW * 0.5);
      const th = rng.range(0, Math.PI * 2);
      out.x = Math.cos(th) * r;
      out.y = this.sech2Height(rng, this.hz * 0.5);
      out.z = Math.sin(th) * r;
    } else if (this.clumps.length && (this.typeId === GTYPE.IRREGULAR || this.typeId === GTYPE.DWARF)) {
      const c = this.clumps[rng.int(0, this.clumps.length - 1)];
      out.x = c.x + rng.normal(0, c.r * 0.45);
      out.y = c.y + rng.normal(0, c.r * 0.28);
      out.z = c.z + rng.normal(0, c.r * 0.45);
    } else {
      const r = clamp(this.expDiscRadius(rng, this.hr * 1.25, R * 1.0), this.armR0, R);
      const armIdx = this.arms > 0 ? rng.int(0, Math.max(0, this.arms - 1)) : 0;
      const base = this.arms > 0 ? this.armAngle(r) + (armIdx * Math.PI * 2) / this.arms : rng.range(0, Math.PI * 2);
      const th = base + rng.normal(0, this.arms > 0 ? 0.1 : 3.0);
      out.x = Math.cos(th) * r;
      out.y = this.sech2Height(rng, this.hz * 0.35);
      out.z = Math.sin(th) * r;
    }
    out.pop = POP.YOUNG;
    // Hα 656 nm dominates, with [O III] 501 nm from the hottest cores. The
    // result is the pink that every emission nebula in the sky is made of.
    const oiii = rng.next();
    out.r = lerp(2.7, 0.55, oiii * 0.75);
    out.g = lerp(0.5, 1.5, oiii);
    out.b = lerp(0.95, 1.35, oiii);
    out.lum = rng.powerLaw(30, 2600, -1.5);
    return out;
  }

  /* ───────────────────────── uniforms ───────────────────────── */

  /**
   * One shared uniform object for every material in the module. Sharing the
   * `IUniform` instances (not copies) means the per-frame pattern phase is
   * written once and every shader sees it.
   */
  makeUniforms(): Record<string, { value: any }> {
    return {
      uGType: { value: this.typeId },
      uRadius: { value: this.radius },
      uHr: { value: this.hr },
      uHz: { value: this.hz },
      uDustHz: { value: this.dustHz },
      uBarLen: { value: this.barLen },
      uBarAngle: { value: this.barAngle },
      uBulgeA: { value: this.bulgeA },
      uBulgeQ: { value: this.bulgeQ },
      uArms: { value: this.arms },
      uArmB: { value: this.armB },
      uArmR0: { value: this.armR0 },
      uArmStrength: { value: this.armStrength },
      uArmBunch: { value: this.armBunch },
      uArmDustShift: { value: -0.34 },
      uPattern: { value: 0 },
      uOmegaA: { value: this.omegaA },
      uRc: { value: this.rc },
      uGalTime: { value: 0 },
      uRingR: { value: this.ringR },
      uRingW: { value: this.ringW },
      uSfr: { value: this.sfrNorm },
      uDust: { value: this.dustAmount },
      uAgn: { value: this.agn },
      uArmColor: { value: this.armColor.slice() },
      uCoreColor: { value: this.coreColor.slice() },
      uDiscColor: { value: this.discColor.slice() },
      uDustColor: { value: this.dustColor.slice() },
    };
  }

  get seed(): number {
    return this.rngSeed;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   GLSL — the same structure, evaluated per fragment.
   Requires GLSL_NOISE (snoise/fbm/ridged/worley) to be included first.
   ═══════════════════════════════════════════════════════════════════════════ */

export const GLSL_GALAXY = /* glsl */ `
#ifndef AEON_GALAXY_INCLUDED
#define AEON_GALAXY_INCLUDED

uniform int   uGType;
uniform float uRadius;
uniform float uHr;
uniform float uHz;
uniform float uDustHz;
uniform float uBarLen;
uniform float uBarAngle;
uniform float uBulgeA;
uniform float uBulgeQ;
uniform float uArms;
uniform float uArmB;
uniform float uArmR0;
uniform float uArmStrength;
uniform float uArmBunch;
uniform float uArmDustShift;
uniform float uPattern;
uniform float uOmegaA;
uniform float uRc;
uniform float uGalTime;
uniform float uRingR;
uniform float uRingW;
uniform float uSfr;
uniform float uDust;
uniform float uAgn;
uniform vec3  uArmColor;
uniform vec3  uCoreColor;
uniform vec3  uDiscColor;
uniform vec3  uDustColor;

const int AEON_SPIRAL = 0;
const int AEON_ELLIPTICAL = 1;
const int AEON_LENTICULAR = 2;
const int AEON_IRREGULAR = 3;
const int AEON_DWARF = 4;
const int AEON_RING = 5;

float aeonSech2(float x){
  float e = exp(-abs(x));
  float s = 2.0 * e / (1.0 + e * e);
  return s * s;
}

vec3 galaxyRotY(vec3 p, float a){
  float c = cos(a), s = sin(a);
  return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
}

/** Ω(r) — flat rotation curve, solid body inside r_c. */
float galaxyOmega(float r){
  return uOmegaA / sqrt(r * r + uRc * uRc);
}

/** Azimuth of the arm ridge at r, in the pattern frame. */
float galaxyArmAngle(float r){
  return log(max(r, uArmR0 * 0.35) / uArmR0) / max(uArmB, 0.02);
}

/** Signed phase relative to the nearest arm ridge; 0 on the crest. */
float galaxyArmPhase(float r, float theta, float shift){
  return (theta - uPattern - galaxyArmAngle(r) + shift) * uArms;
}

/** 0-1 arm occupancy. "sharp" narrows the crest; arms fade at both ends. */
float galaxyArmWeight(float r, float theta, float sharp, float shift){
  if (uArms < 0.5) return 0.0;
  float ph = galaxyArmPhase(r, theta, shift);
  float w = 0.5 + 0.5 * cos(ph);
  w = pow(max(w, 0.0), sharp);
  float inner = smoothstep(uArmR0 * 0.6, uArmR0 * 2.0, r);
  float outer = 1.0 - smoothstep(uRadius * 0.72, uRadius * 1.12, r);
  return w * inner * outer;
}

/** Boxy/peanut bar, co-rotating with the pattern. */
float galaxyBar(vec3 p){
  if (uBarLen <= 0.0) return 0.0;
  float a = uBarAngle + uPattern;
  vec3 q = galaxyRotY(p, -a);
  float m = pow(abs(q.x / uBarLen), 2.6)
          + pow(abs(q.z / (uBarLen * 0.30)), 2.6)
          + pow(abs(q.y / (uBarLen * 0.22)), 2.6);
  return exp(-2.6 * pow(max(m, 0.0), 0.55));
}

/** Hernquist spheroid, flattened by uBulgeQ. Projects to de Vaucouleurs R^¼. */
float galaxySpheroid(vec3 p){
  float r = length(p.xz);
  float m = sqrt(r * r + (p.y * p.y) / max(uBulgeQ * uBulgeQ, 1e-3));
  m = max(m, uBulgeA * 0.05);
  float a = uBulgeA;
  return (a * a * a * a) / (m * (m + a) * (m + a) * (m + a));
}

/**
 * The medium at a point: emitted radiance per unit length and the dust
 * extinction coefficient. Everything — the volume renderer, the sky band, the
 * ambient glow — integrates this one function.
 */
void galaxyMedium(vec3 p, out vec3 emis, out float ext){
  float r  = length(p.xz);
  float y  = p.y;
  float th = atan(p.z, p.x);
  float R  = uRadius;

  emis = vec3(0.0);
  ext  = 0.0;

  // Flocculent warp — real arms are ragged. Without this they look drafted.
  float warp = fbm(p * (2.4 / R) + vec3(0.0, 7.31, 0.0), 3) * 0.6;
  float turb = fbm(p * (9.0 / R) + vec3(19.7, 0.0, 4.2), 4) * 0.5 + 0.5;

  float sph  = galaxySpheroid(p);
  float edge = 1.0 - smoothstep(R * 0.92, R * 1.3, r);
  float disc = exp(-r / uHr) * aeonSech2(y / (uHz * (1.0 + r / R))) * edge;

  if (uGType == AEON_ELLIPTICAL){
    // No disc, no arms, no dust: an elliptical is a relaxed cloud of old stars
    // that ran out of gas ten billion years ago. Its beauty is its smoothness.
    float g = sph * (0.92 + turb * 0.16);
    emis = uCoreColor * g * 0.55;
    ext  = uDust * g * 0.02;
    return;
  }

  if (uGType == AEON_DWARF){
    float cl = fbm(p * (5.5 / R) + vec3(3.1, 1.7, 9.4), 4) * 0.5 + 0.5;
    float body = sph * 0.5 + disc * 0.6;
    vec3 c = mix(uCoreColor, uArmColor, 0.4 * uSfr + 0.15);
    emis = c * body * (0.35 + cl * 1.5) * 0.5;
    ext  = uDust * body * cl * 0.5;
    return;
  }

  if (uGType == AEON_IRREGULAR){
    // Tidally battered: no symmetry, patchy bursts of star formation.
    float lump = fbm(p * (3.4 / R) + vec3(11.2, 5.0, 2.3), 5);
    float body = smoothstep(-0.05, 0.55, lump) * exp(-r / (uHr * 1.6))
               * aeonSech2(y / (uHz * 5.0)) * edge;
    float burst = pow(max(fbm(p * (12.0 / R) + vec3(2.0), 3), 0.0), 2.0);
    emis = uDiscColor * body * 0.8
         + uArmColor * body * burst * 4.0 * uSfr
         + vec3(2.6, 0.55, 0.95) * body * burst * burst * 5.0 * uSfr
         + uCoreColor * sph * 0.25;
    ext = uDust * body * (0.4 + turb) * 1.4;
    return;
  }

  if (uGType == AEON_RING){
    // A head-on collision drives a density wave outward like a ripple in a
    // pond; the ring is where the gas piled up and lit itself on fire.
    float rr = (r - uRingR) / uRingW;
    float ring = exp(-rr * rr) * aeonSech2(y / (uHz * 1.4)) * (0.55 + turb * 0.9);
    float spoke = pow(max(0.5 + 0.5 * cos(th * 9.0 + warp * 3.0), 0.0), 3.0);
    float core = sph * 0.8;
    float knot = smoothstep(0.44, 0.05, worley(galaxyRotY(p, -uPattern) * (30.0 / R), 1.0).x);
    emis = uCoreColor * core
         + uArmColor * ring * (1.6 + spoke * 0.8) * 1.4
         + vec3(2.8, 0.6, 1.0) * knot * ring * 6.0 * uSfr;
    ext = uDust * ring * 0.5 + uDust * disc * 0.25;
    return;
  }

  /* ---- spiral, barred spiral, lenticular ---- */

  float armSharp = 2.4;
  float arm = galaxyArmWeight(r, th + warp * 0.4, armSharp, 0.0);
  float armD = galaxyArmWeight(r, th + warp * 0.4, 1.7, uArmDustShift);
  if (uGType == AEON_LENTICULAR){ arm = 0.0; armD = 0.0; }

  // Ragged the arms further: star formation is patchy along the shock.
  arm *= 0.45 + 0.9 * turb;

  float bar = galaxyBar(p);
  float young = arm * uSfr;

  // HII complexes ride the pattern, so evaluate the cell noise in that frame.
  vec3 pf = galaxyRotY(p, -uPattern);
  float cell = worley(pf * (34.0 / R), 1.0).x;
  float knot = smoothstep(0.40, 0.03, cell) * young * disc * aeonSech2(y / (uHz * 0.5));

  vec3 e = uDiscColor * disc * (1.0 + arm * uArmStrength * 0.7)
         + uArmColor  * disc * young * 2.6
         + vec3(2.9, 0.55, 1.0) * knot * 9.0
         + uCoreColor * sph * 0.5
         + uCoreColor * bar * 0.9;

  // Dust: thinner layer than the stars, concentrated on the inner edge of each
  // arm where the gas shocks. This is what makes a galaxy photograph look like
  // a photograph — the dark threads are structure, not absence of light.
  float dustLayer = exp(-r / (uHr * 1.25)) * aeonSech2(y / uDustHz)
                  * (1.0 - smoothstep(uRadius * 0.85, uRadius * 1.15, r));
  float dustTurb = fbm(p * (16.0 / R) + vec3(5.0, 2.0, 8.0), 4) * 0.5 + 0.5;
  float dustLane = uDust * dustLayer * (0.22 + 2.6 * armD) * (0.35 + 1.3 * dustTurb);
  if (uGType == AEON_LENTICULAR) dustLane = uDust * dustLayer * 0.5 * (0.4 + dustTurb);

  emis = e;
  ext  = dustLane;
}

#endif
`;
