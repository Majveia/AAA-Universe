/**
 * The surface environment bus.
 *
 * Scatter, wildlife and weather are three separate systems that the realm
 * constructs independently, but visually they are one place: the same wind has
 * to bend the grass, tilt the rain and ruffle a herd's fur; the same lightning
 * flash has to light all three within the same millisecond. Rather than route
 * all of that through the realm, the surface systems share one small mutable
 * record. Weather writes most of it, everyone reads it.
 *
 * It is a module singleton because exactly one world is ever under your feet.
 * `resetEnv()` is called when a planet is attached.
 */

import { Color, Vector3 } from 'three';
import type { IUniform, Object3D } from 'three';
import type { SystemContext } from '../api/Contracts';
import type { PlanetSpec } from '../universe/Types';

export class SurfaceEnv {
  /** Reference sphere radius, metres. */
  planetRadius = 6.371e6;
  /** Surface gravity, m/s² — drives plant droop and creature proportions. */
  gravity = 9.81;

  /** Unit vector pointing *toward* the star, planet-local. */
  sunDir = new Vector3(0.3, 0.9, 0.2).normalize();
  /** Linear radiance of the sun disc — HDR, not clamped to 1. */
  sunColor = new Color(1.0, 0.94, 0.86);
  sunIntensity = 3.2;

  /** Hemispheric ambient: sky above, bounce below. Both linear HDR. */
  skyColor = new Color(0.16, 0.26, 0.44);
  groundColor = new Color(0.09, 0.075, 0.06);

  /** Aerial perspective. Density is per metre. */
  fogColor = new Color(0.42, 0.55, 0.72);
  fogDensity = 0.0011;

  /** Wind, planet-local m/s. Direction and magnitude both matter to the shader. */
  wind = new Vector3(1, 0, 0);
  windSpeed = 3;

  /** Local up (radially outward) at the viewer. */
  up = new Vector3(0, 1, 0);
  /** Viewer position, planet-local metres. */
  viewer = new Vector3();

  /** 0 = full day, 1 = full night. Drives bioluminescence and creature rest. */
  night = 0;
  /** 0–1 how wet surfaces look. Rain darkens and glosses everything. */
  wetness = 0;
  /** 0–1 snow accumulation on upward-facing surfaces. */
  snow = 0;
  /** Lightning: additive light on everything, decays in ~150 ms. */
  flash = 0;
  flashColor = new Color(1.1, 1.05, 1.4);

  precipitation = 0;
  precipType = 'none';
  /** 0–1 storminess, used by audio and by the creature panic response. */
  storm = 0;

  /** Bioluminescence accent from the planet palette. */
  emissive = new Color(0, 0, 0);
  emissiveStrength = 0;

  /** Simulated world time, seconds. */
  time = 0;

  /** True while the viewer is below the ocean surface. */
  underwater = false;

  reset(spec: PlanetSpec | null, radius: number): void {
    this.planetRadius = radius;
    if (spec) {
      this.gravity = spec.gravity;
      this.emissive.setRGB(spec.palette.emissive[0], spec.palette.emissive[1], spec.palette.emissive[2]);
      this.emissiveStrength = spec.palette.emissiveStrength;
      const t = spec.atmosphere.tint;
      if (spec.atmosphere.present) {
        this.fogColor.setRGB(Math.max(t[0], 0.02), Math.max(t[1], 0.02), Math.max(t[2], 0.02));
        this.skyColor.setRGB(t[0] * 0.55 + 0.02, t[1] * 0.55 + 0.03, t[2] * 0.55 + 0.05);
        this.fogDensity = 0.0006 + spec.atmosphere.fogDensity * 0.0016;
      } else {
        // No air: no aerial perspective at all. Shadows go black, edges stay hard.
        this.fogColor.setRGB(0, 0, 0);
        this.skyColor.setRGB(0.012, 0.012, 0.018);
        this.fogDensity = 0;
      }
      const g = spec.palette.rock;
      this.groundColor.setRGB(g[0] * 0.35, g[1] * 0.35, g[2] * 0.35);
      this.windSpeed = spec.atmosphere.windSpeed;
    }
    this.night = 0;
    this.wetness = 0;
    this.snow = 0;
    this.flash = 0;
    this.precipitation = 0;
    this.precipType = 'none';
    this.storm = 0;
    this.underwater = false;
  }
}

export const env = new SurfaceEnv();

export function resetEnv(spec: PlanetSpec | null, radius: number): void {
  env.reset(spec, radius);
}

/* ───────────────────────────────────────────────────────────────────────────
   Sun resolution
   ─────────────────────────────────────────────────────────────────────────── */

interface SunLike {
  direction?: Vector3;
  color?: [number, number, number] | Color;
  intensity?: number;
}

let sunSearchCooldown = 0;
let cachedLight: any = null;
const _lp = new Vector3();
const _lt = new Vector3();

