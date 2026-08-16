/**
 * The generative score.
 *
 * There is no loop anywhere in this file. A *section* is a tempo, a mode, a
 * chord progression and a set of layers; it schedules itself one sixteenth at a
 * time against `AudioContext.currentTime`, ~100 ms ahead of the playhead, and
 * decides in the moment which of its players are awake based on the intensity
 * the game has asked for.
 *
 * Changing mood does not cut. The director waits for the next bar line, starts
 * a second section there with the *same tonic and the voice-led continuation of
 * the same chord*, and cross-fades over 4–12 seconds while the outgoing band
 * plays on for another bar and then rings out. The harmony is continuous; only
 * the instrumentation and the pulse change underneath it. That is what a segue
 * sounds like, and it is the difference between a soundtrack and a playlist.
 */

import type { MusicMood } from '../api/Contracts';
import { Rng } from '../core/Rand';
import { clamp, lerp, mtof, smoothstep } from './Dsp';
import { AudioGraph } from './Graph';
import * as I from './Instruments';
import type { SynthCtx } from './Instruments';
import * as T from './Theory';
import { PRIORITY, VoicePool } from './Voices';

const STEPS_PER_BAR = 16;
const BEATS_PER_BAR = 4;

/** Registers, in MIDI notes. Instruments stay in their lane so the mix works. */
const R = {
  bassLow: 28,
  bassHigh: 50,
  padLow: 47,
  padHigh: 77,
  compLow: 55,
  compHigh: 80,
  pluckLow: 54,
  pluckHigh: 85,
  leadLow: 66,
  leadHigh: 89,
  bellLow: 79,
  bellHigh: 102,
};

type LayerName = 'drone' | 'pad' | 'bass' | 'rhodes' | 'pluck' | 'lead' | 'bell' | 'ride' | 'brush' | 'kick';
type BassStyle = 'walk' | 'pulse' | 'held' | 'root5';

interface LayerCfg {
  /** Intensity at which this player wakes up. */
  at: number;
  /** Per-layer level trim. */
  gain?: number;
  /** Extra note-probability multiplier. */
  density?: number;
}

interface MoodPlan {
  tempo: number;
  swing: number;
  mode: T.ModeName;
  /** Scale the melodic layers borrow from — how the "alien" gets in. */
  colour?: T.ModeName;
  /** Semitones the tonic moves by when this mood takes over. */
  rootOffset: number;
  progression: T.ProgressionStep[];
  /** Second progression, alternated with the first for long-form variety. */
  alt?: T.ProgressionStep[];
  bassStyle: BassStyle;
  layers: Partial<Record<LayerName, LayerCfg>>;
  reverb: number;
  room: number;
  echo: number;
  /** Delay time in quarter notes. 0.75 = dotted eighth. */
  echoBeats: number;
  gain: number;
  bright: number;
  /** Preferred cross-fade length in seconds. */
  fade: number;
}

/* ═══════════════════════════════════════════════════════════════════════════
   The moods
   ═══════════════════════════════════════════════════════════════════════════ */

