/**
 * The heading strip.
 *
 * A 1 px ruler of ticks at the top of the frame that scrolls under a fixed
 * mark. It exists for the on-foot and driving contexts, where "which way am I
 * facing" is the only navigational question that matters, and it fades away
 * entirely a couple of seconds after you stop moving — so standing still and
 * looking at a sunset gives you an empty screen.
 *
 * The ticks are painted with two repeating gradients on a single 2376 px
 * element, so scrolling the whole compass costs exactly one transform.
 */

import { clamp01, damp, el } from './Dom';

const PX_PER_DEG = 2.2;
const REV = 360 * PX_PER_DEG;
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

interface Pip {
  root: HTMLElement;
  az: number;
  used: boolean;
}

export class Compass {
  readonly root: HTMLElement;

  private win: HTMLElement;
  private track: HTMLElement;
  private pips: Pip[] = [];
  private width = 420;
  private heading = 0;
  private lastHeading = 0;
  private vis = 0;
  private idle = 99;
  private lastTx = -1e9;
  private on = false;
  private active = false;

  constructor() {
    this.root = el('div', 'ae-compass ae-h');
    this.win = el('div', 'ae-cp-win', this.root);
    this.track = el('div', 'ae-cp-track', this.win);
    el('div', 'ae-cp-head', this.root);

    // Three copies of the rose so the strip can wrap without a seam.
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 8; i++) {
        const deg = c * 360 + i * 45;
        const lbl = el('div', i % 2 === 0 ? 'ae-cp-lbl ae-card' : 'ae-cp-lbl', this.track);
        lbl.textContent = CARDINALS[i];
        lbl.style.left = `${deg * PX_PER_DEG}px`;
      }
    }
  }

  /** One layout read, on resize only. */
  measure(): void {
    const w = this.root.getBoundingClientRect().width;
    if (w > 0) this.width = w;
  }

  setActive(v: boolean): void {
    this.active = v;
    if (!v) this.idle = 99;
  }

  /**
   * @param heading  degrees clockwise from north
   * @param busy     true while the player is moving or turning
   * @param bearings azimuths of important targets, degrees from north
   */
  update(dt: number, heading: number, busy: boolean, bearings: number[] | null): void {
    if (!this.active && this.vis <= 0.001) return;

    // Smooth the heading itself: raw camera yaw jitters by a fraction of a
    // degree every frame and a ruler amplifies that into a shimmer.
    let d = ((heading - this.heading + 540) % 360) - 180;
    this.heading = (this.heading + d * (1 - Math.exp(-14 * dt)) + 360) % 360;

    const turned = Math.abs(((heading - this.lastHeading + 540) % 360) - 180) > 0.6;
    this.lastHeading = heading;
    if (busy || turned) this.idle = 0;
    else this.idle += dt;

    const want = this.active && this.idle < 2.4 ? 1 : 0;
    this.vis = damp(this.vis, want, want > 0 ? 8 : 3, dt);

    const shouldShow = this.vis > 0.02;
    if (shouldShow !== this.on) {
      this.on = shouldShow;
      this.root.classList.toggle('ae-on', shouldShow);
    }
    if (!shouldShow) return;

    const tx = Math.round((this.width * 0.5 - (REV + this.heading * PX_PER_DEG)) * 2) / 2;
    if (tx !== this.lastTx) {
      this.lastTx = tx;
      this.track.style.transform = `translate3d(${tx}px,0,0)`;
    }

    this.drawPips(bearings);
  }

  private drawPips(bearings: number[] | null): void {
    const n = bearings ? Math.min(bearings.length, 4) : 0;
    for (let i = 0; i < n; i++) {
      let p = this.pips[i];
      if (!p) {
        p = { root: el('div', 'ae-cp-pip', this.track), az: -1, used: false };
        this.pips[i] = p;
      }
      const az = Math.round(((bearings![i] % 360) + 360) % 360);
      if (az !== p.az) {
        p.az = az;
        p.root.style.transform = `translateX(${(REV + az * PX_PER_DEG).toFixed(1)}px) rotate(45deg)`;
      }
      if (!p.used) {
        p.used = true;
        p.root.style.opacity = '1';
      }
    }
    for (let i = n; i < this.pips.length; i++) {
      const p = this.pips[i];
      if (p.used) {
        p.used = false;
        p.root.style.opacity = '0';
      }
    }
  }

  /** 0–1 for external fades (photo mode). */
  get opacity(): number {
    return clamp01(this.vis);
  }

  dispose(): void {
    this.root.remove();
    this.pips.length = 0;
  }
}
