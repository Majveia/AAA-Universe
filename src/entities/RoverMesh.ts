/**
 * The rover, as geometry.
 *
 * Built from primitives, but shaped for silhouette: a high wheelbase, an
 * exposed roll cage, a slab nose and a stubby rear deck, so it reads as a
 * vehicle in one glance at any distance. Panels are procedurally weathered by
 * the hull material; damage darkens and roughens them further.
 */

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import type { Rng } from '../core/Rand';
import { disposeTree, makeEmissive, makeHullMaterial } from './Materials';

export interface RoverParts {
  root: Group;
  /** One per wheel, in the order the physics expects: FL, FR, RL, RR. */
  wheels: Object3D[];
  /** Spinning hub inside each wheel assembly. */
  hubs: Object3D[];
  setDamage?(v: number): void;
  setLights?(on: boolean): void;
  dispose(): void;
}

export function buildRoverMesh(rng: Rng): RoverParts {
  const root = new Group();
  const hull = makeHullMaterial(rng, { base: new Color(0.42, 0.40, 0.36), wear: 0.5 });
  const dark = new MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.85, metalness: 0.2 });
  const rubber = new MeshStandardMaterial({ color: 0x131417, roughness: 0.97, metalness: 0.0 });
  const headlight = makeEmissive(new Color(2.6, 2.4, 2.0), 1);
  const taillight = makeEmissive(new Color(2.4, 0.25, 0.18), 1);

  const add = (geo: any, mat: any, x: number, y: number, z: number, parent: Object3D = root) => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  /* ---- chassis ---- */
  add(new BoxGeometry(1.72, 0.34, 3.30), hull, 0, 0.20, 0);
  // Nose: a wedge, so it reads as "front" from behind as well as in front.
  const nose = add(new BoxGeometry(1.62, 0.42, 0.95), hull, 0, 0.42, 1.30);
  nose.rotation.x = -0.16;
  // Cabin.
  add(new BoxGeometry(1.44, 0.62, 1.35), hull, 0, 0.78, 0.10);
  // Rear deck with a cargo lip.
  add(new BoxGeometry(1.58, 0.26, 1.05), hull, 0, 0.50, -1.18);
  add(new BoxGeometry(1.58, 0.30, 0.09), dark, 0, 0.72, -1.66);

  /* ---- roll cage ---- */
  const bar = (x: number, y: number, z: number, len: number, rot: number) => {
    const g = new CylinderGeometry(0.045, 0.045, len, 8);
    const m = add(g, dark, x, y, z);
    m.rotation.z = rot;
    return m;
  };
  bar(-0.70, 1.18, 0.10, 0.72, 0);
  bar(0.70, 1.18, 0.10, 0.72, 0);
  bar(0, 1.52, 0.10, 1.42, Math.PI / 2);
  const hoop = add(new TorusGeometry(0.70, 0.045, 8, 20, Math.PI), dark, 0, 1.18, -0.55);
  hoop.rotation.y = Math.PI / 2;

  /* ---- lights ---- */
  const lights: Mesh[] = [];
  lights.push(add(new SphereGeometry(0.11, 12, 8), headlight, -0.58, 0.52, 1.74));
  lights.push(add(new SphereGeometry(0.11, 12, 8), headlight, 0.58, 0.52, 1.74));
  lights.push(add(new BoxGeometry(0.26, 0.08, 0.05), taillight, -0.60, 0.60, -1.70));
  lights.push(add(new BoxGeometry(0.26, 0.08, 0.05), taillight, 0.60, 0.60, -1.70));

  /* ---- wheels ---- */
  const wheels: Object3D[] = [];
  const hubs: Object3D[] = [];
  const hx = 0.92;
  const hz = 1.42;
  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    const pivot = new Group();
    pivot.position.set(i % 2 === 0 ? -hx : hx, 0, front ? hz : -hz);
    root.add(pivot);

    const hub = new Group();
    pivot.add(hub);

    // Tyre: a torus reads far better than a cylinder at a glance, because the
    // rounded shoulder catches a highlight the way real rubber does.
    const tyre = new Mesh(new TorusGeometry(0.30, 0.13, 10, 20), rubber);
    tyre.rotation.y = Math.PI / 2;
    tyre.castShadow = true;
    hub.add(tyre);
    const rim = new Mesh(new CylinderGeometry(0.19, 0.19, 0.20, 10), dark);
    rim.rotation.z = Math.PI / 2;
    hub.add(rim);
    // Tread blocks, so the wheel visibly rotates.
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const t = new Mesh(new BoxGeometry(0.22, 0.07, 0.11), rubber);
      t.position.set(0, Math.cos(a) * 0.40, Math.sin(a) * 0.40);
      t.rotation.x = -a;
      hub.add(t);
    }

    wheels.push(pivot);
    hubs.push(hub);
  }

  const mats = [hull, dark, rubber, headlight, taillight];

  return {
    root,
    wheels,
    hubs,
    setDamage(v: number) {
      // Damage reads as grime and dulled paint rather than as geometry.
      hull.roughness = 0.55 + v * 0.42;
      hull.color.setRGB(0.42 - v * 0.16, 0.40 - v * 0.17, 0.36 - v * 0.15);
    },
    setLights(on: boolean) {
      for (const l of lights) (l.material as MeshStandardMaterial).emissiveIntensity = on ? 1 : 0.06;
    },
    dispose() {
      disposeTree(root);
      for (const m of mats) m.dispose();
    },
  };
}
