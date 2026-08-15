/**
 * Procedural naming.
 *
 * A universe of "Planet 4471-B" is a spreadsheet. A universe of Aureth, Kavish
 * Delta, and the Weeping Shoals is a place. Names are generated from phonotactic
 * rules per "region" of the galaxy, so neighbouring systems sound related — the
 * same way real place names cluster by language family.
 */

import { Rng } from '../core/Rand';

interface Phonology {
  onsets: string[];
  nuclei: string[];
  codas: string[];
  /** Probability a syllable takes a coda consonant. */
  codaChance: number;
  /** Preferred syllable counts. */
  lengths: number[];
  /** Optional decorative suffixes. */
  suffixes: string[];
}

/**
 * Eight phonologies, each with its own sound. Which one a region uses is a
 * function of its coordinates, so the galaxy has linguistic geography.
 */
const PHONOLOGIES: Phonology[] = [
  {
    // Liquid, vowel-heavy — Elvish/Latinate.
    onsets: ['', 'l', 'm', 'n', 'r', 's', 'v', 'th', 'el', 'ae', 'ly', 'sil', 'ar'],
    nuclei: ['a', 'e', 'i', 'o', 'ae', 'ia', 'ei', 'ea', 'io'],
    codas: ['l', 'n', 'r', 's', 'th', 'm'],
    codaChance: 0.45,
    lengths: [2, 3, 3, 4],
    suffixes: ['', '', 'iel', 'ara', 'is', 'or'],
  },
  {
    // Hard, consonantal — Slavic/Germanic.
    onsets: ['k', 'g', 'v', 'z', 'dr', 'gr', 'kr', 'st', 'br', 'th', 'sk'],
    nuclei: ['a', 'o', 'u', 'i', 'e', 'ov', 'ar'],
    codas: ['k', 'r', 'sk', 'n', 'v', 'th', 'z'],
    codaChance: 0.72,
    lengths: [2, 2, 3],
    suffixes: ['', '', 'ov', 'ek', 'ard'],
  },
  {
    // Sibilant, sharp — insectile, alien.
    onsets: ['x', 'z', 'ts', 'sh', 'ch', 'kh', 'ss', 'thr', 'vr'],
    nuclei: ['i', 'y', 'ee', 'ai', 'e', 'ii'],
    codas: ['x', 'ss', 'k', 'sh', 't', 'kt'],
    codaChance: 0.8,
    lengths: [2, 2, 3],
    suffixes: ['', 'ix', 'ax', 'ekt'],
  },
  {
    // Open, flowing — Polynesian/Japanese.
    onsets: ['', 'k', 'm', 'n', 'h', 't', 'w', 'r', 'p', 's'],
    nuclei: ['a', 'i', 'u', 'e', 'o', 'ao', 'ai'],
    codas: ['', '', '', 'n'],
    codaChance: 0.12,
    lengths: [3, 3, 4],
    suffixes: ['', '', 'ha', 'no', 'ka'],
  },
  {
    // Guttural, ancient — Semitic.
    onsets: ['b', 'd', 'h', 'q', 'sh', 'y', 'z', 'ch', 'm', 'n', 'r'],
    nuclei: ['a', 'e', 'i', 'a', 'aa', 'u'],
    codas: ['l', 'm', 'n', 'r', 'th', 'h', 'd'],
    codaChance: 0.68,
    lengths: [2, 3, 3],
    suffixes: ['', '', 'im', 'el', 'ath'],
  },
  {
    // Nasal, resonant — Sanskrit-ish.
    onsets: ['v', 'j', 'dh', 'bh', 'kr', 'pr', 'sv', 'n', 'm', 'ch'],
    nuclei: ['a', 'i', 'u', 'aa', 'ii', 'e'],
    codas: ['n', 'm', 'r', 'sh', 'nt'],
    codaChance: 0.55,
    lengths: [3, 3, 4],
    suffixes: ['', 'an', 'ika', 'esh'],
  },
  {
    // Clipped, technical — machine cultures.
    onsets: ['t', 'k', 'p', 'd', 'g', 'b', 'v', 'z', 'kr', 'tr'],
    nuclei: ['e', 'i', 'o', 'u', 'y'],
    codas: ['t', 'k', 'x', 'n', 'd', 'g'],
    codaChance: 0.85,
    lengths: [2, 2, 2, 3],
    suffixes: ['', '-' + '', 'ex', 'on', 'ux'],
  },
  {
    // Long, mournful — for dead worlds and drowned cities.
    onsets: ['', 'w', 'l', 'm', 'n', 'y', 'h', 'gl', 'sl', 'thr'],
    nuclei: ['oo', 'ou', 'ow', 'ae', 'ea', 'o', 'u', 'ei'],
    codas: ['l', 'n', 'r', 'w', 'm', 'th'],
    codaChance: 0.5,
    lengths: [2, 3, 3, 4],
    suffixes: ['', '', 'ael', 'oth', 'wyn'],
  },
];

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildWord(rng: Rng, ph: Phonology): string {
  const n = rng.pick(ph.lengths);
  let out = '';
  for (let i = 0; i < n; i++) {
    out += rng.pick(ph.onsets);
    out += rng.pick(ph.nuclei);
    if (rng.chance(ph.codaChance) && i === n - 1) out += rng.pick(ph.codas);
    else if (rng.chance(ph.codaChance * 0.35)) out += rng.pick(ph.codas);
  }
  out += rng.pick(ph.suffixes);
  // Collapse accidental triples like "sss" that read as typos.
  out = out.replace(/(.)\1\1+/g, '$1$1');
  return capitalise(out);
}