const PLANS: Record<MusicMood, MoodPlan | null> = {
  // Vangelis: almost no pulse, a lydian #11 hanging in the dark, bells that
  // arrive whenever they feel like it.
  cosmos: {
    tempo: 50,
    swing: 0,
    mode: 'lydian',
    colour: 'wholeTone',
    rootOffset: 0,
    progression: [
      { deg: 0, size: 6, bars: 4 },
      { deg: 5, size: 5, bars: 4 },
      { deg: 1, size: 5, bars: 4 },
      { deg: 3, size: 5, bars: 4 },
    ],
    bassStyle: 'held',
    layers: { drone: { at: 0 }, pad: { at: 0.18 }, bell: { at: 0.3 }, bass: { at: 0.45 }, pluck: { at: 0.62 }, lead: { at: 0.85 } },
    reverb: 1,
    room: 0,
    echo: 0.35,
    echoBeats: 1.5,
    gain: 0.85,
    bright: 0.5,
    fade: 10,
  },

  // The Bebop one. Dorian vamp, brushes, walking bass, Rhodes comping behind a
  // muted trumpet that plays four bars and then shuts up for two.
  drift: {
    tempo: 104,
    swing: 0.62,
    mode: 'dorian',
    rootOffset: 0,
    progression: [
      { deg: 0, size: 5, bars: 2 },
      { deg: 3, size: 7, bars: 2 },
      { deg: 0, size: 5, bars: 2 },
      { deg: 6, size: 5, bars: 1 },
      { deg: 4, size: 6, bars: 1 },
    ],
    alt: [
      { deg: 1, size: 5, bars: 1 },
      { deg: 4, size: 6, bars: 1 },
      { deg: 0, size: 6, bars: 2 },
      { deg: 3, size: 7, bars: 2 },
      { deg: 5, size: 5, bars: 1 },
      { deg: 6, size: 5, bars: 1 },
    ],
    bassStyle: 'walk',
    layers: {
      pad: { at: 0.05, gain: 0.55 },
      bass: { at: 0.12 },
      ride: { at: 0.28 },
      rhodes: { at: 0.38 },
      brush: { at: 0.5 },
      lead: { at: 0.62 },
      pluck: { at: 0.92, gain: 0.5 },
    },
    reverb: 0.26,
    room: 0.34,
    echo: 0.14,
    echoBeats: 0.75,
    gain: 0.95,
    bright: 0.58,
    fade: 6,
  },

  // Awe. Lydian a fourth up from wherever we were, everything swelling.
  arrival: {
    tempo: 68,
    swing: 0,
    mode: 'lydian',
    rootOffset: 5,
    progression: [
      { deg: 0, size: 6, bars: 2 },
      { deg: 1, size: 5, bars: 2 },
      { deg: 5, size: 5, bars: 2 },
      { deg: 3, size: 5, bars: 1 },
      { deg: 4, size: 6, bars: 1 },
    ],
    bassStyle: 'held',
    layers: {
      pad: { at: 0 },
      drone: { at: 0.12 },
      bell: { at: 0.28 },
      pluck: { at: 0.42 },
      bass: { at: 0.5 },
      lead: { at: 0.55 },
      rhodes: { at: 0.72 },
    },
    reverb: 0.9,
    room: 0.05,
    echo: 0.3,
    echoBeats: 1,
    gain: 1,
    bright: 0.78,
    fade: 8,
  },

  // Outer Wilds loneliness: a few notes, very high, a lot of room between them.
  wonder: {
    tempo: 58,
    swing: 0,
    mode: 'lydian',
    colour: 'pentatonicMajor',
    rootOffset: 0,
    progression: [
      { deg: 0, size: 5, bars: 4 },
      { deg: 4, size: 5, bars: 4 },
      { deg: 5, size: 5, bars: 4 },
      { deg: 0, size: 6, bars: 4 },
    ],
    bassStyle: 'held',
    layers: { bell: { at: 0 }, pluck: { at: 0.22 }, pad: { at: 0.38, gain: 0.7 }, lead: { at: 0.68 }, bass: { at: 0.8, gain: 0.6 } },
    reverb: 1,
    room: 0,
    echo: 0.45,
    echoBeats: 1.5,
    gain: 0.8,
    bright: 0.72,
    fade: 11,
  },

  // Phrygian, with the melodic layers pulling from the octatonic — the flat
  // second against the tonic does most of the work.
  tension: {
    tempo: 82,
    swing: 0,
    mode: 'phrygian',
    colour: 'octatonic',
    rootOffset: 0,
    progression: [
      { deg: 0, size: 5, bars: 2 },
      { deg: 1, size: 5, bars: 2 },
      { deg: 0, size: 5, bars: 2 },
      { deg: 6, size: 5, bars: 1 },
      { deg: 4, size: 4, bars: 1 },
    ],
    bassStyle: 'pulse',
    layers: {
      drone: { at: 0 },
      pad: { at: 0.15 },
      bass: { at: 0.3 },
      pluck: { at: 0.48 },
      rhodes: { at: 0.62 },
      ride: { at: 0.75, gain: 0.6 },
      lead: { at: 0.85 },
    },
    reverb: 0.55,
    room: 0.25,
    echo: 0.18,
    echoBeats: 0.5,
    gain: 0.9,
    bright: 0.34,
    fade: 5,
  },

  // Warm, human, a little folk. Plucked strings lead; nothing is in a hurry.
  settlement: {
    tempo: 96,
    swing: 0.34,
    mode: 'mixolydian',
    colour: 'pentatonicMajor',
    rootOffset: 0,
    progression: [
      { deg: 0, size: 4, bars: 2 },
      { deg: 3, size: 4, bars: 2 },
      { deg: 4, size: 5, bars: 2 },
      { deg: 0, size: 4, bars: 1 },
      { deg: 5, size: 4, bars: 1 },
    ],
    bassStyle: 'walk',
    layers: {
      pluck: { at: 0 },
      pad: { at: 0.18, gain: 0.6 },
      bass: { at: 0.25 },
      rhodes: { at: 0.42 },
      brush: { at: 0.55, gain: 0.7 },
      lead: { at: 0.7 },
    },
    reverb: 0.3,
    room: 0.35,
    echo: 0.1,
    echoBeats: 0.75,
    gain: 0.9,
    bright: 0.62,
    fade: 6,
  },

  storm: {
    tempo: 74,
    swing: 0,
    mode: 'aeolian',
    rootOffset: 0,
    progression: [
      { deg: 0, size: 5, bars: 2 },
      { deg: 5, size: 5, bars: 2 },
      { deg: 3, size: 5, bars: 2 },
      { deg: 6, size: 5, bars: 2 },
    ],
    bassStyle: 'pulse',
    layers: {
      drone: { at: 0 },
      pad: { at: 0.12 },
      bass: { at: 0.28 },
      brush: { at: 0.45 },
      kick: { at: 0.55 },
      pluck: { at: 0.62 },
      lead: { at: 0.8 },
    },
    reverb: 0.7,
    room: 0.15,
    echo: 0.2,
    echoBeats: 1,
    gain: 0.95,
    bright: 0.3,
    fade: 5,
  },

  // Two in the morning, one lamp on, brushes and a Rhodes.
  night: {
    tempo: 76,
    swing: 0.58,
    mode: 'aeolian',
    rootOffset: 0,
    progression: [
      { deg: 0, size: 5, bars: 2 },
      { deg: 5, size: 6, bars: 2 },
      { deg: 3, size: 5, bars: 2 },
      { deg: 4, size: 5, bars: 1 },
      { deg: 6, size: 5, bars: 1 },
    ],
    bassStyle: 'walk',
    layers: {
      pad: { at: 0 },
      bass: { at: 0.28 },
      rhodes: { at: 0.42 },
      brush: { at: 0.55, gain: 0.75 },
      lead: { at: 0.7 },
      bell: { at: 0.85, gain: 0.6 },
    },
    reverb: 0.5,
    room: 0.22,
    echo: 0.22,
    echoBeats: 0.75,
    gain: 0.85,
    bright: 0.42,
    fade: 8,
  },

  silence: null,
};

