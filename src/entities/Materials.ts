/**
 * Procedural materials for everything the player wears, drives and flies.
 *
 * There are no textures in ÆON and there never will be, so every surface story
 * — the panel lines on a suit, the sky caught in a visor, the scuffs a rover
 * earns from a bad landing — is authored in the shader. All of these are
 * `MeshStandardMaterial`/`MeshPhysicalMaterial` with `onBeforeCompile` grafts
 * rather than raw `ShaderMaterial`, so they keep three's lighting, shadows,
 * fog and *log depth* handling for free. The handful of genuinely custom
 * shaders here (flames, dust) paste the log-depth chunks explicitly, because
 * `logarithmicDepthBuffer` is on and without them they z-fight into oblivion.
 *
 * Output is linear HDR. Engine cores are 12.0, not 1.0; the post chain owns
 * exposure and tone mapping.
 */

import {
  AdditiveBlending,
  BackSide,
  Color,
  DoubleSide,
  Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Object3D,
  ShaderMaterial,
  Vector3,
} from 'three';
import { GLSL_NOISE } from '../core/Noise';
import type { Rng } from '../core/Rand';

/** Uniforms we keep a handle on so gameplay can drive them per frame. */
export interface LiveUniforms {
  [k: string]: { value: any };
}

/** Anything created here stashes its live uniforms in `userData.u`. */
export function uniformsOf(m: Material): LiveUniforms {
  return (m.userData.u ?? (m.userData.u = {})) as LiveUniforms;
}

/* ── shared GLSL ────────────────────────────────────────────────────────── */

/** Object-space position + normal varyings, injected into a standard material. */
const LOCAL_VARYINGS_V = /* glsl */ `
varying vec3 vLocalP;
varying vec3 vLocalN;
`;

const LOCAL_ASSIGN_V = /* glsl */ `
vLocalP = position;
vLocalN = normal;
`;

/** Cheap fbm on top of the shared simplex noise, matching the CPU version. */
const FBM = /* glsl */ `
float aeon_fbm(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    s += a; n += a * snoise(p); p *= 2.03; a *= 0.5;
  }
  return n / max(s, 1e-4);
}
float aeon_ridge(vec3 p, int oct){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    s += a; n += a * (1.0 - abs(snoise(p))); p *= 2.11; a *= 0.5;
  }
  return n / max(s, 1e-4);
}
`;

function graft(
  mat: MeshStandardMaterial,
  key: string,
  fragBody: string,
  extraUniforms: LiveUniforms = {},
  vertBody = ''
): void {
  const u = uniformsOf(mat);
  Object.assign(u, extraUniforms);
  mat.onBeforeCompile = (shader) => {
    for (const k in u) shader.uniforms[k] = u[k];
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${LOCAL_VARYINGS_V}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LOCAL_ASSIGN_V}\n${vertBody}`);
    let decl = '';
    for (const k in u) {
      const v = u[k].value;
      const t = typeof v === 'number' ? 'float' : v instanceof Color || v instanceof Vector3 ? 'vec3' : 'float';
      decl += `uniform ${t} ${k};\n`;
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${LOCAL_VARYINGS_V}\n${decl}\n${GLSL_NOISE}\n${FBM}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${fragBody}`);
  };
  // Without this, two variants of "the same" material share a compiled program.
  mat.customProgramCacheKey = () => key;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Suit
   ═══════════════════════════════════════════════════════════════════════════ */

export interface SuitOptions {
  base?: Color;
  accent?: Color;
  /** 0 = pristine EVA suit, 1 = ten years in a dust storm. */
  wear?: number;
  /** Panel line frequency, cycles per metre. */
  panels?: number;
}

/**
 * A layered fabric/composite: woven micro-noise on roughness, quilted padding
 * bands, hard-edged panel seams, and grime that settles on upward faces and in
 * the creases. The seams are what give the silhouette internal structure at
 * distance — without them a suit is a smooth blob.
 */
