/**
 * Every surface a civilisation makes, authored in shaders.
 *
 * There are no textures in ÆON, so a city's entire visual language — board-
 * formed concrete, gilded stone, chitin, cracked plaster, a hundred thousand
 * lit windows — is computed per fragment from the façade coordinate written
 * into `uv` at build time (metres along the wall, metres above the base) plus
 * five numbers per vertex. That is what lets a megacity draw in a dozen calls.
 *
 * Rules obeyed here, and they are not negotiable:
 *   • log-depth chunks in every stage, or the city z-fights with the planet;
 *   • output is linear radiance, unclamped — a lit window is 6.0, not 1.0, so
 *     bloom has something to bite on;
 *   • no tone mapping, no gamma.
 */

import {
  AdditiveBlending,
  BackSide,
  Color,
  DoubleSide,
  FrontSide,
  ShaderMaterial,
  Texture,
  Vector3,
} from 'three';
import { GLSL_COLOR, GLSL_NOISE } from '../core/Noise';

/* ═══════════════════════════════════════════════════════════════════════════
   Shared chunks
   ═══════════════════════════════════════════════════════════════════════════ */

/** Uniform block every civ material shares, so one setter updates all of them. */
export interface CivLighting {
  sunDir: Vector3;
  sunColor: Color;
  sunIntensity: number;
  skyColor: Color;
  groundColor: Color;
  /** 0 = full day, 1 = full night. Drives every emissive in the city. */
  night: number;
  fogColor: Color;
  fogDensity: number;
  time: number;
  structure: Color;
  neon: Color;
  decay: number;
  /** 0–1 near-field detail fade (interior mapping, fine façade relief). */
  detail: number;
  wetness: number;
}

const LIGHT_UNIFORMS = () => ({
  uSunDir: { value: new Vector3(0.4, 0.8, 0.45).normalize() },
  uSunColor: { value: new Color(1.0, 0.96, 0.9) },
  uSunIntensity: { value: 3.2 },
  uSkyColor: { value: new Color(0.28, 0.42, 0.72) },
  uGroundColor: { value: new Color(0.12, 0.1, 0.09) },
  uNight: { value: 0 },
  uFogColor: { value: new Color(0.42, 0.52, 0.66) },
  uFogDensity: { value: 1 / 9000 },
  uTime: { value: 0 },
  uStructure: { value: new Color(0.32, 0.32, 0.34) },
  uNeon: { value: new Color(0.2, 1.6, 2.4) },
  uDecay: { value: 0.05 },
  uDetail: { value: 1 },
  uWet: { value: 0 },
});

