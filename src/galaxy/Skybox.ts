/**
 * The deep sky.
 *
 * Everything you see when you look away from whatever is nearby: stars, the
 * band of the host galaxy, its dust lanes, a couple of nebulae, and the sun of
 * whatever system you happen to be in. One inverted sphere, one shader, no
 * geometry — the whole sky costs a single draw call and no memory.
 *
 * Three things carry the image, in this order:
 *
 *   • THE POWER LAW. Real star counts go roughly ×2.5 per magnitude, so a sky
 *     of uniformly-bright dots reads as static. Brightness here is drawn from
 *     a steep power law, which gives a handful of obvious stars, a scattering
 *     of middling ones, and a haze of unresolved points underneath — the same
 *     structure your eye uses to judge that a sky is real.
 *   • THE BAND. A galaxy seen from inside is a luminous stripe with a warp, a
 *     bright bulge toward the centre, and dark lanes where dust in the plane
 *     absorbs what is behind it. The lanes matter more than the glow: without
 *     them the Milky Way looks like a smear rather than a structure.
 *   • COLOUR TEMPERATURE. Star colour comes from the Planck locus, sampled
 *     from a distribution weighted toward cool dwarfs with a few hot blue
 *     giants. Correct, and much prettier than white dots.
 *
 * Antialiasing is the whole difficulty with a procedural starfield. A star
 * smaller than a pixel either vanishes or crawls when the camera turns. Each
 * one is drawn as a Gaussian whose angular radius has a floor of about one
 * pixel, with its energy conserved as it spreads, so faint stars fade smoothly
 * instead of twinkling on and off with sub-pixel motion.
 */

