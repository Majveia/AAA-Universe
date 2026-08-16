/**
 * Mobile controls.
 *
 * `Input` already owns the raw touch handling — the dynamic left stick, the
 * free-look drag on the right, and hit-testing for buttons it is told about.
 * This module is purely the *feel*: what you see, where it sits, and how it
 * responds.
 *
 * The rules it is built to:
 *
 *  - The stick has no home. It is drawn wherever your thumb lands, fades in
 *    over 120 ms and out over 250 ms, and never occupies the screen when you
 *    are not touching it. A fixed ring you have to hunt for is the single most
 *    common way mobile controls fail.
 *  - Buttons are small (36–44 px) and quiet (~60% opacity), but their hit slop
 *    is 35% wider than they look, so they are far easier to hit than to see.
 *    Small and forgiving beats big and honest.
 *  - Everything lives in the bottom-right thumb arc and the safe-area gutters.
 *    The centre of the screen is never touched by a control.
 *  - The caption under each button disappears once you have used it three
 *    times. The interface teaches itself and then gets out of the way.
 */

import type { Input, TouchButtonSpec, Action } from '../core/Input';
import { el, svg } from './Dom';
import { controlGlyph } from './Glyphs';
import type { Learn } from './Learn';

export type HudContext = 'cosmos' | 'map' | 'space' | 'orbit' | 'foot' | 'vehicle';

interface ButtonDef {
  id: string;
  action: Action;
  cap: string;
  glyph: string;
  /** Offset from the cluster anchor, CSS px. */
  dx: number;
  dy: number;
  r: number;
  mini?: boolean;
}

/** The thumb arc: primary under the thumb, the rest sweeping up and left. */
const ARC: { dx: number; dy: number; r: number }[] = [
  { dx: 0, dy: 0, r: 22 },
  { dx: -6, dy: -64, r: 19 },
  { dx: -64, dy: -18, r: 19 },
  { dx: -54, dy: -72, r: 17 },
];

interface Entry {
  id: string;
  action: Action;
  cap: string;
  glyph: string;
  mini?: boolean;
}

const SETS: Record<HudContext, Entry[]> = {
  foot: [
    { id: 'jump', action: 'jump', cap: 'jump', glyph: 'jump' },
    { id: 'interact', action: 'interact', cap: 'use', glyph: 'interact' },
    { id: 'sprint', action: 'sprint', cap: 'run', glyph: 'sprint' },
    { id: 'scan', action: 'scan', cap: 'scan', glyph: 'scan' },
  ],
  vehicle: [
    { id: 'boost', action: 'boost', cap: 'boost', glyph: 'boost' },
    { id: 'brake', action: 'brake', cap: 'brake', glyph: 'brake' },
    { id: 'exit', action: 'interact', cap: 'exit', glyph: 'exit' },
    { id: 'handbrake', action: 'handbrake', cap: 'drift', glyph: 'handbrake' },
  ],
  space: [
    { id: 'throttle', action: 'boost', cap: 'thrust', glyph: 'boost' },
    { id: 'brake', action: 'brake', cap: 'brake', glyph: 'brake' },
    { id: 'land', action: 'interact', cap: 'land', glyph: 'land' },
    { id: 'warp', action: 'warp', cap: 'warp', glyph: 'warp' },
  ],
  orbit: [
    { id: 'throttle', action: 'boost', cap: 'thrust', glyph: 'boost' },
    { id: 'brake', action: 'brake', cap: 'brake', glyph: 'brake' },
    { id: 'land', action: 'interact', cap: 'land', glyph: 'land' },
    { id: 'scan', action: 'scan', cap: 'scan', glyph: 'scan' },
  ],
  cosmos: [
    { id: 'dive', action: 'enter', cap: 'dive', glyph: 'enter' },
    { id: 'scan', action: 'scan', cap: 'scan', glyph: 'scan' },
  ],
  map: [
    { id: 'select', action: 'enter', cap: 'select', glyph: 'enter' },
    { id: 'closemap', action: 'map', cap: 'close', glyph: 'map' },
  ],
};