/**
 * Find the star. The realm may publish `services.sun`; failing that we look for
 * a DirectionalLight in the scene (the planet module owns the real one). The
 * fallback keeps a world lit rather than black if neither exists yet.
 */
export function resolveSun(ctx: SystemContext, dt: number): void {
  const svc = ctx.services?.sun as SunLike | undefined;
  if (svc && svc.direction) {
    env.sunDir.copy(svc.direction).normalize();
    if (svc.color) {
      if (Array.isArray(svc.color)) env.sunColor.setRGB(svc.color[0], svc.color[1], svc.color[2]);
      else env.sunColor.copy(svc.color as Color);
    }
    if (typeof svc.intensity === 'number') env.sunIntensity = svc.intensity;
    return;
  }

  sunSearchCooldown -= dt;
  if (!cachedLight || sunSearchCooldown <= 0) {
    sunSearchCooldown = 1.0;
    cachedLight = null;
    ctx.scene?.traverse((o: Object3D) => {
      if (cachedLight) return;
      if ((o as any).isDirectionalLight) cachedLight = o;
    });
  }
  if (cachedLight) {
    cachedLight.getWorldPosition(_lp);
    if (cachedLight.target) cachedLight.target.getWorldPosition(_lt);
    else _lt.set(0, 0, 0);
    env.sunDir.copy(_lp).sub(_lt);
    if (env.sunDir.lengthSq() > 1e-9) env.sunDir.normalize();
    env.sunColor.copy(cachedLight.color);
    env.sunIntensity = Math.max(0.25, cachedLight.intensity);
  }
}

/** Recompute day/night from the sun's elevation at the viewer. Cheap. */
export function updateDayNight(): void {
  const e = env.sunDir.dot(env.up);
  // Civil twilight is a wide band: the sky is still bright at -6°.
  env.night = 1 - smooth01(-0.12, 0.06, e);
}

function smooth01(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/* ───────────────────────────────────────────────────────────────────────────
   Shared uniforms
   ─────────────────────────────────────────────────────────────────────────── */

/**
 * One set of uniform *objects*, referenced by every surface material. Three
 * uploads per-material, but assigning the same IUniform instance into many
 * materials means one write here updates all of them.
 */
export class EnvUniforms {
  readonly u: Record<string, IUniform> = {
    uTime: { value: 0 },
    uSunDir: { value: new Vector3(0, 1, 0) },
    uSunColor: { value: new Color(1, 1, 1) },
    uSkyColor: { value: new Color(0.2, 0.3, 0.5) },
    uGroundColor: { value: new Color(0.1, 0.08, 0.06) },
    uFogColor: { value: new Color(0.4, 0.5, 0.7) },
    uFogParams: { value: new Vector3(0.0012, 0.0, 1.0) },
    uWind: { value: new Vector3(1, 0, 0) },
    uUp: { value: new Vector3(0, 1, 0) },
    uViewer: { value: new Vector3() },
    uPlayer: { value: new Vector3() },
    uEnvA: { value: new Vector3(0, 0, 0) }, // night, wetness, flash
    uEnvB: { value: new Vector3(0, 0, 0) }, // snow, precipitation, storm
    uFlashColor: { value: new Color(1, 1, 1) },
    uEmissive: { value: new Color(0, 0, 0) },
  };

  /** Copy the env record into the uniform objects. Call once per frame. */
  sync(originOffset: Vector3): void {
    const u = this.u;
    u.uTime.value = env.time;
    (u.uSunDir.value as Vector3).copy(env.sunDir);
    (u.uSunColor.value as Color).copy(env.sunColor).multiplyScalar(env.sunIntensity);
    (u.uSkyColor.value as Color).copy(env.skyColor);
    (u.uGroundColor.value as Color).copy(env.groundColor);
    (u.uFogColor.value as Color).copy(env.fogColor);
    (u.uFogParams.value as Vector3).set(env.fogDensity, env.planetRadius, 0);
    (u.uWind.value as Vector3).copy(env.wind);
    (u.uUp.value as Vector3).copy(env.up);
    (u.uViewer.value as Vector3).copy(env.viewer).sub(originOffset);
    (u.uPlayer.value as Vector3).copy(env.viewer).sub(originOffset);
    (u.uEnvA.value as Vector3).set(env.night, env.wetness, env.flash);
    (u.uEnvB.value as Vector3).set(env.snow, env.precipitation, env.storm);
    (u.uFlashColor.value as Color).copy(env.flashColor);
    (u.uEmissive.value as Color).copy(env.emissive).multiplyScalar(env.emissiveStrength);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   Shared GLSL
   ─────────────────────────────────────────────────────────────────────────── */

/** Uniform declarations matching EnvUniforms. Paste into every surface shader. */
export const GLSL_ENV_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSkyColor;
uniform vec3  uGroundColor;
uniform vec3  uFogColor;
uniform vec3  uFogParams;   // x: fog density /m, y: planet radius
uniform vec3  uWind;        // planet-local wind vector, m/s
uniform vec3  uUp;
uniform vec3  uViewer;      // viewer in local (rebased) space
uniform vec3  uPlayer;
uniform vec3  uEnvA;        // night, wetness, flash
uniform vec3  uEnvB;        // snow, precipitation, storm
uniform vec3  uFlashColor;
uniform vec3  uEmissive;
`;

/**
 * Shading helpers shared by everything that grows or walks on a surface.
 *
 * The lighting model is deliberately not PBR: foliage read as flat, dark
 * cardboard under a strict Lambert term. Wrapped diffuse plus back-scatter
 * transmission is what makes a leaf canopy glow when the sun is behind it,
 * and that single term does most of the work of making a forest look alive.
 */
export const GLSL_SURFACE_LIB = /* glsl */ `
#ifndef AEON_SURFACE_LIB
#define AEON_SURFACE_LIB

// Interleaved gradient noise — the cheapest good screen-door pattern.
float aeonDither(vec2 fc){
  return fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))));
}

