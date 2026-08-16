/**
 * Distant bodies.
 *
 * When you are eight hundred million kilometres away, a planet is a disc a few
 * dozen pixels across — and running the full quadtree terrain pipeline for it
 * would be absurd. This is the cheap version: one sphere, one shader, and every
 * feature that survives at that distance.
 *
 * What survives, and therefore what this draws: continents, ice caps, cloud
 * bands, the terminator, specular glint off oceans, atmospheric limb, city
 * lights on the night side, and rings. What doesn't survive, and is therefore
 * absent: everything else.
 *
 * The handover to the full `Planet` happens at a few planetary radii, close
 * enough that both look the same and the swap is invisible.
 */

import {
  AdditiveBlending,
  BackSide,
  Color,
  DoubleSide,
  Mesh,
  Object3D,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Uniform,
  Vector3,
} from 'three';
import { GLSL_COLOR, GLSL_NOISE } from '../core/Noise';
import type { PlanetSpec } from '../universe/Types';

const BODY_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocal;
varying vec3 vWorldNormal;
varying vec3 vViewDir;
void main(){
  vLocal = normalize(position);
  vWorldNormal = normalize(mat3(modelMatrix) * vLocal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vViewDir = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const BODY_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}
${GLSL_COLOR}

uniform vec3  uSunDir;        // world space, toward the star
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform float uTime;
uniform float uSpin;
uniform float uSeed;

uniform vec3  uLowland;
uniform vec3  uHighland;
uniform vec3  uMountain;
uniform vec3  uPeak;
uniform vec3  uSand;
uniform vec3  uRock;
uniform vec3  uVegetation;
uniform vec3  uPolar;
uniform vec3  uEmissive;
uniform float uEmissiveStrength;

uniform float uLandFraction;
uniform float uContinentFreq;
uniform float uRidgeFreq;
uniform float uWarp;
uniform float uCraters;
uniform float uHasOcean;
uniform vec3  uOceanShallow;
uniform vec3  uOceanDeep;
uniform float uOceanLevel;
uniform float uIceCoverage;
uniform float uCloudiness;
uniform float uAxialTilt;
uniform float uCityLights;
uniform vec3  uNeon;
uniform float uIsGasGiant;

varying vec3 vLocal;
varying vec3 vWorldNormal;
varying vec3 vViewDir;

// A compressed cousin of the full terrain field: same character, a fraction
// of the cost, because at this distance only the large features are visible.
float continent(vec3 p){
  vec3 w = p + vec3(
    fbm(p * 1.7 + 11.0, 4),
    fbm(p * 1.7 + 31.0, 4),
    fbm(p * 1.7 + 57.0, 4)
  ) * uWarp;
  float base = fbm(w * uContinentFreq, 6, 2.1, 0.52);
  return base;
}

float elevation(vec3 p){
  float c = continent(p);
  float land = smoothstep(-0.06, 0.14, c + (uLandFraction - 0.5) * 0.7);
  float ridges = ridged(p * uRidgeFreq, 5, 2.05, 0.5);
  float e = c * 0.6 + ridges * land * 0.55;
  if (uCraters > 0.01){
    vec2 w = worley(p * 9.0, 0.9);
    float crater = smoothstep(0.0, 0.28, w.x) - 0.35 * smoothstep(0.28, 0.34, w.x);
    e -= (1.0 - crater) * uCraters * 0.22;
  }
  return e;
}

// Gas giants are bands, storms, and shear — a completely different shader.
vec3 gasGiant(vec3 p, float lat){
  float bands = fbm(vec3(p.x * 0.4, lat * 14.0, p.z * 0.4) + vec3(uTime * 0.004, 0.0, 0.0), 5);
  float shear = fbm(vec3(p.x * 2.0 + bands * 1.4, lat * 26.0, p.z * 2.0), 5);
  float storms = ridged(p * 3.4 + vec3(uTime * 0.01, 0.0, 0.0), 4, 2.2, 0.55);
  float t = bands * 0.55 + shear * 0.35;
  vec3 col = mix(uLowland, uHighland, smoothstep(-0.3, 0.4, t));
  col = mix(col, uMountain, smoothstep(0.2, 0.7, shear));
  col = mix(col, uPeak, smoothstep(0.72, 0.95, storms) * 0.85);
  // Polar hoods: the banding breaks down toward the poles.
  col = mix(col, uPolar, smoothstep(0.72, 0.95, abs(lat)));
  return col;
}

void main(){
  #include <logdepthbuf_fragment>

  // Rotate the surface pattern with the planet's spin.
  float a = uSpin;
  mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
  vec3 p = normalize(vLocal);
  p.xz = rot * p.xz;
  p += uSeed;

  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(vViewDir);
  vec3 L = normalize(uSunDir);
  float ndl = dot(N, L);

  float lat = normalize(vLocal).y;
  vec3 albedo;
  float rough = 0.9;
  float ocean = 0.0;

  if (uIsGasGiant > 0.5){
    albedo = gasGiant(p, lat);
  } else {
    float e = elevation(p);
    float sea = uOceanLevel * 2.0 - 1.0;
    ocean = uHasOcean > 0.5 ? smoothstep(sea + 0.02, sea - 0.02, e) : 0.0;

    // Latitude temperature with a tilt-driven offset, plus altitude lapse.
    float temp = (1.0 - abs(lat)) - max(0.0, e - sea) * 0.9;
    float humid = fbm(p * 2.6 + 71.0, 4) * 0.5 + 0.5;

    float h = clamp((e - sea) / max(0.001, 1.0 - sea), 0.0, 1.0);
    albedo = mix(uLowland, uHighland, smoothstep(0.05, 0.4, h));
    albedo = mix(albedo, uMountain, smoothstep(0.35, 0.7, h));
    albedo = mix(albedo, uPeak, smoothstep(0.72, 0.95, h));
    albedo = mix(albedo, uSand, smoothstep(0.06, 0.0, h) * (1.0 - ocean) * 0.8);
    albedo = mix(albedo, uVegetation, smoothstep(0.35, 0.75, humid * temp) * (1.0 - smoothstep(0.4, 0.8, h)));
    albedo = mix(albedo, uRock, smoothstep(0.55, 0.9, ridged(p * 18.0, 3, 2.0, 0.5)) * 0.35);

    // Ice caps: driven by temperature, so tilt genuinely moves them.
    float ice = smoothstep(0.16, -0.06, temp);
    albedo = mix(albedo, uPolar, ice);

    if (ocean > 0.5){
      float depth = clamp((sea - e) * 4.0, 0.0, 1.0);
      albedo = mix(uOceanShallow, uOceanDeep, depth);
      albedo = mix(albedo, uPolar, smoothstep(0.5, 0.9, ice * uIceCoverage + ice * 0.5));
      rough = 0.06;
    }
  }

  /* ---- lighting ---- */
  // Oren-Nayar-ish wrap: rocky, dusty bodies do not fall off like a lambert
  // sphere, and the terminator is where you notice.
  float wrap = clamp((ndl + 0.12) / 1.12, 0.0, 1.0);
  vec3 diffuse = albedo * uSunColor * uSunIntensity * wrap;

  // Ocean specular: the glint is the single most convincing detail on a
  // water world seen from space.
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), mix(24.0, 900.0, 1.0 - rough)) * (1.0 - rough);
  diffuse += uSunColor * uSunIntensity * spec * (ocean > 0.5 ? 2.4 : 0.12);

  /* ---- clouds ---- */
  if (uCloudiness > 0.01){
    vec3 cp = p * 2.2 + vec3(uTime * 0.006, 0.0, uTime * 0.002);
    float cl = fbm(cp + vec3(fbm(cp * 2.0, 4)) * 0.8, 6, 2.2, 0.55) * 0.5 + 0.5;
    float bandMask = mix(1.0, 0.55 + 0.45 * sin(lat * 9.0), 0.35);
    float cover = smoothstep(0.62 - uCloudiness * 0.45, 0.86 - uCloudiness * 0.2, cl * bandMask);
    vec3 cloudCol = uSunColor * uSunIntensity * (0.55 + 0.65 * wrap);
    diffuse = mix(diffuse, cloudCol, cover * 0.92);
  }

  /* ---- night side ---- */
  float night = smoothstep(0.06, -0.22, ndl);
  if (uCityLights > 0.001){
    // Cities cluster on habitable land: use the same fields that decided
    // where the land is, so lights land on coastlines, not on oceans.
    float e = uIsGasGiant > 0.5 ? 0.0 : elevation(p);
    float sea = uOceanLevel * 2.0 - 1.0;
    float land = step(sea, e);
    vec2 w = worley(p * 26.0, 1.0);
    float settlement = smoothstep(0.34, 0.02, w.x);
    float clusters = smoothstep(0.45, 0.8, fbm(p * 5.0 + 3.7, 4) * 0.5 + 0.5);
    float lights = settlement * clusters * land * (1.0 - abs(lat) * 0.55);
    diffuse += uNeon * lights * night * uCityLights * 2.2;
  }
  // Emissive geology (lava, crystal, bioluminescence) also shows at night.
  diffuse += uEmissive * uEmissiveStrength * night * 0.6;

  gl_FragColor = vec4(diffuse, 1.0);
}
`;

const ATMO_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_COLOR}

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uTint;
uniform float uDensity;
varying vec3 vLocal;
varying vec3 vWorldNormal;
varying vec3 vViewDir;

void main(){
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(vViewDir);
  vec3 L = normalize(uSunDir);

  // Path length through the shell: rim-heavy, which is what makes the limb
  // of a planet glow while the middle of the disc stays clear.
  float mu = abs(dot(N, V));
  float rim = pow(1.0 - mu, 3.4);

  float ndl = dot(N, L);
  float lit = smoothstep(-0.45, 0.35, ndl);

  // Forward scattering: the crescent nearest the sun is far brighter, and
  // reddens as the path through the atmosphere lengthens at the terminator.
  float phase = pow(clamp(dot(V, -L) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  vec3 sunset = mix(uTint, vec3(1.25, 0.42, 0.18), smoothstep(0.35, 0.0, abs(ndl)));

  vec3 col = sunset * uSunColor * uSunIntensity * rim * lit * uDensity;
  col += uSunColor * uSunIntensity * phase * rim * 0.55 * uDensity;

  gl_FragColor = vec4(col, clamp(rim * lit * uDensity, 0.0, 1.0));
}
`;

