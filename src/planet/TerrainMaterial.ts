/**
 * The terrain surface material.
 *
 * Built on MeshStandardMaterial so it gets three's shadow, IBL and PBR plumbing
 * for free, with the interesting parts injected: CDLOD vertex morphing, and a
 * fragment shader that decides what this piece of ground actually *is* from the
 * same field the collision code reads.
 *
 * Two things do most of the visual work here:
 *
 *   • SLOPE. Anything steeper than about 35° is bare rock, everywhere, on every
 *     world. Soil and snow do not cling to cliffs. One rule, and terrain stops
 *     looking like a painted heightmap.
 *   • SCALE. Three octaves of detail keyed to viewing distance, so the ground
 *     has grain at one metre, texture at a hundred, and shape at ten thousand,
 *     and none of them alias into the others.
 */

import { Color, MeshStandardMaterial, Vector3 } from 'three';
import { GLSL_COLOR, GLSL_NOISE } from '../core/Noise';
import { CLOUD_SAMPLE_GLSL } from './Clouds';
import { AERIAL_GLSL, AERIAL_UNIFORMS, aerialUniformValues } from './Aerial';
import type { TerrainField } from './TerrainField';
import type { PlanetSpec } from '../universe/Types';

export interface TerrainUniforms {
  uCamLocal: { value: Vector3 };
  uLodMorph: { value: Float32Array };
  uDetailF0: { value: number };
  uSunDir: { value: Vector3 };
  uSunColor: { value: Color };
  uSunIntensity: { value: number };
  uTime: { value: number };
  uDetailFade: { value: number };
  [k: string]: { value: any };
}

const VERT_PARS = /* glsl */ `
attribute vec4 aDir;     // xyz = unit direction, w = elevation (m)
attribute vec4 aMorph;   // xyz = offset toward the parent patch, w = LOD level
attribute vec3 aDetail;  // per-patch noise anchor, keeps detail coords small

uniform vec3  uCamLocal;
uniform float uLodMorph[40];   // [start, end] per level, metres

varying vec3  vDir;
varying float vElev;
varying vec3  vLocal;
varying vec3  vDetailAnchor;
varying float vCamDist;
`;

const VERT_BODY = /* glsl */ `
  vDir = normalize(aDir.xyz);
  vElev = aDir.w;
  vDetailAnchor = aDetail;

  // CDLOD: slide this vertex toward where the parent patch's surface would be,
  // over a distance band chosen so the morph finishes exactly when the parent
  // takes over. Without it, every LOD switch is a visible pop across the whole
  // horizon; with it, nothing moves that the eye can catch.
  float lvl = aMorph.w;
  int li = int(lvl) * 2;
  float mStart = uLodMorph[li];
  float mEnd   = uLodMorph[li + 1];
  float d = distance(position, uCamLocal);
  float m = clamp((d - mStart) / max(1.0, mEnd - mStart), 0.0, 1.0);
  transformed = position + aMorph.xyz * m;

  vLocal = transformed;
  vCamDist = d;
`;

const FRAG_PARS = /* glsl */ `

uniform vec3  uCamLocal;
uniform float uDetailF0;
uniform float uTime;
uniform float uDetailFade;

uniform vec3 uLowland;
uniform vec3 uHighland;
uniform vec3 uMountain;
uniform vec3 uPeak;
uniform vec3 uSand;
uniform vec3 uRock;
uniform vec3 uVeg;
uniform vec3 uVegAlt;
uniform vec3 uPolar;
uniform vec3 uEmissive;
uniform float uEmissiveStrength;
uniform float uSeaLevelR;
uniform float uWetness;
uniform sampler2D uCloudTex;
uniform float uCloudMidR;
uniform float uCloudShadow;
uniform vec3  uSunDir;

varying vec3  vDir;
varying float vElev;
varying vec3  vLocal;
varying vec3  vDetailAnchor;
varying float vCamDist;
`;

/**
 * Assemble the fragment body. `fieldGlsl` is TerrainField.glsl(), which brings
 * aeTemperature / aeHumidity / aeLatSin and the defines they need.
 */