/* ═══════════════════════════════════════════════════════════════════════════
   Section — one band, playing one piece of music
   ═══════════════════════════════════════════════════════════════════════════ */

class Section {
  readonly plan: MoodPlan;
  readonly mood: MusicMood;
  readonly keyRoot: number;
  readonly startTime: number;
  intensity: number;

  /** Stop generating new notes at this time; held notes still ring out. */
  stopAt = Infinity;
  /** Safe to tear down after this. */
  deadAt = Infinity;

  private ctx: AudioContext;
  private dry: GainNode;
  private level: GainNode;
  private spaceIn: GainNode;
  private roomIn: GainNode;
  private echoIn: GainNode;
  private amts: GainNode[] = [];
  private synth: SynthCtx;
  private rng: Rng;

  private bar = 0;
  private step = 0;
  private chord: T.Chord;
  private nextChord: T.Chord;
  private padVoicing: number[] = [];
  private compVoicing: number[] = [];
  private lastBass = 40;
  private leadMidi = 74;
  private leadFreeAt = -1;
  private phraseOn = true;
  private pluckIdx = 0;

  constructor(
    mood: MusicMood,
    plan: MoodPlan,
    ctx: AudioContext,
    graph: AudioGraph,
    pool: VoicePool,
    keyRoot: number,
    startTime: number,
    intensity: number,
    seed: number,
    seedVoicing: number[],
  ) {
    this.mood = mood;
    this.plan = plan;
    this.ctx = ctx;
    this.keyRoot = keyRoot;
    this.startTime = startTime;
    this.intensity = intensity;
    this.rng = new Rng(seed);

    const mk = (dest: AudioNode, amount: number): GainNode => {
      const inNode = ctx.createGain();
      inNode.gain.value = 0;
      const amt = ctx.createGain();
      amt.gain.value = amount;
      inNode.connect(amt).connect(dest);
      this.amts.push(amt);
      return inNode;
    };

    this.dry = ctx.createGain();
    this.dry.gain.value = 0;
    this.level = ctx.createGain();
    this.level.gain.value = plan.gain * this.levelFor(intensity);
    this.dry.connect(this.level).connect(graph.music);
    this.amts.push(this.level);

    this.spaceIn = mk(graph.spaceMusic, plan.reverb);
    this.roomIn = mk(graph.roomMusic, plan.room);
    this.echoIn = mk(graph.echoMusic, plan.echo);

    this.synth = {
      ctx,
      pool,
      noise: graph.noise,
      rng: this.rng.fork('synth'),
      space: this.spaceIn,
      room: this.roomIn,
      echo: this.echoIn,
      strings: SHARED_STRINGS,
    };

    this.chord = this.chordFor(0);
    this.nextChord = this.chordFor(1);
    this.padVoicing = T.voiceLead(seedVoicing, this.chord, 4, R.padLow, R.padHigh);
    this.compVoicing = T.voiceLead(seedVoicing, this.chord, 4, R.compLow, R.compHigh);
    this.lastBass = this.chord.root - 12;
  }

  /* ---- clock ---- */

  get beat(): number {
    return 60 / this.plan.tempo;
  }

