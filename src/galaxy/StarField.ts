/**
 * The resolved stars: up to a couple of million individually placed points,
 * generated across frames and animated entirely on the GPU.
 *
 * Two ideas do most of the work here.
 *
 * **Energy conservation at the sub-pixel limit.** A star further away must get
 * *dimmer*, not just smaller — but a point primitive cannot be smaller than one
 * pixel. So below one pixel we hold the size at 1 and scale the radiance by the
 * square of the size it *should* have had. Without this the outer disc turns
 * into a flat white sheet of minimum-size dots; with it, a galaxy falls off
 * exactly the way a galaxy falls off.
 *
 * **Density-wave bunching.** Disc stars are stored on axisymmetric orbits and
 * pushed into the arms by the vertex shader against the live pattern phase
 * (θ → θ − (ε/m)·sin(mΔθ), whose Jacobian gives a 1/(1−ε) density crest). The
 * arms therefore have real density contrast, real brightness contrast, and can
 * never wind up — while individual stars visibly slide through them.
 *
 * The dust layer is a separate, later pass, so the star cloud is drawn twice:
 * once for the half of the disc behind the dust, once for the half in front,
 * with a soft complementary weight across the mid-plane so nothing pops.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Points,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import { GLSL_NOISE } from '../core/Noise';
import { Rng } from '../core/Rand';
import { GLSL_GALAXY, GalaxyModel, POP, StarSample } from './GalaxyModel';

const STAR_VERT = /* glsl */ `
${GLSL_NOISE}
${GLSL_GALAXY}

attribute vec4 aColor;   // rgb + kinematic population packed into alpha
attribute float aLum;

uniform float uPixPerRad;
uniform float uCoreLy;
uniform float uMaxSize;
uniform float uGain;
uniform float uSide;     // -1 / 0 / +1 — which side of the dust layer this pass draws
uniform float uSplitH;
uniform float uFade;

varying vec3 vColor;
varying float vI;

#include <common>
#include <logdepthbuf_pars_vertex>

void main(){
  vec3 p = position;
  float pop = floor(aColor.a * 255.0 / 32.0 + 0.5);
  vec3 col = aColor.rgb;
  float boost = 1.0;

  if (pop < 0.5){
    // Old thin disc. Ω(r) shears it; the arm potential bunches it.
    float r  = length(p.xz);
    float th = atan(p.z, p.x) + galaxyOmega(r) * uGalTime;
    if (uArms > 0.5){
      float ph = galaxyArmPhase(r, th, 0.0);
      float gate = smoothstep(uArmR0 * 0.6, uArmR0 * 2.0, r)
                 * (1.0 - smoothstep(uRadius * 0.72, uRadius * 1.12, r));
      float bunch = uArmBunch * gate;
      th -= (bunch / uArms) * sin(ph);
      r  *= 1.0 - 0.05 * bunch * cos(ph);
      float w = pow(max(0.5 + 0.5 * cos(ph), 0.0), 2.4) * gate;
      // Crossing the shock triggers star formation, so the crest is brighter
      // and bluer than the average of the stars that pass through it.
      boost = 1.0 + w * uArmStrength * 0.9;
      col = mix(col, uArmColor, w * 0.4 * uSfr);
    }
    p = vec3(cos(th) * r, p.y, sin(th) * r);
  } else if (pop < 2.5){
    // Young stars and the bar both ride the pattern: the OB stars because they
    // die before they can leave the arm, the bar because it is a solid body.
    p = galaxyRotY(p, uPattern);
  } else {
    p = galaxyRotY(p, uPattern * 0.10);
  }

  float w = 1.0;
  if (uSide != 0.0) w = smoothstep(-uSplitH, uSplitH, p.y * uSide);
  if (w < 0.004){
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vI = 0.0;
    return;
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 1.0);
  float lum = aLum * boost;

  float want = uCoreLy * sqrt(lum) * uPixPerRad / dist;
  float s = clamp(want, 1.0, uMaxSize);

  vColor = col;
  vI = uGain * lum * w * uFade / (dist * dist * s * s);
  gl_PointSize = s;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;

varying vec3 vColor;
varying float vI;

#include <common>
#include <logdepthbuf_pars_fragment>

void main(){
  #include <logdepthbuf_fragment>
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;
  // A real point spread function is a tight core sitting in a broad skirt. The
  // skirt is what makes a bright star read as *bright* rather than merely big.
  float a = exp(-r2 * 5.5) + 0.26 * exp(-r2 * 1.35);
  gl_FragColor = vec4(vColor * (vI * a), 1.0);
}
`;

