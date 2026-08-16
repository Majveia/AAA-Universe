/**
 * The small amount of scaffolding a GPGPU pass needs in three.js: a screen
 * filling quad you can point at a render target, and a double buffer you can
 * ping-pong.
 *
 * Everything here is owned and disposed by whoever constructs it — there are no
 * module-level singletons, because a realm that is torn down has to actually
 * give the memory back.
 */

import {
  ClampToEdgeWrapping,
  FloatType,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Texture,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';

/** Renders one full-screen fragment program into a render target. */
export class QuadRunner {
  private geometry = new PlaneGeometry(2, 2);
  private mesh: Mesh;
  private scene = new Scene();
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    this.mesh = new Mesh(this.geometry);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  run(renderer: WebGLRenderer, material: ShaderMaterial, target: WebGLRenderTarget | null): void {
    this.mesh.material = material;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
  }
}

export interface TargetOptions {
  /** Number of colour attachments — >1 gives an MRT target. */
  count?: number;
  /** True for a bilinearly filtered target (the density grid wants this). */
  linear?: boolean;
  half?: boolean;
}

export function createTarget(w: number, h: number, opts: TargetOptions = {}): WebGLRenderTarget {
  const filter = opts.linear ? LinearFilter : NearestFilter;
  return new WebGLRenderTarget(w, h, {
    count: opts.count ?? 1,
    type: opts.half ? HalfFloatType : FloatType,
    format: RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

/** Zero a target's contents — the simulation has to start from a known state. */
export function clearTarget(renderer: WebGLRenderer, target: WebGLRenderTarget): void {
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.clearColor();
  renderer.setRenderTarget(prev);
}

export function textureOf(target: WebGLRenderTarget, index: number): Texture {
  return target.textures[index] ?? target.texture;
}

/**
 * Which float formats this context can actually render into. WebGL2 exposes
 * `EXT_color_buffer_float` on essentially everything that ships WebGL2 at all,
 * but Safari has historically been late with it and a black opening shot is a
 * worse failure than a slightly quantised one, so half-float is a real fallback.
 */
export function probeFloatTargets(renderer: WebGLRenderer): { full: boolean; half: boolean } {
  const gl = renderer.getContext();
  const has = (name: string) => {
    try {
      return !!gl.getExtension(name);
    } catch {
      return false;
    }
  };
  const full = has('EXT_color_buffer_float');
  const half = full || has('EXT_color_buffer_half_float');
  return { full, half };
}
