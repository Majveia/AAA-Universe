/**
 * The starship, as geometry.
 *
 * Built for silhouette above all else: this is the object the player looks at
 * for the entire game, from behind, at every distance from four metres to four
 * kilometres. So it is a shape first — a long forward spine, a swept delta,
 * two heavy nacelles slung below the wing roots, a canopy set well forward —
 * and detail second.
 *
 * Local axes match the rest of the entities: **-Z is forward**, +Y is up.
 */

import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import type { Rng } from '../core/Rand';
import {
  disposeTree,
  makeEmissive,
  makeFlameMaterial,
  makeGlowMaterial,
  makeHullMaterial,
  makeVisorMaterial,
  uniformsOf,
} from './Materials';

export interface ShipParts {
  root: Group;
  /** Overall length, metres — the realm uses it for camera framing. */
  length: number;
  /** 0–1 main engine throttle. */
  setThrust(main: number): void;
  /** 0–1 hover jet output, for VTOL landings. */
  setHover(v: number): void;
  /** 0 = stowed, 1 = deployed. */
  setGear(t: number): void;
  setLights(on: boolean): void;
  /** 0–1 warp charge: the drive rings spin up and the hull glows. */
  setWarp(t: number): void;
  setDamage(v: number): void;
  update(time: number): void;
  dispose(): void;
}