export function makeSuitMaterial(rng: Rng, o: SuitOptions = {}): MeshStandardMaterial {
  const base = o.base ?? new Color(0.72, 0.74, 0.78);
  const accent = o.accent ?? new Color(0.85, 0.42, 0.13);
  const wear = o.wear ?? 0.35;
  const panels = o.panels ?? 9.0;
  const jitter = rng.range(0, 100);

  const mat = new MeshStandardMaterial({
    color: base,
    roughness: 0.68,
    metalness: 0.06,
    envMapIntensity: 1.0,
  });

  graft(
    mat,
    `aeon-suit-${panels.toFixed(2)}-${wear.toFixed(2)}`,
    /* glsl */ `
    {
      vec3 lp = vLocalP * uPanel + uJitter;
      // Hard seams: a triangle wave sharpened to a line, on two axes.
      float sy = abs(fract(vLocalP.y * uPanel * 0.5 + 0.5) - 0.5) * 2.0;
      float ang = atan(vLocalP.x, vLocalP.z) * 1.5915494;
      float sa = abs(fract(ang * 3.0 + 0.5) - 0.5) * 2.0;
      float seam = min(smoothstep(0.0, 0.09, sy), smoothstep(0.0, 0.11, sa));

      // Quilted padding: soft cells that catch light on the ridges.
      float quilt = aeon_fbm(lp * 2.4, 3) * 0.5 + 0.5;
      float weave = aeon_fbm(vLocalP * 220.0 + uJitter, 2);

      // Grime pools on upward faces and in the seams.
      float upness = clamp(vLocalN.y * 0.5 + 0.5, 0.0, 1.0);
      float grime = clamp(aeon_fbm(vLocalP * 5.5 - uJitter, 4) * 0.5 + 0.5, 0.0, 1.0);
      grime = mix(grime * 0.5, grime, upness) * uWear + (1.0 - seam) * 0.25 * uWear;

      vec3 col = diffuseColor.rgb;
      col *= mix(0.62, 1.0, seam);
      col *= 1.0 + quilt * 0.10;
      col = mix(col, col * vec3(0.55, 0.51, 0.47), clamp(grime, 0.0, 0.75));

      // Accent stripe around the upper arm / thigh bands.
      float band = smoothstep(0.014, 0.0, abs(fract(vLocalP.y * 3.0) - 0.5) - 0.08);
      col = mix(col, uAccent, band * 0.55 * step(0.02, abs(vLocalN.y) * -1.0 + 1.0));

      diffuseColor.rgb = col;
      diffuseColor.rgb += weave * 0.012;
      vRoughGraft = clamp(0.52 + weave * 0.16 + grime * 0.30 - seam * 0.06, 0.05, 1.0);
    }
    `,
    { uPanel: { value: panels }, uWear: { value: wear }, uAccent: { value: accent }, uJitter: { value: jitter } }
  );

  // The graft above writes a roughness it cannot apply from <map_fragment>;
  // patch the roughness stage too. (Declared as a fragment-scope float.)
  const inner = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    inner(shader, renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nfloat vRoughGraft = 0.7;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vRoughGraft;');
  };
  return mat;
}

/**
 * Helmet glass. Metal-mirror rather than transmissive: a real transmissive
 * visor costs a whole render pass and reads worse. The graft adds a synthetic
 * sky reflection so the visor still catches the horizon even before the realm
 * hands us an environment map, plus a soft fresnel rim that separates the head
 * from the sky in silhouette.
 */
export function makeVisorMaterial(): MeshPhysicalMaterial {
  const mat = new MeshPhysicalMaterial({
    color: new Color(0.02, 0.03, 0.04),
    metalness: 1.0,
    roughness: 0.055,
    envMapIntensity: 2.0,
    iridescence: 0.55,
    iridescenceIOR: 1.5,
    iridescenceThicknessRange: [140, 460],
  });
  const u = uniformsOf(mat);
  u.uSkyUp = { value: new Color(0.16, 0.30, 0.62) };
  u.uSkyDown = { value: new Color(0.22, 0.19, 0.16) };
  u.uSun = { value: new Vector3(0, 1, 0) };
  u.uSkyGain = { value: 1.0 };

  mat.onBeforeCompile = (shader) => {
    for (const k in u) shader.uniforms[k] = u[k];
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWNrm;\nvarying vec3 vWPos;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWNrm = normalize(mat3(modelMatrix) * normal);\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWNrm; varying vec3 vWPos;
         uniform vec3 uSkyUp; uniform vec3 uSkyDown; uniform vec3 uSun; uniform float uSkyGain;`
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
         {
           vec3 V = normalize(vWPos - cameraPosition);
           vec3 R = reflect(V, normalize(vWNrm));
           float h = R.y * 0.5 + 0.5;
           vec3 sky = mix(uSkyDown, uSkyUp, smoothstep(0.42, 1.0, h));
           // A specular sun disc in the reflection sells "glass" instantly.
           float sd = max(dot(R, normalize(uSun)), 0.0);
           sky += vec3(1.0, 0.94, 0.86) * pow(sd, 900.0) * 30.0;
           sky += vec3(1.0, 0.92, 0.80) * pow(sd, 22.0) * 0.9;
           float fres = pow(1.0 - max(dot(-V, normalize(vWNrm)), 0.0), 4.0);
           gl_FragColor.rgb += sky * uSkyGain * (0.20 + fres * 0.85);
         }`
      );
  };
  mat.customProgramCacheKey = () => 'aeon-visor';
  return mat;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Vehicle / ship hull
   ═══════════════════════════════════════════════════════════════════════════ */

