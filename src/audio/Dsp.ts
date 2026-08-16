/**
 * Signal primitives.
 *
 * There are no audio files in ÆON and there never will be, so every sample the
 * player hears starts here: noise we fill ourselves, impulse responses we decay
 * ourselves, string models we pluck ourselves. Nothing in this file touches the
 * graph — it only makes buffers and numbers, which makes it cheap to test and
 * safe to call before the AudioContext is running.
 */

import { Rng } from '../core/Rand';

export const TAU = Math.PI * 2;

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** MIDI note → Hz. A4 = 69 = 440 Hz. */
export function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function ftom(f: number): number {
  return 69 + 12 * Math.log2(Math.max(1e-6, f) / 440);
}

/** Exponential ramps hate zero; this is the floor we ramp to instead. */
export const EPS = 0.0001;

/* ═══════════════════════════════════════════════════════════════════════════
   Filters we run ourselves, for baking buffers offline
   ═══════════════════════════════════════════════════════════════════════════ */

/** One-pole smoother. `a` is the per-sample coefficient from `poleCoeff`. */
export class OnePole {
  private y = 0;
  constructor(private a = 0.1) {}
  set(a: number): void {
    this.a = clamp(a, 0, 1);
  }
  lp(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
  hp(x: number): number {
    this.y += this.a * (x - this.y);
    return x - this.y;
  }
  reset(v = 0): void {
    this.y = v;
  }
}

export function poleCoeff(cutoffHz: number, sampleRate: number): number {
  return clamp(1 - Math.exp((-TAU * cutoffHz) / sampleRate), 0, 1);
}

/** RBJ biquad, used only for baking. The graph uses BiquadFilterNode. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  lowpass(sr: number, f: number, q = 0.707): this {
    const w = (TAU * clamp(f, 10, sr * 0.49)) / sr;
    const c = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    this.norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
    return this;
  }

  highpass(sr: number, f: number, q = 0.707): this {
    const w = (TAU * clamp(f, 10, sr * 0.49)) / sr;
    const c = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    this.norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
    return this;
  }

  bandpass(sr: number, f: number, q = 1): this {
    const w = (TAU * clamp(f, 10, sr * 0.49)) / sr;
    const c = Math.cos(w);
    const s = Math.sin(w);
    const al = s / (2 * q);
    this.norm(al, 0, -al, 1 + al, -2 * c, 1 - al);
    return this;
  }

  peaking(sr: number, f: number, q: number, gainDb: number): this {
    const A = Math.pow(10, gainDb / 40);
    const w = (TAU * clamp(f, 10, sr * 0.49)) / sr;
    const c = Math.cos(w);
    const al = Math.sin(w) / (2 * q);
    this.norm(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
    return this;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): this {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    return this;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Noise
   ═══════════════════════════════════════════════════════════════════════════ */

export function fillWhite(data: Float32Array, rng: Rng): void {
  for (let i = 0; i < data.length; i++) data[i] = rng.next() * 2 - 1;
}

/** Pink (−3 dB/oct) via Paul Kellet's economy filter. Cheap and close enough. */
export function fillPink(data: Float32Array, rng: Rng): void {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
  }
}

/** Brown (−6 dB/oct) — the bones of thunder, lava and engine rumble. */
export function fillBrown(data: Float32Array, rng: Rng): void {
  let y = 0;
  for (let i = 0; i < data.length; i++) {
    y = (y + (rng.next() * 2 - 1) * 0.06) * 0.996;
    data[i] = clamp(y * 3.2, -1, 1);
  }
}

export type NoiseKind = 'white' | 'pink' | 'brown';

export function noiseBuffer(ctx: BaseAudioContext, seconds: number, kind: NoiseKind, rng: Rng, channels = 2): AudioBuffer {
  const len = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    if (kind === 'pink') fillPink(d, rng);
    else if (kind === 'brown') fillBrown(d, rng);
    else fillWhite(d, rng);
  }
  return buf;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Reverb impulse responses
   ═══════════════════════════════════════════════════════════════════════════ */

