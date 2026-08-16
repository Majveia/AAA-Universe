/**
 * Where the clusters are.
 *
 * The GPU knows where every particle is but cannot answer a question. The
 * camera needs to: "which supercluster is under the cursor, so I can dive into
 * it?" So we keep a small CPU-side catalogue of the *peaks* of the primordial
 * field — the sites that will collapse into rich clusters — and carry each one
 * forward through the same Zel'dovich map the shader uses, so a node's
 * catalogue position and the glowing knot on screen are the same place at every
 * epoch.
 *
 * This is also where `collapsedFraction` comes from, and it is measured, not
 * asserted: we sample δ on a grid once, sort the samples, and at any epoch
 * count how much of the field sits above the spherical-collapse threshold
 * δ_c/D(a). The factor of two is the standard Press–Schechter correction for
 * the mass that is accreted onto peaks from below the threshold.
 */

import { Vector3 } from 'three';
import { DELTA_C } from './Cosmology';
import type { PrimordialField } from './Field';

export interface WebNode {
  /** Lagrangian (unperturbed) position, Mpc. */
  q: Vector3;
  /** Zel'dovich displacement at D = 1, Mpc. */
  psi: Vector3;
  /** Linear overdensity of the peak at D = 1. */
  delta: number;
  /** Comoving position at the current epoch, Mpc. Refreshed by `advance`. */
  position: Vector3;
  /** Rough halo richness, 0–1, for weighting the pick and sizing the marker. */
  richness: number;
}

export class NodeCatalog {
  readonly nodes: WebNode[] = [];
  /** Every grid sample of δ at D = 1, sorted ascending. */
  private sortedDelta: Float32Array;
  /** Radius beyond which we do not consider a node (the volume fades out). */
  private readonly visibleRadius: number;

  constructor(field: PrimordialField, gridN: number, boxMpc: number, maxNodes = 220) {
    const half = boxMpc * 0.5;
    this.visibleRadius = half * 0.98;
    const grid = field.deltaGrid(gridN, -half, boxMpc);

    this.sortedDelta = new Float32Array(grid);
    this.sortedDelta.sort();

    const cell = boxMpc / gridN;
    const idx = (x: number, y: number, z: number) => (z * gridN + y) * gridN + x;

    // A peak is a strict local maximum over its 26 neighbours. Anything below
    // ~1.4σ is a bump, not a cluster, and would clutter the pick results.
    const threshold = field.sigma * 1.4;
    const found: WebNode[] = [];
    for (let z = 1; z < gridN - 1; z++) {
      for (let y = 1; y < gridN - 1; y++) {
        for (let x = 1; x < gridN - 1; x++) {
          const d = grid[idx(x, y, z)];
          if (d < threshold) continue;
          let isPeak = true;
          for (let dz = -1; dz <= 1 && isPeak; dz++) {
            for (let dy = -1; dy <= 1 && isPeak; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;
                if (grid[idx(x + dx, y + dy, z + dz)] >= d) {
                  isPeak = false;
                  break;
                }
              }
            }
          }
          if (!isPeak) continue;

          // Sub-cell refinement: fit a parabola through the three samples on
          // each axis. Without it the nodes snap to a visible lattice.
          const px = parabolicOffset(grid[idx(x - 1, y, z)], d, grid[idx(x + 1, y, z)]);
          const py = parabolicOffset(grid[idx(x, y - 1, z)], d, grid[idx(x, y + 1, z)]);
          const pz = parabolicOffset(grid[idx(x, y, z - 1)], d, grid[idx(x, y, z + 1)]);

          const q = new Vector3(
            -half + (x + 0.5 + px) * cell,
            -half + (y + 0.5 + py) * cell,
            -half + (z + 0.5 + pz) * cell,
          );
          if (q.length() > this.visibleRadius) continue;

          found.push({
            q,
            psi: new Vector3(),
            delta: d,
            position: new Vector3(),
            richness: 0,
          });
        }
      }
    }

    // Keep the richest — a few hundred superclusters is plenty to navigate by,
    // and the ray test is then trivially cheap.
    found.sort((a, b) => b.delta - a.delta);
    const kept = found.slice(0, maxNodes);
    const peak = kept.length > 0 ? kept[0].delta : 1;
    const tmp: [number, number, number] = [0, 0, 0];
    for (const n of kept) {
      field.displacement(n.q.x, n.q.y, n.q.z, tmp);
      n.psi.set(tmp[0], tmp[1], tmp[2]);
      n.richness = Math.min(1, n.delta / peak);
      n.position.copy(n.q);
      this.nodes.push(n);
    }
  }

  /** Move every node to its comoving position at growth factor D. */
  advance(growth: number, displayScale: number): void {
    for (const n of this.nodes) {
      n.position.copy(n.psi).multiplyScalar(growth).add(n.q).multiplyScalar(displayScale);
    }
  }

  /**
   * Fraction of mass in collapsed haloes at growth factor D — Press–Schechter,
   * evaluated against the realised field rather than an assumed σ.
   */
  collapsedFraction(growth: number): number {
    if (growth <= 1e-6) return 0;
    const threshold = DELTA_C / growth;
    const arr = this.sortedDelta;
    // Binary search for the first sample above the threshold.
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < threshold) lo = mid + 1;
      else hi = mid;
    }
    const above = (arr.length - lo) / arr.length;
    return Math.min(1, above * 2);
  }

  /**
   * Densest node near a ray. Scored by perpendicular distance weighted by
   * richness, so a fat supercluster slightly off-axis beats a wisp dead centre
   * — which is what someone pointing at the screen actually means.
   */
  pick(origin: Vector3, direction: Vector3, maxAngle = 0.28): WebNode | null {
    const dir = _dir.copy(direction).normalize();
    let best: WebNode | null = null;
    let bestScore = -Infinity;
    for (const n of this.nodes) {
      const rel = _rel.subVectors(n.position, origin);
      const along = rel.dot(dir);
      if (along <= 0) continue;
      const perp = Math.sqrt(Math.max(0, rel.lengthSq() - along * along));
      const angle = perp / along;
      if (angle > maxAngle) continue;
      // Prefer on-axis, prefer rich, mildly prefer near.
      const score = (1 - angle / maxAngle) * (0.35 + n.richness) - along * 1e-4;
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    return best;
  }

  nearest(p: Vector3): WebNode | null {
    let best: WebNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const d = n.position.distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }
}

const _dir = new Vector3();
const _rel = new Vector3();

/** Vertex offset of the parabola through (−1,a) (0,b) (1,c), clamped. */
function parabolicOffset(a: number, b: number, c: number): number {
  const denom = a - 2 * b + c;
  if (Math.abs(denom) < 1e-9) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
}
