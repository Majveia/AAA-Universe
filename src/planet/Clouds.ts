/**
 * The cloud deck.
 *
 * A raymarched shell between two radii. Not a scrolling texture on a sphere —
 * the thing that makes clouds read as *weather* rather than as paint is that
 * they have thickness: they are lit from the side at the terminator, they
 * self-shadow, their edges are translucent and their cores are not, and they
 * sit above the ground so they throw the terrain into shade.
 *
 * THE ONE ARCHITECTURAL DECISION THAT MATTERS. Coverage is a function of
 * direction only — a deck a few kilometres thick on a body thousands of
 * kilometres across is, to a very good approximation, two-dimensional. So the
 * expensive part (a domain-warped, latitude-banded fBm) is evaluated once per
 * frame into an equirectangular texture, and the raymarch does a texture fetch
 * per step instead of fifteen noise evaluations. That is the difference
 * between ~500 noise calls per screen pixel and ~1, and it is why this can run
 * at sixty frames while still marching sixteen steps with a three-tap sun
 * march inside each one. The terrain samples the same texture for its shadows,
 * so a dark patch on the ground is always genuinely under the cloud that made it.
 *
 * The lighting model, in order of how much each term matters:
 *
 *   • BEER–LAMBERT along the view ray. Optical depth accumulates and radiance
 *     behind thick cloud is extinguished. This is a storm cell's dark base.
 *   • HENYEY–GREENSTEIN phase, strongly forward. Edges facing the sun blaze —
 *     the silver lining — while the same cloud from behind is nearly grey.
 *   • POWDER. Beer alone makes cloud darkest where it is thickest even when
 *     facing the light, which is backwards for what the eye expects. The
 *     (1 - e^-2τ) term restores the dark-edge / bright-core look of cumulus.
 *   • A short march toward the sun for self-shadowing. Three taps: the field
 *     is smooth and the eye only needs the gradient.
 */

