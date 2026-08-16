/**
 * The luminous body of a galaxy.
 *
 * A galaxy is not a swarm of resolvable stars. At any distance from which you
 * can see one whole, essentially none of its stars are individually resolved —
 * what you see is integrated surface brightness with dust cut through it. A
 * point cloud alone, however many points, reads as confetti; the diffuse
 * component is the galaxy, and the points are the sparkle laid over it.
 *
 * So this raymarches a slab. Sixteen steps through a proxy box, evaluating an
 * analytic disc at each one:
 *
 *   • EXPONENTIAL DISC, Σ ∝ e^(-r/h_r) · sech²(z/h_z). The sech² is the
 *     isothermal self-gravitating solution and it matters — a Gaussian
 *     vertical profile gives an edge-on galaxy soft, wrong-looking edges.
 *   • SPIRAL ARMS as a density wave: r = r₀·e^(θ·tan p), with the arm phase
 *     turning at the pattern speed rather than at the local orbital speed, so
 *     the arms never wind up. Contrast rises toward corotation and the arms
 *     are narrower where the gas is denser, inward.
 *   • A BAR, as a smooth ellipsoidal overdensity along its own axis, blended
 *     into the arm launch radius so the arms grow out of the bar's ends
 *     instead of crossing it.
 *   • DUST, in a thinner layer than the stars — that is the whole reason a
 *     galaxy has dark lanes rather than a soft glow. It is absorbed along the
 *     view ray in front of what it hides, which is why this integrates
 *     emission and extinction together rather than blending a dust texture.
 *   • YOUTH. O and B stars live ten million years, less than the time to
 *     cross an arm, so they are born in the shock and die in it. The arms are
 *     blue for a physical reason and the disc between them is old and red.
 */

import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  Color,
  Mesh,
  ShaderMaterial,
  Uniform,
  Vector3,
} from 'three';
import { GLSL_NOISE } from '../core/Noise';
import type { GalaxyModel } from './GalaxyModel';

const VERT = /* glsl */ `
varying vec3 vLocal;
varying vec3 vCamLocal;
void main(){
  vLocal = position;
  // The camera in the slab's own frame: the march is done entirely in local
  // space so the arm maths never sees a world transform.
  vCamLocal = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
${GLSL_NOISE}

uniform vec3  uHalf;         // half-extents of the proxy box
uniform float uRadius;
uniform float uHr;           // disc scale length
uniform float uHz;           // stellar scale height
uniform float uDustHz;       // dust scale height, always the smaller
uniform float uArms;
uniform float uArmB;         // tan(pitch angle)
uniform float uArmR0;
uniform float uArmStrength;
uniform float uPattern;      // arm phase, radians
uniform float uBarLen;
uniform float uBarAngle;
uniform float uBarFrac;
uniform float uBulgeA;
uniform float uBulgeQ;
uniform float uCorotation;
uniform float uDustAmount;
uniform float uSfr;
uniform vec3  uDiscColor;
uniform vec3  uArmColor;
uniform vec3  uCoreColor;
uniform vec3  uDustColor;
uniform float uGain;
uniform float uSteps;
uniform float uSeed;

varying vec3 vLocal;
varying vec3 vCamLocal;

/** Slab intersection in local space. Returns (near, far); far < 0 = miss. */
vec2 rayBox(vec3 o, vec3 d, vec3 h){
  vec3 inv = 1.0 / max(abs(d), vec3(1e-9)) * sign(d + vec3(1e-20));
  vec3 t0 = (-h - o) * inv;
  vec3 t1 = ( h - o) * inv;
  vec3 lo = min(t0, t1);
  vec3 hi = max(t0, t1);
  float n = max(max(lo.x, lo.y), lo.z);
  float f = min(min(hi.x, hi.y), hi.z);
  return f < max(n, 0.0) ? vec2(1.0, -1.0) : vec2(n, f);
}

/** sech²(x), the isothermal disc's vertical profile. */
float sech2(float x){
  float e = exp(-abs(x));
  float s = 2.0 * e / (1.0 + e * e);
  return s * s;
}

/**
 * Arm overdensity at a point in the plane. The ridge of arm k sits where
 * log(r/r0)/b + 2πk/N equals the azimuth, turned by the pattern speed.
 */
float armFactor(float r, float phi, out float young){
  young = 0.0;
  if (uArms < 0.5) return 1.0;
  float ridge = log(max(r, uArmR0 * 0.35) / uArmR0) / uArmB + uPattern;
  // Distance to the nearest arm, in units of the arm separation.
  float n = uArms;
  float d = fract((phi - ridge) * n / 6.2831853072 + 0.5) - 0.5;

  // Arms are narrow inward, where the gas is dense, and broaden outward.
  float width = 0.13 + 0.20 * clamp(r / uRadius, 0.0, 1.0);
  // The wave is only coherent near corotation; outside it the arms fray.
  float coh = exp(-pow(abs(r / max(uCorotation, 1.0) - 1.0) * 1.15, 2.0));
  float ridgeAmp = uArmStrength * (0.35 + 0.9 * coh);

  float a = exp(-(d * d) / (width * width));
  // Flocculent detail: real arms are broken into spurs and feathers, and a
  // clean analytic ridge is the single most artificial thing about a
  // procedural galaxy.
  float spur = fbm(vec3(cos(phi) * r, sin(phi) * r, uSeed) * (3.5 / uRadius), 4) * 0.5 + 0.5;
  a *= 0.55 + 0.9 * spur;

  young = clamp(a * ridgeAmp * 1.6, 0.0, 1.0);
  return 1.0 + a * ridgeAmp * 1.7;
}

/** Bar: a smooth ellipsoidal overdensity, strongest at the centre. */
float barFactor(float x, float z){
  if (uBarFrac < 0.02 || uBarLen < 1.0) return 1.0;
  float c = cos(uBarAngle), s = sin(uBarAngle);
  float u = (x * c + z * s) / uBarLen;
  float v = (-x * s + z * c) / (uBarLen * 0.28);
  float e = sqrt(u * u + v * v);
  return 1.0 + uBarFrac * 3.4 * exp(-e * e * 1.6);
}

void main(){
  vec3 ro = vCamLocal;
  vec3 rd = normalize(vLocal - vCamLocal);
  vec2 t = rayBox(ro, rd, uHalf);
  if (t.y < 0.0) discard;
  float t0 = max(t.x, 0.0);
  float t1 = t.y;
  if (t1 <= t0) discard;

  int steps = int(clamp(uSteps, 8.0, 48.0));
  float len = (t1 - t0) / float(steps);
  // Dither so a coarse march does not band the disc into shells.
  float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);

  vec3 acc = vec3(0.0);
  vec3 trans = vec3(1.0);

  for (int i = 0; i < 48; i++){
    if (i >= steps) break;
    if (trans.g < 0.01) break;
    vec3 p = ro + rd * (t0 + len * (float(i) + jit));
    float r = length(p.xz);
    if (r > uRadius * 1.05) continue;

    float phi = atan(p.z, p.x);
    float young;
    float arm = armFactor(r, phi, young);

    // Stellar density: exponential in radius, isothermal in height, with the
    // bar and the arms modulating it.
    float disc = exp(-r / uHr) * sech2(p.y / uHz) * arm * barFactor(p.x, p.z);
    // The bulge is a flattened Sérsic-ish ball, not part of the disc.
    float rb = length(vec3(p.x, p.y / max(uBulgeQ, 0.05), p.z)) / max(uBulgeA, 1.0);
    float bulge = exp(-pow(rb, 0.55) * 3.2);

    // Colour: old and red between the arms, blue in the shock, warm in the core.
    vec3 col = mix(uDiscColor, uArmColor, young * (0.35 + 0.65 * uSfr));
    vec3 emit = col * disc + uCoreColor * bulge * 2.4;

    // Dust sits in a thinner layer than the stars, which is exactly why a
    // galaxy has lanes: the absorbing material is a sheet inside the light.
    float dust = uDustAmount * exp(-r / (uHr * 1.35)) * sech2(p.y / uDustHz)
               * (0.45 + 0.85 * (arm - 1.0));
    dust *= 0.55 + 0.9 * (fbm(p * (5.5 / uRadius) + uSeed, 4) * 0.5 + 0.5);

    // Extinction is wavelength-dependent — dust reddens what it does not hide.
    vec3 kappa = uDustColor * 0.0 + vec3(1.35, 1.0, 0.72);
    vec3 ext = exp(-kappa * (dust * len * 6.0 / uRadius));

    acc += trans * emit * len * uGain;
    trans *= ext;
  }

  gl_FragColor = vec4(max(acc, 0.0), 1.0);
}
`;

