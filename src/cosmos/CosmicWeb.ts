/**
 * The cosmic web.
 *
 * 262,144 particles carrying the largest structure in the universe, integrated
 * on the GPU and scrubbable in cosmic time. The physics is in Cosmology.ts
 * (Friedmann), Field.ts (the Gaussian random field and its Zel'dovich
 * displacement) and Shaders.ts (the six-stage pipeline). This file is the
 * conductor: it owns the render targets, orders the passes, and decides how
 * fast time runs.
 *
 * Per frame:
 *   SPLAT   particles deposit mass and momentum into a 3D grid (a 2D atlas)
 *   BLUR    six separable passes — simultaneously the Green's function for
 *           the force solve and the thing that turns points into gas
 *   SIM     x = q + D(a)·Ψ(q) + Δ, where Δ integrates the grid force
 *   HAZE    raymarch the grid into a low-res HDR nebular glow
 *   POINTS  additive HDR sprites coloured by density, infall and shock heat
 *   COMPOSITE  the haze, upsampled, behind the points
 *
 * The Zel'dovich terms depend on time only through the growth factor D(a),
 * which is why the epoch can be scrubbed instantly in either direction: rewind
 * is not a replay, it is the same closed-form map evaluated at a smaller D.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  Matrix4,
  Mesh,
  NormalBlending,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Uniform,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import type { CosmicWebStats, ICosmicWeb, SystemContext } from '../api/Contracts';
import type { QualityProfile } from '../core/Settings';
import { Cosmology, DELTA_C } from './Cosmology';
import { PrimordialField } from './Field';
import { NodeCatalog } from './NodeCatalog';
import { QuadRunner, clearTarget, createTarget, probeFloatTargets, textureOf } from './GpuUtil';
import type { TargetOptions } from './GpuUtil';
import {
  BLUR_FRAG,
  COMPOSITE_FRAG,
  HAZE_FRAG,
  INIT_FRAG,
  POINTS_FRAG,
  POINTS_VERT,
  QUAD_VERT,
  SIM_FRAG,
  SPLAT_FRAG,
  SPLAT_VERT,
} from './Shaders';

/** Comoving box side, in megaparsecs. Also the size in world units. */
const BOX_MPC = 300;
/**
 * Cells per side of the density grid, chosen from the particle lattice.
 *
 * This has to track the particle count or the whole thing quietly renders
 * black: mass assignment only means anything with several particles per cell,
 * and a fixed 64³ grid holding 24³ particles gives 0.05 of a particle per cell,
 * so almost every cell is empty and the density field — and therefore every
 * colour and every force derived from it — is zero.
 */
const GRID_COLS = 8;
function gridSideFor(lattice: number): number {
  // Must stay divisible by GRID_COLS so the Z slices tile into a square atlas.
  if (lattice <= 24) return 16;
  if (lattice <= 48) return 32;
  return 64;
}

/** Lattice side per tier — the particle count is the cube of this. */
function latticeFor(budget: number): number {
  const l = Math.cbrt(budget);
  for (const c of [72, 64, 56, 48, 40, 32, 24]) if (c <= l) return c;
  return 24;
}

export class CosmicWeb implements ICosmicWeb {
  readonly root = new Object3D();

  private cosmology = new Cosmology();
  private field: PrimordialField;
  private catalog: NodeCatalog | null = null;
  private quad = new QuadRunner();

  /** Scale factor being displayed, and where it is heading. */
  private a = 0.06;
  private aTarget = 1.0;
  private timeRate = 1;
  private simTimeGyr = 0;
  private elapsed = 0;

  private renderer: WebGLRenderer | null = null;
  private quality: QualityProfile | null = null;
  private lattice = 64;
  private particles = 262144;
  private texW = 512;
  private texH = 512;
  private built = false;
  private floatOk = true;

  private modesTex: DataTexture | null = null;
  private initTarget: WebGLRenderTarget | null = null;
  private simA: WebGLRenderTarget | null = null;
  private simB: WebGLRenderTarget | null = null;
  private gridA: WebGLRenderTarget | null = null;
  private gridB: WebGLRenderTarget | null = null;
  private hazeTarget: WebGLRenderTarget | null = null;

