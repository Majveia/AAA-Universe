/**
 * Settings.
 *
 * A thin sheet that slides in from the right edge over the running world — the
 * game never pauses, never dims to a menu screen, and you can see your changes
 * land behind the glass. Rows are label-left / control-right, hairline rules
 * between groups, no boxes, no icons, no "OK / Cancel". Every control writes
 * straight through to `engine.setPrefs()`, which persists it.
 *
 * The scroll is hand-rolled: `body { touch-action: none }` on the document
 * kills native panning inside the sheet, so a drag/wheel translate is the only
 * way to keep it usable on a phone in landscape.
 */

import type { Engine } from '../core/Engine';
import type { Tier } from '../core/Settings';
import { clamp, clamp01, el } from './Dom';

type Row = { root: HTMLElement };

function group(parent: HTMLElement, title: string): HTMLElement {
  const g = el('div', 'ae-grp', parent);
  const h = el('div', 'ae-grp-h', g);
  h.textContent = title;
  return g;
}

function row(parent: HTMLElement, label: string): HTMLElement {
  const r = el('div', 'ae-row', parent);
  const k = el('div', 'ae-row-k', r);
  k.textContent = label;
  return r;
}

class Switch {
  readonly root: HTMLElement;
  private value: boolean;
  constructor(parent: HTMLElement, value: boolean, private onChange: (v: boolean) => void) {
    this.root = el('div', 'ae-sw', parent);
    el('i', undefined, this.root);
    this.value = value;
    this.root.classList.toggle('ae-sel', value);
    this.root.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.set(!this.value, true);
    });
  }
  set(v: boolean, emit = false): void {
    this.value = v;
    this.root.classList.toggle('ae-sel', v);
    if (emit) this.onChange(v);
  }
}

class Segmented {
  readonly root: HTMLElement;
  private buttons: HTMLElement[] = [];
  constructor(parent: HTMLElement, labels: string[], index: number, private onChange: (i: number) => void) {
    this.root = el('div', 'ae-seg', parent);
    labels.forEach((l, i) => {
      const b = el('div', 'ae-seg-b', this.root);
      b.textContent = l;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.select(i, true);
      });
      this.buttons.push(b);
    });
    this.select(index);
  }
  select(i: number, emit = false): void {
    this.buttons.forEach((b, k) => b.classList.toggle('ae-sel', k === i));
    if (emit) this.onChange(i);
  }
}

class Slider {
  readonly root: HTMLElement;
  private fill: HTMLElement;
  private knob: HTMLElement;
  private out: HTMLElement;
  private track: HTMLElement;
  private v: number;
  private rect = { left: 0, width: 1 };

  constructor(
    parent: HTMLElement,
    private min: number,
    private max: number,
    private step: number,
    value: number,
    private fmt: (v: number) => string,
    private onChange: (v: number) => void
  ) {
    this.root = el('div', 'ae-sld', parent);
    this.track = el('div', 'ae-sld-track', this.root);
    this.fill = el('div', 'ae-sld-fill', this.track);
    this.knob = el('div', 'ae-sld-knob', this.track);
    this.out = el('div', 'ae-sld-val', this.root);
    this.v = value;

    const at = (clientX: number) => {
      const t = clamp01((clientX - this.rect.left) / this.rect.width);
      const raw = this.min + t * (this.max - this.min);
      const snapped = Math.round(raw / this.step) * this.step;
      this.set(clamp(snapped, this.min, this.max), true);
    };

    this.track.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const r = this.track.getBoundingClientRect();
      this.rect = { left: r.left, width: Math.max(1, r.width) };
      this.track.setPointerCapture(e.pointerId);
      this.track.classList.add('ae-drag');
      at(e.clientX);
    });
    this.track.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.track.hasPointerCapture(e.pointerId)) return;
      e.stopPropagation();
      at(e.clientX);
    });
    const end = (e: PointerEvent) => {
      if (this.track.hasPointerCapture(e.pointerId)) this.track.releasePointerCapture(e.pointerId);
      this.track.classList.remove('ae-drag');
    };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);

    this.paint();
  }

  set(v: number, emit = false): void {
    if (Math.abs(v - this.v) < 1e-6 && !emit) return;
    this.v = v;
    this.paint();
    if (emit) this.onChange(v);
  }

  private paint(): void {
    const t = clamp01((this.v - this.min) / (this.max - this.min || 1));
    this.fill.style.transform = `scaleX(${t.toFixed(4)})`;
    this.knob.style.left = `${(t * 100).toFixed(2)}%`;
    this.out.textContent = this.fmt(this.v);
  }
}