const LIGHT_DECL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uNight;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uTime;
uniform vec3 uStructure;
uniform vec3 uNeon;
uniform float uDecay;
uniform float uDetail;
uniform float uWet;
`;

/**
 * Aerial perspective. Cheap exponential extinction toward the atmosphere tint,
 * warmed toward the sun so that distant towers pick up the haze the way they do
 * in every establishing shot ever filmed.
 */
const FOG_FN = /* glsl */ `
vec3 aeon_aerial(vec3 col, float dist, vec3 viewDir){
  float f = 1.0 - exp(-pow(max(dist,0.0) * uFogDensity, 1.15));
  float sunAmt = max(dot(viewDir, uSunDir), 0.0);
  vec3 haze = uFogColor * mix(1.0, 2.6, pow(sunAmt, 6.0));
  haze *= mix(1.0, 0.10, uNight);
  return mix(col, haze, clamp(f, 0.0, 1.0));
}
`;

/** Hemispheric ambient + a wrapped sun term. No shadow maps; AO is baked. */
const LIGHT_FN = /* glsl */ `
vec3 aeon_light(vec3 N, vec3 up, vec3 albedo, float ao, float rough, vec3 V){
  float ndl = dot(N, uSunDir);
  // Wrapped diffuse: a hard terminator on a plain box reads as a bug, and real
  // façades bounce light around corners.
  float wrap = clamp((ndl + 0.22) / 1.22, 0.0, 1.0);
  vec3 direct = uSunColor * uSunIntensity * wrap;
  float hemi = 0.5 + 0.5 * dot(N, up);
  vec3 amb = mix(uGroundColor, uSkyColor, hemi) * (0.55 + 0.45 * ao);
  vec3 col = albedo * (direct * ao + amb);

  // Specular: one GGX-ish lobe, enough for wet asphalt and glass curtain walls.
  vec3 H = normalize(uSunDir + V);
  float a = max(rough * rough, 0.002);
  float ndh = max(dot(N, H), 0.0);
  float d = a / (3.14159 * pow(ndh * ndh * (a - 1.0) + 1.0, 2.0) + 1e-5);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
  col += uSunColor * uSunIntensity * d * (0.04 + 0.96 * fres) * step(0.0, ndl) * ao;

  // Sky reflection on the same fresnel — glass towers must catch the sky.
  col += uSkyColor * fres * (1.0 - rough) * 0.6 * ao;
  return col;
}
`;

/** Deterministic hash of a window cell. Must be stable frame to frame. */
const HASH_FN = /* glsl */ `
float aeon_h21(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float aeon_h31(vec3 p){
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   CITY MATERIAL — the workhorse
   ═══════════════════════════════════════════════════════════════════════════ */

const CITY_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute vec4 aFacade;   // floorHeight, bayWidth, litProbability, buildingHash
attribute vec4 aInfo;     // styleId, decay, bakedAO, materialFamily

varying vec3 vN;          // world-space normal
varying vec3 vNo;         // object-space normal (object +Z is local up)
varying vec3 vUp;         // world-space local up
varying vec2 vFuv;
varying vec4 vFacade;
varying vec4 vInfo;
varying vec3 vView;       // world-space surface → camera
varying float vDist;
varying vec3 vObj;
varying vec3 vT;
varying vec3 vB;

void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;

  vNo = normal;
  vN = normalize(mat3(modelMatrix) * normal);
  vUp = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
  vFuv = uv;
  vFacade = aFacade;
  vInfo = aInfo;
  vObj = position;
  vView = cameraPosition - wp.xyz;
  vDist = length(mvPosition.xyz);

  // Façade tangent frame: U runs along the wall, V runs up it. Built from the
  // object-space up so window rows stay level even on a tilted mass.
  vec3 upo = vec3(0.0, 0.0, 1.0);
  vec3 t = cross(upo, normal);
  if (length(t) < 1e-3) t = vec3(1.0, 0.0, 0.0);
  t = normalize(t);
  vT = normalize(mat3(modelMatrix) * t);
  vB = normalize(cross(vN, vT));

  #include <logdepthbuf_vertex>
}
`;

const CITY_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}
${GLSL_COLOR}
${LIGHT_DECL}
${HASH_FN}
${FOG_FN}
${LIGHT_FN}

uniform float uInterior;

varying vec3 vN;
varying vec3 vNo;
varying vec3 vUp;
varying vec2 vFuv;
varying vec4 vFacade;
varying vec4 vInfo;
varying vec3 vView;
varying float vDist;
varying vec3 vObj;
varying vec3 vT;
varying vec3 vB;

// --- material families -----------------------------------------------------
const float M_CONCRETE = 0.0;
const float M_METAL    = 1.0;
const float M_GLASS    = 2.0;
const float M_PLASTER  = 3.0;
const float M_TIMBER   = 4.0;
const float M_STONE    = 5.0;
const float M_FABRIC   = 6.0;
const float M_CHITIN   = 7.0;
const float M_CRYSTAL  = 8.0;

float boxMask(vec2 p, vec2 h, float soft){
  vec2 d = abs(p) - h;
  float m = max(d.x, d.y);
  return 1.0 - smoothstep(-soft, soft, m);
}

/**
 * Interior mapping. Trace the view ray into a unit box behind the glass and
 * shade whichever wall it hits. Costs a dozen instructions and turns a flat
 * emissive rectangle into a room someone lives in.
 */
vec3 roomColor(vec2 cell, vec3 rdT, float seed, vec3 warm){
  vec3 ro = vec3(cell * 2.0 - 1.0, 1.0);
  vec3 rd = normalize(vec3(rdT.x, rdT.y, -abs(rdT.z) - 0.35));
  vec3 inv = 1.0 / rd;
  vec3 k = (sign(rd) - ro) * inv;
  float t = min(min(k.x, k.y), k.z);
  vec3 hit = ro + rd * t;

  float back = step(abs(hit.z + 1.0), 0.02);
  float floorH = step(hit.y, -0.94);
  float ceil = step(0.94, hit.y);

  vec3 c = warm * 0.55;
  c = mix(c, warm * 0.30, back);
  c = mix(c, warm * 0.85, floorH);
  c = mix(c, warm * 1.6, ceil);          // the lamp is on the ceiling
  // Furniture silhouettes: dark blocks standing on the floor plane.
  float f = aeon_h31(vec3(floor(hit.xz * 2.5), seed * 91.0));
  float sil = step(0.55, f) * step(hit.y, -0.25 + f * 0.4);
  c *= mix(1.0, 0.18, sil);
  // Depth falloff so deep rooms go dark, which is what sells the parallax.
  c *= mix(1.0, 0.45, clamp(-hit.z * 0.5 + 0.5, 0.0, 1.0));
  return c;
}

void main(){
  #include <logdepthbuf_fragment>

  float styleId = vInfo.x;
  float decay   = clamp(vInfo.y + uDecay, 0.0, 1.0);
  float ao      = clamp(vInfo.z, 0.0, 1.0);
  float matId   = vInfo.w;
  float floorH  = max(vFacade.x, 0.35);
  float bayW    = max(vFacade.y, 0.35);
  float litP    = vFacade.z;
  float bseed   = vFacade.w;

  vec3 V = normalize(vView);
  vec3 N = normalize(vN);
  float upness = vNo.z;              // object-space: +1 roof, -1 soffit, 0 wall
  float wallness = 1.0 - smoothstep(0.45, 0.72, abs(upness));

  // ── base albedo per material family ───────────────────────────────────────
  vec3 base = uStructure;
  float rough = 0.85;
  float hueJit = (aeon_h21(vec2(bseed * 37.0, 11.0)) - 0.5);
  base *= 1.0 + hueJit * 0.30;

  vec3 wpos = vObj * 0.5;
  float grain = fbm(wpos * 0.35 + bseed * 13.0, 4);

  if (matId < M_METAL + 0.5 && matId > M_CONCRETE + 0.5){
    base = mix(uStructure, vec3(0.52, 0.55, 0.58), 0.6) * (0.9 + 0.2 * grain);
    rough = 0.35 + 0.3 * decay;
  } else if (matId < M_GLASS + 0.5 && matId > M_METAL + 0.5){
    base = mix(uStructure * 0.5, vec3(0.05, 0.08, 0.11), 0.7);
    rough = 0.06 + 0.25 * decay;
  } else if (matId < M_PLASTER + 0.5 && matId > M_GLASS + 0.5){
    base = mix(uStructure, vec3(0.72, 0.66, 0.56), 0.55) * (0.92 + 0.16 * grain);
    rough = 0.9;
  } else if (matId < M_TIMBER + 0.5 && matId > M_PLASTER + 0.5){
    // Plank banding along the façade — Ghibli warmth lives in this line.
    float plank = fract(vFuv.y * 3.1 + aeon_h21(vec2(floor(vFuv.x * 1.7), bseed)) * 0.4);
    base = mix(vec3(0.20, 0.12, 0.07), vec3(0.36, 0.24, 0.14), 0.35 + 0.6 * grain);
    base *= 0.82 + 0.28 * smoothstep(0.02, 0.10, plank) * smoothstep(1.0, 0.9, plank);
    rough = 0.82;
  } else if (matId < M_STONE + 0.5 && matId > M_TIMBER + 0.5){
    float course = fract(vFuv.y * 1.35);
    float ashlar = fract(vFuv.x * 0.55 + step(0.5, course) * 0.5);
    base = mix(uStructure, vec3(0.62, 0.57, 0.47), 0.5) * (0.9 + 0.18 * grain);
    base *= 1.0 - 0.30 * (1.0 - smoothstep(0.0, 0.035, min(course, 1.0 - course)));
    base *= 1.0 - 0.22 * (1.0 - smoothstep(0.0, 0.03, min(ashlar, 1.0 - ashlar)));
    rough = 0.78;
  } else if (matId < M_FABRIC + 0.5 && matId > M_STONE + 0.5){
    float weave = sin(vFuv.x * 22.0) * sin(vFuv.y * 22.0);
    base = mix(uStructure, vec3(0.78, 0.68, 0.50), 0.7) * (0.95 + 0.1 * weave);
    rough = 0.95;
  } else if (matId < M_CHITIN + 0.5 && matId > M_FABRIC + 0.5){
    vec2 w = worley(wpos * 0.9 + bseed, 1.0);
    base = mix(vec3(0.10, 0.07, 0.05), vec3(0.28, 0.19, 0.11), smoothstep(0.0, 0.5, w.y - w.x));
    base += uNeon * 0.02 * smoothstep(0.45, 0.05, w.y - w.x);
    rough = 0.45;
  } else if (matId > M_CHITIN + 0.5){
    // Crystal: refraction faked with a strong fresnel and an internal glow.
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    base = mix(uStructure * 0.55, uStructure * 1.6, fres);
    rough = 0.08;
  } else {
    // Concrete: board-forming, the single most legible brutalist cue.
    float board = fract(vFuv.y * 0.55);
    float tie = aeon_h21(floor(vec2(vFuv.x * 0.55, vFuv.y * 0.55)));
    base *= 0.93 + 0.14 * smoothstep(0.0, 0.06, board) * smoothstep(1.0, 0.94, board);
    base *= 0.97 + 0.06 * grain;
    base *= 1.0 - 0.10 * step(0.93, tie);
    rough = 0.88;
  }

  // ── weathering: rain streaks, base grime, patina in the crevices ─────────
  float streak = fbm(vec3(vFuv.x * 0.55, vFuv.y * 0.035, bseed * 7.0), 3);
  float streakM = smoothstep(0.15, 0.75, streak) * wallness * (0.25 + 0.75 * decay);
  base *= 1.0 - 0.32 * streakM;
  base *= 1.0 - 0.30 * smoothstep(4.5, 0.0, vFuv.y) * (0.35 + 0.65 * decay);

  // Cracks and missing render, scaled by how ruined this civilisation is.
  vec2 cw = worley(vec3(vFuv * 0.09, bseed * 3.0), 1.0);
  float crack = 1.0 - smoothstep(0.0, 0.035 + 0.05 * decay, cw.y - cw.x);
  base *= 1.0 - 0.55 * crack * decay;
  float spall = smoothstep(0.55 - 0.35 * decay, 0.85, fbm(vec3(vFuv * 0.12, bseed * 21.0), 4));
  base = mix(base, base * vec3(0.65, 0.60, 0.55), spall * decay);

  // ── façade openings ──────────────────────────────────────────────────────
  float emissiveMul = 0.0;
  vec3 emissive = vec3(0.0);
  float glassMask = 0.0;

  if (wallness > 0.01 && vFuv.y > 0.05){
    float fy = vFuv.y / floorH;
    float fx = vFuv.x / bayW;
    float fi = floor(fy);
    float bi = floor(fx);
    vec2 cell = vec2(fract(fx), fract(fy));

    // Window proportions per architectural language.
    vec2 half = vec2(0.30, 0.30);
    float soft = 0.045;
    float shape = 0.0;                       // 0 rect, 1 arch, 2 round
    if (styleId < 0.5){ half = vec2(0.40, 0.16); }                       // brutalist slit
    else if (styleId < 1.5){ half = vec2(0.17, 0.20); shape = 1.0; }     // organic
    else if (styleId < 2.5){ half = vec2(0.46, 0.44); }                  // crystalline
    else if (styleId < 3.5){ half = vec2(0.42, 0.22); }                  // arcology
    else if (styleId < 4.5){ half = vec2(0.14, 0.12); }                  // nomadic
    else if (styleId < 5.5){ half = vec2(0.22, 0.22); shape = 2.0; }     // hive
    else if (styleId < 6.5){ half = vec2(0.16, 0.30); shape = 1.0; }     // baroque
    else { half = vec2(0.26, 0.26); }                                    // ruins

    vec2 q = cell - 0.5;
    float win = boxMask(q, half, soft);
    if (shape > 0.5 && shape < 1.5){
      // Arched head: box below the spring line, circle above it.
      float body = boxMask(vec2(q.x, min(q.y, 0.0)), half, soft);
      float arch = 1.0 - smoothstep(half.x - soft, half.x + soft, length(vec2(q.x, max(q.y, 0.0) * (half.x / half.y))));
      win = max(body, arch * step(0.0, q.y));
    } else if (shape > 1.5){
      win = 1.0 - smoothstep(half.x - soft, half.x + soft, length(q * vec2(1.0, half.x / half.y)));
    }

    // Mullions inside big glass panels.
    if (styleId > 1.5 && styleId < 2.5){
      float mull = step(0.02, abs(fract(fx * 2.0) - 0.5) - 0.46);
      win *= 1.0 - mull * 0.5;
    }

    float wh = aeon_h31(vec3(bi, fi, bseed * 101.0));
    float blown = step(0.86 - 0.5 * decay, aeon_h31(vec3(bi, fi, bseed * 57.0))) * decay;

    // Reveal: the window sits back in the wall, so it self-shadows.
    base *= 1.0 - 0.55 * win;
    base = mix(base, base * 0.35, blown * win);
    glassMask = win * (1.0 - blown);

    // Sills and lintels — a horizontal line every floor is what makes a
    // building read as a building at 400 m.
    float band = 1.0 - smoothstep(0.0, 0.035, abs(cell.y - 0.03));
    base *= 1.0 - 0.18 * band * wallness;

    // Night: individual rooms, warm, hashed, a few flickering, some neon.
    float lit = step(wh, litP) * (1.0 - blown);
    float warmH = aeon_h31(vec3(bi, fi, bseed * 7.0));
    vec3 warm = mix(vec3(1.00, 0.62, 0.28), vec3(1.00, 0.86, 0.62), warmH);
    if (warmH > 0.86) warm = mix(warm, uNeon, 0.85);
    if (warmH < 0.08) warm = mix(warm, vec3(0.55, 0.85, 1.0), 0.8);      // cold office
    float flick = 1.0;
    if (aeon_h31(vec3(bi, fi, bseed * 3.0)) > 0.955){
      flick = 0.45 + 0.55 * step(0.42, fract(sin(uTime * (2.5 + 7.0 * warmH) + wh * 40.0) * 43758.5453));
    }
    float bright = (1.6 + 4.2 * warmH) * flick;

    vec3 roomLit = warm;
    if (uInterior > 0.5 && uDetail > 0.35){
      vec3 rdT = vec3(dot(-V, vT), dot(-V, vB), dot(-V, N));
      roomLit = roomColor(cell, rdT, bseed + fi * 0.37 + bi * 0.11, warm);
      roomLit *= 2.0;
    }
    emissive += roomLit * bright * win * lit * uNight;

    // Daylight: glass is a mirror of the sky, not a hole.
    vec3 skyRefl = uSkyColor * (0.9 + 0.6 * aeon_h31(vec3(bi, fi, 3.0)));
    base = mix(base, skyRefl * 0.5, win * (1.0 - uNight) * (1.0 - blown) * 0.85);
    rough = mix(rough, 0.05, glassMask);
  }

  // ── roofs ────────────────────────────────────────────────────────────────
  if (upness > 0.55){
    float r = fbm(vObj * 0.25 + 4.0, 4);
    base = mix(base, base * vec3(0.72, 0.72, 0.70), 0.55 + 0.35 * r);
    // Rooftop plant: blocky vents and units, drawn not modelled.
    float cellv = step(0.62, aeon_h21(floor(vObj.xy * 0.22 + bseed * 5.0)));
    base = mix(base, base * 1.35, cellv * 0.5);
    // Puddles. Wet roofs at night are half of why Blade Runner looks like that.
    float pud = smoothstep(0.55, 0.75, fbm(vObj * 0.12 + 9.0, 3)) * uWet;
    rough = mix(rough, 0.03, pud);
    base = mix(base, base * 0.35, pud);
  }

  // ── shading ──────────────────────────────────────────────────────────────
  vec3 col = aeon_light(N, normalize(vUp), base, ao, rough, V);

  // Ambient street glow: cities light themselves from below at night.
  col += uNeon * 0.045 * uNight * ao * smoothstep(28.0, 0.0, vFuv.y) * wallness;
  col += emissive;

  col = aeon_aerial(col, vDist, -V);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function makeCityMaterial(): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: { ...LIGHT_UNIFORMS(), uInterior: { value: 1 } },
    vertexShader: CITY_VERT,
    fragmentShader: CITY_FRAG,
    side: FrontSide,
  });
  m.name = 'civ-city';
  return m;
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUND — plazas, aprons, quarry floors, farm fields
   ═══════════════════════════════════════════════════════════════════════════ */

const GROUND_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}
${LIGHT_DECL}
${HASH_FN}
${FOG_FN}
${LIGHT_FN}

varying vec3 vN;
varying vec3 vUp;
varying vec2 vFuv;
varying vec4 vFacade;
varying vec4 vInfo;
varying vec3 vView;
varying float vDist;
varying vec3 vObj;

void main(){
  #include <logdepthbuf_fragment>
  float kind = vInfo.w;      // 0 paving, 1 field, 2 yard, 3 water/dock, 4 pad
  float decay = clamp(vInfo.y + uDecay, 0.0, 1.0);
  float ao = clamp(vInfo.z, 0.0, 1.0);
  float seed = vFacade.w;

  vec3 V = normalize(vView);
  vec3 N = normalize(vN);
  vec3 base;
  float rough = 0.9;
  vec3 emis = vec3(0.0);

  if (kind < 0.5){
    // Paving: slabs with joints, worn along the desire lines.
    vec2 g = vFuv / max(vFacade.x, 0.8);
    vec2 c = abs(fract(g) - 0.5);
    float joint = 1.0 - smoothstep(0.44, 0.49, max(c.x, c.y));
    float tone = aeon_h21(floor(g) + seed);
    base = mix(uStructure * 0.85, uStructure * 1.15, tone);
    base *= 0.62 + 0.38 * joint;
    base *= 0.85 + 0.3 * fbm(vObj * 0.4, 3);
  } else if (kind < 1.5){
    // Farmland: crop rows at a per-field angle. From the air this reads as
    // a quilt, which is exactly the "someone lives here" cue we want.
    float ang = vFacade.x;
    vec2 r = vec2(cos(ang), sin(ang));
    float row = sin(dot(vFuv, r) * 1.9);
    float hue = aeon_h21(vec2(seed * 31.0, 3.0));
    vec3 cropA = vec3(0.10, 0.24, 0.06);
    vec3 cropB = vec3(0.32, 0.30, 0.08);
    vec3 fallow = vec3(0.20, 0.14, 0.09);
    base = mix(cropA, cropB, hue);
    base = mix(base, fallow, step(0.78, hue));
    base *= 0.78 + 0.30 * smoothstep(-0.2, 0.8, row);
    base *= 0.9 + 0.2 * fbm(vObj * 0.06, 3);
    rough = 0.95;
  } else if (kind < 2.5){
    base = mix(uStructure * 0.7, vec3(0.18, 0.16, 0.14), 0.5);
    base *= 0.8 + 0.4 * fbm(vObj * 0.3, 4);
    float oil = smoothstep(0.6, 0.8, fbm(vObj * 0.15 + 2.0, 3));
    base = mix(base, base * 0.4, oil);
    rough = mix(0.9, 0.25, oil * uWet);
  } else if (kind < 3.5){
    base = vec3(0.02, 0.05, 0.07);
    rough = 0.04;
  } else {
    // Landing pad: concrete with a painted circle and perimeter strobes.
    float rr = length(vFuv);
    base = uStructure * 0.7;
    float ring = 1.0 - smoothstep(0.02, 0.05, abs(rr - vFacade.x * 0.72));
    base = mix(base, vec3(0.9, 0.75, 0.15), ring * 0.8);
    float ang = atan(vFuv.y, vFuv.x);
    float strobe = step(0.85, fract(ang / 6.2831 * 12.0 + uTime * 0.35));
    float edge = 1.0 - smoothstep(0.01, 0.04, abs(rr - vFacade.x * 0.95));
    emis += mix(uNeon, vec3(1.6, 0.4, 0.2), 0.3) * edge * strobe * (2.5 + 3.0 * uNight);
    rough = 0.5;
  }

  base *= 1.0 - 0.35 * decay * smoothstep(0.4, 0.9, fbm(vObj * 0.2 + 7.0, 3));

  vec3 col = aeon_light(N, normalize(vUp), base, ao, rough, V);
  col += emis;
  col = aeon_aerial(col, vDist, -V);
  gl_FragColor = vec4(col, 1.0);
}
`;

const SIMPLE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aFacade;
attribute vec4 aInfo;
varying vec3 vN;
varying vec3 vUp;
varying vec2 vFuv;
varying vec4 vFacade;
varying vec4 vInfo;
varying vec3 vView;
varying float vDist;
varying vec3 vObj;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  vN = normalize(mat3(modelMatrix) * normal);
  vUp = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
  vFuv = uv;
  vFacade = aFacade;
  vInfo = aInfo;
  vObj = position;
  vView = cameraPosition - wp.xyz;
  vDist = length(mvPosition.xyz);
  #include <logdepthbuf_vertex>
}
`;

export function makeGroundMaterial(): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: LIGHT_UNIFORMS(),
    vertexShader: SIMPLE_VERT,
    fragmentShader: GROUND_FRAG,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  m.name = 'civ-ground';
  return m;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ROADS
   ═══════════════════════════════════════════════════════════════════════════ */

const ROAD_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}
${LIGHT_DECL}
${HASH_FN}
${FOG_FN}
${LIGHT_FN}

varying vec3 vN;
varying vec3 vUp;
varying vec2 vFuv;    // x = across in [-1,1], y = metres along
varying vec4 vFacade; // x = half width, y = tech level, z = 0, w = seed
varying vec4 vInfo;   // x = 0, y = decay, z = ao, w = kind (0 road, 1 rail, 2 bridge)
varying vec3 vView;
varying float vDist;
varying vec3 vObj;

void main(){
  #include <logdepthbuf_fragment>
  float across = vFuv.x;
  float along = vFuv.y;
  float decay = clamp(vInfo.y + uDecay, 0.0, 1.0);
  float tech = vFacade.y;
  float ao = clamp(vInfo.z, 0.0, 1.0);

  vec3 V = normalize(vView);
  vec3 N = normalize(vN);

  // Surface: asphalt on high-tech worlds, packed stone on low.
  vec3 asphalt = mix(vec3(0.055, 0.055, 0.060), vec3(0.16, 0.13, 0.10), 1.0 - tech);
  float g = fbm(vObj * 1.7, 4);
  vec3 base = asphalt * (0.8 + 0.45 * g);

  // Wheel polish, then shoulders that fade into dirt.
  float lane = smoothstep(0.75, 0.45, abs(abs(across) - 0.42));
  base *= 1.0 + 0.18 * lane;
  float shoulder = smoothstep(0.72, 1.0, abs(across));
  base = mix(base, mix(vec3(0.16, 0.13, 0.09), uStructure * 0.5, 0.4), shoulder);

  // Markings: dashed centre line, solid edges. Faded by decay.
  float centre = 1.0 - smoothstep(0.012, 0.03, abs(across));
  float dash = step(0.45, fract(along * 0.09));
  float edge = 1.0 - smoothstep(0.02, 0.05, abs(abs(across) - 0.86));
  float paint = max(centre * dash, edge) * (1.0 - decay * 0.85) * step(0.35, tech);
  base = mix(base, vec3(0.55, 0.50, 0.30), paint * 0.8);

  // Cracks and reclamation.
  vec2 w = worley(vec3(vObj.xy * 0.35, vFacade.w), 1.0);
  float crack = 1.0 - smoothstep(0.0, 0.03 + 0.06 * decay, w.y - w.x);
  base *= 1.0 - 0.6 * crack * decay;
  float weed = smoothstep(0.62, 0.9, fbm(vObj * 0.5 + 3.0, 3)) * decay;
  base = mix(base, vec3(0.07, 0.13, 0.045), weed * 0.8);

  float rough = mix(0.85, 0.06, uWet * (1.0 - shoulder));
  vec3 col = aeon_light(N, normalize(vUp), base, ao, rough, V);

  // Guidance strips: at night a high-tech road is a light source.
  float strip = 1.0 - smoothstep(0.015, 0.04, abs(abs(across) - 0.93));
  col += uNeon * strip * uNight * tech * 1.4;

  col = aeon_aerial(col, vDist, -V);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function makeRoadMaterial(): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: LIGHT_UNIFORMS(),
    vertexShader: SIMPLE_VERT,
    fragmentShader: ROAD_FRAG,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  m.name = 'civ-road';
  return m;
}

/* ═══════════════════════════════════════════════════════════════════════════
   TRAFFIC — instanced, animated entirely on the GPU
   ═══════════════════════════════════════════════════════════════════════════ */

const TRAFFIC_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${HASH_FN}

attribute vec3 aA;      // lane start (object space)
attribute vec3 aB;      // lane end
attribute vec4 aLane;   // arc height, phase, speed, jitter
attribute vec3 aTint;
attribute float aPart;  // 0 body, 1 headlight, 2 taillight, 3 glow

uniform float uTime;
uniform float uNight;

varying vec3 vN;
varying vec3 vTint;
varying float vPart;
varying float vDist;
varying vec3 vView;
varying vec2 vUvL;

void main(){
  float t = fract(aLane.y + uTime * aLane.z);
  vec3 A = aA;
  vec3 B = aB;
  vec3 dir = B - A;
  float arc = aLane.x;

  vec3 p = A + dir * t;
  p.z += arc * 4.0 * t * (1.0 - t);
  // Lateral jitter keeps a lane from looking like a conveyor belt.
  vec3 fwd = normalize(dir + vec3(0.0, 0.0, arc * 4.0 * (1.0 - 2.0 * t)));
  vec3 side = normalize(cross(vec3(0.0, 0.0, 1.0), fwd) + vec3(1e-5));
  vec3 up = cross(fwd, side);
  p += side * aLane.w;

  // Gentle bank on the arc, so flying traffic has weight.
  float bank = arc * 0.02 * (1.0 - 2.0 * t);
  side = normalize(side + up * bank);
  up = cross(fwd, side);

  vec3 local = position;
  vec3 wpos = p + side * local.x + up * local.z + fwd * local.y;

  vec4 wp = modelMatrix * vec4(wpos, 1.0);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;

  vec3 nWorld = normalize(mat3(modelMatrix) * (side * normal.x + up * normal.z + fwd * normal.y));
  vN = nWorld;
  vTint = aTint;
  vPart = aPart;
  vUvL = uv;
  vView = cameraPosition - wp.xyz;
  vDist = length(mvPosition.xyz);
  #include <logdepthbuf_vertex>
}
`;

