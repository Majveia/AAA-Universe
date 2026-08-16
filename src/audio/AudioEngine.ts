/**
 * The audio engine.
 *
 * Every sound in ÆON is synthesised at runtime — there are no audio files and
 * there never will be. That is a constraint with a payoff: a recorded score
 * cannot change key when you enter a nebula, and a recorded wind cannot get
 * genuinely gustier because the weather system says the pressure gradient
 * steepened. This one can.
 *
 * The engine owns the graph (buses, sends, generated convolution reverbs), the
 * voice pool, and the generative score in MusicDirector. It fails soft: if the
 * browser refuses an AudioContext, every method here becomes a no-op and the
 * game runs in silence rather than not at all.
 */

import type { IAudio, MusicMood, SystemContext } from '../api/Contracts';
import { Rng } from '../core/Rand';
import { AudioGraph } from './Graph';
import { MusicDirector } from './Music';
import { PRIORITY, VoicePool } from './Voices';
import type { SynthCtx } from './Instruments';
import { bell, kick, pluck, snare } from './Instruments';
import { clamp } from './Dsp';

type AmbienceName =
  | 'vacuum' | 'wind' | 'rain' | 'surf' | 'forest' | 'lava' | 'cave' | 'city' | 'ship' | 'none';

interface AmbienceBed {
  gain: GainNode;
  nodes: AudioNode[];
  stop(): void;
}

export class AudioEngine implements IAudio {
  private ctx: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private pool: VoicePool | null = null;
  private music: MusicDirector | null = null;
  private synth: SynthCtx | null = null;
  private rng = new Rng('aeon-sfx');

  private beds = new Map<AmbienceName, AmbienceBed>();
  private currentAmbience: AmbienceName = 'none';
  private musicVol = 0.7;
  private sfxVol = 0.85;
  private muffle = 0;
  private started = false;
  private failed = false;

  get ready(): boolean {
    return this.started && !this.failed && this.ctx?.state === 'running';
  }