export function buildShipMesh(rng: Rng): ShipParts {
  const root = new Group();

  const paint = new Color().setHSL(rng.next(), rng.range(0.12, 0.4), rng.range(0.32, 0.55));
  const accent = new Color().setHSL((rng.next() + 0.5) % 1, 0.8, 0.55);
  const hull = makeHullMaterial(rng, { base: paint, accent, wear: rng.range(0.18, 0.42), plates: 1.1 });
  const dark = new MeshStandardMaterial({ color: 0x16181d, roughness: 0.62, metalness: 0.55 });
  const trim = new MeshStandardMaterial({ color: accent.clone().multiplyScalar(0.55), roughness: 0.35, metalness: 0.7 });
  const glass = makeVisorMaterial();
  const engineCore = makeEmissive(new Color(0.35, 1.5, 3.4), 3.2);
  const navRed = makeEmissive(new Color(3.2, 0.16, 0.1), 1);
  const navGreen = makeEmissive(new Color(0.14, 3.0, 0.5), 1);
  const strobe = makeEmissive(new Color(3.4, 3.4, 3.6), 1);

  const add = (geo: any, mat: any, x: number, y: number, z: number, parent: Object3D = root) => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  /* ── fuselage ─────────────────────────────────────────────────────────── */
  // A long spine with a tapered nose. Three boxes rather than one, so the
  // profile has a shoulder line instead of being a brick.
  add(new BoxGeometry(1.9, 1.25, 6.2), hull, 0, 0, -0.4);
  const nose = add(new ConeGeometry(1.05, 3.4, 6, 1), hull, 0, -0.05, -4.4);
  nose.rotation.x = -Math.PI / 2;
  nose.rotation.z = Math.PI / 6;
  add(new BoxGeometry(2.3, 0.7, 3.0), hull, 0, -0.42, 0.6);
  // Dorsal spine, which is what reads at a distance from above.
  add(new BoxGeometry(0.7, 0.55, 4.4), trim, 0, 0.75, 0.1);

  /* ── canopy ───────────────────────────────────────────────────────────── */
  const canopy = add(new SphereGeometry(0.95, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), glass, 0, 0.5, -2.35);
  canopy.scale.set(0.82, 0.75, 1.7);
  add(new BoxGeometry(1.7, 0.14, 2.4), dark, 0, 0.12, -2.35);

  /* ── wings ────────────────────────────────────────────────────────────── */
  // Swept delta: a long root chord and a short tip, which is the shape that
  // reads as "fast" from any angle.
  const wing = (side: number) => {
    const g = new Group();
    g.position.set(side * 0.9, -0.25, 0.5);
    root.add(g);

    const panel = add(new BoxGeometry(4.6, 0.26, 2.5), hull, side * 2.3, 0, 0.5, g);
    panel.rotation.y = side * -0.42;   // sweep
    panel.rotation.z = side * -0.10;   // dihedral

    // Leading-edge strake back to the fuselage.
    const strake = add(new BoxGeometry(2.4, 0.2, 1.1), hull, side * 1.2, 0.04, -1.5, g);
    strake.rotation.y = side * -0.65;

    // Winglet: the silhouette's exclamation mark.
    const tip = add(new BoxGeometry(0.22, 1.5, 1.3), hull, side * 4.35, 0.6, 1.35, g);
    tip.rotation.x = 0.22;
    add(new BoxGeometry(0.26, 0.14, 0.4), side > 0 ? navGreen : navRed, side * 4.35, 1.32, 1.5, g);

    return g;
  };
  wing(-1);
  wing(1);

  /* ── engines ──────────────────────────────────────────────────────────── */
  const flame = makeFlameMaterial(new Color(0.75, 1.6, 3.6), new Color(0.16, 0.35, 1.5));
  const glow = makeGlowMaterial(new Color(0.3, 1.2, 3.0));
  const flames: Mesh[] = [];
  const cores: Mesh[] = [];

  const engine = (side: number) => {
    const g = new Group();
    g.position.set(side * 1.55, -0.35, 1.5);
    root.add(g);

    const nacelle = new Mesh(new CylinderGeometry(0.62, 0.72, 3.6, 12), hull);
    nacelle.rotation.x = Math.PI / 2;
    nacelle.castShadow = true;
    g.add(nacelle);

    const bell = new Mesh(new CylinderGeometry(0.78, 0.58, 0.8, 12, 1, true), dark);
    bell.rotation.x = Math.PI / 2;
    bell.position.z = 2.0;
    g.add(bell);

    const core = new Mesh(new CylinderGeometry(0.55, 0.55, 0.12, 12), engineCore);
    core.rotation.x = Math.PI / 2;
    core.position.z = 2.05;
    g.add(core);
    cores.push(core);

    // The halo hugs the bell. Any bigger and it stops reading as heat coming
    // off a nozzle and starts reading as a lens flare stuck to the hull.
    const halo = new Mesh(new SphereGeometry(0.82, 14, 10), glow);
    halo.position.z = 2.0;
    halo.scale.set(1, 1, 0.42);
    g.add(halo);

    // The plume: a cone whose local -Z is the exhaust direction, matching the
    // flame shader's convention.
    const cone = new ConeGeometry(0.55, 1, 12, 1, true);
    cone.rotateX(Math.PI / 2);
    cone.translate(0, 0, 0.5);
    cone.scale(1, 1, 7);
    const f = new Mesh(cone, flame);
    f.position.z = 2.1;
    f.rotation.y = Math.PI; // point the plume aft
    f.frustumCulled = false;
    g.add(f);
    flames.push(f);

    return g;
  };
  engine(-1);
  engine(1);

  /* ── warp drive: two counter-rotating rings around the spine ──────────── */
  const warpMat = makeEmissive(new Color(0.5, 0.9, 3.2), 0.0);
  const rings: Mesh[] = [];
  for (let i = 0; i < 2; i++) {
    const r = new Mesh(new TorusGeometry(1.55, 0.10, 6, 28), warpMat);
    r.position.set(0, -0.1, 0.4 + i * 1.5);
    root.add(r);
    rings.push(r);
  }

  /* ── landing gear ─────────────────────────────────────────────────────── */
  const legs: Group[] = [];
  const legAt = (x: number, z: number) => {
    const pivot = new Group();
    pivot.position.set(x, -0.5, z);
    root.add(pivot);
    const strut = new Mesh(new CylinderGeometry(0.10, 0.12, 1.7, 8), dark);
    strut.position.y = -0.85;
    strut.castShadow = true;
    pivot.add(strut);
    const foot = new Mesh(new CylinderGeometry(0.36, 0.42, 0.16, 10), dark);
    foot.position.y = -1.68;
    pivot.add(foot);
    legs.push(pivot);
    return pivot;
  };
  legAt(0, -2.6);
  legAt(-1.9, 1.4);
  legAt(1.9, 1.4);

  /* ── hover jets: four downward nozzles that only light on approach ────── */
  const hoverMat = makeFlameMaterial(new Color(2.4, 1.5, 0.6), new Color(1.4, 0.5, 0.15));
  const hovers: Mesh[] = [];
  for (const [hx, hz] of [[-1.5, -1.9], [1.5, -1.9], [-1.7, 1.6], [1.7, 1.6]] as const) {
    const cone = new ConeGeometry(0.34, 1, 8, 1, true);
    cone.rotateX(Math.PI / 2);
    cone.translate(0, 0, 0.5);
    cone.scale(1, 1, 3.2);
    const m = new Mesh(cone, hoverMat);
    m.position.set(hx, -0.62, hz);
    m.rotation.x = -Math.PI / 2; // plume straight down
    m.frustumCulled = false;
    root.add(m);
    hovers.push(m);
    add(new CylinderGeometry(0.3, 0.34, 0.2, 8), dark, hx, -0.6, hz);
  }

  /* ── strobe and floodlights ───────────────────────────────────────────── */
  const strobeMesh = add(new SphereGeometry(0.12, 8, 6), strobe, 0, 1.12, 0.1);
  const flood = add(new BoxGeometry(0.5, 0.12, 0.1), makeEmissive(new Color(2.8, 2.6, 2.2), 1), 0, -0.55, -3.5);

  const flameU = uniformsOf(flame);
  const hoverU = uniformsOf(hoverMat);
  const glowU = uniformsOf(glow);
  const hullU = uniformsOf(hull);

  let gearT = 1;
  let warpT = 0;
  let lightsOn = true;

  const parts: ShipParts = {
    root,
    length: 10.5,
    setThrust(main: number) {
      const t = Math.max(0, Math.min(1, main));
      if (flameU.uThrottle) flameU.uThrottle.value = t;
      if (glowU.uPower) glowU.uPower.value = 0.06 + t * 1.5;
      engineCore.emissiveIntensity = 0.55 + t * 7.5;
      for (const f of flames) f.visible = t > 0.01;
    },
    setHover(v: number) {
      const t = Math.max(0, Math.min(1, v));
      if (hoverU.uThrottle) hoverU.uThrottle.value = t;
      for (const h of hovers) h.visible = t > 0.02;
    },
    setGear(t: number) {
      gearT = Math.max(0, Math.min(1, t));
      for (let i = 0; i < legs.length; i++) {
        // Legs fold up and forward into the belly.
        legs[i].rotation.x = (1 - gearT) * (i === 0 ? -1.5 : 1.5);
        legs[i].visible = gearT > 0.02;
        legs[i].position.y = -0.5 + (1 - gearT) * 0.35;
      }
    },
    setLights(on: boolean) {
      lightsOn = on;
      flood.visible = on;
      strobeMesh.visible = on;
    },
    setWarp(t: number) {
      warpT = Math.max(0, Math.min(1, t));
      warpMat.emissiveIntensity = warpT * 9;
      for (const r of rings) r.visible = warpT > 0.01;
    },
    setDamage(v: number) {
      if (hullU.uDamage) hullU.uDamage.value = Math.max(0, Math.min(1, v));
    },
    update(time: number) {
      if (flameU.uTime) flameU.uTime.value = time;
      if (hoverU.uTime) hoverU.uTime.value = time;
      // Anti-collision strobe: a hard double-blink, the way aircraft do it.
      if (lightsOn) {
        const p = (time * 1.1) % 1;
        strobeMesh.visible = p < 0.06 || (p > 0.13 && p < 0.19);
      }
      if (warpT > 0.01) {
        rings[0].rotation.z = time * (2 + warpT * 26);
        rings[1].rotation.z = -time * (2 + warpT * 26);
      }
    },
    dispose() {
      disposeTree(root);
      flame.dispose();
      hoverMat.dispose();
      glow.dispose();
      warpMat.dispose();
    },
  };

  parts.setGear(1);
  parts.setThrust(0);
  parts.setHover(0);
  parts.setWarp(0);
  return parts;
}
