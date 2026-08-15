/**
 * The shared vocabulary of ÆON.
 *
 * Every renderer, simulation and gameplay system in the project speaks in these
 * types. Nothing here is stored on disk — a `PlanetSpec` is *derived* from a
 * seed the instant someone looks at it, and thrown away when they leave. Two
 * players given the same seed a year apart see the same rock in the same
 * riverbed.
 *
 * Units are SI unless the field name says otherwise. Distances in metres,
 * masses in kilograms, times in seconds, temperatures in kelvin. Astronomical
 * units appear only in the constants below.
 */

/* ═══════════════════════════════════════════════════════════════════════════
   Physical constants
   ═══════════════════════════════════════════════════════════════════════════ */

export const AU = 1.495978707e11; // m
export const LY = 9.4607304725808e15; // m
export const PC = 3.0856775814913673e16; // m
export const MPC = PC * 1e6;
export const G = 6.6743e-11; // m³ kg⁻¹ s⁻²
export const SOLAR_MASS = 1.98847e30; // kg
export const SOLAR_RADIUS = 6.957e8; // m
export const SOLAR_LUMINOSITY = 3.828e26; // W
export const EARTH_MASS = 5.9722e24; // kg
export const EARTH_RADIUS = 6.371e6; // m
export const JUPITER_MASS = 1.898e27;
export const JUPITER_RADIUS = 6.9911e7;
export const STEFAN_BOLTZMANN = 5.670374419e-8;
export const HUBBLE_CONSTANT = 67.4; // km s⁻¹ Mpc⁻¹
export const SPEED_OF_LIGHT = 2.99792458e8;

/* ═══════════════════════════════════════════════════════════════════════════
   Stars
   ═══════════════════════════════════════════════════════════════════════════ */

export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M' | 'L' | 'T' | 'D' | 'NS' | 'BH' | 'WR';

