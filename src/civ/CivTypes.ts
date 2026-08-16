/**
 * The private vocabulary of the CIVILISATION subsystem.
 *
 * Nothing here crosses `src/api/Contracts.ts`; these are the intermediate
 * representations that a settlement passes through on its way from "a promising
 * dot on a sphere" to "a place you want to land the ship".
 *
 *   Site      → where and why a settlement exists (scored from the terrain)
 *   Layout    → its streets, blocks, parcels, districts (2-D, tangent plane)
 *   Building  → a parametric description, before any geometry exists
 *   Batch     → merged, uploaded geometry, a handful of draw calls
 */

import type { Vector3 } from 'three';
import type { CivilizationSpec } from '../universe/Types';
import type { SettlementInfo } from '../api/Contracts';

export type CivStyle = CivilizationSpec['style'];
export type SettlementKind = SettlementInfo['kind'];

/** Street-plan archetype. Chosen by architectural style, not by size. */
export type StreetPattern = 'radial' | 'grid' | 'hex' | 'organic' | 'mega' | 'camp';

/**
 * Districts give a city a memory. You navigate by "the market is behind the
 * temple, the docks are downhill" — not by coordinates.
 */
export type DistrictKind =
  | 'core'
  | 'residential'
  | 'market'
  | 'civic'
  | 'temple'
  | 'industrial'
  | 'docks'
  | 'slums'
  | 'spaceport'
  | 'park'
  | 'farm';

/** Numeric ids handed to the shader — keep in sync with STYLE_ID in Materials. */
export const STYLE_ID: Record<CivStyle, number> = {
  brutalist: 0,
  organic: 1,
  crystalline: 2,
  arcology: 3,
  nomadic: 4,
  hive: 5,
  baroque: 6,
  ruins: 7,
};

/** Surface families. The fragment shader authors each one from noise. */
export const MAT_CONCRETE = 0;
export const MAT_METAL = 1;
export const MAT_GLASS = 2;
export const MAT_PLASTER = 3;
export const MAT_TIMBER = 4;
export const MAT_STONE = 5;
export const MAT_FABRIC = 6;
export const MAT_CHITIN = 7;
export const MAT_CRYSTAL = 8;

/**
 * A settlement before it has any geometry: cheap enough that every one on the
 * planet can exist at once, which is what `settlements()` and the orbital night
 * lights need.
 */
export interface Site {
  index: number;
  seed: number;
  name: string;
  kind: SettlementKind;
  /** Unit direction from the planet centre. */
  dir: Vector3;
  /** Terrain elevation at the centre, metres above the reference sphere. */
  elevation: number;
  /** Footprint radius, metres. */
  radius: number;
  population: number;
  /** Why this place: the components of its placement score, 0–1 each. */
  coastal: number;
  river: number;
  flat: number;
  defensible: number;
  resource: number;
  fertile: number;
  /** Score total — also drives night-light brightness. */
  score: number;
  /** Rank in the size hierarchy, 0 = largest. */
  rank: number;
  /** Refined against `sampleSurface`? Placement starts coarse and improves. */
  refined: boolean;
  biome: number;
  /** Set for ports/docks: the direction of open water, in tangent-plane 2-D. */
  waterDirX: number;
  waterDirY: number;
  /** Distance to open water, metres (Infinity inland). */
  waterDist: number;
  /** True if the site sits within ~8° of the equator — space elevator anchor. */
  equatorial: boolean;
}

/** A convex polygon in tangent-plane metres, flat [x0,y0,x1,y1,…]. */
export type Poly = number[];

export interface District {
  kind: DistrictKind;
  x: number;
  y: number;
  radius: number;
  /** Height multiplier applied to buildings that fall inside. */
  heightMul: number;
  /** 0–1 how tightly packed. */
  density: number;
}

export interface Block {
  poly: Poly;
  district: DistrictKind;
  /** Distance of the block centroid from the city centre, metres. */
  dist: number;
  x: number;
  y: number;
  /** 0–1 blend toward the periphery, precomputed for zoning. */
  t: number;
}

export interface StreetSeg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Metres. Avenues are wide, alleys are not. */
  width: number;
  /** 0 = arterial, 1 = street, 2 = alley. */
  level: number;
}

export interface BuildingParams {
  /** Convex footprint, tangent-plane metres. */
  poly: Poly;
  /** Footprint centre. */
  x: number;
  y: number;
  /** Oriented bounding box of the footprint — used for collision and massing. */
  ux: number;
  uy: number;
  hu: number;
  hv: number;
  /** Ground height the building sits on (its terrace level), metres. */
  base: number;
  /** Lowest terrain under the footprint — the plinth is filled down to this. */
  baseMin: number;
  height: number;
  floors: number;
  floorHeight: number;
  style: CivStyle;
  district: DistrictKind;
  seed: number;
  /** 0–1 additional decay on top of the civilisation's baseline. */
  decay: number;
  /** 0–1 chance any given window is lit at night. */
  litProb: number;
  matId: number;
  /** Roof archetype id, resolved by the generator. */
  roof: number;
  /** Landmark buildings get the full treatment even at mid LOD. */
  landmark: boolean;
}

/** Everything the collision system needs, in tangent-plane 2-D. */
export interface Obstacle {
  x: number;
  y: number;
  ux: number;
  uy: number;
  hu: number;
  hv: number;
  z0: number;
  z1: number;
}

/** A lane for instanced traffic: straight for roads, arced for flight paths. */
export interface Lane {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  /** Bow height of the quadratic arc, metres. 0 = straight. */
  arc: number;
  /** Vehicles per lane and their speed in lane-lengths per second. */
  count: number;
  speed: number;
  /** 0 = ground, 1 = air. */
  air: number;
}

export interface QualityCaps {
  maxVerts: number;
  maxBuildings: number;
  detail: boolean;
  interiors: boolean;
  traffic: number;
  streamMs: number;
  distanceMul: number;
}
