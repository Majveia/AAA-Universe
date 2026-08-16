/**
 * Aerial perspective — the haze between the eye and everything it is looking at.
 *
 * This lives on the *surfaces*, not on the atmosphere shell, and that is a
 * deliberate split. The shell is drawn with back faces so it can double as the
 * sky from underneath, which means over the planet's own disc it loses the
 * depth test against the ground and contributes only the limb. Anything solid
 * therefore has to compute its own haze, and the two never double-count:
 * rays that hit something get it from here, rays that miss get it from the shell.
 *
 * The integral is closed-form. For an atmosphere whose density falls off as
 * e^(-h/H), the mean density along a chord between altitudes h₀ and h₁ is
 *
 *     ρ̄ = H·(e^(-h₁/H) − e^(-h₀/H)) / (h₀ − h₁)
 *
 * so the whole effect costs two exponentials and no raymarching, at any
 * distance from a metre to a planetary radius.
 */

import { Vector3 } from 'three';
import type { PlanetSpec } from '../universe/Types';

/** Uniform block. Include once per shader that uses `aeAerial`. */
export const AERIAL_UNIFORMS = /* glsl */ `
uniform vec3  uAerialBeta;   // extinction per metre at sea level, RGB
uniform vec3  uAerialScat;   // scattering spectrum, normalised to max 1
uniform float uAerialH;      // atmospheric scale height, m
uniform float uAerialR;      // reference radius the altitudes are measured from
`;

export const AERIAL_GLSL = /* glsl */ `
#ifndef AEON_AERIAL_INCLUDED
#define AEON_AERIAL_INCLUDED

/**
 * Fold haze into an already-shaded colour. The point and the eye are given in
 * planet-local metres; sunDir points toward the star.
 */
vec3 aeAerial(vec3 col, vec3 p, vec3 eye, vec3 sunDir, vec3 sunColor, float sunI){
  if (uAerialH <= 0.0) return col;
  vec3 seg = p - eye;
  float dist = length(seg);
  if (dist < 1.0) return col;
  vec3 rd = seg / dist;

  float hC = max(0.0, length(eye) - uAerialR);
  float hF = max(0.0, length(p) - uAerialR);
  float dh = hC - hF;
  float rho = abs(dh) < 1.0
    ? exp(-hC / uAerialH)
    : uAerialH * (exp(-hF / uAerialH) - exp(-hC / uAerialH)) / dh;
  vec3 ext = exp(-uAerialBeta * (rho * dist));

  float mu = dot(rd, sunDir);
  // Rayleigh's normalised phase, plus a cheap forward Mie lobe. Haze toward
  // the sun really is several times brighter than haze away from it, and that
  // gradient is most of what the eye reads as distance.
  float phaseR = 0.0596831 * (1.0 + mu * mu);
  float phaseM = 0.16 * pow(max(mu, 0.0), 14.0);
  vec3 inscat = sunColor * sunI * (uAerialScat * phaseR + vec3(phaseM)) * (1.0 - ext);
  return col * ext + inscat;
}

#endif
`;

/** Total extinction per metre at sea level: Rayleigh scattering, Mie, ozone. */
export function aerialBeta(spec: PlanetSpec): Vector3 {
  const a = spec.atmosphere;
  if (!a.present) return new Vector3(0, 0, 0);
  return new Vector3(
    a.rayleigh[0] + a.mie + a.absorption[0],
    a.rayleigh[1] + a.mie + a.absorption[1],
    a.rayleigh[2] + a.mie + a.absorption[2]
  );
}

/**
 * The scattering spectrum, normalised so the strongest channel is 1. This is
 * what colours the haze: on Earth the blue end scatters six times as hard as
 * the red, which is why distant ridges go blue and sunsets do not.
 */
export function aerialScat(spec: PlanetSpec): Vector3 {
  const a = spec.atmosphere;
  if (!a.present) return new Vector3(0, 0, 0);
  const r = new Vector3(a.rayleigh[0] + a.mie, a.rayleigh[1] + a.mie, a.rayleigh[2] + a.mie);
  const m = Math.max(r.x, r.y, r.z) || 1;
  return r.divideScalar(m);
}

/** The uniform values, ready to spread into a ShaderMaterial. */
export function aerialUniformValues(spec: PlanetSpec) {
  return {
    uAerialBeta: aerialBeta(spec),
    uAerialScat: aerialScat(spec),
    uAerialH: spec.atmosphere.present ? spec.atmosphere.scaleHeightM : 0,
    uAerialR: spec.radiusM,
  };
}
