/**
 * The mix bus.
 *
 * Everything the player hears passes through here in the same order a studio
 * would run it: sources → bus volumes → sends to the two reverbs and the
 * tempo-synced delay → the global muffle (helmet, water, walls) → a brickwall
 * limiter → the master fader. The limiter is last-but-one on purpose: it should
 * catch a warp jump landing on top of a full ensemble, and the master fader
 * should never be able to push anything back into clipping.
 *
 * Sends are taken *after* the per-bus volume through mirrored scale nodes, so
 * pulling the music down takes its reverb with it.
 */

import { Rng } from '../core/Rand';
import { clamp, impulseResponse, noiseBuffer } from './Dsp';

export type ReverbSize = 'space' | 'hall' | 'room';

export class AudioGraph {
  readonly ctx: AudioContext;

  /** Bus volumes — sources connect here. */
  readonly music: GainNode;
  readonly sfx: GainNode;
  readonly ambience: GainNode;

  /** Post-fader send hubs. Voices connect their send gains to these. */
  readonly spaceMusic: GainNode;
  readonly roomMusic: GainNode;
  readonly echoMusic: GainNode;
  readonly spaceSfx: GainNode;
  readonly roomSfx: GainNode;

  /** Shared looping noise — every bed and every breath borrows from this. */
  readonly noise: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;

  private sum: GainNode;
  private muffleLp: BiquadFilterNode;
  private muffleShelf: BiquadFilterNode;
  private limiter: DynamicsCompressorNode;
  private master: GainNode;

  private spaceVerb: ConvolverNode;
  private roomVerb: ConvolverNode;
  private spaceReturn: GainNode;
  private roomReturn: GainNode;

  private delayL: DelayNode;
  private delayR: DelayNode;
  private delayFb: GainNode;
  private delayTone: BiquadFilterNode;
  private delayReturn: GainNode;
  private panL: StereoPannerNode;
  private panR: StereoPannerNode;

  private rng: Rng;
  private irSeconds = 5;
  private nodes: AudioNode[] = [];

  private musicVol = 0.7;
  private sfxVol = 0.85;
  private muffle = 0;