function fragBody(): string {
  return /* glsl */ `
  vec3 d = normalize(vDir);
  float hN = clamp(vElev / AE_MAXELEV, -1.0, 1.0);
  float temp = aeTemperature(d, hN);
  float hum  = aeHumidity(d, hN, temp);

  // Slope from the interpolated normal against the radial direction. This is
  // the single most important terrain cue, so it is computed from the real
  // shading normal rather than from the height field.
  vec3 gN = normalize(vNormal);
  float slope = 1.0 - clamp(dot(gN, d), 0.0, 1.0);

  // Detail noise. The anchor keeps coordinates small enough for float32 to
  // carry millimetres even ten million metres from the planet centre.
  vec3 dp = d * uDetailF0 - vDetailAnchor;
  float near = 1.0 - smoothstep(120.0, 2600.0, vCamDist);
  float veryNear = 1.0 - smoothstep(6.0, 90.0, vCamDist);

  float grain = fbm(dp * 260.0, 4) * 0.5 + 0.5;
  float coarse = fbm(dp * 26.0, 5) * 0.5 + 0.5;
  float macro = fbm(dp * 3.4, 4) * 0.5 + 0.5;

  float sea = uSeaLevelR - AE_R;
  float above = vElev - sea;

  /* ---- what is this ground made of ---- */
  vec3 albedo = mix(uLowland, uHighland, smoothstep(0.02, 0.35, hN));
  albedo = mix(albedo, uMountain, smoothstep(0.32, 0.68, hN));
  albedo = mix(albedo, uPeak, smoothstep(0.74, 0.96, hN));

  // Vegetation where it is warm and wet and not too steep.
  float vegMask = smoothstep(0.30, 0.62, hum * temp) * (1.0 - smoothstep(0.30, 0.62, slope));
  vec3 veg = mix(uVeg, uVegAlt, macro);
  albedo = mix(albedo, veg, vegMask * 0.92);

  // Beaches: a narrow band just above the waterline, widened on gentle slopes.
  #if AE_HASOCEAN == 1
    float beach = (1.0 - smoothstep(0.0, 26.0 + 60.0 * (1.0 - slope), abs(above)))
                * (1.0 - smoothstep(0.16, 0.4, slope));
    albedo = mix(albedo, uSand, beach * 0.9);
    // Wet sand is darker and shinier — the tideline is a strong visual cue.
    float wet = (1.0 - smoothstep(0.0, 7.0, max(above, 0.0))) * uWetness;
  #else
    float wet = 0.0;
  #endif

  // Cliffs are rock. Always.
  float rockMask = smoothstep(0.34, 0.60, slope);
  vec3 rock = mix(uRock, uMountain, coarse * 0.6);
  // Strata: rock exposed on a slope shows its bedding planes.
  float strata = fbm(vec3(vElev * 0.06, dp.y * 3.0, dp.z * 3.0), 3) * 0.5 + 0.5;
  rock *= mix(0.78, 1.22, strata);
  albedo = mix(albedo, rock, rockMask);

  // Snow above the snow line, on surfaces flat enough to hold it.
  float snowLine = smoothstep(0.30, 0.06, temp);
  float snow = snowLine * (1.0 - smoothstep(0.34, 0.66, slope));
  snow *= smoothstep(0.0, 0.35, 0.55 + 0.45 * (coarse - 0.5));
  albedo = mix(albedo, uPolar, clamp(snow, 0.0, 1.0));

  /* ---- surface finish ---- */
  albedo *= mix(1.0, mix(0.84, 1.16, grain), near * 0.85);
  albedo *= mix(1.0, mix(0.90, 1.10, coarse), 0.7);

  float rough = mix(0.94, 0.70, snow);
  rough = mix(rough, 0.86, rockMask);
  rough = mix(rough, 0.55, wet);
  albedo *= mix(1.0, 0.62, wet);

  // Cloud shadow. Solved against the same field the deck renders, so the dark
  // patch is genuinely under the cloud that made it — and it drifts, which is
  // most of what sells a sky as moving when you are standing still.
  if (uCloudShadow > 0.001) {
    float shade = aeCloudShadow(uCloudTex, vLocal, uSunDir, uCloudMidR);
    albedo *= mix(1.0, 0.34, shade * uCloudShadow);
  }

  diffuseColor.rgb = albedo;
  roughnessFactor = clamp(rough, 0.05, 1.0);
  metalnessFactor = 0.0;

  // Emissive geology: lava in the cracks, crystal, bioluminescent mats. Keyed
  // to the low-lying, high-volcanism parts so it pools where it should.
  if (uEmissiveStrength > 0.0001) {
    float cracks = 1.0 - smoothstep(0.0, 0.16, worley(dp * 34.0, 1.0).y - worley(dp * 34.0, 1.0).x);
    float pool = smoothstep(0.4, 0.0, hN);
    totalEmissiveRadiance += uEmissive * uEmissiveStrength * cracks * pool * 2.4;
  }
`;
}