import {
  BackSide,
  ClampToEdgeWrapping,
  FrontSide,
  Color,
  LinearFilter,
  Mesh,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Uniform,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { GLSL_NOISE } from '../core/Noise';
import { Rng } from '../core/Rand';
import type { PlanetSpec } from '../universe/Types';

/* ═══════════════════════════════════════════════════════════════════════════
   Shared GLSL — the equirect mapping, used by everything that reads the deck
   ═══════════════════════════════════════════════════════════════════════════ */

export const CLOUD_SAMPLE_GLSL = /* glsl */ `
#ifndef AEON_CLOUD_SAMPLE
#define AEON_CLOUD_SAMPLE

/**
 * Direction to equirectangular UV. The seam at u = 0 is handled by wrapping the
 * texture in x, so bilinear filtering crosses it correctly; the poles squash,
 * which nobody has ever noticed on a cloud.
 */
vec2 aeCloudUv(vec3 d){
  return vec2(atan(d.z, d.x) * 0.1591549431 + 0.5,
              asin(clamp(d.y, -1.0, 1.0)) * 0.3183098862 + 0.5);
}

/** Vertical profile: flat bottoms, cauliflower tops, nothing above the anvil. */
float aeCloudProfile(float hN){
  return smoothstep(0.0, 0.14, hN) * (1.0 - smoothstep(0.42, 1.0, hN));
}

/**
 * Shadow thrown on a point below the deck. Solves where the ray from the point
 * toward the sun crosses the middle of the deck and reads the coverage there —
 * one intersection and one fetch, which is why the ground can afford a shadow
 * that actually tracks the cloud above it.
 */
float aeCloudShadow(sampler2D tex, vec3 p, vec3 sunDir, float rMid){
  float b = dot(p, sunDir);
  float c = dot(p, p) - rMid * rMid;
  float h = b * b - c;
  if (h < 0.0) return 0.0;
  float t = -b + sqrt(h);
  if (t < 0.0) return 0.0;
  vec3 q = normalize(p + sunDir * t);
  // Green channel: the same field without its billow octaves. A shadow four
  // kilometres below its caster has no business carrying metre-scale detail.
  return texture2D(tex, aeCloudUv(q)).g;
}

#endif
`;

/* ═══════════════════════════════════════════════════════════════════════════
   Pass 1 — bake coverage into an equirect texture
   ═══════════════════════════════════════════════════════════════════════════ */

const FIELD_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FIELD_FRAG = /* glsl */ `
precision highp float;
${GLSL_NOISE}

uniform vec3  uAxis;
uniform vec3  uOfs;
uniform float uTime;
uniform float uWind;
uniform float uBands;
uniform float uCover;

varying vec2 vUv;

/** Rodrigues rotation of a vector about a unit axis. */
vec3 aeSpin(vec3 v, vec3 axis, float a){
  float c = cos(a), s = sin(a);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

void main(){
  // Undo the equirect mapping to recover the direction this texel stands for.
  float lon = (vUv.x - 0.5) * 6.2831853072;
  float lat = (vUv.y - 0.5) * 3.1415926536;
  float cl = cos(lat);
  vec3 d = vec3(cl * cos(lon), sin(lat), cl * sin(lon));

  float mu = clamp(dot(d, uAxis), -1.0, 1.0);
  // Differential rotation: the equator runs ahead of the poles, which is what
  // shears straight bands into the hooks and spirals of real weather.
  vec3 dr = aeSpin(d, uAxis, uTime * uWind * (1.0 - 0.55 * mu * mu));

  // Curl-ish domain warp. Two scales of warp — eddies inside eddies — which is
  // most of what separates a weather system from a cloud of static.
  vec3 w1 = vec3(snoise(dr * 1.7 + uOfs),
                 snoise(dr * 1.7 + uOfs.yzx * 1.31 + 11.0),
                 snoise(dr * 1.7 + uOfs.zxy * 0.77 - 7.0));
  vec3 q = dr + w1 * 0.42;

  // Circulation bands. The phase wobbles with a low-frequency noise so the
  // stripes meander instead of ringing the planet like a barcode.
  float phi = asin(mu);
  float bands = 0.5 + 0.5 * sin(phi * uBands + snoise(dr * 1.1) * 1.5);
  // The intertropical convergence zone is the wettest line on any wet world.
  float itcz = exp(-phi * phi * 26.0) * 0.5;
  float cov = clamp(uCover * (0.62 + 0.76 * bands + itcz), 0.0, 1.4);

  // Low-frequency mass. This alone is the shadow-caster.
  float lo = fbm(q * 3.4, 3) * 0.5 + 0.5;
  float loD = smoothstep(1.0 - cov, 1.0 - cov + 0.34, lo);

  // Full detail: another two octaves of mass, then billows eaten out of the
  // edges so they are ragged rather than smoothstep-smooth.
  vec3 q2 = q + vec3(snoise(q * 6.1), snoise(q * 6.1 + 3.7), snoise(q * 6.1 - 2.3)) * 0.075;
  float base = fbm(q2 * 3.4, 5) * 0.5 + 0.5;
  float dens = smoothstep(1.0 - cov, 1.0 - cov + 0.30, base);
  float bill = fbm(q2 * 15.0, 4) * 0.5 + 0.5;
  dens = clamp(dens - (1.0 - bill) * 0.44 * (1.0 - dens * 0.55), 0.0, 1.0);

  // B carries the local storm intensity: where the deck is deep, it is dark and
  // tall. The shell march uses it to thicken the profile.
  float tower = smoothstep(0.55, 1.0, dens) * smoothstep(0.3, 0.8, loD);

  gl_FragColor = vec4(dens, loD, tower, 1.0);
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   Pass 2 — march the shell
   ═══════════════════════════════════════════════════════════════════════════ */

const VERT = /* glsl */ `
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

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}
${CLOUD_SAMPLE_GLSL}

uniform sampler2D uCloudTex;
uniform vec3  uCam;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uAmbient;
uniform float uRGround;
uniform float uRBase;
uniform float uRTop;
uniform float uTime;
uniform float uDensity;
uniform float uSteps;
uniform vec3  uTint;
uniform float uDetail;   // 1 when the camera is close enough to need billows

varying vec3 vWorld;