/** Always present, top-right, barely there. */
const MINI: Entry[] = [
  { id: 'menu', action: 'menu', cap: '', glyph: 'menu', mini: true },
  { id: 'photo', action: 'photo', cap: '', glyph: 'photo', mini: true },
];

const VIEW_TOGGLE: Entry = { id: 'view', action: 'toggleView', cap: '', glyph: 'toggleView', mini: true };

interface Node {
  root: HTMLElement;
  cap: HTMLElement | null;
  def: ButtonDef;
}

export class TouchControls {
  readonly root: HTMLElement;

  private input: Input;
  private learn: Learn;
  private stick: HTMLElement;
  private stickArc: SVGSVGElement;
  private stickDot: HTMLElement;
  private btnLayer: HTMLElement;
  private nodes = new Map<string, Node>();
  private defs: ButtonDef[] = [];
  private ctx: HudContext = 'foot';
  private w = 1;
  private h = 1;
  private insets = { t: 0, b: 0, l: 0, r: 0 };
  private enabled = true;
  private raf = 0;

  /** Fired on press so the HUD can react to UI-only buttons (menu, photo). */
  onPress: ((id: string) => void) | null = null;

  constructor(input: Input, learn: Learn) {
    this.input = input;
    this.learn = learn;

    this.root = el('div', 'ae-touch');

    this.stick = el('div', 'ae-stick', this.root);
    el('div', 'ae-stick-ring', this.stick);
    this.stickArc = svg('ae-stick-arc', this.stick, '0 0 140 140');
    // A 70 px-radius arc that lights up with stick magnitude — the only
    // feedback that tells you how hard you are pushing without a number.
    this.stickArc.innerHTML =
      '<path d="M70 4 A66 66 0 0 1 70 136" stroke-width="1.4" stroke-dasharray="60 350" stroke-linecap="round"/>';
    this.stickArc.setAttribute('stroke-width', '1.4');
    this.stickDot = el('div', 'ae-stick-dot', this.stick);

    this.btnLayer = el('div', 'ae-btn-layer', this.root);

    input.onStickChange = (s) => this.drawStick(s);
    input.onLookDrag = null; // deliberate: free look shows nothing at all
    input.onButton = (id, down) => this.press(id, down);
  }

  setEnabled(v: boolean): void {
    if (this.enabled === v) return;
    this.enabled = v;
    this.input.setTouchButtons(v ? this.specs() : []);
    for (const n of this.nodes.values()) n.root.classList.toggle('ae-on', v);
  }

  setContext(ctx: HudContext): void {
    if (this.ctx === ctx && this.defs.length) return;
    this.ctx = ctx;
    this.build();
  }

