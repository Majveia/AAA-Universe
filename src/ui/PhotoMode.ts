/**
 * Photo mode.
 *
 * Everything disappears: markers, vitals, location, hints. What is left is the
 * frame itself — matte bars that ease in to the chosen aspect, a thirds grid at
 * 22% opacity, and one shutter. The hint line explains the camera once and then
 * fades out for good, because a photograph of a HUD telling you how to take a
 * photograph is not a photograph.
 */

import { el } from './Dom';

interface Aspect {
  name: string;
  /** width / height, 0 = match the screen. */
  r: number;
}

const ASPECTS: Aspect[] = [
  { name: 'full', r: 0 },
  { name: '16:9', r: 16 / 9 },
  { name: '2.39', r: 2.39 },
  { name: '1:1', r: 1 },
  { name: '4:5', r: 0.8 },
];

export class PhotoMode {
  readonly root: HTMLElement;

  private bars: HTMLElement[] = [];
  private grid: HTMLElement;
  private lines: HTMLElement[] = [];
  private hint: HTMLElement;
  private aspectBtn: HTMLElement;
  private open = false;
  private index = 0;
  private w = 1;
  private h = 1;
  private age = 0;

  onShutter: (() => void) | null = null;
  onExit: (() => void) | null = null;

  constructor(isTouch: boolean) {
    this.root = el('div', 'ae-pm');

    for (const cls of ['ae-t', 'ae-b', 'ae-l', 'ae-r']) {
      this.bars.push(el('div', `ae-pm-bar ${cls}`, this.root));
    }

    this.grid = el('div', 'ae-pm-grid', this.root);
    for (let i = 0; i < 2; i++) this.lines.push(el('i', 'v', this.grid));
    for (let i = 0; i < 2; i++) this.lines.push(el('i', 'h', this.grid));

    this.hint = el('div', 'ae-pm-hint', this.root);
    this.hint.textContent = isTouch
      ? 'drag to look · pinch to zoom · tap the shutter'
      : 'move freely · scroll to zoom · P to leave';

    const strip = el('div', 'ae-pm-strip', this.root);
    this.aspectBtn = el('div', 'ae-pm-aspect', strip);
    this.aspectBtn.textContent = ASPECTS[0].name;
    this.aspectBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cycle();
    });

    const shutter = el('div', 'ae-pm-shutter', strip);
    el('i', undefined, shutter);
    shutter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onShutter?.();
    });

    const exit = el('div', 'ae-pm-aspect', strip);
    exit.textContent = 'exit';
    exit.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onExit?.();
    });
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(v: boolean): void {
    if (this.open === v) return;
    this.open = v;
    this.age = 0;
    this.root.classList.add('ae-mounted');
    this.root.classList.toggle('ae-on', v);
    this.root.classList.remove('ae-quiet');
    this.applyAspect();
  }

  setViewport(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.applyAspect();
  }

  update(dt: number): void {
    if (!this.open) return;
    this.age += dt;
    if (this.age > 6 && !this.root.classList.contains('ae-quiet')) this.root.classList.add('ae-quiet');
  }

  private cycle(): void {
    this.index = (this.index + 1) % ASPECTS.length;
    this.aspectBtn.textContent = ASPECTS[this.index].name;
    this.age = 0;
    this.root.classList.remove('ae-quiet');
    this.applyAspect();
  }

  private applyAspect(): void {
    const a = ASPECTS[this.index];
    const screen = this.w / this.h;
    let barY = 0;
    let barX = 0;
    if (this.open && a.r > 0) {
      if (a.r > screen) {
        // Wider than the screen → matte the top and bottom.
        barY = (this.h - this.w / a.r) / 2;
      } else if (a.r < screen) {
        barX = (this.w - this.h * a.r) / 2;
      }
    }
    const sy = this.open ? barY / (this.h * 0.5) : 0;
    const sx = this.open ? barX / (this.w * 0.5) : 0;
    this.bars[0].style.transform = `scaleY(${sy.toFixed(4)})`;
    this.bars[1].style.transform = `scaleY(${sy.toFixed(4)})`;
    this.bars[2].style.transform = `scaleX(${sx.toFixed(4)})`;
    this.bars[3].style.transform = `scaleX(${sx.toFixed(4)})`;

    // Thirds inside the framed region, not the screen.
    const left = (barX / this.w) * 100;
    const right = 100 - left;
    const top = (barY / this.h) * 100;
    const bottom = 100 - top;
    const wSpan = right - left;
    const hSpan = bottom - top;
    this.lines[0].style.cssText = `left:${(left + wSpan / 3).toFixed(3)}%;top:${top}%;bottom:${top}%;`;
    this.lines[1].style.cssText = `left:${(left + (2 * wSpan) / 3).toFixed(3)}%;top:${top}%;bottom:${top}%;`;
    this.lines[2].style.cssText = `top:${(top + hSpan / 3).toFixed(3)}%;left:${left}%;right:${left}%;`;
    this.lines[3].style.cssText = `top:${(top + (2 * hSpan) / 3).toFixed(3)}%;left:${left}%;right:${left}%;`;
  }

  dispose(): void {
    this.root.remove();
  }
}