  get barDur(): number {
    return this.beat * BEATS_PER_BAR;
  }

  /**
   * Swing. The offbeat eighth slides toward the triplet position; sixteenths
   * lean a quarter as far. Straight moods pass through untouched.
   */
  stepTime(bar: number, step: number): number {
    const b = this.beat;
    let t = this.startTime + (bar * BEATS_PER_BAR + step / 4) * b;
    const s = this.plan.swing;
    if (s > 0.01) {
      if (step % 4 === 2) t += (s * b) / 6;
      else if (step % 2 === 1) t += (s * b) / 14;
    }
    return t;
  }

  /** The next bar line at or after `after` — where a mood change may happen. */
  nextBarTime(after: number): number {
    const d = this.barDur;
    const n = Math.max(0, Math.ceil((after - this.startTime) / d));
    return this.startTime + n * d;
  }

  get voicing(): number[] {
    return this.padVoicing.length ? this.padVoicing : this.compVoicing;
  }

  /* ---- mix ---- */

  fadeTo(target: number, seconds: number, endBy: number): void {
    const now = this.ctx.currentTime;
    const end = Math.max(now + 0.02, endBy);
    for (const p of [this.dry.gain, this.spaceIn.gain, this.roomIn.gain, this.echoIn.gain]) {
      try {
        p.cancelScheduledValues(now);
        p.setValueAtTime(p.value, now);
        p.linearRampToValueAtTime(target, end);
      } catch {
        /* detached */
      }
    }
  }

  private levelFor(intensity: number): number {
    // Density carries most of the dynamic; level only takes the edge off.
    return lerp(0.72, 1, clamp(intensity, 0, 1));
  }

  setIntensity(v: number): void {
    this.intensity = clamp(v, 0, 1);
    this.level.gain.setTargetAtTime(this.plan.gain * this.levelFor(this.intensity), this.ctx.currentTime, 1.2);
  }

  /* ---- harmony ---- */

  private progressionFor(bar: number): T.ProgressionStep[] {
    if (!this.plan.alt) return this.plan.progression;
    const len = T.progressionBars(this.plan.progression) || 8;
    // Alternate the changes every two turns so an eight-bar form does not feel
    // like an eight-bar loop.
    return Math.floor(bar / (len * 2)) % 2 === 1 ? this.plan.alt : this.plan.progression;
  }

  private chordFor(bar: number): T.Chord {
    const p = this.progressionFor(bar);
    const s = T.stepForBar(p, bar);
    return T.buildChord(this.plan.mode, this.keyRoot, s.deg, s.size, 48);
  }

  /* ---- scheduling ---- */

  scheduleUntil(horizon: number): void {
    const now = this.ctx.currentTime;
    let guard = 0;
    for (;;) {
      const t = this.stepTime(this.bar, this.step);
      if (t >= horizon || t >= this.stopAt) break;
      if (guard++ > 512) break;
      if (t > now - 0.05) this.emit(this.bar, this.step, t);
      if (++this.step >= STEPS_PER_BAR) {
        this.step = 0;
        this.bar++;
      }
    }
  }

  private layer(name: LayerName): LayerCfg | null {
    const cfg = this.plan.layers[name];
    if (!cfg) return null;
    return this.intensity >= cfg.at ? cfg : null;
  }

  /** 0 at the layer's threshold, 1 a little above it — no hard entrances. */
  private ramp(cfg: LayerCfg): number {
    return smoothstep(cfg.at, Math.min(1, cfg.at + 0.22), this.intensity) * (cfg.gain ?? 1);
  }

  private emit(bar: number, step: number, t: number): void {
    if (step === 0) this.startBar(bar, t);
    this.emitBass(bar, step, t);
    this.emitComp(bar, step, t);
    this.emitPluck(bar, step, t);
    this.emitLead(bar, step, t);
    this.emitBell(bar, step, t);
    this.emitPerc(bar, step, t);
  }