  /** Called on resize/orientation change only — never per frame. */
  setViewport(w: number, h: number, insets: { t: number; b: number; l: number; r: number }): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.insets = insets;
    this.layout();
  }

  /* ─────────────────────────── build + layout ─────────────────────────── */

  private build(): void {
    const entries = SETS[this.ctx] ?? SETS.foot;
    const mini = [...MINI];
    if (this.ctx === 'foot' || this.ctx === 'vehicle') mini.unshift(VIEW_TOGGLE);

    const defs: ButtonDef[] = [];
    entries.slice(0, ARC.length).forEach((e, i) => {
      defs.push({ ...e, ...ARC[i] });
    });
    mini.forEach((e, i) => {
      defs.push({ ...e, dx: -i * 38, dy: 0, r: 15, mini: true });
    });
    this.defs = defs;

    // Retire nodes that this context does not use; keep the rest so their
    // press state and learned captions survive a context switch.
    const keep = new Set(defs.map((d) => d.id));
    for (const [id, n] of Array.from(this.nodes)) {
      if (keep.has(id)) continue;
      n.root.classList.remove('ae-on');
      const node = n.root;
      window.setTimeout(() => node.remove(), 360);
      this.nodes.delete(id);
    }

    for (const d of defs) {
      let n = this.nodes.get(d.id);
      if (!n) {
        const root = el('div', d.mini ? 'ae-btn ae-mini' : 'ae-btn', this.btnLayer);
        const g = svg(undefined, root);
        g.innerHTML = controlGlyph(d.glyph);
        let cap: HTMLElement | null = null;
        if (d.cap) {
          cap = el('div', 'ae-btn-cap', root);
          cap.textContent = d.cap;
        }
        if (this.learn.learned(d.id)) root.classList.add('ae-known');
        n = { root, cap, def: d };
        this.nodes.set(d.id, n);
      }
      n.def = d;
    }

    this.layout();

    // Stagger the reveal so the cluster assembles rather than blinking on.
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      let i = 0;
      for (const d of this.defs) {
        const n = this.nodes.get(d.id);
        if (!n) continue;
        n.root.style.transitionDelay = `${Math.min(i, 6) * 45}ms`;
        n.root.classList.toggle('ae-on', this.enabled);
        i++;
      }
    });
  }

  private layout(): void {
    if (!this.defs.length) return;
    const pad = Math.max(16, Math.min(30, this.w * 0.032));
    const ax = this.w - this.insets.r - pad - 22;
    const ay = this.h - this.insets.b - pad - 22;
    const mx = this.w - this.insets.r - pad - 15;
    const my = this.insets.t + pad + 15;

    for (const d of this.defs) {
      const n = this.nodes.get(d.id);
      if (!n) continue;
      const cx = (d.mini ? mx : ax) + d.dx;
      const cy = (d.mini ? my : ay) + d.dy;
      const s = n.root.style;
      // Positioned once per layout with left/top/size; the press animation is
      // pure transform, so nothing here is ever touched during a frame.
      s.left = `${Math.round(cx - d.r)}px`;
      s.top = `${Math.round(cy - d.r)}px`;
      s.width = `${d.r * 2}px`;
      s.height = `${d.r * 2}px`;
      (d as any)._cx = cx;
      (d as any)._cy = cy;
    }
    this.input.setTouchButtons(this.enabled ? this.specs() : []);
  }

  private specs(): TouchButtonSpec[] {
    return this.defs.map((d) => ({
      id: d.id,
      action: d.action,
      ax: ((d as any)._cx ?? 0) / this.w,
      ay: ((d as any)._cy ?? 0) / this.h,
      r: d.r,
    }));
  }

  /**
   * Re-sync the "you already know this one" styling against the Learn store.
   * Called when hints are reset from the settings panel, so buttons that had
   * faded back to their taught state without needing a rebuild.
   */
  refreshLearned(): void {
    for (const [id, n] of this.nodes) {
      n.root.classList.toggle('ae-known', this.learn.learned(id));
    }
  }

  /* ─────────────────────────── feedback ─────────────────────────── */

  private press(id: string, down: boolean): void {
    const n = this.nodes.get(id);
    if (n) {
      n.root.classList.toggle('ae-press', down);
      if (down && this.learn.bump(id)) n.root.classList.add('ae-known');
      else if (down && this.learn.learned(id)) n.root.classList.add('ae-known');
    }
    if (down) this.onPress?.(id);
  }

  private drawStick(s: { active: boolean; ox: number; oy: number; x: number; y: number; radius: number }): void {
    const st = this.stick.style;
    st.transform = `translate3d(${s.ox.toFixed(1)}px,${s.oy.toFixed(1)}px,0)`;
    if (s.active) {
      // The dot sits slightly inside the ring so the ring always frames it.
      const k = s.radius * 0.9;
      this.stickDot.style.transform = `translate3d(${(s.x * k).toFixed(1)}px,${(-s.y * k).toFixed(1)}px,0)`;
      const mag = Math.min(1, Math.hypot(s.x, s.y));
      const ang = Math.atan2(-s.y, s.x) * (180 / Math.PI);
      this.stickArc.style.transform = `rotate(${ang.toFixed(1)}deg)`;
      this.stickArc.style.opacity = (mag * 0.55).toFixed(2);
      this.stick.classList.add('ae-on');
    } else {
      this.stick.classList.remove('ae-on');
      this.stickArc.style.opacity = '0';
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    if (this.input.onStickChange) this.input.onStickChange = null;
    if (this.input.onButton) this.input.onButton = null;
    this.input.setTouchButtons([]);
    this.nodes.clear();
    this.root.remove();
  }
}
