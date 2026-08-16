/**
 * ÆON's interface.
 *
 * The brief, in one line: the HUD should mostly be invisible, and should appear
 * only when it has something to say.
 *
 * So there is nothing in the middle of the screen, ever. Readouts live in the
 * corners, markers live on the things they describe, and both fade rather than
 * appear. One accent colour. Hairlines. Tabular numerals. Every transition on
 * the same easing curve, so the whole interface moves like one object.
 *
 * Structurally it is a DOM overlay — text stays crisp at any DPI and the
 * browser's compositor does the animation for free — with a hard rule that the
 * per-frame path only ever writes `transform` and `opacity`, and only when the
 * value has actually changed. Anything that costs layout (button placement,
 * safe-area insets, compass width) is computed on resize and cached.
 */

import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import type { HudTarget, IHud, SystemContext } from '../api/Contracts';
import type { Engine } from '../core/Engine';
import { clamp01, damp, el } from './Dom';
import { ensureStyle } from './Theme';
import { Markers } from './Markers';
import { Compass } from './Compass';
import { Readouts, Vitals } from './Readouts';
import { KeyHints } from './KeyHints';
import { Learn } from './Learn';
import { TouchControls, HudContext } from './TouchControls';
import { SettingsPanel } from './SettingsPanel';
import { PhotoMode } from './PhotoMode';

interface Toast {
  root: HTMLElement;
  life: number;
  out: boolean;
}

const EYEBROW: Record<HudContext, string> = {
  cosmos: 'the deep field',
  map: 'star chart',
  space: 'in transit',
  orbit: 'orbital insertion',
  foot: 'landfall',
  vehicle: 'overland',
};

/** Contexts where a pointer-lock prompt makes sense. */
const PLAY_CONTEXTS: HudContext[] = ['foot', 'vehicle', 'space', 'orbit', 'cosmos'];

const _fwd = new Vector3();
const _north = new Vector3();
const _east = new Vector3();
const _up = new Vector3(0, 1, 0);

export class Hud implements IHud {
  readonly element: HTMLElement;

  private engine: Engine;
  private stage: HTMLElement;

  private markers: Markers;
  private compass: Compass;
  private rail: Readouts;
  private hints: KeyHints;
  private learn: Learn;
  private touch: TouchControls;
  private panel: SettingsPanel;
  private photo: PhotoMode;

  private locBox: HTMLElement;
  private locPrimary: HTMLElement;
  private locSecondary: HTMLElement;
  private toastBox: HTMLElement;
  private prompt: HTMLElement;
  private title: HTMLElement;
  private titleEyebrow: HTMLElement;
  private titleName: HTMLElement;
  private titleSub: HTMLElement;
  private scan: HTMLElement;
  private scanRows: HTMLElement;
  private veil: HTMLElement;
  private flash: HTMLElement;

  private ctx: HudContext = 'foot';
  private vitals: Vitals = {};
  private toasts: Toast[] = [];
  private timers = new Set<number>();

  private visible = false;
  private scanning = false;
  private externalScan = false;
  private veilValue = 0;
  private veilWritten = -1;
  private promptOn = false;
  private lockCooldown = 0;
  private gamepad = false;
  private padCheck = 0;
  private scanAcc = 0;
  private bearingAcc = 0;
  private bearings: number[] = [];
  private busy = 0;
  private w = 1;
  private h = 1;
  private insets = { t: 0, b: 0, l: 0, r: 0 };
  private probe: HTMLElement;
  private disposers: (() => void)[] = [];
  private locSwap = 0;
  private pendingLoc: [string, string] | null = null;

