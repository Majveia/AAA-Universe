/**
 * The generator. Given a seed and a coordinate, this file conjures a star, a
 * system, a world — with astrophysics that is real wherever real is also
 * beautiful, and gently exaggerated wherever it is not.
 *
 * Things that are genuinely modelled:
 *   • the Kroupa initial mass function, so M-dwarfs dominate as they should
 *   • mass–luminosity, mass–radius and Stefan–Boltzmann for stellar properties
 *   • the habitable zone from bolometric luminosity
 *   • equilibrium temperature from insolation, albedo and greenhouse forcing
 *   • the ice line, which decides where gas giants can form
 *   • Hill spheres for moon capture and Roche limits for ring survival
 *   • Kepler's third law for every orbit in the game
 *
 * Things that are cheerfully exaggerated: the frequency of interesting worlds.
 * A truthful universe is 99.99% barren rock, and that makes a bad game. ÆON
 * biases toward the remarkable while keeping the *physics* of each world
 * self-consistent, so a world that looks impossible still obeys its own rules.
 */

import { Rng, hashCombine } from '../core/Rand';
import { clamp, lerp, saturate, smoothstep } from '../core/Noise';
import {
  AU,
  AsteroidBeltSpec,
  AtmosphereSpec,
  BiomePalette,
  CivilizationSpec,
  EARTH_MASS,
  EARTH_RADIUS,
  G,
  GalaxySpec,
  GalaxyType,
  JUPITER_MASS,
  JUPITER_RADIUS,
  LY,
  LifeStage,
  MoonSpec,
  NebulaSpec,
  OceanSpec,
  OrbitElements,
  PlanetClass,
  PlanetSpec,
  RingSpec,
  SOLAR_LUMINOSITY,
  SOLAR_MASS,
  SOLAR_RADIUS,
  SpectralClass,
  StarSpec,
  StarSystemSpec,
  TerrainSpec,
} from './Types';
import {
  cityName,
  civilizationName,
  galaxyName,
  moonDesignation,
  nebulaName,
  planetDesignation,
  planetProperName,
  starName,
} from './Names';

/* ═══════════════════════════════════════════════════════════════════════════
   Stars
   ═══════════════════════════════════════════════════════════════════════════ */

const SUN_TEMP = 5772;

/** Kroupa IMF sample, in solar masses. Heavily weighted to small stars. */
function sampleIMF(rng: Rng): number {
  const u = rng.next();
  if (u < 0.78) return rng.powerLaw(0.08, 0.5, -1.3); // M dwarfs: most of the sky
  if (u < 0.965) return rng.powerLaw(0.5, 2.0, -2.3); // K, G, F
  if (u < 0.998) return rng.powerLaw(2.0, 16.0, -2.3); // A, B
  return rng.powerLaw(16.0, 60.0, -2.3); // O — rare, brief, spectacular
}

function luminosityFromMass(m: number): number {
  if (m < 0.43) return 0.23 * Math.pow(m, 2.3);
  if (m < 2) return Math.pow(m, 4);
  if (m < 55) return 1.4 * Math.pow(m, 3.5);
  return 32000 * m;
}

function radiusFromMass(m: number): number {
  return m < 1 ? Math.pow(m, 0.8) : Math.pow(m, 0.57);
}

function spectralFromTemp(t: number): SpectralClass {
  if (t >= 30000) return 'O';
  if (t >= 10000) return 'B';
  if (t >= 7500) return 'A';
  if (t >= 6000) return 'F';
  if (t >= 5200) return 'G';
  if (t >= 3700) return 'K';
  if (t >= 2400) return 'M';
  if (t >= 1300) return 'L';
  return 'T';
}

/** Planck-locus colour, normalised so the eye reads it as the star's hue. */
export function blackbodyRGB(tempK: number): [number, number, number] {
  const t = clamp(tempK, 1000, 40000) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const out: [number, number, number] = [clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255];
  // Lift toward white a touch: pure Planck colours look muddy in-engine.
  return [lerp(out[0], 1, 0.18), lerp(out[1], 1, 0.14), lerp(out[2], 1, 0.1)];
}