  constructor(ctx: AudioContext, seed = 'aeon-audio') {
    this.ctx = ctx;
    this.rng = new Rng(seed);

    const t = <T extends AudioNode>(n: T): T => {
      this.nodes.push(n);
      return n;
    };

    this.master = t(ctx.createGain());
    this.master.gain.value = 1;
    this.master.connect(ctx.destination);

    // Brickwall: high ratio, no knee, fast attack. Not a mix tool — a seatbelt.
    this.limiter = t(ctx.createDynamicsCompressor());
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.18;
    this.limiter.connect(this.master);

    // Global muffle. A low-pass alone sounds like a broken speaker; pairing it
    // with a high-shelf cut keeps the tone plausible as "behind glass".
    this.muffleShelf = t(ctx.createBiquadFilter());
    this.muffleShelf.type = 'highshelf';
    this.muffleShelf.frequency.value = 2400;
    this.muffleShelf.gain.value = 0;
    this.muffleShelf.connect(this.limiter);

    this.muffleLp = t(ctx.createBiquadFilter());
    this.muffleLp.type = 'lowpass';
    this.muffleLp.frequency.value = 20000;
    this.muffleLp.Q.value = 0.6;
    this.muffleLp.connect(this.muffleShelf);

    this.sum = t(ctx.createGain());
    this.sum.connect(this.muffleLp);

    this.music = t(ctx.createGain());
    this.music.gain.value = this.musicVol;
    this.music.connect(this.sum);

    this.sfx = t(ctx.createGain());
    this.sfx.gain.value = this.sfxVol;
    this.sfx.connect(this.sum);

    this.ambience = t(ctx.createGain());
    this.ambience.gain.value = this.sfxVol;
    this.ambience.connect(this.sum);

    /* ---- reverbs ---- */
    this.spaceVerb = t(ctx.createConvolver());
    this.spaceVerb.normalize = true;
    this.spaceReturn = t(ctx.createGain());
    this.spaceReturn.gain.value = 1;
    this.spaceVerb.connect(this.spaceReturn).connect(this.sum);

    this.roomVerb = t(ctx.createConvolver());
    this.roomVerb.normalize = true;
    this.roomReturn = t(ctx.createGain());
    this.roomReturn.gain.value = 1;
    this.roomVerb.connect(this.roomReturn).connect(this.sum);

    this.spaceMusic = t(ctx.createGain());
    this.spaceMusic.gain.value = this.musicVol;
    this.spaceMusic.connect(this.spaceVerb);
    this.roomMusic = t(ctx.createGain());
    this.roomMusic.gain.value = this.musicVol;
    this.roomMusic.connect(this.roomVerb);

    this.spaceSfx = t(ctx.createGain());
    this.spaceSfx.gain.value = this.sfxVol;
    this.spaceSfx.connect(this.spaceVerb);
    this.roomSfx = t(ctx.createGain());
    this.roomSfx.gain.value = this.sfxVol;
    this.roomSfx.connect(this.roomVerb);

    /* ---- ping-pong delay, tempo synced by the music director ---- */
    this.delayL = t(ctx.createDelay(4));
    this.delayR = t(ctx.createDelay(4));
    this.delayL.delayTime.value = 0.36;
    this.delayR.delayTime.value = 0.36;
    this.delayTone = t(ctx.createBiquadFilter());
    this.delayTone.type = 'bandpass';
    this.delayTone.frequency.value = 1100;
    this.delayTone.Q.value = 0.35;
    this.delayFb = t(ctx.createGain());
    this.delayFb.gain.value = 0.42;
    this.panL = t(ctx.createStereoPanner());
    this.panL.pan.value = -0.75;
    this.panR = t(ctx.createStereoPanner());
    this.panR.pan.value = 0.75;
    this.delayReturn = t(ctx.createGain());
    this.delayReturn.gain.value = 1;

    // L taps out and feeds R; R feeds back into L through the tone filter. One
    // filter in the loop means the repeats get darker and narrower as they die.
    this.delayL.connect(this.panL).connect(this.delayReturn);
    this.delayL.connect(this.delayR);
    this.delayR.connect(this.panR).connect(this.delayReturn);
    this.delayR.connect(this.delayTone).connect(this.delayFb).connect(this.delayL);
    this.delayReturn.connect(this.sum);

    this.echoMusic = t(ctx.createGain());
    this.echoMusic.gain.value = this.musicVol;
    this.echoMusic.connect(this.delayL);

    // Ambience gets a modest, permanent send — outdoor beds want a little air.
    const ambSend = t(ctx.createGain());
    ambSend.gain.value = 0.12;
    this.ambience.connect(ambSend).connect(this.spaceVerb);

    /* ---- shared noise sources ---- */
    this.noise = noiseBuffer(ctx, 4, 'white', this.rng.fork('white'), 2);
    this.pink = noiseBuffer(ctx, 4, 'pink', this.rng.fork('pink'), 2);
    this.brown = noiseBuffer(ctx, 4, 'brown', this.rng.fork('brown'), 2);

    this.buildImpulses(5);
  }

  /**
   * Rebuild the impulse responses. Length is a real CPU decision: a 5 s stereo
   * convolution is fine on a desktop and is not fine on a phone, so the quality
   * tier shortens the void rather than removing it.
   */
  buildImpulses(spaceSeconds: number): void {
    this.irSeconds = spaceSeconds;
    this.spaceVerb.buffer = impulseResponse(
      this.ctx,
      { seconds: spaceSeconds, decay: 1.15, openHz: 7200, closeHz: 320, predelay: 0.035, width: 1, earlyCount: 5, earlyGain: 0.28 },
      this.rng.fork('ir-space'),
    );
    this.roomVerb.buffer = impulseResponse(
      this.ctx,
      { seconds: Math.min(0.85, spaceSeconds * 0.3), decay: 2.4, openHz: 4200, closeHz: 260, predelay: 0.006, width: 0.55, earlyCount: 12, earlyGain: 0.62 },
      this.rng.fork('ir-room'),
    );
  }

