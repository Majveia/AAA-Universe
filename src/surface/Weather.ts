/**
 * Weather and sky drama.
 *
 * A light climate model rather than a random-number generator: pressure cells
 * drift around the planet and set the wind; humidity comes from ocean
 * proximity; precipitation happens where humid air is pushed uphill, which is
 * why it rains on the windward side of a mountain range and not the lee side.
 * That one rule makes weather feel like it belongs to the terrain.
 *
 * Plus the two phenomena worth flying across a system to see: aurorae along
 * the magnetic field lines, and lightning that genuinely lights the ground.
 */

import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  Points,
  ShaderMaterial,
  SphereGeometry,
  Uniform,
  Vector3,
} from 'three';
import type { IPlanet, IWeather, SystemContext, WeatherState } from '../api/Contracts';
import type { QualityProfile } from '../core/Settings';
import { GLSL_COLOR, GLSL_NOISE } from '../core/Noise';
import { fbm3, saturate, smoothstep } from '../core/Noise';
import { Rng } from '../core/Rand';
import { env } from './Env';

const AURORA_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocal;
void main(){
  vLocal = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

/**
 * Aurorae are curtains, not clouds: charged particles spiral down field lines
 * into a narrow oval around the magnetic pole, so the structure is vertical
 * and banded, and the colour changes with altitude — oxygen green low down,
 * oxygen red high up, nitrogen violet at the fringes.
 */
const AURORA_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}
${GLSL_COLOR}

uniform float uTime;
uniform float uIntensity;
uniform float uRadius;
uniform float uThickness;
uniform vec3  uAxis;
uniform float uOvalLat;
varying vec3 vLocal;

void main(){
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vLocal);
  float lat = dot(d, normalize(uAxis));

  // The auroral oval: a band at a fixed magnetic latitude, both hemispheres.
  float band = exp(-pow((abs(lat) - uOvalLat) / 0.085, 2.0));
  if (band < 0.004) discard;

  float alt = (length(vLocal) - uRadius) / max(1.0, uThickness);

  // Curtains: high-frequency structure around the oval, drifting.
  vec3 p = d * 9.0;
  float curtain = fbm(vec3(p.x, p.y * 0.35, p.z) + vec3(0.0, uTime * 0.06, uTime * 0.13), 5) * 0.5 + 0.5;
  curtain = pow(curtain, 2.2);
  float rays = ridged(vec3(p.x * 3.0, alt * 1.5, p.z * 3.0) + vec3(uTime * 0.2, 0.0, 0.0), 4, 2.1, 0.55);

  float v = band * curtain * (0.35 + rays * 1.3);
  // Vertical falloff: bright and sharp at the bottom, fading with altitude.
  v *= exp(-alt * 1.6) * smoothstep(0.0, 0.06, alt);

  vec3 lowC  = vec3(0.18, 1.5, 0.55);   // O₂ 557.7 nm
  vec3 highC = vec3(1.4, 0.22, 0.45);   // O₂ 630.0 nm
  vec3 edgeC = vec3(0.45, 0.35, 1.6);   // N₂
  vec3 col = mix(lowC, highC, smoothstep(0.15, 0.9, alt));
  col = mix(col, edgeC, smoothstep(0.6, 1.0, rays) * 0.35);

  gl_FragColor = vec4(col * v * uIntensity * 2.2, 1.0);
}
`;

const RAIN_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uTime;
uniform vec3  uViewer;
uniform vec3  uUp;
uniform vec3  uWind;
uniform float uSpan;
uniform float uFall;
uniform float uSize;
attribute vec3 aSeed;
varying float vFade;
void main(){
  // Particles live in a box that follows the camera; each one wraps when it
  // falls out of the bottom, so a few thousand cover an unbounded volume.
  float t = uTime * uFall + aSeed.z * 100.0;
  float h = uSpan - mod(t, uSpan);
  vec3 pos = uViewer
    + aSeed.x * uSpan * 0.5 * normalize(cross(uUp, vec3(0.0, 0.0, 1.0) + vec3(0.001)))
    + aSeed.y * uSpan * 0.5 * normalize(cross(uUp, cross(uUp, vec3(0.0, 0.0, 1.0) + vec3(0.001))))
    + uUp * (h - uSpan * 0.35)
    + uWind * (mod(t, uSpan) * 0.12);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (300.0 / max(1.0, -mv.z));
  vFade = smoothstep(0.0, 0.12, h / uSpan) * (1.0 - smoothstep(0.75, 1.0, h / uSpan));
  #include <logdepthbuf_vertex>
}
`;

