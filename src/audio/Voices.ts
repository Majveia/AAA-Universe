/**
 * Voice allocation.
 *
 * Web Audio nodes are single-use: an oscillator you start is garbage the moment
 * it stops, but only if somebody disconnects it. A generative score that never
 * repeats will happily leak a few hundred oscillators a minute, so every note in
 * ÆON is born through this pool, which caps polyphony, steals the least
 * important voice when the cap is hit, and guarantees the teardown.
 */

const CLEANUP_PAD = 0.25;

export class Voice {
  /** Instruments build into this node; it is already connected to the bus. */
  readonly gain: GainNode;
  readonly priority: number;
  readonly startTime: number;
  endTime: number;
  dead = false;

  private ctx: AudioContext;
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];
  private onDone: (v: Voice) => void;

  constructor(ctx: AudioContext, dest: AudioNode, priority: number, startTime: number, endTime: number, onDone: (v: Voice) => void) {
    this.ctx = ctx;
    this.priority = priority;
    this.startTime = startTime;
    this.endTime = endTime;
    this.onDone = onDone;
    this.gain = ctx.createGain();
    this.gain.connect(dest);
  }

  /** Register a node so the pool can disconnect it, and return it for chaining. */
  track<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  /** Register and start a source; it will be stopped and freed automatically. */
  source<T extends AudioScheduledSourceNode>(n: T, start: number, stop: number): T {
    this.nodes.push(n);
    this.sources.push(n);
    try {
      n.start(Math.max(start, this.ctx.currentTime));
      n.stop(Math.max(stop, start + 0.005));
    } catch {
      /* already started elsewhere — harmless */
    }
    return n;
  }

  /**
   * Post-fader send. Taken from the voice output so that anything ducking the
   * voice ducks its reverb too — a tail that outlives its source sounds wrong.
   */
  send(hub: AudioNode | null, amount: number): void {
    if (!hub || amount <= 0.0001) return;
    const g = this.track(this.ctx.createGain());
    g.gain.value = amount;
    this.gain.connect(g);
    g.connect(hub);
  }

  /** Push the natural end later (a held note that got extended). */
  extend(t: number): void {
    if (t > this.endTime) this.endTime = t;
  }

  /** Fast fade and immediate teardown — used by voice stealing and dispose. */
  kill(when: number, fade = 0.03): void {
    if (this.dead) return;
    const t = Math.max(when, this.ctx.currentTime);
    try {
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setTargetAtTime(0, t, fade * 0.4);
    } catch {
      /* param already detached */
    }
    this.endTime = Math.min(this.endTime, t + fade);
    for (const s of this.sources) {
      try {
        s.stop(t + fade);
      } catch {
        /* not started */
      }
    }
  }

  /** Disconnect everything. Called by the pool once the voice is past its end. */
  free(): void {
    if (this.dead) return;
    this.dead = true;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.onended = null;
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
    try {
      this.gain.disconnect();
    } catch {
      /* already gone */
    }
    this.nodes.length = 0;
    this.sources.length = 0;
    this.onDone(this);
  }
}

/**
 * Priorities. Higher wins when the pool is full: a UI click the player just
 * asked for matters more than the eleventh note of a pad chord.
 */
export const PRIORITY = {
  bed: 0,
  music: 1,
  musicLead: 2,
  world: 3,
  player: 4,
  ui: 5,
} as const;

export class VoicePool {
  max: number;
  private ctx: AudioContext;
  private live: Voice[] = [];

  constructor(ctx: AudioContext, max = 32) {
    this.ctx = ctx;
    this.max = max;
  }

  get count(): number {
    return this.live.length;
  }

  /**
   * Reserve a voice. Returns null when the pool is saturated with sounds that
   * matter more than this one — the caller simply does not play the note, which
   * thins the arrangement gracefully instead of crunching the mix.
   */
  alloc(dest: AudioNode, priority: number, startTime: number, endTime: number): Voice | null {
    this.prune();
    if (this.live.length >= this.max && !this.steal(priority)) return null;
    const v = new Voice(this.ctx, dest, priority, startTime, endTime, (x) => this.remove(x));
    this.live.push(v);
    return v;
  }

  /** Free the oldest voice of the lowest priority below `priority`. */
  private steal(priority: number): boolean {
    let victim: Voice | null = null;
    for (const v of this.live) {
      if (v.priority >= priority) continue;
      if (!victim || v.priority < victim.priority || (v.priority === victim.priority && v.startTime < victim.startTime)) victim = v;
    }
    // Nothing less important? Take the oldest peer that is already fading out.
    if (!victim) {
      const now = this.ctx.currentTime;
      for (const v of this.live) {
        if (v.priority > priority) continue;
        if (!victim || v.endTime < victim.endTime) victim = v;
      }
      if (victim && victim.endTime > now + 1.5) victim = null;
    }
    if (!victim) return false;
    victim.kill(this.ctx.currentTime, 0.04);
    return true;
  }

  private remove(v: Voice): void {
    const i = this.live.indexOf(v);
    if (i >= 0) this.live.splice(i, 1);
  }

  /** Free anything whose scheduled tail has passed. Called every frame. */
  prune(): void {
    const now = this.ctx.currentTime;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const v = this.live[i];
      if (v.endTime + CLEANUP_PAD < now) v.free();
    }
  }

  /** Silence everything — realm changes, muting, teardown. */
  releaseAll(fade = 0.08): void {
    const now = this.ctx.currentTime;
    for (const v of this.live.slice()) v.kill(now, fade);
  }

  dispose(): void {
    for (const v of this.live.slice()) v.free();
    this.live.length = 0;
  }
}
