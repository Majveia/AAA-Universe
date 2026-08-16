/**
 * The engine: renderer ownership, the frame loop, realm switching, and the
 * transition effect that hides the seam between scales.
 */

import {
  Clock,
  Color,
  LinearSRGBColorSpace,
  NoToneMapping,
  PCFSoftShadowMap,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  WebGLRenderer,
} from 'three';
import { Input } from './Input';
import { PostFX } from './PostFX';
import {
  AdaptiveQuality,
  DeviceInfo,
  QualityProfile,
  UserPrefs,
  guessTier,
  loadPrefs,
  probeDevice,
  savePrefs,
} from './Settings';
import type { Realm, RealmContext, RealmId } from './Realm';

export interface EngineStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
}

type TransitionPhase = 'none' | 'out' | 'in';

export class Engine {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: WebGLRenderer;
  readonly input: Input;
  readonly device: DeviceInfo;
  readonly adaptive: AdaptiveQuality;
  prefs: UserPrefs;
  postfx!: PostFX;

  /** Shared services (audio, hud, universe…) available to every realm. */
  readonly services: Record<string, any> = {};

  realms = new Map<RealmId, Realm>();
  current: Realm | null = null;

  time = 0;
  frame = 0;
  paused = false;
  /** Diagnostic: bypass the post chain and render the scene straight. */
  postEnabled = true;
  /** Global slow-motion / time-dilation factor applied to gameplay dt. */
  timeScale = 1;