export class GalaxyVolume {
  readonly mesh: Mesh;
  private mat: ShaderMaterial;

  constructor(model: GalaxyModel) {
    const R = model.radius;
    // The proxy box has to contain the light, not the model: the disc fades
    // exponentially, so a little past the nominal radius is plenty.
    const half = new Vector3(R * 1.06, Math.max(model.hz * 9, model.bulgeA * 2.4), R * 1.06);

    this.mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uHalf: new Uniform(half),
        uRadius: new Uniform(R),
        uHr: new Uniform(model.hr),
        uHz: new Uniform(model.hz),
        uDustHz: new Uniform(Math.max(1, model.dustHz)),
        uArms: new Uniform(model.arms),
        uArmB: new Uniform(model.armB),
        uArmR0: new Uniform(model.armR0),
        uArmStrength: new Uniform(model.armStrength),
        uPattern: new Uniform(0),
        uBarLen: new Uniform(model.barLen),
        uBarAngle: new Uniform(model.barAngle),
        uBarFrac: new Uniform(model.spec.barFraction),
        uBulgeA: new Uniform(model.bulgeA),
        uBulgeQ: new Uniform(model.bulgeQ),
        uCorotation: new Uniform(model.corotation),
        uDustAmount: new Uniform(model.dustAmount),
        uSfr: new Uniform(model.sfrNorm),
        uDiscColor: new Uniform(new Color(...model.discColor)),
        uArmColor: new Uniform(new Color(...model.armColor)),
        uCoreColor: new Uniform(new Color(...model.coreColor)),
        uDustColor: new Uniform(new Color(...model.dustColor)),
        // Normalised by the scale length so a dwarf and a giant come out at
        // comparable surface brightness, which is what they actually do.
        uGain: new Uniform(0.85 / Math.max(1, model.hr)),
        uSteps: new Uniform(20),
        uSeed: new Uniform((model.spec.seed % 512) * 0.031),
      },
      transparent: true,
      depthWrite: false,
      // Back faces: the camera can be inside the box, and when it is not, the
      // march computes the true entry point anyway.
      side: BackSide,
      blending: AdditiveBlending,
      toneMapped: false,
    });

    this.mesh = new Mesh(new BoxGeometry(half.x * 2, half.y * 2, half.z * 2), this.mat);
    this.mesh.frustumCulled = false;
    // Under the star points, so the sparkle sits on top of the body.
    this.mesh.renderOrder = -5;
  }

  /** Advance the density wave. The pattern turns; the stars do not follow it. */
  setPattern(phase: number): void {
    this.mat.uniforms.uPattern.value = phase;
  }

  setSteps(n: number): void {
    this.mat.uniforms.uSteps.value = n;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
