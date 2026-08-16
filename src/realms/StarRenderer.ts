/**
 * Stars.
 *
 * A star is the brightest object the engine will ever draw, and it has to work
 * at every distance: a pinprick from four light years, a disc from an outer
 * planet, and a wall of boiling plasma from close orbit. The trick is that
 * "brightness" here is genuinely HDR — the photosphere emits values in the
 * thousands, and the post chain's AgX curve and bloom turn that into the
 * blinding, hue-preserving glare a real star has.
 *
 * Modelled: limb darkening (the edge of the Sun is measurably dimmer than the
 * centre, which is why it reads as a sphere and not a disc), convective
 * granulation advected by rotation, starspots, chromospheric prominences, and
 * for degenerate remnants, a relativistically beamed accretion disc.
 */

import {
  AdditiveBlending,
  BackSide,
  Color,
  DoubleSide,
  FrontSide,
  Mesh,
  Object3D,
  PlaneGeometry,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Uniform,
  Vector3,
} from 'three';
import { GLSL_COLOR, GLSL_NOISE } from '../core/Noise';
import type { StarSpec } from '../universe/Types';

const PHOTOSPHERE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocal;
varying vec3 vView;
void main(){
  vLocal = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const PHOTOSPHERE_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}
${GLSL_COLOR}

uniform float uTime;
uniform float uTemp;
uniform float uActivity;
uniform float uGranulation;
uniform float uIntensity;
uniform vec3  uColor;
uniform float uSpin;

varying vec3 vLocal;
varying vec3 vView;

void main(){
  #include <logdepthbuf_fragment>

  vec3 n = normalize(vLocal);
  vec3 v = normalize(vView);
  float mu = clamp(dot(n, v), 0.0, 1.0);

  // Rotate the convection pattern with the star.
  float a = uSpin;
  mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
  vec3 p = n;
  p.xz = rot * p.xz;

  // Granulation: supergranules modulating granules, both drifting. Real
  // convection cells are polygonal with dark lanes between them, which is
  // exactly what the F2-F1 form of worley noise gives you.
  vec2 wl = worley(p / max(uGranulation, 1e-4), 1.0);
  float lanes = smoothstep(0.0, 0.35, wl.y - wl.x);
  vec2 wl2 = worley(p / (uGranulation * 5.0) + vec2(uTime * 0.02).xxy.xy, 1.0);
  float superg = smoothstep(0.0, 0.5, wl2.y - wl2.x);

  float turb = fbm(p * 24.0 + vec3(0.0, uTime * 0.09, 0.0), 5) * 0.5 + 0.5;
  float cells = mix(0.55, 1.25, lanes) * mix(0.85, 1.1, superg) * mix(0.82, 1.18, turb);

  // Starspots: cool magnetic regions, more of them on active stars.
  float spotField = fbm(p * 3.1 + vec3(11.0, uTime * 0.011, 3.0), 4);
  float spot = smoothstep(0.36, 0.62, spotField * uActivity * 1.7);
  cells *= mix(1.0, 0.32, spot);

  // Limb darkening — the Eddington approximation, I(mu)/I(1) = 0.4 + 0.6*mu.
  // Without this a star is a flat sticker; with it, it is a sphere.
  float limb = 0.35 + 0.65 * pow(mu, 0.62);

  // Hotter in the granule centres, cooler in the lanes: shift the blackbody
  // temperature rather than tinting, so the colour physics stays honest.
  float localTemp = uTemp * mix(0.93, 1.06, cells * 0.5 + 0.25);
  vec3 col = blackbody(localTemp) * uColor;

  // Chromospheric edge: a thin hot rim where we look through more plasma.
  float rim = pow(1.0 - mu, 3.0);
  col += blackbody(uTemp * 1.5) * rim * uActivity * 0.9;

  gl_FragColor = vec4(col * cells * limb * uIntensity, 1.0);
}
`;

const CORONA_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocal;
varying vec3 vView;
void main(){
  vLocal = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const CORONA_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}
${GLSL_COLOR}

uniform float uTime;
uniform float uTemp;
uniform float uActivity;
uniform float uIntensity;
uniform vec3  uColor;
uniform float uInner;   // photosphere radius / shell radius

varying vec3 vLocal;
varying vec3 vView;

void main(){
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vLocal);
  vec3 v = normalize(vView);
  float mu = abs(dot(n, v));

  // Optical depth through a shell: thickest at the limb, which is why a
  // corona looks like a ring rather than a fog.
  float shell = pow(1.0 - mu, 2.2);

  // Streamers along magnetic field lines, stretched radially.
  vec3 p = n * 3.0;
  float streamers = fbm(vec3(p.x, p.y * 0.35, p.z) + vec3(0.0, uTime * 0.05, 0.0), 5) * 0.5 + 0.5;
  streamers = pow(streamers, 1.8);

  // Prominences: violent loops that live briefly and only on active stars.
  float loops = ridged(n * 6.0 + vec3(uTime * 0.13, 0.0, 0.0), 4, 2.1, 0.55);
  loops = smoothstep(0.55, 0.95, loops) * uActivity;

  float density = shell * (0.35 + streamers * 0.9) + loops * shell * 2.2;
  vec3 col = blackbody(uTemp * 1.25) * uColor;
  col += vec3(1.4, 0.35, 0.25) * loops * 2.0;

  float alpha = clamp(density, 0.0, 1.0);
  gl_FragColor = vec4(col * density * uIntensity, alpha);
}
`;