export function makeStar(rng: Rng, pos: [number, number, number], forceMassSolar?: number): StarSpec {
  const seed = rng.int(0, 2 ** 30);
  let msol = forceMassSolar ?? sampleIMF(rng);

  // Main-sequence lifetime ~ 10 Gyr * M^-2.5. Massive stars die young, so any
  // massive star we generate must be young; low-mass stars can be any age.
  const lifetimeGyr = 10 * Math.pow(msol, -2.5);
  const ageGyr = rng.range(0.05, Math.min(13.5, lifetimeGyr * 1.15));

  // A small fraction of stars have already left the main sequence.
  const evolved = ageGyr > lifetimeGyr;
  let lsol = luminosityFromMass(msol);
  let rsol = radiusFromMass(msol);
  let lumClass: StarSpec['luminosityClass'] = 'V';
  let compact: StarSpec['compact'] | undefined;

  if (evolved) {
    if (msol < 8) {
      if (rng.chance(0.62)) {
        // Red giant: puffed up, cooled down, ferociously bright.
        rsol *= rng.range(20, 90);
        lsol *= rng.range(180, 2400);
        lumClass = 'III';
      } else {
        // White dwarf remnant: Earth-sized, faint, blue-white.
        msol = rng.range(0.5, 1.2);
        rsol = 0.012 * Math.pow(msol, -1 / 3);
        lsol = rng.range(0.0002, 0.04);
        lumClass = 'VII';
        compact = { kind: 'white-dwarf', schwarzschildM: 0, accretionW: 0, jetAngle: 0, spin: rng.range(0, 1) };
      }
    } else if (msol < 25) {
      // Neutron star: 20 km across, absurdly hot, spinning fast.
      const nsMass = rng.range(1.2, 2.1);
      rsol = 1.2e4 / SOLAR_RADIUS;
      lsol = rng.range(0.1, 40);
      lumClass = 'VII';
      compact = {
        kind: 'neutron-star',
        schwarzschildM: (2 * G * nsMass * SOLAR_MASS) / (2.99792458e8 ** 2),
        accretionW: rng.chance(0.35) ? rng.range(1e26, 1e30) : 0,
        jetAngle: rng.chance(0.5) ? rng.range(0.05, 0.3) : 0,
        spin: rng.range(0.3, 1),
      };
      msol = nsMass;
    } else {
      // Stellar-mass black hole with an accretion disc worth flying to.
      const bhMass = rng.range(5, 40);
      const rs = (2 * G * bhMass * SOLAR_MASS) / (2.99792458e8 ** 2);
      rsol = rs / SOLAR_RADIUS;
      lsol = 0;
      lumClass = 'VII';
      compact = {
        kind: 'black-hole',
        schwarzschildM: rs,
        accretionW: rng.chance(0.55) ? rng.range(1e28, 1e32) : 0,
        jetAngle: rng.chance(0.4) ? rng.range(0.03, 0.2) : 0,
        spin: rng.range(0.1, 0.998),
      };
      msol = bhMass;
    }
  }

  const radiusM = rsol * SOLAR_RADIUS;
  const luminosityW = lsol * SOLAR_LUMINOSITY;
  // T from L = 4πR²σT⁴
  const tempK =
    compact?.kind === 'black-hole'
      ? 0
      : Math.max(600, SUN_TEMP * Math.pow(lsol / (rsol * rsol), 0.25));

  const spectral: SpectralClass =
    compact?.kind === 'black-hole'
      ? 'BH'
      : compact?.kind === 'neutron-star'
        ? 'NS'
        : compact?.kind === 'white-dwarf'
          ? 'D'
          : spectralFromTemp(tempK);

  // Smaller, cooler stars are magnetically furious; hot giants are placid.
  const activity = saturate(1.15 - msol * 0.55 + rng.range(-0.15, 0.2));

  return {
    seed,
    name: starName(rng, pos),
    spectral,
    subclass: Math.floor(rng.next() * 10),
    luminosityClass: lumClass,
    massKg: msol * SOLAR_MASS,
    radiusM,
    tempK,
    luminosityW,
    color: compact?.kind === 'black-hole' ? [0.02, 0.02, 0.03] : blackbodyRGB(tempK),
    ageS: ageGyr * 3.156e16,
    rotationS: compact ? rng.range(0.002, 60) : rng.range(8, 60) * 86400 * Math.pow(msol, -0.6),
    activity,
    granulation: clamp(0.004 + 0.02 / Math.max(0.2, msol), 0.002, 0.06),
    compact,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Planets
   ═══════════════════════════════════════════════════════════════════════════ */

function radiusFromPlanetMass(massEarth: number, icy: boolean): number {
  if (massEarth < 2) return EARTH_RADIUS * Math.pow(massEarth, 0.27);
  if (massEarth < 10) return EARTH_RADIUS * Math.pow(massEarth, icy ? 0.42 : 0.32);
  if (massEarth < 130) return EARTH_RADIUS * 2.2 * Math.pow(massEarth / 10, 0.35);
  // Above ~0.4 Jupiter masses, degeneracy pressure holds radius near constant.
  return JUPITER_RADIUS * clamp(Math.pow(massEarth / 318, 0.06), 0.85, 1.25);
}

function makePalette(rng: Rng, klass: PlanetClass, tempK: number, life: LifeStage): BiomePalette {
  const jitter = (c: [number, number, number], amt = 0.08): [number, number, number] => [
    saturate(c[0] * (1 + rng.range(-amt, amt))),
    saturate(c[1] * (1 + rng.range(-amt, amt))),
    saturate(c[2] * (1 + rng.range(-amt, amt))),
  ];

  // Alien vegetation is not obliged to be green. Chlorophyll happens to peak
  // where our Sun does; around a red dwarf, a different pigment wins — so
  // vegetation hue is derived from the star's colour temperature elsewhere,
  // and here we just pick a plausible family.
  const vegHue = rng.weighted([
    ['green', 5],
    ['teal', 2],
    ['amber', 2],
    ['crimson', 2],
    ['violet', 1],
    ['cyan', 1],
  ]);
  const VEG: Record<string, [number, number, number]> = {
    green: [0.11, 0.26, 0.08],
    teal: [0.06, 0.24, 0.21],
    amber: [0.32, 0.22, 0.05],
    crimson: [0.28, 0.07, 0.09],
    violet: [0.19, 0.09, 0.28],
    cyan: [0.08, 0.27, 0.30],
  };

  const base: Record<PlanetClass, BiomePalette> = {
    molten: {
      lowland: [0.10, 0.045, 0.035], highland: [0.14, 0.06, 0.04], mountain: [0.09, 0.04, 0.035],
      peak: [0.20, 0.10, 0.06], sand: [0.16, 0.08, 0.05], rock: [0.07, 0.035, 0.03],
      vegetation: [0.10, 0.04, 0.03], vegetationAlt: [0.13, 0.05, 0.03], polar: [0.12, 0.06, 0.05],
      emissive: [3.2, 0.65, 0.10], emissiveStrength: 1.0,
    },
    barren: {
      lowland: [0.20, 0.19, 0.175], highland: [0.26, 0.245, 0.225], mountain: [0.17, 0.16, 0.15],
      peak: [0.34, 0.33, 0.31], sand: [0.28, 0.26, 0.23], rock: [0.14, 0.135, 0.125],
      vegetation: [0.19, 0.18, 0.17], vegetationAlt: [0.22, 0.21, 0.19], polar: [0.42, 0.43, 0.46],
      emissive: [0, 0, 0], emissiveStrength: 0,
    },
    desert: {
      lowland: [0.42, 0.29, 0.16], highland: [0.50, 0.35, 0.19], mountain: [0.30, 0.20, 0.13],
      peak: [0.56, 0.44, 0.31], sand: [0.60, 0.44, 0.24], rock: [0.26, 0.17, 0.11],
      vegetation: [0.24, 0.22, 0.10], vegetationAlt: [0.32, 0.27, 0.12], polar: [0.62, 0.58, 0.52],
      emissive: [0, 0, 0], emissiveStrength: 0,
    },
    terran: {
      lowland: [0.13, 0.20, 0.09], highland: [0.18, 0.20, 0.11], mountain: [0.21, 0.19, 0.16],
      peak: [0.80, 0.83, 0.88], sand: [0.55, 0.48, 0.34], rock: [0.19, 0.18, 0.16],
      vegetation: VEG[vegHue], vegetationAlt: [0.16, 0.29, 0.10], polar: [0.84, 0.88, 0.93],
      emissive: [0, 0, 0], emissiveStrength: 0,
    },
    ocean: {
      lowland: [0.15, 0.23, 0.12], highland: [0.19, 0.22, 0.13], mountain: [0.22, 0.20, 0.17],
      peak: [0.75, 0.80, 0.85], sand: [0.68, 0.62, 0.46], rock: [0.18, 0.17, 0.16],
      vegetation: VEG[vegHue], vegetationAlt: [0.13, 0.28, 0.14], polar: [0.86, 0.90, 0.94],
      emissive: [0, 0, 0], emissiveStrength: 0,
    },
    tundra: {
      lowland: [0.20, 0.21, 0.15], highland: [0.24, 0.23, 0.17], mountain: [0.22, 0.21, 0.19],
      peak: [0.86, 0.89, 0.93], sand: [0.36, 0.33, 0.26], rock: [0.18, 0.18, 0.17],
      vegetation: [0.11, 0.17, 0.10], vegetationAlt: [0.20, 0.20, 0.12], polar: [0.88, 0.91, 0.95],
      emissive: [0, 0, 0], emissiveStrength: 0,
    },
    glacial: {
      lowland: [0.62, 0.70, 0.79], highland: [0.70, 0.77, 0.85], mountain: [0.52, 0.60, 0.70],
      peak: [0.92, 0.95, 0.99], sand: [0.58, 0.64, 0.72], rock: [0.30, 0.34, 0.40],
      vegetation: [0.42, 0.55, 0.62], vegetationAlt: [0.50, 0.62, 0.70], polar: [0.95, 0.97, 1.0],
      emissive: [0.05, 0.18, 0.32], emissiveStrength: 0.12,
    },
    jungle: {
      lowland: [0.07, 0.18, 0.06], highland: [0.09, 0.21, 0.07], mountain: [0.16, 0.17, 0.13],
      peak: [0.42, 0.44, 0.40], sand: [0.44, 0.38, 0.24], rock: [0.14, 0.15, 0.12],
      vegetation: VEG[vegHue], vegetationAlt: [0.05, 0.22, 0.09], polar: [0.30, 0.38, 0.30],
      emissive: [0.10, 0.60, 0.35], emissiveStrength: 0.25,
    },
    toxic: {
      lowland: [0.26, 0.24, 0.10], highland: [0.32, 0.28, 0.12], mountain: [0.20, 0.17, 0.09],
      peak: [0.40, 0.36, 0.18], sand: [0.36, 0.31, 0.14], rock: [0.17, 0.15, 0.08],
      vegetation: [0.24, 0.26, 0.08], vegetationAlt: [0.30, 0.28, 0.10], polar: [0.42, 0.40, 0.26],
      emissive: [0.45, 0.85, 0.15], emissiveStrength: 0.35,
    },
    exotic: {
      lowland: [0.16, 0.10, 0.24], highland: [0.22, 0.13, 0.30], mountain: [0.12, 0.09, 0.20],
      peak: [0.55, 0.42, 0.72], sand: [0.30, 0.22, 0.38], rock: [0.10, 0.08, 0.16],
      vegetation: [0.34, 0.10, 0.42], vegetationAlt: [0.18, 0.28, 0.48], polar: [0.70, 0.72, 0.90],
      emissive: [0.55, 0.25, 1.6], emissiveStrength: 0.75,
    },
    'gas-giant': {
      lowland: [0.52, 0.42, 0.32], highland: [0.62, 0.52, 0.40], mountain: [0.42, 0.34, 0.26],
      peak: [0.72, 0.64, 0.52], sand: [0.58, 0.48, 0.36], rock: [0.36, 0.30, 0.24],
      vegetation: [0.5, 0.42, 0.34], vegetationAlt: [0.44, 0.36, 0.30], polar: [0.46, 0.50, 0.58],
      emissive: [0, 0, 0], emissiveStrength: 0,
    },
    'ice-giant': {
      lowland: [0.18, 0.34, 0.52], highland: [0.24, 0.42, 0.62], mountain: [0.14, 0.28, 0.44],
      peak: [0.36, 0.56, 0.74], sand: [0.22, 0.38, 0.56], rock: [0.12, 0.24, 0.38],
      vegetation: [0.2, 0.36, 0.54], vegetationAlt: [0.16, 0.32, 0.50], polar: [0.40, 0.60, 0.78],
      emissive: [0, 0, 0], emissiveStrength: 0,
    },
  };

  const p = base[klass];
  const out: BiomePalette = {
    lowland: jitter(p.lowland),
    highland: jitter(p.highland),
    mountain: jitter(p.mountain),
    peak: jitter(p.peak, 0.04),
    sand: jitter(p.sand),
    rock: jitter(p.rock),
    vegetation: jitter(p.vegetation, 0.14),
    vegetationAlt: jitter(p.vegetationAlt, 0.14),
    polar: jitter(p.polar, 0.03),
    emissive: p.emissive,
    emissiveStrength: p.emissiveStrength,
  };

  // Bioluminescence: worlds with life and long nights glow.
  if ((life === 'fauna' || life === 'sapient' || life === 'post-sapient') && rng.chance(0.35)) {
    out.emissive = [rng.range(0.1, 0.9), rng.range(0.4, 1.6), rng.range(0.5, 1.8)];
    out.emissiveStrength = Math.max(out.emissiveStrength, rng.range(0.2, 0.7));
  }
  return out;
}

function makeAtmosphere(rng: Rng, klass: PlanetClass, radiusM: number, gravity: number, tempK: number): AtmosphereSpec {
  const none: AtmosphereSpec = {
    present: false, surfacePressurePa: 0, scaleHeightM: 1, thicknessM: 1,
    rayleigh: [0, 0, 0], mie: 0, mieG: 0.76, absorption: [0, 0, 0],
    fogDensity: 0, windSpeed: 0, tint: [0, 0, 0],
  };
  if (klass === 'barren') return rng.chance(0.85) ? none : { ...none, present: true, surfacePressurePa: rng.range(1, 900) };

  const thick = rng.weighted<'thin' | 'earthlike' | 'thick' | 'crushing'>([
    ['thin', klass === 'desert' || klass === 'glacial' ? 4 : 2],
    ['earthlike', klass === 'terran' || klass === 'ocean' || klass === 'jungle' ? 6 : 2],
    ['thick', klass === 'toxic' || klass === 'gas-giant' ? 5 : 1],
    ['crushing', klass === 'toxic' ? 3 : 0.2],
  ]);
  const pressure =
    thick === 'thin' ? rng.range(2e3, 3e4)
    : thick === 'earthlike' ? rng.range(5e4, 1.6e5)
    : thick === 'thick' ? rng.range(2e5, 1.2e6)
    : rng.range(2e6, 1e7);

  // Scale height H = kT/(mg): hot, light, low-gravity atmospheres are puffy.
  const meanMolarMass = rng.range(0.016, 0.05); // kg/mol
  const scaleHeight = clamp((8.314 * Math.max(80, tempK)) / (meanMolarMass * Math.max(0.5, gravity)), 2e3, 9e4);
  const thickness = clamp(scaleHeight * 8.5, 1e4, radiusM * 0.35);

  // Rayleigh coefficients scale as λ⁻⁴; the ratio here is Earth's, scaled by
  // density and shifted by composition so alien skies are not all blue.
  const density = pressure / 101325;
  const hueShift = rng.range(-1, 1);
  const baseR = 5.802e-6;
  const baseG = 13.558e-6;
  const baseB = 33.1e-6;
  const rayleigh: [number, number, number] = [
    baseR * density * (1 + hueShift * 0.85),
    baseG * density * (1 + hueShift * 0.2),
    baseB * density * (1 - hueShift * 0.55),
  ];

  const mie = clamp(3.996e-6 * density * rng.range(0.4, 6), 1e-7, 8e-5);
  const absorption: [number, number, number] = [
    0.65e-6 * density * rng.range(0, 2),
    1.881e-6 * density * rng.range(0.2, 1.8),
    0.085e-6 * density * rng.range(0, 3),
  ];

  const tint: [number, number, number] = [
    saturate(rayleigh[0] / (baseB * Math.max(0.2, density)) + 0.05),
    saturate(rayleigh[1] / (baseB * Math.max(0.2, density)) + 0.05),
    saturate(rayleigh[2] / (baseB * Math.max(0.2, density)) + 0.05),
  ];

  return {
    present: true,
    surfacePressurePa: pressure,
    scaleHeightM: scaleHeight,
    thicknessM: thickness,
    rayleigh,
    mie,
    mieG: rng.range(0.6, 0.86),
    absorption,
    fogDensity: clamp(density * rng.range(0.2, 1.6), 0.01, 3),
    windSpeed: rng.range(1, 26) * (thick === 'crushing' ? 2.2 : 1),
    tint,
  };
}

function makeOcean(rng: Rng, klass: PlanetClass, tempK: number, atmo: AtmosphereSpec): OceanSpec {
  const dry: OceanSpec = {
    present: false, level: 0, shallow: [0, 0, 0], deep: [0, 0, 0],
    waveHeightM: 0, fluid: 'water', iceCoverage: 0,
  };
  const canHoldLiquid = atmo.present && atmo.surfacePressurePa > 6e3;
  if (!canHoldLiquid) return dry;

  let fluid: OceanSpec['fluid'] = 'water';
  if (tempK > 1200) fluid = 'lava';
  else if (tempK > 620) fluid = 'mercury';
  else if (tempK < 95) fluid = 'methane';
  else if (tempK < 200) fluid = 'ammonia';
  else if (klass === 'toxic') fluid = 'hydrocarbon';

  const chance =
    klass === 'ocean' ? 1
    : klass === 'terran' || klass === 'jungle' ? 0.95
    : klass === 'tundra' ? 0.7
    : klass === 'glacial' ? 0.6
    : klass === 'molten' ? 0.85
    : klass === 'toxic' ? 0.5
    : klass === 'desert' ? 0.22
    : 0.1;
  if (!rng.chance(chance)) return dry;

  const COLORS: Record<OceanSpec['fluid'], { s: [number, number, number]; d: [number, number, number] }> = {
    water: { s: [0.09, 0.36, 0.42], d: [0.004, 0.028, 0.075] },
    methane: { s: [0.16, 0.20, 0.14], d: [0.02, 0.03, 0.02] },
    ammonia: { s: [0.22, 0.26, 0.20], d: [0.03, 0.05, 0.04] },
    lava: { s: [2.4, 0.55, 0.08], d: [0.9, 0.12, 0.02] },
    mercury: { s: [0.35, 0.36, 0.40], d: [0.10, 0.11, 0.13] },
    hydrocarbon: { s: [0.20, 0.17, 0.07], d: [0.045, 0.035, 0.012] },
  };
  const c = COLORS[fluid];
  const tealShift = rng.range(-0.35, 0.5);

  return {
    present: true,
    level: rng.range(klass === 'ocean' ? 0.62 : 0.28, klass === 'ocean' ? 0.86 : 0.58),
    shallow: [saturate(c.s[0] * (1 - tealShift * 0.4)), saturate(c.s[1] * (1 + tealShift * 0.15)), saturate(c.s[2] * (1 + tealShift * 0.3))],
    deep: c.d,
    waveHeightM: rng.range(0.4, 4.5) * clamp(atmo.windSpeed / 10, 0.3, 2.4),
    fluid,
    iceCoverage: tempK < 275 ? saturate((278 - tempK) / 70 + rng.range(-0.1, 0.15)) : rng.range(0, 0.08),
  };
}

function makeTerrain(rng: Rng, klass: PlanetClass, radiusM: number, gravity: number, atmo: AtmosphereSpec): TerrainSpec {
  // Mountains are limited by gravity: rock has a crush strength, so a bigger
  // world has proportionally flatter terrain. Olympus Mons is 22 km tall
  // because Mars pulls at 3.7 m/s²; on a 3g world nothing like it survives.
  const reliefScale = clamp(9.81 / Math.max(1.2, gravity), 0.25, 3.2);
  const maxElev = clamp(radiusM * rng.range(0.0012, 0.006) * reliefScale, 900, 42000);

  const airless = !atmo.present || atmo.surfacePressurePa < 5e3;
  return {
    maxElevationM: maxElev,
    continentFreq: rng.range(0.7, 2.4),
    landFraction: klass === 'ocean' ? rng.range(0.06, 0.24) : klass === 'desert' || klass === 'barren' ? rng.range(0.78, 0.98) : rng.range(0.26, 0.62),
    ridgeFreq: rng.range(2.0, 7.5),
    ridgeStrength: rng.range(0.35, 0.95),
    erosion: airless ? rng.range(0, 0.12) : rng.range(0.35, 0.95),
    craterDensity: airless ? rng.range(0.45, 1.0) : rng.range(0, 0.18),
    duneCoverage: klass === 'desert' ? rng.range(0.35, 0.85) : klass === 'barren' ? rng.range(0, 0.3) : rng.range(0, 0.15),
    plates: rng.int(5, 22),
    volcanism: klass === 'molten' ? rng.range(0.7, 1) : rng.range(0, 0.45),
    domainWarp: rng.range(0.15, 0.85),
  };
}

function makeRings(rng: Rng, radiusM: number, massKg: number, klass: PlanetClass): RingSpec {
  const p = klass === 'gas-giant' ? 0.55 : klass === 'ice-giant' ? 0.45 : 0.06;
  if (!rng.chance(p)) {
    return { present: false, innerRadiusM: 0, outerRadiusM: 0, opacity: 0, color: [0, 0, 0], gaps: 0, tilt: 0 };
  }
  // Rings live inside the Roche limit, where tides shred any moon that forms.
  const roche = radiusM * 2.44 * Math.pow(1.0, 1 / 3);
  const inner = radiusM * rng.range(1.25, 1.7);
  const outer = Math.min(roche * rng.range(0.9, 1.35), inner * rng.range(1.6, 3.4));
  const warm = rng.range(0, 1);
  return {
    present: true,
    innerRadiusM: inner,
    outerRadiusM: outer,
    opacity: rng.range(0.25, 0.92),
    color: [lerp(0.55, 0.85, warm), lerp(0.52, 0.74, warm), lerp(0.58, 0.55, warm)],
    gaps: rng.int(1, 5),
    tilt: rng.range(-0.06, 0.06),
  };
}

function makeCivilization(rng: Rng, life: LifeStage, pos: [number, number, number], klass: PlanetClass): CivilizationSpec {
  const absent: CivilizationSpec = {
    present: false, name: '', techLevel: 0, population: 0, cityCount: 0,
    style: 'ruins', structure: [0, 0, 0], neon: [0, 0, 0], orbital: 0, decay: 0,
  };
  if (life !== 'sapient' && life !== 'post-sapient') return absent;

  const dead = life === 'post-sapient';
  const tech = dead ? rng.range(0.4, 0.95) : rng.range(0.15, 0.98);
  const style = rng.weighted<CivilizationSpec['style']>([
    ['brutalist', 3], ['organic', 3], ['crystalline', 2], ['arcology', 3],
    ['nomadic', 1.5], ['hive', 2], ['baroque', 1.5], ['ruins', dead ? 6 : 0.2],
  ]);

  // Structural palettes chosen to read at a distance and at night.
  const STRUCT: Record<CivilizationSpec['style'], [number, number, number]> = {
    brutalist: [0.30, 0.30, 0.32],
    organic: [0.34, 0.30, 0.24],
    crystalline: [0.42, 0.48, 0.58],
    arcology: [0.24, 0.26, 0.30],
    nomadic: [0.38, 0.32, 0.24],
    hive: [0.26, 0.22, 0.18],
    baroque: [0.52, 0.46, 0.36],
    ruins: [0.24, 0.23, 0.21],
  };
  const NEON: [number, number, number][] = [
    [0.15, 1.6, 2.4], // cyan
    [2.4, 0.55, 1.5], // magenta
    [2.2, 1.3, 0.25], // amber
    [0.35, 2.2, 1.0], // mint
    [1.4, 0.35, 2.4], // violet
    [2.6, 0.9, 0.35], // sodium
  ];

  return {
    present: true,
    name: civilizationName(rng, pos),
    techLevel: tech,
    population: Math.floor(Math.pow(10, rng.range(5, 11)) * (dead ? 0.001 : 1)),
    cityCount: dead ? rng.int(2, 9) : Math.max(1, Math.round(rng.range(3, 26) * tech)),
    style,
    structure: STRUCT[style],
    neon: rng.pick(NEON),
    orbital: dead ? rng.range(0, 0.3) : saturate(tech * rng.range(0.4, 1.4)),
    decay: dead ? rng.range(0.55, 0.98) : rng.range(0, 0.2),
  };
}

const NOTE_POOL: Record<string, string[]> = {
  molten: ['Surface renews on a geological heartbeat.', 'Silicate rain falls on the nightside.', 'Tidal flexing keeps the mantle liquid.'],
  barren: ['No atmosphere. Every impact since formation is still visible.', 'Regolith undisturbed for four billion years.', 'Temperature swings 300 K between day and night.'],
  desert: ['Wind has been the only sculptor here for an age.', 'Subsurface aquifers detected at depth.', 'Dust storms envelop the planet seasonally.'],
  terran: ['Liquid water, breathable partial pressure, magnetic shielding.', 'Seasonal albedo variation consistent with vegetation.', 'Oxygen present in disequilibrium — something is making it.'],
  ocean: ['Land is a rumour here.', 'Thermohaline circulation drives a global current.', 'Abyssal vents host chemosynthetic communities.'],
  tundra: ['Permafrost holds an archive of the last ten million years.', 'Growing season measured in weeks.', 'Aurora visible from most latitudes.'],
  glacial: ['Ice sheet kilometres thick. A liquid ocean beneath.', 'Cryovolcanism resurfaces the southern hemisphere.', 'Sublimation haze at the terminator.'],
  jungle: ['Canopy so dense the forest floor has never seen direct light.', 'Biomass density exceeds survey instrumentation limits.', 'Rainfall is effectively continuous.'],
  toxic: ['Atmosphere would dissolve an unshielded hull in hours.', 'Sulphuric precipitation never reaches the ground.', 'Surface visibility under two hundred metres.'],
  exotic: ['Chemistry here has no analogue in the survey catalogue.', 'Crystalline structures show signs of slow growth.', 'The rocks are, in some defensible sense, thinking.'],
  'gas-giant': ['No surface. Pressure gradient continues to a metallic core.', 'Storm systems older than recorded history.', 'Auroral ovals brighter than any world in the catalogue.'],
  'ice-giant': ['Supersonic winds in the upper cloud deck.', 'Diamond precipitation likely at depth.', 'Magnetic field wildly offset from the rotation axis.'],
};

function makePlanet(
  rng: Rng,
  star: StarSpec,
  index: number,
  semiMajorM: number,
  systemName: string,
  systemPos: [number, number, number],
  iceLineM: number,
  isMoon = false
): PlanetSpec {
  const seed = rng.int(0, 2 ** 30);
  const beyondIceLine = semiMajorM > iceLineM;

  // Mass: rocky inside the ice line, giants outside — with exceptions, because
  // hot Jupiters migrate inward and the universe likes to break its own rules.
  let massEarth: number;
  let klass: PlanetClass;
  const migrated = !beyondIceLine && rng.chance(0.07);
  if (isMoon) {
    massEarth = rng.powerLaw(0.0001, 0.2, -1.6);
  } else if (beyondIceLine || migrated) {
    massEarth = rng.chance(0.55) ? rng.range(60, 3000) : rng.range(6, 60);
  } else {
    massEarth = rng.powerLaw(0.02, 12, -1.1);
  }

  const icy = beyondIceLine;
  const radiusM = radiusFromPlanetMass(massEarth, icy);
  const massKg = massEarth * EARTH_MASS;
  const gravity = (G * massKg) / (radiusM * radiusM);

  // Equilibrium temperature, then a greenhouse bump once we know the air.
  const albedo0 = rng.range(0.08, 0.55);
  const flux = star.luminosityW / (4 * Math.PI * semiMajorM * semiMajorM);
  const tEq = Math.pow((flux * (1 - albedo0)) / (4 * 5.670374419e-8), 0.25);

  if (massEarth > 130) klass = 'gas-giant';
  else if (massEarth > 14 && beyondIceLine) klass = 'ice-giant';
  else if (tEq > 1100) klass = 'molten';
  else if (massEarth < 0.08 || (tEq > 700 && rng.chance(0.6))) klass = 'barren';
  else {
    // The interesting band. Bias generously toward habitable outcomes.
    const roll = rng.next();
    if (tEq > 400) klass = roll < 0.55 ? 'toxic' : 'desert';
    else if (tEq > 310) klass = roll < 0.5 ? 'desert' : roll < 0.78 ? 'toxic' : 'jungle';
    else if (tEq > 268) klass = roll < 0.34 ? 'terran' : roll < 0.55 ? 'ocean' : roll < 0.72 ? 'jungle' : roll < 0.88 ? 'desert' : 'exotic';
    else if (tEq > 220) klass = roll < 0.42 ? 'tundra' : roll < 0.62 ? 'terran' : roll < 0.8 ? 'glacial' : 'barren';
    else if (tEq > 120) klass = roll < 0.6 ? 'glacial' : roll < 0.82 ? 'tundra' : 'barren';
    else klass = roll < 0.8 ? 'glacial' : 'exotic';
    if (rng.chance(0.035)) klass = 'exotic';
  }

  const atmosphere = makeAtmosphere(rng, klass, radiusM, gravity, tEq);
  // Greenhouse forcing: thick CO₂-analogue atmospheres trap a lot of heat.
  const greenhouse = atmosphere.present ? Math.pow(atmosphere.surfacePressurePa / 101325, 0.28) * rng.range(8, 42) : 0;
  const tempK = tEq + greenhouse;

  const magnetosphere = saturate(
    (massEarth > 0.4 ? 0.5 : 0.05) * rng.range(0.4, 1.8) * (klass === 'gas-giant' || klass === 'ice-giant' ? 2.2 : 1)
  );

  // Life needs liquid, shielding, and time. Then it needs luck.
  const ageGyr = star.ageS / 3.156e16;
  const habitable = tempK > 250 && tempK < 340 && atmosphere.present && atmosphere.surfacePressurePa > 2e4;
  let life: LifeStage = 'none';
  if (habitable) {
    const p = saturate((ageGyr - 0.6) / 4) * (0.35 + magnetosphere * 0.65);
    const r = rng.next();
    if (r < p * 0.95) life = 'microbial';
    if (r < p * 0.72) life = 'flora';
    if (r < p * 0.5) life = 'fauna';
    if (r < p * 0.17) life = 'sapient';
    if (r < p * 0.035) life = 'post-sapient';
  } else if ((klass === 'exotic' || klass === 'toxic' || klass === 'glacial') && rng.chance(0.07)) {
    life = rng.chance(0.6) ? 'microbial' : 'flora';
  }

  const ocean = makeOcean(rng, klass, tempK, atmosphere);
  const terrain = makeTerrain(rng, klass, radiusM, gravity, atmosphere);
  const palette = makePalette(rng, klass, tempK, life);
  const rings = isMoon
    ? { present: false, innerRadiusM: 0, outerRadiusM: 0, opacity: 0, color: [0, 0, 0] as [number, number, number], gaps: 0, tilt: 0 }
    : makeRings(rng, radiusM, massKg, klass);
  const civilization = makeCivilization(rng, life, systemPos, klass);

  const periodS = 2 * Math.PI * Math.sqrt(Math.pow(semiMajorM, 3) / (G * star.massKg));
  // Tidal locking timescale ∝ a⁶; close-in worlds always end up locked.
  const tidallyLocked = semiMajorM < 0.12 * AU * Math.pow(star.massKg / SOLAR_MASS, 0.4) || (isMoon && rng.chance(0.85));

  const orbit: OrbitElements = {
    a: semiMajorM,
    e: rng.chance(0.7) ? rng.range(0, 0.08) : rng.range(0.08, 0.42),
    i: rng.normal(0, 0.035),
    raan: rng.range(0, Math.PI * 2),
    argP: rng.range(0, Math.PI * 2),
    m0: rng.range(0, Math.PI * 2),
    periodS,
    primaryMassKg: star.massKg,
  };

  const name = rng.chance(0.3) ? planetProperName(rng, systemPos) : planetDesignation(systemName, index);

  const notes: string[] = [];
  const pool = NOTE_POOL[klass] ?? [];
  if (pool.length) notes.push(rng.pick(pool));
  if (life === 'sapient') notes.push('Artificial illumination detected on the nightside.');
  if (life === 'post-sapient') notes.push('Structures present. No active signals. No one is answering.');
  if (rings.present) notes.push('Ring system: debris of a moon that came too close.');
  if (tidallyLocked) notes.push('Tidally locked. One face in permanent day, one in permanent night.');
  if (magnetosphere > 0.7 && atmosphere.present) notes.push('Strong magnetosphere — persistent auroral display.');

  const notable =
    life === 'sapient' || life === 'post-sapient' || klass === 'terran' || klass === 'exotic' || rings.present || life === 'fauna';

  return {
    seed,
    name,
    designation: planetDesignation(systemName, index),
    klass,
    index,
    radiusM,
    massKg,
    gravity,
    rotationS: tidallyLocked ? periodS : rng.range(6, 90) * 3600 * (rng.chance(0.04) ? -1 : 1),
    axialTiltRad: rng.chance(0.12) ? rng.range(0.6, 1.9) : Math.abs(rng.normal(0.4, 0.22)),
    rotationPhase: rng.range(0, Math.PI * 2),
    tempK,
    magnetosphere,
    albedo: albedo0,
    tidallyLocked,
    orbit,
    atmosphere,
    ocean,
    terrain,
    palette,
    rings,
    life,
    biodiversity: life === 'none' ? 0 : saturate(rng.range(0.15, 1) * (life === 'fauna' || life === 'sapient' ? 1 : 0.5)),
    civilization,
    moons: [],
    notes,
    notable,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Systems
   ═══════════════════════════════════════════════════════════════════════════ */

export function makeSystem(seed: number, position: [number, number, number]): StarSystemSpec {
  const rng = new Rng(seed);
  const name = starName(rng.fork('name'), position);

  // Roughly half of all stars are in multiples. Keep it to three for sanity.
  const multiplicity = rng.weighted([
    [1, 5.5],
    [2, 3.2],
    [3, 0.9],
  ]);

  const stars: StarSpec[] = [];
  const separationsM: number[] = [];
  const primary = makeStar(rng.fork('star0'), position);
  stars.push(primary);
  for (let i = 1; i < multiplicity; i++) {
    const companion = makeStar(rng.fork(`star${i}`), position, rng.range(0.08, 1) * (primary.massKg / SOLAR_MASS));
    stars.push(companion);
    separationsM.push(rng.powerLaw(0.05 * AU, 900 * AU, -1.1));
  }

  const metallicity = saturate(rng.normal(0.5, 0.22));
  // Metal-poor stars build fewer planets: there is less rock to build them of.
  const planetCount = Math.max(0, Math.round(rng.range(0, 9) * (0.35 + metallicity)));

  const lsol = primary.luminosityW / SOLAR_LUMINOSITY;
  // Ice line: where water condenses. Scales as √L.
  const iceLineM = 2.7 * AU * Math.sqrt(Math.max(1e-4, lsol));

  const planets: PlanetSpec[] = [];
  // Orbital spacing follows a noisy geometric progression — the real thing
  // (Titius–Bode) is a coincidence, but dynamically packed systems do end up
  // roughly geometric because anything else is unstable.
  let a = rng.range(0.04, 0.55) * AU * Math.pow(Math.max(0.1, lsol), 0.4);
  for (let i = 0; i < planetCount; i++) {
    const p = makePlanet(rng.fork(`planet${i}`), primary, i, a, name, position, iceLineM);
    // Moons: only worlds with a decent Hill sphere keep them.
    const hillRadius = a * Math.pow(p.massKg / (3 * primary.massKg), 1 / 3);
    const maxMoons = p.klass === 'gas-giant' ? 8 : p.klass === 'ice-giant' ? 6 : p.massKg > 0.3 * EARTH_MASS ? 3 : 1;
    const moonCount = rng.int(0, maxMoons);
    const moonRng = rng.fork(`moons${i}`);
    let ma = p.radiusM * rng.range(2.6, 6);
    for (let m = 0; m < moonCount && ma < hillRadius * 0.45; m++) {
      const moonBase = makePlanet(moonRng.fork(`m${m}`), primary, m, Math.max(a, iceLineM * 0.6), name, position, iceLineM, true);
      const moonPeriod = 2 * Math.PI * Math.sqrt(Math.pow(ma, 3) / (G * p.massKg));
      const moon: MoonSpec = {
        ...moonBase,
        parentIndex: i,
        name: moonDesignation(p.name, m),
        designation: moonDesignation(p.designation, m),
        orbit: { ...moonBase.orbit, a: ma, periodS: moonPeriod, primaryMassKg: p.massKg, e: moonRng.range(0, 0.05) },
        rotationS: moonPeriod, // moons lock fast
        tidallyLocked: true,
      };
      p.moons.push(moon);
      ma *= moonRng.range(1.5, 2.6);
    }
    planets.push(p);
    a *= rng.range(1.4, 2.3);
    if (a > 260 * AU) break;
  }

  const belts: AsteroidBeltSpec[] = [];
  if (planets.length >= 2 && rng.chance(0.62)) {
    const gapIdx = rng.int(0, planets.length - 2);
    const inner = planets[gapIdx].orbit.a * 1.25;
    const outer = planets[gapIdx + 1].orbit.a * 0.78;
    if (outer > inner * 1.15) {
      belts.push({
        present: true,
        innerM: inner,
        outerM: outer,
        count: rng.int(1200, 9000),
        spread: rng.range(0.02, 0.22),
        color: [rng.range(0.25, 0.5), rng.range(0.22, 0.44), rng.range(0.2, 0.4)],
      });
    }
  }

  let totalMassKg = 0;
  for (const s of stars) totalMassKg += s.massKg;
  for (const p of planets) totalMassKg += p.massKg;

  const notable = planets.some((p) => p.notable) || !!primary.compact || stars.length > 2;

  return { seed, name, position, stars, separationsM, planets, belts, totalMassKg, notable, metallicity };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Galaxies
   ═══════════════════════════════════════════════════════════════════════════ */

function makeNebulae(rng: Rng, radiusLy: number, count: number): NebulaSpec[] {
  const out: NebulaSpec[] = [];
  const KINDS: NebulaSpec['kind'][] = ['emission', 'reflection', 'dark', 'planetary', 'supernova-remnant'];
  for (let i = 0; i < count; i++) {
    const kind = rng.weighted<NebulaSpec['kind']>([
      ['emission', 4], ['reflection', 2], ['dark', 2], ['planetary', 1], ['supernova-remnant', 1.2],
    ]);
    const r = radiusLy * Math.sqrt(rng.next()) * 0.9;
    const th = rng.range(0, Math.PI * 2);
    // Hydrogen-alpha reds, oxygen-III teals, sulphur golds: the real palette
    // of a nebula, which is also, conveniently, a gorgeous one.
    const PAL: Record<NebulaSpec['kind'], [[number, number, number], [number, number, number]]> = {
      emission: [[2.4, 0.42, 0.55], [0.25, 1.1, 1.5]],
      reflection: [[0.35, 0.75, 2.2], [0.9, 1.0, 1.8]],
      dark: [[0.10, 0.08, 0.09], [0.18, 0.14, 0.13]],
      planetary: [[0.30, 1.9, 1.6], [1.8, 0.55, 1.4]],
      'supernova-remnant': [[2.0, 1.3, 0.35], [0.35, 0.9, 2.1]],
    };
    const [a, b] = PAL[kind];
    out.push({
      seed: rng.int(0, 2 ** 30),
      name: nebulaName(rng),
      kind,
      position: [Math.cos(th) * r, rng.normal(0, radiusLy * 0.02), Math.sin(th) * r],
      radiusLy: rng.range(8, 260) * (kind === 'planetary' ? 0.15 : 1),
      colorA: a,
      colorB: b,
      density: rng.range(0.25, 1),
      turbulence: rng.range(0.4, 2.2),
    });
  }
  return out;
}

export function makeGalaxy(seed: number, position: [number, number, number]): GalaxySpec {
  const rng = new Rng(seed);
  const type = rng.weighted<GalaxyType>([
    ['spiral', 4], ['barred-spiral', 4], ['elliptical', 2],
    ['lenticular', 1], ['irregular', 1.5], ['dwarf', 2], ['ring', 0.4],
  ]);

  const isDisc = type === 'spiral' || type === 'barred-spiral' || type === 'lenticular' || type === 'ring';
  const radiusLy =
    type === 'dwarf' ? rng.range(3000, 18000)
    : type === 'elliptical' ? rng.range(30000, 180000)
    : rng.range(28000, 120000);

  const starCount = Math.floor(rng.range(2e9, 5e11) * (type === 'dwarf' ? 0.01 : 1));
  const sfr = type === 'elliptical' || type === 'lenticular' ? rng.range(0.001, 0.4) : rng.range(0.4, 22);

  // Star formation makes a galaxy blue; its absence leaves the old red giants.
  const youth = saturate(sfr / 12);
  const armColor: [number, number, number] = [lerp(1.0, 0.62, youth), lerp(0.86, 0.78, youth), lerp(0.6, 1.3, youth)];
  const coreColor: [number, number, number] = [1.25, 0.95, 0.62];

  const n = rng.onSphere();
  const smbh = Math.pow(10, rng.range(6, 9.6)) * SOLAR_MASS;

  return {
    seed,
    name: galaxyName(rng),
    type,
    position,
    radiusLy,
    thicknessLy: isDisc ? radiusLy * rng.range(0.008, 0.03) : radiusLy * rng.range(0.35, 0.8),
    starCount,
    arms: type === 'barred-spiral' ? rng.int(2, 4) : type === 'spiral' ? rng.int(2, 6) : 0,
    armPitch: rng.range(0.16, 0.42),
    barFraction: type === 'barred-spiral' ? rng.range(0.18, 0.42) : 0,
    bulgeFraction: type === 'elliptical' ? 1 : rng.range(0.05, 0.22),
    angularVel: rng.range(0.6, 2.4) * 1e-15,
    normal: [n.x, n.y, n.z],
    armColor,
    coreColor,
    dustColor: [0.32, 0.19, 0.12],
    redshift: 0,
    smbhMassKg: smbh,
    agn: rng.chance(0.08) ? rng.range(0.3, 1) : rng.range(0, 0.05),
    nebulae: makeNebulae(rng.fork('neb'), radiusLy, isDisc ? rng.int(14, 40) : rng.int(2, 8)),
    sfr,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The universe object — lazy, cached, deterministic
   ═══════════════════════════════════════════════════════════════════════════ */

export class Universe {
  readonly seed: number;
  /** Cosmic time since the Big Bang, in seconds. Advances with the sim. */
  cosmicTimeS = 13.8e9 * 3.156e7;
  /** Scale factor a(t), normalised to 1 today. */
  scaleFactor = 1;

  private systemCache = new Map<string, StarSystemSpec>();
  private galaxyCache = new Map<string, GalaxySpec>();
  private cacheOrder: string[] = [];
  private maxCache = 256;

  constructor(seed: number | string = 'AEON') {
    this.seed = typeof seed === 'string' ? new Rng(seed).int(0, 2 ** 30) : seed;
  }

  /**
   * Star systems live on a jittered lattice. Each cell of side `CELL_LY` may
   * contain a star; whether it does, and where exactly, is a hash of the cell.
   * This gives an unbounded starfield with O(1) lookup and no storage.
   */
  static readonly CELL_LY = 6.5;

  systemAt(ix: number, iy: number, iz: number): StarSystemSpec | null {
    const key = `s${ix},${iy},${iz}`;
    const hit = this.systemCache.get(key);
    if (hit) return hit;

    const h = hashCombine(this.seed, ix, iy, iz, 0x5f3a);
    // Density falls off away from the galactic plane and outward from centre.
    const r = Math.sqrt(ix * ix + iz * iz) * Universe.CELL_LY;
    const y = Math.abs(iy) * Universe.CELL_LY;
    const discFalloff = Math.exp(-r / 9000) * Math.exp(-y / 700);
    const p = 0.42 * clamp(discFalloff * 4 + 0.02, 0.01, 1);
    if (h / 4294967296 > p) return null;

    const jr = new Rng(h);
    const pos: [number, number, number] = [
      (ix + jr.range(0.12, 0.88)) * Universe.CELL_LY,
      (iy + jr.range(0.12, 0.88)) * Universe.CELL_LY,
      (iz + jr.range(0.12, 0.88)) * Universe.CELL_LY,
    ];
    const sys = makeSystem(h, pos);
    this.remember(key, sys, this.systemCache);
    return sys;
  }

  /** All systems whose cells intersect a sphere, for local starfield rendering. */
  systemsNear(cx: number, cy: number, cz: number, radiusLy: number): StarSystemSpec[] {
    const c = Universe.CELL_LY;
    const r = Math.ceil(radiusLy / c);
    const bx = Math.floor(cx / c);
    const by = Math.floor(cy / c);
    const bz = Math.floor(cz / c);
    const out: StarSystemSpec[] = [];
    const r2 = radiusLy * radiusLy;
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const s = this.systemAt(bx + dx, by + dy, bz + dz);
          if (!s) continue;
          const ex = s.position[0] - cx;
          const ey = s.position[1] - cy;
          const ez = s.position[2] - cz;
          if (ex * ex + ey * ey + ez * ez <= r2) out.push(s);
        }
      }
    }
    return out;
  }

  galaxyAt(ix: number, iy: number, iz: number): GalaxySpec | null {
    const key = `g${ix},${iy},${iz}`;
    const hit = this.galaxyCache.get(key);
    if (hit) return hit;
    const h = hashCombine(this.seed, ix, iy, iz, 0x9e11);
    if (h / 4294967296 > 0.35) return null;
    const jr = new Rng(h);
    const pos: [number, number, number] = [ix + jr.next(), iy + jr.next(), iz + jr.next()];
    const g = makeGalaxy(h, pos);
    this.remember(key, g, this.galaxyCache);
    return g;
  }

  private remember<T>(key: string, val: T, cache: Map<string, T>): void {
    cache.set(key, val);
    this.cacheOrder.push(key);
    if (this.cacheOrder.length > this.maxCache) {
      const old = this.cacheOrder.shift()!;
      this.systemCache.delete(old);
      this.galaxyCache.delete(old);
    }
  }

  /**
   * Find a system worth starting in: a G/K star with a terran world, no more
   * than a few hundred light years out. The opening shot has to land.
   */
  findHomeSystem(maxSearch = 6000): StarSystemSpec {
    let best: StarSystemSpec | null = null;
    let bestScore = -Infinity;
    const rng = new Rng(this.seed ^ 0x1234);
    for (let i = 0; i < maxSearch; i++) {
      const ix = rng.int(-40, 40);
      const iy = rng.int(-6, 6);
      const iz = rng.int(-40, 40);
      const s = this.systemAt(ix, iy, iz);
      if (!s) continue;
      let score = 0;
      const st = s.stars[0];
      if (st.spectral === 'G' || st.spectral === 'K') score += 4;
      if (st.spectral === 'F' || st.spectral === 'M') score += 1.5;
      if (st.compact) score -= 6;
      for (const p of s.planets) {
        if (p.klass === 'terran') score += 6;
        if (p.klass === 'ocean' || p.klass === 'jungle') score += 4;
        if (p.life === 'sapient') score += 5;
        if (p.life === 'fauna') score += 3;
        if (p.rings.present) score += 2;
        if (p.moons.length) score += p.moons.length * 0.6;
      }
      score += s.planets.length * 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
      if (bestScore > 22) break;
    }
    return best ?? makeSystem(hashCombine(this.seed, 1), [0, 0, 0]);
  }
}

export { makePlanet };
export const universe = new Universe('AEON');
