/**
 * A HUD that keeps telling you which key jumps is a HUD that thinks you are
 * stupid. Every prompt in ÆON is counted: once you have used a control three
 * times, its hint never appears again — on any device, forever.
 *
 * The counts are shared between the desktop key hints and the mobile button
 * captions, so switching devices does not restart the tutorial.
 */

import { readJson, writeJson } from './Dom';

const KEY = 'aeon.learned.v1';
const THRESHOLD = 3;

type Counts = Record<string, number>;

export class Learn {
  private counts: Counts;
  private saveHandle = 0;

  constructor() {
    this.counts = readJson<Counts>(KEY, {});
  }

  count(id: string): number {
    return this.counts[id] ?? 0;
  }

  learned(id: string): boolean {
    return this.count(id) >= THRESHOLD;
  }

  /** Returns true when this use was the one that tipped it into "learned". */
  bump(id: string): boolean {
    const was = this.learned(id);
    this.counts[id] = this.count(id) + 1;
    this.queueSave();
    return !was && this.learned(id);
  }

  reset(): void {
    this.counts = {};
    this.queueSave();
  }

  private queueSave(): void {
    if (this.saveHandle) return;
    // Coalesce — a player mashing jump should not hit localStorage 20 times.
    this.saveHandle = window.setTimeout(() => {
      this.saveHandle = 0;
      writeJson(KEY, this.counts);
    }, 900);
  }

  dispose(): void {
    if (this.saveHandle) {
      clearTimeout(this.saveHandle);
      this.saveHandle = 0;
      writeJson(KEY, this.counts);
    }
  }
}
