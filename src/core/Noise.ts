/**
 * Procedural noise — CPU and GPU implementations of *the same functions*.
 *
 * This dual implementation matters more than it looks. The GPU shades the
 * terrain; the CPU has to know exactly where the ground is so the player's feet
 * and the rover's wheels land on it. Any divergence between the two shows up as
 * characters sinking into hillsides. So the JS below is a literal port of the
 * GLSL below, arithmetic op for arithmetic op — including the integer hash,
 * which uses the same 32-bit avalanche on both sides.
 *
 * Simplex noise after Ashima Arts / Stefan Gustavson (MIT).
 */

/* ═══════════════════════════════════════════════════════════════════════════
   CPU
   ═══════════════════════════════════════════════════════════════════════════ */

const F3 = 1 / 3;
const G3 = 1 / 6;

function mod289(x: number): number {
  return x - Math.floor(x * (1 / 289)) * 289;
}
function permute(x: number): number {
  return mod289((x * 34 + 1) * x);
}
function taylorInvSqrt(r: number): number {
  return 1.79284291400159 - 0.85373472095314 * r;
}
function step(edge: number, x: number): number {
  return x >= edge ? 1 : 0;
}

/** 3D simplex noise in [-1,1]. Exact CPU twin of `snoise` in GLSL_NOISE. */
export function snoise3(vx: number, vy: number, vz: number): number {
  const s = (vx + vy + vz) * F3;
  const ix = Math.floor(vx + s);
  const iy = Math.floor(vy + s);
  const iz = Math.floor(vz + s);

  const t = (ix + iy + iz) * G3;
  const x0 = vx - ix + t;
  const y0 = vy - iy + t;
  const z0 = vz - iz + t;

  const gx = step(y0, x0);
  const gy = step(z0, y0);
  const gz = step(x0, z0);
  const lx = 1 - gx;
  const ly = 1 - gy;
  const lz = 1 - gz;

  const i1x = Math.min(gx, lz);
  const i1y = Math.min(gy, lx);
  const i1z = Math.min(gz, ly);
  const i2x = Math.max(gx, lz);
  const i2y = Math.max(gy, lx);
  const i2z = Math.max(gz, ly);

  const x1 = x0 - i1x + G3;
  const y1 = y0 - i1y + G3;
  const z1 = z0 - i1z + G3;
  const x2 = x0 - i2x + 2 * G3;
  const y2 = y0 - i2y + 2 * G3;
  const z2 = z0 - i2z + 2 * G3;
  const x3 = x0 - 1 + 3 * G3;
  const y3 = y0 - 1 + 3 * G3;
  const z3 = z0 - 1 + 3 * G3;

  const mi = mod289(ix);
  const mj = mod289(iy);
  const mk = mod289(iz);

  // p = permute(permute(permute(k + [0,i1z,i2z,1]) + j + [0,i1y,i2y,1]) + i + [0,i1x,i2x,1])
  const pa0 = permute(permute(permute(mk + 0) + mj + 0) + mi + 0);
  const pa1 = permute(permute(permute(mk + i1z) + mj + i1y) + mi + i1x);
  const pa2 = permute(permute(permute(mk + i2z) + mj + i2y) + mi + i2x);
  const pa3 = permute(permute(permute(mk + 1) + mj + 1) + mi + 1);

  const nsx = 2 / 7;
  const nsy = -1 + 0.5 / 7;
  const nsz = 1 / 7;

  const grad = (p: number): [number, number, number] => {
    const j = p - 49 * Math.floor(p * nsz * nsz);
    const xf = Math.floor(j * nsz);
    const yf = Math.floor(j - 7 * xf);
    const gxv = xf * nsx + nsy;
    const gyv = yf * nsx + nsy;
    const h = 1 - Math.abs(gxv) - Math.abs(gyv);
    const b0 = gxv;
    const b1 = gyv;
    const s0 = Math.floor(b0) * 2 + 1;
    const s1 = Math.floor(b1) * 2 + 1;
    const sh = -step(h, 0);
    return [b0 + s0 * sh, b1 + s1 * sh, h];
  };

  const g0 = grad(pa0);
  const g1 = grad(pa1);
  const g2 = grad(pa2);
  const g3 = grad(pa3);

  const n0 = taylorInvSqrt(g0[0] * g0[0] + g0[1] * g0[1] + g0[2] * g0[2]);
  const n1 = taylorInvSqrt(g1[0] * g1[0] + g1[1] * g1[1] + g1[2] * g1[2]);
  const n2 = taylorInvSqrt(g2[0] * g2[0] + g2[1] * g2[1] + g2[2] * g2[2]);
  const n3 = taylorInvSqrt(g3[0] * g3[0] + g3[1] * g3[1] + g3[2] * g3[2]);

  g0[0] *= n0; g0[1] *= n0; g0[2] *= n0;
  g1[0] *= n1; g1[1] *= n1; g1[2] *= n1;
  g2[0] *= n2; g2[1] *= n2; g2[2] *= n2;
  g3[0] *= n3; g3[1] *= n3; g3[2] *= n3;

  let m0 = Math.max(0.6 - (x0 * x0 + y0 * y0 + z0 * z0), 0);
  let m1 = Math.max(0.6 - (x1 * x1 + y1 * y1 + z1 * z1), 0);
  let m2 = Math.max(0.6 - (x2 * x2 + y2 * y2 + z2 * z2), 0);
  let m3 = Math.max(0.6 - (x3 * x3 + y3 * y3 + z3 * z3), 0);
  m0 *= m0; m0 *= m0;
  m1 *= m1; m1 *= m1;
  m2 *= m2; m2 *= m2;
  m3 *= m3; m3 *= m3;

  return (
    42 *
    (m0 * (g0[0] * x0 + g0[1] * y0 + g0[2] * z0) +
      m1 * (g1[0] * x1 + g1[1] * y1 + g1[2] * z1) +
      m2 * (g2[0] * x2 + g2[1] * y2 + g2[2] * z2) +
      m3 * (g3[0] * x3 + g3[1] * y3 + g3[2] * z3))
  );
}

