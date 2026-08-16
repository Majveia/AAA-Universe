/**
 * The band.
 *
 * Eight instruments, all built from oscillators, noise and filters, all voiced
 * through the pool so nothing leaks. They share one shape: hand it a start time
 * and a frequency, and it schedules itself completely — no per-frame babysitting,
 * because the scheduler runs 100 ms ahead of the clock and a note that needs
 * tending after it starts will be late.
 *
 * Art direction: warm, slightly imperfect, never bright for its own sake. Every
 * voice detunes, drifts or breathes a little. That is the whole difference
 * between "a synth" and "a player".
 */

import { Rng } from '../core/Rand';
import { EPS, clamp, karplusBuffer, lerp, mtof, saturationCurve, brassCurve } from './Dsp';
import { PRIORITY, Voice, VoicePool } from './Voices';

export interface SynthCtx {
  ctx: AudioContext;
  pool: VoicePool;
  /** Shared looping white noise. */
  noise: AudioBuffer;
  rng: Rng;
  /** Post-fader send hubs, or null when this context has no effects. */
  space: AudioNode | null;
  room: AudioNode | null;
  echo: AudioNode | null;
  /** Karplus–Strong buffers, one per pitch class, built on demand. */
  strings: Map<number, AudioBuffer>;
}

export interface NoteOpts {
  /** 0–1. Drives level *and* timbre — hitting harder should sound different. */
  vel?: number;
  /** Seconds the note is held before its release begins. */
  dur?: number;
  pan?: number;
  /** Multiplier on the section's reverb send. */
  send?: number;
  room?: number;
  echo?: number;
  /** 0–1 filter tilt. */
  bright?: number;
  detune?: number;
  attack?: number;
  release?: number;
  priority?: number;
}

function panner(S: SynthCtx, v: Voice, pan: number | undefined): AudioNode {
  if (pan === undefined || Math.abs(pan) < 0.001) return v.gain;
  const p = v.track(S.ctx.createStereoPanner());
  p.pan.value = clamp(pan, -1, 1);
  p.connect(v.gain);
  return p;
}

function sends(v: Voice, S: SynthCtx, o: NoteOpts, defSpace = 1, defRoom = 1): void {
  v.send(S.space, (o.send ?? 1) * defSpace);
  v.send(S.room, (o.room ?? 0) * defRoom);
  if (o.echo) v.send(S.echo, o.echo);
}

