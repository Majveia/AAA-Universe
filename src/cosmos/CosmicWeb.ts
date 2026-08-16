import { Group, Vector3 } from 'three';
import type { ICosmicWeb } from '../api/Contracts';

export class CosmicWeb implements ICosmicWeb {
  root = new Group();

  setQuality(_q: any) {}
  setEpoch(_e: number) {}
  setTimeRate(_r: number) {}
  update(_dt: number, _ctx: any) {}
  stats() {
    return { redshift: 0, ageYears: 0, collapsedFraction: 0 };
  }
  pickNode(_pos: Vector3, _dir: Vector3) {
    return null;
  }
  nearestNode(_pos: Vector3) {
    return null;
  }
  dispose() {}
}
