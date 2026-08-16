/**
 * Every shader the cosmic web runs, and the art direction that lives in them.
 *
 * The pipeline per frame is:
 *
 *   1. SIM       Zel'dovich backbone + particle-mesh correction  (MRT, 512²)
 *   2. SPLAT     particles → a 3D density/momentum grid stored as a 2D atlas
 *   3. BLUR      separable, twice, widening stride — the Green's function
 *   4. HAZE      raymarch the grid into a low-res HDR nebular glow
 *   5. POINTS    256k additive HDR sprites, coloured by physics
 *   6. COMPOSITE the haze, upsampled and added behind the points
 *
 * Colour is not decoration here: hue *is* the physics readout. Deep indigo is
 * void material coasting outward, steel blue is a collapsing sheet, dusty rose
 * is a filament, amber-gold is a knot, and incandescent white is gas that has
 * been through an accretion shock. Someone watching without reading a single
 * number should still be able to see matter falling.
 */

import { GLSL_COLOR, GLSL_NOISE } from '../core/Noise';

/* ═══════════════════════════════════════════════════════════════════════════
   Shared chunks
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The density field lives in a 3D grid that WebGL2 will not let us render into
 * directly, so it is stored as a 2D atlas of Z slices. These helpers hide the
 * address arithmetic. Slices are sampled with hardware bilinear filtering and
 * clamped half a texel inside their tile so a lookup never bleeds into the
 * neighbouring slice; the Z axis is interpolated by hand. Two fetches per
 * trilinear sample, which is what makes a 48-step raymarch affordable.
 *
 *   R = mass          G = mass·infall      B = mass·shock heat    A = mass·speed
 */
const GRID_CHUNK = /* glsl */ `
uniform sampler2D uGridTex;
uniform vec4 uGridInfo;   // N, cols, atlasWidth, atlasHeight
uniform vec4 uGridBox;    // min.xyz, size (a cube, comoving Mpc)

vec4 gridSlice(float z, vec2 xy){
  float N = uGridInfo.x;
  z = clamp(z, 0.0, N - 1.0);
  float tx = mod(z, uGridInfo.y);
  float ty = floor(z / uGridInfo.y);
  vec2 cl = clamp(xy, vec2(0.5), vec2(N - 0.5));
  return texture2D(uGridTex, (vec2(tx, ty) * N + cl) / uGridInfo.zw);
}

/** Trilinear sample at a comoving position, in raw (unnormalised) counts. */
vec4 gridSample(vec3 p){
  vec3 cell = (p - uGridBox.xyz) / uGridBox.w * uGridInfo.x;
  float z = cell.z - 0.5;
  float z0 = floor(z);
  return mix(gridSlice(z0, cell.xy), gridSlice(z0 + 1.0, cell.xy), z - z0);
}

/** Cell size in comoving Mpc. */
float gridCell(){ return uGridBox.w / uGridInfo.x; }
`;

/**
 * The palette.
 *
 * Densities span four decades from void to cluster core, so the ramp is keyed
 * on log density; a linear ramp would put the entire web in the top 2 % of the
 * scale and everything else in the black. Values are linear radiance and
 * deliberately exceed 1.0 at the knots — the post chain's bloom is what turns
 * that into the glare around a supercluster, so clamping here would throw the
 * best part of the image away.
 */
