/**
 * A world.
 *
 * Composes the height field (TerrainField), the LOD terrain (QuadSphere), the
 * surface material, an atmosphere and an ocean into one object that behaves
 * correctly from four planetary radii out to standing on a beach.
 *
 * The contract that matters most is `heightAt`: it must return exactly what the
 * vertex shader drew, because the player's feet, the rover's wheels and every
 * scattered rock are placed by it. Both sides call into TerrainField, which is
 * written once in TypeScript and once in GLSL from the same parameters.
 */

import {
  AdditiveBlending,
  BackSide,
  Color,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshNormalMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
  Uniform,
  Vector2,
  Vector3,
} from 'three';
import type { IPlanet, SurfaceSample, SystemContext } from '../api/Contracts';
import type { QualityProfile } from '../core/Settings';
import type { PlanetSpec } from '../universe/Types';
import { GLSL_COLOR, GLSL_NOISE } from '../core/Noise';
import { TerrainField } from './TerrainField';
import { QuadSphere } from './QuadSphere';
import { makeTerrainMaterial, type TerrainUniforms } from './TerrainMaterial';
import { CLOUD_SAMPLE_GLSL, makeClouds, type CloudDeck } from './Clouds';
import { AERIAL_GLSL, AERIAL_UNIFORMS, aerialUniformValues } from './Aerial';

/* ═══════════════════════════════════════════════════════════════════════════
   Atmosphere
   ═══════════════════════════════════════════════════════════════════════════ */

const ATMO_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

/**
 * Single-scattering Rayleigh + Mie, raymarched through an exponential
 * atmosphere. Not a LUT model — but it is the real integral, evaluated with
 * few enough steps to be cheap, and it gets the things that matter right:
 * blue zenith, red horizon, the bright forward halo around the sun, and a
 * limb that glows when you see it from space.
 */
const ATMO_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_COLOR}

uniform vec3  uCam;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform float uRPlanet;
uniform float uRAtmo;
uniform vec3  uRayleigh;
uniform float uMie;
uniform float uMieG;
uniform vec3  uAbsorb;
uniform float uHRayleigh;
uniform float uHMie;
uniform float uSteps;
uniform float uScatterGain;

varying vec3 vWorld;

// Distances to a sphere centred on the origin. Returns (near, far); far < 0
// when the ray misses.
vec2 raySphere(vec3 o, vec3 d, float r){
  float b = dot(o, d);
  float c = dot(o, o) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

float densityR(float h){ return exp(-max(h, 0.0) / uHRayleigh); }
float densityM(float h){ return exp(-max(h, 0.0) / uHMie); }

// Optical depth from a point toward the sun. Four steps is enough because the
// function is smooth and monotonic along that ray.
vec3 sunTransmittance(vec3 p){
  vec2 t = raySphere(p, uSunDir, uRAtmo);
  if (t.y < 0.0) return vec3(1.0);
  float len = t.y / 4.0;
  float odR = 0.0, odM = 0.0;
  for (int i = 0; i < 4; i++){
    vec3 s = p + uSunDir * (len * (float(i) + 0.5));
    float h = length(s) - uRPlanet;
    odR += densityR(h) * len;
    odM += densityM(h) * len;
  }
  return exp(-(uRayleigh * odR + uAbsorb * odR + vec3(uMie) * odM * 1.1));
}

void main(){
  #include <logdepthbuf_fragment>

  vec3 ro = uCam;
  vec3 rd = normalize(vWorld - uCam);

  vec2 atmo = raySphere(ro, rd, uRAtmo);
  if (atmo.y < 0.0) discard;
  float t0 = max(atmo.x, 0.0);
  float t1 = atmo.y;

  // Stop at the ground: the terrain is drawn separately and gets its aerial
  // perspective from its own fog, so the shell must not paint over it.
  vec2 ground = raySphere(ro, rd, uRPlanet);
  if (ground.y > 0.0 && ground.x > 0.0) t1 = min(t1, ground.x);
  if (t1 <= t0) discard;

  float mu = dot(rd, uSunDir);
  // Rayleigh is symmetric; Mie is sharply forward-scattering, which is what
  // makes the sky brighten dramatically as you look toward the sun.
  float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = uMieG;
  float g2 = g * g;
  float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) /
                 ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));

  int steps = int(clamp(uSteps, 4.0, 48.0));
  float len = (t1 - t0) / float(steps);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  float odR = 0.0, odM = 0.0;

  for (int i = 0; i < 48; i++){
    if (i >= steps) break;
    vec3 p = ro + rd * (t0 + len * (float(i) + 0.5));
    float h = length(p) - uRPlanet;
    float dR = densityR(h) * len;
    float dM = densityM(h) * len;
    odR += dR;
    odM += dM;
    vec3 tr = exp(-(uRayleigh * odR + uAbsorb * odR + vec3(uMie) * odM * 1.1)) * sunTransmittance(p);
    sumR += tr * dR;
    sumM += tr * dM;
  }

  // The scattering integral is in per-metre units over a path of millions of
  // metres, so the raw result is enormous. This is the single scalar that turns
  // it into radiance the tone curve can hold; at 22 it buried the terrain under
  // a flat wash and overexposed the forward-scattering lobe into a green blob.
  vec3 col = (sumR * uRayleigh * phaseR + sumM * uMie * phaseM) * uSunColor * uSunIntensity * uScatterGain;

  // The alpha is how much of what is behind the shell survives — so a thick
  // atmosphere genuinely hides the stars, and a thin one barely tints them.
  float occl = 1.0 - exp(-(odR * 1.4 + odM * 0.7) * 0.6);
  gl_FragColor = vec4(max(col, 0.0), clamp(occl, 0.0, 1.0));
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   Ocean
   ═══════════════════════════════════════════════════════════════════════════ */