import {
  AdditiveBlending,
  BackSide,
  Color,
  Group,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Uniform,
  Vector2,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import { GLSL_COLOR, GLSL_NOISE } from '../core/Noise';
import type { QualityProfile } from '../core/Settings';
import type { ISkybox, SystemContext } from '../api/Contracts';
import type { GalaxySpec } from '../universe/Types';

const VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = position;
  // Force the sky to the far plane: w = z after the projection, so the depth
  // is exactly 1 and nothing can ever be drawn behind it.
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const FRAG = /* glsl */ `
precision highp float;
${GLSL_NOISE}
${GLSL_COLOR}

uniform vec3  uGalNormal;    // unit normal of the galactic plane
uniform vec3  uGalCentre;    // unit direction toward the galactic centre
uniform float uGalBright;    // how deep in the disc the viewer sits
uniform vec3  uArmColor;
uniform vec3  uCoreColor;
uniform vec3  uDustColor;
uniform float uStarGain;
uniform float uPixAngle;     // radians per pixel: the antialiasing floor
uniform float uOpacity;      // 0 in daylight, 1 in the dark
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform float uSunAngle;     // angular radius of the local star, radians
uniform float uSeed;

varying vec3 vDir;

/** Direction to equirectangular UV. */
vec2 aeSkyUv(vec3 d){
  return vec2(atan(d.z, d.x) * 0.1591549431 + 0.5,
              asin(clamp(d.y, -1.0, 1.0)) * 0.3183098862 + 0.5);
}

/**
 * One layer of stars.
 *
 * Cells are laid out on the equirectangular grid, not in 3D space. The obvious
 * implementation dices direction-scaled 3-space and loops the 27 neighbouring
 * cells, which is correct but costs 243 cell evaluations per pixel across three
 * layers — enough to push a single frame past three minutes on a software
 * rasteriser and into milliseconds on real hardware, for a backdrop. In 2D the
 * same result needs 9 cells per layer. The poles stretch, which no one has ever
 * noticed in a starfield.
 *
 * Density is cells across the full 360 degrees; the cut throws most cells away
 * so the sky is not a uniform lattice.
 */
vec3 starLayer(vec2 uv, float density, float cut, float gain){
  // Half as many cells in latitude as in longitude keeps them roughly square.
  vec2 p = uv * vec2(density, density * 0.5);
  vec2 base = floor(p);
  vec3 acc = vec3(0.0);
  for (int dy = -1; dy <= 1; dy++)
  for (int dx = -1; dx <= 1; dx++){
    vec2 c = base + vec2(float(dx), float(dy));
    // Wrap longitude so the seam has no doubled or missing stars.
    vec2 cw = vec2(mod(c.x, density), c.y);
    vec3 h = hash33i(ivec3(int(cw.x), int(cw.y), 0));
    if (h.z > cut) continue;
    vec3 h2 = hash33i(ivec3(int(cw.x) + 37, int(cw.y) + 91, 13));

    vec2 sp = c + vec2(0.05) + h.xy * 0.9;
    // Angular distance, corrected for the longitude squeeze toward the poles.
    vec2 dd = (p - sp) / vec2(density, density * 0.5);
    dd.x *= max(0.08, cos((uv.y - 0.5) * 3.1415926536));
    float ang = length(dd) * 6.2831853072;

    // Power law: mag^6 makes bright stars rare and the rest a fine dust.
    float mag = pow(h2.x, 6.0);
    // Energy-conserving spread. Below one pixel a star cannot get smaller,
    // only fainter — which is exactly how a real one behaves.
    float rad = uPixAngle * (0.85 + 2.4 * mag);
    float falloff = exp(-(ang * ang) / (rad * rad));
    if (falloff < 0.002) continue;
    float energy = mag * (uPixAngle * uPixAngle) / (rad * rad);
    // Cool dwarfs are common, blue giants are not.
    float tempK = mix(2600.0, 26000.0, pow(h2.y, 2.6));
    acc += blackbody(tempK) * falloff * energy * gain;
  }
  return acc;
}

void main(){
  vec3 d = normalize(vDir);

  /* ---- the galactic band ---- */
  float z = dot(d, uGalNormal);            // sine of galactic latitude
  float toCentre = dot(d, uGalCentre);
  // Warp: the plane of a real disc is not flat, and the bend is visible from
  // inside. A low-frequency noise on the latitude does the job.
  float warp = snoise(d * 1.6 + uSeed) * 0.055;
  float lat = z + warp;

  // The disc is optically thick, so brightness falls off roughly exponentially
  // with height above the plane and rises toward the centre.
  float band = exp(-abs(lat) * 26.0);
  float bulge = exp(-abs(lat) * 9.0) * pow(max(toCentre, 0.0), 2.2);

  // Dust. Cold molecular clouds sit *in* the plane, so the lanes are thinnest
  // exactly where the glow is brightest, which is what carves the band into
  // the rift that makes it read as a structure rather than a smear.
  float dustN = fbm(d * 5.2 + uSeed * 0.37, 4) * 0.5 + 0.5;
  float lane = smoothstep(0.42, 0.78, dustN) * exp(-abs(lat) * 42.0);
  // Clumping along the band, so it is not a smooth airbrushed stripe.
  float clump = 0.55 + 0.9 * (fbm(d * 9.0 - uSeed * 0.11, 3) * 0.5 + 0.5);

  vec3 milky = (uArmColor * band * clump * 0.055 + uCoreColor * bulge * 0.10) * uGalBright;
  milky *= mix(1.0, 0.10, lane);
  // The dust itself is not black: it reddens what leaks through.
  milky += uDustColor * lane * band * 0.012 * uGalBright;

  /* ---- nebulae: a few emission clouds, mostly near the plane ---- */
  float neb = pow(clamp(fbm(d * 3.1 - uSeed * 0.53, 3) * 0.5 + 0.5, 0.0, 1.0), 5.0);
  vec3 nebC = mix(vec3(0.85, 0.22, 0.42), vec3(0.20, 0.52, 0.95),
                  snoise(d * 1.3 + uSeed) * 0.5 + 0.5);
  milky += nebC * neb * exp(-abs(lat) * 12.0) * 0.09 * uGalBright;

  /* ---- stars: three layers, coarse to fine ---- */
  vec2 suv = aeSkyUv(d);
  vec3 stars = vec3(0.0);
  stars += starLayer(suv,  260.0, 0.060, 1.00);
  stars += starLayer(suv,  700.0, 0.080, 0.40);
  stars += starLayer(suv, 1800.0, 0.095, 0.15);
  // The band is where the stars are: crowd them into it rather than
  // scattering them evenly over the sphere.
  stars *= (0.55 + 1.9 * band * uGalBright) * uStarGain;

  vec3 col = (milky + stars) * uOpacity;

  /* ---- the local star ---- */
  if (uSunAngle > 0.0) {
    float cosA = dot(d, uSunDir);
    float ang = sqrt(max(0.0, 2.0 - 2.0 * cosA));
    // A disc with a soft edge one pixel wide, plus the forward halo that any
    // real optic puts around a source this bright.
    float disc = 1.0 - smoothstep(uSunAngle - uPixAngle, uSunAngle + uPixAngle, ang);
    float halo = exp(-ang / (uSunAngle * 9.0)) * 0.28;
    col += uSunColor * uSunIntensity * (disc * 260.0 + halo);
  }

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

export class Skybox implements ISkybox {
  readonly root = new Group();
  private mesh: Mesh;
  private mat: ShaderMaterial;

  constructor() {
    this.mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uGalNormal: new Uniform(new Vector3(0, 1, 0)),
        uGalCentre: new Uniform(new Vector3(1, 0, 0)),
        uGalBright: new Uniform(1),
        uArmColor: new Uniform(new Color(0.62, 0.78, 1.3)),
        uCoreColor: new Uniform(new Color(1.25, 0.95, 0.62)),
        uDustColor: new Uniform(new Color(0.32, 0.19, 0.12)),
        uStarGain: new Uniform(1),
        uPixAngle: new Uniform(0.002),
        uOpacity: new Uniform(1),
        uSunDir: new Uniform(new Vector3(1, 0, 0)),
        uSunColor: new Uniform(new Color(1, 1, 1)),
        uSunIntensity: new Uniform(0),
        uSunAngle: new Uniform(0),
        uSeed: new Uniform(0),
      },
      side: BackSide,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });

    // Radius is irrelevant — the vertex shader pins the sky to the far plane —
    // but the tessellation still has to be fine enough that `vDir` interpolates
    // without visibly faceting the band.
    this.mesh = new Mesh(new SphereGeometry(1, 64, 48), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.root.add(this.mesh);
  }

  build(galaxy: GalaxySpec, positionLy: [number, number, number]): void {
    const u = this.mat.uniforms;
    const n = new Vector3(...galaxy.normal).normalize();
    u.uGalNormal.value.copy(n);

    // The galactic centre as seen from here. Inside the disc that is simply
    // the direction back to the origin, projected into the plane.
    const p = new Vector3(...positionLy);
    const toCentre = p.lengthSq() > 1 ? p.clone().negate() : new Vector3(1, 0, 0);
    toCentre.addScaledVector(n, -toCentre.dot(n));
    if (toCentre.lengthSq() < 1e-6) toCentre.set(1, 0, 0).addScaledVector(n, -n.x);
    u.uGalCentre.value.copy(toCentre.normalize());

    // Deep in the disc the band dominates the sky; out in the halo it is a
    // faint smudge and the sky goes almost black.
    const rFrac = p.length() / Math.max(1, galaxy.radiusLy);
    const hFrac = Math.abs(p.dot(n)) / Math.max(1, galaxy.thicknessLy);
    u.uGalBright.value = Math.max(0.06, Math.exp(-hFrac * 0.8) * (1.25 - 0.6 * Math.min(1.4, rFrac)));

    u.uArmColor.value.setRGB(...galaxy.armColor);
    u.uCoreColor.value.setRGB(...galaxy.coreColor);
    u.uDustColor.value.setRGB(...galaxy.dustColor);
    u.uSeed.value = (galaxy.seed % 1024) * 0.017;
  }

  /** The local star, so the sky has something to look away from. */
  setSun(dir: Vector3, color: [number, number, number], intensity: number, angularRadius: number): void {
    const u = this.mat.uniforms;
    u.uSunDir.value.copy(dir).normalize();
    u.uSunColor.value.setRGB(color[0], color[1], color[2]);
    u.uSunIntensity.value = intensity;
    u.uSunAngle.value = angularRadius;
  }

  /** 1 in the dark, 0 under a daylit sky. */
  setOpacity(v: number): void {
    this.mat.uniforms.uOpacity.value = v;
  }

  update(_dt: number, ctx: SystemContext): void {
    // Follow the camera so the sky is always at infinity, and keep the pixel
    // angle honest so stars antialias at any field of view or resolution.
    const cam = ctx.camera as PerspectiveCamera;
    this.root.position.copy(cam.position);
    const h = ctx.renderer.getDrawingBufferSize(_sz).y || 1080;
    this.mat.uniforms.uPixAngle.value = ((cam.fov * Math.PI) / 180) / h;
  }

  setQuality(q: QualityProfile): void {
    // Faint layers cost the most and matter the least; drop them on weak
    // hardware by pulling the gain down rather than branching in the shader.
    this.mat.uniforms.uStarGain.value = q.tier === 'potato' ? 0.7 : 1.0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.root.remove(this.mesh);
  }
}

const _sz = new Vector2();