/** A phonology chosen by position, so neighbours sound like neighbours. */
export function phonologyFor(x: number, y: number, z: number): Phonology {
  const cell = Math.abs(Math.floor(x / 900) * 73856093 + Math.floor(y / 900) * 19349663 + Math.floor(z / 900) * 83492791);
  return PHONOLOGIES[cell % PHONOLOGIES.length];
}

export function starName(rng: Rng, pos: [number, number, number]): string {
  return buildWord(rng, phonologyFor(pos[0], pos[1], pos[2]));
}

const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota', 'Kappa', 'Lambda', 'Mu'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV'];

export function planetDesignation(systemName: string, index: number): string {
  return `${systemName} ${ROMAN[index] ?? index + 1}`;
}

export function moonDesignation(planetName: string, index: number): string {
  return `${planetName} ${String.fromCharCode(97 + index)}`;
}

/** Some worlds get a proper name rather than a catalogue number. */
export function planetProperName(rng: Rng, pos: [number, number, number]): string {
  return buildWord(rng, phonologyFor(pos[0] + 137, pos[1] - 41, pos[2] + 7));
}

const GALAXY_PREFIX = ['NGC', 'IC', 'UGC', 'PGC', 'Abell', 'M'];
const EVOCATIVE = [
  'The Drowned Lantern',
  'Shepherd of Ash',
  'The Long Silence',
  'Cinderfall',
  'The Weeping Wheel',
  "Hollow Crown",
  'The Ninefold Path',
  'Ember Reach',
  'The Glass Meridian',
  'Vault of Tides',
  'The Unquiet Loom',
  'Saltspire',
  'The Gilded Wound',
  'Anvil of Dusk',
  'The Patient Dark',
  'Coral Nine',
  'The Thousand Mouths',
  'Lantern of the Deep',
  'Riverless',
  'The Second Morning',
];

export function galaxyName(rng: Rng): string {
  if (rng.chance(0.22)) return rng.pick(EVOCATIVE);
  const p = rng.pick(GALAXY_PREFIX);
  return `${p} ${rng.int(100, 9999)}`;
}

const NEBULA_NOUNS = [
  'Veil', 'Crown', 'Hand', 'Eye', 'Wing', 'Mane', 'Serpent', 'Lantern', 'Anvil', 'Bloom',
  'Rift', 'Choir', 'Ribbon', 'Shroud', 'Fountain', 'Cathedral', 'Wake', 'Ash', 'Thorn', 'Pearl',
];
const NEBULA_ADJ = [
  'Weeping', 'Burning', 'Silent', 'Broken', 'Golden', 'Cobalt', 'Hollow', 'Endless', 'Sleeping',
  'Radiant', 'Drowned', 'Frozen', 'Whispering', 'Crimson', 'Emerald', 'Shattered', 'Ancient',
];

export function nebulaName(rng: Rng): string {
  return `The ${rng.pick(NEBULA_ADJ)} ${rng.pick(NEBULA_NOUNS)}`;
}

const CIV_TITLES = [
  'Ascendancy', 'Concord', 'Compact', 'Dominion', 'Assembly', 'Coalition', 'Chorus', 'Remnant',
  'Sovereignty', 'Collective', 'Communion', 'Hegemony', 'Consortium', 'Lattice', 'Covenant',
];

export function civilizationName(rng: Rng, pos: [number, number, number]): string {
  const root = buildWord(rng, phonologyFor(pos[0] * 3, pos[1] * 5, pos[2] * 7));
  return rng.chance(0.5) ? `The ${root} ${rng.pick(CIV_TITLES)}` : `${root} ${rng.pick(CIV_TITLES)}`;
}

const CITY_PREFIX = ['New', 'Old', 'High', 'Low', 'Far', 'Deep', 'Grand', 'Little', 'Upper', 'Lower'];
const CITY_SUFFIX = ['Harbour', 'Reach', 'Gate', 'Watch', 'Hollow', 'Spire', 'Crossing', 'Landing', 'Rest', 'Fold', 'Bastion', 'Terrace'];

export function cityName(rng: Rng, pos: [number, number, number]): string {
  const root = buildWord(rng, phonologyFor(pos[0], pos[1], pos[2]));
  const r = rng.next();
  if (r < 0.3) return `${rng.pick(CITY_PREFIX)} ${root}`;
  if (r < 0.6) return `${root} ${rng.pick(CITY_SUFFIX)}`;
  return root;
}

export { buildWord, PHONOLOGIES };