  private initMat: ShaderMaterial | null = null;
  private simMat: ShaderMaterial | null = null;
  private blurMat: ShaderMaterial | null = null;
  private hazeMat: ShaderMaterial | null = null;
  private splatMat: ShaderMaterial | null = null;
  private pointsMat: ShaderMaterial | null = null;
  private compositeMat: ShaderMaterial | null = null;

  private splatPoints: Points | null = null;
  private webPoints: Points | null = null;
  private compositeMesh: Mesh | null = null;
  /** A scene of one, used only to draw the splat into the grid. */
  private splatScene = new Scene();

  private gridN = 64;
  private gridInfo = new Vector4(64, GRID_COLS, 64 * GRID_COLS, 64 * (64 / GRID_COLS));
  private gridBox = new Vector4(-BOX_MPC / 2, -BOX_MPC / 2, -BOX_MPC / 2, BOX_MPC);
  private invViewProj = new Matrix4();
  private invModel = new Matrix4();

  constructor(seed: number | string = 'AEON-WEB') {
    this.field = new PrimordialField(seed, { modes: 384 });
    this.root.name = 'CosmicWeb';
    this.root.frustumCulled = false;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Build
     ═══════════════════════════════════════════════════════════════════════ */

  private build(renderer: WebGLRenderer, quality: QualityProfile): void {
    this.teardownGpu();
    this.renderer = renderer;
    this.quality = quality;

    const probe = probeFloatTargets(renderer);
    this.floatOk = probe.full || probe.half;


    this.lattice = latticeFor(quality.cosmicWebParticles);
    this.particles = this.lattice ** 3;
    this.gridN = gridSideFor(this.lattice);
    this.gridInfo.set(
      this.gridN,
      GRID_COLS,
      this.gridN * GRID_COLS,
      this.gridN * (this.gridN / GRID_COLS)
    );
    this.texW = 512;
    this.texH = Math.ceil(this.particles / this.texW);

    /* ---- the mode table: one texel per Fourier mode, two rows ---- */
    const n = Math.min(this.field.count, 512);
    const data = new Float32Array(n * 2 * 4);
    for (let i = 0; i < n; i++) {
      const kx = this.field.k[i * 3];
      const ky = this.field.k[i * 3 + 1];
      const kz = this.field.k[i * 3 + 2];
      data[i * 4] = kx;
      data[i * 4 + 1] = ky;
      data[i * 4 + 2] = kz;
      data[i * 4 + 3] = this.field.amp[i];
      const row1 = (n + i) * 4;
      data[row1] = this.field.phase[i];
      data[row1 + 1] = Math.max(1e-9, kx * kx + ky * ky + kz * kz);
    }
    this.modesTex = new DataTexture(data, n, 2, RGBAFormat, FloatType);
    this.modesTex.needsUpdate = true;

    /* ---- targets ---- */
    const t: TargetOptions = { half: !probe.full, count: 1 };
    this.initTarget = createTarget(this.texW, this.texH, { ...t, count: 2 });
    this.simA = createTarget(this.texW, this.texH, { ...t, count: 3 });
    this.simB = createTarget(this.texW, this.texH, { ...t, count: 3 });
    const gw = this.gridInfo.z;
    const gh = this.gridInfo.w;
    this.gridA = createTarget(gw, gh, { half: true, linear: true });
    this.gridB = createTarget(gw, gh, { half: true, linear: true });

    clearTarget(renderer, this.simA);
    clearTarget(renderer, this.simB);
    clearTarget(renderer, this.gridA);
    clearTarget(renderer, this.gridB);

    /* ---- materials ---- */
    this.initMat = new ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: INIT_FRAG,
      glslVersion: '300 es' as any,
      uniforms: {
        uModes: new Uniform(this.modesTex),
        uModeCount: new Uniform(n),
        uTexSize: new Uniform(new Vector2(this.texW, this.texH)),
        uLattice: new Uniform(this.lattice),
        uBox: new Uniform(BOX_MPC),
        uJitter: new Uniform(0.85),
      },
    });