float aeonHash11(float p){
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

vec3 aeonHash31(float p){
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

// Cheap value noise — used for silhouette masks and cloud-ish alpha, never for
// terrain (that must match the CPU implementation in core/Noise.ts).
float aeonVnoise(vec3 p){
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n = i.x + i.y * 57.0 + i.z * 113.0;
  float a = aeonHash11(n);
  float b = aeonHash11(n + 1.0);
  float c = aeonHash11(n + 57.0);
  float d = aeonHash11(n + 58.0);
  float e = aeonHash11(n + 113.0);
  float g = aeonHash11(n + 114.0);
  float h = aeonHash11(n + 170.0);
  float k = aeonHash11(n + 171.0);
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
             mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}

float aeonFbm(vec3 p, int oct){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    s += a * aeonVnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

vec3 aeonRotQ(vec4 q, vec3 v){
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

/**
 * Coherent gust field. Two long travelling waves along the wind direction plus
 * a slow cross-wave: a field of grass then ripples in bands that sweep across
 * it, which is the single most important cue that a world is alive. Independent
 * per-blade jitter reads as static noise; this reads as weather.
 */
float aeonGust(vec3 wp, vec3 wdir, float speed, float t){
  float d = dot(wp, wdir);
  float g = sin(d * 0.055 - t * speed * 0.055) * 0.62
          + sin(d * 0.0161 - t * speed * 0.0161 + 1.7) * 0.38;
  vec3 cross0 = normalize(cross(wdir, uUp) + vec3(1e-5));
  float c = sin(dot(wp, cross0) * 0.031 + t * 0.42) * 0.22;
  return g + c;
}

/** Sun + hemispheric ambient + leaf transmission. V points surface→camera. */
vec3 aeonShade(vec3 albedo, vec3 N, vec3 V, float ao, float wrap, float trans){
  float ndl = dot(N, uSunDir);
  float diff = max(0.0, (ndl + wrap) / (1.0 + wrap));
  vec3 lit = uSunColor * diff;

  // Light coming *through* the surface from behind — leaves, membranes, fins.
  if (trans > 0.0){
    float back = pow(max(0.0, dot(-V, uSunDir)), 3.0);
    lit += uSunColor * back * trans * (0.55 + 0.45 * max(0.0, -ndl));
  }

  float h = 0.5 + 0.5 * dot(N, uUp);
  vec3 amb = mix(uGroundColor, uSkyColor, h) * ao;

  vec3 c = albedo * (lit + amb);
  c += albedo * uFlashColor * uEnvA.z;
  return c;
}

/** Wet surfaces are darker and glossier. Cheap Blinn lobe, HDR, unclamped. */
vec3 aeonWetSheen(vec3 c, vec3 N, vec3 V, float wet, float upness){
  if (wet <= 0.001) return c;
  float w = wet * upness;
  c *= mix(1.0, 0.62, w);
  vec3 H = normalize(uSunDir + V);
  float s = pow(max(0.0, dot(N, H)), 90.0);
  return c + uSunColor * s * w * 0.9;
}

/**
 * Aerial perspective. Vc points camera→surface, so the sun-facing term brightens
 * haze when you look toward the star — the reason distant hills wash out warm at
 * sunset and stay cold blue at your back.
 */
vec3 aeonAerial(vec3 color, float dist, vec3 Vc){
  float dens = uFogParams.x;
  if (dens <= 0.0) return color;
  float f = 1.0 - exp(-dist * dens);
  float sunAmt = max(0.0, dot(Vc, uSunDir));
  vec3 fogc = uFogColor * (0.6 + 0.4 * (1.0 - uEnvA.x));
  fogc = mix(fogc, fogc * 0.4 + uSunColor * 0.5, pow(sunAmt, 5.0) * 0.75);
  fogc += uFlashColor * uEnvA.z * 0.6;
  return mix(color, fogc, f);
}

#endif
`;