  stats: EngineStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, programs: 0, geometries: 0, textures: 0 };

  private clock = new Clock();
  private running = false;
  private rafId = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private width = 1;
  private height = 1;
  private transition: { phase: TransitionPhase; t: number; dur: number; next: (() => void) | null } = {
    phase: 'none',
    t: 0,
    dur: 0.8,
    next: null,
  };

  onTransitionProgress: ((v: number, phase: TransitionPhase) => void) | null = null;
  onRealmChanged: ((id: RealmId) => void) | null = null;
  onQualityChanged: ((q: QualityProfile) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.prefs = loadPrefs();

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false, // SMAA in post; MSAA on an HDR buffer is not worth it
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      // Planet-scale scenes span 1 m to 10¹¹ m in one frame. A log depth
      // buffer is the only thing that keeps a rock and a gas giant both
      // z-correct at the same time.
      logarithmicDepthBuffer: true,
      preserveDrawingBuffer: true, // needed for photo mode + the critic harness
    });

    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.device = probeDevice(gl);

    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping; // handled in post, in HDR
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.setClearColor(new Color(0x000000), 1);
    this.renderer.info.autoReset = false;

    const tier = guessTier(this.device);
    this.adaptive = new AdaptiveQuality(tier, this.device.isMobile ? 45 : 60);
    if (!this.prefs.autoQuality) this.adaptive.enabled = false;
    this.adaptive.onChange = (q) => {
      this.applyQuality(q);
    };

    this.input = new Input(canvas);
    this.input.sensitivity = this.prefs.lookSensitivity;
    this.input.invertY = this.prefs.invertY;

    this.bindResize();
    this.resize();
  }

  get quality(): QualityProfile {
    return this.adaptive.profile;
  }

  /** Create the post chain once a realm exists (needs a scene + camera). */
  initPostFX(scene: Scene, camera: PerspectiveCamera): void {
    this.postfx = new PostFX(this.renderer, scene, camera, {
      quality: this.quality,
      filmGrain: this.prefs.filmGrain,
      vignette: this.prefs.vignette,
      chromaticAberration: this.prefs.chromaticAberration,
      depthOfField: true,
    });
    this.postfx.setSize(this.width, this.height);
  }

  registerRealm(realm: Realm): void {
    this.realms.set(realm.id, realm);
  }

  context(): RealmContext {
    return {
      engine: this,
      renderer: this.renderer,
      input: this.input,
      quality: this.quality,
      prefs: this.prefs,
      time: this.time,
      services: this.services,
    };
  }

  /**
   * Switch realms behind a warp. The out-phase is short and accelerating, the
   * in-phase is long and decelerating — the same asymmetry a good film cut has.
   */
  async goto(id: RealmId, payload?: any, duration = 1.5): Promise<void> {
    const realm = this.realms.get(id);
    if (!realm || realm === this.current) return;

    this.transition.phase = 'out';
    this.transition.t = 0;
    this.transition.dur = duration * 0.42;

    await new Promise<void>((resolve) => {
      this.transition.next = resolve;
    });

    this.current?.exit?.(this.context());
    await realm.enter(this.context(), payload);
    this.current = realm;
    this.postfx?.setScene(realm.scene);
    this.postfx?.setCamera(realm.camera);
    realm.resize?.(this.width, this.height);
    this.onRealmChanged?.(id);

    this.transition.phase = 'in';
    this.transition.t = 0;
    this.transition.dur = duration * 0.58;
    this.transition.next = null;
  }

  /** Immediate switch with no warp — used at boot. */
  async setRealm(id: RealmId, payload?: any): Promise<void> {
    const realm = this.realms.get(id);
    if (!realm) throw new Error(`Unknown realm: ${id}`);
    this.current?.exit?.(this.context());
    await realm.enter(this.context(), payload);
    this.current = realm;
    if (!this.postfx) this.initPostFX(realm.scene, realm.camera);
    else {
      this.postfx.setScene(realm.scene);
      this.postfx.setCamera(realm.camera);
    }
    realm.resize?.(this.width, this.height);
    this.onRealmChanged?.(id);
  }

  applyQuality(q: QualityProfile): void {
    this.renderer.shadowMap.enabled = q.shadows;
    this.resize();
    this.postfx?.setQuality(q);
    for (const r of this.realms.values()) r.setQuality?.(q);
    this.onQualityChanged?.(q);
  }

  setPrefs(p: Partial<UserPrefs>): void {
    Object.assign(this.prefs, p);
    savePrefs(this.prefs);
    this.input.sensitivity = this.prefs.lookSensitivity;
    this.input.invertY = this.prefs.invertY;
    if (this.postfx) {
      this.postfx.film.grain = this.prefs.filmGrain ? 0.028 : 0;
      this.postfx.film.vignette = this.prefs.vignette ? 0.34 : 0;
      this.postfx.lens.aberration = this.prefs.chromaticAberration ? 0.14 : 0;
    }
  }

  /* ─────────────────────────── loop ─────────────────────────── */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.step();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private step(): void {
    const rawDt = Math.min(this.clock.getDelta(), 0.1);
    const t0 = performance.now();

    // Transitions run on unscaled time so slow-motion can't strand a warp.
    if (this.transition.phase !== 'none') {
      this.transition.t += rawDt;
      const p = Math.min(1, this.transition.t / this.transition.dur);
      this.onTransitionProgress?.(this.transition.phase === 'out' ? p : 1 - p, this.transition.phase);
      if (p >= 1) {
        if (this.transition.phase === 'out' && this.transition.next) {
          const next = this.transition.next;
          this.transition.next = null;
          this.transition.phase = 'none';
          next();
        } else {
          this.transition.phase = 'none';
          this.onTransitionProgress?.(0, 'none');
        }
      }
    }

    const dt = this.paused ? 0 : rawDt * this.timeScale;
    this.time += dt;
    this.frame++;

    this.input.beginFrame(rawDt);

    if (this.current) {
      this.current.update(dt, this.context());
      this.renderer.info.reset();
      const handled = this.current.render?.(this.context(), rawDt);
      if (!handled && this.postfx && this.postEnabled) this.postfx.render(rawDt);
      else if (!handled) {
        this.renderer.setRenderTarget(null);
        this.renderer.render(this.current.scene, this.current.camera);
      }
    }

    this.input.endFrame();

    const frameMs = performance.now() - t0;
    this.adaptive.update(rawDt * 1000);

    this.fpsAccum += rawDt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.stats.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      const info = this.renderer.info;
      this.stats.drawCalls = info.render.calls;
      this.stats.triangles = info.render.triangles;
      this.stats.programs = info.programs?.length ?? 0;
      this.stats.geometries = info.memory.geometries;
      this.stats.textures = info.memory.textures;
    }
    this.stats.frameMs = frameMs;
  }

  /* ─────────────────────────── resize ─────────────────────────── */

  private bindResize(): void {
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => setTimeout(onResize, 120));
    if ('visualViewport' in window) {
      window.visualViewport?.addEventListener('resize', onResize);
    }
    document.addEventListener('visibilitychange', () => {
      // Returning from a background tab yields one enormous delta; swallow it.
      if (!document.hidden) this.clock.getDelta();
    });
  }

  resize(): void {
    const q = this.quality;
    const cssW = Math.max(1, window.innerWidth);
    const cssH = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, q.maxPixelRatio);
    const w = Math.max(2, Math.floor(cssW * dpr * q.renderScale));
    const h = Math.max(2, Math.floor(cssH * dpr * q.renderScale));

    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);

    this.postfx?.setSize(w, h);
    for (const r of this.realms.values()) r.resize?.(w, h);

    // Last, and deliberately so: EffectComposer.setSize forwards to
    // renderer.setSize *without* passing updateStyle, which three defaults to
    // true — so it stamps the drawing-buffer size onto the canvas CSS and the
    // render ends up occupying renderScale² of the window. Re-assert the CSS
    // size after everything else has had its say.
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
  }

  get aspect(): number {
    return this.width / this.height;
  }

  /** PNG data URL of the current frame — used by photo mode and the critic. */
  capture(): string {
    return this.canvas.toDataURL('image/png');
  }
}