/** HII complexes and globular clusters: extended, so their size is physical. */
const BLOB_VERT = /* glsl */ `
${GLSL_NOISE}
${GLSL_GALAXY}

attribute vec4 aColor;
attribute float aLum;
attribute float aSize;   // physical radius, light years

uniform float uPixPerRad;
uniform float uMaxSize;
uniform float uGain;
uniform float uSide;
uniform float uSplitH;
uniform float uFade;
uniform float uPatternMix;

varying vec3 vColor;
varying float vI;
varying float vSoft;

#include <common>
#include <logdepthbuf_pars_vertex>

void main(){
  vec3 p = galaxyRotY(position, uPattern * uPatternMix);

  float w = 1.0;
  if (uSide != 0.0) w = smoothstep(-uSplitH, uSplitH, p.y * uSide);
  if (w < 0.004){
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0); vI = 0.0; vSoft = 0.0;
    return;
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dist = max(-mv.z, 1.0);
  float want = aSize * uPixPerRad / dist;
  float s = clamp(want, 1.0, uMaxSize);
  // Once it shrinks below a pixel the cloud is a point source like any other.
  vSoft = clamp(want / max(s, 1e-3), 0.0, 1.0);

  vColor = aColor.rgb;
  vI = uGain * aLum * w * uFade / (dist * dist * s * s);
  gl_PointSize = s;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const BLOB_FRAG = /* glsl */ `
precision highp float;

varying vec3 vColor;
varying float vI;
varying float vSoft;

#include <common>
#include <logdepthbuf_pars_fragment>