export interface HullOptions {
  base?: Color;
  accent?: Color;
  metalness?: number;
  roughness?: number;
  /** Cycles per metre for panel plating. */
  plates?: number;
  /** Baked-in grime, before any impact damage accumulates. */
  wear?: number;
}

/**
 * Painted metal that can be beaten up. `uDamage` (0..1) drives paint chipping
 * back to bare metal, scorching around the impact bands, and a rise in
 * roughness — the visible half of Pacific Drive's "your car is a character".
 * Drive it via `uniformsOf(mat).uDamage.value`.
 */
export function makeHullMaterial(rng: Rng, o: HullOptions = {}): MeshStandardMaterial {
  const base = o.base ?? new Color(0.55, 0.52, 0.47);
  const accent = o.accent ?? new Color(0.90, 0.55, 0.10);
  const jitter = rng.range(0, 200);

  const mat = new MeshStandardMaterial({
    color: base,
    roughness: o.roughness ?? 0.48,
    metalness: o.metalness ?? 0.62,
    envMapIntensity: 1.1,
  });

  graft(
    mat,
    `aeon-hull-${(o.plates ?? 2.2).toFixed(2)}`,
    /* glsl */ `
    {
      vec3 lp = vLocalP;
      // Plating: rectangular cells with bevelled, slightly darker gaps.
      vec3 cell = floor(lp * uPlates + uJitter);
      float cellRnd = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      vec3 f = abs(fract(lp * uPlates + uJitter) - 0.5) * 2.0;
      float gap = 1.0 - smoothstep(0.86, 0.995, max(max(f.x, f.y), f.z));

      float streak = aeon_fbm(vec3(lp.x * 3.0, lp.y * 26.0, lp.z * 3.0) + uJitter, 3);
      float dirt = clamp(aeon_fbm(lp * 3.1 - uJitter, 4) * 0.5 + 0.5, 0.0, 1.0);
      float down = clamp(-vLocalN.y * 0.5 + 0.5, 0.0, 1.0);

      vec3 col = diffuseColor.rgb;
      col *= mix(0.92, 1.06, cellRnd);
      col *= mix(0.55, 1.0, gap);
      col = mix(col, col * vec3(0.48, 0.44, 0.40), dirt * (uWear * 0.7 + down * 0.25));
      col += streak * 0.02;

      // Damage: paint flakes off along high-frequency ridges, revealing metal,
      // and scorch collects around the flaked edges.
      float chipMask = aeon_ridge(lp * 11.0 + uJitter * 0.5, 4);
      float chip = smoothstep(0.72 - uDamage * 0.42, 0.86 - uDamage * 0.30, chipMask) * uDamage;
      float scorch = smoothstep(0.45, 0.95, chipMask) * uDamage * 0.6;
      vec3 bare = vec3(0.32, 0.31, 0.30);
      col = mix(col, bare, clamp(chip, 0.0, 0.9));
      col = mix(col, col * 0.22, scorch * 0.8);

      diffuseColor.rgb = col;
      vRoughGraft = clamp(uRough + dirt * 0.22 * uWear + chip * 0.30 - gap * 0.05, 0.04, 1.0);
      vMetalGraft = clamp(uMetal + chip * 0.35 - scorch * 0.4, 0.0, 1.0);
    }
    `,
    {
      uPlates: { value: o.plates ?? 2.2 },
      uJitter: { value: jitter },
      uWear: { value: o.wear ?? 0.3 },
      uDamage: { value: 0 },
      uAccent: { value: accent },
      uRough: { value: o.roughness ?? 0.48 },
      uMetal: { value: o.metalness ?? 0.62 },
    }
  );

  const inner = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    inner(shader, renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nfloat vRoughGraft = 0.5;\nfloat vMetalGraft = 0.5;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vRoughGraft;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vMetalGraft;');
  };
  return mat;
}

