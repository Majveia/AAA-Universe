import { Group, Vector3 } from 'three';
import type { IGalaxyRenderer } from '../api/Contracts';
import type { GalaxySpec } from '../universe/Types';

export class GalaxyRenderer implements IGalaxyRenderer {
  root = new Group();

  setQuality(_q: any) {}
  build(_spec: GalaxySpec) {}
  update(_dt: number, _ctx: any) {}
  setTarget(_pos: Vector3) {}
  dispose() {}
}