const PALETTE_CHUNK = /* glsl */ `
vec3 webColour(float rho, float infall, float heat){
  float t = clamp(log2(1.0 + max(rho, 0.0)) / 5.6, 0.0, 1.0);

  vec3 cVoid  = vec3(0.050, 0.078, 0.245);  // indigo, barely above black
  vec3 cSheet = vec3(0.135, 0.300, 0.620);  // cold steel — a collapsing pancake
  vec3 cFil   = vec3(0.720, 0.410, 0.330);  // dusty rose — the filaments
  vec3 cNode  = vec3(1.000, 0.735, 0.395);  // amber gold — the knots

  vec3 c = mix(cVoid, cSheet, smoothstep(0.00, 0.34, t));
  c = mix(c, cFil,  smoothstep(0.30, 0.68, t));
  c = mix(c, cNode, smoothstep(0.62, 0.94, t));

  // Velocity divergence as temperature. Material climbing out of a void is
  // rarefying and reads cold and violet; material falling into a filament is
  // compressing and reads warm. This is the single cue that makes the motion
  // legible as *flow* rather than as drifting dots.
  float w = clamp(infall, -1.0, 1.0) * 0.5 + 0.5;
  c *= mix(vec3(0.66, 0.74, 1.30), vec3(1.24, 0.94, 0.68), w);

  // Accretion shocks. Cluster gas at 10⁷ K is the hottest thing in frame and
  // it should look it: nearly white, faintly gold.
  c = mix(c, vec3(1.30, 1.19, 1.00), clamp(heat, 0.0, 1.0) * 0.88);
  return c;
}

/** Emitted radiance, before colour. Superlinear so nodes bloom and voids don't. */
float webIntensity(float rho){
  return pow(max(rho, 0.0), 0.92);
}

/**
 * Distance reddening. Light from the far side of a volume this size really is
 * redshifted, and the eye reads it as depth — the same job aerial perspective
 * does in a landscape painting.
 */
vec3 redshiftTint(float depth01){
  float z = clamp(depth01, 0.0, 1.0);
  return mix(vec3(1.0), vec3(1.22, 0.70, 0.46), z * 0.85) * mix(1.0, 0.45, z);
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   1. Initialisation — the Lagrangian lattice and its Zel'dovich displacement
   ═══════════════════════════════════════════════════════════════════════════ */

export const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Runs once per (re)build. Unpacks a particle index into a cubic lattice site,
 * jitters it — a perfect lattice moirés horribly at early epochs when the
 * displacements are still tiny — and evaluates the primordial field there.
 *
 * Both outputs are constant for the life of the simulation: the whole point of
 * the Zel'dovich approximation is that the expensive part is a function of the
 * Lagrangian coordinate alone, and time enters only through a scalar D(a).
 */
export const INIT_FRAG = /* glsl */ `
precision highp float;
${GLSL_NOISE}

uniform sampler2D uModes;
uniform int   uModeCount;
uniform vec2  uTexSize;
uniform float uLattice;
uniform float uBox;
uniform float uJitter;

layout(location = 0) out vec4 oLag;
layout(location = 1) out vec4 oDisp;

void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  float idx = float(px.y) * uTexSize.x + float(px.x);

  float n = uLattice;
  float iz = floor(idx / (n * n));
  float rem = idx - iz * n * n;
  float iy = floor(rem / n);
  float ix = rem - iy * n;
  vec3 site = vec3(ix, iy, iz);

  vec3 jitter = (hash33i(ivec3(site)) - 0.5) * uJitter;
  vec3 q = ((site + 0.5 + jitter) / n - 0.5) * uBox;

  // δ(q) = Σ A cos(k·q + φ)   and   Ψ(q) = −Σ (A/k²) k sin(k·q + φ),
  // so that ∇·Ψ = −δ and x = q + D·Ψ is the Zel'dovich map.
  vec3 psi = vec3(0.0);
  float delta = 0.0;
  for (int m = 0; m < 512; m++){
    if (m >= uModeCount) break;
    vec4 A = texelFetch(uModes, ivec2(m, 0), 0);   // k.xyz, amplitude
    vec4 B = texelFetch(uModes, ivec2(m, 1), 0);   // phase, k²
    float ph = dot(A.xyz, q) + B.x;
    delta += A.w * cos(ph);
    psi   -= (A.w / B.y) * A.xyz * sin(ph);
  }

  oLag  = vec4(q, 0.0);
  oDisp = vec4(psi, delta);
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   2. The simulation step
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * x(a) = q + D(a)·Ψ(q) + Δ
 *
 * The first two terms are linear theory and are exact — they produce the
 * pancakes-then-filaments-then-nodes sequence for free, and because they depend
 * on time only through D(a) the epoch can be scrubbed instantly in either
 * direction. Δ is everything linear theory gets wrong: past shell crossing the
 * Zel'dovich flow sails straight through its own caustics and the structure it
 * just built blurs away again.
 *
 * Δ comes from a particle-mesh force. A Gaussian-smoothed density field is a
 * 1/k² low-pass of δ, which is what ∇⁻² is, so the gradient of the blurred grid
 * is a real (if short-ranged) peculiar gravity — not an invented attractor. On
 * top of it sit two damping terms with names: 2Hu, the Hubble drag that comoving
 * peculiar velocities genuinely feel, and an adhesion viscosity, the standard
 * Burgers-equation fix that stops matter from streaming back out of a caustic.
 * Together they turn a smeared Zel'dovich pancake into a knot that stays a knot.
 */
