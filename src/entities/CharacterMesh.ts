/**
 * The explorer: a procedurally built suited figure and the skeletal animation
 * that sells it.
 *
 * There are no model files in this project, so the figure is assembled from
 * lathes, tapered cylinders and clipped spheres — about 40 primitives arranged
 * for silhouette rather than detail. That is the right trade: at 4 m in third
 * person you read the *shape* (helmet dome, pack, pauldrons, boot flare) and
 * the *motion*, never the polygon count. Simple geometry animated well reads as
 * AAA; dense geometry animated badly does not.
 *
 * The animation is a weighted blend of five hand-authored poses — locomotion,
 * air, land, swim, jetpack — with the weights (not the joint angles) damped, so
 * the walk cycle itself stays crisp while transitions between states are smooth.
 * On top of that:
 *
 *   • Two-bone leg IK against the terrain, so feet plant on slopes and stairs
 *     instead of skating through them. This is the single highest-value piece
 *     of animation code in a game with procedural ground.
 *   • Arms counter-swing the legs, and the elbow bend scales with cadence.
 *   • The torso leans into acceleration and banks into turns — the thing that
 *     makes a character feel like it has mass.
 *   • Idle breathing, because a perfectly still character reads as a paused
 *     game.
 */

import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  SpotLight,
  Vector2,
  Vector3,
} from 'three';
import type { Rng } from '../core/Rand';
import { disposeTree, makeEmissive, makeFlameMaterial, makeSuitMaterial, makeVisorMaterial, uniformsOf } from './Materials';
import { Damp1, TAU, clamp, lerp, saturate, smoothstep } from './Motion';

/** Per-frame animation drive, all in world/planet-local space. */
export interface CharacterAnimState {
  /** Tangential ground speed, m/s. */
  speed: number;
  /** Unit tangent the body is facing. */
  facing: Vector3;
  up: Vector3;
  grounded: boolean;
  /** 0..1 blends. */
  swimming: number;
  jetpack: number;
  crouch: number;
  sprint: number;
  /** Signed, m/s along up. */
  verticalSpeed: number;
  /** Acceleration along `facing`, m/s². Drives the forward torso lean. */
  accelForward: number;
  /** Signed yaw rate about up, rad/s. Drives the bank into turns. */
  turnRate: number;
  /** 0..1, decays after a hard landing. */
  landing: number;
}

const SUIT_PALETTES: { base: [number, number, number]; accent: [number, number, number]; visorTint: number }[] = [
  // Chalk-white EVA with hazard orange — the Apollo/NMS read.
  { base: [0.74, 0.75, 0.77], accent: [0.92, 0.38, 0.08], visorTint: 0.9 },
  // Graphite and cold teal — Starfield's Constellation register.
  { base: [0.21, 0.23, 0.26], accent: [0.16, 0.68, 0.66], visorTint: 1.1 },
  // Weathered sand and oxblood — the long-haul prospector.
  { base: [0.60, 0.53, 0.41], accent: [0.48, 0.13, 0.12], visorTint: 0.8 },
  // Deep navy with signal yellow.
  { base: [0.14, 0.17, 0.28], accent: [0.95, 0.76, 0.12], visorTint: 1.0 },
];

const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _qTmp = new Quaternion();
const _qPose = new Quaternion();
/** Scratch for the knee bend computed by the two-bone IK. */
const kneeQ = new Quaternion();
const DOWN = new Vector3(0, -1, 0);
const _xAxis = new Vector3(1, 0, 0);
const _zAxis = new Vector3(0, 0, 1);