const TIERS: Tier[] = ['low', 'medium', 'high', 'ultra'];

export class SettingsPanel {
  readonly root: HTMLElement;

  private engine: Engine;
  private sheet: HTMLElement;
  private clip: HTMLElement;
  private body: HTMLElement;
  private foot: HTMLElement;
  private open = false;
  private scroll = 0;
  private maxScroll = 0;
  private dragY = 0;
  private dragging = false;
  private disposers: (() => void)[] = [];
  private footTimer = 0;

  onClose: (() => void) | null = null;
  onResetHints: (() => void) | null = null;

  constructor(engine: Engine) {
    this.engine = engine;
    const prefs = engine.prefs;

    this.root = el('div', 'ae-panel');
    const scrim = el('div', 'ae-panel-scrim', this.root);
    scrim.addEventListener('pointerdown', () => this.setOpen(false));

    this.sheet = el('div', 'ae-sheet', this.root);
    const head = el('div', 'ae-sheet-head', this.sheet);
    const title = el('div', 'ae-sheet-title', head);
    title.textContent = 'Options';
    const esc = el('div', 'ae-sheet-esc', head);
    esc.textContent = engine.device.isTouch ? 'tap out' : 'esc';

    this.clip = el('div', 'ae-sheet-clip', this.sheet);
    this.body = el('div', 'ae-sheet-body', this.clip);
    this.bindScroll();

    /* ── image ── */
    const gImage = group(this.body, 'Image');
    const autoIdx = prefs.autoQuality ? 0 : TIERS.indexOf(engine.adaptive.tier) + 1;
    new Segmented(row(gImage, 'Quality'), ['AUTO', 'LOW', 'MED', 'HIGH', 'ULT'], Math.max(0, autoIdx), (i) => {
      if (i === 0) {
        engine.adaptive.setAuto();
        engine.setPrefs({ autoQuality: true });
      } else {
        engine.adaptive.setManual(TIERS[i - 1]);
        engine.setPrefs({ autoQuality: false });
      }
    });
    new Slider(row(gImage, 'Field of view'), 55, 100, 1, prefs.fovDeg, (v) => `${v.toFixed(0)}°`, (v) => {
      engine.setPrefs({ fovDeg: v });
      const cam = engine.current?.camera;
      if (cam) {
        cam.fov = v;
        cam.updateProjectionMatrix();
      }
    });
    new Switch(row(gImage, 'Film grain'), prefs.filmGrain, (v) => engine.setPrefs({ filmGrain: v }));
    new Switch(row(gImage, 'Vignette'), prefs.vignette, (v) => engine.setPrefs({ vignette: v }));
    new Switch(row(gImage, 'Chromatic aberration'), prefs.chromaticAberration, (v) =>
      engine.setPrefs({ chromaticAberration: v })
    );
    new Switch(row(gImage, 'Motion blur'), prefs.motionBlur, (v) => engine.setPrefs({ motionBlur: v }));

    /* ── controls ── */
    const gCtl = group(this.body, 'Controls');
    new Slider(
      row(gCtl, 'Look sensitivity'),
      0.2,
      3,
      0.05,
      prefs.lookSensitivity,
      (v) => v.toFixed(2),
      (v) => engine.setPrefs({ lookSensitivity: v })
    );
    new Switch(row(gCtl, 'Invert vertical'), prefs.invertY, (v) => engine.setPrefs({ invertY: v }));
    new Switch(row(gCtl, 'Head bob'), prefs.headBob, (v) => engine.setPrefs({ headBob: v }));

    /* ── sound ── */
    const gSnd = group(this.body, 'Sound');
    new Slider(
      row(gSnd, 'Music'),
      0,
      1,
      0.05,
      prefs.music,
      (v) => `${Math.round(v * 100)}%`,
      (v) => {
        engine.setPrefs({ music: v });
        engine.services.audio?.setMusicVolume?.(v);
      }
    );
    new Slider(
      row(gSnd, 'Effects'),
      0,
      1,
      0.05,
      prefs.sfx,
      (v) => `${Math.round(v * 100)}%`,
      (v) => {
        engine.setPrefs({ sfx: v });
        engine.services.audio?.setSfxVolume?.(v);
      }
    );

    /* ── comfort ── */
    const gCom = group(this.body, 'Comfort');
    new Switch(row(gCom, 'Reduce motion'), prefs.reduceMotion, (v) => engine.setPrefs({ reduceMotion: v }));
    new Switch(row(gCom, 'Show interface'), prefs.showHud, (v) => engine.setPrefs({ showHud: v }));
    const rHints = row(gCom, 'Control hints');
    const reset = el('div', 'ae-btn-t', rHints);
    reset.textContent = 'show again';
    reset.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onResetHints?.();
    });

    this.foot = el('div', 'ae-note', this.body);
    this.updateFoot();
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(v: boolean): void {
    if (this.open === v) return;
    this.open = v;
    this.root.classList.add('ae-mounted');
    this.root.classList.toggle('ae-on', v);
    if (v) {
      // One layout read per open — never during a frame.
      requestAnimationFrame(() => this.measure());
      this.updateFoot();
    } else {
      this.onClose?.();
    }
  }

  /** Refresh the diagnostics footer at most a few times a second. */
  tick(dt: number): void {
    if (!this.open) return;
    this.footTimer -= dt;
    if (this.footTimer > 0) return;
    this.footTimer = 0.5;
    this.updateFoot();
  }

  private updateFoot(): void {
    const e = this.engine;
    const gpu = (e.device.gpu || 'unknown').replace(/\s*\(.*?\)\s*/g, ' ').trim().slice(0, 42);
    this.foot.textContent = `${e.adaptive.tier.toUpperCase()} · ${Math.round(e.stats.fps)} fps · ${gpu}`;
  }

  private measure(): void {
    const inner = this.body.scrollHeight;
    const outer = this.clip.clientHeight;
    this.maxScroll = Math.max(0, inner - outer);
    this.applyScroll(clamp(this.scroll, -this.maxScroll, 0));
  }

  private applyScroll(y: number): void {
    this.scroll = y;
    this.body.style.transform = `translate3d(0,${y.toFixed(1)}px,0)`;
  }

  private bindScroll(): void {
    const onWheel = (e: WheelEvent) => {
      if (!this.open) return;
      e.preventDefault();
      this.applyScroll(clamp(this.scroll - e.deltaY, -this.maxScroll, 0));
    };
    this.clip.addEventListener('wheel', onWheel, { passive: false });
    this.disposers.push(() => this.clip.removeEventListener('wheel', onWheel));

    let startY = 0;
    let startScroll = 0;
    const down = (e: PointerEvent) => {
      if (!this.open) return;
      this.dragging = true;
      startY = e.clientY;
      startScroll = this.scroll;
      this.dragY = 0;
    };
    const move = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragY = e.clientY - startY;
      this.applyScroll(clamp(startScroll + this.dragY, -this.maxScroll, 0));
    };
    const up = () => {
      this.dragging = false;
    };
    this.clip.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    this.disposers.push(() => {
      this.clip.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    });
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.root.remove();
  }
}