export const SIM_FRAG = /* glsl */ `
precision highp float;
${GRID_CHUNK}

uniform sampler2D uLag;
uniform sampler2D uDisp;
uniform sampler2D uVel;
uniform sampler2D uNL;

uniform float uGrowth;      // D(a)
uniform float uGrowthRate;  // Ḋ, 1/Gyr
uniform float uHubble;      // H(a), 1/Gyr
uniform float uDt;          // dynamical step, Gyr
uniform float uForce;
uniform float uGate;        // 0 while the field is still linear
uniform float uViscosity;
uniform float uDecay;       // per-step relaxation of Δ (unwinds on rewind)
uniform float uMaxOffset;
uniform float uMeanCell;    // counts → 1+δ
uniform float uHeatDecay;
uniform float uHeatGain;

layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;
layout(location = 2) out vec4 oNL;

void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 lag  = texelFetch(uLag,  px, 0);
  vec4 disp = texelFetch(uDisp, px, 0);
  vec4 vel  = texelFetch(uVel,  px, 0);
  vec4 nl   = texelFetch(uNL,   px, 0);

  vec3 q = lag.xyz;
  vec3 psi = disp.xyz;
  float deltaLinear = disp.w;

  vec3 x = q + uGrowth * psi + nl.xyz;

  float h = gridCell();
  float rho = max(gridSample(x).r * uMeanCell, 0.0);
  vec3 grad = vec3(
    gridSample(x + vec3(h, 0.0, 0.0)).r - gridSample(x - vec3(h, 0.0, 0.0)).r,
    gridSample(x + vec3(0.0, h, 0.0)).r - gridSample(x - vec3(0.0, h, 0.0)).r,
    gridSample(x + vec3(0.0, 0.0, h)).r - gridSample(x - vec3(0.0, 0.0, h)).r
  ) * (uMeanCell / (2.0 * h));

  vec3 accel = uForce * uGate * grad;

  vec3 u = vel.xyz;
  u += (accel - (2.0 * uHubble + uViscosity) * u) * uDt;

  vec3 offset = (nl.xyz + u * uDt) * uDecay;
  float mag = length(offset);
  if (mag > uMaxOffset) offset *= uMaxOffset / mag;   // nothing escapes the box

  x = q + uGrowth * psi + offset;

  // Divergence of the velocity field. The linear half is exact — ∇·Ψ = −δ, so
  // ∇·v = −Ḋ·δ — and the nonlinear half we read off the alignment of a
  // particle's own motion with the force it feels: falling in is converging.
  float divergence = -uGrowthRate * deltaLinear
                   - dot(normalize(accel + vec3(1e-9)), u) * 0.5;

  // Gas only shocks where it is both converging *and* already dense: the
  // virial boundary of a halo, not the middle of a quiet filament.
  float shock = max(0.0, -divergence) * smoothstep(6.0, 40.0, rho);
  float heat = nl.w * uHeatDecay + shock * uDt * uHeatGain;

  oPos = vec4(x, rho);
  oVel = vec4(u, divergence);
  oNL  = vec4(offset, heat);
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   3. Mass assignment — particles into the grid
   ═══════════════════════════════════════════════════════════════════════════ */

export const SPLAT_VERT = /* glsl */ `
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform sampler2D uNL;
uniform vec4 uGridInfo;
uniform vec4 uGridBox;
uniform float uDivScale;