function meshOf(geo: any, mat: any, parent: Object3D, x = 0, y = 0, z = 0): Mesh {
  const m = new Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/** A limb segment: tapered cylinder from the pivot down its local -Y. */
function limb(len: number, rTop: number, rBot: number, mat: any, parent: Object3D): Mesh {
  const g = new CylinderGeometry(rTop, rBot, len, 10, 1, false);
  g.translate(0, -len * 0.5, 0);
  return meshOf(g, mat, parent);
}

export class CharacterMesh {
  readonly root = new Group();

  /** Eye height in local metres — the Player reads this for the FP camera. */
  readonly eyeLocalY: number;
  readonly height: number;

  /** Ground clearance under a local XZ offset, in local Y. Set by the owner. */
  groundProbe: ((lx: number, lz: number) => number) | null = null;

  private body = new Object3D();
  private hips = new Object3D();
  private spine = new Object3D();
  private neck = new Object3D();
  private head = new Object3D();
  private shoulder: Object3D[] = [];
  private elbow: Object3D[] = [];
  private thigh: Object3D[] = [];
  private knee: Object3D[] = [];
  private ankle: Object3D[] = [];
  private chestMesh!: Mesh;
  private lamp: SpotLight | null = null;
  private lampLens!: Mesh;
  private jetFlames: Mesh[] = [];
  private statusLights: Mesh[] = [];

  private visorMat = makeVisorMaterial();
  private suitMat: MeshStandardMaterial;
  private trimMat: MeshStandardMaterial;
  private darkMat: MeshStandardMaterial;
  private emissiveMat: MeshStandardMaterial;

  /* skeleton dimensions, metres */
  private hipY: number;
  private thighLen: number;
  private shinLen: number;
  private shoulderY: number;
  private shoulderX: number;
  private hipX: number;

  /* animation state */
  private phase = 0;
  private t = 0;
  private wLoco = new Damp1(1);
  private wAir = new Damp1(0);
  private wSwim = new Damp1(0);
  private wJet = new Damp1(0);
  private wLand = new Damp1(0);
  private leanF = new Damp1(0);
  private leanR = new Damp1(0);
  private crouchD = new Damp1(0);
  private strokePhase = 0;
  /** Smoothed IK foot heights, so a noisy height field doesn't jitter feet. */
  private footY = [new Damp1(0), new Damp1(0)];
  private viewBlend = 1;

  constructor(rng: Rng, height = 1.82, quality: { shadows?: boolean; lamp?: boolean } = {}) {
    this.height = height;
    const s = height / 1.82;
    this.hipY = 0.94 * s;
    this.thighLen = 0.45 * s;
    this.shinLen = 0.44 * s;
    this.shoulderY = 0.46 * s;
    this.shoulderX = 0.19 * s;
    this.hipX = 0.105 * s;
    this.eyeLocalY = 1.665 * s;

    const pal = rng.pick(SUIT_PALETTES);
    const base = new Color(pal.base[0], pal.base[1], pal.base[2]);
    const accent = new Color(pal.accent[0], pal.accent[1], pal.accent[2]);

    this.suitMat = makeSuitMaterial(rng.fork('suit'), { base, accent, wear: rng.range(0.2, 0.6), panels: 11 });
    this.trimMat = makeSuitMaterial(rng.fork('trim'), {
      base: accent.clone().multiplyScalar(0.8),
      accent,
      wear: rng.range(0.3, 0.7),
      panels: 16,
    });
    this.darkMat = new MeshStandardMaterial({ color: new Color(0.055, 0.06, 0.07), roughness: 0.52, metalness: 0.55 });
    this.emissiveMat = makeEmissive(new Color(0.35, 0.85, 1.0), 6.0);
    uniformsOf(this.visorMat).uSkyGain.value = pal.visorTint;

    this.build(rng, s, quality);
  }

  /* ═════════════════════════════════════════════════════════════════════
     Construction
     ═════════════════════════════════════════════════════════════════════ */

  private build(rng: Rng, s: number, quality: { shadows?: boolean; lamp?: boolean }): void {
    this.root.add(this.body);
    this.body.add(this.hips);
    this.hips.position.y = this.hipY;
    this.hips.add(this.spine);

    const suit = this.suitMat;
    const trim = this.trimMat;
    const dark = this.darkMat;

    /* ── pelvis ──────────────────────────────────────────────────────── */
    const pelvisGeo = new SphereGeometry(0.155 * s, 14, 10);
    pelvisGeo.scale(1.15, 0.85, 0.95);
    meshOf(pelvisGeo, suit, this.hips, 0, -0.02 * s, 0);
    // Utility belt: the horizontal line that separates legs from torso at range.
    const beltGeo = new CylinderGeometry(0.175 * s, 0.168 * s, 0.075 * s, 18, 1, true);
    meshOf(beltGeo, dark, this.hips, 0, 0.01 * s, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.4;
      const pouch = new BoxGeometry(0.075 * s, 0.085 * s, 0.05 * s);
      const m = meshOf(pouch, trim, this.hips, Math.sin(a) * 0.17 * s, 0.005 * s, Math.cos(a) * 0.15 * s);
      m.rotation.y = a;
    }

    /* ── torso: a lathe so the chest actually has a profile ──────────── */
    // Waist → chest → shoulder yoke. The pinch at the waist is what stops the
    // figure reading as a barrel.
    const prof: Vector2[] = [];
    const seg = [
      [0.150, 0.00],
      [0.142, 0.08],
      [0.152, 0.17],
      [0.176, 0.28],
      [0.192, 0.38],
      [0.188, 0.45],
      [0.150, 0.50],
      [0.075, 0.525],
    ];
    for (const [r, y] of seg) prof.push(new Vector2(r * s, y * s));
    const chestGeo = new LatheGeometry(prof, 20);
    chestGeo.scale(1.0, 1.0, 0.78); // ovoid cross-section, not a tube
    this.chestMesh = meshOf(chestGeo, suit, this.spine, 0, 0, 0);

    // Chest plate — a hard, flat highlight surface against the soft suit.
    const plate = new SphereGeometry(0.185 * s, 16, 12, 0, Math.PI, 0.55, 1.0);
    plate.scale(1.0, 1.0, 0.72);
    const plateMesh = meshOf(plate, trim, this.spine, 0, 0.31 * s, 0.01 * s);
    plateMesh.rotation.y = -Math.PI * 0.5;

    /* ── backpack + jet nozzles ──────────────────────────────────────── */
    const packGeo = new BoxGeometry(0.30 * s, 0.40 * s, 0.17 * s);
    const pack = meshOf(packGeo, trim, this.spine, 0, 0.30 * s, -0.19 * s);
    pack.rotation.x = -0.06;
    for (const sx of [-1, 1]) {
      const tank = new CylinderGeometry(0.052 * s, 0.052 * s, 0.30 * s, 12);
      meshOf(tank, dark, this.spine, sx * 0.10 * s, 0.31 * s, -0.30 * s);
      const cap = new SphereGeometry(0.052 * s, 10, 8);
      meshOf(cap, dark, this.spine, sx * 0.10 * s, 0.46 * s, -0.30 * s);
      // Jetpack nozzle + its flame, hidden until the pack fires.
      const noz = new ConeGeometry(0.052 * s, 0.09 * s, 12, 1, true);
      const nm = meshOf(noz, dark, this.spine, sx * 0.10 * s, 0.11 * s, -0.28 * s);
      nm.rotation.x = -0.28;
      const flameGeo = new ConeGeometry(0.05 * s, 1.0, 10, 1, true);
      // The flame shader runs the plume along -Z, so stand the cone up first.
      flameGeo.rotateX(Math.PI * 0.5);
      flameGeo.translate(0, 0, -0.5);
      const fm = makeFlameMaterial(new Color(0.55, 0.78, 1.0), new Color(0.12, 0.22, 0.75));
      fm.uniforms.uJitter.value = rng.range(0, 10);
      const flame = new Mesh(flameGeo, fm);
      flame.position.set(sx * 0.10 * s, 0.06 * s, -0.29 * s);
      flame.rotation.x = Math.PI * 0.5 - 0.28;
      flame.scale.setScalar(0.55 * s);
      flame.visible = false;
      flame.frustumCulled = false;
      this.spine.add(flame);
      this.jetFlames.push(flame);
    }

    // Status lights on the chest — tiny, but they make the figure feel powered.
    for (let i = 0; i < 3; i++) {
      const g = new SphereGeometry(0.011 * s, 6, 5);
      const m = makeEmissive(new Color(i === 0 ? 0.2 : 0.1, i === 1 ? 1.0 : 0.5, i === 2 ? 1.0 : 0.35), 5);
      const mm = meshOf(g, m, this.spine, (i - 1) * 0.036 * s, 0.235 * s, 0.145 * s);
      this.statusLights.push(mm);
    }

    /* ── neck + helmet ───────────────────────────────────────────────── */
    this.spine.add(this.neck);
    this.neck.position.y = this.shoulderY + 0.055 * s;
    const neckGeo = new CylinderGeometry(0.058 * s, 0.072 * s, 0.09 * s, 12);
    meshOf(neckGeo, dark, this.neck, 0, 0.02 * s, 0);

    this.neck.add(this.head);
    this.head.position.y = 0.075 * s;

    const helmGeo = new SphereGeometry(0.135 * s, 22, 16);
    helmGeo.scale(1.0, 1.06, 1.1);
    meshOf(helmGeo, suit, this.head, 0, 0.055 * s, -0.008 * s);
    // Visor: a clipped sphere slightly proud of the helmet, wrapping the front.
    const visorGeo = new SphereGeometry(0.138 * s, 24, 16, Math.PI * 0.44, Math.PI * 1.12, Math.PI * 0.22, Math.PI * 0.48);
    visorGeo.scale(1.0, 1.06, 1.12);
    const visor = meshOf(visorGeo, this.visorMat, this.head, 0, 0.055 * s, -0.008 * s);
    visor.castShadow = false;
    // Brow ridge — reads the head's facing direction from far away.
    const brow = new SphereGeometry(0.146 * s, 18, 10, Math.PI * 0.42, Math.PI * 1.16, Math.PI * 0.16, Math.PI * 0.10);
    brow.scale(1.0, 1.06, 1.12);
    meshOf(brow, trim, this.head, 0, 0.055 * s, -0.008 * s);

    /* ── shoulder lamp ───────────────────────────────────────────────── */
    const housing = new CylinderGeometry(0.036 * s, 0.042 * s, 0.075 * s, 10);
    housing.rotateX(Math.PI * 0.5);
    const house = meshOf(housing, dark, this.spine, 0.175 * s, 0.42 * s, 0.02 * s);
    house.rotation.y = -0.12;
    const lensGeo = new CylinderGeometry(0.030 * s, 0.030 * s, 0.006 * s, 12);
    lensGeo.rotateX(Math.PI * 0.5);
    this.lampLens = meshOf(lensGeo, makeEmissive(new Color(1.0, 0.94, 0.82), 9), this.spine, 0.175 * s, 0.42 * s, 0.06 * s);
    if (quality.lamp !== false) {
      // One spot light. Gated by the caller because per-entity lights are the
      // easiest way to blow a frame budget.
      this.lamp = new SpotLight(0xfff0d8, 0, 42, 0.42, 0.55, 1.3);
      this.lamp.position.set(0.175 * s, 0.42 * s, 0.06 * s);
      this.lamp.target.position.set(0.175 * s, 0.30 * s, 6);
      this.lamp.castShadow = false; // a shadow-casting spot per character is not affordable
      this.spine.add(this.lamp);
      this.spine.add(this.lamp.target);
    }

    /* ── arms ────────────────────────────────────────────────────────── */
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? -1 : 1;
      const sh = new Object3D();
      sh.position.set(sx * this.shoulderX, this.shoulderY, 0);
      this.spine.add(sh);
      this.shoulder.push(sh);

      // Pauldron: a clipped sphere cap. The strongest silhouette cue on the
      // upper body, and it hides the shoulder joint seam.
      const pauld = new SphereGeometry(0.088 * s, 14, 10, 0, TAU, 0, Math.PI * 0.62);
      pauld.scale(1.15, 0.95, 1.05);
      const pm = meshOf(pauld, trim, sh, sx * 0.012 * s, 0.012 * s, 0);
      pm.rotation.z = sx * -0.18;

      limb(0.29 * s, 0.062 * s, 0.050 * s, suit, sh);

      const el = new Object3D();
      el.position.y = -0.29 * s;
      sh.add(el);
      this.elbow.push(el);
      meshOf(new SphereGeometry(0.052 * s, 10, 8), dark, el);
      limb(0.26 * s, 0.050 * s, 0.043 * s, suit, el);
      // Forearm cuff / wrist computer on the left arm only — asymmetry reads
      // as "equipment" rather than "mirrored model".
      if (i === 0) {
        const cuff = new BoxGeometry(0.075 * s, 0.055 * s, 0.045 * s);
        meshOf(cuff, dark, el, sx * 0.03 * s, -0.20 * s, 0.03 * s);
        const scr = new BoxGeometry(0.055 * s, 0.038 * s, 0.004 * s);
        meshOf(scr, this.emissiveMat, el, sx * 0.03 * s, -0.20 * s, 0.054 * s);
      }
      const glove = new SphereGeometry(0.055 * s, 10, 8);
      glove.scale(0.85, 1.15, 1.0);
      meshOf(glove, dark, el, 0, -0.30 * s, 0.008 * s);
    }

    /* ── legs ────────────────────────────────────────────────────────── */
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? -1 : 1;
      const th = new Object3D();
      th.position.set(sx * this.hipX, -0.02 * s, 0);
      this.hips.add(th);
      this.thigh.push(th);
      meshOf(new SphereGeometry(0.085 * s, 12, 9), suit, th);
      limb(this.thighLen, 0.093 * s, 0.075 * s, suit, th);

      const kn = new Object3D();
      kn.position.y = -this.thighLen;
      th.add(kn);
      this.knee.push(kn);
      const kneePad = new SphereGeometry(0.072 * s, 12, 9);
      kneePad.scale(1.0, 0.9, 1.15);
      meshOf(kneePad, trim, kn, 0, 0, 0.012 * s);
      limb(this.shinLen, 0.070 * s, 0.055 * s, suit, kn);

      const an = new Object3D();
      an.position.y = -this.shinLen;
      kn.add(an);
      this.ankle.push(an);
      // Boot: flared sole + toe cap. The flare is what makes the figure look
      // planted rather than balanced on pins.
      const bootGeo = new BoxGeometry(0.105 * s, 0.075 * s, 0.20 * s);
      meshOf(bootGeo, dark, an, 0, -0.028 * s, 0.028 * s);
      const soleGeo = new BoxGeometry(0.118 * s, 0.026 * s, 0.235 * s);
      meshOf(soleGeo, trim, an, 0, -0.056 * s, 0.032 * s);
      const toe = new SphereGeometry(0.055 * s, 10, 8);
      toe.scale(0.95, 0.72, 1.0);
      meshOf(toe, dark, an, 0, -0.030 * s, 0.115 * s);
    }

    this.root.traverse((o) => {
      o.frustumCulled = false; // one small skinned-ish figure; culling it costs more than it saves
    });
  }

  /* ═════════════════════════════════════════════════════════════════════
     Presentation
     ═════════════════════════════════════════════════════════════════════ */

  /**
   * 0 = first person, 1 = third. In first person the head and pack are hidden
   * so the camera is not inside the helmet, but the body stays so you can look
   * down and see your own boots, and so the figure still casts a real shadow.
   */
  setViewBlend(b: number): void {
    this.viewBlend = b;
    const showHead = b > 0.42;
    this.head.visible = showHead;
    this.neck.visible = showHead;
    this.chestMesh.visible = b > 0.18;
  }

  setLamp(on: boolean, intensity = 30): void {
    if (this.lamp) this.lamp.intensity = on ? intensity : 0;
    (this.lampLens.material as MeshStandardMaterial).emissiveIntensity = on ? 9 : 0.25;
  }

  /** Sky colours for the visor reflection; the realm feeds these through. */
  setSky(zenith: Color, horizon: Color, sunDir: Vector3): void {
    const u = uniformsOf(this.visorMat);
    (u.uSkyUp.value as Color).copy(zenith);
    (u.uSkyDown.value as Color).copy(horizon);
    (u.uSun.value as Vector3).copy(sunDir);
  }

  /* ═════════════════════════════════════════════════════════════════════
     Animation
     ═════════════════════════════════════════════════════════════════════ */

  update(dt: number, a: CharacterAnimState): void {
    this.t += dt;

    /* ── state weights ───────────────────────────────────────────────── */
    const airborne = !a.grounded && a.swimming < 0.5 && a.jetpack < 0.5;
    this.wJet.step(a.jetpack, 0.14, dt);
    this.wSwim.step(a.swimming, 0.22, dt);
    this.wAir.step(airborne ? 1 : 0, 0.11, dt);
    this.wLand.step(a.landing, 0.06, dt);
    this.wLoco.step(a.grounded && a.swimming < 0.5 ? 1 : 0, 0.13, dt);
    this.crouchD.step(a.crouch, 0.13, dt);

    const wJet = this.wJet.value;
    const wSwim = this.wSwim.value;
    const wAir = this.wAir.value * (1 - wJet) * (1 - wSwim);
    const wLand = this.wLand.value;
    const wGround = this.wLoco.value * (1 - wSwim) * (1 - wJet);
    const crouch = this.crouchD.value;

    /* ── cadence ─────────────────────────────────────────────────────── */
    // Stride grows with speed so a run is long strides, not a fast walk. This
    // must match CameraRig's stride formula or the head bob desyncs from the
    // foot plants and the whole thing reads as broken.
    const stride = clamp(0.78 + a.speed * 0.085, 0.78, 1.95);
    const cadence = wGround > 0.05 ? a.speed / stride : 0;
    this.phase = (this.phase + cadence * Math.PI * dt) % TAU;
    this.strokePhase = (this.strokePhase + (1.2 + a.speed * 0.35) * dt) % TAU;

    const moving = saturate(a.speed / 1.2);
    const run = saturate((a.speed - 3.0) / 5.0);
    const strideAmp = lerp(0.16, 0.42, run) * (1 - crouch * 0.45) * moving;
    const liftAmp = lerp(0.055, 0.20, run) * moving;

    /* ── torso lean ──────────────────────────────────────────────────── */
    // Lean into acceleration (and against deceleration) and bank into turns —
    // the cheapest possible way to give a character apparent mass.
    this.leanF.step(clamp(a.accelForward * 0.016 + a.speed * 0.012, -0.22, 0.30), 0.18, dt);
    this.leanR.step(clamp(-a.turnRate * 0.10 * saturate(a.speed / 4), -0.28, 0.28), 0.20, dt);

    /* ── whole-body pose ─────────────────────────────────────────────── */
    // Swimming pitches the entire figure onto its front; the jetpack tips it
    // forward as thrust vectors it along; landing folds it down.
    const bodyPitch = wSwim * 1.32 + wJet * 0.30 + wLand * 0.10 + wGround * this.leanF.value;
    const bodyRoll = this.leanR.value * (1 - wSwim) + wSwim * Math.sin(this.strokePhase) * 0.22;
    this.body.rotation.set(bodyPitch, 0, bodyRoll);
    // Lift the origin when swimming so the figure floats about its middle
    // rather than pivoting through the seabed.
    this.body.position.y = wSwim * 0.62 * (this.height / 1.82);

    /* ── pelvis ──────────────────────────────────────────────────────── */
    const bob = -0.030 * (0.5 - 0.5 * Math.cos(this.phase * 2)) * moving * wGround;
    const squat = -crouch * 0.30 - wLand * 0.22 * (this.height / 1.82);
    this.hips.position.y = this.hipY + (bob + squat) * (this.height / 1.82);
    this.hips.rotation.set(
      crouch * 0.22 + wLand * 0.18,
      Math.sin(this.phase) * 0.10 * moving * wGround,
      Math.sin(this.phase) * 0.055 * moving * wGround
    );

    /* ── spine + head ────────────────────────────────────────────────── */
    const breathe = Math.sin(this.t * 1.15) * (1 - moving) * 0.5 + 0.5;
    this.spine.rotation.set(
      crouch * 0.24 + wLand * 0.30 + wGround * this.leanF.value * 0.6 - wSwim * 0.22 + wJet * 0.10,
      -Math.sin(this.phase) * 0.075 * moving * wGround,
      -this.leanR.value * 0.4
    );
    this.chestMesh.scale.set(1 + breathe * 0.014, 1 + breathe * 0.008, 1 + breathe * 0.018);
    // The head counter-rotates so it stays level-ish while the torso works —
    // real bodies stabilise the head, and its absence looks instantly wrong.
    this.neck.rotation.set(
      -this.spine.rotation.x * 0.55 - bodyPitch * 0.45 + Math.sin(this.phase * 2) * 0.02 * moving * wGround,
      -this.spine.rotation.y * 0.6,
      -this.spine.rotation.z * 0.5
    );

    /* ── arms ────────────────────────────────────────────────────────── */
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? -1 : 1;
      const legPhase = this.phase + (i === 0 ? 0 : Math.PI);
      // Counter-swing: the left arm follows the right leg.
      const swing = -Math.sin(legPhase) * lerp(0.35, 0.95, run) * moving;

      const locoP = swing;
      const locoZ = sx * (0.10 + run * 0.14 + crouch * 0.10);
      const locoElbow = -(0.28 + run * 0.55 + Math.max(0, Math.sin(legPhase)) * 0.35 * run);

      const airP = a.verticalSpeed > 0 ? -0.55 : -1.05;
      const airZ = sx * (0.42 + saturate(-a.verticalSpeed / 22) * 0.35);
      const airElbow = -0.75;

      const landP = -1.25;
      const landZ = sx * 0.30;
      const landElbow = -1.15;

      // Front crawl: the shoulder rotates through a full circle.
      const sp = this.strokePhase + (i === 0 ? 0 : Math.PI);
      const swimP = Math.sin(sp) * 1.9 - 0.9;
      const swimZ = sx * (0.30 + Math.cos(sp) * 0.22);
      const swimElbow = -(0.55 + 0.45 * Math.max(0, -Math.cos(sp)));

      // Jetpack: arms swept back and out, like a wingsuit brace.
      const jetP = 0.85;
      const jetZ = sx * 0.62;
      const jetElbow = -0.35;

      const px = locoP * wGround + airP * wAir + landP * wLand + swimP * wSwim + jetP * wJet;
      const pz = locoZ * wGround + airZ * wAir + landZ * wLand + swimZ * wSwim + jetZ * wJet;
      const pe = locoElbow * wGround + airElbow * wAir + landElbow * wLand + swimElbow * wSwim + jetElbow * wJet;

      // Idle: a slow, tiny sway so the arms are never dead.
      const idleSway = (1 - moving) * wGround * Math.sin(this.t * 0.8 + i * 2.1) * 0.03;

      this.shoulder[i].rotation.set(px + idleSway, 0, pz + idleSway * 0.5);
      this.elbow[i].rotation.set(pe, 0, 0);
    }

    /* ── legs: pose, then IK on top when we are on the ground ────────── */
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? -1 : 1;
      const p = this.phase + (i === 0 ? 0 : Math.PI);

      /* non-grounded pose (Euler, no IK) */
      const airThigh = a.verticalSpeed > 0 ? 0.62 : 0.10;
      const airKnee = a.verticalSpeed > 0 ? -1.15 : -0.42;
      const swimThigh = -0.18 + Math.sin(this.strokePhase * 2 + i * Math.PI) * 0.42;
      const swimKnee = -0.30 - Math.max(0, Math.sin(this.strokePhase * 2 + i * Math.PI)) * 0.55;
      const jetThigh = -0.32;
      const jetKnee = -0.55;
      const wNon = wAir + wSwim + wJet + 1e-6;
      const poseThigh = (airThigh * wAir + swimThigh * wSwim + jetThigh * wJet) / wNon;
      const poseKnee = (airKnee * wAir + swimKnee * wSwim + jetKnee * wJet) / wNon;
      const poseSpread = (sx * 0.16 * wAir + sx * 0.10 * wSwim + sx * 0.22 * wJet) / wNon;

      if (wGround <= 0.004) {
        // Fully airborne / swimming / jetting: pure Euler pose, no IK.
        _q.setFromAxisAngle(_xAxis, poseThigh).multiply(_qTmp.setFromAxisAngle(_zAxis, poseSpread));
        this.thigh[i].quaternion.copy(_q);
        this.knee[i].quaternion.setFromAxisAngle(_xAxis, poseKnee);
        this.ankle[i].rotation.set(wSwim * 0.55 + wJet * 0.35, 0, 0);
        this.footY[i].set(0);
      } else {
        /* ---- gait: foot target as an ellipse in the sagittal plane ---- */
        // Stance (0..π): planted, sliding back. Swing (π..2π): lifted, returning.
        let fz: number;
        let fy: number;
        const c = Math.cos(p);
        if (p < Math.PI) {
          const t = p / Math.PI;
          fz = lerp(strideAmp, -strideAmp, t);
          fy = 0;
        } else {
          const t = (p - Math.PI) / Math.PI;
          const e = t * t * (3 - 2 * t);
          fz = lerp(-strideAmp, strideAmp, e);
          fy = Math.sin(Math.PI * t) * liftAmp;
        }
        void c;

        const hipLocalX = sx * this.hipX;
        // Ask the terrain how high the ground is under this foot, then plant.
        let ground = 0;
        if (this.groundProbe) ground = this.groundProbe(hipLocalX, fz);
        // Smoothing is asymmetric: rise to meet a step immediately, sink slowly.
        const fd = this.footY[i];
        const targetY = Math.max(ground, ground + fy);
        fd.step(targetY, targetY > fd.value ? 0.02 : 0.09, dt);
        const footTargetY = fd.value + 0.055 * (this.height / 1.82);

        /* ---- two-bone IK ---- */
        // Everything in hip space: the hip pivot is the origin, the foot target
        // is (0, footTargetY - hipWorldY, fz).
        const hipY = this.hips.position.y - 0.02 * (this.height / 1.82);
        _v.set(0, footTargetY - hipY, fz);
        const L1 = this.thighLen;
        const L2 = this.shinLen;
        let d = _v.length();
        const dMin = Math.abs(L1 - L2) + 1e-3;
        const dMax = L1 + L2 - 1e-3;
        if (d < dMin) {
          _v.setLength(dMin);
          d = dMin;
        } else if (d > dMax) {
          _v.setLength(dMax);
          d = dMax;
        }
        // Law of cosines: hip offset from the hip→foot line, and knee bend.
        const cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
        const cosB = clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1);
        const A = Math.acos(cosA);
        const B = Math.acos(cosB);

        // Aim the thigh down the hip→foot line, then swing it forward by A so
        // the knee leads. Rotating +X about the limb's local axis moves the tip
        // toward -Z, which is forward.
        _v2.copy(_v).normalize();
        _q2.setFromUnitVectors(DOWN, _v2);
        _q.copy(_q2).multiply(_qTmp.setFromAxisAngle(_xAxis, A));
        // Shin bends backward from the thigh by (π − B).
        kneeQ.setFromAxisAngle(_xAxis, -(Math.PI - B));

        // Blend IK against the airborne pose by the ground weight.
        this.thigh[i].quaternion.copy(_q);
        this.knee[i].quaternion.copy(kneeQ);
        if (wGround < 0.999) {
          _qPose.setFromAxisAngle(_xAxis, poseThigh);
          _qTmp.setFromAxisAngle(_zAxis, poseSpread);
          _qPose.multiply(_qTmp);
          this.thigh[i].quaternion.slerp(_qPose, 1 - wGround);
          _qPose.setFromAxisAngle(_xAxis, poseKnee);
          this.knee[i].quaternion.slerp(_qPose, 1 - wGround);
        }

        // Ankle keeps the sole parallel to the ground it is standing on.
        const thighAng = 2 * Math.asin(clamp(_q.x, -1, 1)) * Math.sign(_q.w || 1);
        this.ankle[i].rotation.set(clamp(-(thighAng - (Math.PI - B)) * 0.85, -0.7, 0.7) * wGround, 0, 0);
      }
    }

    /* ── jetpack flames ──────────────────────────────────────────────── */
    const jetOn = a.jetpack > 0.02;
    for (const f of this.jetFlames) {
      f.visible = jetOn;
      if (!jetOn) continue;
      const u = (f.material as any).uniforms;
      u.uTime.value = this.t;
      u.uThrottle.value = a.jetpack;
    }

    /* ── status lights breathe with exertion ─────────────────────────── */
    const pulse = 0.5 + 0.5 * Math.sin(this.t * (2.2 + a.sprint * 3.5));
    for (let i = 0; i < this.statusLights.length; i++) {
      const m = this.statusLights[i].material as MeshStandardMaterial;
      m.emissiveIntensity = 3 + pulse * (i === 1 ? 5 : 1.5);
    }
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    if (this.lamp) {
      this.lamp.dispose();
      this.lamp.target.parent?.remove(this.lamp.target);
    }
    disposeTree(this.root);
    this.visorMat.dispose();
    this.suitMat.dispose();
    this.trimMat.dispose();
    this.darkMat.dispose();
    this.emissiveMat.dispose();
  }
}