  /** Must be called from a user gesture. Safe to call more than once. */
  async resume(): Promise<void> {
    if (this.failed) return;
    try {
      if (!this.ctx) {
        const Ctor: typeof AudioContext =
          (window as any).AudioContext ?? (window as any).webkitAudioContext;
        if (!Ctor) {
          this.failed = true;
          return;
        }
        this.ctx = new Ctor({ latencyHint: 'interactive' });
        this.graph = new AudioGraph(this.ctx, 'aeon-audio');
        this.pool = new VoicePool(this.ctx, 40);
        this.music = new MusicDirector(this.ctx, this.graph, this.pool, 'aeon-score');
        this.synth = {
          ctx: this.ctx,
          pool: this.pool,
          noise: this.graph.noise,
          rng: this.rng.fork('synth'),
          space: this.graph.spaceSfx,
          room: this.graph.roomSfx,
          echo: null,
          strings: new Map(),
        };
        this.graph.setMusicVolume(this.musicVol, 0);
        this.graph.setSfxVolume(this.sfxVol, 0);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.music?.start();
      this.started = true;
    } catch {
      // Autoplay policy, no output device, or a locked-down context. Silence
      // is an acceptable outcome; crashing is not.
      this.failed = true;
    }
  }

  update(dt: number, ctx: SystemContext): void {
    if (!this.ready) return;
    this.music?.update(dt);
  }

  setMood(mood: MusicMood, intensity = 0.6): void {
    if (!this.music) {
      // Remember it, so the first mood set before the gesture still lands.
      this.pendingMood = { mood, intensity };
      return;
    }
    this.music.setMood(mood, intensity);
  }
  private pendingMood: { mood: MusicMood; intensity: number } | null = null;

  setMusicVolume(v: number): void {
    this.musicVol = clamp(v, 0, 1);
    this.graph?.setMusicVolume(this.musicVol);
  }

  setSfxVolume(v: number): void {
    this.sfxVol = clamp(v, 0, 1);
    this.graph?.setSfxVolume(this.sfxVol);
  }

  setMuffle(amount: number): void {
    this.muffle = clamp(amount, 0, 1);
    this.graph?.setMuffle(this.muffle);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     One-shots
     ═══════════════════════════════════════════════════════════════════════ */

  play(name: string, opts: { volume?: number; rate?: number; position?: any } = {}): void {
    if (!this.ready || !this.ctx || !this.graph || !this.synth) return;
    const t = this.ctx.currentTime + 0.005;
    const vol = clamp(opts.volume ?? 1, 0, 4);
    const rate = opts.rate ?? 1;
    const dest = this.graph.sfx;
    const S = this.synth;

    switch (name) {
      case 'footstep': {
        // A footstep is a filtered noise burst with a very fast decay; the
        // pitch of the burst is what makes it read as gravel or as metal.
        this.burst(t, 0.055 * rate, 900 * rate, 2.4, vol * 0.22, 'bandpass');
        break;
      }
      case 'jump':
        this.burst(t, 0.09, 420, 1.2, vol * 0.2, 'bandpass');
        break;
      case 'land':
        this.burst(t, 0.16, 180, 0.9, vol * 0.5, 'lowpass');
        kick(S, dest, t, { vel: Math.min(1, vol * 0.6) });
        break;
      case 'splash':
        this.burst(t, 0.4, 2200, 0.7, vol * 0.35, 'highpass');
        break;
      case 'thunder': {
        // Distant thunder is a long, low, filtered roar; near thunder keeps
        // its crack. Volume stands in for distance.
        const near = clamp(vol, 0, 1);
        this.burst(t, 1.6 + (1 - near) * 2.4, 90 + near * 260, 0.5, vol * 0.9, 'lowpass');
        if (near > 0.6) this.burst(t, 0.09, 1800, 1.5, vol * 0.4, 'bandpass');
        this.graph.duck(0.35 * near, 0.02, 0.3, 1.4);
        break;
      }
      case 'rockfall':
        this.burst(t, 0.5, 320, 0.8, vol * 0.4, 'lowpass');
        snare(S, dest, t, { vel: Math.min(1, vol * 0.4) });
        break;
      case 'warp_charge':
        this.sweep(t, 1.8, 80, 2400, vol * 0.28);
        break;
      case 'warp_jump':
        this.sweep(t, 0.5, 2600, 60, vol * 0.5);
        this.graph.duck(0.6, 0.01, 0.2, 1.2);
        break;
      case 'warp_exit':
        this.burst(t, 0.9, 1200, 0.6, vol * 0.3, 'lowpass');
        break;
      case 'engine_start':
        this.sweep(t, 1.2, 40, 220, vol * 0.35);
        break;
      case 'landing_gear':
        this.burst(t, 0.22, 620, 2.0, vol * 0.25, 'bandpass');
        break;
      case 'ui_hover':
        bell(S, dest, t, 1760 * rate, { vel: Math.min(1, vol * 0.35), dur: 0.12 });
        break;
      case 'ui_select':
        bell(S, dest, t, 1320 * rate, { vel: Math.min(1, vol * 0.5), dur: 0.3 });
        break;
      case 'ui_back':
        bell(S, dest, t, 660 * rate, { vel: Math.min(1, vol * 0.45), dur: 0.25 });
        break;
      case 'scan_start':
        this.sweep(t, 0.6, 300, 1800, vol * 0.14);
        break;
      case 'scan_ping':
        bell(S, dest, t, 2093, { vel: Math.min(1, vol * 0.45), dur: 0.6 });
        break;
      case 'discovery':
        // A small rising figure — the sound of finding something.
        for (let i = 0; i < 4; i++) {
          bell(S, dest, t + i * 0.11, 523.25 * Math.pow(2, i / 4), { vel: Math.min(1, vol * 0.5), dur: 1.2 });
        }
        break;
      default:
        pluck(S, dest, t, 60, { vel: Math.min(1, vol * 0.45) });
        break;
    }
  }

  /** A filtered noise burst — the workhorse behind most physical sounds. */
  private burst(
    t: number,
    dur: number,
    freq: number,
    q: number,
    gain: number,
    type: BiquadFilterType
  ): void {
    const ctx = this.ctx!;
    const pool = this.pool!;
    const graph = this.graph!;
    const v = pool.alloc(graph.sfx, PRIORITY.world, t, t + dur + 0.05);
    if (!v) return;

    const src = ctx.createBufferSource();
    src.buffer = graph.noise;
    src.loop = true;
    const f = v.track(ctx.createBiquadFilter());
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.35), t + dur);
    f.Q.value = q;
    const g = v.track(ctx.createGain());
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(f).connect(g).connect(v.gain);
    src.start(t, this.rng.next() * Math.max(0.01, graph.noise.duration - dur - 0.1));
    src.stop(t + dur + 0.05);
    v.send(graph.spaceSfx, 0.35);
  }

