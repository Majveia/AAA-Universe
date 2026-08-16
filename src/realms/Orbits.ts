/**
 * Keplerian orbital mechanics.
 *
 * Every planet, moon and asteroid in ÆON is on a real two-body orbit solved
 * from its elements. Nothing is on a circle with a sine wave. The consequence
 * you can actually see: eccentric worlds visibly speed up at periapsis, moons
 * transit their primaries and cast real shadows, and the whole system is
 * time-reversible — you can wind the clock back and everything returns.
 */

import { Vector3 } from 'three';
import { G } from '../universe/Types';
import type { OrbitElements } from '../universe/Types';

/**
 * Solve Kepler's equation M = E - e·sin E for the eccentric anomaly.
 * Newton–Raphson, with a starting guess good enough that it converges in
 * three iterations for anything short of a comet.
 */
export function solveKepler(M: number, e: number): number {
  // Normalise into [-π, π] where the iteration is best behaved.
  let m = M % (Math.PI * 2);
  if (m > Math.PI) m -= Math.PI * 2;
  if (m < -Math.PI) m += Math.PI * 2;

  let E = e < 0.8 ? m : Math.PI * Math.sign(m || 1);
  for (let i = 0; i < 8; i++) {
    const f = E - e * Math.sin(E) - m;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

const _v = new Vector3();

/** Position on an orbit at time t (seconds since epoch), in metres. */
export function orbitalPosition(o: OrbitElements, t: number, out = new Vector3()): Vector3 {
  const n = (Math.PI * 2) / o.periodS; // mean motion
  const M = o.m0 + n * t;
  const E = solveKepler(M, o.e);

  // Perifocal coordinates.
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const xp = o.a * (cosE - o.e);
  const yp = o.a * Math.sqrt(1 - o.e * o.e) * sinE;

  return perifocalToWorld(xp, yp, o, out);
}

/** Velocity on an orbit at time t, in m/s. */
export function orbitalVelocity(o: OrbitElements, t: number, out = new Vector3()): Vector3 {
  const n = (Math.PI * 2) / o.periodS;
  const M = o.m0 + n * t;
  const E = solveKepler(M, o.e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const r = o.a * (1 - o.e * cosE);
  const fac = (Math.sqrt(G * o.primaryMassKg * o.a) / r);
  const xp = -fac * sinE;
  const yp = fac * Math.sqrt(1 - o.e * o.e) * cosE;
  return perifocalToWorld(xp, yp, o, out);
}

function perifocalToWorld(xp: number, yp: number, o: OrbitElements, out: Vector3): Vector3 {
  const cw = Math.cos(o.argP);
  const sw = Math.sin(o.argP);
  const co = Math.cos(o.raan);
  const so = Math.sin(o.raan);
  const ci = Math.cos(o.i);
  const si = Math.sin(o.i);

  // Standard 3-1-3 rotation from the perifocal frame to the reference frame,
  // with y as the vertical axis to match Three.js conventions.
  const x = (cw * co - sw * so * ci) * xp + (-sw * co - cw * so * ci) * yp;
  const z = (cw * so + sw * co * ci) * xp + (-sw * so + cw * co * ci) * yp;
  const y = sw * si * xp + cw * si * yp;

  return out.set(x, y, z);
}

/** Sample points along a full orbit, for drawing the trace line. */
export function orbitPolyline(o: OrbitElements, segments = 256): Float32Array {
  const arr = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const E = (i / segments) * Math.PI * 2;
    const xp = o.a * (Math.cos(E) - o.e);
    const yp = o.a * Math.sqrt(1 - o.e * o.e) * Math.sin(E);
    perifocalToWorld(xp, yp, o, _v);
    arr[i * 3] = _v.x;
    arr[i * 3 + 1] = _v.y;
    arr[i * 3 + 2] = _v.z;
  }
  return arr;
}

/** Sphere-of-influence radius: where this body's gravity beats its primary's. */
export function hillRadius(o: OrbitElements, bodyMassKg: number): number {
  return o.a * (1 - o.e) * Math.cbrt(bodyMassKg / (3 * o.primaryMassKg));
}