/**
 * Aerial perspective, applied to the shaded colour. See src/planet/Aerial.ts
 * for why this lives on the surface rather than on the atmosphere shell.
 */
const AERIAL_BODY = /* glsl */ `
  gl_FragColor.rgb = aeAerial(gl_FragColor.rgb, vLocal, uCamLocal, uSunDir, uSunColor, uSunIntensity);
`;

/** Per-fragment normal perturbation, injected after the normal is established. */
const NORMAL_BODY = /* glsl */ `
  {
    // Micro-relief. Derived by finite differences of the same detail noise the
    // albedo uses, so bumps and colour agree instead of fighting.
    vec3 dp2 = normalize(vDir) * uDetailF0 - vDetailAnchor;
    float k = 1.0 - smoothstep(40.0, 900.0, vCamDist);
    if (k > 0.001) {
      float e = 0.004;
      float n0 = fbm(dp2 * 180.0, 3);
      float nx = fbm((dp2 + vec3(e, 0.0, 0.0)) * 180.0, 3);
      float ny = fbm((dp2 + vec3(0.0, e, 0.0)) * 180.0, 3);
      float nz = fbm((dp2 + vec3(0.0, 0.0, e)) * 180.0, 3);
      vec3 g = vec3(nx - n0, ny - n0, nz - n0) / e;
      // Project the gradient onto the tangent plane so it tilts the normal
      // without ever flipping it through the surface.
      g -= normal * dot(g, normal);
      normal = normalize(normal + g * 0.010 * k);
    }
  }
`;

export function makeTerrainMaterial(
  field: TerrainField,
  spec: PlanetSpec,
  lodMorph: Float32Array,
  detailF0: number
): { material: MeshStandardMaterial; uniforms: TerrainUniforms } {
  const pal = spec.palette;
  const morph = new Float32Array(40);
  morph.set(lodMorph.subarray(0, Math.min(40, lodMorph.length)));

  const uniforms: TerrainUniforms = {
    uCamLocal: { value: new Vector3() },
    uLodMorph: { value: morph },
    uDetailF0: { value: detailF0 },
    uSunDir: { value: new Vector3(1, 0, 0) },
    uSunColor: { value: new Color(1, 1, 1) },
    uSunIntensity: { value: 1 },
    uTime: { value: 0 },
    uDetailFade: { value: 1 },
    uLowland: { value: new Color(...pal.lowland) },
    uHighland: { value: new Color(...pal.highland) },
    uMountain: { value: new Color(...pal.mountain) },
    uPeak: { value: new Color(...pal.peak) },
    uSand: { value: new Color(...pal.sand) },
    uRock: { value: new Color(...pal.rock) },
    uVeg: { value: new Color(...pal.vegetation) },
    uVegAlt: { value: new Color(...pal.vegetationAlt) },
    uPolar: { value: new Color(...pal.polar) },
    uEmissive: { value: new Color(...pal.emissive) },
    uEmissiveStrength: { value: pal.emissiveStrength },
    uSeaLevelR: { value: field.seaLevelRadius() },
    uWetness: { value: spec.ocean.present ? 1 : 0 },
    // Filled in by Planet once the deck exists; zero means "no clouds here".
    uCloudTex: { value: null },
    uCloudMidR: { value: spec.radiusM * 1.001 },
    uCloudShadow: { value: 0 },
    ...Object.fromEntries(
      Object.entries(aerialUniformValues(spec)).map(([k, v]) => [k, { value: v }])
    ),
  };

  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    dithering: true,
  });

  const fieldGlsl = field.glsl();

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${GLSL_NOISE}\n${GLSL_COLOR}\n${fieldGlsl}\n${FRAG_PARS}\n${CLOUD_SAMPLE_GLSL}\n${AERIAL_UNIFORMS}\n${AERIAL_GLSL}`
      )
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${NORMAL_BODY}`)
      // After <opaque_fragment> has written gl_FragColor and before the output
      // transform, so the haze is added in linear radiance like everything else.
      .replace('#include <colorspace_fragment>', `${AERIAL_BODY}\n#include <colorspace_fragment>`)
      // Must land after <metalnessmap_fragment>, not after <roughnessmap_fragment>:
      // three declares metalnessFactor in the later chunk, and writing to it one
      // chunk early fails the whole program to compile (silent black terrain).
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>\n${fragBody()}`
      );
  };

  // Without this, three reuses one compiled program across planets and every
  // world after the first gets the first world's palette baked in.
  material.customProgramCacheKey = () => `aeon-terrain-${spec.seed}`;

  return { material, uniforms };
}