const RAIN_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;
void main(){
  #include <logdepthbuf_fragment>
  vec2 d = gl_PointCoord - 0.5;
  // Vertically stretched: a raindrop at speed is a streak, not a dot.
  d.x *= 3.5;
  float a = 1.0 - smoothstep(0.0, 0.5, length(d));
  gl_FragColor = vec4(uColor, a * vFade * uOpacity);
}
`;

export class Weather implements IWeather {
  readonly root = new Group();

  private planet: IPlanet | null = null;
  private viewer = new Vector3();
  private quality: QualityProfile | null = null;
  private time = 0;
  private rng = new Rng(1);

  private aurora: Mesh | null = null;
  private rain: Points | null = null;

  private stateOut: WeatherState = {
    cloudiness: 0.3,
    precipitation: 0,
    precipitationType: 'none',
    wind: new Vector3(1, 0, 0),
    fog: 0.1,
    storm: 0,
    temperature: 288,
    aurora: 0,
  };
  private flash = 0;
  private nextStrike = 6;
  private forced: { type: string; intensity: number; until: number } | null = null;

  attach(planet: IPlanet): void {
    this.dispose();
    this.planet = planet;
    this.rng = new Rng(planet.spec.seed ^ 0x77a1);
    this.buildAurora();
    this.buildRain();
  }

  private buildAurora(): void {
    const p = this.planet!;
    const m = p.spec.magnetosphere;
    if (m < 0.25 || !p.spec.atmosphere.present) return;

    const rIn = p.radius + p.spec.atmosphere.thicknessM * 0.55;
    const thickness = Math.max(40000, p.spec.atmosphere.thicknessM * 0.9);
    const geo = new SphereGeometry(rIn + thickness, 96, 64);
    const mat = new ShaderMaterial({
      vertexShader: AURORA_VERT,
      fragmentShader: AURORA_FRAG,
      uniforms: {
        uTime: new Uniform(0),
        uIntensity: new Uniform(0),
        uRadius: new Uniform(rIn),
        uThickness: new Uniform(thickness),
        uAxis: new Uniform(new Vector3(0, 1, 0)),
        // The oval sits a little inside the magnetic pole; stronger fields
        // push it further toward the equator.
        uOvalLat: new Uniform(Math.cos(0.28 + (1 - m) * 0.35)),
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: BackSide,
      toneMapped: false,
    });
    this.aurora = new Mesh(geo, mat);
    this.aurora.renderOrder = 6;
    this.root.add(this.aurora);
  }

  private buildRain(): void {
    const n = 5000;
    const seeds = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      seeds[i * 3] = this.rng.range(-1, 1);
      seeds[i * 3 + 1] = this.rng.range(-1, 1);
      seeds[i * 3 + 2] = this.rng.next();
    }
    const geo = new BufferGeometry();
    // `position` is unused by the shader but three requires it to size the draw.
    geo.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aSeed', new BufferAttribute(seeds, 3));
    const mat = new ShaderMaterial({
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      uniforms: {
        uTime: new Uniform(0),
        uViewer: new Uniform(new Vector3()),
        uUp: new Uniform(new Vector3(0, 1, 0)),
        uWind: new Uniform(new Vector3()),
        uSpan: new Uniform(60),
        uFall: new Uniform(22),
        uSize: new Uniform(1.4),
        uColor: new Uniform(new Color(0.62, 0.72, 0.86)),
        uOpacity: new Uniform(0),
      },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.rain = new Points(geo, mat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.root.add(this.rain);
  }

  setViewer(localPosition: Vector3): void {
    this.viewer.copy(localPosition);
  }

  state(): WeatherState {
    return this.stateOut;
  }

  force(type: string, intensity: number): void {
    this.forced = { type, intensity, until: this.time + 45 };
  }

  update(dt: number, ctx: SystemContext): void {
    if (!this.planet) return;
    this.time += dt;
    const spec = this.planet.spec;
    const s = this.stateOut;

    const dir = _d.copy(this.viewer).normalize();
    const alt = this.viewer.length() - this.planet.radius;

    /* ---- pressure cells drift; their gradient is the wind ---- */
    const t = this.time * 0.006;
    const cell = fbm3(dir.x * 2.1 + t, dir.y * 2.1, dir.z * 2.1 - t, { octaves: 4 });
    const e = 0.02;
    const gx = fbm3(dir.x * 2.1 + e + t, dir.y * 2.1, dir.z * 2.1 - t, { octaves: 4 }) - cell;
    const gz = fbm3(dir.x * 2.1 + t, dir.y * 2.1, dir.z * 2.1 + e - t, { octaves: 4 }) - cell;

    const up = dir;
    const ref = Math.abs(up.y) > 0.94 ? _a.set(1, 0, 0) : _a.set(0, 1, 0);
    const tx = _b.crossVectors(ref, up).normalize();
    const tz = _c.crossVectors(up, tx).normalize();
    // Geostrophic-ish: wind runs along the isobars, not down the gradient.
    s.wind
      .copy(tx).multiplyScalar(-gz / e)
      .addScaledVector(tz, gx / e)
      .normalize()
      .multiplyScalar(Math.max(0.4, spec.atmosphere.windSpeed * (0.5 + Math.abs(cell))));

    /* ---- humidity and orographic lift ---- */
    const sample = this.planet.sampleSurface(dir);
    const seaR = this.planet.seaLevelRadius();
    const height = this.planet.heightAt(dir);
    // Uphill in the wind direction → air is being lifted → it rains.
    const ahead = _e2.copy(dir).addScaledVector(s.wind, 0.0008 / Math.max(1, s.wind.length())).normalize();
    const lift = saturate((this.planet.heightAt(ahead) - height) / 240);

    const humid = sample.humidity;
    const wet = saturate(humid * 1.1 + lift * 0.9 - 0.25);
    s.cloudiness = saturate(wet * 0.9 + 0.12 + cell * 0.25);
    s.precipitation = spec.atmosphere.present ? saturate((wet - 0.42) * 2.1) : 0;
    s.temperature = spec.tempK - Math.max(0, height) * 0.0065 + (sample.temperature - 0.5) * 26;

    let type = 'none';
    if (s.precipitation > 0.02) {
      if (spec.klass === 'toxic') type = 'acid';
      else if (spec.klass === 'molten') type = 'ash';
      else if (s.temperature < 273) type = 'snow';
      else if (!spec.ocean.present || spec.terrain.duneCoverage > 0.5) type = 'dust';
      else type = 'rain';
    }
    s.precipitationType = type;
    s.fog = saturate(spec.atmosphere.fogDensity * 0.25 + wet * 0.5 + (seaR > 0 && height < 40 ? 0.2 : 0));
    s.storm = saturate((s.precipitation - 0.55) * 2.2);

    if (this.forced) {
      if (this.time > this.forced.until) this.forced = null;
      else {
        s.precipitationType = this.forced.type;
        s.precipitation = this.forced.intensity;
        s.storm = this.forced.type === 'storm' ? this.forced.intensity : s.storm;
      }
    }

    /* ---- aurora ---- */
    const night = saturate(-env.sunDir.dot(dir) * 2.2);
    const latAbs = Math.abs(dir.y);
    s.aurora = spec.magnetosphere > 0.25
      ? saturate(spec.magnetosphere * night * smoothstep(0.45, 0.85, latAbs) * (0.6 + 0.4 * Math.sin(this.time * 0.07)))
      : 0;
    if (this.aurora) {
      const u = (this.aurora.material as ShaderMaterial).uniforms;
      u.uTime.value = this.time;
      u.uIntensity.value = s.aurora;
      this.aurora.visible = s.aurora > 0.01;
    }

    /* ---- lightning ---- */
    this.flash = Math.max(0, this.flash - dt * 5.5);
    if (s.storm > 0.15) {
      this.nextStrike -= dt * (0.4 + s.storm * 2.6);
      if (this.nextStrike <= 0) {
        this.nextStrike = this.rng.range(1.4, 7.0);
        this.flash = this.rng.range(0.6, 1.4);
        const delay = this.rng.range(0.4, 5.5);
        setTimeout(() => ctx.services.audio?.play('thunder', { volume: saturate(1.4 - delay * 0.2) }), delay * 1000);
      }
    }
    env.flash = this.flash;
    env.precipitation = s.precipitation;
    env.precipType = s.precipitationType;
    env.storm = s.storm;
    env.wetness = type === 'rain' ? saturate(s.precipitation * 1.4) : 0;
    env.snow = type === 'snow' ? saturate(s.precipitation) : 0;

    /* ---- precipitation particles ---- */
    if (this.rain) {
      const show = s.precipitation > 0.03 && alt < 4000 && (this.quality?.particleBudget ?? 0) > 0;
      this.rain.visible = show;
      if (show) {
        const u = (this.rain.material as ShaderMaterial).uniforms;
        u.uTime.value = this.time;
        (u.uViewer.value as Vector3).copy(this.viewer);
        (u.uUp.value as Vector3).copy(dir);
        (u.uWind.value as Vector3).copy(s.wind);
        u.uOpacity.value = saturate(s.precipitation) * 0.75;
        if (type === 'snow') {
          u.uFall.value = 2.4;
          u.uSize.value = 2.6;
          (u.uColor.value as Color).setRGB(0.92, 0.95, 1.0);
        } else if (type === 'dust' || type === 'ash') {
          u.uFall.value = 5;
          u.uSize.value = 2.0;
          (u.uColor.value as Color).setRGB(0.55, 0.44, 0.32);
        } else if (type === 'acid') {
          u.uFall.value = 16;
          u.uSize.value = 1.5;
          (u.uColor.value as Color).setRGB(0.62, 0.85, 0.35);
        } else {
          u.uFall.value = 24;
          u.uSize.value = 1.3;
          (u.uColor.value as Color).setRGB(0.62, 0.72, 0.86);
        }
      }
    }
  }

  setQuality(q: QualityProfile): void {
    this.quality = q;
  }

  dispose(): void {
    for (const o of [this.aurora, this.rain] as (Mesh | Points | null)[]) {
      if (!o) continue;
      this.root.remove(o);
      o.geometry.dispose();
      (o.material as ShaderMaterial).dispose();
    }
    this.aurora = null;
    this.rain = null;
  }
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e2 = new Vector3();
