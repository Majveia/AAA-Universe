/**
 * Music theory.
 *
 * The score is generated, not sequenced, so the rules have to live somewhere.
 * This file is pure arithmetic on MIDI note numbers: modes, chords stacked in
 * thirds far enough to reach the 9ths, 11ths and 13ths that give the drift
 * material its jazz colour, and a voice-leading routine so chords move by the
 * smallest distance instead of jumping in parallel blocks.
 *
 * Nothing here allocates audio nodes or knows the AudioContext exists.
 */

import { Rng } from '../core/Rand';

export type ModeName =
  | 'ionian'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'aeolian'
  | 'locrian'
  | 'harmonicMinor'
  | 'melodicMinor'
  | 'lydianDominant'
  | 'wholeTone'
  | 'octatonic'
  | 'pentatonicMinor'
  | 'pentatonicMajor';

/** Semitone offsets from the tonic. */
export const MODES: Record<ModeName, readonly number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  // Lydian dominant — the "acoustic" scale. Alien but still consonant.
  lydianDominant: [0, 2, 4, 6, 7, 9, 10],
  // Six equal steps: no leading tone, no tonic gravity. Weightlessness.
  wholeTone: [0, 2, 4, 6, 8, 10],
  // Half–whole diminished: symmetric, unsettling, endlessly reharmonisable.
  octatonic: [0, 1, 3, 4, 6, 7, 9, 10],
  pentatonicMinor: [0, 3, 5, 7, 10],
  pentatonicMajor: [0, 2, 4, 7, 9],
};

/** Scale degree → absolute MIDI note. `index` may be negative or past an octave. */
export function pitchAt(mode: readonly number[], rootMidi: number, index: number): number {
  const n = mode.length;
  const oct = Math.floor(index / n);
  const i = index - oct * n;
  return rootMidi + mode[i] + 12 * oct;
}

export interface Chord {
  /** Scale degree the chord is built on, 0-based. */
  degree: number;
  /** Absolute MIDI notes, stacked in thirds from the chord root upward. */
  tones: number[];
  /** Pitch classes present, 0–11. */
  pcs: number[];
  /** MIDI note of the chord root. */
  root: number;
  /** Tonic pitch class of the key this chord belongs to. */
  keyRoot: number;
  mode: ModeName;
}

/**
 * Stack thirds inside the mode. `size` counts chord tones: 3 = triad,
 * 4 = seventh, 5 = ninth, 6 = eleventh, 7 = thirteenth. In a six- or eight-note
 * scale "thirds" are whatever every-other-degree gives you, which is exactly
 * the augmented and diminished colour those scales are wanted for.
 */
export function buildChord(mode: ModeName, keyRoot: number, degree: number, size: number, baseOctaveMidi = 48): Chord {
  const scale = MODES[mode];
  const tones: number[] = [];
  const pcs: number[] = [];
  for (let i = 0; i < size; i++) {
    const p = pitchAt(scale, baseOctaveMidi + keyRoot, degree + i * 2);
    tones.push(p);
    const pc = ((p % 12) + 12) % 12;
    if (!pcs.includes(pc)) pcs.push(pc);
  }
  return { degree, tones, pcs, root: tones[0], keyRoot, mode };
}

/** Every chord tone that falls inside a register, low to high. */
export function chordTonesInRange(chord: Chord, low: number, high: number): number[] {
  const out: number[] = [];
  for (const pc of chord.pcs) {
    let m = low + ((((pc - low) % 12) + 12) % 12);
    for (; m <= high; m += 12) out.push(m);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Move each voice to the nearest available chord tone. The point is that a
 * listener hears *lines*, not chords: if the top voice wanders by a tone while
 * everything underneath holds, the harmony changes without anyone noticing the
 * seam. That is what lets one mood dissolve into another mid-phrase.
 */
export function voiceLead(prev: readonly number[], chord: Chord, count: number, low: number, high: number): number[] {
  const pool = chordTonesInRange(chord, low, high);
  if (pool.length === 0) return prev.slice(0, count);
  const used = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    // With no history, spread the voices evenly across the register.
    const anchor = prev.length ? prev[Math.min(i, prev.length - 1)] : low + ((high - low) * (i + 0.5)) / count;
    let best = pool[0];
    let bestD = Infinity;
    for (const c of pool) {
      if (used.has(c)) continue;
      const d = Math.abs(c - anchor);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    used.add(best);
    out.push(best);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Snap an arbitrary MIDI note into a mode, choosing the nearer neighbour. */
export function quantizeToMode(midi: number, mode: ModeName, keyRoot: number): number {
  const scale = MODES[mode];
  const rel = midi - keyRoot;
  const oct = Math.floor(rel / 12);
  const pc = rel - oct * 12;
  let best = scale[0];
  let bestD = Infinity;
  for (const s of scale) {
    const d = Math.abs(s - pc);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return keyRoot + oct * 12 + best;
}

/** The scale-degree index of a MIDI note, for melodic random walks. */
export function degreeOf(midi: number, mode: ModeName, keyRoot: number): number {
  const scale = MODES[mode];
  const rel = quantizeToMode(midi, mode, keyRoot) - keyRoot;
  const oct = Math.floor(rel / 12);
  const pc = rel - oct * 12;
  const i = Math.max(0, scale.indexOf(pc));
  return oct * scale.length + i;
}

/** A chromatic approach note a semitone below or above a target — walking glue. */
export function approach(target: number, rng: Rng): number {
  return target + (rng.chance(0.62) ? -1 : 1);
}

export interface ProgressionStep {
  /** Scale degree, 0-based. */
  deg: number;
  /** Chord size: 4 = 7th, 5 = 9th, 6 = 11th, 7 = 13th. */
  size: number;
  /** Length in bars. */
  bars: number;
}

export function progressionBars(p: readonly ProgressionStep[]): number {
  let n = 0;
  for (const s of p) n += s.bars;
  return n;
}

/** Which step of the progression a bar index lands on. */
export function stepForBar(p: readonly ProgressionStep[], bar: number): ProgressionStep {
  const total = progressionBars(p) || 1;
  let b = ((bar % total) + total) % total;
  for (const s of p) {
    if (b < s.bars) return s;
    b -= s.bars;
  }
  return p[p.length - 1];
}

/**
 * Humanised timing. A grid-perfect performance is the fastest way to make a
 * generated score sound generated, so every note gets a few milliseconds of
 * drift — always positive-mean-free so the pulse itself does not wander.
 */
export function humanize(rng: Rng, spreadMs = 12): number {
  return (rng.next() - 0.5) * 2 * (spreadMs / 1000);
}