    const meanCell = this.gridN ** 3 / this.particles;
    this.simMat = new ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: SIM_FRAG,
      glslVersion: '300 es' as any,
      uniforms: {
        uLag: new Uniform(null),
        uDisp: new Uniform(null),
        uVel: new Uniform(null),
        uNL: new Uniform(null),
        uGridTex: new Uniform(null),
        uGridInfo: new Uniform(this.gridInfo),
        uGridBox: new Uniform(this.gridBox),
        uGrowth: new Uniform(1),
        uGrowthRate: new Uniform(0),
        uHubble: new Uniform(0),
        uDt: new Uniform(0),
        uForce: new Uniform(0.55),
        uGate: new Uniform(1),
        uViscosity: new Uniform(1.4),
        uDecay: new Uniform(1),
        uMaxOffset: new Uniform(BOX_MPC * 0.16),
        uMeanCell: new Uniform(meanCell),
        uHeatDecay: new Uniform(0.985),
        uHeatGain: new Uniform(2.4),
      },
    });

    this.blurMat = new ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      glslVersion: '300 es' as any,
      uniforms: {
        uSrc: new Uniform(null),
        uGridInfo: new Uniform(this.gridInfo),
        uAxis: new Uniform(new Vector3(1, 0, 0)),
        uStride: new Uniform(1),
      },
    });

    /* ---- splat: one point per particle, drawn into the grid atlas ---- */
    const uv = new Float32Array(this.particles * 3);
    for (let i = 0; i < this.particles; i++) {
      const x = i % this.texW;
      const y = Math.floor(i / this.texW);
      uv[i * 3] = (x + 0.5) / this.texW;
      uv[i * 3 + 1] = (y + 0.5) / this.texH;
      uv[i * 3 + 2] = 0;
    }
    const splatGeo = new BufferGeometry();
    splatGeo.setAttribute('position', new BufferAttribute(uv, 3));
    this.splatMat = new ShaderMaterial({
      vertexShader: SPLAT_VERT,
      fragmentShader: SPLAT_FRAG,
      uniforms: {
        uPos: new Uniform(null),
        uVel: new Uniform(null),
        uNL: new Uniform(null),
        uGridInfo: new Uniform(this.gridInfo),
        uGridBox: new Uniform(this.gridBox),
        uDivScale: new Uniform(3.0),
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.splatPoints = new Points(splatGeo, this.splatMat);
    this.splatPoints.frustumCulled = false;
    this.splatScene.add(this.splatPoints);

    /* ---- the visible particles ---- */
    const webGeo = new BufferGeometry();
    webGeo.setAttribute('position', new BufferAttribute(uv.slice(), 3));
    this.pointsMat = new ShaderMaterial({
      vertexShader: POINTS_VERT,
      fragmentShader: POINTS_FRAG,
      uniforms: {
        uPos: new Uniform(null),
        uVel: new Uniform(null),
        uNL: new Uniform(null),
        uDisp: new Uniform(null),
        uGrowthRate: new Uniform(0),
        uDisplayScale: new Uniform(1),
        uSize: new Uniform(1.0),
        uPixelScale: new Uniform(600),
        uMinSize: new Uniform(1.0),
        uMaxSize: new Uniform(quality.tier === 'ultra' ? 26 : 16),
        uBrightness: new Uniform(1.0),
        uDivScale: new Uniform(3.0),
        uHalfBox: new Uniform(BOX_MPC * 0.5),
        uFadeStart: new Uniform(0.82),
        uFar: new Uniform(BOX_MPC * 2.4),
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
    });
    this.webPoints = new Points(webGeo, this.pointsMat);
    this.webPoints.frustumCulled = false;
    this.webPoints.renderOrder = 10;
    this.root.add(this.webPoints);

    /* ---- volumetric haze + composite ---- */
    this.hazeMat = new ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: HAZE_FRAG,
      uniforms: {
        uGridTex: new Uniform(null),
        uGridInfo: new Uniform(this.gridInfo),
        uGridBox: new Uniform(this.gridBox),
        uInvViewProj: new Uniform(this.invViewProj),
        uInvModel: new Uniform(this.invModel),
        uCamPos: new Uniform(new Vector3()),
        uBoxHalf: new Uniform(new Vector3(BOX_MPC / 2, BOX_MPC / 2, BOX_MPC / 2)),
        uDisplayScale: new Uniform(1),
        uMeanCell: new Uniform(meanCell),
        uGain: new Uniform(1.0),
        uSteps: new Uniform(quality.tier === 'ultra' ? 64 : quality.tier === 'high' ? 48 : 28),
        uDetail: new Uniform(0.55),
        uDetailFreq: new Uniform(0.06),
        uTime: new Uniform(0),
        uFar: new Uniform(BOX_MPC * 2.4),
        uFadeStart: new Uniform(0.8),
      },
    });

    this.compositeMat = new ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        uHaze: new Uniform(null),
        uTexel: new Uniform(new Vector2(1 / 512, 1 / 512)),
        uGain: new Uniform(1.0),
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: NormalBlending,
    });
    this.compositeMesh = new Mesh(new PlaneGeometry(2, 2), this.compositeMat);
    this.compositeMesh.frustumCulled = false;
    // Drawn before the particles, with no depth interaction: it is a backdrop.
    this.compositeMesh.renderOrder = -10;
    this.root.add(this.compositeMesh);

    /* ---- one-off: the Lagrangian lattice and its displacement field ---- */
    this.quad.run(renderer, this.initMat, this.initTarget);

    this.catalog = new NodeCatalog(this.field, 48, BOX_MPC, 240);
    this.built = true;
  }

  private resizeHaze(renderer: WebGLRenderer, quality: QualityProfile): void {
    const size = renderer.getDrawingBufferSize(_v2);
    const scale = quality.tier === 'ultra' ? 0.5 : quality.tier === 'high' ? 0.4 : 0.3;
    const w = Math.max(32, Math.floor(size.x * scale));
    const h = Math.max(32, Math.floor(size.y * scale));
    if (this.hazeTarget && this.hazeTarget.width === w && this.hazeTarget.height === h) return;
    this.hazeTarget?.dispose();
    this.hazeTarget = createTarget(w, h, { half: true });
    if (this.compositeMat) {
      (this.compositeMat.uniforms.uTexel.value as Vector2).set(1 / w, 1 / h);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Frame
     ═══════════════════════════════════════════════════════════════════════ */

  update(dt: number, ctx: SystemContext): void {
    if (!this.built) {
      this.build(ctx.renderer, ctx.quality);
      if (!this.built) return;
    }
    const renderer = ctx.renderer;
    this.elapsed += dt;
    this.resizeHaze(renderer, ctx.quality);

    /* ---- cosmic time ---- */
    // Ease in log space: the interesting range spans two decades of a, and a
    // linear approach would spend all its time in the boring end.
    const la = Math.log(Math.max(1e-3, this.a));
    const lt = Math.log(Math.max(1e-3, this.aTarget));
    this.a = Math.exp(la + (lt - la) * (1 - Math.pow(0.05, dt * Math.max(0.05, this.timeRate))));

    const growth = this.cosmology.growth(this.a);
    const growthRate = this.cosmology.growthRate(this.a);
    const hubble = this.cosmology.hubble(this.a);
    // A fixed dynamical step keeps the nonlinear correction stable no matter
    // what the frame rate is doing.
    const stepGyr = Math.min(0.06, dt * 0.9 * Math.max(0.15, this.timeRate));
    this.simTimeGyr += stepGyr;

    /* ---- 1. splat particles into the density grid ---- */
    const src = this.simA!;
    clearTarget(renderer, this.gridA!);
    this.splatMat!.uniforms.uPos.value = textureOf(src, 0);
    this.splatMat!.uniforms.uVel.value = textureOf(src, 1);
    this.splatMat!.uniforms.uNL.value = textureOf(src, 2);
    this.renderSplat(renderer, this.gridA!);

    /* ---- 2. blur: x,y,z at stride 1, then again at stride 2 ---- */
    let a = this.gridA!;
    let b = this.gridB!;
    for (const stride of [1, 2]) {
      for (const axis of AXES) {
        this.blurMat!.uniforms.uSrc.value = textureOf(a, 0);
        (this.blurMat!.uniforms.uAxis.value as Vector3).copy(axis);
        this.blurMat!.uniforms.uStride.value = stride;
        this.quad.run(renderer, this.blurMat!, b);
        const t = a;
        a = b;
        b = t;
      }
    }
    const density = textureOf(a, 0);

    /* ---- 3. integrate ---- */
    const s = this.simMat!.uniforms;
    s.uLag.value = textureOf(this.initTarget!, 0);
    s.uDisp.value = textureOf(this.initTarget!, 1);
    s.uVel.value = textureOf(this.simA!, 1);
    s.uNL.value = textureOf(this.simA!, 2);
    s.uGridTex.value = density;
    s.uGrowth.value = growth;
    s.uGrowthRate.value = growthRate;
    s.uHubble.value = hubble;
    s.uDt.value = stepGyr;
    // Gravity only switches on once the field has gone nonlinear; before that
    // linear theory is exact and a force term would just add noise.
    s.uGate.value = smooth01(growth, 0.18, 0.45);
    // Rewinding unwinds the nonlinear remainder, so scrubbing back really does
    // return to a smooth early universe rather than leaving fossil clumps.
    s.uDecay.value = this.aTarget < this.a ? 0.90 : 0.999;
    this.quad.run(renderer, this.simMat!, this.simB!);
    const t = this.simA;
    this.simA = this.simB;
    this.simB = t!;

    /* ---- 4. haze ---- */
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    this.invViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
    this.invModel.copy(this.root.matrixWorld).invert();
    const h = this.hazeMat!.uniforms;
    h.uGridTex.value = density;
    (h.uCamPos.value as Vector3).setFromMatrixPosition(cam.matrixWorld);
    h.uTime.value = this.elapsed;
    h.uGain.value = 1.0;
    this.quad.run(renderer, this.hazeMat!, this.hazeTarget!);
    if (this.showGrid) {
      this.compositeMat!.uniforms.uHaze.value = density;
      this.compositeMat!.uniforms.uGain.value = 2.0;
    } else {
      this.compositeMat!.uniforms.uHaze.value = textureOf(this.hazeTarget!, 0);
      this.compositeMat!.uniforms.uGain.value = 1.0;
    }

    /* ---- 5. the visible particles ---- */
    const p = this.pointsMat!.uniforms;
    p.uPos.value = textureOf(this.simA!, 0);
    p.uVel.value = textureOf(this.simA!, 1);
    p.uNL.value = textureOf(this.simA!, 2);
    p.uDisp.value = textureOf(this.initTarget!, 1);
    p.uGrowthRate.value = growthRate;
    const size = renderer.getDrawingBufferSize(_v2);
    // Point size in pixels for a sprite of a fixed world size, from the
    // projection: r_px = r_world · (h/2) / (tan(fov/2) · z).
    p.uPixelScale.value = (size.y * 0.5) / Math.tan(((cam as any).fov * Math.PI) / 360);
    p.uMaxSize.value = ctx.quality.tier === 'ultra' ? 26 : 16;

    this.catalog?.advance(growth, 1);
  }

  /** Draw the splat points into the grid atlas with additive blending. */
  private renderSplat(renderer: WebGLRenderer, target: WebGLRenderTarget): void {
    const prev = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    // The splat shader writes clip-space coordinates itself, so the camera it
    // is handed is irrelevant — but three still needs one.
    renderer.render(this.splatScene, _splatCam);
    renderer.setRenderTarget(prev);
    renderer.autoClear = prevAuto;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     API
     ═══════════════════════════════════════════════════════════════════════ */

  /** Diagnostic: paint the density grid over the frame instead of the haze. */
  showGrid = false;

  setTimeRate(rate: number): void {
    this.timeRate = Math.max(0, rate);
  }

  setEpoch(scaleFactor: number): void {
    this.aTarget = Math.max(0.02, Math.min(4, scaleFactor));
  }

  stats(): CosmicWebStats {
    const sigma = this.field.sigma * this.cosmology.growth(this.a);
    // Press–Schechter: the fraction of mass in regions that have crossed the
    // spherical-collapse threshold. It is the honest answer to "how much of
    // the universe has fallen in yet".
    const collapsed = erfc(DELTA_C / (Math.SQRT2 * Math.max(1e-4, sigma)));
    return {
      redshift: this.cosmology.redshift(this.a),
      scaleFactor: this.a,
      ageYears: this.cosmology.ageGyr(this.a) * 1e9,
      particles: this.particles,
      collapsedFraction: Math.max(0, Math.min(1, collapsed)),
    };
  }

  pickNode(origin: Vector3, direction: Vector3): Vector3 | null {
    if (!this.catalog) return null;
    let best: Vector3 | null = null;
    let bestScore = -Infinity;
    const dir = _v3a.copy(direction).normalize();
    for (const node of this.catalog.nodes) {
      const rel = _v3b.subVectors(node.position, origin);
      const along = rel.dot(dir);
      if (along <= 0) continue;
      const perp = rel.length() * Math.sqrt(Math.max(0, 1 - (along / Math.max(1e-6, rel.length())) ** 2));
      // Favour bright, massive nodes near the aim point, but do not require a
      // pixel-perfect hit — this is a gesture, not a click target.
      const score = node.richness * 40 - perp * 2.0 - along * 0.02;
      if (score > bestScore) {
        bestScore = score;
        best = node.position;
      }
    }
    return best ? best.clone() : null;
  }

  nearestNode(p: Vector3): Vector3 | null {
    if (!this.catalog) return null;
    let best: Vector3 | null = null;
    let bestD = Infinity;
    for (const node of this.catalog.nodes) {
      const d = node.position.distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = node.position;
      }
    }
    return best ? best.clone() : null;
  }

  setQuality(q: QualityProfile): void {
    const wantLattice = latticeFor(q.cosmicWebParticles);
    this.quality = q;
    if (!this.built) return;
    if (wantLattice !== this.lattice && this.renderer) {
      this.build(this.renderer, q);
      return;
    }
    if (this.hazeMat) {
      this.hazeMat.uniforms.uSteps.value = q.tier === 'ultra' ? 64 : q.tier === 'high' ? 48 : 28;
    }
  }

  private teardownGpu(): void {
    for (const t of [this.initTarget, this.simA, this.simB, this.gridA, this.gridB, this.hazeTarget]) {
      t?.dispose();
    }
    this.initTarget = this.simA = this.simB = this.gridA = this.gridB = this.hazeTarget = null;
    for (const m of [
      this.initMat, this.simMat, this.blurMat, this.hazeMat,
      this.splatMat, this.pointsMat, this.compositeMat,
    ]) {
      m?.dispose();
    }
    this.initMat = this.simMat = this.blurMat = this.hazeMat = null;
    this.splatMat = this.pointsMat = this.compositeMat = null;
    this.modesTex?.dispose();
    this.modesTex = null;
    if (this.splatPoints) {
      this.splatScene.remove(this.splatPoints);
      this.splatPoints.geometry.dispose();
      this.splatPoints = null;
    }
    if (this.webPoints) {
      this.root.remove(this.webPoints);
      this.webPoints.geometry.dispose();
      this.webPoints = null;
    }
    if (this.compositeMesh) {
      this.root.remove(this.compositeMesh);
      this.compositeMesh.geometry.dispose();
      this.compositeMesh = null;
    }
    this.built = false;
  }

  dispose(): void {
    this.teardownGpu();
    this.quad.dispose();
  }
}

/* ─────────────────────────── helpers ─────────────────────────── */

const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
const _v2 = new Vector2();
const _v3a = new Vector3();
const _v3b = new Vector3();
// The splat shader writes clip space itself, so this camera only has to exist —
// but it must be a real Camera, because three drives internal state from it.
const _splatCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

function smooth01(x: number, e0: number, e1: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Complementary error function, Abramowitz & Stegun 7.1.26. */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
      t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
      t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? r : 2 - r;
}