const TRAFFIC_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${LIGHT_DECL}
${FOG_FN}
${LIGHT_FN}

varying vec3 vN;
varying vec3 vTint;
varying float vPart;
varying float vDist;
varying vec3 vView;
varying vec2 vUvL;

void main(){
  #include <logdepthbuf_fragment>
  vec3 V = normalize(vView);
  vec3 N = normalize(vN);
  vec3 col;
  if (vPart < 0.5){
    col = aeon_light(N, vec3(0.0, 1.0, 0.0), vTint * 0.35, 1.0, 0.25, V);
    // Running lights along the flank, always on — reads at any distance.
    col += vTint * 0.6 * uNight;
  } else if (vPart < 1.5){
    float d = 1.0 - smoothstep(0.0, 0.55, length(vUvL - 0.5));
    col = vec3(1.0, 0.95, 0.86) * d * (2.5 + 18.0 * uNight);
  } else if (vPart < 2.5){
    float d = 1.0 - smoothstep(0.0, 0.55, length(vUvL - 0.5));
    col = vec3(1.0, 0.10, 0.04) * d * (1.5 + 9.0 * uNight);
  } else {
    float d = 1.0 - smoothstep(0.0, 0.5, length(vUvL - 0.5));
    col = vTint * d * (0.8 + 6.0 * uNight);
  }
  col = aeon_aerial(col, vDist, -V);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function makeTrafficMaterial(): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: LIGHT_UNIFORMS(),
    vertexShader: TRAFFIC_VERT,
    fragmentShader: TRAFFIC_FRAG,
    side: DoubleSide,
  });
  m.name = 'civ-traffic';
  return m;
}