const OCEAN_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uTime;
uniform float uWaveHeight;
uniform vec3  uCamLocal;
uniform float uSeaR;
uniform float uLocal;      // 1 for the near patch, 0 for the far sphere

varying vec3 vWorld;
varying vec3 vDir;
varying float vDist;

// Sum of Gerstner waves. Real ocean swell is trochoidal — crests sharpen and
// troughs flatten — which is what separates water from a sine sheet.
vec3 gerstner(vec3 p, vec3 tangent, vec3 bitangent, vec3 up, out vec3 nrm){
  vec3 disp = vec3(0.0);
  vec3 n = up;
  float amp = uWaveHeight;
  float freq = 0.09;
  float speed = 1.1;
  float ang = 0.0;
  for (int i = 0; i < 4; i++){
    vec2 dir = vec2(cos(ang), sin(ang));
    vec3 wd = tangent * dir.x + bitangent * dir.y;
    float ph = freq * dot(p, wd) + uTime * speed;
    float s = sin(ph);
    float c = cos(ph);
    disp += wd * (amp * 0.62 * c) + up * (amp * s);
    n -= wd * (amp * freq * c) * 1.6;
    amp *= 0.56;
    freq *= 1.92;
    speed *= 1.28;
    ang += 2.399963;   // golden angle: four directions that never align
  }
  nrm = normalize(n);
  return disp;
}

void main(){
  vec3 local = position;
  vec3 up = normalize(local);
  // A stable tangent frame that does not spin at the poles.
  vec3 ref = abs(up.y) > 0.94 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 t = normalize(cross(ref, up));
  vec3 b = cross(up, t);

  vDir = up;
  vec3 nrm;
  vec3 disp = uLocal > 0.5 ? gerstner(local, t, b, up, nrm) : vec3(0.0);
  if (uLocal <= 0.5) nrm = up;

  vec3 world = local + disp;
  vWorld = world;
  vDist = distance(world, uCamLocal);

  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const oceanFrag = (fieldGlsl: string) => /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}
${GLSL_COLOR}
${fieldGlsl}
${CLOUD_SAMPLE_GLSL}
${AERIAL_UNIFORMS}
${AERIAL_GLSL}

uniform sampler2D uCloudTex;
uniform float uCloudMidR;
uniform float uCloudShadow;
uniform vec3  uCamLocal;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uShallow;
uniform vec3  uDeep;
uniform vec3  uSand;
uniform vec3  uSkyTint;
uniform float uTime;
uniform float uEmissive;
uniform float uWaveHeight;
uniform float uFloorFmax;