export interface FbmOpts {
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  frequency?: number;
  amplitude?: number;
}

/** Classic fractal Brownian motion — the workhorse for rolling terrain. */
export function fbm3(x: number, y: number, z: number, o: FbmOpts = {}): number {
  const octaves = o.octaves ?? 6;
  const lac = o.lacunarity ?? 2.0;
  const gain = o.gain ?? 0.5;
  let f = o.frequency ?? 1;
  let a = o.amplitude ?? 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += a * snoise3(x * f, y * f, z * f);
    norm += a;
    f *= lac;
    a *= gain;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged multifractal — inverted, sharpened noise. This is what makes mountain
 * ranges look eroded rather than lumpy: the ridges are creases, not bumps.
 */
export function ridged3(x: number, y: number, z: number, o: FbmOpts = {}): number {
  const octaves = o.octaves ?? 6;
  const lac = o.lacunarity ?? 2.0;
  const gain = o.gain ?? 0.5;
  let f = o.frequency ?? 1;
  let a = o.amplitude ?? 1;
  let sum = 0;
  let norm = 0;
  let prev = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(snoise3(x * f, y * f, z * f));
    n *= n;
    n *= prev; // higher octaves suppressed in valleys → sharper crests
    prev = n;
    sum += a * n;
    norm += a;
    f *= lac;
    a *= gain;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Billow noise — puffy, cloud-like, good for dunes and cumulus. */
export function billow3(x: number, y: number, z: number, o: FbmOpts = {}): number {
  const octaves = o.octaves ?? 5;
  const lac = o.lacunarity ?? 2.0;
  const gain = o.gain ?? 0.5;
  let f = o.frequency ?? 1;
  let a = o.amplitude ?? 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += a * (Math.abs(snoise3(x * f, y * f, z * f)) * 2 - 1);
    norm += a;
    f *= lac;
    a *= gain;
  }
  return norm > 0 ? sum / norm : 0;
}

/* ---- integer hash, identical to the GLSL uint version ---- */

function ihash(x: number): number {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}

function hash3(i: number, j: number, k: number): number {
  return ihash((ihash((ihash(i) ^ (j * 0x9e3779b9)) >>> 0) ^ (k * 0x85ebca6b)) >>> 0);
}

/** Three decorrelated floats in [0,1) from an integer lattice cell. */
export function hash33(i: number, j: number, k: number, out: number[] = []): number[] {
  const h = hash3(i, j, k);
  out[0] = h / 4294967296;
  out[1] = ihash(h ^ 0x27d4eb2d) / 4294967296;
  out[2] = ihash(h ^ 0x165667b1) / 4294967296;
  return out;
}

const _c = [0, 0, 0];

/**
 * Worley / cellular noise. Returns [F1, F2] — distance to nearest and second
 * nearest feature point. F2-F1 gives the cracked-mud / crystal look; F1 alone
 * gives craters and bubbles.
 */
export function worley3(x: number, y: number, z: number, jitter = 1.0): [number, number] {
  const bx = Math.floor(x);
  const by = Math.floor(y);
  const bz = Math.floor(z);
  let f1 = 1e9;
  let f2 = 1e9;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = bx + dx;
        const cy = by + dy;
        const cz = bz + dz;
        hash33(cx, cy, cz, _c);
        const px = cx + 0.5 + (_c[0] - 0.5) * jitter;
        const py = cy + 0.5 + (_c[1] - 0.5) * jitter;
        const pz = cz + 0.5 + (_c[2] - 0.5) * jitter;
        const ex = px - x;
        const ey = py - y;
        const ez = pz - z;
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
  }
  return [f1, f2];
}