/* ═══════════════════════════════════════════════════════════════════════════
   HOLOGRAMS AND ENERGY — additive, alien script, searchlights
   ═══════════════════════════════════════════════════════════════════════════ */

const HOLO_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aFacade;   // x scroll speed, y glyph row, z brightness, w seed
attribute vec4 aInfo;     // x kind (0 sign, 1 beam, 2 field, 3 ring), y decay, z ao, w -
varying vec2 vFuv;
varying vec4 vFacade;
varying vec4 vInfo;
varying float vDist;
varying vec3 vView;
varying vec3 vN;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  vFuv = uv;
  vFacade = aFacade;
  vInfo = aInfo;
  vN = normalize(mat3(modelMatrix) * normal);
  vView = cameraPosition - wp.xyz;
  vDist = length(mvPosition.xyz);
  #include <logdepthbuf_vertex>
}
`;

const HOLO_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}
${LIGHT_DECL}
${HASH_FN}

uniform sampler2D uGlyphs;

varying vec2 vFuv;
varying vec4 vFacade;
varying vec4 vInfo;
varying float vDist;
varying vec3 vView;
varying vec3 vN;

void main(){
  #include <logdepthbuf_fragment>
  float kind = vInfo.x;
  float seed = vFacade.w;
  vec3 V = normalize(vView);
  vec3 col = vec3(0.0);
  float alpha = 1.0;

  if (kind < 0.5){
    // Signage: a marquee of procedural glyphs scrolling in an alien script.
    vec2 uv = vFuv;
    float scroll = uTime * vFacade.x;
    float cols = 8.0;
    float gx = uv.x * cols + scroll;
    float gi = floor(gx);
    vec2 cell = vec2(fract(gx), uv.y);
    float row = floor(mod(vFacade.y + aeon_h21(vec2(gi, seed)) * 8.0, 8.0));
    float colIdx = floor(aeon_h21(vec2(gi * 3.1, seed * 7.0)) * 8.0);
    vec2 auv = (vec2(colIdx, row) + clamp(cell, 0.02, 0.98)) / 8.0;
    float g = texture2D(uGlyphs, auv).r;
    vec3 tint = mix(uNeon, vec3(1.0, 0.35, 0.15), step(0.6, aeon_h21(vec2(seed, 9.0))));
    float pulse = 0.75 + 0.25 * sin(uTime * 2.3 + seed * 30.0);
    // Occasional dead tube — perfect signage looks fake.
    float dead = step(0.93, aeon_h21(vec2(gi * 13.0, seed))) * step(0.5, fract(uTime * 0.7));
    col = tint * g * vFacade.z * pulse * (1.0 - dead) * (0.35 + 2.2 * uNight);
    alpha = g * (1.0 - dead);
  } else if (kind < 1.5){
    // Searchlight / beam: soft-edged cone, brighter toward the source.
    float radial = 1.0 - smoothstep(0.0, 1.0, abs(vFuv.x * 2.0 - 1.0));
    float fall = pow(1.0 - vFuv.y, 1.6);
    float haze = 0.6 + 0.4 * fbm(vec3(vFuv * 6.0, uTime * 0.15), 3);
    col = mix(uNeon, vec3(1.0), 0.4) * radial * fall * haze * vFacade.z * (0.2 + 1.6 * uNight);
    alpha = radial * fall;
  } else if (kind < 2.5){
    // Containment field: fresnel shell with a scanning band.
    float fres = pow(1.0 - abs(dot(normalize(vN), V)), 2.0);
    float scan = 0.5 + 0.5 * sin(vFuv.y * 30.0 - uTime * 2.0);
    col = uNeon * (fres * 1.4 + scan * 0.15) * vFacade.z;
    alpha = fres * 0.9 + 0.05;
  } else {
    // Energy ring / halo.
    float r = abs(vFuv.y - 0.5) * 2.0;
    float band = 1.0 - smoothstep(0.0, 1.0, r);
    float flow = 0.6 + 0.4 * sin(vFuv.x * 40.0 - uTime * 3.0);
    col = uNeon * band * flow * vFacade.z * 2.0;
    alpha = band;
  }

  // Holograms fade out in daylight rather than vanishing.
  float far = 1.0 - smoothstep(2000.0, 9000.0, vDist);
  gl_FragColor = vec4(col * far, clamp(alpha * far, 0.0, 1.0));
}
`;