export interface IrOptions {
  /** Tail length in seconds — 5 s for the void, 0.7 s for a corridor. */
  seconds: number;
  /** Shape of the decay. 1 = exponential, >1 collapses faster at the end. */
  decay?: number;
  /** Top of the tail's low-pass at t=0, Hz. */
  openHz?: number;
  /** Where the low-pass has fallen to by the end of the tail, Hz. High
   *  frequencies die first in air and in soft rooms; this is what sells size. */
  closeHz?: number;
  /** Seconds of silence before the tail — distance to the first wall. */
  predelay?: number;
  /** 0 = mono-ish, 1 = fully decorrelated channels. */
  width?: number;
  /** Discrete early reflections sprinkled into the first ~120 ms. */
  earlyCount?: number;
  earlyGain?: number;
}

/**
 * Exponentially decaying, progressively darkening filtered noise. Real rooms
 * lose their highs long before their lows, so the low-pass sweeps down across
 * the tail — without that a convolution reverb sounds like a hiss gate.
 */
export function impulseResponse(ctx: BaseAudioContext, o: IrOptions, rng: Rng): AudioBuffer {
  const sr = ctx.sampleRate;
  const seconds = clamp(o.seconds, 0.05, 12);
  const pre = Math.floor(clamp(o.predelay ?? 0, 0, 0.3) * sr);
  const len = Math.max(8, Math.floor(seconds * sr) + pre);
  const decay = o.decay ?? 1.6;
  const openHz = o.openHz ?? 9000;
  const closeHz = o.closeHz ?? 420;
  const width = clamp(o.width ?? 0.85, 0, 1);
  const buf = ctx.createBuffer(2, len, sr);

  // A shared noise stream plus a per-channel one, blended by `width`. At width 1
  // the channels are independent, which is what makes a reverb feel wide.
  const shared = new Float32Array(len);
  fillWhite(shared, rng.fork('ir-shared'));

  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const own = rng.fork(`ir-${c}`);
    const lp = new OnePole(poleCoeff(openHz, sr));
    const hp = new OnePole(poleCoeff(45, sr));
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const u = t / seconds;
      const env = Math.exp(-6.5 * Math.pow(u, decay > 1 ? 1 : 1) * decay) * (1 - u);
      const n = lerp(shared[i], own.next() * 2 - 1, width);
      lp.set(poleCoeff(lerp(openHz, closeHz, Math.pow(u, 0.55)), sr));
      d[i] = hp.hp(lp.lp(n)) * env;
    }
    // Early reflections: a handful of discrete taps give the ear something to
    // measure the room with before the diffuse tail arrives.
    const taps = o.earlyCount ?? 7;
    const eg = o.earlyGain ?? 0.5;
    for (let k = 0; k < taps; k++) {
      const at = pre + Math.floor(own.range(0.004, 0.12) * sr);
      if (at < len) d[at] += own.range(-1, 1) * eg * Math.pow(0.72, k);
    }
  }

  // Normalise to a predictable peak; ConvolverNode's own normalisation then
  // keeps long and short reverbs at comparable loudness.
  let peak = 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  if (peak > 0) {
    const g = 0.85 / peak;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] *= g;
    }
  }
  return buf;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Karplus–Strong
   ═══════════════════════════════════════════════════════════════════════════ */

export interface StringOptions {
  /** −60 dB time in seconds. */
  decay?: number;
  /** 0 = felt-muted, 1 = steel and bright. */
  brightness?: number;
  /** Pick position as a fraction of the string; comb-filters the excitation. */
  pick?: number;
  /** Slight inharmonicity, as a fraction. Real strings are never perfect. */
  detune?: number;
}

/**
 * A plucked string, rendered into a buffer rather than run as a live feedback
 * loop. Web Audio adds a 128-sample delay to any cycle in the graph, which puts
 * a hard ceiling on the pitch a DelayNode loop can reach; doing the recurrence
 * ourselves costs a millisecond and gives exact tuning at any pitch.
 */