  constructor(engine: Engine) {
    this.engine = engine;
    ensureStyle();

    this.element = el('div', 'aeon-hud ae-off');
    this.stage = el('div', 'ae-stage', this.element);

    /* ── world markers ── */
    this.markers = new Markers(engine.device.isMobile ? 18 : 30);
    this.stage.appendChild(this.markers.root);

    /* ── compass ── */
    this.compass = new Compass();
    this.stage.appendChild(this.compass.root);

    /* ── bottom-left: hints over location ── */
    const left = el('div', 'ae-left ae-h', this.stage);
    this.learn = new Learn();
    this.hints = new KeyHints(this.learn);
    left.appendChild(this.hints.root);
    this.locBox = el('div', 'ae-loc', left);
    el('div', 'ae-loc-rule', this.locBox);
    this.locPrimary = el('div', 'ae-loc-p', this.locBox);
    this.locSecondary = el('div', 'ae-loc-s', this.locBox);

    /* ── bottom-right: vitals ── */
    this.rail = new Readouts();
    this.stage.appendChild(this.rail.root);

    /* ── transient text ── */
    this.toastBox = el('div', 'ae-toasts ae-h', this.stage);
    this.prompt = el('div', 'ae-prompt ae-h', this.stage);
    this.prompt.textContent = 'click to look';

    /* ── title card ── */
    this.title = el('div', 'ae-title ae-h', this.stage);
    el('div', 'ae-title-wash', this.title);
    const tin = el('div', 'ae-title-in', this.title);
    this.titleEyebrow = el('div', 'ae-t-eyebrow', tin);
    this.titleName = el('div', 'ae-t-name', tin);
    el('div', 'ae-t-rule', tin);
    this.titleSub = el('div', 'ae-t-sub', tin);

    /* ── scanner ── */
    this.scan = el('div', 'ae-scan ae-h', this.stage);
    el('div', 'ae-scan-field', this.scan);
    for (let i = 0; i < 3; i++) el('div', 'ae-scan-ring', this.scan);
    const brk = el('div', 'ae-scan-brk', this.scan);
    for (let i = 0; i < 4; i++) el('i', undefined, brk);
    const meta = el('div', 'ae-scan-meta', this.scan);
    const mh = el('div', 'ae-sm-h', meta);
    mh.textContent = 'contacts';
    this.scanRows = el('div', undefined, meta);

    /* ── touch ── */
    this.touch = new TouchControls(engine.input, this.learn);
    this.touch.root.classList.add('ae-h');
    this.stage.appendChild(this.touch.root);
    this.touch.onPress = (id) => this.onTouchPress(id);

    /* ── photo mode + settings (above the stage fade) ── */
    this.photo = new PhotoMode(engine.device.isTouch);
    this.photo.onShutter = () => this.shoot();
    this.photo.onExit = () => this.setPhoto(false);
    this.stage.appendChild(this.photo.root);

    this.panel = new SettingsPanel(engine);
    this.panel.onClose = () => this.onPanelClosed();
    this.panel.onResetHints = () => this.resetHints();
    this.element.appendChild(this.panel.root);

    /* ── veil + shutter flash, outside the stage so they survive setVisible ── */
    this.veil = el('div', 'ae-veil', this.element);
    el('div', 'ae-veil-core', this.veil);
    el('div', 'ae-veil-chroma', this.veil);
    el('div', 'ae-veil-streak', this.veil);
    this.flash = el('div', 'ae-flash', this.element);

    /* ── safe-area probe: read once per resize, never per frame ── */
    this.probe = el('div', undefined, this.element);
    this.probe.style.cssText =
      'position:absolute;visibility:hidden;pointer-events:none;top:0;left:0;width:0;height:0;' +
      'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);' +
      'padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px);';

    if (engine.device.isTouch) this.element.classList.add('ae-touch-on');
    if (engine.prefs.reduceMotion) this.element.classList.add('ae-calm');

    this.bindWindow();
    this.measure();
    this.setContext('cosmos');
  }