export interface StarSpec {
  seed: number;
  name: string;
  spectral: SpectralClass;
  /** Sub-class digit, 0–9 (e.g. G2 for the Sun). */
  subclass: number;
  luminosityClass: 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI' | 'VII';
  massKg: number;
  radiusM: number;
  /** Effective surface temperature, K. */
  tempK: number;
  /** Bolometric luminosity, W. */
  luminosityW: number;
  /** Linear sRGB colour of the photosphere. */
  color: [number, number, number];
  /** Age in seconds since formation. */
  ageS: number;
  /** Rotation period, s. Drives starspot advection and flare cadence. */
  rotationS: number;
  /** 0–1: how violent the chromosphere is. M-dwarfs flare constantly. */
  activity: number;
  /** Convective granulation cell scale as a fraction of radius. */
  granulation: number;
  /** Present only for degenerate remnants. */
  compact?: {
    kind: 'white-dwarf' | 'neutron-star' | 'black-hole';
    /** Schwarzschild radius, m — the visual event horizon. */
    schwarzschildM: number;
    /** Accretion disc luminosity, W. Zero for a quiet remnant. */
    accretionW: number;
    /** Relativistic jet half-opening angle, radians. 0 = no jets. */
    jetAngle: number;
    spin: number;
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Orbits
   ═══════════════════════════════════════════════════════════════════════════ */

export interface OrbitElements {
  /** Semi-major axis, m. */
  a: number;
  /** Eccentricity, 0–1. */
  e: number;
  /** Inclination, radians. */
  i: number;
  /** Longitude of ascending node, radians. */
  raan: number;
  /** Argument of periapsis, radians. */
  argP: number;
  /** Mean anomaly at epoch, radians. */
  m0: number;
  /** Orbital period, s (derived, cached). */
  periodS: number;
  /** Mass of the primary this orbits, kg. */
  primaryMassKg: number;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Planets
   ═══════════════════════════════════════════════════════════════════════════ */

export type PlanetClass =
  | 'molten' // young, resurfacing, lava seas
  | 'barren' // airless rock, cratered
  | 'desert' // dry, thin air, dunes and mesas
  | 'terran' // the rare good one: oceans, forests, weather
  | 'ocean' // world-covering sea, archipelagos
  | 'tundra' // cold, taiga and steppe
  | 'glacial' // ice sheets, subsurface ocean
  | 'jungle' // hot, wet, dense canopy
  | 'toxic' // thick corrosive atmosphere, acid rain
  | 'exotic' // crystalline, silicate life, impossible chemistry
  | 'gas-giant'
  | 'ice-giant';

export type LifeStage = 'none' | 'microbial' | 'flora' | 'fauna' | 'sapient' | 'post-sapient';

export interface AtmosphereSpec {
  present: boolean;
  /** Surface pressure, Pa. Earth = 101325. */
  surfacePressurePa: number;
  /** Scale height, m. */
  scaleHeightM: number;
  /** Top of the modelled atmosphere above the surface, m. */
  thicknessM: number;
  /** Rayleigh scattering coefficients at sea level, per metre, RGB. */
  rayleigh: [number, number, number];
  /** Mie scattering coefficient at sea level, per metre. */
  mie: number;
  /** Mie anisotropy, -1..1. ~0.76 for Earth haze. */
  mieG: number;
  /** Ozone-like absorption, per metre, RGB. Gives Earth its blue twilight. */
  absorption: [number, number, number];
  /** Ground-level fog density multiplier. */
  fogDensity: number;
  /** Mean wind speed, m/s — drives cloud advection and vegetation sway. */
  windSpeed: number;
  /** Dominant tint used for cheap far-field shading. */
  tint: [number, number, number];
}

export interface OceanSpec {
  present: boolean;
  /** Sea level as a fraction of maxElevation above the reference sphere. */
  level: number;
  /** Shallow-water scattering colour, linear. */
  shallow: [number, number, number];
  /** Deep-water absorption colour, linear. */
  deep: [number, number, number];
  /** Significant wave height, m. */
  waveHeightM: number;
  /** Is it water? Could be methane, ammonia, molten silicate. */
  fluid: 'water' | 'methane' | 'ammonia' | 'lava' | 'mercury' | 'hydrocarbon';
  /** 0–1 fraction of the ocean that is frozen at the poles. */
  iceCoverage: number;
}

export interface TerrainSpec {
  /** Peak elevation above the reference sphere, m. */
  maxElevationM: number;
  /** Base frequency of the continental mask, in cycles per planet radius. */
  continentFreq: number;
  /** 0–1: how much of the surface is continent rather than basin. */
  landFraction: number;
  /** Mountain ridge frequency and strength. */
  ridgeFreq: number;
  ridgeStrength: number;
  /** Erosion iterations baked into the height function, 0–1 strength. */
  erosion: number;
  /** Crater density, 0–1. High on airless worlds, ~0 on active ones. */
  craterDensity: number;
  /** Dune field coverage, 0–1. */
  duneCoverage: number;
  /** Tectonic plate count — drives rift valleys and mountain arcs. */
  plates: number;
  /** Volcanic activity, 0–1. */
  volcanism: number;
  /** Warp strength applied to the domain before sampling — makes coastlines
   *  fractal and fjord-like instead of smoothly circular. */
  domainWarp: number;
}

export interface BiomePalette {
  /** Linear-sRGB triplets, sampled by the terrain shader. */
  lowland: [number, number, number];
  highland: [number, number, number];
  mountain: [number, number, number];
  peak: [number, number, number];
  sand: [number, number, number];
  rock: [number, number, number];
  vegetation: [number, number, number];
  vegetationAlt: [number, number, number];
  polar: [number, number, number];
  /** Emissive accents: lava cracks, bioluminescence, crystal glow. */
  emissive: [number, number, number];
  emissiveStrength: number;
}

export interface RingSpec {
  present: boolean;
  innerRadiusM: number;
  outerRadiusM: number;
  /** Optical thickness, 0–1. */
  opacity: number;
  color: [number, number, number];
  /** Number of visible Cassini-style gaps. */
  gaps: number;
  /** Ring plane tilt relative to the equator, radians. */
  tilt: number;
}

export interface CivilizationSpec {
  present: boolean;
  name: string;
  /** 0–1 along the Kardashev-ish scale used for visual density. */
  techLevel: number;
  population: number;
  /** Number of major settlements placed on the surface. */
  cityCount: number;
  /** Architectural language — picked once per civilisation. */
  style: 'brutalist' | 'organic' | 'crystalline' | 'arcology' | 'nomadic' | 'ruins' | 'hive' | 'baroque';
  /** Primary structural colour and the neon they light it with. */
  structure: [number, number, number];
  neon: [number, number, number];
  /** 0–1: how much orbital infrastructure exists (elevators, rings, stations). */
  orbital: number;
  /** 0–1: how ruined. 1 = a dead civilisation's bones. */
  decay: number;
}

export interface MoonSpec extends Omit<PlanetSpec, 'moons' | 'rings'> {
  parentIndex: number;
}

export interface PlanetSpec {
  seed: number;
  name: string;
  designation: string;
  klass: PlanetClass;
  /** Index within the parent system, 0-based, inner to outer. */
  index: number;

  radiusM: number;
  massKg: number;
  /** Surface gravity, m/s². */
  gravity: number;
  /** Sidereal rotation period, s. Negative = retrograde. */
  rotationS: number;
  /** Axial tilt, radians — the reason seasons exist. */
  axialTiltRad: number;
  /** Rotation phase at epoch, radians. */
  rotationPhase: number;
  /** Equilibrium surface temperature, K. */
  tempK: number;
  /** 0–1 magnetic field strength; gates aurorae and surface radiation. */
  magnetosphere: number;
  /** Albedo, 0–1. */
  albedo: number;
  /** Is the planet tidally locked to its primary? */
  tidallyLocked: boolean;

  orbit: OrbitElements;
  atmosphere: AtmosphereSpec;
  ocean: OceanSpec;
  terrain: TerrainSpec;
  palette: BiomePalette;
  rings: RingSpec;
  life: LifeStage;
  /** 0–1 biodiversity, drives flora/fauna variety and density. */
  biodiversity: number;
  civilization: CivilizationSpec;
  moons: MoonSpec[];

  /** Free-form flavour used by the scanner UI. */
  notes: string[];
  /** True if this world is worth a marker on the galaxy map. */
  notable: boolean;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Systems, galaxies, the web
   ═══════════════════════════════════════════════════════════════════════════ */

export interface AsteroidBeltSpec {
  present: boolean;
  innerM: number;
  outerM: number;
  count: number;
  /** Mean inclination spread, radians. */
  spread: number;
  color: [number, number, number];
}

export interface StarSystemSpec {
  seed: number;
  name: string;
  /** Position within the parent galaxy, in light years. */
  position: [number, number, number];
  stars: StarSpec[];
  /** Binary/trinary separation, m. Empty for single stars. */
  separationsM: number[];
  planets: PlanetSpec[];
  belts: AsteroidBeltSpec[];
  /** Total mass used for the far-field n-body approximation, kg. */
  totalMassKg: number;
  /** True if anything here is worth flying to. */
  notable: boolean;
  /** 0-1 metallicity; affects planet composition and star colour. */
  metallicity: number;
}

export type GalaxyType = 'spiral' | 'barred-spiral' | 'elliptical' | 'lenticular' | 'irregular' | 'dwarf' | 'ring';

export interface NebulaSpec {
  seed: number;
  name: string;
  kind: 'emission' | 'reflection' | 'dark' | 'planetary' | 'supernova-remnant';
  /** Position in the galaxy, light years. */
  position: [number, number, number];
  radiusLy: number;
  /** Primary and secondary emission colours, linear. */
  colorA: [number, number, number];
  colorB: [number, number, number];
  density: number;
  /** Turbulence scale for the volumetric noise. */
  turbulence: number;
}

export interface GalaxySpec {
  seed: number;
  name: string;
  type: GalaxyType;
  /** Position in the cosmic web, megaparsecs. */
  position: [number, number, number];
  /** Disc radius, light years. */
  radiusLy: number;
  /** Disc scale height, light years. */
  thicknessLy: number;
  starCount: number;
  arms: number;
  /** Logarithmic spiral pitch angle, radians. */
  armPitch: number;
  /** Bar half-length as a fraction of radius. 0 for unbarred. */
  barFraction: number;
  /** Bulge radius fraction. */
  bulgeFraction: number;
  /** Rotation, radians per second at the half-light radius. */
  angularVel: number;
  /** Orientation of the disc normal. */
  normal: [number, number, number];
  /** Population colours: young blue arms, old yellow bulge. */
  armColor: [number, number, number];
  coreColor: [number, number, number];
  dustColor: [number, number, number];
  /** Redshift z — everything far away is old and red. */
  redshift: number;
  /** Central black hole mass, kg. Sets the AGN brightness. */
  smbhMassKg: number;
  /** 0–1 active galactic nucleus strength. */
  agn: number;
  nebulae: NebulaSpec[];
  /** Star formation rate, solar masses per year — drives blue-ness. */
  sfr: number;
}

export interface WebNodeSpec {
  /** Comoving position, Mpc. */
  position: [number, number, number];
  /** Mass, in units of 10¹⁴ solar masses. */
  mass: number;
  /** 0 = void, 1 = sheet, 2 = filament, 3 = node/cluster. */
  classification: 0 | 1 | 2 | 3;
}