export function makeHoloMaterial(glyphs: Texture): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: { ...LIGHT_UNIFORMS(), uGlyphs: { value: glyphs } },
    vertexShader: HOLO_VERT,
    fragmentShader: HOLO_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
  m.name = 'civ-holo';
  return m;
}

/* ═══════════════════════════════════════════════════════════════════════════
   NIGHT LIGHTS — the view from orbit
   ═══════════════════════════════════════════════════════════════════════════ */

const LIGHTS_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aSize;
attribute vec3 aTint;
attribute float aSeed;
uniform float uNight;
uniform float uTime;
uniform float uPixelScale;
varying vec3 vTint;
varying float vFade;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  float d = length(mvPosition.xyz);
  // Angular size with a floor, so a distant city is still a visible spark.
  float px = clamp(aSize / max(d, 1.0) * uPixelScale, 1.5, 96.0);
  gl_PointSize = px;
  float twinkle = 0.85 + 0.15 * sin(uTime * 1.7 + aSeed * 40.0);
  vFade = uNight * twinkle * smoothstep(120.0, 900.0, d);
  vTint = aTint;
  #include <logdepthbuf_vertex>
}
`;

const LIGHTS_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vTint;
varying float vFade;
void main(){
  #include <logdepthbuf_fragment>
  vec2 q = gl_PointCoord - 0.5;
  float r = length(q);
  if (r > 0.5) discard;
  // Tight core plus a wide halo: that is what a city looks like from orbit.
  float core = exp(-r * r * 34.0);
  float halo = exp(-r * r * 5.0) * 0.35;
  vec3 col = vTint * (core * 4.5 + halo) * vFade;
  gl_FragColor = vec4(col, 1.0);
}
`;