  /* ═══════════════════════ IHud ═══════════════════════ */

  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    this.element.classList.toggle('ae-off', !v);
    this.touch.setEnabled(v && this.engine.device.isTouch && !this.photo.isOpen());
    this.hints.setEnabled(v && !this.engine.device.isTouch);
    if (v) this.hints.setContext(this.ctx);
  }

  setTargets(targets: HudTarget[]): void {
    this.markers.setTargets(targets);
  }

  setLocation(primary: string, secondary?: string): void {
    const p = primary ?? '';
    const s = secondary ?? '';
    if (this.locPrimary.textContent === p && this.locSecondary.textContent === s) return;
    // Cross-dissolve rather than a text swap: a name changing under your eye
    // without motion reads as a bug.
    this.pendingLoc = [p, s];
    this.locBox.classList.add('ae-swap');
    this.locSwap = 0.28;
  }

  toast(text: string, durationS = 3.4): void {
    if (!text) return;
    const root = el('div', 'ae-toast', this.toastBox);
    root.textContent = text;
    const t: Toast = { root, life: Math.max(0.6, durationS), out: false };
    this.toasts.push(t);
    // Three is the most that can be read before the first has gone.
    while (this.toasts.length > 3) {
      const old = this.toasts.shift()!;
      old.root.remove();
    }
    this.after(16, () => root.classList.add('ae-on'));
  }

  titleCard(title: string, subtitle?: string): void {
    if (!title) return;
    this.titleEyebrow.textContent = EYEBROW[this.ctx] ?? '';
    this.titleName.textContent = title;
    this.titleSub.textContent = subtitle ?? '';

    const t = this.title;
    t.classList.remove('ae-play', 'ae-out');
    t.classList.add('ae-on');
    // Force a reflow so re-triggering the same card actually restarts it.
    void t.offsetWidth;
    t.classList.add('ae-play');

    this.after(4200, () => t.classList.add('ae-out'));
    this.after(5900, () => {
      t.classList.remove('ae-on', 'ae-play', 'ae-out');
    });
  }

  setVitals(v: Vitals): void {
    Object.assign(this.vitals, v);
    this.rail.set(v);
  }

  setContext(mode: HudContext): void {
    if (this.ctx === mode) return;
    this.ctx = mode;
    this.element.setAttribute('data-ctx', mode);
    this.rail.setContext(mode);
    this.touch.setContext(mode);
    this.hints.setContext(mode);
    // The heading strip is for walking and driving; in space it is meaningless.
    this.compass.setActive(mode === 'foot' || mode === 'vehicle');
  }

  setScanning(active: boolean): void {
    this.externalScan = true;
    this.applyScanning(active);
  }

  setVeil(v: number): void {
    this.veilValue = clamp01(v);
    if (Math.abs(this.veilValue - this.veilWritten) < 0.003) return;
    this.veilWritten = this.veilValue;
    const on = this.veilValue > 0.002;
    // Unmounted at rest: the streak layer is a full-screen conic gradient and
    // `display:none` is the only way to guarantee it costs nothing.
    this.veil.classList.toggle('ae-mounted', on);
    if (!on) return;
    this.veil.style.opacity = this.veilValue.toFixed(3);
    // The chromatic ring closes in as the veil takes hold.
    this.veil.style.setProperty('--ae-veil-s', (1.34 - 0.34 * this.veilValue).toFixed(3));
  }

  /* ═══════════════════════ frame ═══════════════════════ */

  update(dt: number, ctx?: SystemContext): void {
    const engine = this.engine;
    const input = engine.input;
    const step = Math.min(dt || 0, 0.1);

    /* Toggles are processed even when the HUD is hidden, otherwise a player
       who turned the interface off could never turn it back on. */
    if (input.pressed('menu')) this.setPanel(!this.panel.isOpen());
    if (input.pressed('photo')) this.setPhoto(!this.photo.isOpen());
    if (input.pressed('pause')) {
      if (this.photo.isOpen()) this.setPhoto(false);
      else if (this.panel.isOpen()) this.setPanel(false);
    }
    // If nothing owns the scanner, mirror the scan key so the overlay is not
    // dead weight in realms that have not wired it up yet.
    if (!this.externalScan) this.applyScanning(input.isDown('scan'));

    this.panel.tick(step);
    this.photo.update(step);
    this.updateToasts(step);
    this.updateLocation(step);

    const showHud = this.visible && engine.prefs.showHud !== false;
    if (!showHud) return;

    const camera = (ctx?.camera as PerspectiveCamera) ?? (engine.current?.camera as PerspectiveCamera);
    if (!camera) return;

    if (!this.photo.isOpen()) {
      this.markers.update(step, camera, this.scanning);
      this.updateCompass(step, camera, input);
    }
    this.rail.update(step);

    /* Desktop-only affordances. */
    if (!engine.device.isTouch) {
      this.hints.update(step, input);
      this.padCheck -= step;
      if (this.padCheck <= 0) {
        this.padCheck = 0.75;
        const pad = input.hasGamepad();
        if (pad !== this.gamepad) {
          this.gamepad = pad;
          this.hints.setGamepad(pad);
        }
      }
      this.updatePrompt(step, input);
    }

    if (this.scanning) this.updateScanRows(step);
  }

  /* ═══════════════════════ internals ═══════════════════════ */

  private updateToasts(dt: number): void {
    if (!this.toasts.length) return;
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.life -= dt;
      if (t.life <= 0 && !t.out) {
        t.out = true;
        t.root.classList.remove('ae-on');
        t.root.classList.add('ae-out');
        t.life = -0.55;
      } else if (t.out && t.life < -0.5) {
        t.root.remove();
        this.toasts.splice(i, 1);
      }
    }
  }

  private updateLocation(dt: number): void {
    if (this.locSwap <= 0) return;
    this.locSwap -= dt;
    if (this.locSwap > 0 || !this.pendingLoc) return;
    const [p, s] = this.pendingLoc;
    this.pendingLoc = null;
    this.locPrimary.textContent = p;
    this.locSecondary.textContent = s;
    this.locBox.classList.remove('ae-swap');
  }

  /**
   * Heading is derived from the camera and the player's local up, so it stays
   * correct on a sphere — "north" is the planet's pole projected onto the
   * tangent plane, not a fixed world axis.
   */
  private updateCompass(dt: number, camera: PerspectiveCamera, input: any): void {
    if (this.ctx !== 'foot' && this.ctx !== 'vehicle') return;

    camera.getWorldDirection(_fwd);
    const state = this.engine.services.player?.state;
    const up: Vector3 = state?.up?.isVector3 ? state.up : _up;

    _north.set(0, 1, 0);
    if (Math.abs(_north.dot(up)) > 0.985) _north.set(1, 0, 0);
    _north.addScaledVector(up, -_north.dot(up)).normalize();
    _east.crossVectors(_north, up).normalize();

    _fwd.addScaledVector(up, -_fwd.dot(up));
    if (_fwd.lengthSq() < 1e-8) return;
    _fwd.normalize();
    const heading = (Math.atan2(_fwd.dot(_east), _fwd.dot(_north)) * (180 / Math.PI) + 360) % 360;

    const moving = input.move.lengthSq() > 0.04 || (state?.speed ?? 0) > 0.4;
    this.busy = moving ? 0.6 : Math.max(0, this.busy - dt);

    this.bearingAcc -= dt;
    if (this.bearingAcc <= 0) {
      this.bearingAcc = 0.12;
      this.collectBearings(camera.position);
    }
    this.compass.update(dt, heading, this.busy > 0, this.bearings);
  }

  private collectBearings(origin: Vector3): void {
    this.bearings.length = 0;
    const targets = (this.markers as any).targets as HudTarget[] | undefined;
    if (!targets) return;
    for (const t of targets) {
      if (!t.important) continue;
      this.bearings.push(Markers.azimuth(t.position, origin, _north, _east));
      if (this.bearings.length >= 4) break;
    }
  }

  private updatePrompt(dt: number, input: any): void {
    this.lockCooldown = Math.max(0, this.lockCooldown - dt);
    const want =
      !input.pointerLocked &&
      !this.panel.isOpen() &&
      !this.photo.isOpen() &&
      this.engine.services.started === true &&
      PLAY_CONTEXTS.includes(this.ctx);
    if (want !== this.promptOn) {
      this.promptOn = want;
      this.prompt.classList.toggle('ae-on', want);
      // Give the browser a moment after an Escape-driven unlock, or the
      // re-request throws a SecurityError straight into the console.
      if (!want) this.lockCooldown = 1.2;
    }
  }

  private applyScanning(active: boolean): void {
    if (this.scanning === active) return;
    this.scanning = active;
    this.scan.classList.add('ae-mounted');
    this.scan.classList.toggle('ae-on', active);
    this.element.classList.toggle('ae-scanning', active);
    if (!active) {
      // Unmount after the fade so the rings stop animating entirely.
      this.after(500, () => {
        if (!this.scanning) this.scan.classList.remove('ae-mounted');
      });
    } else {
      this.scanAcc = 0;
    }
  }

  private updateScanRows(dt: number): void {
    this.scanAcc -= dt;
    if (this.scanAcc > 0) return;
    this.scanAcc = 0.25;
    const contacts = this.markers.contacts;
    const rows = this.scanRows.children;
    for (let i = 0; i < contacts.length; i++) {
      let row = rows[i] as HTMLElement;
      if (!row) {
        row = el('div', 'ae-scan-row', this.scanRows);
        el('span', undefined, row);
        el('span', undefined, row);
      }
      const c = contacts[i];
      const a = row.children[0] as HTMLElement;
      const b = row.children[1] as HTMLElement;
      const label = c.label.length > 18 ? `${c.label.slice(0, 17)}…` : c.label;
      if (a.textContent !== label) a.textContent = label;
      if (b.textContent !== c.distText) b.textContent = c.distText;
      row.style.display = '';
    }
    for (let i = contacts.length; i < rows.length; i++) {
      (rows[i] as HTMLElement).style.display = 'none';
    }
    if (!contacts.length && rows.length === 0) {
      const row = el('div', 'ae-scan-row', this.scanRows);
      el('span', undefined, row).textContent = 'no contacts';
      el('span', undefined, row);
    }
  }

  /* ─────────────── panels ─────────────── */

  private setPanel(open: boolean): void {
    if (open && this.photo.isOpen()) this.setPhoto(false);
    this.panel.setOpen(open);
    if (open) {
      this.engine.input.exitPointerLock();
      this.engine.services.player?.setControlEnabled?.(false);
      this.touch.setEnabled(false);
    } else {
      this.onPanelClosed();
    }
  }

  private onPanelClosed(): void {
    this.engine.services.player?.setControlEnabled?.(true);
    this.touch.setEnabled(this.visible && this.engine.device.isTouch && !this.photo.isOpen());
  }

  private setPhoto(open: boolean): void {
    if (open && this.panel.isOpen()) this.panel.setOpen(false);
    this.photo.setOpen(open);
    this.element.classList.toggle('ae-photo', open);
    this.touch.setEnabled(!open && this.visible && this.engine.device.isTouch);
    if (open) this.toast('photo mode', 2.2);
  }

  private shoot(): void {
    this.flash.classList.remove('ae-fire');
    void this.flash.offsetWidth;
    this.flash.classList.add('ae-fire');
    // Capture on the next frame so the flash has painted but the world has not
    // yet been overdrawn by it — the canvas is a separate surface.
    this.after(0, () => {
      try {
        const url = this.engine.capture();
        const a = document.createElement('a');
        a.href = url;
        a.download = `aeon-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        this.toast('captured', 1.8);
      } catch {
        this.toast('capture failed', 2);
      }
    });
  }

  private resetHints(): void {
    this.learn.reset();
    this.hints.setContext(this.ctx);
    this.touch.refreshLearned();
    this.toast('control hints restored', 2.4);
  }

  private onTouchPress(id: string): void {
    // Touch buttons already synthesise their action through Input; the HUD only
    // needs the two that exist purely for the interface.
    if (id === 'menu' || id === 'photo') this.lockCooldown = 0.4;
  }

  /* ─────────────── viewport ─────────────── */

  private bindWindow(): void {
    const onResize = () => this.measure();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => window.setTimeout(onResize, 140));
    window.visualViewport?.addEventListener('resize', onResize);
    this.disposers.push(() => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    });

    // Desktop: any click in the world re-acquires pointer lock. Guarded so an
    // Escape-driven unlock is not instantly undone.
    const onDown = (e: PointerEvent) => {
      if (this.engine.device.isTouch) return;
      if (this.panel.isOpen() || this.photo.isOpen()) return;
      if (this.lockCooldown > 0) return;
      if (this.engine.services.started !== true) return;
      if (document.pointerLockElement) return;
      const t = e.target as HTMLElement;
      if (t && t.closest && t.closest('.ae-panel,.ae-pm-strip')) return;
      try {
        this.engine.input.requestPointerLock();
      } catch {
        /* the browser refused; the prompt stays up and we try again later */
      }
    };
    window.addEventListener('pointerdown', onDown);
    this.disposers.push(() => window.removeEventListener('pointerdown', onDown));
  }

  private measure(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.w = w;
    this.h = h;

    const cs = getComputedStyle(this.probe);
    this.insets = {
      t: parseFloat(cs.paddingTop) || 0,
      b: parseFloat(cs.paddingBottom) || 0,
      l: parseFloat(cs.paddingLeft) || 0,
      r: parseFloat(cs.paddingRight) || 0,
    };

    this.markers.setViewport(w, h, this.engine.device.isMobile);
    this.touch.setViewport(w, h, this.insets);
    this.photo.setViewport(w, h);
    this.compass.measure();
  }

  private after(ms: number, fn: () => void): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  /* ═══════════════════════ teardown ═══════════════════════ */

  dispose(): void {
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    for (const d of this.disposers) d();
    this.disposers.length = 0;

    this.markers.dispose();
    this.compass.dispose();
    this.rail.dispose();
    this.hints.dispose();
    this.touch.dispose();
    this.panel.dispose();
    this.photo.dispose();
    this.learn.dispose();

    for (const t of this.toasts) t.root.remove();
    this.toasts.length = 0;
    this.element.remove();
  }
}