varying vec3 vWorld;
varying vec3 vDir;
varying float vDist;

void main(){
  #include <logdepthbuf_fragment>

  vec3 up = normalize(vDir);
  vec3 V = normalize(uCamLocal - vWorld);

  // Detail normal from noise, faded with distance so the far ocean stays
  // glassy instead of turning into shimmering static.
  float k = 1.0 - smoothstep(200.0, 9000.0, vDist);
  vec3 ref = abs(up.y) > 0.94 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 t = normalize(cross(ref, up));
  vec3 b = cross(up, t);
  vec3 N = up;
  if (k > 0.001) {
    vec3 p = vWorld * 0.06;
    float e = 0.35;
    float n0 = fbm(p + vec3(0.0, uTime * 0.25, 0.0), 4);
    float nx = fbm(p + vec3(e, uTime * 0.25, 0.0), 4);
    float nz = fbm(p + vec3(0.0, uTime * 0.25, e), 4);
    N = normalize(up - (t * (nx - n0) + b * (nz - n0)) * 3.4 * k);
  }

  float ndv = clamp(dot(N, V), 0.0, 1.0);
  // Schlick Fresnel with water's F0. At a grazing angle the sea is a mirror;
  // straight down it is glass. This one term does most of the work.
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);

  vec3 L = normalize(uSunDir);
  vec3 H = normalize(L + V);
  float ndl = max(dot(N, L), 0.0);

  // Sun glint: a very tight lobe, allowed to go far above 1.0 so the bloom
  // turns it into the streak that reads as "sea" from any distance.
  // Sun glint. It should be a hot, tight streak on the waves — not a floodlight
  // that swallows the whole sub-solar hemisphere. The wide lobe carries most of
  // what the eye reads as "water"; the tight one is the sparkle on the crests.
  float spec = pow(max(dot(N, H), 0.0), 900.0) * 2.4
             + pow(max(dot(N, H), 0.0), 90.0) * 0.22;

  // How deep is it here? The sea floor comes from the same height field the
  // terrain draws, evaluated at a coarse band limit — a continental shelf is a
  // hundred-kilometre feature and needs none of the fine octaves.
  //
  // This is the single largest thing separating a water world from a blue ball.
  // Water absorbs red within a few metres and blue over tens, so a shelf is
  // turquoise, a trench is nearly black, and the boundary between them traces
  // every coastline and every island chain from orbit.
  float floorN = aeHeightN(up, uFloorFmax);
  float depth = max(0.0, (AE_DATUM - floorN) * AE_MAXELEV);
  float dAtten = 1.0 - exp(-depth / 46.0);
  vec3 body = mix(uShallow, uDeep, dAtten);
  // In the first few metres the bottom itself is visible through the water.
  body = mix(uSand * 0.62, body, smoothstep(0.0, 13.0, depth));

  // Subsurface: light that made it through the crest and back out.
  float sss = pow(clamp(dot(V, -L) * 0.5 + 0.5, 0.0, 1.0), 3.0) * 0.6;
  body += uShallow * sss * uSunIntensity * 0.22 * (1.0 - dAtten * 0.7);

  vec3 sky = uSkyTint * uSunIntensity * (0.5 + 0.5 * ndl) * 0.30;
  vec3 col = mix(body * uSunColor * uSunIntensity * (0.25 + 0.75 * ndl), sky, F);
  col += uSunColor * uSunIntensity * spec * ndl;

  // Non-water fluids (lava, mostly) light themselves.
  col += uShallow * uEmissive;

  // A cloud shadow on open water is the most legible shadow on any world:
  // there is nothing else out there for the eye to attribute the darkening to.
  if (uCloudShadow > 0.001) {
    col *= mix(1.0, 0.30, aeCloudShadow(uCloudTex, vWorld, uSunDir, uCloudMidR) * uCloudShadow);
  }

  col = aeAerial(col, vWorld, uCamLocal, uSunDir, uSunColor, uSunIntensity);

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   Planet
   ═══════════════════════════════════════════════════════════════════════════ */