  get spaceSeconds(): number {
    return this.irSeconds;
  }

  setMusicVolume(v: number, smooth = 0.05): void {
    this.musicVol = clamp(v, 0, 1);
    const t = this.ctx.currentTime;
    this.music.gain.setTargetAtTime(this.musicVol, t, smooth);
    // Mirror onto the send hubs so reverb and echo follow the fader.
    this.spaceMusic.gain.setTargetAtTime(this.musicVol, t, smooth);
    this.roomMusic.gain.setTargetAtTime(this.musicVol, t, smooth);
    this.echoMusic.gain.setTargetAtTime(this.musicVol, t, smooth);
  }

  setSfxVolume(v: number, smooth = 0.05): void {
    this.sfxVol = clamp(v, 0, 1);
    const t = this.ctx.currentTime;
    this.sfx.gain.setTargetAtTime(this.sfxVol, t, smooth);
    this.ambience.gain.setTargetAtTime(this.sfxVol, t, smooth);
    this.spaceSfx.gain.setTargetAtTime(this.sfxVol, t, smooth);
    this.roomSfx.gain.setTargetAtTime(this.sfxVol, t, smooth);
  }

  /**
   * 0 = open air, 1 = head under water. The cutoff moves exponentially because
   * hearing is; a linear sweep spends all its travel in the last 10 %.
   */
  setMuffle(amount: number, smooth = 0.12): void {
    this.muffle = clamp(amount, 0, 1);
    const t = this.ctx.currentTime;
    const cut = 20000 * Math.pow(360 / 20000, this.muffle);
    this.muffleLp.frequency.setTargetAtTime(cut, t, smooth);
    this.muffleShelf.gain.setTargetAtTime(-16 * this.muffle, t, smooth);
    // Enclosed spaces get shorter, denser reflections; open ones get the void.
    this.roomReturn.gain.setTargetAtTime(1 + this.muffle * 0.5, t, smooth);
    this.spaceReturn.gain.setTargetAtTime(1 - this.muffle * 0.55, t, smooth);
  }

  get muffleAmount(): number {
    return this.muffle;
  }

  /** Tempo sync for the delay. `beat` is one quarter note in seconds. */
  setDelayTime(seconds: number, feedback = 0.42, smooth = 0.4): void {
    const t = this.ctx.currentTime;
    const d = clamp(seconds, 0.02, 3.9);
    this.delayL.delayTime.setTargetAtTime(d, t, smooth);
    this.delayR.delayTime.setTargetAtTime(d, t, smooth);
    this.delayFb.gain.setTargetAtTime(clamp(feedback, 0, 0.85), t, smooth);
  }

  /** Duck the whole mix briefly — used by warp jumps and thunder. */
  duck(amount: number, attack = 0.05, hold = 0.2, release = 0.6): void {
    const t = this.ctx.currentTime;
    const g = clamp(1 - amount, 0.05, 1);
    this.sum.gain.cancelScheduledValues(t);
    this.sum.gain.setValueAtTime(this.sum.gain.value, t);
    this.sum.gain.linearRampToValueAtTime(g, t + attack);
    this.sum.gain.setValueAtTime(g, t + attack + hold);
    this.sum.gain.linearRampToValueAtTime(1, t + attack + hold + release);
  }

  setMaster(v: number, smooth = 0.05): void {
    this.master.gain.setTargetAtTime(clamp(v, 0, 1), this.ctx.currentTime, smooth);
  }

  dispose(): void {
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already detached */
      }
    }
    this.nodes.length = 0;
    this.spaceVerb.buffer = null;
    this.roomVerb.buffer = null;
  }
}
