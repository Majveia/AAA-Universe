/**
 * Where a civilisation puts itself.
 *
 * Cities are not scattered at random and they are not placed by hand. They sit
 * where the four things settlers actually need overlap: buildable ground, fresh
 * or navigable water, a climate you survive without technology, and something
 * worth digging up. Scoring those four and taking the local maxima produces a
 * settlement pattern that reads as *reasoned* from orbit — a chain of ports down
 * a coastline, a capital at a river mouth, outposts strung along a mountain
 * pass — which is the difference between a world and a spawn table.
 *
 * The output is deliberately cheap: every settlement on the planet exists as a
 * `Site` from the moment you arrive, so the map, the HUD and the orbital night
 * lights all have something to draw long before any geometry is built.
 */

import { Vector3 } from 'three';
import type { IPlanet } from '../api/Contracts';
import { BIOME_IDS } from '../api/Contracts';
import type { CivilizationSpec } from '../universe/Types';
import { Rng, hashCombine } from '../core/Rand';
import { clamp01, smoothstep01 } from './CivMath';
import type { Site, SettlementKind } from './CivTypes';
import { cityName } from '../universe/Names';

/**
 * Rank → what kind of place it is. One capital, a couple of rivals, then the
 * long tail. This is the rank-size rule expressed as a lookup, which is honest:
 * the underlying distribution is Zipf and this is what Zipf looks like.
 */
const KIND_BY_RANK: SettlementKind[] = [
  'megacity',
  'city',
  'city',
  'town',
  'town',
  'town',
  'town',
  'outpost',
];

/**
 * Footprint radius in metres, by kind.
 *
 * Deliberately smaller than a real city of the same population. A settlement
 * has to be *dense* to read as one — a real megacity's fifty square kilometres
 * spread across the budget we can afford would be a scatter of sheds. Better a
 * compact city with a skyline than a sprawl with nothing in it.
 */
const RADIUS_BY_KIND: Record<SettlementKind, [number, number]> = {
  megacity: [1500, 2400],
  city: [780, 1350],
  town: [300, 620],
  outpost: [95, 220],
  port: [430, 900],
  farm: [280, 620],
  monument: [80, 180],
  ruin: [240, 760],
};

interface Candidate {
  dir: Vector3;
  elevation: number;
  score: number;
  coastal: number;
  flat: number;
  fertile: number;
  defensible: number;
  resource: number;
  river: number;
  biome: number;
  waterDist: number;
  waterDirX: number;
  waterDirY: number;
}

/**
 * Score the whole sphere and return the settlements, largest first.
 *
 * `budgetSamples` bounds the coarse sweep — a lower number on mobile costs
 * placement quality, never correctness.
 */