varying vec4 vValue;

void main(){
  vec4 P = texture2D(uPos, position.xy);
  vec4 V = texture2D(uVel, position.xy);
  vec4 N = texture2D(uNL,  position.xy);

  float n = uGridInfo.x;
  vec3 cell = floor((P.xyz - uGridBox.xyz) / uGridBox.w * n);
  if (any(lessThan(cell, vec3(0.0))) || any(greaterThan(cell, vec3(n - 1.0)))) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // off-screen: silently dropped
    gl_PointSize = 0.0;
    vValue = vec4(0.0);
    return;
  }

  vec2 tile = vec2(mod(cell.z, uGridInfo.y), floor(cell.z / uGridInfo.y));
  vec2 texel = tile * n + cell.xy + 0.5;
  gl_Position = vec4(texel / uGridInfo.zw * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;

  // Mass-weighted moments, so a later divide by R recovers the mean.
  float infall = clamp(-V.w * uDivScale, -1.0, 1.0);
  vValue = vec4(1.0, infall, N.w, length(V.xyz));
}
`;

export const SPLAT_FRAG = /* glsl */ `
precision highp float;
varying vec4 vValue;
void main(){ gl_FragColor = vValue; }
`;

/* ═══════════════════════════════════════════════════════════════════════════
   4. Blur — one axis at a time, run twice with a widening stride
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A 5-tap binomial kernel along one axis of the 3D grid. Run over x, y and z
 * with stride 1 and then again with stride 2, it approximates a Gaussian about
 * two and a half cells wide for the cost of six cheap passes — and that kernel
 * is doing double duty as the Green's function for the force solve and as the
 * thing that turns a shot-noisy point cloud into something that looks like gas.
 */
export const BLUR_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uSrc;
uniform vec4 uGridInfo;   // N, cols, atlasWidth, atlasHeight
uniform vec3 uAxis;
uniform float uStride;

layout(location = 0) out vec4 oColor;

ivec2 atlasTexel(vec3 c){
  float N = uGridInfo.x;
  c = clamp(c, vec3(0.0), vec3(N - 1.0));
  float tx = mod(c.z, uGridInfo.y);
  float ty = floor(c.z / uGridInfo.y);
  return ivec2(tx * N + c.x, ty * N + c.y);
}

void main(){
  vec2 px = floor(gl_FragCoord.xy);
  float N = uGridInfo.x;
  vec2 tile = floor(px / N);
  vec3 c = vec3(px - tile * N, tile.y * uGridInfo.y + tile.x);

  // Slices past the end of the cube exist only to pad the atlas out to a
  // rectangle; leave them at zero so they can never leak into a sample.
  if (c.z > N - 1.0) { oColor = vec4(0.0); return; }

  vec4 sum =
      texelFetch(uSrc, atlasTexel(c - uAxis * uStride * 2.0), 0) * 0.0625
    + texelFetch(uSrc, atlasTexel(c - uAxis * uStride), 0)       * 0.25
    + texelFetch(uSrc, atlasTexel(c), 0)                         * 0.375
    + texelFetch(uSrc, atlasTexel(c + uAxis * uStride), 0)       * 0.25
    + texelFetch(uSrc, atlasTexel(c + uAxis * uStride * 2.0), 0) * 0.0625;
  oColor = sum;
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   5. Volumetric haze
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Points alone read as dots, however many you draw. What makes the Millennium
 * Simulation stills look like *gas* is that the filaments glow between the
 * particles. So we raymarch the same density grid the physics uses, in
 * emission only — no scattering, no absorption — which keeps the voids at true
 * black on an OLED and makes the pass order-independent and additive.
 *
 * A single octave of simplex noise modulates the sample: the grid resolves 3 Mpc
 * and real intergalactic gas is structured far below that, so without it the
 * haze looks like what it is, an interpolated lattice.
 */
export const HAZE_FRAG = /* glsl */ `
precision highp float;
${GLSL_NOISE}
${GLSL_COLOR}
${GRID_CHUNK}
${PALETTE_CHUNK}

