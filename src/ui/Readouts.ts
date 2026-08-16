/**
 * The vitals rail — bottom right, right-aligned, three lines at most.
 *
 * Each context gets its own set: oxygen and temperature on foot, integrity and
 * fuel in a vehicle, speed and altitude in flight. When the context changes the
 * old set falls upward and out while the new set rises in behind it, staggered
 * by 55 ms per row. Nothing ever hard-cuts, because a hard cut in the corner of
 * your eye reads as a glitch.
 *
 * Text is only written when the *formatted string* changes, and the meters are
 * `scaleX` on a 1 px rule, so a rail sitting at a constant 98% oxygen costs
 * nothing at all.
 */

import { clamp01, el } from './Dom';
import { distanceParts, percentParts, speedParts, temperatureParts } from './Format';
import type { HudContext } from './TouchControls';

export interface Vitals {
  speed?: number;
  altitude?: number;
  fuel?: number;
  integrity?: number;
  oxygen?: number;
  temperature?: number;
}

type Key = keyof Vitals;

const LAYOUTS: Record<HudContext, Key[]> = {
  foot: ['oxygen', 'temperature'],
  vehicle: ['speed', 'integrity', 'fuel'],
  space: ['speed', 'altitude', 'fuel'],
  orbit: ['altitude', 'speed'],
  cosmos: [],
  map: [],
};

const HEADS: Record<Key, string> = {
  speed: 'vel',
  altitude: 'alt',
  fuel: 'fuel',
  integrity: 'hull',
  oxygen: 'o₂',
  temperature: 'temp',
};

/** Fractional readouts get a meter; scalar ones just get a number. */
const METERED: Key[] = ['fuel', 'integrity', 'oxygen'];

interface Cell {
  root: HTMLElement;
  value: HTMLElement;
  unit: HTMLElement;
  meter: HTMLElement | null;
  fill: HTMLElement | null;
  key: Key;
  text: string;
  unitText: string;
  bar: number;
  state: string;
  removing: boolean;
  timer: number;
}

export class Readouts {
  readonly root: HTMLElement;

  private cells = new Map<Key, Cell>();
  private keys: Key[] = [];
  private vitals: Vitals = {};
  private acc = 0;

  constructor() {
    this.root = el('div', 'ae-rail ae-h');
  }

  setContext(ctx: HudContext): void {
    const next = LAYOUTS[ctx] ?? [];
    if (next.length === this.keys.length && next.every((k, i) => this.keys[i] === k)) return;
    this.keys = next.slice();

    for (const [key, cell] of this.cells) {
      if (this.keys.includes(key)) {
        // Reprieve: it survived the context change, so cancel any exit.
        if (cell.removing) {
          cell.removing = false;
          cell.root.classList.remove('ae-out');
          cell.root.classList.add('ae-on');
        }
        continue;
      }
      cell.removing = true;
      cell.timer = 0.34;
      cell.root.classList.remove('ae-on');
      cell.root.classList.add('ae-out');
    }

    this.keys.forEach((key, i) => {
      let cell = this.cells.get(key);
      if (!cell) cell = this.make(key);
      cell.root.style.setProperty('--ae-i', String(i));
      // Order matters visually; re-append is cheap and happens once per context.
      this.root.appendChild(cell.root);
      if (!cell.root.classList.contains('ae-on')) {
        requestAnimationFrame(() => cell!.root.classList.add('ae-on'));
      }
    });
  }

  set(v: Vitals): void {
    Object.assign(this.vitals, v);
  }

  update(dt: number): void {
    // Retire exiting cells.
    for (const [key, cell] of Array.from(this.cells)) {
      if (!cell.removing) continue;
      cell.timer -= dt;
      if (cell.timer <= 0) {
        cell.root.remove();
        this.cells.delete(key);
      }
    }
    if (!this.keys.length) return;

    // 20 Hz is past the point where a changing number reads as a number.
    this.acc += dt;
    if (this.acc < 0.05) return;
    this.acc = 0;

    for (const key of this.keys) {
      const cell = this.cells.get(key);
      if (!cell) continue;
      const raw = this.vitals[key];
      if (raw === undefined || raw === null || !isFinite(raw)) {
        this.write(cell, '—', '', -1, '');
        continue;
      }
      switch (key) {
        case 'speed': {
          const p = speedParts(raw);
          this.write(cell, p.v, p.u, -1, '');
          break;
        }
        case 'altitude': {
          const p = distanceParts(raw);
          this.write(cell, p.v, p.u, -1, '');
          break;
        }
        case 'temperature': {
          const p = temperatureParts(raw);
          const c = raw > 150 ? raw - 273.15 : raw;
          this.write(cell, p.v, p.u, -1, c < -25 || c > 45 ? 'ae-warn' : c < -55 || c > 70 ? 'ae-crit' : '');
          break;
        }
        default: {
          // Accept either 0–1 or 0–100 without being told which.
          const f = clamp01(raw > 1.0001 ? raw / 100 : raw);
          const p = percentParts(f);
          this.write(cell, p.v, p.u, f, f < 0.12 ? 'ae-crit' : f < 0.3 ? 'ae-warn' : '');
          break;
        }
      }
    }
  }

  private write(cell: Cell, v: string, u: string, bar: number, state: string): void {
    if (cell.text !== v) {
      cell.text = v;
      cell.value.textContent = v;
    }
    if (cell.unitText !== u) {
      cell.unitText = u;
      cell.unit.textContent = u;
    }
    if (cell.fill && bar >= 0 && Math.abs(bar - cell.bar) > 0.004) {
      cell.bar = bar;
      cell.fill.style.transform = `scaleX(${bar.toFixed(3)})`;
    }
    if (cell.state !== state) {
      if (cell.state) cell.root.classList.remove(cell.state);
      if (state) cell.root.classList.add(state);
      cell.state = state;
    }
  }

  private make(key: Key): Cell {
    const root = el('div', 'ae-ro');
    const head = el('div', 'ae-ro-h', root);
    head.textContent = HEADS[key];
    const body = el('div', 'ae-ro-b', root);
    const value = el('span', 'ae-ro-v', body);
    value.textContent = '—';
    const unit = el('span', 'ae-ro-u', body);
    let meter: HTMLElement | null = null;
    let fill: HTMLElement | null = null;
    if (METERED.includes(key)) {
      meter = el('div', 'ae-ro-m', root);
      fill = el('i', undefined, meter);
    }
    const cell: Cell = {
      root,
      value,
      unit,
      meter,
      fill,
      key,
      text: '—',
      unitText: '',
      bar: -1,
      state: '',
      removing: false,
      timer: 0,
    };
    this.cells.set(key, cell);
    return cell;
  }

  dispose(): void {
    this.root.remove();
    this.cells.clear();
  }
}
