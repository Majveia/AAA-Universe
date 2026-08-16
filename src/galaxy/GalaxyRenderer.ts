/**
 * The galaxy, assembled.
 *
 * `GalaxyModel` knows the physics — the exponential disc, the Sérsic bulge, the
 * logarithmic arms, the flat rotation curve — in both TypeScript and GLSL.
 * `StarField` turns that into millions of HDR points in a handful of draw calls.
 * This file owns the two of them, advances galactic time, and streams the star
 * population in across frames so building a galaxy never costs a dropped frame.
 *
 * The one thing worth knowing about the motion: the arms are a *density wave*,
 * not a structure. Stars orbit on the flat rotation curve and pass through the
 * arms; the pattern turns at its own slower rate. That is why the arms stay
 * sharp instead of winding themselves into a spiral of infinite tightness after
 * a few rotations — which is exactly the problem that told astronomers the
 * density-wave answer had to be right.
 */

import {
  AdditiveBlending,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  RingGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { IGalaxyRenderer, SystemContext } from '../api/Contracts';
import type { GalaxySpec, StarSystemSpec } from '../universe/Types';
import type { QualityProfile } from '../core/Settings';
import { GalaxyModel } from './GalaxyModel';
import { StarField } from './StarField';

/** Stars actually drawn, per tier. The real count is ~10¹¹; we suggest it. */
function budgetFor(q: QualityProfile | null): number {
  if (!q) return 300000;
  switch (q.tier) {
    case 'ultra': return 900000;
    case 'high': return 600000;
    case 'medium': return 320000;
    case 'low': return 150000;
    default: return 70000;
  }
}

export class GalaxyRenderer implements IGalaxyRenderer {
  readonly root = new Group();

  private model: GalaxyModel | null = null;
  private field: StarField | null = null;
  private shared: Record<string, { value: any }> = {};
  private spec: GalaxySpec | null = null;
  private quality: QualityProfile | null = null;

  private galTime = 0;
  private budget = 300000;
  private grown = 0;
  private fade = 0;

  private marker: Mesh | null = null;
  private targetPos: Vector3 | null = null;
  private universe: any = null;

  build(spec: GalaxySpec): void {
    this.teardown();
    this.spec = spec;
    this.model = new GalaxyModel(spec);
    this.shared = this.model.makeUniforms();
    this.budget = budgetFor(this.quality);
    this.field = new StarField(this.model, this.shared, this.budget);
    for (const o of this.field.objects) this.root.add(o);
    this.grown = 0;
    this.fade = 0;
    // Orient the disc so its normal matches the spec — every galaxy hangs at
    // its own angle, which is most of why a field of them looks natural.
    const n = new Vector3(...spec.normal).normalize();
    this.root.up.set(0, 1, 0);
    this.root.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), n);

    this.marker = new Mesh(
      new RingGeometry(1, 1.16, 48),
      new MeshBasicMaterial({
        color: 0x8fe6ff,
        transparent: true,
        opacity: 0.9,
        blending: AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
      })
    );
    this.marker.visible = false;
    this.marker.renderOrder = 50;
    this.root.add(this.marker);
  }

  update(dt: number, ctx: SystemContext): void {
    if (!this.model || !this.field) return;
    if (ctx.services?.universe) this.universe = ctx.services.universe;

    // Galactic time runs fast enough that the pattern visibly turns while you
    // watch, but slow enough that it reads as majesty rather than a spinner.
    this.galTime += dt * 0.0009;
    this.shared.uGalTime.value = this.galTime;
    this.shared.uPattern.value = this.model.patternOmega * this.galTime;

    // Stream the population in over the first couple of seconds.
    if (this.grown < this.budget) {
      const chunk = Math.max(4000, Math.floor(this.budget / 45));
      this.grown = this.field.grow(chunk);
    }
    this.fade = Math.min(1, this.fade + dt * 0.9);

    const cam = ctx.camera;
    cam.updateMatrixWorld();
    // Camera position in the galaxy's own frame — the field needs it for
    // depth sorting the dust and for sizing points.
    _v.setFromMatrixPosition(cam.matrixWorld);
    this.root.updateMatrixWorld();
    _inv.copy(this.root.matrixWorld).invert();
    _v.applyMatrix4(_inv);

    const size = ctx.renderer.getDrawingBufferSize(_sz);
    const pixPerRad = size.y / (2 * Math.tan(((cam as any).fov * Math.PI) / 360));
    // Inside the dust layer the near/far split matters; outside it we can skip
    // the extra pass entirely.
    const dusty = Math.abs(_v.y) < this.model.dustHz * 4 && _v.length() < this.model.radius * 1.4;

    this.field.update(_v, pixPerRad, dusty, this.fade);

    if (this.marker && this.targetPos) {
      this.marker.visible = true;
      this.marker.position.copy(this.targetPos);
      // Constant angular size, so it reads at any zoom.
      const d = this.marker.position.distanceTo(_v);
      this.marker.scale.setScalar(Math.max(1, d * 0.012));
      this.marker.quaternion.copy(cam.quaternion).premultiply(_q.setFromRotationMatrix(_inv));
      const m = this.marker.material as MeshBasicMaterial;
      m.opacity = 0.55 + 0.35 * Math.sin(ctx.time * 3.0);
    } else if (this.marker) {
      this.marker.visible = false;
    }
  }

  /** Diagnostic: how much of the population has streamed in. */
  stats(): Record<string, any> {
    return {
      grown: this.grown,
      budget: this.budget,
      fade: Number(this.fade.toFixed(2)),
      objects: this.field?.objects.length ?? 0,
    };
  }

  setTarget(positionLy: Vector3 | null): void {
    this.targetPos = positionLy ? positionLy.clone() : null;
  }

  systemsNear(positionLy: Vector3, radiusLy: number): StarSystemSpec[] {
    if (!this.universe) return [];
    return this.universe.systemsNear(positionLy.x, positionLy.y, positionLy.z, radiusLy);
  }

  setQuality(q: QualityProfile): void {
    this.quality = q;
    const want = budgetFor(q);
    if (this.field && Math.abs(want - this.budget) / Math.max(1, this.budget) > 0.25 && this.spec) {
      // A tier change is rare; a full rebuild is cheaper than a resizable pool.
      const spec = this.spec;
      this.build(spec);
    } else if (this.field) {
      this.field.setDrawFraction(Math.min(1, want / Math.max(1, this.budget)));
    }
  }

  private teardown(): void {
    if (this.field) {
      for (const o of this.field.objects) this.root.remove(o);
      this.field.dispose();
      this.field = null;
    }
    if (this.marker) {
      this.root.remove(this.marker);
      this.marker.geometry.dispose();
      (this.marker.material as MeshBasicMaterial).dispose();
      this.marker = null;
    }
    this.model = null;
  }

  dispose(): void {
    this.teardown();
  }
}

const _v = new Vector3();
const _sz = new Vector2();
const _inv = new Matrix4();
const _q = new Quaternion();