export function makeLightsMaterial(): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: {
      uNight: { value: 0 },
      uTime: { value: 0 },
      uPixelScale: { value: 900 },
    },
    vertexShader: LIGHTS_VERT,
    fragmentShader: LIGHTS_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  m.name = 'civ-lights';
  return m;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ATMOSPHERIC GLOW over a city, and the space-elevator ribbon
   ═══════════════════════════════════════════════════════════════════════════ */

const RIBBON_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vFuv;
varying float vDist;
varying vec3 vN;
varying vec3 vView;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  vFuv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vView = cameraPosition - wp.xyz;
  vDist = length(mvPosition.xyz);
  #include <logdepthbuf_vertex>
}
`;

const RIBBON_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}
${LIGHT_DECL}
${HASH_FN}
${FOG_FN}
${LIGHT_FN}
varying vec2 vFuv;
varying float vDist;
varying vec3 vN;
varying vec3 vView;
void main(){
  #include <logdepthbuf_fragment>
  vec3 V = normalize(vView);
  vec3 N = normalize(vN);
  // Structural ribbon: dark composite with running climber beacons.
  vec3 base = mix(vec3(0.06, 0.065, 0.075), uStructure * 0.5, 0.4);
  float rib = smoothstep(0.42, 0.5, abs(vFuv.x - 0.5));
  base *= 0.7 + 0.6 * rib;
  vec3 col = aeon_light(N, vec3(0.0, 1.0, 0.0), base, 1.0, 0.4, V);

  // Beacons climbing the tether. You can watch one for a minute.
  float beacon = 0.0;
  for (int i = 0; i < 3; i++){
    float ph = fract(uTime * (0.006 + float(i) * 0.0021) + float(i) * 0.37);
    beacon += smoothstep(0.004, 0.0, abs(vFuv.y - ph));
  }
  col += uNeon * beacon * 6.0;
  // Guide strips run the whole length, so it reads at night from the ground.
  col += uNeon * 0.5 * (0.35 + 0.65 * uNight) * (1.0 - rib);

  col = aeon_aerial(col, vDist * 0.35, -V);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function makeRibbonMaterial(): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: LIGHT_UNIFORMS(),
    vertexShader: RIBBON_VERT,
    fragmentShader: RIBBON_FRAG,
    side: DoubleSide,
  });
  m.name = 'civ-ribbon';
  return m;
}

const GLOW_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}
${LIGHT_DECL}
varying vec2 vFuv;
varying float vDist;
varying vec3 vN;
varying vec3 vView;
void main(){
  #include <logdepthbuf_fragment>
  // Sodium-orange light pollution dome. Half the reason a city at night feels
  // like a city and not a model on a table.
  float r = length(vFuv - 0.5) * 2.0;
  float d = pow(clamp(1.0 - r, 0.0, 1.0), 2.2);
  float turb = 0.7 + 0.3 * fbm(vec3(vFuv * 4.0, uTime * 0.02), 3);
  vec3 col = mix(vec3(1.0, 0.52, 0.20), uNeon, 0.25) * d * turb * uNight * 0.85;
  gl_FragColor = vec4(col, d * uNight);
}
`;