  private startBar(bar: number, t: number): void {
    const prevDeg = this.chord.degree;
    this.chord = this.chordFor(bar);
    this.nextChord = this.chordFor(bar + 1);
    const changed = this.chord.degree !== prevDeg || bar === 0;

    // Four-bar phrases: the lead sits out roughly one in three, which is what
    // makes the ones it plays sound like a decision.
    if (bar % 4 === 0) this.phraseOn = this.rng.next() < 0.42 + this.intensity * 0.42;

    const padCfg = this.layer('pad');
    if (padCfg && (changed || bar % 4 === 0)) {
      this.padVoicing = T.voiceLead(this.padVoicing, this.chord, 4, R.padLow, R.padHigh);
      const g = this.ramp(padCfg);
      const hold = this.barDur * (changed ? this.barsUntilChange(bar) : 1);
      for (let i = 0; i < this.padVoicing.length; i++) {
        const m = this.padVoicing[i];
        I.pad(this.synth, this.dry, t + this.rng.range(0, 0.05), mtof(m), {
          vel: g * lerp(0.85, 0.45, i / this.padVoicing.length),
          dur: hold,
          attack: clamp(this.barDur * 0.4, 0.5, 3),
          release: this.barDur * 0.9,
          bright: this.plan.bright,
          pan: (i - 1.5) * 0.28,
          send: 1,
          room: 0.4,
        });
      }
    }

    const droneCfg = this.layer('drone');
    if (droneCfg && bar % 8 === 0) {
      const g = this.ramp(droneCfg);
      const root = this.keyRoot + 36;
      const dur = this.barDur * 8;
      I.drone(this.synth, this.dry, t, mtof(root), { vel: g, dur, attack: dur * 0.3, release: dur * 0.5, bright: this.plan.bright, send: 1 });
      I.drone(this.synth, this.dry, t + 0.4, mtof(root + 7), { vel: g * 0.55, dur, attack: dur * 0.4, release: dur * 0.5, bright: this.plan.bright * 0.8, pan: 0.3, send: 1 });
    }

    // Held bass: one long note per chord.
    const bassCfg = this.layer('bass');
    if (bassCfg && this.plan.bassStyle === 'held' && changed) {
      const n = this.nearestBass(this.chord.root);
      I.bass(this.synth, this.dry, t, mtof(n), {
        vel: 0.5 * this.ramp(bassCfg),
        dur: this.barDur * this.barsUntilChange(bar) * 0.9,
        send: 0.6,
      });
      this.lastBass = n;
    }
  }

  private barsUntilChange(bar: number): number {
    const p = this.progressionFor(bar);
    return T.stepForBar(p, bar).bars;
  }

  private nearestBass(root: number): number {
    let n = root - 12;
    while (n < R.bassLow) n += 12;
    while (n > R.bassHigh) n -= 12;
    return n;
  }

  /* ---- bass ---- */

  private emitBass(bar: number, step: number, t: number): void {
    const cfg = this.layer('bass');
    if (!cfg) return;
    const style = this.plan.bassStyle;
    const g = this.ramp(cfg);
    if (style === 'held') return;

    if (style === 'walk') {
      if (step % 4 !== 0) return;
      const beat = step / 4;
      const n = this.walkNote(beat, bar);
      this.lastBass = n;
      I.bass(this.synth, this.dry, t + T.humanize(this.rng, 14), mtof(n), {
        vel: (beat === 0 ? 0.9 : beat === 2 ? 0.78 : 0.7) * g * this.rng.range(0.9, 1.06),
        dur: this.beat * 0.86,
        send: 0.5,
      });
      return;
    }

    if (style === 'pulse') {
      // Eighths on the root with the fifth on the offbeat: a heartbeat under
      // the storm rather than a bass line.
      if (step % 2 !== 0) return;
      const isDown = step % 4 === 0;
      if (!isDown && this.rng.next() > 0.35 + this.intensity * 0.4) return;
      const base = this.nearestBass(this.chord.root);
      const n = isDown ? base : base + (this.rng.chance(0.7) ? 7 : 12);
      I.bass(this.synth, this.dry, t + T.humanize(this.rng, 8), mtof(n), {
        vel: (isDown ? 0.85 : 0.5) * g,
        dur: this.beat * 0.4,
        send: 0.4,
      });
      return;
    }

    if (style === 'root5' && step % 8 === 0) {
      const base = this.nearestBass(this.chord.root);
      I.bass(this.synth, this.dry, t, mtof(step === 0 ? base : base + 7), { vel: 0.8 * g, dur: this.beat * 1.6, send: 0.5 });
    }
  }

  /**
   * Walking bass: root on one, chord tones through the middle of the bar, and a
   * chromatic approach on four aimed at wherever the next bar starts. The
   * approach note is the whole trick — it is what makes the bar line inevitable.
   */
  private walkNote(beat: number, bar: number): number {
    const scale = T.MODES[this.plan.mode];
    if (beat === 0) return this.nearestBass(this.chord.root);
    if (beat === 3) {
      const target = this.nearestBass(this.nextChord.root);
      const app = this.rng.chance(0.55) ? T.approach(target, this.rng) : T.quantizeToMode(target + (this.rng.chance(0.5) ? 2 : -2), this.plan.mode, this.keyRoot);
      return clamp(app, R.bassLow, R.bassHigh);
    }
    const tones = T.chordTonesInRange(this.chord, R.bassLow, R.bassHigh);
    const pool = this.rng.chance(0.7) ? tones : [T.quantizeToMode(this.lastBass + (this.rng.chance(0.5) ? 2 : -2), this.plan.mode, this.keyRoot)];
    let best = pool[0];
    let bestD = Infinity;
    for (const c of pool) {
      const d = Math.abs(c - this.lastBass) + (c === this.lastBass ? 6 : 0);
      if (d < bestD && d <= 9) {
        bestD = d;
        best = c;
      }
    }
    void scale;
    return clamp(best, R.bassLow, R.bassHigh);
  }