/** Smooth minimum — blends two signed fields without a crease. */
export function smin(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
export function saturate(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
/** Smoothstep's better-behaved cousin: zero 1st *and* 2nd derivative at ends. */
export function smootherstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
export function remap(v: number, a: number, b: number, c: number, d: number): number {
  return c + ((v - a) / (b - a)) * (d - c);
}

/* ═══════════════════════════════════════════════════════════════════════════
   GPU — paste `GLSL_NOISE` into any shader that needs it
   ═══════════════════════════════════════════════════════════════════════════ */

export const GLSL_NOISE = /* glsl */ `
#ifndef AEON_NOISE_INCLUDED
#define AEON_NOISE_INCLUDED

vec3 aeon_mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 aeon_mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 aeon_permute(vec4 x){ return aeon_mod289(((x*34.0)+1.0)*x); }
vec4 aeon_taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = aeon_mod289(i);
  vec4 p = aeon_permute(aeon_permute(aeon_permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = aeon_taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

// --- integer hash: bit-exact twin of the JS version ---
uint aeon_hashU(uint x){
  x ^= x >> 16u; x *= 0x21f0aaadu;
  x ^= x >> 15u; x *= 0x735a2d97u;
  x ^= x >> 15u; return x;
}
uint aeon_hash3u(ivec3 c){
  uint h = aeon_hashU(uint(c.x));
  h = aeon_hashU(h ^ (uint(c.y) * 0x9e3779b9u));
  h = aeon_hashU(h ^ (uint(c.z) * 0x85ebca6bu));
  return h;
}
vec3 hash33i(ivec3 c){
  uint h = aeon_hash3u(c);
  return vec3(
    float(h) / 4294967296.0,
    float(aeon_hashU(h ^ 0x27d4eb2du)) / 4294967296.0,
    float(aeon_hashU(h ^ 0x165667b1u)) / 4294967296.0
  );
}
float hash13(vec3 p){ return hash33i(ivec3(floor(p))).x; }

float fbm(vec3 p, int octaves, float lacunarity, float gain){
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int i = 0; i < 12; i++){
    if (i >= octaves) break;
    sum += amp * snoise(p);
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
float fbm(vec3 p, int octaves){ return fbm(p, octaves, 2.0, 0.5); }

float ridged(vec3 p, int octaves, float lacunarity, float gain){
  float sum = 0.0, amp = 1.0, norm = 0.0, prev = 1.0;
  for (int i = 0; i < 12; i++){
    if (i >= octaves) break;
    float n = 1.0 - abs(snoise(p));
    n *= n;
    n *= prev;
    prev = n;
    sum += amp * n;
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

float billow(vec3 p, int octaves, float lacunarity, float gain){
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int i = 0; i < 12; i++){
    if (i >= octaves) break;
    sum += amp * (abs(snoise(p)) * 2.0 - 1.0);
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

// F1 / F2 cellular
vec2 worley(vec3 p, float jitter){
  ivec3 b = ivec3(floor(p));
  float f1 = 1e9, f2 = 1e9;
  for (int dz = -1; dz <= 1; dz++)
  for (int dy = -1; dy <= 1; dy++)
  for (int dx = -1; dx <= 1; dx++){
    ivec3 c = b + ivec3(dx, dy, dz);
    vec3 r = hash33i(c);
    vec3 pt = vec3(c) + 0.5 + (r - 0.5) * jitter;
    float d = length(pt - p);
    if (d < f1){ f2 = f1; f1 = d; }
    else if (d < f2){ f2 = d; }
  }
  return vec2(f1, f2);
}

// Curl of a noise field — divergence-free, so particles advected by it swirl
// instead of clumping. Used for nebulae, smoke, and atmospheric flow.
vec3 curlNoise(vec3 p){
  const float e = 0.08;
  float n1, n2;
  n1 = snoise(vec3(p.x, p.y + e, p.z)); n2 = snoise(vec3(p.x, p.y - e, p.z));
  float a = n1 - n2;
  n1 = snoise(vec3(p.x, p.y, p.z + e)); n2 = snoise(vec3(p.x, p.y, p.z - e));
  float b = n1 - n2;
  n1 = snoise(vec3(p.x, p.y, p.z + e)); n2 = snoise(vec3(p.x, p.y, p.z - e));
  float c = n1 - n2;
  n1 = snoise(vec3(p.x + e, p.y, p.z)); n2 = snoise(vec3(p.x - e, p.y, p.z));
  float d = n1 - n2;
  n1 = snoise(vec3(p.x + e, p.y, p.z)); n2 = snoise(vec3(p.x - e, p.y, p.z));
  float f = n1 - n2;
  n1 = snoise(vec3(p.x, p.y + e, p.z)); n2 = snoise(vec3(p.x, p.y - e, p.z));
  float g = n1 - n2;
  return normalize(vec3(a - b, c - d, f - g) / (2.0 * e));
}

float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

#endif
`;

/** Dithering + colour utilities every shader in the project shares. */
export const GLSL_COLOR = /* glsl */ `
#ifndef AEON_COLOR_INCLUDED
#define AEON_COLOR_INCLUDED

// Interleaved gradient noise — the cheapest good dither. Essential on OLED:
// without it, dark gradients band into visible steps.
float ignoise(vec2 uv){
  return fract(52.9829189 * fract(dot(uv, vec2(0.06711056, 0.00583715))));
}

vec3 dither(vec3 c, vec2 fragCoord, float amount){
  return c + (ignoise(fragCoord) - 0.5) * amount;
}

// Blackbody radiance colour (Planck locus approximation, Tanner Helland fit).
// Drives star colour, lava, hot metal, engine exhaust.
vec3 blackbody(float tempK){
  float t = clamp(tempK, 1000.0, 40000.0) / 100.0;
  float r, g, b;
  if (t <= 66.0) {
    r = 255.0;
    g = 99.4708025861 * log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * pow(t - 60.0, -0.1332047592);
    g = 288.1221695283 * pow(t - 60.0, -0.0755148492);
  }
  if (t >= 66.0) b = 255.0;
  else if (t <= 19.0) b = 0.0;
  else b = 138.5177312231 * log(t - 10.0) - 305.0447927307;
  return clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
}

vec3 srgbToLinear(vec3 c){
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

float luminance(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

#endif
`;
