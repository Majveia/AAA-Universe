/**
 * Desktop control hints.
 *
 * They appear when the context changes, they teach at most four things at
 * once, and each line deletes itself permanently once you have used that
 * control three times. After a short while on screen they fade out anyway —
 * a hint that outstays its welcome is just clutter with a border.
 *
 * If a gamepad is plugged in the labels become controller glyphs mid-session,
 * without a reload and without a settings toggle.
 */

import type { Action, Input } from '../core/Input';
import { el } from './Dom';
import type { Learn } from './Learn';
import type { HudContext } from './TouchControls';

interface HintDef {
  id: string;
  /** Action whose use counts as "learned". `null` for composite hints. */
  action: Action | null;
  key: string;
  pad: string;
  text: string;
}

const MOVE: HintDef = { id: 'move', action: null, key: 'W A S D', pad: 'L', text: 'move' };
const MENU: HintDef = { id: 'menu', action: 'menu', key: 'Tab', pad: '≡', text: 'options' };

const SETS: Record<HudContext, HintDef[]> = {
  foot: [
    MOVE,
    { id: 'jump', action: 'jump', key: 'Space', pad: 'A', text: 'jump' },
    { id: 'interact', action: 'interact', key: 'E', pad: 'X', text: 'interact' },
    { id: 'scan', action: 'scan', key: 'T', pad: 'R3', text: 'scan' },
    { id: 'view', action: 'toggleView', key: 'V', pad: 'Y', text: 'view' },
    MENU,
  ],
  vehicle: [
    MOVE,
    { id: 'boost', action: 'boost', key: 'R', pad: 'RT', text: 'boost' },
    { id: 'brake', action: 'brake', key: 'X', pad: 'LT', text: 'brake' },
    { id: 'exit', action: 'interact', key: 'E', pad: 'X', text: 'disembark' },
    MENU,
  ],
  space: [
    MOVE,
    { id: 'throttle', action: 'boost', key: 'R', pad: 'RT', text: 'thrust' },
    { id: 'brake', action: 'brake', key: 'X', pad: 'LT', text: 'reverse' },
    { id: 'warp', action: 'warp', key: 'J', pad: 'RB', text: 'warp' },
    { id: 'land', action: 'interact', key: 'E', pad: 'X', text: 'land' },
  ],
  orbit: [
    MOVE,
    { id: 'throttle', action: 'boost', key: 'R', pad: 'RT', text: 'thrust' },
    { id: 'land', action: 'interact', key: 'E', pad: 'X', text: 'descend' },
    { id: 'scan', action: 'scan', key: 'T', pad: 'R3', text: 'scan' },
  ],
  cosmos: [
    MOVE,
    { id: 'dive', action: 'enter', key: 'Enter', pad: 'A', text: 'dive in' },
    { id: 'map', action: 'map', key: 'M', pad: '⧉', text: 'star map' },
    MENU,
  ],
  map: [
    { id: 'select', action: 'enter', key: 'Enter', pad: 'A', text: 'select' },
    { id: 'closemap', action: 'map', key: 'M', pad: '⧉', text: 'close' },
    MENU,
  ],
};

const MAX_VISIBLE = 4;
const HOLD_S = 13;

interface Row {
  root: HTMLElement;
  key: HTMLElement;
  def: HintDef;
  gone: boolean;
}

export class KeyHints {
  readonly root: HTMLElement;

  private learn: Learn;
  private rows: Row[] = [];
  private ctx: HudContext = 'foot';
  private age = 0;
  private shown = false;
  private pad = false;
  private moveTime = 0;
  private enabled = true;

  constructor(learn: Learn) {
    this.learn = learn;
    this.root = el('div', 'ae-hints');
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v) this.hideAll();
  }

  setGamepad(v: boolean): void {
    if (this.pad === v) return;
    this.pad = v;
    for (const r of this.rows) r.key.textContent = v ? r.def.pad : r.def.key;
  }

  setContext(ctx: HudContext): void {
    this.ctx = ctx;
    this.rebuild();
  }

  private rebuild(): void {
    for (const r of this.rows) r.root.remove();
    this.rows.length = 0;
    this.age = 0;
    this.shown = false;
    if (!this.enabled) return;

    const defs = (SETS[this.ctx] ?? SETS.foot).filter((d) => !this.learn.learned(d.id)).slice(0, MAX_VISIBLE);
    for (const def of defs) {
      const root = el('div', 'ae-hint', this.root);
      const key = el('span', 'ae-key', root);
      key.textContent = this.pad ? def.pad : def.key;
      const t = el('span', 'ae-hint-t', root);
      t.textContent = def.text;
      this.rows.push({ root, key, def, gone: false });
    }
    if (!this.rows.length) return;

    requestAnimationFrame(() => {
      this.rows.forEach((r, i) => {
        r.root.style.transitionDelay = `${i * 70}ms`;
        r.root.classList.add('ae-on');
      });
      this.shown = true;
    });
  }

  update(dt: number, input: Input): void {
    if (!this.rows.length) return;
    this.age += dt;

    // Composite "move" hint: learned by actually walking for a moment, not by
    // tapping a key once.
    if (input.move.lengthSq() > 0.25) {
      this.moveTime += dt;
      if (this.moveTime > 1.1) {
        this.moveTime = -1e9;
        if (this.learn.bump('move')) this.retire('move');
      }
    }

    for (const r of this.rows) {
      if (r.gone || !r.def.action) continue;
      if (input.pressed(r.def.action)) {
        if (this.learn.bump(r.def.id)) this.retire(r.def.id);
      }
    }

    if (this.shown && this.age > HOLD_S) this.hideAll();
  }

  private retire(id: string): void {
    const r = this.rows.find((x) => x.def.id === id);
    if (!r || r.gone) return;
    r.gone = true;
    r.root.style.transitionDelay = '0ms';
    r.root.classList.remove('ae-on');
  }

  private hideAll(): void {
    for (const r of this.rows) {
      r.gone = true;
      r.root.style.transitionDelay = '0ms';
      r.root.classList.remove('ae-on');
    }
    this.shown = false;
  }

  dispose(): void {
    this.root.remove();
    this.rows.length = 0;
  }
}
