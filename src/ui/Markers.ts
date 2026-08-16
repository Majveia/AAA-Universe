/**
 * Diegetic world markers.
 *
 * Every frame, world positions are projected into screen space and a pool of
 * DOM nodes is nudged with `transform`/`opacity` only — no element is created,
 * destroyed or measured while the game is running.
 *
 * The behaviour rules matter more than the maths:
 *
 *  - A marker gets *smaller and fainter* the further it is from where you are
 *    looking. The screen centre is where your attention already is; the HUD
 *    rewards it instead of competing with it.
 *  - Labels obey a "look at it to read it" rule. Text only resolves within the
 *    middle ~30% of the frame, so a busy sky is a field of quiet glyphs, and
 *    reading one is an act of intent.
 *  - Anything off-screen or behind you collapses to a chevron pinned just
 *    inside the frame, pointing along the bearing.
 *  - Nothing ever snaps. Opacity and label focus are damped, so a marker
 *    grazing the edge of the frame breathes rather than strobes.
 */

import { Matrix4, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import type { HudTarget } from '../api/Contracts';
import { clamp, clamp01, damp, el, smoothstep, svg } from './Dom';
import { CHEVRON, TARGET_TICKS, targetGlyph } from './Glyphs';
import { distanceParts } from './Format';

interface Slot {
  root: HTMLElement;
  glyph: SVGSVGElement;
  chev: SVGSVGElement;
  label: HTMLElement;
  name: HTMLElement;
  dist: HTMLElement;
  /* last written state — every write is guarded by these */
  kind: string;
  imp: boolean;
  nameTxt: string;
  distTxt: string;
  tx: number;
  ty: number;
  ts: number;
  op: number;
  lop: number;
  rot: number;
  edge: boolean;
  flip: boolean;
  /* animated state */
  fade: number;
  focus: number;
  live: boolean;
}

export interface MarkerReadout {
  label: string;
  kind: string;
  distText: string;
}

const _inv = new Matrix4();
const _v = new Vector3();

export class Markers {
  readonly root: HTMLElement;
  /** Culled + sorted contacts, reused by the scanner panel. */
  readonly contacts: MarkerReadout[] = [];

  private slots: Slot[] = [];
  private targets: HudTarget[] = [];
  private order: number[] = [];
  private fades = new Map<HudTarget, number>();
  private w = 1;
  private h = 1;
  private edgeInset = 34;
  private maxSlots = 28;
  private dirtyOrder = true;

  constructor(maxSlots = 28) {
    this.maxSlots = maxSlots;
    this.root = el('div', 'ae-markers ae-h');
  }

  setViewport(w: number, h: number, mobile: boolean): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.edgeInset = mobile ? 26 : 36;
  }

  setTargets(t: HudTarget[]): void {
    this.targets = t || [];
    this.dirtyOrder = true;
    // Drop fade memory for targets that are gone, so the map cannot grow.
    if (this.fades.size > this.targets.length * 2 + 16) {
      const keep = new Set(this.targets);
      for (const k of Array.from(this.fades.keys())) if (!keep.has(k)) this.fades.delete(k);
    }
  }

  /** Bearing of a target relative to a world direction basis, for the compass. */
  static azimuth(target: Vector3, origin: Vector3, north: Vector3, east: Vector3): number {
    _v.copy(target).sub(origin);
    const deg = Math.atan2(_v.dot(east), _v.dot(north)) * (180 / Math.PI);
    return (deg + 360) % 360;
  }

  update(dt: number, camera: PerspectiveCamera, scanning: boolean): void {
    const list = this.targets;
    const n = list.length;
    if (n === 0 && this.contacts.length === 0 && !this.anyLive()) return;

    _inv.copy(camera.matrixWorld).invert();
    const camPos = camera.position;
    const w = this.w;
    const h = this.h;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const halfW = cx - this.edgeInset;
    const halfH = cy - this.edgeInset;
    // Projection scale factors, derived once rather than round-tripping every
    // point through Vector3.project (which rebuilds the same matrix product).
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const fy = cy / tanHalf;
    const fx = fy / camera.aspect;

    // Rank by importance, then proximity: a distant star should never push the
    // waypoint you are actually flying to out of the pool.
    if (this.dirtyOrder || this.order.length !== n) {
      this.order.length = n;
      for (let i = 0; i < n; i++) this.order[i] = i;
      this.dirtyOrder = false;
    }
    const rank = (i: number) => {
      const t = list[i];
      const d = t.distance ?? camPos.distanceTo(t.position);
      return (t.important ? 0 : 1e12) + d;
    };
    if (n > 1) this.order.sort((a, b) => rank(a) - rank(b));

    const count = Math.min(n, this.maxSlots);
    this.contacts.length = 0;

    for (let s = 0; s < count; s++) {
      const t = list[this.order[s]];
      const slot = this.slot(s);

      _v.copy(t.position).applyMatrix4(_inv);
      const z = -_v.z; // metres in front of the lens
      const behind = z <= 0.02;

      let sx: number;
      let sy: number;
      let onScreen = false;
      if (!behind) {
        sx = cx + (_v.x * fx) / z;
        sy = cy - (_v.y * fy) / z;
        onScreen = sx > -40 && sx < w + 40 && sy > -40 && sy < h + 40;
      } else {
        // Mirror through the centre so the chevron still points the right way.
        sx = cx - _v.x * 1000;
        sy = cy + _v.y * 1000;
      }

      const dist = t.distance ?? camPos.distanceTo(t.position);
      let rot = 0;
      let edge = false;

      if (!onScreen) {
        edge = true;
        let dx = sx - cx;
        let dy = sy - cy;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        const tx = Math.abs(dx) > 1e-4 ? halfW / Math.abs(dx) : Infinity;
        const ty = Math.abs(dy) > 1e-4 ? halfH / Math.abs(dy) : Infinity;
        const k = Math.min(tx, ty);
        sx = cx + dx * k;
        sy = cy + dy * k;
        rot = Math.atan2(dy, dx) * (180 / Math.PI);
      }

      // Distance from the centre in "screen radii" — drives scale, opacity and
      // the label reveal all at once, which is what makes it feel coherent.
      const r = Math.hypot((sx - cx) / cx, (sy - cy) / cy);
      const focusTarget = edge ? 0 : 1 - smoothstep(0.16, 0.46, r);
      // Fade out near the frame edge; important targets hold on longer.
      const edgeFade = edge ? 0.5 : 1 - 0.55 * smoothstep(0.78, 1.06, r);
      const distFade = 1 - 0.32 * smoothstep(0.0, 1.0, clamp01(Math.log10(Math.max(dist, 1)) / 12));
      const want = (t.important ? 1 : 0.82) * edgeFade * distFade * (scanning ? 1 : 1);

      const prev = this.fades.get(t) ?? 0;
      const fade = damp(prev, want, 9, dt);
      this.fades.set(t, fade);
      slot.focus = damp(slot.focus, focusTarget, 11, dt);

      const scale = edge ? 0.78 : 0.74 + 0.3 * slot.focus - 0.06 * smoothstep(0.4, 1.0, r);
      const flip = sx > w * 0.62;

      this.write(slot, t, sx, sy, scale, fade, slot.focus, edge, flip, rot, dist, scanning);

      if (scanning && !edge && this.contacts.length < 6) {
        const p = distanceParts(dist);
        this.contacts.push({ label: t.label, kind: t.kind, distText: `${p.v} ${p.u}` });
      }
    }

    // Retire the tail of the pool without destroying it.
    for (let s = count; s < this.slots.length; s++) {
      const slot = this.slots[s];
      if (!slot.live) continue;
      this.setOpacity(slot, 0);
      slot.live = false;
    }
  }

  private anyLive(): boolean {
    for (const s of this.slots) if (s.live) return true;
    return false;
  }

  private slot(i: number): Slot {
    let s = this.slots[i];
    if (s) return s;
    const root = el('div', 'ae-mk', this.root);
    const glyph = svg('ae-mk-g', root);
    const chev = svg('ae-mk-c', root);
    chev.innerHTML = CHEVRON;
    const label = el('div', 'ae-mk-l', root);
    const name = el('span', 'ae-mk-n', label);
    const dist = el('span', 'ae-mk-d', label);
    s = {
      root,
      glyph,
      chev,
      label,
      name,
      dist,
      kind: '',
      imp: false,
      nameTxt: '',
      distTxt: '',
      tx: -9999,
      ty: -9999,
      ts: 1,
      op: 0,
      lop: 0,
      rot: 0,
      edge: false,
      flip: false,
      fade: 0,
      focus: 0,
      live: false,
    };
    this.slots[i] = s;
    return s;
  }

  private setOpacity(s: Slot, v: number): void {
    if (Math.abs(v - s.op) < 0.004) return;
    s.op = v;
    s.root.style.opacity = v.toFixed(3);
  }

  private write(
    s: Slot,
    t: HudTarget,
    x: number,
    y: number,
    scale: number,
    fade: number,
    focus: number,
    edge: boolean,
    flip: boolean,
    rot: number,
    dist: number,
    scanning: boolean
  ): void {
    s.live = true;

    if (s.kind !== t.kind || s.imp !== !!t.important) {
      s.kind = t.kind;
      s.imp = !!t.important;
      s.glyph.innerHTML = targetGlyph(t.kind) + (t.important ? TARGET_TICKS : '');
      s.root.classList.toggle('ae-imp', !!t.important);
      s.root.classList.toggle('ae-anomaly', t.kind === 'anomaly');
    }

    // Quantise the transform: sub-pixel churn costs a re-raster for no gain.
    const qx = Math.round(x * 2) / 2;
    const qy = Math.round(y * 2) / 2;
    const qs = Math.round(scale * 50) / 50;
    if (qx !== s.tx || qy !== s.ty || qs !== s.ts) {
      s.tx = qx;
      s.ty = qy;
      s.ts = qs;
      s.root.style.transform = `translate3d(${qx}px,${qy}px,0) scale(${qs})`;
    }

    this.setOpacity(s, fade);

    if (edge !== s.edge) {
      s.edge = edge;
      s.root.classList.toggle('ae-edge', edge);
    }
    if (edge) {
      const qr = Math.round(rot);
      if (qr !== s.rot) {
        s.rot = qr;
        s.chev.style.transform = `rotate(${qr}deg)`;
      }
    }
    if (flip !== s.flip) {
      s.flip = flip;
      s.root.classList.toggle('ae-flip', flip);
    }

    // Labels: the reveal is the whole interaction, so it is generous when the
    // player is clearly looking, and absent otherwise.
    const lop = edge ? 0 : focus * (scanning ? 1 : 0.94);
    if (Math.abs(lop - s.lop) > 0.01) {
      s.lop = lop;
      s.label.style.opacity = lop.toFixed(3);
    }
    if (lop > 0.02) {
      if (s.nameTxt !== t.label) {
        s.nameTxt = t.label;
        s.name.textContent = t.label;
      }
      const p = distanceParts(dist);
      const dtxt = t.sub ? `${t.sub} · ${p.v} ${p.u}` : `${p.v} ${p.u}`;
      if (s.distTxt !== dtxt) {
        s.distTxt = dtxt;
        s.dist.textContent = dtxt;
      }
    }
  }

  dispose(): void {
    this.root.remove();
    this.slots.length = 0;
    this.fades.clear();
    this.targets = [];
    this.contacts.length = 0;
  }
}
