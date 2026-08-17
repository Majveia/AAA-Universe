/**
 * A city plan, in the tangent plane.
 *
 * Everything here is 2-D metres around the settlement centre; the curvature and
 * the terrain are applied later, when vertices are written. That separation is
 * what makes the plan legible: a city is a *drawing* first, and only then a pile
 * of geometry.
 *
 * The plan is produced by recursive convex subdivision. Start with the city
 * outline, cut it with a street, recurse on both halves, and stop when a piece
 * is block-sized. Two properties fall out for free and both matter:
 *
 *   • every piece stays convex, so parcels, obstacles and lighting are trivial;
 *   • the recursion depth *is* the road hierarchy — the first cuts are the
 *     arterials, the last are the alleys — which is how real cities are built
 *     and why they read as navigable rather than as a maze.
 *
 * The pattern (grid, radial, hex, organic…) only changes which direction each
 * cut is allowed to take. That one hook is the difference between Manhattan,
 * Paris and a hill town, and it costs six lines.
 */

import type {
  Block,
  BuildingParams,
  CivStyle,
  DistrictKind,
  Lane,
  Poly,
  Site,
  StreetPattern,
  StreetSeg,
} from './CivTypes';
import { MAT_CHITIN, MAT_CONCRETE, MAT_CRYSTAL, MAT_GLASS, MAT_METAL, MAT_PLASTER, MAT_STONE, MAT_TIMBER, MAT_FABRIC } from './CivTypes';
import { Rng } from '../core/Rand';
import { fbm3 } from '../core/Noise';
import type { CivilizationSpec } from '../universe/Types';
import type { Heightfield } from './CivMath';
import { clamp01, mix, ngonPoly, polyArea, polyCentroid, polyClip, polyContains, polyInset, polyOBB, rectPoly, smoothstep01 } from './CivMath';

