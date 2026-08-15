/**
 * The post chain. This is where a competent render becomes a photograph.
 *
 * Ordering follows a real camera: the scene is lit and exposed in linear HDR,
 * then depth-of-field (lens), then bloom (veiling glare in the optics), then
 * chromatic aberration and distortion (glass), then exposure + tone mapping
 * (sensor), then vignette and grain (film), and finally anti-aliasing on the
 * display-referred image.
 *
 * AgX tone mapping is the default rather than ACES because ÆON is full of
 * extremely bright, extremely saturated things — stars, plasma, neon — and
 * ACES turns those into flat clipped discs. AgX keeps hue as it desaturates
 * into the highlight, so a blue supergiant still reads as blue at its core.
 */

import {
  BloomEffect,
  BlendFunction,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  KernelSize,
  NoiseEffect,
  NormalPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  SSAOEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  Effect,
} from 'postprocessing';
import {
  Camera,
  HalfFloatType,
  PerspectiveCamera,
  Scene,
  Uniform,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { QualityProfile } from './Settings';
import { GLSL_COLOR } from './Noise';

/* ═══════════════════════════════════════════════════════════════════════════
   Custom effect: anamorphic streaks + lens dirt + starburst
   ═══════════════════════════════════════════════════════════════════════════ */

const LENS_FRAG = /* glsl */ `
${GLSL_COLOR}

uniform float uIntensity;
uniform float uStreak;
uniform float uTime;
uniform float uAberration;
uniform float uGrain;
uniform float uVignette;
uniform float uExposure;
uniform vec2  uResolution;

// A cheap horizontal streak sampled from the already-bloomed image. Real
// anamorphic flare is a convolution; four taps at growing offsets sells it.
vec3 anamorphic(sampler2D tex, vec2 uv){
  vec3 acc = vec3(0.0);
  float w = 0.0;
  for (int i = 1; i <= 12; i++){
    float f = float(i);
    float off = f * 0.0055 * uStreak;
    float weight = exp(-f * 0.30);
    vec3 a = texture2D(tex, uv + vec2(off, 0.0)).rgb;
    vec3 b = texture2D(tex, uv - vec2(off, 0.0)).rgb;
    // Only genuinely bright pixels streak, otherwise the whole frame smears.
    a = max(a - 1.05, 0.0);
    b = max(b - 1.05, 0.0);
    acc += (a + b) * weight;
    w += weight * 2.0;
  }
  return acc / max(w, 0.0001) * vec3(0.42, 0.66, 1.0);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
  vec2 centered = uv - 0.5;
  float r2 = dot(centered, centered);

  // Lateral chromatic aberration: grows with the square of image height, the
  // way an actual uncorrected lens behaves. Zero in the middle of the frame.
  vec2 caOff = centered * r2 * uAberration;
  vec3 col;
  col.r = texture2D(inputBuffer, uv - caOff).r;
  col.g = inputColor.g;
  col.b = texture2D(inputBuffer, uv + caOff).b;

  col += anamorphic(inputBuffer, uv) * uIntensity;

  outputColor = vec4(col, inputColor.a);
}
`;

class LensEffect extends Effect {
  constructor(opts: { intensity?: number; streak?: number; aberration?: number } = {}) {
    super('LensEffect', LENS_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform<any>>([
        ['uIntensity', new Uniform(opts.intensity ?? 0.5)],
        ['uStreak', new Uniform(opts.streak ?? 1.0)],
        ['uTime', new Uniform(0)],
        ['uAberration', new Uniform(opts.aberration ?? 0.9)],
        ['uGrain', new Uniform(0.02)],
        ['uVignette', new Uniform(0.35)],
        ['uExposure', new Uniform(1)],
        ['uResolution', new Uniform(new Vector2(1, 1))],
      ]),
    });
  }
  set intensity(v: number) {
    (this.uniforms.get('uIntensity') as Uniform<number>).value = v;
  }
  set aberration(v: number) {
    (this.uniforms.get('uAberration') as Uniform<number>).value = v;
  }
  update(_r: WebGLRenderer, _i: any, dt: number): void {
    const u = this.uniforms.get('uTime') as Uniform<number>;
    u.value += dt;
  }
  setSize(w: number, h: number): void {
    (this.uniforms.get('uResolution') as Uniform<Vector2>).value.set(w, h);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Custom effect: filmic finish (exposure, grain, vignette, subtle halation)
   ═══════════════════════════════════════════════════════════════════════════ */

const FILM_FRAG = /* glsl */ `
${GLSL_COLOR}

uniform float uTime;
uniform float uGrain;
uniform float uVignette;
uniform float uSaturation;
uniform float uLift;
uniform vec3  uShadowTint;
uniform vec3  uHighlightTint;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
  vec3 c = inputColor.rgb;

  // Split-tone: cool the shadows, warm the highlights. One of the cheapest,
  // most effective things you can do to make a render feel photographed.
  float l = luminance(c);
  vec3 tint = mix(uShadowTint, uHighlightTint, smoothstep(0.05, 0.75, l));
  c *= tint;

  // Saturation around luminance.
  c = mix(vec3(l), c, uSaturation);

  // Vignette — smooth, natural falloff, never a hard ring.
  vec2 d = (uv - 0.5) * vec2(1.0, 1.0);
  float vig = 1.0 - uVignette * pow(dot(d, d) * 2.0, 1.35);
  c *= clamp(vig, 0.0, 1.0);

  // Gentle black lift so shadows read as film, not as crushed digital void.
  c = c * (1.0 - uLift) + uLift * vec3(0.012, 0.016, 0.028);

  // Grain scaled by 1-luminance: film grain lives in the mids and shadows.
  float g = ignoise(gl_FragCoord.xy + vec2(uTime * 61.0, uTime * 37.0)) - 0.5;
  c += g * uGrain * (0.35 + 0.9 * (1.0 - l));

  // Final dither. Without this, an OLED shows visible banding across any
  // large dark gradient — which in a space game is most of the screen.
  c += (ignoise(gl_FragCoord.xy * 1.7 + 11.0) - 0.5) * (1.0 / 255.0);

  outputColor = vec4(c, inputColor.a);
}
`;

export class FilmEffect extends Effect {
  constructor() {
    super('FilmEffect', FILM_FRAG, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform<any>>([
        ['uTime', new Uniform(0)],
        ['uGrain', new Uniform(0.028)],
        ['uVignette', new Uniform(0.34)],
        ['uSaturation', new Uniform(1.06)],
        ['uLift', new Uniform(0.02)],
        ['uShadowTint', new Uniform(new Vector3(0.93, 0.97, 1.06))],
        ['uHighlightTint', new Uniform(new Vector3(1.04, 1.0, 0.95))],
      ]),
    });
  }
  update(_r: WebGLRenderer, _i: any, dt: number): void {
    (this.uniforms.get('uTime') as Uniform<number>).value += dt;
  }
  set grain(v: number) {
    (this.uniforms.get('uGrain') as Uniform<number>).value = v;
  }
  set vignette(v: number) {
    (this.uniforms.get('uVignette') as Uniform<number>).value = v;
  }
  set saturation(v: number) {
    (this.uniforms.get('uSaturation') as Uniform<number>).value = v;
  }
  /** Push toward a mood: 0 = neutral, 1 = deep cyan/amber cinematic. */
  setMood(shadow: [number, number, number], highlight: [number, number, number]): void {
    (this.uniforms.get('uShadowTint') as Uniform<Vector3>).value.set(...shadow);
    (this.uniforms.get('uHighlightTint') as Uniform<Vector3>).value.set(...highlight);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Chain
   ═══════════════════════════════════════════════════════════════════════════ */

export interface PostFXOptions {
  quality: QualityProfile;
  filmGrain: boolean;
  vignette: boolean;
  chromaticAberration: boolean;
  depthOfField: boolean;
}

export class PostFX {
  composer: EffectComposer;
  bloom!: BloomEffect;
  film!: FilmEffect;
  lens!: LensEffect;
  dof: DepthOfFieldEffect | null = null;
  ssao: SSAOEffect | null = null;
  toneMapping!: ToneMappingEffect;
  vignetteEffect!: VignetteEffect;

  private renderer: WebGLRenderer;
  private scene: Scene;
  private camera: PerspectiveCamera;
  private opts: PostFXOptions;
  private normalPass: NormalPass | null = null;
  private renderPass!: RenderPass;
  private width = 1;
  private height = 1;

  constructor(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, opts: PostFXOptions) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.opts = opts;
    this.composer = new EffectComposer(renderer, {
      frameBufferType: HalfFloatType,
      multisampling: 0,
    });
    this.build();
  }

  private disposePasses(): void {
    const passes = [...(this.composer as any).passes];
    for (const p of passes) {
      this.composer.removePass(p);
      p.dispose?.();
    }
    this.normalPass = null;
    this.dof = null;
    this.ssao = null;
  }

  build(): void {
    this.disposePasses();
    const q = this.opts.quality;

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    // --- ambient occlusion --------------------------------------------------
    if (q.ssao) {
      this.normalPass = new NormalPass(this.scene, this.camera);
      this.normalPass.enabled = true;
      this.composer.addPass(this.normalPass);
      this.ssao = new SSAOEffect(this.camera, this.normalPass.texture, {
        blendFunction: BlendFunction.MULTIPLY,
        distanceScaling: true,
        depthAwareUpsampling: true,
        samples: q.tier === 'ultra' ? 24 : 12,
        rings: 5,
        luminanceInfluence: 0.55,
        radius: 0.055,
        intensity: 1.35,
        bias: 0.03,
        fade: 0.02,
        resolutionScale: q.tier === 'ultra' ? 1 : 0.6,
        worldDistanceThreshold: 800,
        worldDistanceFalloff: 200,
        worldProximityThreshold: 4,
        worldProximityFalloff: 1,
      });
      this.composer.addPass(new EffectPass(this.camera, this.ssao));
    }

    // --- lens: depth of field (its own pass; it is a convolution) -----------
    if (q.depthOfField && this.opts.depthOfField) {
      this.dof = new DepthOfFieldEffect(this.camera, {
        focusDistance: 0.02,
        focalLength: 0.035,
        bokehScale: 2.6,
        resolutionScale: 0.75,
      });
      this.composer.addPass(new EffectPass(this.camera, this.dof));
    }

    // --- glare --------------------------------------------------------------
    this.bloom = new BloomEffect({
      blendFunction: BlendFunction.ADD,
      mipmapBlur: true,
      luminanceThreshold: 0.62,
      luminanceSmoothing: 0.22,
      intensity: 1.15,
      radius: 0.72,
      levels: q.tier === 'potato' ? 5 : 8,
      kernelSize: KernelSize.MEDIUM,
    });

    this.lens = new LensEffect({
      intensity: q.tier === 'potato' || q.tier === 'low' ? 0.0 : 0.55,
      streak: 1.0,
      aberration: this.opts.chromaticAberration ? 0.55 : 0,
    });

    this.toneMapping = new ToneMappingEffect({
      mode: ToneMappingMode.AGX,
      resolution: 256,
      whitePoint: 12.0,
      middleGrey: 0.35,
      minLuminance: 0.005,
      averageLuminance: 0.28,
      adaptationRate: 1.2,
    });

    this.film = new FilmEffect();
    this.film.grain = this.opts.filmGrain ? 0.028 : 0;
    this.film.vignette = this.opts.vignette ? 0.34 : 0;

    const chain: Effect[] = [this.bloom, this.lens, this.toneMapping, this.film];
    this.composer.addPass(new EffectPass(this.camera, ...chain));

    // --- anti-aliasing, last, on the display-referred image -----------------
    if (q.antialias === 'smaa') {
      const smaa = new SMAAEffect({
        preset: q.tier === 'ultra' || q.tier === 'high' ? SMAAPreset.ULTRA : SMAAPreset.HIGH,
      });
      this.composer.addPass(new EffectPass(this.camera, smaa));
    }

    this.composer.setSize(this.width, this.height);
  }

  setQuality(q: QualityProfile): void {
    this.opts.quality = q;
    this.build();
  }

  setCamera(cam: PerspectiveCamera): void {
    this.camera = cam;
    for (const p of (this.composer as any).passes) {
      p.mainCamera = cam;
      p.camera = cam;
    }
    this.renderPass.mainCamera = cam;
  }

  setScene(scene: Scene): void {
    this.scene = scene;
    this.renderPass.mainScene = scene;
    if (this.normalPass) (this.normalPass as any).mainScene = scene;
  }

  setSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.composer.setSize(w, h);
  }

  /** Focus distance in world units — driven by what the player is looking at. */
  setFocus(distance: number): void {
    if (!this.dof) return;
    const t = (this.dof as any).cocMaterial;
    if (t) t.focusDistance = Math.min(1, distance / this.camera.far);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.disposePasses();
    this.composer.dispose();
  }
}
