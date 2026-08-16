/**
 * Tiny DOM + easing helpers shared by the UI modules.
 *
 * The HUD is DOM rather than canvas so text stays crisp at any DPI, but that
 * means every write is a potential layout. These helpers exist so the rest of
 * the UI can be written as "set this transform, set this opacity" and nothing
 * else — no reads, no geometry queries, no string concatenation in the loop.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  parent?: Element
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(cls?: string, parent?: Element, viewBox = '0 0 24 24'): SVGSVGElement {
  const n = document.createElementNS(SVG_NS, 'svg');
  if (cls) n.setAttribute('class', cls);
  n.setAttribute('viewBox', viewBox);
  n.setAttribute('fill', 'none');
  n.setAttribute('stroke', 'currentColor');
  n.setAttribute('stroke-width', '1.15');
  n.setAttribute('stroke-linecap', 'round');
  n.setAttribute('stroke-linejoin', 'round');
  if (parent) parent.appendChild(n);
  return n;
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential approach. `lambda` is roughly "how many
 * e-folds per second"; 8–14 feels immediate, 2–4 feels like drifting.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Shortest signed difference between two angles in degrees. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** Guarded localStorage — private browsing throws on write. */
export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) } as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked — the HUD degrades to "always show hints" */
  }
}