vec2 raySphere(vec3 o, vec3 d, float r){
  float b = dot(o, d);
  float c = dot(o, o) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

float hg(float mu, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

/**
 * Density at a point. The baked texture carries the shape; close to the deck
 * we cut it with a world-space billow so the texel grid never becomes visible
 * from underneath, where a single texel spans tens of kilometres of sky.
 */
float density(vec3 p, float r){
  float hN = (r - uRBase) / max(1.0, uRTop - uRBase);
  if (hN < 0.0 || hN > 1.0) return 0.0;
  vec3 d = p / r;
  vec4 f = texture2D(uCloudTex, aeCloudUv(d));
  // Towers reach higher: a convective cell is tall, a stratus sheet is not.
  float prof = aeCloudProfile(hN * (1.0 - 0.42 * f.b));
  float dens = f.r * prof;
  if (uDetail > 0.001 && dens > 0.001) {
    float bill = fbm(p * 0.00042 + vec3(0.0, uTime * 0.006, 0.0), 4) * 0.5 + 0.5;
    dens *= mix(1.0, clamp(bill * 1.7, 0.0, 1.0), uDetail);
  }
  return dens * uDensity;
}

void main(){
  #include <logdepthbuf_fragment>

  vec3 ro = uCam;
  vec3 rd = normalize(vWorld - uCam);

  vec2 tTop = raySphere(ro, rd, uRTop);
  if (tTop.y < 0.0) discard;
  vec2 tBase = raySphere(ro, rd, uRBase);
  float camR = length(ro);

  float t0, t1;
  if (camR > uRTop) {
    // Looking in from outside: enter the shell, leave when we hit the deck's
    // underside or exit the far side of the outer sphere.
    t0 = max(tTop.x, 0.0);
    t1 = (tBase.y > 0.0 && tBase.x > 0.0) ? tBase.x : tTop.y;
  } else if (camR > uRBase) {
    t0 = 0.0;
    t1 = (tBase.y > 0.0 && tBase.x > 0.0) ? tBase.x : tTop.y;
  } else {
    if (tBase.y < 0.0) discard;   // below the deck, looking away from it
    t0 = max(tBase.y, 0.0);
    t1 = tTop.y;
  }

  // Never march past the ground.
  vec2 tG = raySphere(ro, rd, uRGround);
  if (tG.y > 0.0 && tG.x > 0.0) t1 = min(t1, tG.x);
  if (t1 <= t0 + 1.0) discard;

  int steps = int(clamp(uSteps, 4.0, 64.0));
  float len = (t1 - t0) / float(steps);
  float shell = max(1.0, uRTop - uRBase);

  float mu = dot(rd, uSunDir);
  // Two lobes: a strong forward one for the halo around the sun, a weak
  // backward one so the anti-solar side is not perfectly flat.
  float ph = mix(hg(mu, 0.78), hg(mu, -0.28), 0.22) * 4.0 * PI;

  float sunStep = shell * 0.34;

  vec3 scatter = vec3(0.0);
  float trans = 1.0;

  // Dither the first sample so a dozen steps do not band the terminator.
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

  for (int i = 0; i < 64; i++){
    if (i >= steps || trans < 0.012) break;
    vec3 p = ro + rd * (t0 + len * (float(i) + jitter));
    float r = length(p);
    float dens = density(p, r);
    if (dens < 0.0015) continue;

    // Self-shadow: optical depth toward the sun over three taps.
    float sod = 0.0;
    for (int j = 0; j < 3; j++){
      vec3 sp = p + uSunDir * (sunStep * (float(j) + 0.5));
      sod += density(sp, length(sp)) * sunStep;
    }
    // The planet shadows its own deck on the night side.
    vec2 occl = raySphere(p, uSunDir, uRGround);
    float lit = (occl.y > 0.0 && occl.x > 0.0) ? 0.0 : 1.0;

    float sunT = exp(-sod * 1.15);
    float dt = dens * len;
    float powder = 1.0 - exp(-dt * 2.4);

    float hN = clamp((r - uRBase) / shell, 0.0, 1.0);
    vec3 lightIn = uSunColor * uSunIntensity * sunT * ph * powder * lit
                 + uAmbient * (0.35 + 0.65 * hN);

    // Analytic integration of the segment: energy-conserving even at 8 steps.
    float ext = exp(-dt);
    scatter += trans * (1.0 - ext) * lightIn * uTint;
    trans *= ext;
  }

  float alpha = clamp(1.0 - trans, 0.0, 1.0);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(max(scatter, 0.0), alpha);
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   CloudDeck
   ═══════════════════════════════════════════════════════════════════════════ */

const FIELD_RES: Record<string, number> = {
  potato: 0,
  low: 384,
  medium: 640,
  high: 1024,
  ultra: 1536,
};

export class CloudDeck {
  readonly mesh: Mesh;
  /** Coverage before weather modulates it. */
  readonly baseCover: number;
  readonly rBase: number;
  readonly rTop: number;
  readonly axis: Vector3;

  private target: WebGLRenderTarget;
  private fieldScene = new Scene();
  private fieldCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private fieldMat: ShaderMaterial;
  private fieldQuad: Mesh;
  private shellMat: ShaderMaterial;
  private res = 384;
  private width = 384;

  constructor(spec: PlanetSpec) {
    const a = spec.atmosphere;
    const rng = new Rng(spec.seed ^ 0x51f0a3d7);

    // Condensation needs something to condense. An ocean world in the habitable
    // zone is overcast; a hot dry rock manages a thin haze deck at best.
    const wet = spec.ocean.present ? (spec.ocean.fluid === 'water' ? 1 : 0.45) : 0.12;
    const temperate = Math.exp(-Math.pow((spec.tempK - 288) / 190, 2));
    const thick = Math.min(1.6, Math.pow(a.surfacePressurePa / 101325, 0.4));
    this.baseCover = Math.min(0.95, 0.10 + 0.72 * wet * (0.35 + 0.65 * temperate) * thick);

    // Cumulus sit near 1.5 km under Earth's 8.5 km scale height, and the deck
    // runs a few km thick.
    const base = Math.max(600, a.scaleHeightM * 0.19);
    const top = base + Math.max(1400, a.scaleHeightM * 0.62);
    this.rBase = spec.radiusM + base;
    this.rTop = spec.radiusM + top;

    // Bands follow the spin axis. Fast rotators get more of them — Jupiter has
    // many narrow belts, Venus effectively one.
    const dayS = Math.max(1, spec.rotationS);
    const bands = Math.round(Math.min(22, Math.max(3, 900000 / dayS + 2)));
    const tilt = spec.axialTiltRad || 0;
    this.axis = new Vector3(Math.sin(tilt), Math.cos(tilt), 0).normalize();

    this.target = makeTarget(this.res);

    this.fieldMat = new ShaderMaterial({
      vertexShader: FIELD_VERT,
      fragmentShader: FIELD_FRAG,
      uniforms: {
        uAxis: new Uniform(this.axis.clone()),
        uOfs: new Uniform(
          new Vector3(rng.range(-40, 40), rng.range(-40, 40), rng.range(-40, 40))
        ),
        uTime: new Uniform(0),
        // Weather outruns the ground: about a fifth of a rotation per day on
        // Earth, plus a contribution from the world's own mean wind.
        uWind: new Uniform(((2 * Math.PI) / dayS) * 0.22 + a.windSpeed * 2e-6),
        uBands: new Uniform(bands),
        uCover: new Uniform(this.baseCover),
      },
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
    this.fieldQuad = new Mesh(new PlaneGeometry(2, 2), this.fieldMat);
    this.fieldQuad.frustumCulled = false;
    this.fieldScene.add(this.fieldQuad);

    this.shellMat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uCloudTex: new Uniform(this.target.texture),
        uCam: new Uniform(new Vector3()),
        uSunDir: new Uniform(new Vector3(1, 0, 0)),
        uSunColor: new Uniform(new Color(1, 1, 1)),
        uSunIntensity: new Uniform(1),
        uAmbient: new Uniform(new Color(0.03, 0.045, 0.07)),
        uRGround: new Uniform(spec.radiusM),
        uRBase: new Uniform(this.rBase),
        uRTop: new Uniform(this.rTop),
        uTime: new Uniform(0),
        // Normalised so a fully covered column has optical depth ≈ 5.5, which
        // is opaque without being a wall.
        uDensity: new Uniform(5.5 / Math.max(400, top - base)),
        uSteps: new Uniform(16),
        uTint: new Uniform(new Color(...cloudTint(spec))),
        uDetail: new Uniform(0),
      },
      transparent: true,
      depthWrite: false,
      // Flipped per frame in update(): front faces while the camera is outside
      // the shell (so the deck draws *in front of* the terrain and survives the
      // depth test), back faces once inside it (so it still covers the sky).
      side: FrontSide,
      premultipliedAlpha: true,
      toneMapped: false,
    });

    this.mesh = new Mesh(new SphereGeometry(this.rTop, 96, 64), this.shellMat);
    this.mesh.renderOrder = 4; // beneath the atmosphere shell, over the terrain
    this.mesh.frustumCulled = false;
  }

  get texture() {
    return this.target.texture;
  }
  get midRadius(): number {
    return (this.rBase + this.rTop) * 0.5;
  }
  get uniforms() {
    return this.shellMat.uniforms;
  }

  setCover(v: number): void {
    this.fieldMat.uniforms.uCover.value = v;
  }

  setQuality(tier: string, steps: number): void {
    this.shellMat.uniforms.uSteps.value = steps;
    this.mesh.visible = steps > 0;
    const want = FIELD_RES[tier] ?? 512;
    if (want > 0 && want !== this.width) {
      this.target.dispose();
      this.width = want;
      this.target = makeTarget(want);
      this.shellMat.uniforms.uCloudTex.value = this.target.texture;
    }
  }

  /**
   * Re-bake the coverage texture. Cheap — one fullscreen pass at a fraction of
   * screen resolution — but it must run before the shell is drawn, so the realm
   * calls it from its own update rather than leaving it to the render loop.
   */
  bake(renderer: WebGLRenderer, time: number): void {
    if (!this.mesh.visible) return;
    this.fieldMat.uniforms.uTime.value = time;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(this.fieldScene, this.fieldCam);
    renderer.setRenderTarget(prev);
  }

  update(
    viewer: Vector3,
    sunDir: Vector3,
    sunColor: [number, number, number],
    sunIntensity: number,
    ambient: Color,
    time: number
  ): void {
    const u = this.shellMat.uniforms;
    u.uCam.value.copy(viewer);
    u.uSunDir.value.copy(sunDir);
    u.uSunColor.value.setRGB(sunColor[0], sunColor[1], sunColor[2]);
    u.uSunIntensity.value = sunIntensity;
    u.uAmbient.value.copy(ambient);
    u.uTime.value = time;
    // A texel of the baked field spans tens of kilometres. From orbit that is
    // finer than a pixel; from underneath it is the whole sky, so fade in a
    // world-space billow as the camera approaches the deck.
    const r = viewer.length();
    u.uDetail.value = 1 - smoothstep(this.rTop, this.rTop * 1.9, r);
    this.shellMat.side = r > this.rTop ? FrontSide : BackSide;
  }

  dispose(): void {
    this.target.dispose();
    this.fieldMat.dispose();
    this.fieldQuad.geometry.dispose();
    this.shellMat.dispose();
    this.mesh.geometry.dispose();
  }
}

function makeTarget(w: number): WebGLRenderTarget {
  const t = new WebGLRenderTarget(w, w / 2, {
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: false,
  });
  // Wrap in longitude so bilinear filtering crosses the seam correctly; clamp
  // in latitude so it does not wrap the north pole into the south.
  t.texture.wrapS = RepeatWrapping;
  t.texture.wrapT = ClampToEdgeWrapping;
  return t;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Cloud is white on Earth because water is. Elsewhere it is whatever condensed. */
function cloudTint(spec: PlanetSpec): [number, number, number] {
  switch (spec.klass) {
    case 'toxic':
      return [1.0, 0.86, 0.55];
    case 'desert':
      return [1.0, 0.94, 0.84];
    case 'exotic':
      return [0.86, 0.92, 1.0];
    case 'molten':
      // Ash and sulphur, not water vapour.
      return [0.72, 0.62, 0.56];
    default:
      return [1.0, 1.0, 1.0];
  }
}

/** Worlds with no air, or air too thin to hold anything, get no deck. */
export function makeClouds(spec: PlanetSpec): CloudDeck | null {
  if (!spec.atmosphere.present || spec.atmosphere.surfacePressurePa < 3000) return null;
  return new CloudDeck(spec);
}