/** Numeric clamp; `clamp01`'s general sibling, kept local to this module. */
function clampNum(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

/** A lamp post, sign, antenna — anything small placed against the plan. */
export interface Prop {
  kind: 'lamp' | 'sign' | 'antenna' | 'tank' | 'pylon' | 'tree' | 'statue' | 'beacon';
  x: number;
  y: number;
  /** Ground height at (x, y), metres above the frame datum. */
  z: number;
  rot: number;
  scale: number;
  seed: number;
}

/** A flat area that is not a building: plaza, field, apron, yard. */
export interface GroundPatch {
  poly: Poly;
  /** 0 paving, 1 field, 2 yard, 3 water, 4 landing pad. */
  kind: number;
  /** Slab size for paving, row angle for fields, radius for pads. */
  param: number;
  seed: number;
}

export interface Layout {
  site: Site;
  pattern: StreetPattern;
  streets: StreetSeg[];
  blocks: Block[];
  buildings: BuildingParams[];
  ground: GroundPatch[];
  props: Prop[];
  lanes: Lane[];
  /** City outline, for the light-pollution dome and the ground apron. */
  outline: Poly;
  /** Tallest structure, metres above the datum — drives the glow dome. */
  skylineHeight: number;
}

interface DistrictSeed {
  kind: DistrictKind;
  x: number;
  y: number;
  radius: number;
  heightMul: number;
  density: number;
  /**
   * Who wins where two districts overlap. Needed because influence alone is
   * scale-dependent: without it the largest seed claims every block on the map,
   * and a city made entirely of its own hinterland has nothing in it.
   */
  priority: number;
}

/** Which district beats which. A core outranks the suburb it sits inside. */
const DISTRICT_PRIORITY: Record<DistrictKind, number> = {
  core: 2.6,
  temple: 2.45,
  spaceport: 2.3,
  docks: 2.1,
  civic: 1.95,
  market: 1.85,
  industrial: 1.65,
  slums: 1.5,
  park: 1.35,
  residential: 1.0,
  farm: 0.4,
};

const PATTERN_BY_STYLE: Record<CivStyle, StreetPattern> = {
  brutalist: 'grid',
  organic: 'organic',
  crystalline: 'hex',
  arcology: 'mega',
  nomadic: 'camp',
  hive: 'hex',
  baroque: 'radial',
  ruins: 'organic',
};

/** Base material family per architectural language. */
const MAT_BY_STYLE: Record<CivStyle, number[]> = {
  brutalist: [MAT_CONCRETE, MAT_CONCRETE, MAT_CONCRETE, MAT_METAL, MAT_GLASS],
  organic: [MAT_PLASTER, MAT_TIMBER, MAT_PLASTER, MAT_STONE],
  crystalline: [MAT_CRYSTAL, MAT_GLASS, MAT_CRYSTAL, MAT_METAL],
  arcology: [MAT_GLASS, MAT_METAL, MAT_CONCRETE, MAT_GLASS],
  nomadic: [MAT_FABRIC, MAT_TIMBER, MAT_FABRIC, MAT_STONE],
  hive: [MAT_CHITIN, MAT_CHITIN, MAT_STONE, MAT_CHITIN],
  baroque: [MAT_STONE, MAT_STONE, MAT_PLASTER, MAT_STONE],
  ruins: [MAT_CONCRETE, MAT_STONE, MAT_PLASTER, MAT_CONCRETE],
};

/** Storey height in metres, per language. A hive lives in low rooms. */
const FLOOR_H: Record<CivStyle, number> = {
  brutalist: 3.5,
  organic: 3.0,
  crystalline: 4.2,
  arcology: 3.8,
  nomadic: 2.6,
  hive: 2.4,
  baroque: 4.4,
  ruins: 3.2,
};

export interface LayoutCaps {
  maxBuildings: number;
  /** 0–1 how much small decoration to place. */
  detail: number;
  traffic: number;
}

/**
 * Build the plan. Pure and deterministic given the site seed — call it once,
 * off the frame budget, and keep the result.
 */
export function buildLayout(site: Site, civ: CivilizationSpec, hf: Heightfield, caps: LayoutCaps): Layout {
  const rng = new Rng(site.seed);
  const pattern = PATTERN_BY_STYLE[civ.style];
  const R = site.radius;

  /* ── outline ──────────────────────────────────────────────────────────── */
  // A city is not a circle. Perturb the boundary with smooth noise so it has
  // lobes and inlets, then push the boundary back from any water.
  const lobes = rng.fork('outline');
  const outline = ngonPoly(0, 0, R, pattern === 'grid' ? 8 : 13, rng.range(0, Math.PI), (i) => {
    const a = (i / 13) * Math.PI * 2;
    return 0.72 + 0.42 * (0.5 + 0.5 * fbm3(Math.cos(a) * 1.6, Math.sin(a) * 1.6, lobes.next() * 0 + site.index * 3.1, { octaves: 3 }));
  });

  // A coastal city stops at the waterline instead of wading in.
  let bounds: Poly = outline;
  if (site.waterDist < R * 1.6 && site.waterDist > 40) {
    const wx = site.waterDirX;
    const wy = site.waterDirY;
    bounds = polyClip(bounds, wx * site.waterDist * 0.94, wy * site.waterDist * 0.94, wx, wy);
  }
  if (bounds.length < 6) bounds = outline;

  /* ── districts ────────────────────────────────────────────────────────── */
  const seeds = placeDistricts(site, civ, rng.fork('districts'), R);

  /* ── street network + blocks ──────────────────────────────────────────── */
  const streets: StreetSeg[] = [];
  const blocks: Block[] = [];
  const grid = rng.range(0, Math.PI * 0.5);
  // A block stays a human size whatever the city's size — that constancy is
  // most of why a big city still feels walkable. The recursion depth is then
  // whatever it takes to get there, bounded so a megacity cannot run away.
  const minBlock = pattern === 'mega' ? 165 : pattern === 'camp' ? 42 : 52;
  const area = Math.abs(polyArea(bounds));
  const ctx: SplitCtx = {
    pattern,
    rng: rng.fork('bsp'),
    gridAngle: grid,
    streets,
    blocks,
    site,
    seeds,
    minBlock,
    maxDepth: Math.round(clampNum(Math.log2(Math.max(4, area / (minBlock * minBlock))) + 1, 3, 12)),
  };
  subdivide(ctx, bounds, 0);

  /* ── zoning + parcels ─────────────────────────────────────────────────── */
  const buildings: BuildingParams[] = [];
  const ground: GroundPatch[] = [];
  const props: Prop[] = [];

  // Sort blocks core-outward. The order matters because the budget is spent in
  // it: if anything has to be dropped it is the far suburb, never the centre.
  blocks.sort((a, b) => a.dist - b.dist);

  const styleMats = MAT_BY_STYLE[civ.style];
  const floorH = FLOOR_H[civ.style];
  let skylineHeight = 0;

  /*
   * Spending the building budget.
   *
   * The naive thing — fill blocks in order until the cap is hit — builds a
   * dense disc with a hard edge and nothing beyond it. Real cities thin out.
   * So each block is assigned a *share* that falls with distance from the
   * centre, the shares are normalised against the cap, and a block whose share
   * is below one building keeps only that fraction of its parcels. The whole
   * footprint gets covered, the core is dense, the edge is scattered, and the
   * total lands on budget whatever size the settlement is.
   */
  const shareOf = (b: Block, d: DistrictSeed | null): number => {
    if (!d || d.density <= 0) return 0;
    return d.density * (0.22 + 0.78 * Math.pow(1 - clamp01(b.dist / (R * 1.15)), 1.5));
  };
  let shareSum = 0;
  const blockSeed: (DistrictSeed | null)[] = [];
  for (const b of blocks) {
    const d = seeds.length ? nearestSeed(seeds, b.x, b.y) : null;
    blockSeed.push(d);
    // Roughly how many buildings this block could hold, from its perimeter.
    const est = Math.max(1, Math.sqrt(Math.abs(polyArea(b.poly))) * 0.28);
    shareSum += shareOf(b, d) * est;
  }
  const budgetScale = shareSum > 0 ? Math.min(1.6, caps.maxBuildings / shareSum) : 0;

  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (buildings.length >= caps.maxBuildings) break;
    const brng = new Rng(Math.round((b.x * 7919 + b.y * 104729 + site.seed) >>> 0));
    const seedD = blockSeed[bi];
    b.district = seedD?.kind ?? 'residential';
    // How much of this block to actually build, 0–1.
    const fill = clamp01(shareOf(b, seedD) * budgetScale);

    if (b.district === 'park') {
      ground.push({ poly: polyInset(b.poly, 3), kind: 1, param: brng.range(0, Math.PI), seed: brng.next() });
      scatterProps(props, b.poly, hf, brng, 'tree', 0.0016 * caps.detail, 1);
      continue;
    }
    if (fill < 0.02) continue;
    if (b.district === 'farm') {
      ground.push({ poly: polyInset(b.poly, 2), kind: 1, param: brng.range(0, Math.PI), seed: brng.next() });
      continue;
    }
    if (b.district === 'spaceport') {
      buildPort(b, brng, ground, props, buildings, site, civ, hf, floorH, styleMats, caps);
      continue;
    }

    // `fill` is the acceptance probability per parcel and already carries the
    // district's density; `dens` is only used to size parcels, because a dense
    // quarter has smaller plots as well as more of them.
    const dens = clamp01(seedD?.density ?? 0.7);
    const hMul = seedD?.heightMul ?? 1;
    const inset = b.district === 'core' ? 2.6 : b.district === 'slums' ? 1.0 : 3.4;
    const plot = polyInset(b.poly, inset);
    if (plot.length < 6 || Math.abs(polyArea(plot)) < 55) continue;

    // Paving under the block: it covers the terrain noise and gives the
    // buildings something to stand on that reads as made rather than found.
    // Only where the block is actually built up — a paved plaza in the middle
    // of empty farmland reads as a bug, because it is one.
    if (caps.detail > 0.2 && fill > 0.22 && b.district !== 'slums') {
      ground.push({ poly: b.poly, kind: b.district === 'industrial' || b.district === 'docks' ? 2 : 0, param: brng.range(2.4, 5.5), seed: brng.next() });
    }

    // Two ways to fill a block, and cities use both: a perimeter wall of
    // buildings around a courtyard (old quarters, everywhere in Europe), or
    // free-standing parcels (towers, industry, anything post-war).
    const perimeter =
      b.district === 'residential' || b.district === 'market' || b.district === 'slums'
        ? brng.chance(0.72)
        : brng.chance(0.18);

    const parcels: Poly[] = [];
    if (perimeter) perimeterParcels(plot, brng, b.district === 'slums' ? 7 : 11, parcels);
    else {
      const target = b.district === 'industrial' || b.district === 'docks' ? 780 : b.district === 'core' ? 460 : 240;
      splitParcels(plot, brng, target * mix(1.6, 0.6, dens), parcels, 0);
    }

    for (const p of parcels) {
      if (buildings.length >= caps.maxBuildings) break;
      if (brng.next() > fill) continue;
      const foot = polyInset(p, brng.range(0.5, 1.8));
      if (foot.length < 6) continue;
      const area = Math.abs(polyArea(foot));
      if (area < 26) continue;

      const obb = polyOBB(foot);
      const c: [number, number] = [0, 0];
      polyCentroid(foot, c);
      const dist = Math.hypot(c[0], c[1]);
      const t = clamp01(dist / R);

      const bld = makeBuilding(foot, obb, c, t, b.district, hMul, civ, brng, hf, floorH, styleMats, site);
      if (!bld) continue;
      buildings.push(bld);
      skylineHeight = Math.max(skylineHeight, bld.base + bld.height);
    }
  }

  /* ── landmark: the one building the city is known for ─────────────────── */
  if (buildings.length > 24 && civ.style !== 'nomadic') {
    let tallest = buildings[0];
    for (const b of buildings) if (b.height > tallest.height) tallest = b;
    tallest.landmark = true;
    tallest.height *= civ.style === 'arcology' ? 1.9 : 1.45;
    tallest.floors = Math.max(2, Math.round(tallest.height / tallest.floorHeight));
    skylineHeight = Math.max(skylineHeight, tallest.base + tallest.height);
  }

  /* ── street furniture ─────────────────────────────────────────────────── */
  if (caps.detail > 0.15) placeStreetProps(streets, props, hf, new Rng(site.seed ^ 0x1a2b), civ, caps.detail);

  /* ── traffic ──────────────────────────────────────────────────────────── */
  const lanes: Lane[] = [];
  if (caps.traffic > 0) buildLanes(streets, lanes, hf, civ, site, caps.traffic, skylineHeight);

  return { site, pattern, streets, blocks, buildings, ground, props, lanes, outline: bounds, skylineHeight };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Districts
   ═══════════════════════════════════════════════════════════════════════════ */

function placeDistricts(site: Site, civ: CivilizationSpec, rng: Rng, R: number): DistrictSeed[] {
  const out: DistrictSeed[] = [];
  const small = site.kind === 'outpost' || site.kind === 'farm' || site.radius < 400;

  const push = (kind: DistrictKind, x: number, y: number, radius: number, heightMul: number, density: number) =>
    out.push({ kind, x, y, radius, heightMul, density, priority: DISTRICT_PRIORITY[kind] });

  if (small) {
    if (site.kind === 'farm') push('farm', 0, 0, R * 0.95, 0.3, 0.4);
    if (site.resource > 0.5) push('industrial', R * 0.5, 0, R * 0.6, 0.6, 0.7);
    push('residential', 0, 0, R * 1.35, 0.5, 0.7);
    return out;
  }

  // The core sits at the centre — that is what "centre" means — but a coastal
  // city pulls it toward the water, because that is where the money landed.
  const cx = site.coastal > 0.4 ? site.waterDirX * R * 0.22 : 0;
  const cy = site.coastal > 0.4 ? site.waterDirY * R * 0.22 : 0;
  push('core', cx, cy, R * 0.34, civ.style === 'arcology' ? 2.6 : 1.75, 0.92);
  push('civic', cx - site.waterDirY * R * 0.3, cy + site.waterDirX * R * 0.3, R * 0.2, 1.0, 0.7);
  push('market', cx + site.waterDirY * R * 0.26, cy - site.waterDirX * R * 0.26, R * 0.2, 0.55, 0.95);

  if (site.coastal > 0.35 && site.waterDist < R * 2) {
    push('docks', site.waterDirX * R * 0.78, site.waterDirY * R * 0.78, R * 0.34, 0.42, 0.8);
  }

  // Industry sits away from the money, which is both true and useful: it puts
  // the chimneys on one side of the skyline instead of all around it.
  const ia = rng.range(0, Math.PI * 2);
  push('industrial', Math.cos(ia) * R * 0.72, Math.sin(ia) * R * 0.72, R * 0.36, 0.5, 0.72);

  if (civ.decay > 0.25 || site.population > 4e5) {
    const sa = ia + rng.range(1.6, 2.4);
    push('slums', Math.cos(sa) * R * 0.66, Math.sin(sa) * R * 0.66, R * 0.3, 0.28, 1.0);
  }

  // Green space, in proportion to how well the place is doing.
  const parks = Math.round(mix(1, 4, clamp01(civ.techLevel - civ.decay)));
  for (let i = 0; i < parks; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(0.28, 0.8) * R;
    push('park', Math.cos(a) * r, Math.sin(a) * r, R * rng.range(0.09, 0.16), 0, 0);
  }

  if (civ.techLevel > 0.35 && site.rank < 4) {
    const pa = ia + Math.PI + rng.range(-0.5, 0.5);
    push('spaceport', Math.cos(pa) * R * 0.82, Math.sin(pa) * R * 0.82, R * 0.3, 0.35, 0.5);
  }

  if (civ.style === 'baroque' || civ.style === 'organic' || civ.style === 'hive') {
    const ta = rng.range(0, Math.PI * 2);
    push('temple', Math.cos(ta) * R * 0.4, Math.sin(ta) * R * 0.4, R * 0.13, 1.6, 0.5);
  }

  // The fill. Residential covers the whole outline and loses to every district
  // above it; farmland reaches further still and loses to residential, so the
  // city fades into its own hinterland instead of ending at a line.
  push('residential', 0, 0, R * 1.25, 0.62, 0.82);
  push('farm', 0, 0, R * 4.2, 0.2, 0.34);
  return out;
}

/**
 * Which district owns a point.
 *
 * Influence falls off inside a seed's radius and is zero outside it, then it is
 * weighted by priority. That ordering matters: a plain "closest seed wins" test
 * hands the whole map to whichever district was given the largest radius, and
 * priority alone would make the core swallow the city. Together they give what
 * a zoning map actually looks like — small strong districts punched into a
 * large weak one, with ragged edges where they meet.
 */
function nearestSeed(seeds: DistrictSeed[], x: number, y: number): DistrictSeed | null {
  let best: DistrictSeed | null = null;
  let bestScore = 0;
  for (const s of seeds) {
    const d = Math.hypot(x - s.x, y - s.y);
    const inf = 1 - d / Math.max(1, s.radius);
    if (inf <= 0) continue;
    const score = s.priority * (0.35 + 0.65 * inf);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Recursive subdivision
   ═══════════════════════════════════════════════════════════════════════════ */

interface SplitCtx {
  pattern: StreetPattern;
  rng: Rng;
  gridAngle: number;
  streets: StreetSeg[];
  blocks: Block[];
  site: Site;
  seeds: DistrictSeed[];
  minBlock: number;
  maxDepth: number;
}

/** Street width by hierarchy level. Arterials are wide; alleys are not. */
function streetWidth(level: number, rng: Rng, tech: number): number {
  if (level === 0) return rng.range(13, 20) * (0.8 + tech * 0.5);
  if (level === 1) return rng.range(8.5, 12);
  if (level === 2) return rng.range(6, 8.5);
  return rng.range(3.6, 5.4);
}

function subdivide(ctx: SplitCtx, poly: Poly, depth: number): void {
  if (poly.length < 6) return;
  const obb = polyOBB(poly);
  const long = Math.max(obb.hu, obb.hv) * 2;
  const short = Math.min(obb.hu, obb.hv) * 2;

  if (depth >= ctx.maxDepth || long < ctx.minBlock || Math.abs(polyArea(poly)) < 140) {
    const c: [number, number] = [0, 0];
    polyCentroid(poly, c);
    const dist = Math.hypot(c[0], c[1]);
    ctx.blocks.push({
      poly,
      district: 'residential',
      dist,
      x: c[0],
      y: c[1],
      t: clamp01(dist / ctx.site.radius),
    });
    return;
  }

  const c: [number, number] = [0, 0];
  polyCentroid(poly, c);

  // Which way the cut runs. This one choice is the city's whole character.
  let nx: number;
  let ny: number;
  const jit = ctx.rng.range(-0.035, 0.035);
  switch (ctx.pattern) {
    case 'radial': {
      const r = Math.hypot(c[0], c[1]);
      if (r < 1e-3 || depth % 2 === 0) {
        // A ring road: its normal points outward from the centre.
        const a = Math.atan2(c[1], c[0]) + jit;
        nx = Math.cos(a);
        ny = Math.sin(a);
      } else {
        // A spoke: normal is tangential.
        const a = Math.atan2(c[1], c[0]) + Math.PI / 2 + jit;
        nx = Math.cos(a);
        ny = Math.sin(a);
      }
      break;
    }
    case 'hex': {
      const a = ctx.gridAngle + ((depth % 3) * Math.PI) / 3 + jit;
      nx = Math.cos(a);
      ny = Math.sin(a);
      break;
    }
    case 'organic': {
      // Streets follow a smooth flow field, which is what a town that grew
      // along footpaths looks like from the air.
      const f = fbm3(c[0] * 0.0016, c[1] * 0.0016, ctx.site.index * 5.7, { octaves: 3 });
      const a = f * Math.PI * 2 + (depth % 2) * (Math.PI / 2) + ctx.rng.range(-0.25, 0.25);
      nx = Math.cos(a);
      ny = Math.sin(a);
      break;
    }
    case 'camp': {
      const a = ctx.rng.range(0, Math.PI * 2);
      nx = Math.cos(a);
      ny = Math.sin(a);
      break;
    }
    default: {
      // Grid and mega: two fixed axes, alternating. Always cut the long way,
      // or the blocks drift toward slivers.
      const cutAlong = obb.hu >= obb.hv;
      const a = ctx.gridAngle + (cutAlong ? 0 : Math.PI / 2) + (depth % 2 === 0 ? 0 : 0) + jit;
      nx = Math.cos(a);
      ny = Math.sin(a);
      // Fall back to the OBB axis when the grid would produce a sliver.
      if (short < ctx.minBlock * 1.2) {
        nx = obb.ux;
        ny = obb.uy;
      }
      break;
    }
  }

  const level = depth === 0 ? 0 : depth <= 1 ? 0 : depth <= 3 ? 1 : depth <= 5 ? 2 : 3;
  const w = streetWidth(level, ctx.rng, 0.6);

  // Where to cut. A grid quantises; an organic town does not.
  let ox = c[0];
  let oy = c[1];
  if (ctx.pattern === 'grid' || ctx.pattern === 'mega') {
    const off = ctx.rng.range(-0.06, 0.06) * long;
    ox += nx * off;
    oy += ny * off;
  } else {
    const off = ctx.rng.range(-0.22, 0.22) * long;
    ox += nx * off;
    oy += ny * off;
  }

  // `polyClip(p, o, n)` keeps the half-plane dot(p − o, n) ≤ 0. The two blocks
  // are the outsides of a slab of width w centred on the cut, and the street is
  // the slab itself — so the offsets and the normals have to disagree in sign,
  // or the halves overlap the carriageway and the carriageway comes out empty.
  const a = polyClip(poly, ox - nx * (w * 0.5), oy - ny * (w * 0.5), nx, ny);
  const b = polyClip(poly, ox + nx * (w * 0.5), oy + ny * (w * 0.5), -nx, -ny);
  if (a.length < 6 || b.length < 6) {
    // The cut missed; keep the piece as a block rather than losing it.
    ctx.blocks.push({ poly, district: 'residential', dist: Math.hypot(c[0], c[1]), x: c[0], y: c[1], t: clamp01(Math.hypot(c[0], c[1]) / ctx.site.radius) });
    return;
  }

  // Record the road itself: the strip between the two halves, as a segment.
  const strip = polyClip(
    polyClip(poly, ox + nx * (w * 0.5), oy + ny * (w * 0.5), nx, ny),
    ox - nx * (w * 0.5),
    oy - ny * (w * 0.5),
    -nx,
    -ny
  );
  if (strip.length >= 6) {
    const so = polyOBB(strip);
    const alongU = so.hu >= so.hv;
    const dx = alongU ? so.ux : -so.uy;
    const dy = alongU ? so.uy : so.ux;
    const half = alongU ? so.hu : so.hv;
    if (half > 6) {
      ctx.streets.push({
        ax: so.x - dx * half,
        ay: so.y - dy * half,
        bx: so.x + dx * half,
        by: so.y + dy * half,
        width: w,
        level,
      });
    }
  }

  subdivide(ctx, a, depth + 1);
  subdivide(ctx, b, depth + 1);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Parcels
   ═══════════════════════════════════════════════════════════════════════════ */

/** Split a block into free-standing plots by area, no streets between them. */
function splitParcels(poly: Poly, rng: Rng, targetArea: number, out: Poly[], depth: number): void {
  const area = Math.abs(polyArea(poly));
  if (depth > 6 || area < targetArea * 1.7) {
    out.push(poly);
    return;
  }
  const obb = polyOBB(poly);
  const alongU = obb.hu >= obb.hv;
  const nx = alongU ? obb.ux : -obb.uy;
  const ny = alongU ? obb.uy : obb.ux;
  const off = rng.range(-0.16, 0.16) * (alongU ? obb.hu : obb.hv) * 2;
  const ox = obb.x + nx * off;
  const oy = obb.y + ny * off;
  const a = polyClip(poly, ox, oy, nx, ny);
  const b = polyClip(poly, ox, oy, -nx, -ny);
  if (a.length < 6 || b.length < 6) {
    out.push(poly);
    return;
  }
  splitParcels(a, rng, targetArea, out, depth + 1);
  splitParcels(b, rng, targetArea, out, depth + 1);
}

/**
 * A wall of buildings around the block edge with a courtyard behind. This is
 * the single most important massing type there is: it is what makes a street
 * feel like a room rather than a gap between objects.
 */
function perimeterParcels(poly: Poly, rng: Rng, depth: number, out: Poly[]): void {
  const n = poly.length / 2;
  if (n < 3) return;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2];
    const ay = poly[i * 2 + 1];
    const bx = poly[j * 2];
    const by = poly[j * 2 + 1];
    let ex = bx - ax;
    let ey = by - ay;
    const len = Math.hypot(ex, ey);
    if (len < 7) continue;
    ex /= len;
    ey /= len;
    // Inward normal: the block is CCW, so (-ey, ex) points in.
    const sign = polyArea(poly) >= 0 ? 1 : -1;
    const ix = -ey * sign;
    const iy = ex * sign;

    let s = 0;
    while (s < len - 4) {
      const w = Math.min(rng.range(7, 15), len - s);
      const d = depth * rng.range(0.8, 1.25);
      const cx = ax + ex * (s + w * 0.5) + ix * (d * 0.5);
      const cy = ay + ey * (s + w * 0.5) + iy * (d * 0.5);
      const rot = Math.atan2(ey, ex);
      const p = rectPoly(cx, cy, w * 0.5, d * 0.5, rot);
      // Only keep it if the far corners are still inside the block, or the
      // terrace grows out into the street.
      if (polyContains(poly, cx + ix * d * 0.45, cy + iy * d * 0.45)) out.push(p);
      s += w + rng.range(0, 1.6);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Buildings
   ═══════════════════════════════════════════════════════════════════════════ */

function makeBuilding(
  foot: Poly,
  obb: { x: number; y: number; ux: number; uy: number; hu: number; hv: number },
  c: [number, number],
  t: number,
  district: DistrictKind,
  heightMul: number,
  civ: CivilizationSpec,
  rng: Rng,
  hf: Heightfield,
  floorH: number,
  mats: number[],
  site: Site
): BuildingParams | null {
  // Ground under the footprint: the building sits on its highest corner and
  // fills down to its lowest, so it never floats and never sinks.
  let base = -Infinity;
  let baseMin = Infinity;
  const n = foot.length / 2;
  for (let i = 0; i < n; i++) {
    const h = hf.at(foot[i * 2], foot[i * 2 + 1]);
    if (h > base) base = h;
    if (h < baseMin) baseMin = h;
  }
  const hc = hf.at(c[0], c[1]);
  if (hc > base) base = hc;
  if (hc < baseMin) baseMin = hc;
  if (!Number.isFinite(base)) return null;
  // Underwater plots are for the harbour, not for houses.
  if (base < hf.seaElev + 0.4 && district !== 'docks') return null;
  // Refuse a plot on a cliff: the plinth would be a ten-storey retaining wall.
  if (base - baseMin > 22) return null;

  /* ── height ───────────────────────────────────────────────────────────── */
  // The skyline: a falloff from the centre, plus a couple of secondary peaks
  // from noise so it is not a smooth cone, plus a heavy random tail so a few
  // towers break the line. Cities are lognormal in height, not uniform.
  const falloff = Math.pow(1 - clamp01(t), 1.55);
  const secondary = 0.5 + 0.5 * fbm3(c[0] * 0.0009, c[1] * 0.0009, site.index * 11.3, { octaves: 3 });
  const tall =
    district === 'core' ? 78 :
    district === 'civic' ? 34 :
    district === 'temple' ? 44 :
    district === 'market' ? 16 :
    district === 'industrial' ? 15 :
    district === 'docks' ? 18 :
    district === 'slums' ? 9 :
    district === 'spaceport' ? 22 : 26;

  const scale = 0.6 + civ.techLevel * 1.5;
  let height =
    tall * scale * heightMul * (0.35 + 0.65 * falloff) * (0.45 + 0.75 * secondary) * rng.range(0.55, 1.5);
  // The long tail: one plot in thirty goes up.
  if (rng.chance(0.035) && district !== 'slums') height *= rng.range(1.8, 3.4);
  // A footprint that small cannot carry a tower; keep the proportions sane.
  const footScale = Math.min(obb.hu, obb.hv) * 2;
  height = Math.min(height, footScale * rng.range(2.6, 9.0) + 6);
  height = Math.max(height, floorH * (district === 'slums' ? 1 : 1.6));
  // A ruined civilisation lost its upper floors first.
  height *= 1 - civ.decay * rng.range(0.15, 0.65);

  const floors = Math.max(1, Math.round(height / floorH));
  const litProb = clamp01(
    (district === 'core' ? 0.62 : district === 'industrial' ? 0.28 : district === 'slums' ? 0.34 : 0.48) *
      (1 - civ.decay * 0.8) *
      rng.range(0.6, 1.35)
  );

  const matId = rng.pick(mats);
  // Glass only on tall modern things; a two-storey glass shed looks wrong.
  const finalMat = matId === MAT_GLASS && height < 22 ? MAT_CONCRETE : matId;

  const roof =
    district === 'industrial' || district === 'docks' ? 3 :          // saw-tooth shed
    height > 45 ? (rng.chance(0.4) ? 2 : 0) :                        // stepped or flat
    civ.style === 'organic' || civ.style === 'nomadic' ? 1 :         // pitched
    civ.style === 'baroque' ? (rng.chance(0.5) ? 4 : 1) :            // dome or pitched
    rng.chance(0.24) ? 1 : 0;

  return {
    poly: foot,
    x: c[0],
    y: c[1],
    ux: obb.ux,
    uy: obb.uy,
    hu: obb.hu,
    hv: obb.hv,
    base,
    baseMin,
    height,
    floors,
    floorHeight: floorH,
    style: civ.style,
    district,
    seed: rng.next(),
    decay: clamp01(civ.decay * rng.range(0.4, 1.6) + (district === 'slums' ? 0.25 : 0)),
    litProb,
    matId: finalMat,
    roof,
    landmark: false,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Spaceport — the one district the player actually arrives in
   ═══════════════════════════════════════════════════════════════════════════ */

function buildPort(
  b: Block,
  rng: Rng,
  ground: GroundPatch[],
  props: Prop[],
  buildings: BuildingParams[],
  site: Site,
  civ: CivilizationSpec,
  hf: Heightfield,
  floorH: number,
  mats: number[],
  caps: LayoutCaps
): void {
  const obb = polyOBB(b.poly);
  const span = Math.min(obb.hu, obb.hv);
  // Apron first: a big flat slab, which is the whole point of a spaceport.
  ground.push({ poly: b.poly, kind: 2, param: 6, seed: rng.next() });

  const padR = Math.min(span * 0.62, 34);
  if (padR > 9) {
    ground.push({ poly: ngonPoly(obb.x, obb.y, padR, 16), kind: 4, param: 1.0, seed: rng.next() });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      props.push({
        kind: 'beacon',
        x: obb.x + Math.cos(a) * padR * 1.06,
        y: obb.y + Math.sin(a) * padR * 1.06,
        z: hf.at(obb.x + Math.cos(a) * padR * 1.06, obb.y + Math.sin(a) * padR * 1.06),
        rot: a,
        scale: 1,
        seed: rng.next(),
      });
    }
  }

  // A control tower and a couple of hangars around the edge.
  const ring = polyInset(b.poly, padR + 12);
  if (ring.length >= 6 && buildings.length < caps.maxBuildings) {
    const parcels: Poly[] = [];
    splitParcels(ring, rng, 900, parcels, 0);
    for (const p of parcels.slice(0, 6)) {
      const foot = polyInset(p, 2.5);
      if (foot.length < 6) continue;
      const po = polyOBB(foot);
      const c: [number, number] = [0, 0];
      polyCentroid(foot, c);
      const bld = makeBuilding(foot, po, c, clamp01(Math.hypot(c[0], c[1]) / site.radius), 'spaceport', 0.5, civ, rng, hf, floorH, mats, site);
      if (bld) {
        bld.roof = 3;
        buildings.push(bld);
      }
    }
  }
  if (civ.techLevel > 0.5) {
    props.push({ kind: 'pylon', x: obb.x + obb.ux * span * 0.9, y: obb.y + obb.uy * span * 0.9, z: hf.at(obb.x, obb.y), rot: rng.range(0, 6.28), scale: 1.4, seed: rng.next() });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Props and traffic
   ═══════════════════════════════════════════════════════════════════════════ */

function scatterProps(out: Prop[], poly: Poly, hf: Heightfield, rng: Rng, kind: Prop['kind'], perM2: number, scale: number): void {
  const area = Math.abs(polyArea(poly));
  const n = Math.min(90, Math.floor(area * perM2));
  const o = polyOBB(poly);
  for (let i = 0; i < n; i++) {
    const u = rng.range(-o.hu, o.hu);
    const v = rng.range(-o.hv, o.hv);
    const x = o.x + o.ux * u - o.uy * v;
    const y = o.y + o.uy * u + o.ux * v;
    if (!polyContains(poly, x, y)) continue;
    out.push({ kind, x, y, z: hf.at(x, y), rot: rng.range(0, Math.PI * 2), scale: scale * rng.range(0.7, 1.4), seed: rng.next() });
  }
}

/** Lamp posts down the arterials — the shape of a city at night. */
function placeStreetProps(streets: StreetSeg[], out: Prop[], hf: Heightfield, rng: Rng, civ: CivilizationSpec, detail: number): void {
  const spacing = 30 / Math.max(0.25, detail);
  for (const s of streets) {
    if (s.level > 1) continue;
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const len = Math.hypot(dx, dy);
    if (len < spacing) continue;
    const ux = dx / len;
    const uy = dy / len;
    const off = s.width * 0.5 - 1.1;
    const n = Math.floor(len / spacing);
    for (let i = 0; i <= n; i++) {
      const t = (i / Math.max(1, n)) * len;
      const side = i % 2 === 0 ? 1 : -1;
      const x = s.ax + ux * t - uy * off * side;
      const y = s.ay + uy * t + ux * off * side;
      out.push({
        kind: 'lamp',
        x,
        y,
        z: hf.at(x, y),
        rot: Math.atan2(uy, ux),
        scale: s.level === 0 ? 1.15 : 0.9,
        seed: rng.next(),
      });
    }
    // A hoarding at one end of the biggest streets, if anyone here advertises.
    if (s.level === 0 && civ.techLevel > 0.3 && rng.chance(0.35)) {
      out.push({ kind: 'sign', x: s.bx, y: s.by, z: hf.at(s.bx, s.by), rot: Math.atan2(uy, ux), scale: rng.range(0.8, 1.6), seed: rng.next() });
    }
  }
}

function buildLanes(
  streets: StreetSeg[],
  out: Lane[],
  hf: Heightfield,
  civ: CivilizationSpec,
  site: Site,
  budget: number,
  skyline: number
): void {
  const arterials = streets.filter((s) => s.level <= 1);
  arterials.sort((a, b) => Math.hypot(b.bx - b.ax, b.by - b.ay) - Math.hypot(a.bx - a.ax, a.by - a.ay));
  const groundLanes = Math.min(arterials.length, Math.round(budget * 0.7));
  for (let i = 0; i < groundLanes; i++) {
    const s = arterials[i];
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const len = Math.hypot(dx, dy);
    if (len < 30) continue;
    const ux = dx / len;
    const uy = dy / len;
    const off = s.width * 0.24;
    for (let dir = 0; dir < 2; dir++) {
      const sgn = dir === 0 ? 1 : -1;
      const ax = (dir === 0 ? s.ax : s.bx) - uy * off * sgn;
      const ay = (dir === 0 ? s.ay : s.by) + ux * off * sgn;
      const bx = (dir === 0 ? s.bx : s.ax) - uy * off * sgn;
      const by = (dir === 0 ? s.by : s.ay) + ux * off * sgn;
      out.push({
        ax,
        ay,
        az: hf.at(ax, ay) + 0.55,
        bx,
        by,
        bz: hf.at(bx, by) + 0.55,
        arc: 0,
        count: Math.max(1, Math.round(len / 90)),
        speed: (10 / len) * (0.7 + civ.techLevel),
        air: 0,
      });
    }
  }

  // Air corridors: only a civilisation that can build them, and only over the
  // core, where they read against the towers instead of against empty sky.
  if (civ.techLevel > 0.55 && skyline > 40) {
    const airLanes = Math.round(budget * 0.3);
    const rng = new Rng(site.seed ^ 0x7a17);
    for (let i = 0; i < airLanes; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = site.radius * rng.range(0.25, 0.95);
      const a2 = a + rng.range(2.0, 4.2);
      const r2 = site.radius * rng.range(0.25, 0.95);
      const z = mix(30, skyline * 1.15, rng.next());
      out.push({
        ax: Math.cos(a) * r,
        ay: Math.sin(a) * r,
        az: hf.at(Math.cos(a) * r, Math.sin(a) * r) + z,
        bx: Math.cos(a2) * r2,
        by: Math.sin(a2) * r2,
        bz: hf.at(Math.cos(a2) * r2, Math.sin(a2) * r2) + z * rng.range(0.7, 1.3),
        arc: rng.range(6, 26),
        count: rng.int(2, 6),
        speed: rng.range(0.02, 0.06),
        air: 1,
      });
    }
  }
}