export class Planet implements IPlanet {
  readonly root = new Group();
  readonly spec: PlanetSpec;
  readonly radius: number;

  readonly field: TerrainField;
  private quad: QuadSphere;
  private terrainMat: MeshStandardMaterial;
  private terrainUniforms: TerrainUniforms;

  private atmo: Mesh | null = null;
  private oceanFar: Mesh | null = null;
  private oceanNear: Mesh | null = null;
  private clouds: CloudDeck | null = null;

  private viewer = new Vector3();
  private sunDir = new Vector3(1, 0, 0);
  private sunColor: [number, number, number] = [1, 1, 1];
  private sunIntensity = 1;
  private time = 0;
  private quality: QualityProfile | null = null;
  private screenH = 1080;
  private fovY = 1.2;

  constructor(spec: PlanetSpec) {
    this.spec = spec;
    this.radius = spec.radiusM;
    this.field = new TerrainField(spec);

    this.quad = new QuadSphere(this.field, {
      maxDepth: 14,
      patchRes: 33,
      budgetMsPerFrame: 3,
      pixelError: 3.0,
      maxPatches: 900,
    });
    this.root.add(this.quad.root);

    const built = makeTerrainMaterial(this.field, spec, this.quad.lodMorph, this.quad.detailF0);
    this.terrainMat = built.material;
    this.terrainUniforms = built.uniforms;
    this.terrainMat.side = FrontSide;
    this.quad.setMaterials(this.terrainMat, null);

    this.buildAtmosphere();
    this.buildOcean();
    this.buildClouds();
  }

  private buildClouds(): void {
    const c = makeClouds(this.spec);
    if (!c) return;
    this.clouds = c;
    this.root.add(c.mesh);

    // The terrain reads the same baked field for its shadows, so a dark patch
    // on the ground is always under the cloud that cast it.
    const tu = this.terrainUniforms;
    tu.uCloudTex.value = c.texture;
    tu.uCloudMidR.value = c.midRadius;
    tu.uCloudShadow.value = 1;
    for (const m of [this.oceanFar, this.oceanNear]) {
      if (!m) continue;
      const u = (m.material as ShaderMaterial).uniforms;
      u.uCloudTex.value = c.texture;
      u.uCloudMidR.value = c.midRadius;
      u.uCloudShadow.value = 1;
    }
  }

  /* ─────────────────────────── construction ─────────────────────────── */

