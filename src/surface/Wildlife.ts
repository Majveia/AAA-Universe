/**
 * Fauna.
 *
 * A handful of species per world, each with a body plan derived from the
 * planet's gravity and class — low gravity grows tall, spindly, long-limbed
 * things; high gravity grows low, broad, heavy ones. Herds flock, flyers
 * circle on thermals, and everything keeps its distance from the player.
 *
 * Creatures are simulated only near the viewer, but a herd remembers where it
 * was, so walking away and back does not teleport it.
 */

import {
  BoxGeometry,
  Color,
  ConeGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import type { IPlanet, IWildlife, SystemContext } from '../api/Contracts';
import type { QualityProfile } from '../core/Settings';
import { Rng } from '../core/Rand';
import { saturate } from '../core/Noise';

type Locomotion = 'walker' | 'flyer' | 'swimmer';

interface Species {
  id: number;
  name: string;
  locomotion: Locomotion;
  size: number;
  legs: number;
  color: Color;
  accent: Color;
  speed: number;
  /** How close the player can get before it bolts, metres. */
  flightDistance: number;
  herd: number;
  neck: number;
  tail: number;
}

interface Creature {
  species: Species;
  position: Vector3;
  velocity: Vector3;
  heading: Vector3;
  obj: Object3D;
  legPhase: number;
  alarm: number;
}

interface Herd {
  species: Species;
  center: Vector3;
  members: Creature[];
}

export class Wildlife implements IWildlife {
  readonly root = new Group();

  private planet: IPlanet | null = null;
  private species: Species[] = [];
  private herds: Herd[] = [];
  private viewer = new Vector3();
  private quality: QualityProfile | null = null;
  private rng = new Rng(1);
  private time = 0;
  private materials: MeshStandardMaterial[] = [];

  attach(planet: IPlanet): void {
    this.dispose();
    this.planet = planet;
    const spec = planet.spec;
    this.rng = new Rng(spec.seed ^ 0x3b19);

    const count = Math.max(1, Math.round(2 + spec.biodiversity * 6));
    const g = spec.gravity / 9.81;
    for (let i = 0; i < count; i++) {
      const r = this.rng.fork(i);
      // Gravity shapes the body plan. This is the single rule that makes the
      // fauna of a 0.2 g moon look unmistakably unlike a 2 g world's.
      const size = r.range(0.5, 3.4) / Math.pow(Math.max(0.15, g), 0.55);
      const loco: Locomotion = r.weighted<Locomotion>([
        ['walker', 6],
        ['flyer', g < 1.4 ? 3 : 1],
        ['swimmer', spec.ocean.present ? 2 : 0],
      ]);
      const base = new Color(...spec.palette.vegetation).lerp(new Color(...spec.palette.rock), r.next());
      base.offsetHSL(r.range(-0.25, 0.25), r.range(-0.1, 0.3), r.range(-0.15, 0.2));
      this.species.push({
        id: i,
        name: `species-${i}`,
        locomotion: loco,
        size,
        legs: loco === 'walker' ? r.weighted([[2, 2], [4, 6], [6, 2]]) : 0,
        color: base,
        accent: new Color(...spec.palette.emissive).multiplyScalar(0.4).add(base.clone().multiplyScalar(0.4)),
        speed: r.range(2, 9) * Math.pow(Math.max(0.2, g), -0.25),
        flightDistance: r.range(12, 45),
        herd: loco === 'flyer' ? r.int(6, 22) : r.int(2, 12),
        neck: r.range(0.1, 1.0),
        tail: r.range(0.1, 1.2),
      });
    }
  }

  setViewer(localPosition: Vector3): void {
    this.viewer.copy(localPosition);
  }

  population(): number {
    let n = 0;
    for (const h of this.herds) n += h.members.length;
    return n;
  }

  private buildMesh(sp: Species): Object3D {
    const g = new Group();
    const mat = new MeshStandardMaterial({ color: sp.color, roughness: 0.82, metalness: 0.02 });
    const accent = new MeshStandardMaterial({ color: sp.accent, roughness: 0.6, metalness: 0.05 });
    this.materials.push(mat, accent);
    const s = sp.size;

    const body = new Mesh(new SphereGeometry(0.5, 14, 10), mat);
    body.scale.set(0.62, 0.58, 1.0);
    body.position.y = s * 0.55;
    body.castShadow = true;
    g.add(body);
    body.scale.multiplyScalar(s);

    // Neck and head: the silhouette cue that reads at a hundred metres.
    const neck = new Mesh(new ConeGeometry(0.16, 1, 8), mat);
    neck.position.set(0, s * (0.62 + sp.neck * 0.35), s * 0.42);
    neck.rotation.x = -0.6;
    neck.scale.setScalar(s * (0.5 + sp.neck));
    g.add(neck);
    const head = new Mesh(new SphereGeometry(0.2, 10, 8), accent);
    head.position.set(0, s * (0.75 + sp.neck * 0.7), s * (0.55 + sp.neck * 0.4));
    head.scale.setScalar(s);
    g.add(head);

    if (sp.locomotion === 'flyer') {
      for (const side of [-1, 1]) {
        const wing = new Mesh(new BoxGeometry(1.6, 0.04, 0.55), accent);
        wing.position.set(side * s * 0.6, s * 0.6, 0);
        wing.scale.setScalar(s);
        wing.name = `wing${side}`;
        g.add(wing);
      }
    } else {
      const legLen = s * 0.55;
      for (let i = 0; i < sp.legs; i++) {
        const row = Math.floor(i / 2);
        const side = i % 2 === 0 ? -1 : 1;
        const leg = new Mesh(new BoxGeometry(0.09, 1, 0.09), mat);
        leg.geometry.translate(0, -0.5, 0);
        leg.position.set(side * s * 0.28, s * 0.55, s * (0.35 - row * (0.7 / Math.max(1, sp.legs / 2 - 1 || 1))));
        leg.scale.set(s, legLen, s);
        leg.name = `leg${i}`;
        g.add(leg);
      }
    }

    const tail = new Mesh(new ConeGeometry(0.13, 1, 7), mat);
    tail.position.set(0, s * 0.6, -s * 0.55);
    tail.rotation.x = Math.PI * 0.55;
    tail.scale.setScalar(s * (0.4 + sp.tail));
    g.add(tail);

    return g;
  }

  update(dt: number, ctx: SystemContext): void {
    if (!this.planet || !this.species.length) return;
    this.time += dt;
    const R = this.planet.radius;
    const density = this.quality?.scatterDensity ?? 1;
    const maxHerds = Math.max(1, Math.round(4 * density));
    const spawnR = 260;

    /* ---- spawn and retire herds ---- */
    if (this.herds.length < maxHerds) {
      const sp = this.rng.pick(this.species);
      const dir = _d.copy(this.viewer).normalize();
      const ref = Math.abs(dir.y) > 0.94 ? _a.set(1, 0, 0) : _a.set(0, 1, 0);
      const tx = _b.crossVectors(ref, dir).normalize();
      const tz = _c.crossVectors(dir, tx).normalize();
      const ang = this.rng.range(0, Math.PI * 2);
      const dist = this.rng.range(70, spawnR);
      const spot = _e
        .copy(dir)
        .addScaledVector(tx, (Math.cos(ang) * dist) / R)
        .addScaledVector(tz, (Math.sin(ang) * dist) / R)
        .normalize();

      const sample = this.planet.sampleSurface(spot);
      const ok =
        sp.locomotion === 'swimmer' ? sample.underwater : !sample.underwater && sample.slope < 0.45;
      if (ok) {
        const herd: Herd = { species: sp, center: spot.clone().multiplyScalar(R + this.planet.heightAt(spot)), members: [] };
        const n = Math.max(1, Math.round(sp.herd * saturate(density)));
        for (let i = 0; i < n; i++) {
          const obj = this.buildMesh(sp);
          this.root.add(obj);
          const p = herd.center.clone();
          const jitterDir = _f.copy(p).normalize();
          const jt = this.rng.range(0, Math.PI * 2);
          const jr = this.rng.range(0, 6 + sp.herd * 0.8);
          p.addScaledVector(tx, Math.cos(jt) * jr).addScaledVector(tz, Math.sin(jt) * jr);
          const up = jitterDir;
          herd.members.push({
            species: sp,
            position: p,
            velocity: new Vector3(),
            heading: _g.crossVectors(up, tx).normalize().clone(),
            obj,
            legPhase: this.rng.range(0, Math.PI * 2),
            alarm: 0,
          });
        }
        this.herds.push(herd);
      }
    }

    /* ---- simulate ---- */
    for (let hi = this.herds.length - 1; hi >= 0; hi--) {
      const herd = this.herds[hi];
      if (herd.center.distanceTo(this.viewer) > spawnR * 1.9) {
        for (const m of herd.members) {
          this.root.remove(m.obj);
          m.obj.traverse((o: any) => o.geometry?.dispose?.());
        }
        this.herds.splice(hi, 1);
        continue;
      }

      const sp = herd.species;
      _center.set(0, 0, 0);
      for (const m of herd.members) _center.add(m.position);
      _center.multiplyScalar(1 / Math.max(1, herd.members.length));
      herd.center.copy(_center);

      for (const m of herd.members) {
        const up = _up.copy(m.position).normalize();
        const toPlayer = _tp.subVectors(this.viewer, m.position);
        const dPlayer = toPlayer.length();

        // Boids: cohesion toward the herd, separation from neighbours.
        _steer.set(0, 0, 0);
        _steer.addScaledVector(_tmp.subVectors(herd.center, m.position), 0.55);
        for (const o of herd.members) {
          if (o === m) continue;
          const d = m.position.distanceTo(o.position);
          if (d < sp.size * 2.2 && d > 1e-3) {
            _steer.addScaledVector(_tmp.subVectors(m.position, o.position).divideScalar(d), 3.2);
          }
        }

        // Flee the player, with a species-specific comfort radius.
        if (dPlayer < sp.flightDistance) {
          m.alarm = 1;
          _steer.addScaledVector(toPlayer.normalize(), -14 * (1 - dPlayer / sp.flightDistance));
        } else {
          m.alarm = Math.max(0, m.alarm - dt * 0.4);
        }

        // Wander.
        const w = this.time * 0.4 + m.legPhase;
        _steer.x += Math.sin(w * 1.1) * 0.8;
        _steer.z += Math.cos(w * 0.9) * 0.8;

        // Stay on the tangent plane (walkers) or hold an altitude (flyers).
        _steer.addScaledVector(up, -_steer.dot(up));

        const maxSpeed = sp.speed * (0.35 + m.alarm * 0.9);
        m.velocity.addScaledVector(_steer, dt * 2.4);
        m.velocity.addScaledVector(up, -m.velocity.dot(up));
        if (m.velocity.length() > maxSpeed) m.velocity.setLength(maxSpeed);
        m.velocity.multiplyScalar(Math.max(0, 1 - 1.6 * dt));
        m.position.addScaledVector(m.velocity, dt);

        // Sit on the ground (or circle above it).
        const dir = _dir.copy(m.position).normalize();
        const h = this.planet.heightAt(dir);
        const seaR = this.planet.seaLevelRadius();
        let targetR = this.planet.radius + h;
        if (sp.locomotion === 'flyer') targetR += 18 + Math.sin(this.time * 0.6 + m.legPhase) * 9;
        else if (sp.locomotion === 'swimmer' && seaR > 0) targetR = seaR - 1.2 - Math.sin(this.time + m.legPhase) * 0.8;
        m.position.copy(dir).multiplyScalar(targetR);

        const speed = m.velocity.length();
        if (speed > 0.05) m.heading.copy(m.velocity).normalize();

        // Orient: up along the radius, nose along the heading.
        _right.crossVectors(m.heading, dir).normalize();
        _fwd.crossVectors(dir, _right).normalize();
        _mat.makeBasis(_right, dir, _fwd.clone().multiplyScalar(-1));
        m.obj.quaternion.setFromRotationMatrix(_mat);
        m.obj.position.copy(m.position);

        /* ---- animation ---- */
        m.legPhase += dt * (2.5 + speed * 1.6);
        if (sp.locomotion === 'flyer') {
          for (const side of [-1, 1]) {
            const wing = m.obj.getObjectByName(`wing${side}`);
            if (wing) wing.rotation.z = Math.sin(m.legPhase * 3.2) * 0.6 * side;
          }
        } else {
          for (let i = 0; i < sp.legs; i++) {
            const leg = m.obj.getObjectByName(`leg${i}`);
            if (leg) leg.rotation.x = Math.sin(m.legPhase + i * Math.PI * 0.5) * 0.55 * saturate(speed / 2);
          }
        }
      }
    }
  }

  setQuality(q: QualityProfile): void {
    this.quality = q;
  }

  dispose(): void {
    for (const h of this.herds) {
      for (const m of h.members) {
        this.root.remove(m.obj);
        m.obj.traverse((o: any) => o.geometry?.dispose?.());
      }
    }
    this.herds = [];
    for (const m of this.materials) m.dispose();
    this.materials = [];
    this.species = [];
  }
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _f = new Vector3();
const _g = new Vector3();
const _up = new Vector3();
const _tp = new Vector3();
const _tmp = new Vector3();
const _steer = new Vector3();
const _center = new Vector3();
const _dir = new Vector3();
const _right = new Vector3();
const _fwd = new Vector3();
const _mat = new Matrix4();
