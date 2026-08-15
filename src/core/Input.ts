/**
 * Unified input: keyboard + mouse, gamepad, and touch — all funnelled into one
 * small state object the gameplay code reads.
 *
 * Design rules, learned from the games this is chasing:
 *  - Look input is *never* smoothed on mouse (adds latency, feels like mud) but
 *    *is* smoothed on stick and touch, where raw values are noisy.
 *  - Sticks get a radial deadzone with rescaling, so slow walking is possible.
 *  - Touch joysticks are dynamic: the stick appears wherever the thumb lands,
 *    instead of asking the player to hunt for a fixed circle they can't see.
 *  - Everything is edge-detectable (`pressed`/`released`), because holding and
 *    tapping the same button usually mean different things.
 */

import { Vector2 } from 'three';

export type Action =
  | 'jump'
  | 'sprint'
  | 'crouch'
  | 'interact'
  | 'toggleView'
  | 'boost'
  | 'brake'
  | 'handbrake'
  | 'scan'
  | 'map'
  | 'photo'
  | 'pause'
  | 'menu'
  | 'ascend'
  | 'descend'
  | 'rollLeft'
  | 'rollRight'
  | 'enter'
  | 'warp'
  | 'zoomIn'
  | 'zoomOut'
  | 'lightToggle'
  | 'nextTarget'
  | 'prevTarget';

const KEY_MAP: Record<string, Action> = {
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  ControlLeft: 'crouch',
  KeyC: 'crouch',
  KeyE: 'interact',
  KeyF: 'interact',
  KeyV: 'toggleView',
  KeyR: 'boost',
  KeyX: 'brake',
  KeyQ: 'rollLeft',
  KeyZ: 'handbrake',
  KeyT: 'scan',
  KeyM: 'map',
  KeyP: 'photo',
  Escape: 'pause',
  Tab: 'menu',
  KeyL: 'lightToggle',
  KeyJ: 'warp',
  Enter: 'enter',
  BracketRight: 'zoomIn',
  BracketLeft: 'zoomOut',
  KeyN: 'nextTarget',
  KeyB: 'prevTarget',
};

/** Standard-gamepad button index → action. */
const PAD_MAP: Record<number, Action> = {
  0: 'jump', // A / ✕
  1: 'crouch', // B / ○
  2: 'interact', // X / □
  3: 'toggleView', // Y / △
  4: 'prevTarget', // LB
  5: 'nextTarget', // RB
  6: 'brake', // LT
  7: 'boost', // RT
  8: 'map', // select
  9: 'pause', // start
  10: 'sprint', // L3
  11: 'scan', // R3
  12: 'ascend', // dpad up
  13: 'descend', // dpad down
  14: 'rollLeft',
  15: 'rollRight',
};

interface TouchStick {
  id: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  active: boolean;
  radius: number;
}

export interface TouchButtonSpec {
  id: string;
  action: Action;
  /** Normalised screen-space anchor, 0..1 from top-left. */
  ax: number;
  ay: number;
  /** Radius in CSS pixels. */
  r: number;
  visible?: boolean;
}

export class Input {
  /** Movement intent, -1..1 per axis. y > 0 is forward. */
  readonly move = new Vector2();
  /** Look delta accumulated since last `endFrame()`, in radians-ish units. */
  readonly look = new Vector2();
  /** Right-stick style analogue look (already deadzoned+curved), -1..1. */
  readonly lookStick = new Vector2();
  /** Analogue triggers, 0..1. */
  throttle = 0;
  reverse = 0;
  /** Wheel delta accumulated this frame. */
  wheel = 0;
  /** Pinch scale delta this frame (touch). */
  pinch = 0;

  pointerLocked = false;
  isTouchDevice = false;
  /** True when any touch/mouse is currently down. */
  pointerDown = false;

  sensitivity = 1;
  invertY = false;

  private down = new Set<Action>();
  private justDown = new Set<Action>();
  private justUp = new Set<Action>();
  private keysDown = new Set<string>();
  private keysJustDown = new Set<string>();

  private el: HTMLElement;
  private moveStick: TouchStick = { id: -1, originX: 0, originY: 0, x: 0, y: 0, active: false, radius: 70 };
  private lookTouchId = -1;
  private lookLastX = 0;
  private lookLastY = 0;
  private lookVel = new Vector2();
  private pinchIds: number[] = [];
  private pinchLastDist = 0;
  private touchButtons: TouchButtonSpec[] = [];
  private touchButtonHeld = new Map<string, number>();
  private padIndex = -1;
  private padPrev: boolean[] = [];
  private disposers: (() => void)[] = [];