/** A slice of the shared noise buffer, started at a random offset. */
function noiseSource(S: SynthCtx, v: Voice, start: number, stop: number, rate = 1): AudioBufferSourceNode {
  const n = S.ctx.createBufferSource();
  n.buffer = S.noise;
  n.loop = true;
  n.playbackRate.value = rate;
  n.loopStart = 0;
  n.loopEnd = S.noise.duration;
  const off = S.rng.range(0, S.noise.duration * 0.9);
  v.track(n);
  try {
    n.start(Math.max(start, S.ctx.currentTime), off);
    n.stop(Math.max(stop, start + 0.01));
  } catch {
    /* ignore */
  }
  return n;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Rhodes-ish electric piano — 2-operator FM with a tine transient
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The Rhodes trick is that the bark and the body are two different sounds: a
 * high-ratio ping that dies in 100 ms, and a nearly pure sine that rings for
 * seconds. Modulating a 1:1 pair with a fast-decaying index gives the body its
 * hollow bell edge; a separate 14:1 operator gives the hammer hitting the tine.
 */
export function rhodes(S: SynthCtx, dest: AudioNode, t: number, freq: number, o: NoteOpts = {}): void {
  const ctx = S.ctx;
  const vel = clamp(o.vel ?? 0.7, 0.05, 1);
  const dur = o.dur ?? 1.4;
  const ring = clamp(dur * 0.5 + 1.6 - freq / 900, 0.5, 3.2);
  const end = t + dur + ring;
  const v = S.pool.alloc(dest, o.priority ?? PRIORITY.music, t, end);
  if (!v) return;

  const out = panner(S, v, o.pan);
  const amp = v.track(ctx.createGain());
  const tone = v.track(ctx.createBiquadFilter());
  tone.type = 'lowpass';
  tone.frequency.setValueAtTime(clamp(freq * lerp(6, 13, vel), 700, 9000), t);
  tone.frequency.exponentialRampToValueAtTime(clamp(freq * 3.2, 300, 3600), t + 0.9);
  tone.Q.value = 0.4;
  tone.connect(amp);
  amp.connect(out);

  const car = v.track(ctx.createOscillator());
  car.type = 'sine';
  car.frequency.value = freq;
  car.detune.value = (o.detune ?? 0) + S.rng.range(-4, 4);
  const idx = v.track(ctx.createGain());
  const modOsc = v.track(ctx.createOscillator());
  modOsc.type = 'sine';
  modOsc.frequency.value = freq;
  const peak = freq * lerp(1.6, 4.4, vel);
  idx.gain.setValueAtTime(peak, t);
  idx.gain.exponentialRampToValueAtTime(Math.max(1, peak * 0.03), t + 0.5);
  modOsc.connect(idx).connect(car.frequency);
  car.connect(tone);

  // The tine: high ratio, gone almost immediately, but it is what makes the ear
  // say "electric piano" instead of "sine".
  const tine = v.track(ctx.createOscillator());
  tine.type = 'sine';
  tine.frequency.value = freq * 13.7;
  const tineGain = v.track(ctx.createGain());
  tineGain.gain.setValueAtTime(0.13 * vel * vel, t);
  tineGain.gain.exponentialRampToValueAtTime(EPS, t + 0.16);
  tine.connect(tineGain).connect(amp);

  const level = 0.34 * vel;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + 0.006);
  amp.gain.exponentialRampToValueAtTime(Math.max(EPS, level * 0.28), t + dur * 0.6 + 0.35);
  amp.gain.exponentialRampToValueAtTime(EPS, end);

  v.source(car, t, end);
  v.source(modOsc, t, end);
  v.source(tine, t, t + 0.25);
  sends(v, S, o, 0.8);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Filtered saw pad
   ═══════════════════════════════════════════════════════════════════════════ */

export function pad(S: SynthCtx, dest: AudioNode, t: number, freq: number, o: NoteOpts = {}): void {
  const ctx = S.ctx;
  const vel = clamp(o.vel ?? 0.5, 0.03, 1);
  const dur = o.dur ?? 4;
  const atk = o.attack ?? clamp(dur * 0.35, 0.4, 2.6);
  const rel = o.release ?? clamp(dur * 0.5, 0.8, 4);
  const end = t + dur + rel;
  const v = S.pool.alloc(dest, o.priority ?? PRIORITY.music, t, end);
  if (!v) return;

  const out = panner(S, v, o.pan);
  const amp = v.track(ctx.createGain());
  amp.connect(out);

  const lp = v.track(ctx.createBiquadFilter());
  lp.type = 'lowpass';
  lp.Q.value = 3.2;
  const bright = o.bright ?? 0.5;
  const openHz = clamp(freq * lerp(3, 11, bright) * lerp(0.6, 1.2, vel), 180, 7000);
  lp.frequency.setValueAtTime(clamp(freq * 1.6, 90, 900), t);
  lp.frequency.linearRampToValueAtTime(openHz, t + atk * 1.15);
  lp.frequency.linearRampToValueAtTime(clamp(openHz * 0.55, 140, 5000), end);
  lp.connect(amp);

  // A slow filter LFO stops the pad from sitting still. 0.06–0.13 Hz is below
  // conscious notice but the ear tracks it, which is why pads breathe.
  const lfo = v.track(ctx.createOscillator());
  lfo.type = 'sine';
  lfo.frequency.value = S.rng.range(0.05, 0.14);
  const lfoAmt = v.track(ctx.createGain());
  lfoAmt.gain.value = openHz * 0.22;
  lfo.connect(lfoAmt).connect(lp.frequency);
  v.source(lfo, t, end);

  const spread = [-9, 7];
  for (let i = 0; i < spread.length; i++) {
    const osc = v.track(ctx.createOscillator());
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    osc.detune.value = spread[i] + (o.detune ?? 0) + S.rng.range(-3, 3);
    const p = v.track(ctx.createStereoPanner());
    p.pan.value = i === 0 ? -0.45 : 0.45;
    osc.connect(p).connect(lp);
    v.source(osc, t, end);
  }
  // A sine an octave down gives the chord a floor without muddying the saws.
  const sub = v.track(ctx.createOscillator());
  sub.type = 'sine';
  sub.frequency.value = freq * 0.5;
  const subG = v.track(ctx.createGain());
  subG.gain.value = 0.35;
  sub.connect(subG).connect(amp);
  v.source(sub, t, end);

  const level = 0.09 * vel;
  amp.gain.setValueAtTime(EPS, t);
  amp.gain.exponentialRampToValueAtTime(level, t + atk);
  amp.gain.setValueAtTime(level, t + dur);
  amp.gain.exponentialRampToValueAtTime(EPS, end);
  sends(v, S, o, 1);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Drone — the Vangelis floor
   ═══════════════════════════════════════════════════════════════════════════ */

export function drone(S: SynthCtx, dest: AudioNode, t: number, freq: number, o: NoteOpts = {}): void {
  const ctx = S.ctx;
  const vel = clamp(o.vel ?? 0.5, 0.03, 1);
  const dur = o.dur ?? 16;
  const atk = o.attack ?? 6;
  const rel = o.release ?? 8;
  const end = t + dur + rel;
  const v = S.pool.alloc(dest, o.priority ?? PRIORITY.music, t, end);
  if (!v) return;

  const amp = v.track(ctx.createGain());
  amp.connect(panner(S, v, o.pan));
  const lp = v.track(ctx.createBiquadFilter());
  lp.type = 'lowpass';
  lp.frequency.value = clamp(freq * lerp(4, 9, o.bright ?? 0.4), 200, 3000);
  lp.Q.value = 0.8;
  lp.connect(amp);

  // Three voices a few cents apart beat against each other over tens of
  // seconds. That slow interference *is* the sound; a single oscillator here
  // would be dead on arrival.
  const cents = [-7, 0, 6.5];
  for (let i = 0; i < cents.length; i++) {
    const osc = v.track(ctx.createOscillator());
    osc.type = i === 1 ? 'sine' : 'triangle';
    osc.frequency.value = freq;
    osc.detune.value = cents[i] + S.rng.range(-1.5, 1.5);
    const g = v.track(ctx.createGain());
    g.gain.value = i === 1 ? 0.55 : 0.32;
    const p = v.track(ctx.createStereoPanner());
    p.pan.value = (i - 1) * 0.6;
    osc.connect(g).connect(p).connect(lp);
    v.source(osc, t, end);
  }

  const level = 0.13 * vel;
  amp.gain.setValueAtTime(EPS, t);
  amp.gain.exponentialRampToValueAtTime(level, t + atk);
  amp.gain.setValueAtTime(level, t + dur);
  amp.gain.exponentialRampToValueAtTime(EPS, end);
  sends(v, S, o, 1.3);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Karplus–Strong pluck
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * One buffer per pitch class, transposed by whole octaves at playback. Because
 * the rate change is always a power of two the timbre survives intact, and the
 * decay shortens with pitch — which is what real strings do anyway.
 */
function stringBuffer(S: SynthCtx, midi: number): { buf: AudioBuffer; rate: number } {
  const base = 48 + ((((midi - 48) % 12) + 12) % 12);
  let buf = S.strings.get(base);
  if (!buf) {
    buf = karplusBuffer(S.ctx, mtof(base), 2.4, { decay: 2.6, brightness: 0.62, pick: 0.19, detune: 0.4 }, new Rng(`ks-${base}`));
    S.strings.set(base, buf);
  }
  return { buf, rate: Math.pow(2, (midi - base) / 12) };
}

export function pluck(S: SynthCtx, dest: AudioNode, t: number, midi: number, o: NoteOpts = {}): void {
  const ctx = S.ctx;
  const vel = clamp(o.vel ?? 0.7, 0.05, 1);
  const { buf, rate } = stringBuffer(S, Math.round(clamp(midi, 28, 96)));
  const natural = buf.duration / rate;
  const dur = Math.min(o.dur ?? natural, natural);
  const end = t + dur + 0.12;
  const v = S.pool.alloc(dest, o.priority ?? PRIORITY.music, t, end);
  if (!v) return;

  const src = v.track(ctx.createBufferSource());
  src.buffer = buf;
  src.playbackRate.value = rate * Math.pow(2, (o.detune ?? 0) / 1200);
  const amp = v.track(ctx.createGain());
  const tone = v.track(ctx.createBiquadFilter());
  tone.type = 'lowpass';
  tone.frequency.value = clamp(mtof(midi) * lerp(4, 14, o.bright ?? 0.5), 500, 12000);
  tone.Q.value = 0.5;
  src.connect(tone).connect(amp).connect(panner(S, v, o.pan));

  const level = 0.42 * vel;
  amp.gain.setValueAtTime(level, t);
  // Damping the string early is a performance gesture, not an edit.
  if (dur < natural - 0.05) amp.gain.setTargetAtTime(EPS, t + dur, 0.03);
  v.source(src, t, end);
  sends(v, S, o, 0.9);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Breathy lead — the muted trumpet
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Sine plus triangle for the body, a band-passed noise layer riding the same
 * envelope for the air, delayed vibrato so the note settles before it wobbles,
 * and an asymmetric shaper that only bites when the player leans on it. Harmon
 * mutes are mostly upper-mid resonance, hence the fixed peak around 1.8 kHz.
 */
export function lead(S: SynthCtx, dest: AudioNode, t: number, freq: number, o: NoteOpts = {}): void {
  const ctx = S.ctx;
  const vel = clamp(o.vel ?? 0.7, 0.05, 1);
  const dur = o.dur ?? 0.8;
  const atk = o.attack ?? lerp(0.09, 0.035, vel);
  const rel = o.release ?? 0.32;
  const end = t + dur + rel;
  const v = S.pool.alloc(dest, o.priority ?? PRIORITY.musicLead, t, end);
  if (!v) return;

  const amp = v.track(ctx.createGain());
  const body = v.track(ctx.createGain());
  const shaper = v.track(ctx.createWaveShaper());
  shaper.curve = brassCurve(lerp(1.1, 3.4, vel));
  const mute = v.track(ctx.createBiquadFilter());
  mute.type = 'peaking';
  mute.frequency.value = 1800;
  mute.Q.value = 1.1;
  mute.gain.value = lerp(3, 9, vel);
  const lp = v.track(ctx.createBiquadFilter());
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(clamp(freq * 2.5, 400, 3000), t);
  lp.frequency.linearRampToValueAtTime(clamp(freq * lerp(5, 11, vel), 700, 8000), t + atk * 1.6);
  lp.Q.value = 0.7;
  body.connect(shaper).connect(mute).connect(lp).connect(amp);
  amp.connect(panner(S, v, o.pan));

  // Vibrato arrives late and grows, the way a player leans into a held note.
  const vib = v.track(ctx.createOscillator());
  vib.type = 'sine';
  vib.frequency.value = S.rng.range(4.6, 5.9);
  const vibAmt = v.track(ctx.createGain());
  vibAmt.gain.setValueAtTime(0, t);
  vibAmt.gain.setValueAtTime(0, t + Math.min(0.22, dur * 0.4));
  vibAmt.gain.linearRampToValueAtTime(lerp(3, 11, vel), t + Math.min(0.7, dur));
  vib.connect(vibAmt);
  v.source(vib, t, end);

  for (const [type, gain, det] of [['sine', 0.75, 0], ['triangle', 0.3, 5]] as const) {
    const osc = v.track(ctx.createOscillator());
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = det + (o.detune ?? 0);
    // A tiny scoop up into pitch: brass never arrives exactly in tune.
    osc.detune.setValueAtTime(det - lerp(22, 6, vel), t);
    osc.detune.linearRampToValueAtTime(det, t + atk * 1.4);
    vibAmt.connect(osc.detune);
    const g = v.track(ctx.createGain());
    g.gain.value = gain;
    osc.connect(g).connect(body);
    v.source(osc, t, end);
  }

  // Breath: noise band-passed at the fundamental's second partial.
  const bp = v.track(ctx.createBiquadFilter());
  bp.type = 'bandpass';
  bp.frequency.value = clamp(freq * 2.1, 200, 6000);
  bp.Q.value = 1.6;
  const air = v.track(ctx.createGain());
  air.gain.setValueAtTime(0, t);
  air.gain.linearRampToValueAtTime(0.16 * lerp(1.4, 0.55, vel), t + atk * 0.6);
  air.gain.setTargetAtTime(0.05, t + atk * 0.6, 0.35);
  noiseSource(S, v, t, end).connect(bp);
  bp.connect(air).connect(body);

  const level = 0.2 * vel;
  amp.gain.setValueAtTime(EPS, t);
  amp.gain.exponentialRampToValueAtTime(level, t + atk);
  amp.gain.setValueAtTime(level, t + dur);
  amp.gain.exponentialRampToValueAtTime(EPS, end);
  sends(v, S, o, 1.1);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Upright bass
   ═══════════════════════════════════════════════════════════════════════════ */

export function bass(S: SynthCtx, dest: AudioNode, t: number, freq: number, o: NoteOpts = {}): void {
  const ctx = S.ctx;
  const vel = clamp(o.vel ?? 0.8, 0.05, 1);
  const dur = o.dur ?? 0.5;
  const end = t + dur + 0.45;
  const v = S.pool.alloc(dest, o.priority ?? PRIORITY.music, t, end);
  if (!v) return;

  const amp = v.track(ctx.createGain());
  amp.connect(panner(S, v, o.pan));
  const lp = v.track(ctx.createBiquadFilter());
  lp.type = 'lowpass';
  lp.Q.value = 4.5;
  // The pluck *is* the filter envelope. Gut strings on a big box lose their
  // highs within a couple of hundred milliseconds.
  lp.frequency.setValueAtTime(clamp(freq * lerp(9, 20, vel), 300, 2600), t);
  lp.frequency.exponentialRampToValueAtTime(clamp(freq * 2.6, 90, 500), t + 0.22);
  lp.connect(amp);

  const osc = v.track(ctx.createOscillator());
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq * 1.03, t);
  osc.frequency.exponentialRampToValueAtTime(freq, t + 0.045);
  osc.detune.value = o.detune ?? 0;
  osc.connect(lp);
  v.source(osc, t, end);

  // Finger noise against the fingerboard.
  const click = v.track(ctx.createBiquadFilter());
  click.type = 'bandpass';
  click.frequency.value = 900;
  click.Q.value = 0.9;
  const clickG = v.track(ctx.createGain());
  clickG.gain.setValueAtTime(0.28 * vel, t);
  clickG.gain.exponentialRampToValueAtTime(EPS, t + 0.06);
  noiseSource(S, v, t, t + 0.08).connect(click);
  click.connect(clickG).connect(amp);

  const level = 0.5 * vel;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + 0.012);
  amp.gain.exponentialRampToValueAtTime(Math.max(EPS, level * 0.35), t + dur * 0.7);
  amp.gain.exponentialRampToValueAtTime(EPS, end);
  sends(v, S, o, 0.35);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Glass bell — FM with a deliberately irrational harmonicity
   ═══════════════════════════════════════════════════════════════════════════ */

export function bell(S: SynthCtx, dest: AudioNode, t: number, freq: number, o: NoteOpts = {}): void {
  const ctx = S.ctx;
  const vel = clamp(o.vel ?? 0.5, 0.03, 1);
  const dur = o.dur ?? clamp(7 - freq / 400, 1.6, 7);
  const end = t + dur;
  const v = S.pool.alloc(dest, o.priority ?? PRIORITY.music, t, end);
  if (!v) return;

  const amp = v.track(ctx.createGain());
  amp.connect(panner(S, v, o.pan ?? S.rng.range(-0.5, 0.5)));

  const car = v.track(ctx.createOscillator());
  car.type = 'sine';
  car.frequency.value = freq;
  const idx = v.track(ctx.createGain());
  const mod = v.track(ctx.createOscillator());
  mod.type = 'sine';
  // 3.51: far enough from an integer that the partials never line up, which is
  // exactly why struck glass and metal sound the way they do.
  mod.frequency.value = freq * 3.51;
  const peak = freq * lerp(2.2, 6.5, vel);
  idx.gain.setValueAtTime(peak, t);
  idx.gain.exponentialRampToValueAtTime(Math.max(1, peak * 0.012), t + dur * 0.45);
  mod.connect(idx).connect(car.frequency);
  car.connect(amp);
  v.source(car, t, end);
  v.source(mod, t, end);

  // A second, quieter partial well above the fundamental for the shimmer.
  const hi = v.track(ctx.createOscillator());
  hi.type = 'sine';
  hi.frequency.value = freq * 2.76;
  const hiG = v.track(ctx.createGain());
  hiG.gain.setValueAtTime(0.18 * vel, t);
  hiG.gain.exponentialRampToValueAtTime(EPS, t + dur * 0.55);
  hi.connect(hiG).connect(amp);
  v.source(hi, t, t + dur * 0.6);

  const level = 0.17 * vel;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + 0.004);
  amp.gain.exponentialRampToValueAtTime(EPS, end);
  sends(v, S, o, 1.6);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Brushes and ride
   ═══════════════════════════════════════════════════════════════════════════ */

/** The ride's "ding" — a bright noise transient over inharmonic partials. */
export function ride(S: SynthCtx, dest: AudioNode, t: number, o: NoteOpts = {}): void {
  const ctx = S.ctx;
  const vel = clamp(o.vel ?? 0.5, 0.03, 1);
  const dur = o.dur ?? lerp(0.5, 1.5, vel);
  const end = t + dur;
  const v = S.pool.alloc(dest, o.priority ?? PRIORITY.music, t, end);
  if (!v) return;

  const amp = v.track(ctx.createGain());
  amp.connect(panner(S, v, o.pan ?? 0.35));
  const hp = v.track(ctx.createBiquadFilter());
  hp.type = 'highpass';
  hp.frequency.value = 4200;
  const bp = v.track(ctx.createBiquadFilter());
  bp.type = 'bandpass';
  bp.frequency.value = 7200;
  bp.Q.value = 0.8;
  noiseSource(S, v, t, end, S.rng.range(0.95, 1.06)).connect(hp);
  hp.connect(bp).connect(amp);

  for (const r of [1, 1.83, 2.71]) {
    const osc = v.track(ctx.createOscillator());
    osc.type = 'sine';
    osc.frequency.value = 520 * r * S.rng.range(0.99, 1.01);
    const g = v.track(ctx.createGain());
    g.gain.setValueAtTime(0.05 * vel, t);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur * 0.7);
    osc.connect(g).connect(amp);
    v.source(osc, t, end);
  }

  const level = 0.16 * vel;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + 0.003);
  amp.gain.exponentialRampToValueAtTime(EPS, end);
  sends(v, S, o, 0.5, 0.4);
}

/** Brush on a snare head: a swirl, not a hit. */
export function brush(S: SynthCtx, dest: AudioNode, t: number, o: NoteOpts = {}): void {
  const ctx = S.ctx;
  const vel = clamp(o.vel ?? 0.4, 0.02, 1);
  const dur = o.dur ?? 0.35;
  const atk = o.attack ?? 0.02;
  const end = t + dur;
  const v = S.pool.alloc(dest, o.priority ?? PRIORITY.music, t, end);
  if (!v) return;

  const amp = v.track(ctx.createGain());
  amp.connect(panner(S, v, o.pan ?? -0.2));
  const bp = v.track(ctx.createBiquadFilter());
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(lerp(1400, 2600, vel), t);
  bp.frequency.linearRampToValueAtTime(900, end);
  bp.Q.value = 0.6;
  noiseSource(S, v, t, end, S.rng.range(0.9, 1.1)).connect(bp);
  bp.connect(amp);

  const level = 0.12 * vel;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + atk);
  amp.gain.exponentialRampToValueAtTime(EPS, end);
  sends(v, S, o, 0.35, 0.5);
}

/** A brushed rim/snare accent with a little body under it. */
export function snare(S: SynthCtx, dest: AudioNode, t: number, o: NoteOpts = {}): void {
  const ctx = S.ctx;
  const vel = clamp(o.vel ?? 0.5, 0.03, 1);
  const dur = o.dur ?? 0.22;
  const end = t + dur;
  const v = S.pool.alloc(dest, o.priority ?? PRIORITY.music, t, end);
  if (!v) return;

  const amp = v.track(ctx.createGain());
  amp.connect(panner(S, v, o.pan ?? -0.15));
  const hp = v.track(ctx.createBiquadFilter());
  hp.type = 'highpass';
  hp.frequency.value = 1200;
  noiseSource(S, v, t, end).connect(hp).connect(amp);

  const tone = v.track(ctx.createOscillator());
  tone.type = 'triangle';
  tone.frequency.setValueAtTime(230, t);
  tone.frequency.exponentialRampToValueAtTime(150, t + 0.08);
  const tg = v.track(ctx.createGain());
  tg.gain.setValueAtTime(0.22 * vel, t);
  tg.gain.exponentialRampToValueAtTime(EPS, t + 0.09);
  tone.connect(tg).connect(amp);
  v.source(tone, t, t + 0.12);

  const level = 0.22 * vel;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + 0.002);
  amp.gain.exponentialRampToValueAtTime(EPS, end);
  sends(v, S, o, 0.4, 0.6);
}

/** Soft kick / felt mallet on a low drum — used sparingly, mostly in storm. */
export function kick(S: SynthCtx, dest: AudioNode, t: number, o: NoteOpts = {}): void {
  const ctx = S.ctx;
  const vel = clamp(o.vel ?? 0.6, 0.03, 1);
  const end = t + 0.7;
  const v = S.pool.alloc(dest, o.priority ?? PRIORITY.music, t, end);
  if (!v) return;
  const amp = v.track(ctx.createGain());
  amp.connect(v.gain);
  const osc = v.track(ctx.createOscillator());
  osc.type = 'sine';
  osc.frequency.setValueAtTime(120, t);
  osc.frequency.exponentialRampToValueAtTime(41, t + 0.13);
  osc.connect(amp);
  v.source(osc, t, end);
  const level = 0.55 * vel;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + 0.006);
  amp.gain.exponentialRampToValueAtTime(EPS, end);
  sends(v, S, o, 0.2, 0.3);
}

/** Shared saturation curve for anything that needs to be pushed. */
export const SOFT_CLIP = saturationCurve(2.2);