/**
 * The accretion disc of a compact object. Doppler beaming makes the side
 * rotating toward us dramatically brighter and bluer — the single detail that
 * separates a convincing black hole from a glowing donut.
 */
const DISC_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${GLSL_NOISE}
${GLSL_COLOR}

uniform float uTime;
uniform float uInner;
uniform float uOuter;
uniform float uIntensity;
uniform float uSpin;
uniform vec3  uViewDir;

varying vec2 vUvR;   // x = normalised radius, y = angle
varying vec3 vWorld;

void main(){
  #include <logdepthbuf_fragment>
  float r = vUvR.x;
  if (r < 0.0 || r > 1.0) discard;

  float radius = mix(uInner, uOuter, r);
  // Keplerian shear: inner material laps the outer, so the turbulence winds
  // into spirals on its own instead of being drawn as spirals.
  float omega = pow(radius / uInner, -1.5);
  float ang = vUvR.y + uTime * omega * 0.6 * uSpin;

  vec3 p = vec3(cos(ang) * radius, 0.0, sin(ang) * radius) / uInner;
  float turb = fbm(p * 2.4 + vec3(0.0, uTime * 0.05, 0.0), 5) * 0.5 + 0.5;
  float bands = fbm(vec3(r * 26.0, uTime * 0.1, 0.0), 3) * 0.5 + 0.5;

  // Temperature profile of a thin disc: T ∝ r^(-3/4).
  float temp = 2.6e4 * pow(radius / uInner, -0.75);

  // Relativistic beaming: I' = I * D^4 where D is the Doppler factor. The
  // approaching limb can be an order of magnitude brighter.
  vec3 vel = normalize(vec3(-sin(ang), 0.0, cos(ang)));
  float beta = clamp(0.42 * pow(radius / uInner, -0.5), 0.0, 0.85);
  float cosT = dot(vel, normalize(uViewDir));
  float doppler = 1.0 / max(0.15, (1.0 - beta * cosT));
  float beam = pow(doppler, 3.2);

  vec3 col = blackbody(temp * doppler) * turb * mix(0.6, 1.4, bands) * beam;

  // Thin the disc at both edges so it does not end on a hard ring.
  float edge = smoothstep(0.0, 0.06, r) * (1.0 - smoothstep(0.82, 1.0, r));
  gl_FragColor = vec4(col * uIntensity * edge, edge);
}
`;

const DISC_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUvR;
varying vec3 vWorld;
void main(){
  // RingGeometry uv.x runs across the radius, uv.y around the circumference.
  vUvR = vec2(uv.x, uv.y * 6.2831853);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

export class StarRenderer {
  readonly root = new Object3D();
  private photosphere: Mesh | null = null;
  private corona: Mesh | null = null;
  private disc: Mesh | null = null;
  private spec: StarSpec | null = null;
  private time = 0;
  private uniforms: Record<string, Uniform<any>> = {};

  build(spec: StarSpec): void {
    this.dispose();
    this.spec = spec;
    const isBH = spec.compact?.kind === 'black-hole';
    const r = isBH ? spec.compact!.schwarzschildM : spec.radiusM;

    // Luminance scaling: map bolometric luminosity onto a sane HDR range so a
    // red dwarf is dim and an O star is punishing, without either breaking the
    // tone curve. Log-compressed because the real range is 10 decades.
    const lsol = spec.luminosityW / 3.828e26;
    const intensity = isBH ? 0 : Math.pow(Math.max(1e-5, lsol), 0.18) * 9.0;

    if (!isBH) {
      const geo = new SphereGeometry(r, 96, 64);
      this.uniforms = {
        uTime: new Uniform(0),
        uTemp: new Uniform(spec.tempK),
        uActivity: new Uniform(spec.activity),
        uGranulation: new Uniform(spec.granulation),
        uIntensity: new Uniform(intensity),
        uColor: new Uniform(new Color(...spec.color)),
        uSpin: new Uniform(0),
      };
      const mat = new ShaderMaterial({
        vertexShader: PHOTOSPHERE_VERT,
        fragmentShader: PHOTOSPHERE_FRAG,
        uniforms: this.uniforms,
        side: FrontSide,
        toneMapped: false,
      });
      this.photosphere = new Mesh(geo, mat);
      this.root.add(this.photosphere);

      // Corona shell. Bigger and more structured on active, cooler stars.
      const cr = r * (1.45 + spec.activity * 0.9);
      const cgeo = new SphereGeometry(cr, 64, 48);
      const cmat = new ShaderMaterial({
        vertexShader: CORONA_VERT,
        fragmentShader: CORONA_FRAG,
        uniforms: {
          uTime: new Uniform(0),
          uTemp: new Uniform(spec.tempK),
          uActivity: new Uniform(spec.activity),
          uIntensity: new Uniform(intensity * 0.35),
          uColor: new Uniform(new Color(...spec.color)),
          uInner: new Uniform(r / cr),
        },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: BackSide,
        toneMapped: false,
      });
      this.corona = new Mesh(cgeo, cmat);
      this.root.add(this.corona);
    }

    // Accretion disc for anything degenerate that is actively feeding.
    const acc = spec.compact?.accretionW ?? 0;
    if (acc > 0) {
      const inner = isBH ? r * 3 : r * 4; // ISCO for a Schwarzschild hole
      const outer = inner * 22;
      const geo = new RingGeometry(inner, outer, 256, 48);
      const mat = new ShaderMaterial({
        vertexShader: DISC_VERT,
        fragmentShader: DISC_FRAG,
        uniforms: {
          uTime: new Uniform(0),
          uInner: new Uniform(inner),
          uOuter: new Uniform(outer),
          uIntensity: new Uniform(Math.pow(acc / 1e30, 0.2) * 6),
          uSpin: new Uniform(spec.compact!.spin),
          uViewDir: new Uniform(new Vector3(0, 0, 1)),
        },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
        toneMapped: false,
      });
      this.disc = new Mesh(geo, mat);
      this.disc.rotation.x = Math.PI / 2;
      this.root.add(this.disc);
    }

    if (isBH) {
      // The hole itself: an absolutely black sphere at the photon sphere. It
      // needs to write depth so the disc behind it is genuinely occluded.
      const geo = new SphereGeometry(r * 1.5, 64, 48);
      const mat = new ShaderMaterial({
        vertexShader: PHOTOSPHERE_VERT,
        fragmentShader: /* glsl */ `
          #include <common>
          #include <logdepthbuf_pars_fragment>
          varying vec3 vLocal; varying vec3 vView;
          void main(){
            #include <logdepthbuf_fragment>
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
          }
        `,
        uniforms: {},
        toneMapped: false,
      });
      this.photosphere = new Mesh(geo, mat);
      this.root.add(this.photosphere);
    }
  }

  update(dt: number, cameraWorldPos: Vector3): void {
    if (!this.spec) return;
    this.time += dt;
    const spin = this.spec.rotationS > 0 ? (this.time / this.spec.rotationS) * Math.PI * 2 : 0;

    const setU = (m: Mesh | null, k: string, v: any) => {
      if (!m) return;
      const u = (m.material as ShaderMaterial).uniforms?.[k];
      if (u) u.value = v;
    };
    setU(this.photosphere, 'uTime', this.time);
    setU(this.photosphere, 'uSpin', spin);
    setU(this.corona, 'uTime', this.time);
    if (this.disc) {
      setU(this.disc, 'uTime', this.time);
      const u = (this.disc.material as ShaderMaterial).uniforms.uViewDir;
      if (u) {
        this.root.getWorldPosition(u.value as Vector3);
        (u.value as Vector3).sub(cameraWorldPos).normalize();
      }
    }
  }

  dispose(): void {
    for (const m of [this.photosphere, this.corona, this.disc]) {
      if (!m) continue;
      this.root.remove(m);
      m.geometry.dispose();
      (m.material as ShaderMaterial).dispose();
    }
    this.photosphere = null;
    this.corona = null;
    this.disc = null;
  }
}