/** Flat HDR emitter for light housings, decals and engine cores. */
export function makeEmissive(color: Color, intensity: number): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color: new Color(0, 0, 0),
    emissive: color.clone(),
    emissiveIntensity: intensity,
    roughness: 0.4,
    metalness: 0,
    toneMapped: false,
  });
  return m;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Custom shaders — these must carry the log-depth chunks themselves
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Thruster flame. A cone whose local Y runs 0 (nozzle) → 1 (tip); the shader
 * turns it into a shock-diamond plume that shortens and reddens at low throttle
 * and goes blue-white and long at full. Additive, depth-tested but not written.
 */
export function makeFlameMaterial(colorHot: Color, colorCool: Color): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uThrottle: { value: 0 },
      uHot: { value: colorHot.clone() },
      uCool: { value: colorCool.clone() },
      uJitter: { value: 0 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform float uThrottle;
      uniform float uTime;
      uniform float uJitter;
      varying vec2 vUv;
      varying float vR;
      void main(){
        vUv = uv;
        vec3 p = position;
        // The plume grows along -Z and pinches with throttle.
        float t = clamp(p.z / -1.0, 0.0, 1.0);
        float flick = sin(uTime * 41.0 + uJitter + t * 9.0) * 0.5 + 0.5;
        float len = mix(0.18, 1.0, uThrottle) * (0.9 + flick * 0.12);
        p.z *= len;
        p.xy *= mix(0.55, 1.0, uThrottle) * (1.0 - t * 0.55) * (0.94 + flick * 0.10);
        vR = length(p.xy) / max(1e-3, mix(0.55, 1.0, uThrottle));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uHot;
      uniform vec3 uCool;
      uniform float uThrottle;
      uniform float uTime;
      uniform float uJitter;
      varying vec2 vUv;
      varying float vR;
      void main(){
        #include <logdepthbuf_fragment>
        float t = clamp(vUv.y, 0.0, 1.0);
        // Shock diamonds: periodic brightening down the plume axis.
        float diamonds = 0.5 + 0.5 * cos((t * 26.0 - uTime * 22.0 + uJitter) );
        diamonds = pow(diamonds, 3.0) * smoothstep(0.02, 0.25, t) * (1.0 - t);
        float core = pow(1.0 - clamp(vR, 0.0, 1.0), 2.2);
        float fade = pow(1.0 - t, 1.6);
        vec3 c = mix(uCool, uHot, core * 0.85 + diamonds * 0.4);
        // HDR: the core is genuinely 20× white. The post chain handles it.
        float e = (core * 14.0 + diamonds * 9.0 + 0.5) * fade * (0.25 + uThrottle * 1.35);
        float a = clamp(fade * (core * 1.1 + 0.18), 0.0, 1.0) * (0.15 + uThrottle * 0.85);
        if (a < 0.004) discard;
        gl_FragColor = vec4(c * e, a);
      }
    `,
  });
}

/**
 * The soft glow shell around an engine bell or a running light. Back-faces
 * only, so it reads as a halo hugging the geometry rather than a card.
 */
export function makeGlowMaterial(color: Color): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    side: BackSide,
    toneMapped: false,
    uniforms: { uColor: { value: color.clone() }, uPower: { value: 1 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN;
      varying vec3 vV;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor;
      uniform float uPower;
      varying vec3 vN;
      varying vec3 vV;
      void main(){
        #include <logdepthbuf_fragment>
        float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);
        float a = rim * uPower;
        if (a < 0.004) discard;
        gl_FragColor = vec4(uColor * a * 3.2, a * 0.85);
      }
    `,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Teardown
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Free every geometry and material under a subtree exactly once. Shared
 * materials are common in these rigs, hence the Set.
 */
export function disposeTree(root: Object3D): void {
  const seen = new Set<any>();
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry && !seen.has(m.geometry)) {
      seen.add(m.geometry);
      m.geometry.dispose();
    }
    const mat = (m as any).material;
    if (!mat) return;
    const list: Material[] = Array.isArray(mat) ? mat : [mat];
    for (const x of list) {
      if (seen.has(x)) continue;
      seen.add(x);
      for (const k in x) {
        const v = (x as any)[k];
        if (v && v.isTexture) v.dispose();
      }
      x.dispose();
    }
  });
}