uniform mat4  uInvViewProj;
uniform mat4  uInvModel;
uniform vec3  uCamPos;
uniform vec3  uBoxHalf;      // root-local half extent of the volume
uniform float uDisplayScale;
uniform float uMeanCell;
uniform float uGain;
uniform float uSteps;
uniform float uDetail;
uniform float uDetailFreq;
uniform float uTime;
uniform float uFar;
uniform float uFadeStart;

varying vec2 vUv;

bool boxHit(vec3 ro, vec3 rd, vec3 h, out float t0, out float t1){
  vec3 inv = 1.0 / rd;
  vec3 a = (-h - ro) * inv;
  vec3 b = ( h - ro) * inv;
  vec3 lo = min(a, b);
  vec3 hi = max(a, b);
  t0 = max(max(lo.x, lo.y), lo.z);
  t1 = min(min(hi.x, hi.y), hi.z);
  return t1 > max(t0, 0.0);
}

void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 nearP = uInvViewProj * vec4(ndc, -1.0, 1.0);
  nearP /= nearP.w;

  vec3 roW = uCamPos;
  vec3 rdW = normalize(nearP.xyz - roW);
  vec3 ro = (uInvModel * vec4(roW, 1.0)).xyz;
  vec3 rd = normalize((uInvModel * vec4(rdW, 0.0)).xyz);

  float t0, t1;
  if (!boxHit(ro, rd, uBoxHalf, t0, t1)) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  t0 = max(t0, 0.0);

  float dt = (t1 - t0) / uSteps;
  // Jitter the entry point per pixel and per frame. Without it a fixed step
  // count carves visible onion shells through the filaments.
  float t = t0 + dt * ignoise(gl_FragCoord.xy + uTime * 53.0);

  float halfBox = max(max(uBoxHalf.x, uBoxHalf.y), uBoxHalf.z);
  vec3 acc = vec3(0.0);

  for (int i = 0; i < 96; i++){
    if (float(i) >= uSteps) break;
    vec3 p = ro + rd * t;
    vec3 comoving = p / uDisplayScale;
    vec4 g = gridSample(comoving);
    float rho = g.r * uMeanCell;

    if (rho > 0.03) {
      float invMass = 1.0 / max(g.r, 1e-4);
      float infall = clamp(g.g * invMass, -1.0, 1.0);
      float heat = clamp(g.b * invMass, 0.0, 1.0);

      float detail = 1.0;
      if (uDetail > 0.0 && rho > 0.35) {
        detail = 1.0 + uDetail * snoise(comoving * uDetailFreq + vec3(0.0, uTime * 0.013, 0.0));
      }

      // The volume is a cube but it should not look like one: fade the
      // outermost tenth so the web dissolves into the dark instead of
      // stopping at a wall.
      float edge = 1.0 - smoothstep(uFadeStart, 1.0, length(p) / halfBox);

      acc += webColour(rho, infall, heat)
           * webIntensity(rho) * detail * edge
           * redshiftTint(t / uFar);
    }
    t += dt;
  }

  gl_FragColor = vec4(acc * uGain * dt, 1.0);
}
`;

export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
${GLSL_COLOR}

uniform sampler2D uHaze;
uniform vec2 uTexel;
uniform float uGain;

varying vec2 vUv;

void main(){
  // A small tent on the low-res buffer: the haze is a smooth field, so this
  // costs four taps and removes every trace of the upsample.
  vec3 c = texture2D(uHaze, vUv).rgb * 0.4;
  c += texture2D(uHaze, vUv + vec2( uTexel.x,  uTexel.y)).rgb * 0.15;
  c += texture2D(uHaze, vUv + vec2(-uTexel.x,  uTexel.y)).rgb * 0.15;
  c += texture2D(uHaze, vUv + vec2( uTexel.x, -uTexel.y)).rgb * 0.15;
  c += texture2D(uHaze, vUv + vec2(-uTexel.x, -uTexel.y)).rgb * 0.15;

  // Dither before the tone mapper sees it. These gradients are enormous and
  // very dark, which is exactly where 10-bit banding shows up on an OLED.
  c += (ignoise(gl_FragCoord.xy) - 0.5) * 0.0016;
  gl_FragColor = vec4(max(c, 0.0) * uGain, 1.0);
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   6. The particles
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Brightness follows the inverse square law honestly. A sprite's total flux is
 * its peak times its area, so when a particle is smaller than one pixel and we
 * clamp it up to stay visible, we dim it by exactly the area we stole. That is
 * what keeps the surface brightness of a filament constant as the camera pulls
 * back, instead of the whole web blowing out into a white sheet.
 */
export const POINTS_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${PALETTE_CHUNK}

uniform sampler2D uPos;
uniform sampler2D uVel;
uniform sampler2D uNL;
uniform sampler2D uDisp;

uniform float uGrowthRate;
uniform float uDisplayScale;
uniform float uSize;
uniform float uPixelScale;
uniform float uMinSize;
uniform float uMaxSize;
uniform float uBrightness;
uniform float uDivScale;
uniform float uHalfBox;
uniform float uFadeStart;
uniform float uFar;

varying vec3 vColor;
varying float vCore;

void main(){
  vec4 P = texture2D(uPos,  position.xy);
  vec4 V = texture2D(uVel,  position.xy);
  vec4 N = texture2D(uNL,   position.xy);
  vec4 D = texture2D(uDisp, position.xy);

  vec3 world = P.xyz * uDisplayScale;
  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;

  float dist = max(-mv.z, 1e-4);
  float trueSize = uSize * uPixelScale / dist;
  float drawn = clamp(trueSize, uMinSize, uMaxSize);
  float flux = trueSize / drawn;
  flux *= flux;

  float rho = P.w;
  // The Zel'dovich velocity is Ḋ·Ψ and lives in the static texture; only the
  // nonlinear remainder had to be integrated.
  vec3 vel = uGrowthRate * D.xyz + V.xyz;
  float infall = clamp(-V.w * uDivScale, -1.0, 1.0);
  float heat = N.w;

  float edge = 1.0 - smoothstep(uFadeStart, 1.0, length(P.xyz) / uHalfBox);
  vec3 tint = redshiftTint(dist / uFar);

  float lum = uBrightness * webIntensity(rho) * flux * edge;
  vColor = webColour(rho, infall, heat) * tint * lum;

  // A hard little core on the brightest particles. Bloom needs something well
  // above threshold to bite on, and this is what gives a cluster its starburst
  // instead of a flat bright disc.
  vCore = smoothstep(24.0, 160.0, rho) * lum * 2.2;

  gl_PointSize = drawn;
  #include <logdepthbuf_vertex>
}
`;

export const POINTS_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>

varying vec3 vColor;
varying float vCore;

void main(){
  #include <logdepthbuf_fragment>
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;

  // Gaussian core that reaches exactly zero at the sprite edge — a truncated
  // Gaussian leaves a faint square around every particle, and with a quarter
  // million of them that reads as a grid across the whole image.
  float falloff = exp(-r2 * 3.1) * (1.0 - r2);
  vec3 c = vColor * falloff + vColor * vCore * exp(-r2 * 20.0);
  gl_FragColor = vec4(c, 1.0);
}
`;