export function karplusBuffer(ctx: BaseAudioContext, freq: number, seconds: number, o: StringOptions, rng: Rng): AudioBuffer {
  const sr = ctx.sampleRate;
  const f = clamp(freq, 20, sr / 4);
  const n = Math.max(2, Math.round(sr / f));
  const len = Math.max(64, Math.floor(seconds * sr));
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);

  const bright = clamp(o.brightness ?? 0.6, 0, 1);
  const t60 = clamp(o.decay ?? 2.2, 0.05, 20);
  const pickPos = clamp(o.pick ?? 0.22, 0.02, 0.5);

  // Excitation: noise, low-passed by `brightness`, then comb-filtered by the
  // pick position (a plectrum near the bridge kills the low partials).
  const line = new Float32Array(n);
  const exLp = new OnePole(poleCoeff(lerp(900, 9000, bright), sr));
  for (let i = 0; i < n; i++) line[i] = exLp.lp(rng.next() * 2 - 1);
  const off = Math.max(1, Math.floor(n * pickPos));
  const combed = new Float32Array(n);
  for (let i = 0; i < n; i++) combed[i] = line[i] - line[(i + off) % n] * 0.85;
  // Remove DC so the string does not walk off centre.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += combed[i];
  mean /= n;
  for (let i = 0; i < n; i++) line[i] = combed[i] - mean;

  const perSample = Math.exp(-6.9078 / (t60 * sr));
  const damp = new OnePole(poleCoeff(lerp(1200, 7000, bright), sr));
  const drift = (o.detune ?? 0) * 0.0004;
  let idx = 0;
  let prev = 0;
  for (let i = 0; i < len; i++) {
    const cur = line[idx];
    // Averaging the two most recent taps is the classic KS low-pass: it makes
    // the high partials decay faster than the low ones, exactly like a string.
    let y = 0.5 * (cur + prev) * perSample;
    y = lerp(y, damp.lp(y), 0.65);
    if (drift) y += drift * (rng.next() - 0.5);
    line[idx] = y;
    prev = cur;
    out[i] = y;
    idx = idx + 1 >= n ? 0 : idx + 1;
  }

  // Fade the last 30 ms so looping/stopping never clicks.
  const fade = Math.min(len, Math.floor(0.03 * sr));
  for (let i = 0; i < fade; i++) out[len - 1 - i] *= i / fade;
  return buf;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Wave shaping
   ═══════════════════════════════════════════════════════════════════════════ */

/** tanh saturation curve for WaveShaperNode. `amount` 0 = clean, 8 = fuzzy. */
export function saturationCurve(amount: number, n = 2048): Float32Array {
  const c = new Float32Array(n);
  const a = Math.max(0.001, amount);
  const norm = Math.tanh(a);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(a * x) / norm;
  }
  return c;
}

/** Asymmetric soft clip — adds even harmonics, good for brass and engines. */
export function brassCurve(amount: number, n = 2048): Float32Array<ArrayBuffer> {
  const c = new Float32Array(new ArrayBuffer(n * 4));
  const a = Math.max(0.001, amount);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const s = x >= 0 ? Math.tanh(a * x) : Math.tanh(a * 0.72 * x);
    c[i] = s / Math.tanh(a);
  }
  return c;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Buffer baking helpers (used by the SFX bank)
   ═══════════════════════════════════════════════════════════════════════════ */

/** Percussive envelope: fast attack, exponential-ish decay, in [0,1]. */
export function hit(t: number, attack: number, decay: number, curve = 2.2): number {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  const u = (t - attack) / decay;
  return u >= 1 ? 0 : Math.pow(1 - u, curve);
}

/** Create a buffer and let a callback write each channel. */
export function bake(
  ctx: BaseAudioContext,
  seconds: number,
  channels: number,
  fn: (data: Float32Array, channel: number, sr: number) => void,
): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(channels, Math.max(1, Math.floor(seconds * sr)), sr);
  for (let c = 0; c < channels; c++) fn(buf.getChannelData(c), c, sr);
  return buf;
}

/** Peak-normalise a baked buffer to `peak`, in place. */
export function normalize(buf: AudioBuffer, peak = 0.9): AudioBuffer {
  let m = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  }
  if (m > 1e-6) {
    const g = peak / m;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= g;
    }
  }
  return buf;
}