  private buildAtmosphere(): void {
    const a = this.spec.atmosphere;
    if (!a.present) return;
    const rAtmo = this.radius + a.thicknessM;
    const geo = new SphereGeometry(rAtmo, 96, 64);
    const mat = new ShaderMaterial({
      vertexShader: ATMO_VERT,
      fragmentShader: ATMO_FRAG,
      uniforms: {
        uCam: new Uniform(new Vector3()),
        uSunDir: new Uniform(new Vector3(1, 0, 0)),
        uSunColor: new Uniform(new Color(1, 1, 1)),
        uSunIntensity: new Uniform(1),
        uRPlanet: new Uniform(this.radius),
        uRAtmo: new Uniform(rAtmo),
        uRayleigh: new Uniform(new Vector3(...a.rayleigh).multiplyScalar(1)),
        uMie: new Uniform(a.mie),
        uMieG: new Uniform(a.mieG),
        uAbsorb: new Uniform(new Vector3(...a.absorption)),
        uHRayleigh: new Uniform(a.scaleHeightM),
        uHMie: new Uniform(a.scaleHeightM * 0.22),
        uSteps: new Uniform(16),
        // One is the physically neutral value: the integral above is the real
        // single-scattering integral in per-metre units. It was set to 0.38 to
        // tame a limb seen from orbit, which left the sky black overhead when
        // standing on the ground — the zenith of a real sky is brighter than
        // the ground beneath it, not darker.
        uScatterGain: new Uniform(1.0),
      },
      transparent: true,
      depthWrite: false,
      // Back faces: we are usually inside the shell, and when we are not, the
      // far side is the limb we actually want to see.
      side: BackSide,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    this.atmo = new Mesh(geo, mat);
    this.atmo.renderOrder = 5;
    this.root.add(this.atmo);
  }

  private buildOcean(): void {
    const o = this.spec.ocean;
    if (!o.present) return;
    const r = this.field.seaLevelRadius();
    const emissive = o.fluid === 'lava' ? 2.4 : 0;

    const mkUniforms = (local: number) => ({
      uTime: new Uniform(0),
      uWaveHeight: new Uniform(o.waveHeightM),
      uCamLocal: new Uniform(new Vector3()),
      uSeaR: new Uniform(r),
      uLocal: new Uniform(local),
      uSunDir: new Uniform(new Vector3(1, 0, 0)),
      uSunColor: new Uniform(new Color(1, 1, 1)),
      uSunIntensity: new Uniform(1),
      uShallow: new Uniform(new Color(...o.shallow)),
      uDeep: new Uniform(new Color(...o.deep)),
      uSand: new Uniform(new Color(...this.spec.palette.sand)),
      // Band-limit the sea-floor lookup: continental shelves are hundred-
      // kilometre features, and the fine octaves would only alias.
      uFloorFmax: new Uniform(Math.min(this.field.fmaxFull, 46)),
      uSkyTint: new Uniform(
        new Color(
          ...(this.spec.atmosphere.present ? this.spec.atmosphere.tint : ([0.05, 0.06, 0.09] as any))
        )
      ),
      uEmissive: new Uniform(emissive),
      uCloudTex: new Uniform(null),
      uCloudMidR: new Uniform(this.radius * 1.001),
      uCloudShadow: new Uniform(0),
      ...Object.fromEntries(
        Object.entries(aerialUniformValues(this.spec)).map(([k, v]) => [k, new Uniform(v)])
      ),
    });

    // Far: one sphere, no displacement — at that distance waves are invisible
    // and the silhouette is all that matters.
    const farGeo = new SphereGeometry(r, 128, 96);
    this.oceanFar = new Mesh(
      farGeo,
      new ShaderMaterial({
        vertexShader: OCEAN_VERT,
        fragmentShader: oceanFrag(this.field.glsl()),
        uniforms: mkUniforms(0),
        side: FrontSide,
        toneMapped: false,
      })
    );
    this.root.add(this.oceanFar);

    // Near: a tangent grid that follows the camera and carries the Gerstner
    // displacement, swapped in once you are low enough to see a wave.
    const nearGeo = new PlaneGeometry(1, 1, 160, 160);
    this.oceanNear = new Mesh(
      nearGeo,
      new ShaderMaterial({
        vertexShader: OCEAN_VERT,
        fragmentShader: oceanFrag(this.field.glsl()),
        uniforms: mkUniforms(1),
        side: DoubleSide,
        toneMapped: false,
      })
    );
    this.oceanNear.visible = false;
    this.oceanNear.frustumCulled = false;
    this.root.add(this.oceanNear);
  }

  /* ─────────────────────────── IPlanet ─────────────────────────── */

  heightAt(direction: Vector3): number {
    const d = _d.copy(direction).normalize();
    return this.field.heightN(d.x, d.y, d.z, this.field.fmaxFull) * this.field.maxElev;
  }

  sampleSurface(direction: Vector3): SurfaceSample {
    const d = _d.copy(direction).normalize();
    const s = this.field.sample(d.x, d.y, d.z);
    return {
      elevation: s.elevation,
      normal: new Vector3(s.nx, s.ny, s.nz),
      slope: s.slope,
      temperature: s.temperature,
      humidity: s.humidity,
      biome: s.biome,
      underwater: s.underwater > 0.5,
    };
  }

  ensureDetail(direction: Vector3, radiusM: number): Promise<void> {
    return this.quad.ensureDetail(_d.copy(direction).normalize(), radiusM);
  }

  setSun(directionWorld: Vector3, colorLinear: [number, number, number], intensity: number): void {
    this.sunDir.copy(directionWorld).normalize();
    this.sunColor = colorLinear;
    this.sunIntensity = intensity;
  }

  setViewer(localPosition: Vector3): void {
    this.viewer.copy(localPosition);
  }

  /** Diagnostic: terrain LOD state. */
  stats(): Record<string, any> {
    const q = this.quad.stats();
    // Sample the height field over the whole sphere: if the rendered world is
    // all ocean, this says whether the terrain is genuinely submerged or the
    // sea level is simply in the wrong place.
    const N = 400;
    const sea = this.seaLevelRadius();
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let above = 0;
    const d = new Vector3();
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const t = i * 2.399963;
      d.set(Math.cos(t) * r, y, Math.sin(t) * r);
      const h = this.heightAt(d);
      min = Math.min(min, h);
      max = Math.max(max, h);
      sum += h;
      if (sea > 0 && this.radius + h > sea) above++;
    }
    return {
      ...q,
      builtEver: (this.quad as any).builtEver,
      radius: Math.round(this.radius),
      klass: this.spec.klass,
      hMin: Math.round(min),
      hMax: Math.round(max),
      hMean: Math.round(sum / N),
      maxElev: Math.round(this.field.maxElev),
      seaMinusR: Math.round(sea - this.radius),
      landFrac: Number((above / N).toFixed(3)),
      specLandFrac: this.spec.terrain.landFraction,
      oceanLevel: this.spec.ocean.level,
    };
  }

  isReady(): boolean {
    return this.quad.stats().patches > 0;
  }

  seaLevelRadius(): number {
    return this.spec.ocean.present ? this.field.seaLevelRadius() : 0;
  }

  update(dt: number, ctx: SystemContext): void {
    this.time += dt;
    const size = ctx.renderer.getDrawingBufferSize(_sz);
    this.screenH = size.y;
    this.fovY = ((ctx.camera as any).fov * Math.PI) / 180;

    this.quad.update(this.viewer, this.fovY, this.screenH, dt);

    /* ---- terrain uniforms ---- */
    const tu = this.terrainUniforms;
    tu.uCamLocal.value.copy(this.viewer);
    tu.uSunDir.value.copy(this.sunDir);
    tu.uSunColor.value.setRGB(this.sunColor[0], this.sunColor[1], this.sunColor[2]);
    tu.uSunIntensity.value = this.sunIntensity;
    tu.uTime.value = this.time;
    tu.uLodMorph.value.set(this.quad.lodMorph.subarray(0, Math.min(40, this.quad.lodMorph.length)));

    /* ---- clouds ---- */
    if (this.clouds) {
      // Skylight bouncing back up into the base of the deck. Without it the
      // undersides of clouds go pure black at dusk, which reads as a hole.
      const t = this.spec.atmosphere.present ? this.spec.atmosphere.tint : [0.04, 0.05, 0.07];
      const sky = Math.max(0, this.sunDir.dot(_d.copy(this.viewer).normalize())) * 0.5 + 0.12;
      _amb.setRGB(t[0] * sky, t[1] * sky, t[2] * sky).multiplyScalar(this.sunIntensity * 0.5);
      this.clouds.update(this.viewer, this.sunDir, this.sunColor, this.sunIntensity, _amb, this.time);
      // Bake before anything draws this frame. The deck is the only thing that
      // renders to a target mid-update, so it owns the ordering.
      this.clouds.bake(ctx.renderer, this.time);
    }

    /* ---- atmosphere ---- */
    if (this.atmo) {
      const u = (this.atmo.material as ShaderMaterial).uniforms;
      u.uCam.value.copy(this.viewer);
      u.uSunDir.value.copy(this.sunDir);
      u.uSunColor.value.setRGB(this.sunColor[0], this.sunColor[1], this.sunColor[2]);
      u.uSunIntensity.value = this.sunIntensity;
      u.uSteps.value = this.quality?.atmosphereSteps ?? 16;
    }

    /* ---- ocean ---- */
    if (this.oceanFar && this.oceanNear) {
      const alt = this.viewer.length() - this.field.seaLevelRadius();
      // Below ~8 km the near patch takes over; the sphere stays on behind it
      // to cover the horizon.
      const useNear = alt < 8000;
      this.oceanNear.visible = useNear;

      const apply = (m: Mesh) => {
        const u = (m.material as ShaderMaterial).uniforms;
        u.uTime.value = this.time;
        u.uCamLocal.value.copy(this.viewer);
        u.uSunDir.value.copy(this.sunDir);
        u.uSunColor.value.setRGB(this.sunColor[0], this.sunColor[1], this.sunColor[2]);
        u.uSunIntensity.value = this.sunIntensity;
      };
      apply(this.oceanFar);
      apply(this.oceanNear);

      if (useNear) {
        // Lay the grid on the tangent plane under the camera, sized so it
        // reaches the horizon for the current altitude.
        const up = _d.copy(this.viewer).normalize();
        const horizon = Math.sqrt(Math.max(1, 2 * this.radius * Math.max(2, alt))) * 1.4;
        const span = Math.min(60000, Math.max(400, horizon));
        this.oceanNear.position.copy(up).multiplyScalar(this.field.seaLevelRadius());
        this.oceanNear.quaternion.setFromUnitVectors(_up.set(0, 0, 1), up);
        this.oceanNear.scale.set(span, span, 1);
      }
    }
  }

  private plainMat: MeshNormalMaterial | null = null;
  /**
   * Diagnostic: swap the terrain for a material that needs no lights and no
   * uniforms. If this shows geometry, the patches and their placement are fine
   * and the fault is in the terrain material.
   */
  setPlainTerrain(v: boolean): void {
    if (v) {
      if (!this.plainMat) this.plainMat = new MeshNormalMaterial();
      this.quad.setMaterials(this.plainMat, null);
    } else {
      this.quad.setMaterials(this.terrainMat, null);
    }
  }

  /** Diagnostic: isolate a layer. */
  setLayerVisible(layer: 'ocean' | 'atmosphere' | 'terrain' | 'clouds', v: boolean): void {
    if (layer === 'ocean') {
      if (this.oceanFar) this.oceanFar.visible = v;
      if (this.oceanNear) this.oceanNear.visible = v;
    } else if (layer === 'atmosphere') {
      if (this.atmo) this.atmo.visible = v;
    } else if (layer === 'clouds') {
      if (this.clouds) this.clouds.mesh.visible = v;
    } else {
      this.quad.root.visible = v;
    }
  }

  /**
   * Weather drives the deck. `cloudiness` is the live 0–1 from the weather
   * system; it modulates the world's own climatological base rather than
   * replacing it, so a dry world never turns overcast and a wet one never
   * turns clear.
   */
  setWeather(cloudiness: number): void {
    this.clouds?.setCover(Math.min(1.15, this.clouds.baseCover * (0.45 + 1.25 * cloudiness)));
  }

  setQuality(q: QualityProfile): void {
    this.quality = q;
    this.quad.setOptions({
      maxDepth: Math.min(16, q.terrainMaxDepth),
      patchRes: q.terrainPatchRes,
      budgetMsPerFrame: Math.max(1, q.terrainBudgetPerFrame),
      pixelError: q.tier === 'ultra' ? 1.5 : q.tier === 'high' ? 2.0 : 3.0,
      maxPatches: q.tier === 'ultra' ? 1400 : q.tier === 'high' ? 900 : 500,
    });
    this.clouds?.setQuality(q.tier, q.cloudSteps);
    if (this.clouds) {
      this.terrainUniforms.uCloudTex.value = this.clouds.texture;
      for (const m of [this.oceanFar, this.oceanNear]) {
        if (m) (m.material as ShaderMaterial).uniforms.uCloudTex.value = this.clouds.texture;
      }
    }
    this.terrainMat.flatShading = false;
    this.terrainMat.needsUpdate = true;
  }

  dispose(): void {
    this.quad.dispose();
    this.terrainMat.dispose();
    this.clouds?.dispose();
    if (this.clouds) this.root.remove(this.clouds.mesh);
    for (const m of [this.atmo, this.oceanFar, this.oceanNear]) {
      if (!m) continue;
      this.root.remove(m);
      m.geometry.dispose();
      (m.material as ShaderMaterial).dispose();
    }
    this.atmo = null;
    this.oceanFar = null;
    this.oceanNear = null;
    this.clouds = null;
  }
}

const _d = new Vector3();
const _up = new Vector3();
const _amb = new Color();
const _sz = new Vector2();