  /* ---- Rhodes comping ---- */

  private emitComp(bar: number, step: number, t: number): void {
    const cfg = this.layer('rhodes');
    if (!cfg) return;
    if (step % 2 !== 0) return;
    const g = this.ramp(cfg);

    // Comping lives on the offbeats. Landing on beat one every bar is what a
    // machine does; a player pushes and pulls around it.
    const onBeat = step % 4 === 0;
    const base = onBeat ? 0.16 : 0.32;
    const p = (base + this.intensity * 0.3) * (cfg.density ?? 1) * (this.plan.swing > 0.2 ? 1 : 0.75);
    if (this.rng.next() > p) return;

    this.compVoicing = T.voiceLead(this.compVoicing, this.rootlessChord(), 4, R.compLow, R.compHigh);
    const spread = this.rng.range(0.006, 0.022);
    const vel = (onBeat ? 0.5 : 0.66) * g * this.rng.range(0.85, 1.1);
    const dur = this.beat * this.rng.range(0.35, 1.1);
    for (let i = 0; i < this.compVoicing.length; i++) {
      I.rhodes(this.synth, this.dry, t + i * spread + T.humanize(this.rng, 9), mtof(this.compVoicing[i]), {
        vel: vel * lerp(1, 0.75, i / 4),
        dur,
        pan: (i - 1.5) * 0.16,
        send: 0.7,
        room: 0.5,
        echo: 0.5,
      });
    }
  }

  /** Drop the root: the bass has it, and 3–7–9–13 is where the colour lives. */
  private rootlessChord(): T.Chord {
    const c = this.chord;
    if (c.tones.length < 5) return c;
    const tones = c.tones.slice(1);
    const pcs: number[] = [];
    for (const p of tones) {
      const pc = ((p % 12) + 12) % 12;
      if (!pcs.includes(pc)) pcs.push(pc);
    }
    return { ...c, tones, pcs };
  }

  /* ---- plucked strings ---- */

  private emitPluck(bar: number, step: number, t: number): void {
    const cfg = this.layer('pluck');
    if (!cfg) return;
    const eighth = step % 2 === 0;
    if (!eighth) return;
    const g = this.ramp(cfg);
    const p = (0.16 + this.intensity * 0.38) * (cfg.density ?? 1);
    if (this.rng.next() > p) return;

    const tones = T.chordTonesInRange(this.chord, R.pluckLow, R.pluckHigh);
    if (!tones.length) return;
    // Walk the arpeggio rather than picking at random: an arpeggio is a line.
    this.pluckIdx += this.rng.chance(0.72) ? 1 : -1;
    if (this.pluckIdx < 0) this.pluckIdx = tones.length - 1;
    const midi = tones[this.pluckIdx % tones.length];
    I.pluck(this.synth, this.dry, t + T.humanize(this.rng, 10), midi, {
      vel: g * this.rng.range(0.45, 0.85),
      bright: this.plan.bright,
      pan: this.rng.range(-0.5, 0.5),
      send: 1,
      echo: 0.6,
    });
  }

  /* ---- lead ---- */

