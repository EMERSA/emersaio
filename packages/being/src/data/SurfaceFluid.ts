import {
  ClampToEdgeWrapping,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  type Texture,
  Vector2,
  Vector4,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { fluidFrag, fluidVert } from '../avatar/shaders/fluid.glsl.ts';
import type { DepthEncoding } from './depth/DepthSource.ts';
import {
  DROP_AREA,
  DROP_BRUSH,
  dropGap,
  FLUID_DAMPING,
  FLUID_GRID,
  FLUID_LIMIT,
  FLUID_MAX_STEPS,
  FLUID_STEP_S,
  STIR_BRUSH,
  stirPush,
  VOICE_BRUSH,
  voicePush,
} from './fluidMath.ts';

const ENCODING: Readonly<Record<DepthEncoding, number>> = { perspective: 0, grey: 1, metres: 2 };

/** What moves the liquid this frame: where Emily's lips and the pointer are in sensor uv, and how strongly. */
export interface FluidDrive {
  /** Her lips in sensor uv, and her loudness 0..1 (0 while she is silent). */
  voiceU: number;
  voiceV: number;
  voice: number;
  /** The pointer in sensor uv, and its speed over the face in sensor frames a second (0 while it rests). */
  stirU: number;
  stirV: number;
  stir: number;
}

export interface SurfaceFluidOptions {
  /** No motion at all: nothing is simulated and the surface reads flat. */
  reducedMotion?: boolean;
  /** Injectable for tests and for a repeatable look; Math.random otherwise. */
  random?: () => number;
}

/**
 * The shards' liquid skin on the GPU: the height field of data/fluidMath.ts in two half-float targets the size of
 * FLUID_GRID, stepped 120 times a second by a full-screen pass (avatar/shaders/fluid.glsl.ts) and read by the
 * cloud's vertex stage, which moves each shard along the sensor ray by the height and tilts its light by the slope.
 * A device that cannot render to half floats, or a visitor who asked for reduced motion, gets no texture and a
 * still surface.
 */
export class SurfaceFluid {
  readonly supported: boolean;
  private readonly renderer: WebGLRenderer;
  /** The state now (front) and the target the next step writes (back); they swap every step. */
  private front: WebGLRenderTarget | null = null;
  private back: WebGLRenderTarget | null = null;
  private readonly material: ShaderMaterial | null = null;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly random: () => number;
  private carry = 0;
  private clock = 0;
  private nextDrop = 1;
  private fresh = true;

  constructor(renderer: WebGLRenderer, options: SurfaceFluidOptions = {}) {
    this.renderer = renderer;
    this.random = options.random ?? Math.random;
    const extensions = renderer.extensions;
    const renderable = extensions.has('EXT_color_buffer_float') || extensions.has('EXT_color_buffer_half_float');
    this.supported = renderable && options.reducedMotion !== true;
    if (!this.supported) return;
    const target = (): WebGLRenderTarget =>
      new WebGLRenderTarget(FLUID_GRID.cols, FLUID_GRID.rows, {
        type: HalfFloatType,
        format: RGBAFormat,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        wrapS: ClampToEdgeWrapping,
        wrapT: ClampToEdgeWrapping,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
    this.front = target();
    this.back = target();
    this.material = new ShaderMaterial({
      uniforms: {
        uState: { value: null },
        uDepth: { value: null },
        uEncoding: { value: 0 },
        uClip: { value: new Vector2(0.1, 50) },
        uTexel: { value: new Vector2(1 / FLUID_GRID.cols, 1 / FLUID_GRID.rows) },
        uDamping: { value: FLUID_DAMPING },
        uLimit: { value: FLUID_LIMIT },
        uAspect: { value: FLUID_GRID.cols / FLUID_GRID.rows },
        uReset: { value: 1 },
        uVoice: { value: new Vector4(0.5, 0.5, 0, VOICE_BRUSH.radius) },
        uStir: { value: new Vector4(0.5, 0.5, 0, STIR_BRUSH.radius) },
        uDrop: { value: new Vector4(0.5, 0.5, 0, DROP_BRUSH.radius) },
      },
      vertexShader: fluidVert,
      fragmentShader: fluidFrag,
      depthTest: false,
      depthWrite: false,
    });
    this.material.name = 'SurfaceFluid';
    const quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /** The current state (height, last height, slope), or null when the surface is still. */
  get texture(): Texture | null {
    return this.front?.texture ?? null;
  }

  /** Where the liquid may be: the cloud's depth texture and how to read it. */
  setDepth(texture: Texture, encoding: DepthEncoding, nearM: number, farM: number): void {
    const u = this.material?.uniforms;
    if (!u) return;
    if (u.uDepth) u.uDepth.value = texture;
    if (u.uEncoding) u.uEncoding.value = ENCODING[encoding];
    (u.uClip?.value as Vector2 | undefined)?.set(nearM, farM);
  }

  /** Flatten the surface, for example when the look changes. */
  reset(): void {
    this.fresh = true;
  }

  /** Advance by `dt` seconds at FLUID_STEP_S a step, at most FLUID_MAX_STEPS this frame. */
  update(dt: number, drive: FluidDrive): void {
    const material = this.material;
    if (!this.front || !this.back || !material) return;
    const u = material.uniforms;
    const previous = this.renderer.getRenderTarget();
    if (this.fresh) {
      this.fresh = false;
      this.carry = 0;
      if (u.uReset) u.uReset.value = 1;
      for (const target of [this.front, this.back]) {
        this.renderer.setRenderTarget(target);
        this.renderer.render(this.scene, this.camera);
      }
      if (u.uReset) u.uReset.value = 0;
    }
    this.carry += Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
    let steps = 0;
    while (this.carry >= FLUID_STEP_S && steps < FLUID_MAX_STEPS) {
      this.carry -= FLUID_STEP_S;
      steps += 1;
      this.clock += FLUID_STEP_S;
      (u.uVoice?.value as Vector4).set(
        drive.voiceU,
        drive.voiceV,
        voicePush(drive.voice, this.clock),
        VOICE_BRUSH.radius,
      );
      (u.uStir?.value as Vector4).set(drive.stirU, drive.stirV, stirPush(drive.stir), STIR_BRUSH.radius);
      const drop = u.uDrop?.value as Vector4;
      if (this.clock >= this.nextDrop) {
        this.nextDrop = this.clock + dropGap(this.random());
        const du = DROP_AREA.u[0] + (DROP_AREA.u[1] - DROP_AREA.u[0]) * this.random();
        const dv = DROP_AREA.v[0] + (DROP_AREA.v[1] - DROP_AREA.v[0]) * this.random();
        drop.set(du, dv, DROP_BRUSH.force * (0.6 + 0.4 * this.random()), DROP_BRUSH.radius);
      } else {
        drop.z = 0;
      }
      if (u.uState) u.uState.value = this.front.texture;
      this.renderer.setRenderTarget(this.back);
      this.renderer.render(this.scene, this.camera);
      [this.front, this.back] = [this.back, this.front];
    }
    // A long frame drops the time it could not step rather than carrying it into the next.
    if (steps === FLUID_MAX_STEPS) this.carry = 0;
    this.renderer.setRenderTarget(previous);
  }

  dispose(): void {
    this.front?.dispose();
    this.back?.dispose();
    this.material?.dispose();
    for (const child of this.scene.children) if (child instanceof Mesh) child.geometry.dispose();
  }
}