export function placeSettlements(
  planet: IPlanet,
  civ: CivilizationSpec,
  budgetSamples = 3000
): Site[] {
  const R = planet.radius;
  const seaR = planet.seaLevelRadius();
  const seaElev = seaR > 0 ? seaR - R : -Infinity;
  const rng = new Rng(hashCombine(planet.spec.seed, 0x6c17));

  /* ── coarse pass: cheap height only ───────────────────────────────────── */
  const N = budgetSamples;
  const coarse: Candidate[] = [];
  const d = new Vector3();
  for (let i = 0; i < N; i++) {
    // Golden-angle spiral: uniform on the sphere with no pole bunching, and
    // deterministic, so the same world always has the same cities.
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const t = i * 2.399963;
    d.set(Math.cos(t) * r, y, Math.sin(t) * r);

    const h = planet.heightAt(d);
    if (seaR > 0 && h < seaElev + 2) continue; // in the water

    // Local relief from four probes at ~600 m. Flat ground is buildable; a
    // ridge is defensible; a cliff is neither.
    const e = 600 / R;
    const up = d.clone();
    const ref = Math.abs(up.y) > 0.94 ? _a.set(1, 0, 0) : _a.set(0, 1, 0);
    const tx = _b.crossVectors(ref, up).normalize();
    const ty = _c.crossVectors(up, tx).normalize();
    let hMin = Infinity;
    let hMax = -Infinity;
    let hSum = 0;
    for (let k = 0; k < 4; k++) {
      const ang = (k * Math.PI) / 2;
      _p.copy(up)
        .addScaledVector(tx, Math.cos(ang) * e)
        .addScaledVector(ty, Math.sin(ang) * e)
        .normalize();
      const hh = planet.heightAt(_p);
      hMin = Math.min(hMin, hh);
      hMax = Math.max(hMax, hh);
      hSum += hh;
    }
    const relief = hMax - hMin;
    const flat = 1 - clamp01(relief / 220);
    if (flat < 0.12) continue; // a cliff face; nobody builds here

    // Prominence: standing above your surroundings is worth something, and it
    // is what puts the citadel on the hill rather than in the marsh.
    const prominence = clamp01((h - hSum / 4) / 90);

    coarse.push({
      dir: up,
      elevation: h,
      score: 0,
      coastal: 0,
      flat,
      fertile: 0,
      defensible: prominence,
      resource: 0,
      river: 0,
      biome: 0,
      waterDist: Infinity,
      waterDirX: 0,
      waterDirY: 1,
    });
  }

  if (!coarse.length) return [];

  /* ── water access ─────────────────────────────────────────────────────── */
  // Coast-finding is the single most expensive term, so it runs on the coarse
  // survivors only, with a step that grows as it walks outward: near water we
  // want metres of precision, far from it we only want to know "not here".
  if (seaR > 0) {
    for (const c of coarse) {
      const up = c.dir;
      const ref = Math.abs(up.y) > 0.94 ? _a.set(1, 0, 0) : _a.set(0, 1, 0);
      const tx = _b.crossVectors(ref, up).normalize().clone();
      const ty = _c.crossVectors(up, tx).normalize().clone();
      let best = Infinity;
      let bx = 0;
      let by = 1;
      for (let k = 0; k < 12; k++) {
        const ang = (k / 12) * Math.PI * 2;
        const ux = Math.cos(ang);
        const uy = Math.sin(ang);
        let dist = 240;
        while (dist < 9000) {
          _p.copy(up)
            .addScaledVector(tx, (ux * dist) / R)
            .addScaledVector(ty, (uy * dist) / R)
            .normalize();
          if (planet.heightAt(_p) < seaElev) {
            if (dist < best) {
              best = dist;
              bx = ux;
              by = uy;
            }
            break;
          }
          dist *= 1.55;
        }
      }
      c.waterDist = best;
      c.waterDirX = bx;
      c.waterDirY = by;
      // A harbour wants to be *near* the water, not in it. 400 m is a beach.
      c.coastal = best === Infinity ? 0 : smoothstep01(6000, 400, best);
    }
  }

  /* ── climate: one full surface sample on the promising ones ───────────── */
  // `sampleSurface` costs several height evaluations; run it on the best third.
  for (const c of coarse) {
    c.score = c.flat * 3.0 + c.coastal * 3.4 + c.defensible * 0.9;
  }
  coarse.sort((a, b) => b.score - a.score);
  const refined = coarse.slice(0, Math.min(coarse.length, 420));

  for (const c of refined) {
    const s = planet.sampleSurface(c.dir);
    c.biome = s.biome;
    if (s.underwater) {
      c.score = -1;
      continue;
    }
    // Temperate and moist, but not swamp. The peak sits slightly warm of the
    // midpoint because cold kills a pre-industrial settlement faster than heat.
    const temp = 1 - clamp01(Math.abs(s.temperature - 0.60) * 2.6);
    const humid = 1 - clamp01(Math.abs(s.humidity - 0.52) * 2.2);
    c.fertile = clamp01(temp * 0.65 + humid * 0.35);
    // Ore follows rough, exposed rock; farmland does not.
    c.resource = clamp01((1 - c.flat) * 0.7 + (s.biome === BIOME_IDS.ROCK || s.biome === BIOME_IDS.BADLANDS ? 0.5 : 0));
    // Standing water inland reads as a river or a lake to the layout code.
    c.river = c.waterDist < 2600 && c.waterDist > 300 ? 1 - clamp01(c.waterDist / 2600) : 0;
    // Nobody founds a capital on a glacier or in a lava field.
    const hostile =
      s.biome === BIOME_IDS.GLACIER || s.biome === BIOME_IDS.LAVA ? 0.15 :
      s.biome === BIOME_IDS.DESERT || s.biome === BIOME_IDS.TUNDRA ? 0.62 : 1;

    c.score =
      (c.flat * 2.6 +
        c.coastal * 3.2 +
        c.fertile * 3.4 +
        c.resource * 1.1 +
        c.defensible * 0.8 +
        c.river * 1.4) *
      hostile -
      // Keep away from the poles: weather, light and life are all better away
      // from them, and a city under permanent night is a shot nobody wants.
      Math.abs(c.dir.y) * 2.2;
  }
  refined.sort((a, b) => b.score - a.score);

  /* ── select, with a separation that scales with the settlement's size ─── */
  const want = Math.max(1, Math.min(civ.cityCount, 26));
  const sites: Site[] = [];
  for (const c of refined) {
    if (sites.length >= want) break;
    if (c.score <= 0) continue;

    const rank = sites.length;
    const kind: SettlementKind =
      civ.decay > 0.75 && rank > 0 && rng.chance(0.45)
        ? 'ruin'
        : c.coastal > 0.55 && rank > 0 && rank < 5
          ? 'port'
          : c.fertile > 0.8 && rank > 4
            ? 'farm'
            : KIND_BY_RANK[Math.min(rank, KIND_BY_RANK.length - 1)];

    const [r0, r1] = RADIUS_BY_KIND[kind];
    // Bigger civilisations build bigger; a starfaring one builds much bigger.
    const radius = rng.range(r0, r1) * (0.75 + civ.techLevel * 0.6);

    // Separation is measured against the *other* city's reach, so a megacity
    // clears a wide hinterland and two hamlets can sit in the same valley.
    let ok = true;
    for (const s of sites) {
      const metres = c.dir.distanceTo(s.dir) * R;
      if (metres < (s.radius + radius) * 3.4 + 4000) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    // Zipf again, in population: rank k holds roughly P₁/k of the people.
    const pop = Math.max(60, Math.round((civ.population * 0.6) / (rank + 1) / Math.max(1, want * 0.3)));

    sites.push({
      index: sites.length,
      seed: hashCombine(planet.spec.seed, sites.length, 0x51ed),
      name: cityName(rng.fork(sites.length), [c.dir.x * 1000, c.dir.y * 1000, c.dir.z * 1000]),
      kind,
      dir: c.dir.clone(),
      elevation: c.elevation,
      radius,
      population: pop,
      coastal: c.coastal,
      river: c.river,
      flat: c.flat,
      defensible: c.defensible,
      resource: c.resource,
      fertile: c.fertile,
      score: c.score,
      rank,
      refined: true,
      biome: c.biome,
      waterDirX: c.waterDirX,
      waterDirY: c.waterDirY,
      waterDist: c.waterDist,
      equatorial: Math.abs(c.dir.y) < 0.14,
    });
  }

  return sites;
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _p = new Vector3();