  private emitLead(bar: number, step: number, t: number): void {
    const cfg = this.layer('lead');
    if (!cfg || !this.phraseOn) return;
    if (step % 2 !== 0) return;
    const abs = bar * STEPS_PER_BAR + step;
    if (abs < this.leadFreeAt) return;
    const g = this.ramp(cfg);

    const onBeat = step % 4 === 0;
    const p = (onBeat ? 0.3 : 0.42) * (0.45 + this.intensity * 0.8) * (cfg.density ?? 1);
    if (this.rng.next() > p) {
      this.leadFreeAt = abs + 2;
      return;
    }

    const mode = this.plan.colour ?? this.plan.mode;
    // Random walk by scale steps, then pulled onto a chord tone on the strong
    // beats. Steps most of the time, the occasional leap, and a hard reflection
    // at the edges of the register so phrases arch instead of drifting away.
    const move = this.rng.weighted<number>([
      [1, 3],
      [-1, 3],
      [2, 2],
      [-2, 2],
      [3, 1],
      [-3, 1],
      [5, 0.5],
      [-5, 0.5],
      [0, 0.6],
    ]);
    const deg = T.degreeOf(this.leadMidi, mode, this.keyRoot) + move;
    let midi = T.pitchAt(T.MODES[mode], this.keyRoot + 48, deg);
    if (onBeat && this.rng.chance(0.7)) {
      const tones = T.chordTonesInRange(this.chord, R.leadLow, R.leadHigh);
      let best = midi;
      let bd = Infinity;
      for (const c of tones) {
        const d = Math.abs(c - midi);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      midi = best;
    }
    if (midi > R.leadHigh) midi -= 12;
    if (midi < R.leadLow) midi += 12;
    this.leadMidi = clamp(midi, R.leadLow, R.leadHigh);

    const steps = this.rng.weighted<number>([
      [2, 3],
      [4, 3],
      [6, 1.5],
      [8, 1],
      [12, 0.4],
      [1, 0.8],
    ]);
    const dur = (steps / 4) * this.beat * this.rng.range(0.8, 0.98);
    this.leadFreeAt = abs + steps + (this.rng.chance(0.45) ? 2 : 0);

    I.lead(this.synth, this.dry, t + T.humanize(this.rng, 16), mtof(this.leadMidi), {
      vel: g * this.rng.range(0.5, 0.9),
      dur,
      pan: this.rng.range(-0.2, 0.2),
      send: 1,
      echo: 0.8,
      room: 0.3,
      priority: PRIORITY.musicLead,
    });
  }

  /* ---- bells ---- */

  private emitBell(bar: number, step: number, t: number): void {
    const cfg = this.layer('bell');
    if (!cfg) return;
    if (step % 2 !== 0) return;
    const g = this.ramp(cfg);
    const p = (0.045 + this.intensity * 0.1) * (cfg.density ?? 1);
    if (this.rng.next() > p) return;

    const mode = this.plan.colour ?? this.plan.mode;
    const tones = this.rng.chance(0.65) ? T.chordTonesInRange(this.chord, R.bellLow, R.bellHigh) : [];
    let midi: number;
    if (tones.length) midi = this.rng.pick(tones);
    else midi = T.pitchAt(T.MODES[mode], this.keyRoot + 72, this.rng.int(0, T.MODES[mode].length * 2));
    midi = clamp(midi, R.bellLow, R.bellHigh);
    I.bell(this.synth, this.dry, t + T.humanize(this.rng, 22), mtof(midi), {
      vel: g * this.rng.range(0.3, 0.7),
      pan: this.rng.range(-0.7, 0.7),
      send: 1.4,
      echo: 0.9,
    });
  }

  /* ---- brushes and ride ---- */

  private emitPerc(bar: number, step: number, t: number): void {
    const rideCfg = this.layer('ride');
    if (rideCfg) {
      const g = this.ramp(rideCfg);
      // The jazz ride: 1, 2, 2-and, 3, 4, 4-and — with hits dropped at random,
      // because a drummer who plays all six every bar is a drum machine.
      const isQuarter = step % 4 === 0;
      const isAnd = step === 6 || step === 14;
      if (isQuarter || isAnd) {
        const keep = isQuarter ? 0.93 : 0.55 + this.intensity * 0.4;
        if (this.rng.next() < keep) {
          const accent = step === 4 || step === 12;
          I.ride(this.synth, this.dry, t + T.humanize(this.rng, 11), {
            vel: (accent ? 0.62 : isAnd ? 0.34 : 0.46) * g * this.rng.range(0.85, 1.15),
            pan: 0.34,
            send: 0.6,
            room: 0.6,
          });
        }
      }
    }

    const brushCfg = this.layer('brush');
    if (brushCfg) {
      const g = this.ramp(brushCfg);
      if (step % 4 === 0) {
        // A continuous circular swirl, one stroke per beat.
        I.brush(this.synth, this.dry, t, {
          vel: (step === 0 ? 0.42 : 0.3) * g,
          dur: this.beat * 0.9,
          attack: this.beat * 0.35,
          pan: -0.25,
          send: 0.3,
          room: 0.7,
        });
      }
      if ((step === 4 || step === 12) && this.rng.chance(0.45 + this.intensity * 0.3)) {
        I.snare(this.synth, this.dry, t + T.humanize(this.rng, 10), { vel: 0.34 * g, pan: -0.15, send: 0.4, room: 0.7 });
      }
    }

    const kickCfg = this.layer('kick');
    if (kickCfg && step % 8 === 0 && this.rng.chance(0.7)) {
      I.kick(this.synth, this.dry, t, { vel: (step === 0 ? 0.7 : 0.45) * this.ramp(kickCfg), send: 0.3 });
    }
  }

  dispose(): void {
    for (const n of [this.dry, this.level, this.spaceIn, this.roomIn, this.echoIn, ...this.amts]) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
  }
}

/** Karplus buffers are expensive and pitch-identical across sections. */
const SHARED_STRINGS = new Map<number, AudioBuffer>();

/* ═══════════════════════════════════════════════════════════════════════════
   Director
   ═══════════════════════════════════════════════════════════════════════════ */

const TICK_MS = 25;
const LOOKAHEAD = 0.12;
/** When the tab is hidden, timers throttle to ~1 Hz; schedule further out. */
const LOOKAHEAD_HIDDEN = 1.8;

export class MusicDirector {
  private ctx: AudioContext;
  private graph: AudioGraph;
  private pool: VoicePool;
  private rng: Rng;