  /** Callbacks so the HUD can draw the sticks it owns. */
  onStickChange: ((stick: { active: boolean; ox: number; oy: number; x: number; y: number; radius: number }) => void) | null = null;
  onLookDrag: ((active: boolean, x: number, y: number) => void) | null = null;
  onButton: ((id: string, downNow: boolean) => void) | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    this.isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.bind();
  }

  setTouchButtons(specs: TouchButtonSpec[]): void {
    this.touchButtons = specs;
  }

  /* ─────────────────────────── queries ─────────────────────────── */

  isDown(a: Action): boolean {
    return this.down.has(a);
  }
  pressed(a: Action): boolean {
    return this.justDown.has(a);
  }
  released(a: Action): boolean {
    return this.justUp.has(a);
  }
  key(code: string): boolean {
    return this.keysDown.has(code);
  }
  keyPressed(code: string): boolean {
    return this.keysJustDown.has(code);
  }

  /** Synthesise a press from UI (touch buttons, on-screen prompts). */
  virtualPress(a: Action): void {
    if (!this.down.has(a)) this.justDown.add(a);
    this.down.add(a);
  }
  virtualRelease(a: Action): void {
    if (this.down.has(a)) this.justUp.add(a);
    this.down.delete(a);
  }

  requestPointerLock(): void {
    if (this.isTouchDevice) return;
    this.el.requestPointerLock?.();
  }
  exitPointerLock(): void {
    document.exitPointerLock?.();
  }

  /* ─────────────────────────── frame ─────────────────────────── */

  /** Call once per frame *before* gameplay reads input. */
  beginFrame(dt: number): void {
    this.pollGamepad(dt);

    // Compose movement from keyboard, stick, or touch.
    let mx = 0;
    let my = 0;
    if (this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp')) my += 1;
    if (this.keysDown.has('KeyS') || this.keysDown.has('ArrowDown')) my -= 1;
    if (this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight')) mx += 1;
    if (this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft')) mx -= 1;
    if (mx !== 0 || my !== 0) {
      const l = Math.hypot(mx, my);
      mx /= l;
      my /= l;
    }
    if (this.moveStick.active) {
      mx += this.moveStick.x;
      my += this.moveStick.y;
    }
    mx += this.padMove.x;
    my += this.padMove.y;
    const ml = Math.hypot(mx, my);
    if (ml > 1) {
      mx /= ml;
      my /= ml;
    }
    this.move.set(mx, my);

    // Touch look carries momentum for a frame or two so flicks feel weighty.
    if (this.lookTouchId === -1 && (Math.abs(this.lookVel.x) > 0.0001 || Math.abs(this.lookVel.y) > 0.0001)) {
      this.look.x += this.lookVel.x;
      this.look.y += this.lookVel.y;
      const decay = Math.pow(0.0015, dt);
      this.lookVel.multiplyScalar(decay);
      if (this.lookVel.lengthSq() < 1e-8) this.lookVel.set(0, 0);
    }
  }

  /** Call once per frame *after* gameplay reads input. */
  endFrame(): void {
    this.justDown.clear();
    this.justUp.clear();
    this.keysJustDown.clear();
    this.look.set(0, 0);
    this.wheel = 0;
    this.pinch = 0;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }

  /* ─────────────────────────── gamepad ─────────────────────────── */

  private padMove = new Vector2();

  private pollGamepad(dt: number): void {
    this.padMove.set(0, 0);
    this.lookStick.set(0, 0);
    const pads = navigator.getGamepads?.();
    if (!pads) return;
    let pad: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected) {
        pad = p;
        break;
      }
    }
    if (!pad) {
      this.padIndex = -1;
      return;
    }
    this.padIndex = pad.index;

    const dz = (v: number, dead = 0.14) => {
      const a = Math.abs(v);
      if (a < dead) return 0;
      return Math.sign(v) * ((a - dead) / (1 - dead));
    };
    // Radial deadzone on the left stick preserves diagonal precision.
    let lx = pad.axes[0] ?? 0;
    let ly = pad.axes[1] ?? 0;
    const lmag = Math.hypot(lx, ly);
    if (lmag > 0.14) {
      const scaled = (lmag - 0.14) / (1 - 0.14);
      lx = (lx / lmag) * scaled;
      ly = (ly / lmag) * scaled;
    } else {
      lx = 0;
      ly = 0;
    }
    this.padMove.set(lx, -ly);

    // Cubic response on look: precise near centre, fast at the edge.
    const rx = dz(pad.axes[2] ?? 0);
    const ry = dz(pad.axes[3] ?? 0);
    const curve = (v: number) => v * v * v * 0.75 + v * 0.25;
    this.lookStick.set(curve(rx), curve(ry));
    const padLookSpeed = 2.6 * this.sensitivity * dt;
    this.look.x += this.lookStick.x * padLookSpeed;
    this.look.y += this.lookStick.y * padLookSpeed * (this.invertY ? -1 : 1);

    this.throttle = Math.max(this.throttle, pad.buttons[7]?.value ?? 0);
    this.reverse = Math.max(this.reverse, pad.buttons[6]?.value ?? 0);

    for (let i = 0; i < pad.buttons.length; i++) {
      const isDown = pad.buttons[i].pressed || pad.buttons[i].value > 0.5;
      const was = this.padPrev[i] ?? false;
      const act = PAD_MAP[i];
      if (act) {
        if (isDown && !was) this.virtualPress(act);
        else if (!isDown && was) this.virtualRelease(act);
      }
      this.padPrev[i] = isDown;
    }
  }

  hasGamepad(): boolean {
    return this.padIndex >= 0;
  }

  /* ─────────────────────────── binding ─────────────────────────── */

  private bind(): void {
    const add = <K extends keyof WindowEventMap>(
      target: EventTarget,
      type: string,
      fn: (e: any) => void,
      opts?: AddEventListenerOptions
    ) => {
      target.addEventListener(type, fn, opts);
      this.disposers.push(() => target.removeEventListener(type, fn, opts));
    };

    /* ---- keyboard ---- */
    add(window, 'keydown', (e: KeyboardEvent) => {
      if (e.repeat) return;
      // Let the browser keep its reload/devtools/copy shortcuts.
      if (e.metaKey || e.ctrlKey) return;
      this.keysDown.add(e.code);
      this.keysJustDown.add(e.code);
      const a = KEY_MAP[e.code];
      if (a) this.virtualPress(a);
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    add(window, 'keyup', (e: KeyboardEvent) => {
      this.keysDown.delete(e.code);
      const a = KEY_MAP[e.code];
      if (a) this.virtualRelease(a);
    });
    // A dropped keyup while unfocused leaves the player sprinting into a wall.
    add(window, 'blur', () => {
      for (const a of Array.from(this.down)) this.virtualRelease(a);
      this.keysDown.clear();
      this.moveStick.active = false;
      this.pointerDown = false;
    });

    /* ---- mouse ---- */
    add(document, 'pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.el;
    });
    add(this.el, 'mousedown', (e: MouseEvent) => {
      this.pointerDown = true;
      if (e.button === 2) this.virtualPress('scan');
    });
    add(window, 'mouseup', (e: MouseEvent) => {
      this.pointerDown = false;
      if (e.button === 2) this.virtualRelease('scan');
    });
    add(this.el, 'contextmenu', (e: Event) => e.preventDefault());
    add(window, 'mousemove', (e: MouseEvent) => {
      if (!this.pointerLocked) return;
      // Raw deltas, no smoothing — mouse look must be 1:1 or it feels broken.
      const s = 0.0022 * this.sensitivity;
      this.look.x += e.movementX * s;
      this.look.y += e.movementY * s * (this.invertY ? -1 : 1);
    });
    add(
      this.el,
      'wheel',
      (e: WheelEvent) => {
        e.preventDefault();
        this.wheel += Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 100 + 0.35);
      },
      { passive: false } as AddEventListenerOptions
    );

    /* ---- touch ---- */
    const touchOpts = { passive: false } as AddEventListenerOptions;
    add(
      this.el,
      'touchstart',
      (e: TouchEvent) => {
        e.preventDefault();
        this.pointerDown = true;
        const w = window.innerWidth;
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];

          // Buttons win over sticks wherever they overlap.
          const hit = this.hitButton(t.clientX, t.clientY);
          if (hit) {
            this.touchButtonHeld.set(hit.id, t.identifier);
            this.virtualPress(hit.action);
            this.onButton?.(hit.id, true);
            continue;
          }

          if (t.clientX < w * 0.46 && !this.moveStick.active) {
            this.moveStick.id = t.identifier;
            this.moveStick.originX = t.clientX;
            this.moveStick.originY = t.clientY;
            this.moveStick.x = 0;
            this.moveStick.y = 0;
            this.moveStick.active = true;
            this.emitStick();
          } else if (this.lookTouchId === -1) {
            this.lookTouchId = t.identifier;
            this.lookLastX = t.clientX;
            this.lookLastY = t.clientY;
            this.lookVel.set(0, 0);
            this.onLookDrag?.(true, t.clientX, t.clientY);
          }
        }
        this.updatePinch(e);
      },
      touchOpts
    );

    add(
      this.el,
      'touchmove',
      (e: TouchEvent) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          if (t.identifier === this.moveStick.id && this.moveStick.active) {
            const dx = t.clientX - this.moveStick.originX;
            const dy = t.clientY - this.moveStick.originY;
            const r = this.moveStick.radius;
            const d = Math.hypot(dx, dy);
            // Past the ring, the origin is dragged along — the stick never
            // "runs out" mid-sprint, which is the usual mobile frustration.
            if (d > r) {
              this.moveStick.originX += (dx / d) * (d - r);
              this.moveStick.originY += (dy / d) * (d - r);
            }
            const nx = (t.clientX - this.moveStick.originX) / r;
            const ny = (t.clientY - this.moveStick.originY) / r;
            const nl = Math.hypot(nx, ny);
            const scale = nl > 1 ? 1 / nl : 1;
            this.moveStick.x = nx * scale;
            this.moveStick.y = -ny * scale;
            this.emitStick();
          } else if (t.identifier === this.lookTouchId) {
            const s = 0.0042 * this.sensitivity;
            const dx = (t.clientX - this.lookLastX) * s;
            const dy = (t.clientY - this.lookLastY) * s * (this.invertY ? -1 : 1);
            this.look.x += dx;
            this.look.y += dy;
            this.lookVel.set(dx * 0.55, dy * 0.55);
            this.lookLastX = t.clientX;
            this.lookLastY = t.clientY;
            this.onLookDrag?.(true, t.clientX, t.clientY);
          }
        }
        this.updatePinch(e);
      },
      touchOpts
    );

    const endTouch = (e: TouchEvent) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === this.moveStick.id) {
          this.moveStick.active = false;
          this.moveStick.id = -1;
          this.moveStick.x = 0;
          this.moveStick.y = 0;
          this.emitStick();
        }
        if (t.identifier === this.lookTouchId) {
          this.lookTouchId = -1;
          this.onLookDrag?.(false, 0, 0);
        }
        for (const [id, tid] of this.touchButtonHeld) {
          if (tid === t.identifier) {
            const spec = this.touchButtons.find((b) => b.id === id);
            if (spec) this.virtualRelease(spec.action);
            this.touchButtonHeld.delete(id);
            this.onButton?.(id, false);
          }
        }
      }
      if (e.touches.length === 0) this.pointerDown = false;
      this.pinchIds.length = 0;
      this.pinchLastDist = 0;
    };
    add(this.el, 'touchend', endTouch, touchOpts);
    add(this.el, 'touchcancel', endTouch, touchOpts);
  }

  private hitButton(x: number, y: number): TouchButtonSpec | null {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const b of this.touchButtons) {
      if (b.visible === false) continue;
      const bx = b.ax * w;
      const by = b.ay * h;
      // Generous hit slop: fingers are imprecise and the targets are small.
      if (Math.hypot(x - bx, y - by) <= b.r * 1.35) return b;
    }
    return null;
  }

  private updatePinch(e: TouchEvent): void {
    if (e.touches.length === 2) {
      const a = e.touches[0];
      const b = e.touches[1];
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (this.pinchLastDist > 0) this.pinch += (d - this.pinchLastDist) / 200;
      this.pinchLastDist = d;
    } else {
      this.pinchLastDist = 0;
    }
  }

  private emitStick(): void {
    this.onStickChange?.({
      active: this.moveStick.active,
      ox: this.moveStick.originX,
      oy: this.moveStick.originY,
      x: this.moveStick.x,
      y: this.moveStick.y,
      radius: this.moveStick.radius,
    });
  }
}