  /** An exponential frequency sweep — warps, engines, scanners. */
  private sweep(t: number, dur: number, from: number, to: number, gain: number): void {
    const ctx = this.ctx!;
    const pool = this.pool!;
    const graph = this.graph!;
    const v = pool.alloc(graph.sfx, PRIORITY.world, t, t + dur + 0.1);
    if (!v) return;

    const o = v.track(ctx.createOscillator());
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(Math.max(20, from), t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const sub = v.track(ctx.createOscillator());
    sub.type = 'sine';
    sub.frequency.setValueAtTime(Math.max(20, from * 0.5), t);
    sub.frequency.exponentialRampToValueAtTime(Math.max(20, to * 0.5), t + dur);

    const f = v.track(ctx.createBiquadFilter());
    f.type = 'lowpass';
    f.frequency.setValueAtTime(Math.max(from, to) * 2.2, t);
    f.Q.value = 3;

    const g = v.track(ctx.createGain());
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + dur * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    o.connect(f);
    sub.connect(f);
    f.connect(g).connect(v.gain);
    o.start(t);
    sub.start(t);
    o.stop(t + dur + 0.1);
    sub.stop(t + dur + 0.1);
    v.send(graph.spaceSfx, 0.6);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Ambience
     ═══════════════════════════════════════════════════════════════════════ */

  setAmbience(name: string, intensity: number): void {
    if (!this.ready || !this.ctx || !this.graph) return;
    const want = name as AmbienceName;
    const level = clamp(intensity, 0, 1);

    // Fade out anything that is no longer wanted.
    for (const [k, bed] of this.beds) {
      if (k !== want) {
        bed.gain.gain.cancelScheduledValues(this.ctx.currentTime);
        bed.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 1.2);
        setTimeout(() => {
          bed.stop();
          this.beds.delete(k);
        }, 5000);
      }
    }

    if (want === 'none') {
      this.currentAmbience = 'none';
      return;
    }

    let bed = this.beds.get(want);
    if (!bed) {
      bed = this.buildBed(want);
      if (!bed) return;
      this.beds.set(want, bed);
    }
    bed.gain.gain.setTargetAtTime(level * 0.5, this.ctx.currentTime, 1.4);
    this.currentAmbience = want;
  }

  private buildBed(name: AmbienceName): AmbienceBed | null {
    const ctx = this.ctx!;
    const graph = this.graph!;
    const nodes: AudioNode[] = [];
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(graph.ambience);
    nodes.push(out);

    const noiseSrc = (buffer: AudioBuffer) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      s.start(ctx.currentTime + 0.02);
      nodes.push(s);
      return s;
    };

    const lfo = (rate: number, depth: number, target: AudioParam, base: number) => {
      const o = ctx.createOscillator();
      o.frequency.value = rate;
      const g = ctx.createGain();
      g.gain.value = depth;
      target.value = base;
      o.connect(g).connect(target);
      o.start();
      nodes.push(o, g);
    };

    switch (name) {
      case 'vacuum': {
        // Near-silence, with the faint high ring of your own hearing and a
        // slow low pulse you feel more than hear. Outer Wilds' trick.
        const s = noiseSrc(graph.pink);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 90;
        const g = ctx.createGain();
        g.gain.value = 0.16;
        s.connect(f).connect(g).connect(out);
        const ring = ctx.createOscillator();
        ring.type = 'sine';
        ring.frequency.value = 5200;
        const rg = ctx.createGain();
        rg.gain.value = 0.0018;
        ring.connect(rg).connect(out);
        ring.start();
        nodes.push(f, g, ring, rg);
        break;
      }
      case 'wind': {
        // Bandpassed noise whose centre frequency and gain are both driven by
        // slow LFOs at different rates, which is what makes gusts feel random.
        const s = noiseSrc(graph.noise);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.Q.value = 0.9;
        lfo(0.07, 320, f.frequency, 620);
        const g = ctx.createGain();
        lfo(0.11, 0.14, g.gain, 0.24);
        s.connect(f).connect(g).connect(out);
        nodes.push(f, g);
        break;
      }
      case 'rain': {
        const s = noiseSrc(graph.noise);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 900;
        const g = ctx.createGain();
        g.gain.value = 0.3;
        s.connect(hp).connect(g).connect(out);
        nodes.push(hp, g);
        break;
      }
      case 'surf': {
        const s = noiseSrc(graph.brown);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        lfo(0.09, 380, f.frequency, 700);
        const g = ctx.createGain();
        lfo(0.09, 0.2, g.gain, 0.3);
        s.connect(f).connect(g).connect(out);
        nodes.push(f, g);
        break;
      }
      case 'forest': {
        const s = noiseSrc(graph.pink);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 1400;
        f.Q.value = 0.6;
        const g = ctx.createGain();
        g.gain.value = 0.12;
        s.connect(f).connect(g).connect(out);
        nodes.push(f, g);
        break;
      }
      case 'lava': {
        const s = noiseSrc(graph.brown);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 160;
        const g = ctx.createGain();
        lfo(0.23, 0.12, g.gain, 0.34);
        s.connect(f).connect(g).connect(out);
        nodes.push(f, g);
        break;
      }
      case 'city':
      case 'ship':
      case 'cave':
      default: {
        const s = noiseSrc(graph.brown);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = name === 'ship' ? 220 : 340;
        const g = ctx.createGain();
        g.gain.value = 0.2;
        s.connect(f).connect(g).connect(out);
        nodes.push(f, g);
        break;
      }
    }

    return {
      gain: out,
      nodes,
      stop() {
        for (const n of nodes) {
          try {
            (n as any).stop?.();
          } catch {
            /* already stopped */
          }
          try {
            n.disconnect();
          } catch {
            /* already disconnected */
          }
        }
      },
    };
  }

  dispose(): void {
    this.music?.stop();
    this.music?.dispose();
    for (const bed of this.beds.values()) bed.stop();
    this.beds.clear();
    this.graph?.dispose();
    try {
      this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.ctx = null;
    this.graph = null;
    this.pool = null;
    this.music = null;
    this.synth = null;
    this.started = false;
  }
}