  private sections: Section[] = [];
  private current: Section | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private counter = 0;

  private moodNow: MusicMood = 'silence';
  private moodWanted: MusicMood = 'silence';
  private intensity = 0.6;
  private keyRoot = 2; // D — dark enough for the drones, open enough for the horn
  private lastVoicing: number[] = [];
  private running = false;

  constructor(ctx: AudioContext, graph: AudioGraph, pool: VoicePool, seed: string | number = 'aeon-score') {
    this.ctx = ctx;
    this.graph = graph;
    this.pool = pool;
    this.rng = new Rng(seed);
  }

  get mood(): MusicMood {
    return this.moodWanted;
  }

  get level(): number {
    return this.intensity;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.timer === null) this.timer = setInterval(() => this.tick(), TICK_MS);
    // Whatever was asked for while the context was asleep starts now.
    if (this.moodWanted !== 'silence' && !this.current) this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setMood(mood: MusicMood, intensity = this.intensity): void {
    this.intensity = clamp(intensity, 0, 1);
    if (mood === this.moodWanted) {
      if (this.current) this.current.setIntensity(this.intensity);
      return;
    }
    this.moodWanted = mood;
    // The switch itself happens in tick(), on a bar line.
  }

  setIntensity(v: number): void {
    this.intensity = clamp(v, 0, 1);
    if (this.current) this.current.setIntensity(this.intensity);
  }

  /** Force the tonic. Realms use this to give a star system its own key. */
  setKey(pitchClass: number): void {
    this.keyRoot = ((Math.round(pitchClass) % 12) + 12) % 12;
  }

  tick(): void {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const horizon = now + (hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD);

    if (this.moodWanted !== this.moodNow) this.considerSwitch(now, horizon);

    for (let i = this.sections.length - 1; i >= 0; i--) {
      const s = this.sections[i];
      s.scheduleUntil(horizon);
      if (now > s.deadAt) {
        s.dispose();
        this.sections.splice(i, 1);
        if (this.current === s) this.current = null;
      }
    }
  }

  /**
   * Wait for a bar line. Everything about a mood change — the new pulse, the
   * new instruments, the fade — is anchored to it, so the listener experiences
   * a modulation rather than an edit.
   */
  private considerSwitch(now: number, horizon: number): void {
    const at = this.current ? this.current.nextBarTime(now + 0.12) : now + 0.05;
    if (at > horizon) return;

    const plan = PLANS[this.moodWanted];
    const outgoing = this.current;
    const fade = clamp(plan ? plan.fade : 6, 4, 12);

    if (outgoing) {
      // Keep playing for up to a bar past the switch so the two bands overlap,
      // then let the tails ring through the rest of the fade.
      const overlap = Math.min(outgoing.barDur, fade * 0.4);
      outgoing.stopAt = at + overlap;
      outgoing.fadeTo(0, fade, at + fade);
      outgoing.deadAt = at + fade + 9;
      this.lastVoicing = outgoing.voicing;
    }

    this.moodNow = this.moodWanted;
    this.current = null;

    if (!plan) {
      this.graph.setDelayTime(0.36, 0.2, 2);
      return;
    }

    // The tonic moves only when the mood explicitly asks for it — arrival lifts
    // a fourth. Otherwise the harmony is literally shared across the seam.
    this.keyRoot = ((this.keyRoot + plan.rootOffset) % 12 + 12) % 12;

    const s = new Section(
      this.moodNow,
      plan,
      this.ctx,
      this.graph,
      this.pool,
      this.keyRoot,
      at,
      this.intensity,
      this.rng.int(0, 0x7fffffff) ^ (this.counter++ << 7),
      this.lastVoicing,
    );
    s.fadeTo(1, fade, at + fade * (outgoing ? 0.85 : 0.5));
    this.sections.push(s);
    this.current = s;
    this.graph.setDelayTime(s.beat * plan.echoBeats, lerp(0.2, 0.5, plan.echo), fade * 0.5);
  }

  /** Per-frame backstop: browsers throttle timers, requestAnimationFrame less so. */
  update(_dt: number): void {
    if (this.running) this.tick();
  }

  dispose(): void {
    this.stop();
    for (const s of this.sections) {
      s.fadeTo(0, 0.05, this.ctx.currentTime + 0.05);
      s.dispose();
    }
    this.sections.length = 0;
    this.current = null;
    SHARED_STRINGS.clear();
  }
}