const RING_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUvR;
varying vec3 vWorld;
void main(){
  vUvR = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const RING_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}

uniform vec3  uColor;
uniform float uOpacity;
uniform float uGaps;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uPlanetCenter;
uniform float uPlanetRadius;
uniform float uSeed;
varying vec2 vUvR;
varying vec3 vWorld;

void main(){
  #include <logdepthbuf_fragment>
  float r = vUvR.x;

  // Structure: broad bands from noise, plus resonance gaps carved by shepherd
  // moons. Real rings are mostly empty space with sharp edges.
  float bands = fbm(vec3(r * 90.0 + uSeed, 0.0, 0.0), 5) * 0.5 + 0.5;
  float fine = fbm(vec3(r * 420.0 + uSeed, 0.0, 0.0), 3) * 0.5 + 0.5;
  float density = bands * 0.7 + fine * 0.3;

  for (float i = 1.0; i <= 5.0; i += 1.0){
    if (i > uGaps) break;
    float gp = fract(sin(i * 12.9898 + uSeed) * 43758.5453);
    float d = abs(r - gp);
    density *= smoothstep(0.0, 0.018, d);
  }
  density *= smoothstep(0.0, 0.05, r) * (1.0 - smoothstep(0.93, 1.0, r));

  // Planet shadow: rings crossing behind the planet go dark, which is one of
  // the most striking things in the solar system.
  vec3 toSun = normalize(uSunDir);
  vec3 rel = vWorld - uPlanetCenter;
  float along = dot(rel, toSun);
  float perp = length(rel - toSun * along);
  float shadow = (along < 0.0 && perp < uPlanetRadius) ? smoothstep(uPlanetRadius, uPlanetRadius * 0.85, perp) : 1.0;

  // Forward scattering: ice particles glow when backlit.
  float forward = 1.0;
  vec3 col = uColor * uSunColor * uSunIntensity * shadow * forward;
  float alpha = clamp(density * uOpacity, 0.0, 1.0);
  gl_FragColor = vec4(col * (0.35 + density * 0.9), alpha);
}
`;

export class BodyRenderer {
  readonly root = new Object3D();
  private surface: Mesh | null = null;
  private atmosphere: Mesh | null = null;
  private ring: Mesh | null = null;
  private spec: PlanetSpec | null = null;
  private time = 0;

  build(spec: PlanetSpec, segments = 96): void {
    this.dispose();
    this.spec = spec;
    const r = spec.radiusM;
    const isGas = spec.klass === 'gas-giant' || spec.klass === 'ice-giant';
    const pal = spec.palette;

    const geo = new SphereGeometry(r, segments, Math.floor(segments * 0.6));
    const mat = new ShaderMaterial({
      vertexShader: BODY_VERT,
      fragmentShader: BODY_FRAG,
      uniforms: {
        uSunDir: new Uniform(new Vector3(1, 0, 0)),
        uSunColor: new Uniform(new Color(1, 1, 1)),
        uSunIntensity: new Uniform(1),
        uTime: new Uniform(0),
        uSpin: new Uniform(spec.rotationPhase),
        uSeed: new Uniform((spec.seed % 1000) * 0.017),
        uLowland: new Uniform(new Color(...pal.lowland)),
        uHighland: new Uniform(new Color(...pal.highland)),
        uMountain: new Uniform(new Color(...pal.mountain)),
        uPeak: new Uniform(new Color(...pal.peak)),
        uSand: new Uniform(new Color(...pal.sand)),
        uRock: new Uniform(new Color(...pal.rock)),
        uVegetation: new Uniform(new Color(...pal.vegetation)),
        uPolar: new Uniform(new Color(...pal.polar)),
        uEmissive: new Uniform(new Color(...pal.emissive)),
        uEmissiveStrength: new Uniform(pal.emissiveStrength),
        uLandFraction: new Uniform(spec.terrain.landFraction),
        uContinentFreq: new Uniform(spec.terrain.continentFreq),
        uRidgeFreq: new Uniform(spec.terrain.ridgeFreq),
        uWarp: new Uniform(spec.terrain.domainWarp),
        uCraters: new Uniform(spec.terrain.craterDensity),
        uHasOcean: new Uniform(spec.ocean.present ? 1 : 0),
        uOceanShallow: new Uniform(new Color(...spec.ocean.shallow)),
        uOceanDeep: new Uniform(new Color(...spec.ocean.deep)),
        uOceanLevel: new Uniform(spec.ocean.level),
        uIceCoverage: new Uniform(spec.ocean.iceCoverage),
        uCloudiness: new Uniform(spec.atmosphere.present ? Math.min(0.95, spec.atmosphere.surfacePressurePa / 2.2e5) : 0),
        uAxialTilt: new Uniform(spec.axialTiltRad),
        uCityLights: new Uniform(spec.civilization.present ? spec.civilization.techLevel * (1 - spec.civilization.decay) : 0),
        uNeon: new Uniform(new Color(...(spec.civilization.present ? spec.civilization.neon : [0, 0, 0]))),
        uIsGasGiant: new Uniform(isGas ? 1 : 0),
      },
      toneMapped: false,
    });
    this.surface = new Mesh(geo, mat);
    this.root.add(this.surface);

    if (spec.atmosphere.present) {
      const ar = r + spec.atmosphere.thicknessM;
      const ageo = new SphereGeometry(ar, segments, Math.floor(segments * 0.6));
      const amat = new ShaderMaterial({
        vertexShader: BODY_VERT,
        fragmentShader: ATMO_FRAG,
        uniforms: {
          uSunDir: new Uniform(new Vector3(1, 0, 0)),
          uSunColor: new Uniform(new Color(1, 1, 1)),
          uSunIntensity: new Uniform(1),
          uTint: new Uniform(new Color(...spec.atmosphere.tint)),
          uDensity: new Uniform(Math.min(2.2, Math.pow(spec.atmosphere.surfacePressurePa / 101325, 0.35))),
        },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: BackSide,
        toneMapped: false,
      });
      this.atmosphere = new Mesh(ageo, amat);
      this.root.add(this.atmosphere);
    }

    if (spec.rings.present) {
      const rgeo = new RingGeometry(spec.rings.innerRadiusM, spec.rings.outerRadiusM, 256, 2);
      const rmat = new ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: {
          uColor: new Uniform(new Color(...spec.rings.color)),
          uOpacity: new Uniform(spec.rings.opacity),
          uGaps: new Uniform(spec.rings.gaps),
          uSunDir: new Uniform(new Vector3(1, 0, 0)),
          uSunColor: new Uniform(new Color(1, 1, 1)),
          uSunIntensity: new Uniform(1),
          uPlanetCenter: new Uniform(new Vector3()),
          uPlanetRadius: new Uniform(r),
          uSeed: new Uniform((spec.seed % 997) * 0.31),
        },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
      });
      this.ring = new Mesh(rgeo, rmat);
      this.ring.rotation.x = Math.PI / 2 + spec.rings.tilt;
      this.root.add(this.ring);
    }

    // Axial tilt is applied to the whole body so the rings and the spin axis
    // stay consistent with each other.
    this.root.rotation.z = spec.axialTiltRad;
  }

  setSun(dirWorld: Vector3, color: [number, number, number], intensity: number): void {
    const apply = (m: Mesh | null) => {
      if (!m) return;
      const u = (m.material as ShaderMaterial).uniforms;
      u.uSunDir?.value.copy(dirWorld);
      u.uSunColor?.value.setRGB(color[0], color[1], color[2]);
      if (u.uSunIntensity) u.uSunIntensity.value = intensity;
    };
    apply(this.surface);
    apply(this.atmosphere);
    apply(this.ring);
    if (this.ring) {
      const u = (this.ring.material as ShaderMaterial).uniforms;
      this.root.getWorldPosition(u.uPlanetCenter.value as Vector3);
    }
  }

  update(dt: number, simTime: number): void {
    if (!this.spec || !this.surface) return;
    this.time += dt;
    const u = (this.surface.material as ShaderMaterial).uniforms;
    u.uTime.value = this.time;
    u.uSpin.value = this.spec.rotationPhase + (simTime / this.spec.rotationS) * Math.PI * 2;
  }

  dispose(): void {
    for (const m of [this.surface, this.atmosphere, this.ring]) {
      if (!m) continue;
      this.root.remove(m);
      m.geometry.dispose();
      (m.material as ShaderMaterial).dispose();
    }
    this.surface = null;
    this.atmosphere = null;
    this.ring = null;
  }
}
