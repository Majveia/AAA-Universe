/**
 * A writing system, generated.
 *
 * Signage is where a city tells you it belongs to someone. Latin letters on an
 * alien world break the spell instantly; a script with its own stroke grammar —
 * consistent stroke weight, a shared baseline, recurring radicals — reads as
 * language even though it says nothing.
 *
 * Each civilisation gets 64 glyphs rasterised into one 8×8 atlas. Strokes are
 * drawn as capsules with a soft edge, so the script survives being scaled onto
 * a hundred-metre marquee.
 */

import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RGBAFormat, RepeatWrapping, Texture } from 'three';
import { Rng } from '../core/Rand';

const CELL = 32;
const GRID = 8;
const SIZE = CELL * GRID; // 256²

interface Stroke {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
}

/**
 * Stroke vocabulary. A script is not random lines: it reuses a small set of
 * moves. We pick a per-civilisation subset and a per-civilisation stroke weight,
 * which is what makes two alphabets look like different languages.
 */
function buildGlyph(rng: Rng, style: number, weight: number): Stroke[] {
  const s: Stroke[] = [];
  const n = rng.int(2, 5);
  // A shared skeleton per script: vertical spine, horizontal bar, or a box.
  if (style === 0) {
    s.push({ x0: 0.5, y0: 0.12, x1: 0.5, y1: 0.88, w: weight });
  } else if (style === 1) {
    s.push({ x0: 0.14, y0: 0.5, x1: 0.86, y1: 0.5, w: weight });
  } else if (style === 2) {
    s.push({ x0: 0.18, y0: 0.16, x1: 0.82, y1: 0.16, w: weight });
    s.push({ x0: 0.18, y0: 0.16, x1: 0.18, y1: 0.84, w: weight });
  } else {
    s.push({ x0: 0.2, y0: 0.85, x1: 0.8, y1: 0.15, w: weight });
  }
  for (let i = 0; i < n; i++) {
    const kind = rng.int(0, 3);
    const a = rng.range(0.16, 0.84);
    const b = rng.range(0.16, 0.84);
    if (kind === 0) s.push({ x0: a, y0: 0.16, x1: a, y1: b, w: weight });
    else if (kind === 1) s.push({ x0: 0.16, y0: a, x1: b, y1: a, w: weight });
    else if (kind === 2) s.push({ x0: a, y0: b, x1: a + rng.range(-0.3, 0.3), y1: b + rng.range(-0.3, 0.3), w: weight * 0.8 });
    else s.push({ x0: a, y0: b, x1: rng.range(0.2, 0.8), y1: 0.84, w: weight });
  }
  return s;
}

function capsule(px: number, py: number, s: Stroke): number {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-9 ? ((px - s.x0) * dx + (py - s.y0) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = s.x0 + dx * t;
  const cy = s.y0 + dy * t;
  return Math.hypot(px - cx, py - cy) - s.w;
}

/**
 * Rasterise 64 glyphs. Red channel is coverage; green carries a slight inner
 * gradient so the shader can fake a tube-neon core if it wants one.
 */
export function makeGlyphTexture(seed: number): Texture {
  const rng = new Rng(seed ^ 0x9e37);
  const style = rng.int(0, 3);
  const weight = rng.range(0.035, 0.075);
  const data = new Uint8Array(SIZE * SIZE * 4);
  const soft = 1.4 / CELL;

  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const strokes = buildGlyph(rng.fork(gy * GRID + gx), style, weight);
      for (let py = 0; py < CELL; py++) {
        for (let px = 0; px < CELL; px++) {
          const u = (px + 0.5) / CELL;
          const v = (py + 0.5) / CELL;
          let d = 1e9;
          for (let i = 0; i < strokes.length; i++) {
            const dd = capsule(u, v, strokes[i]);
            if (dd < d) d = dd;
          }
          // Smoothstep the signed distance into coverage.
          let a = 1 - (d + soft) / (2 * soft);
          a = a < 0 ? 0 : a > 1 ? 1 : a;
          a = a * a * (3 - 2 * a);
          const core = Math.max(0, 1 - Math.abs(d) / (weight * 1.2));
          const idx = ((gy * CELL + py) * SIZE + (gx * CELL + px)) * 4;
          data[idx] = (a * 255) | 0;
          data[idx + 1] = (core * 255) | 0;
          data[idx + 2] = 0;
          data[idx + 3] = 255;
        }
      }
    }
  }

  const tex = new DataTexture(data, SIZE, SIZE, RGBAFormat);
  tex.needsUpdate = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.name = 'civ-glyphs';
  return tex;
}