export function makeGlowMaterial(): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: LIGHT_UNIFORMS(),
    vertexShader: RIBBON_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: BackSide,
  });
  m.name = 'civ-glow';
  return m;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Uniform broadcasting
   ═══════════════════════════════════════════════════════════════════════════ */

/** Push the shared lighting state into every civ material in one pass. */
export function applyLighting(mats: ShaderMaterial[], L: CivLighting): void {
  for (const m of mats) {
    const u = m.uniforms;
    if (!u) continue;
    if (u.uSunDir) u.uSunDir.value.copy(L.sunDir);
    if (u.uSunColor) u.uSunColor.value.copy(L.sunColor);
    if (u.uSunIntensity) u.uSunIntensity.value = L.sunIntensity;
    if (u.uSkyColor) u.uSkyColor.value.copy(L.skyColor);
    if (u.uGroundColor) u.uGroundColor.value.copy(L.groundColor);
    if (u.uNight) u.uNight.value = L.night;
    if (u.uFogColor) u.uFogColor.value.copy(L.fogColor);
    if (u.uFogDensity) u.uFogDensity.value = L.fogDensity;
    if (u.uTime) u.uTime.value = L.time;
    if (u.uStructure) u.uStructure.value.copy(L.structure);
    if (u.uNeon) u.uNeon.value.copy(L.neon);
    if (u.uDecay) u.uDecay.value = L.decay;
    if (u.uDetail) u.uDetail.value = L.detail;
    if (u.uWet) u.uWet.value = L.wetness;
  }
}