void main(){
  #include <logdepthbuf_fragment>
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;
  float k = mix(6.5, 1.6, vSoft);
  float a = exp(-r2 * k) + 0.30 * exp(-r2 * 0.85);
  gl_FragColor = vec4(vColor * (vI * a), 1.0);
}
`;

interface Layer {
  far: Points;
  near: Points;
  matFar: ShaderMaterial;
  matNear: ShaderMaterial;
  geo: BufferGeometry;
  /** Peak radiance of a fully resolved element. */
  surface: number;
  /** Physical radius of a unit-luminosity element, ly (point stars only). */
  coreLy: number;
  /** Extended sources have their size from an attribute, not from luminosity. */
  extended: boolean;
  /** Halo objects sit outside the dust layer and never need the split. */
  split: boolean;
}

export class StarField {
  /** Everything this system contributes to the scene graph. */
  readonly objects: Points[] = [];

  private model: GalaxyModel;
  private shared: Record<string, { value: any }>;
  private layers: Layer[] = [];

  private geo!: BufferGeometry;
  private posArr!: Float32Array;
  private colArr!: Uint8Array;
  private lumArr!: Float32Array;
  private count = 0;
  private built = 0;
  private rng: Rng;
  private s: StarSample = { x: 0, y: 0, z: 0, r: 1, g: 1, b: 1, lum: 1, pop: 0 };
  private drawFraction = 1;
  /**
   * Scalar exposure on top of the physical gain. The surface-brightness law
   * below is correct but lands in the hundreds for the brightest stars, and
   * AgX renders that much overshoot as green-yellow before it clips. This is
   * the photographic stop, not a fudge of the physics.
   */
  exposure = 0.15;

  constructor(model: GalaxyModel, shared: Record<string, { value: any }>, budget: number) {
    this.model = model;
    this.shared = shared;
    this.rng = new Rng(model.seed ^ 0x51a7);
    this.count = Math.max(4096, Math.floor(budget));

    this.buildStars();
    this.buildHII();
    this.buildGlobulars();

    // Seed the first slice synchronously so the opening frame is never empty.
    this.grow(Math.min(this.count, 45000));
  }

  /* ───────────────────────── construction ───────────────────────── */

  private newMaterial(vert: string, frag: string, extra: Record<string, any>): ShaderMaterial {
    const uniforms: Record<string, { value: any }> = { ...this.shared };
    uniforms.uPixPerRad = { value: 700 };
    uniforms.uGain = { value: 1 };
    uniforms.uSide = { value: 0 };
    uniforms.uSplitH = { value: this.model.hz * 1.1 };
    uniforms.uFade = { value: 1 };
    for (const k in extra) uniforms[k] = { value: extra[k] };
    return new ShaderMaterial({
      uniforms,
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      // No GLSL3 here. three only omits its gl_FragColor compatibility define
      // when glslVersion is set explicitly to and these shaders are
      // written against GLSL1 (gl_FragColor, varying) with no 3.0-only
      // features — so declaring 3.0 just breaks them.
    });
  }

  private addLayer(
    geo: BufferGeometry,
    vert: string,
    frag: string,
    extra: Record<string, any>,
    cfg: { surface: number; coreLy: number; extended: boolean; split: boolean; order: number }
  ): Layer {
    const matFar = this.newMaterial(vert, frag, extra);
    const matNear = this.newMaterial(vert, frag, extra);
    const far = new Points(geo, matFar);
    const near = new Points(geo, matNear);
    far.frustumCulled = false;
    near.frustumCulled = false;
    far.renderOrder = cfg.order;
    near.renderOrder = cfg.order + 20;
    this.objects.push(far, near);
    const layer: Layer = {
      far,
      near,
      matFar,
      matNear,
      geo,
      surface: cfg.surface,
      coreLy: cfg.coreLy,
      extended: cfg.extended,
      split: cfg.split,
    };
    this.layers.push(layer);
    return layer;
  }

  private buildStars(): void {
    const n = this.count;
    this.posArr = new Float32Array(n * 3);
    this.colArr = new Uint8Array(n * 4);
    this.lumArr = new Float32Array(n);

    const g = new BufferGeometry();
    // BufferAttribute (not Float32BufferAttribute) keeps *our* array, which is
    // what lets the generator keep writing into it across frames.
    g.setAttribute('position', new BufferAttribute(this.posArr, 3));
    g.setAttribute('aColor', new BufferAttribute(this.colArr, 4, true));
    g.setAttribute('aLum', new BufferAttribute(this.lumArr, 1));
    g.boundingSphere = new Sphere(new Vector3(0, 0, 0), this.model.radius * 2.4);
    g.setDrawRange(0, 0);
    this.geo = g;

    this.addLayer(g, STAR_VERT, STAR_FRAG, { uCoreLy: 5.5, uMaxSize: 30 }, {
      surface: 24,
      coreLy: 5.5,
      extended: false,
      split: true,
      order: 10,
    });
  }

  private buildHII(): void {
    const m = this.model;
    const rng = new Rng(m.seed ^ 0x2b19);
    const count = Math.max(0, Math.round(90 + 1000 * m.sfrNorm));
    if (count === 0) return;

    const pos = new Float32Array(count * 3);
    const col = new Uint8Array(count * 4);
    const lum = new Float32Array(count);
    const size = new Float32Array(count);
    const s = this.s;
    for (let i = 0; i < count; i++) {
      m.sampleHII(rng, s);
      pos[i * 3] = s.x;
      pos[i * 3 + 1] = s.y;
      pos[i * 3 + 2] = s.z;
      // Hα is a line, not a continuum: it is more saturated than any blackbody
      // can be. Store the hue normalised and push the excess into luminosity.
      const mx = Math.max(s.r, s.g, s.b, 1e-3);
      col[i * 4] = Math.round(Math.min(1, s.r / mx) * 255);
      col[i * 4 + 1] = Math.round(Math.min(1, s.g / mx) * 255);
      col[i * 4 + 2] = Math.round(Math.min(1, s.b / mx) * 255);
      col[i * 4 + 3] = POP.YOUNG * 32;
      lum[i] = s.lum * mx;
      // Orion is 24 ly across, 30 Doradus is 600. A power law, as usual.
      size[i] = rng.powerLaw(16, 380, -1.9);
    }

    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aColor', new BufferAttribute(col, 4, true));
    g.setAttribute('aLum', new BufferAttribute(lum, 1));
    g.setAttribute('aSize', new BufferAttribute(size, 1));
    g.boundingSphere = new Sphere(new Vector3(0, 0, 0), m.radius * 2.4);

    this.addLayer(g, BLOB_VERT, BLOB_FRAG, { uMaxSize: 260, uPatternMix: 1 }, {
      surface: 0.8,
      coreLy: 1,
      extended: true,
      split: true,
      order: 12,
    });
  }

  private buildGlobulars(): void {
    const m = this.model;
    const n = m.clusters.length;
    if (n === 0) return;
    const pos = new Float32Array(n * 3);
    const col = new Uint8Array(n * 4);
    const lum = new Float32Array(n);
    const size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = m.clusters[i];
      pos[i * 3] = c.x;
      pos[i * 3 + 1] = c.y;
      pos[i * 3 + 2] = c.z;
      col[i * 4] = Math.round(Math.min(1, c.color[0]) * 255);
      col[i * 4 + 1] = Math.round(Math.min(1, c.color[1]) * 255);
      col[i * 4 + 2] = Math.round(Math.min(1, c.color[2]) * 255);
      col[i * 4 + 3] = POP.HALO * 32;
      lum[i] = c.lum * 90;
      size[i] = c.radiusLy * 1.5;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aColor', new BufferAttribute(col, 4, true));
    g.setAttribute('aLum', new BufferAttribute(lum, 1));
    g.setAttribute('aSize', new BufferAttribute(size, 1));
    g.boundingSphere = new Sphere(new Vector3(0, 0, 0), m.radius * 2.6);

    this.addLayer(g, BLOB_VERT, BLOB_FRAG, { uMaxSize: 110, uPatternMix: 0.1 }, {
      surface: 0.7,
      coreLy: 1,
      extended: true,
      split: false,
      order: 14,
    });
  }

  /* ───────────────────────── progressive fill ───────────────────────── */

  get complete(): boolean {
    return this.built >= this.count;
  }

  get progress(): number {
    return this.count > 0 ? this.built / this.count : 1;
  }

  get total(): number {
    return this.count;
  }

  /** Generate up to `n` more stars. Returns how many were actually added. */
  grow(n: number): number {
    const end = Math.min(this.count, this.built + n);
    const start = this.built;
    if (end <= start) return 0;

    const s = this.s;
    const pos = this.posArr;
    const col = this.colArr;
    const lum = this.lumArr;
    for (let i = start; i < end; i++) {
      this.model.sample(this.rng, s);
      pos[i * 3] = s.x;
      pos[i * 3 + 1] = s.y;
      pos[i * 3 + 2] = s.z;
      col[i * 4] = (s.r * 255) | 0;
      col[i * 4 + 1] = (s.g * 255) | 0;
      col[i * 4 + 2] = (s.b * 255) | 0;
      col[i * 4 + 3] = s.pop * 32;
      lum[i] = s.lum;
    }
    this.built = end;

    // Patch only the slice that changed — re-uploading 30 MB every frame while
    // the galaxy assembles would hitch worse than building it all at once.
    const pa = this.geo.getAttribute('position') as BufferAttribute;
    const ca = this.geo.getAttribute('aColor') as BufferAttribute;
    const la = this.geo.getAttribute('aLum') as BufferAttribute;
    pa.addUpdateRange(start * 3, (end - start) * 3);
    ca.addUpdateRange(start * 4, (end - start) * 4);
    la.addUpdateRange(start, end - start);
    pa.needsUpdate = true;
    ca.needsUpdate = true;
    la.needsUpdate = true;
    this.geo.setDrawRange(0, Math.floor(this.built * this.drawFraction));
    return end - start;
  }

  /* ───────────────────────── per frame ───────────────────────── */

  /**
   * @param camLocal   camera position in galaxy-local light years
   * @param pixPerRad  viewport pixels per radian — the size/energy law needs it
   * @param dusty      false for galaxies with no dust worth splitting around
   */
  update(camLocal: Vector3, pixPerRad: number, dusty: boolean, fade: number): void {
    const side = dusty ? (camLocal.y >= 0 ? 1 : -1) : 0;
    for (const L of this.layers) {
      const s = L.split ? side : 0;
      // Resolved surface brightness is held constant, so the gain has to absorb
      // the current projection scale: see the derivation in the vertex shader.
      const gain = (L.extended ? L.surface : L.surface * (L.coreLy * pixPerRad) * (L.coreLy * pixPerRad)) * this.exposure;
      for (const mat of [L.matFar, L.matNear]) {
        mat.uniforms.uPixPerRad.value = pixPerRad;
        mat.uniforms.uFade.value = fade;
        mat.uniforms.uGain.value = gain;
      }
      L.matNear.uniforms.uSide.value = s;
      L.matFar.uniforms.uSide.value = -s;
      // With nothing to hide behind, one pass draws the lot rather than burning
      // a second million vertex invocations on stars that are all weighted out.
      L.far.visible = s !== 0;
    }
  }

  /** Quality dial: draw a fraction of the generated stars. */
  setDrawFraction(f: number): void {
    this.drawFraction = Math.max(0.05, Math.min(1, f));
    this.geo.setDrawRange(0, Math.floor(this.built * this.drawFraction));
  }

  dispose(): void {
    for (const p of this.objects) p.removeFromParent();
    for (const L of this.layers) {
      L.matFar.dispose();
      L.matNear.dispose();
      L.geo.dispose();
    }
    this.objects.length = 0;
    this.layers.length = 0;
  }
}
