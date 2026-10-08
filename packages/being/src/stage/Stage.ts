import {
  type Blending,
  MathUtils,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { Backdrop, type BackdropUniforms } from './Backdrop.ts';
import { type Framing, faceFramingFor, framingFor, type HeadBounds, visibleHeight } from './framing.ts';
import type { BloomChain, BloomChainOptions } from './postprocessing.ts';

/** The figure stands with its feet at y = 0 and its crown here, facing +Z (avatar asset contract). */
export const FIGURE_HEIGHT = 1.75;
export const BLOOM_THRESHOLD = 0.55;

/** A backgrounded tab must not resume with one giant step. */
const MAX_DELTA_S = 0.1;
/** Canvas height under which the stage drops bloom and the extras (the docked tour panel is about 144 px). */
const SMALL_STAGE_PX = 260;
/** The display rate assumed until the first probe has measured it. */
const DEFAULT_DISPLAY_FPS = 60;
/**
 * Animation-frame callbacks counted, drawing nothing, each time the loop starts or resumes. Their median spacing is
 * the display rate the quality ladder measures against: the being's own GPU cost cannot slow an empty callback, and
 * a 30 Hz cap (Low Power Mode, Energy Saver, a 30 Hz screen) shows up as 30 rather than as a slow device.
 */
const PROBE_FRAMES = 15;
/** Shader links are awaited this long at most before the first frame goes ahead regardless. */
const COMPILE_WAIT_MS = 6000;
/** The view's pointer parallax: at most this much yaw and pitch, eased with this time constant. */
export const PARALLAX_YAW_DEG = 6;
export const PARALLAX_PITCH_DEG = 3;
const PARALLAX_EASE_S = 0.35;

export interface StageOptions {
  canvas: HTMLCanvasElement;
  /**
   * MSAA on the canvas; only worth asking for when there is no composer (its target is not multisampled, so the
   * samples would never see a geometry edge). The wire strokes antialias themselves through fwidth.
   */
  antialias: boolean;
  bloomStrength: number;
  bloomRadius?: number;
  pixelRatio: number;
  /** Frame cap while nothing is happening; 0 means the display rate. */
  idleFps: number;
  /** The rim light and the god rays behind the figure; left out, the stage has no backdrop. */
  backdrop?: { uniforms: BackdropUniforms; blending: Blending };
  onContextLost?: () => void;
}

export type FrameCallback = (dtSeconds: number, elapsedSeconds: number) => void;

export type { Framing, HeadBounds } from './framing.ts';

/**
 * Renderer, camera, composer and the render loop. The loop pauses when the tab is hidden or the canvas scrolls out
 * of view, runs at a capped rate while idle on touch devices, and stops for good on context loss.
 */
export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  /** The point the camera looks at. */
  readonly cameraTarget = new Vector3(0, 1, 0);
  /** The rim light and the god rays, when the options asked for them. */
  readonly backdrop: Backdrop | null;

  private readonly canvas: HTMLCanvasElement;
  private readonly host: HTMLElement;
  private readonly idleFps: number;
  private readonly onContextLostCallback: (() => void) | undefined;
  private chain: BloomChain | null = null;
  private width = 1;
  private height = 1;
  private pixelRatio: number;
  /** Bloom strength asked for by the theme; the applied value shrinks with the canvas (see layout). */
  private baseBloom = 0;
  /** The quality tier's say on bloom, remembered for a chain that arrives later. */
  private bloomWanted = true;
  private bloomRadius: number;
  /** The look's share of the theme's strength: the face look, a large bright head, takes less. */
  private bloomScale = 1;
  /** The light theme draws with normal blending, which the composer's output has to treat as premultiplied. */
  private lightOutput = false;
  private framing: Framing = framingFor(1);
  /** The head's bounds while the face look frames the head alone; null frames the figure. */
  private faceBounds: HeadBounds | null = null;
  /** Where the pointer wants the view (-1..1), and where the eased view is. */
  private readonly parallaxGoal = new Vector2();
  private readonly parallax = new Vector2();
  private parallaxOn = false;
  private frame: FrameCallback = () => {};
  private layoutCallback: (() => void) | null = null;
  private wanted = false;
  private running = false;
  private visible = typeof document === 'undefined' ? true : !document.hidden;
  private inView = true;
  private lost = false;
  private busy = false;
  private lastTick = 0;
  private lastRender = Number.NEGATIVE_INFINITY;
  private readonly startedAt = performance.now();
  private avgInterval = 1000 / DEFAULT_DISPLAY_FPS;
  private displayFps = DEFAULT_DISPLAY_FPS;
  private probing = false;
  private probeLast = Number.NEGATIVE_INFINITY;
  private readonly probeDeltas: number[] = [];
  private readonly resizeObserver: ResizeObserver | null;
  private readonly intersection: IntersectionObserver | null;

  private readonly onVisibility = (): void => {
    this.visible = !document.hidden;
    this.updateRunning();
  };

  private readonly onContextLost = (): void => {
    this.lost = true;
    this.updateRunning();
    this.onContextLostCallback?.();
  };

  private readonly tick = (): void => {
    if (!this.running) return;
    const now = performance.now();
    if (this.probing && this.probe(now)) return;
    const minInterval = !this.busy && this.idleFps > 0 ? 1000 / this.idleFps : 0;
    if (now - this.lastRender < minInterval - 1.5) return;
    const dt = Math.min((now - this.lastTick) / 1000, MAX_DELTA_S);
    const interval = now - this.lastRender;
    if (Number.isFinite(interval)) this.avgInterval += (interval - this.avgInterval) * 0.1;
    this.lastTick = now;
    this.lastRender = now;
    // Counting every pass of the frame, not just the last one, needs manual resets.
    this.renderer.info.reset();
    this.easeParallax(dt);
    this.frame(dt, (now - this.startedAt) / 1000);
    this.render();
  };

  constructor(options: StageOptions) {
    this.canvas = options.canvas;
    this.host = options.canvas.parentElement ?? options.canvas;
    this.idleFps = options.idleFps;
    this.pixelRatio = options.pixelRatio;
    this.onContextLostCallback = options.onContextLost;

    this.renderer = new WebGLRenderer({
      canvas: options.canvas,
      antialias: options.antialias,
      alpha: true,
      powerPreference: 'high-performance',
    });
    // Alpha 0 on the default (black) clear colour: the page background shows through the canvas.
    this.renderer.setClearAlpha(0);
    this.renderer.outputColorSpace = SRGBColorSpace;
    // The tokens are the colours; tone mapping would shift them.
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.info.autoReset = false;
    this.renderer.setPixelRatio(this.pixelRatio);

    this.camera = new PerspectiveCamera(30, 1, 0.1, 50);
    this.backdrop = options.backdrop ? new Backdrop(options.backdrop.uniforms, options.backdrop.blending) : null;
    if (this.backdrop) this.scene.add(this.backdrop.group);
    this.baseBloom = options.bloomStrength;
    this.bloomRadius = options.bloomRadius ?? 0.5;

    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.layout()) : null;
    this.resizeObserver?.observe(this.host);
    this.intersection =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
            ([entry]) => {
              this.inView = entry?.isIntersecting ?? true;
              this.updateRunning();
            },
            { threshold: 0 },
          )
        : null;
    this.intersection?.observe(this.host);
    this.layout();
  }

  /** The per-frame update, called before the render. */
  onFrame(callback: FrameCallback): void {
    this.frame = callback;
  }

  /** Called after every layout (a resize, a new framing), once the camera has been placed. */
  onLayout(callback: () => void): void {
    this.layoutCallback = callback;
  }

  /**
   * Hand over the bloom chain (postprocessing.ts, loaded on demand). The passes take the size, strength, radius and
   * output mode the stage already holds, so it makes no difference whether the tier or the theme was set first.
   */
  attachBloom(create: (options: BloomChainOptions) => BloomChain): void {
    if (this.chain || this.lost) return;
    this.chain = create({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      width: this.width,
      height: this.height,
      pixelRatio: this.pixelRatio,
      strength: this.baseBloom,
      radius: this.bloomRadius,
      threshold: BLOOM_THRESHOLD,
    });
    this.chain.output.setStraight(this.lightOutput);
    this.applyBloomStrength();
  }

  /**
   * Link every program in the scene before the first frame. With KHR_parallel_shader_compile the links finish in
   * the background and this waits for them; without it the same stalls happen here rather than inside the first
   * tick. Gives up after a bound, and at once on a lost context, so a stuck driver never holds the being back.
   */
  compile(): Promise<void> {
    if (this.lost) return Promise.resolve();
    let compiled: Promise<unknown>;
    try {
      compiled = this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = window.setTimeout(resolve, COMPILE_WAIT_MS);
      const done = (): void => {
        window.clearTimeout(timer);
        resolve();
      };
      compiled.then(done, done);
    });
  }

  start(): void {
    this.wanted = true;
    this.updateRunning();
  }

  stop(): void {
    this.wanted = false;
    this.updateRunning();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Speaking lifts the idle frame cap. */
  setBusy(on: boolean): void {
    this.busy = on;
  }

  setPixelRatio(ratio: number): void {
    const next = Math.max(0.5, ratio);
    if (next === this.pixelRatio) return;
    this.pixelRatio = next;
    this.layout();
  }

  getPixelRatio(): number {
    return this.pixelRatio;
  }

  /** The quality tier's choice; it only takes effect on a stage that was given a bloom chain. */
  setBloom(enabled: boolean, radius: number): void {
    this.bloomWanted = enabled;
    this.bloomRadius = radius;
    if (this.chain) this.chain.bloom.radius = radius;
    this.applyBloomStrength();
  }

  setBloomStrength(strength: number): void {
    this.baseBloom = strength;
    this.applyBloomStrength();
  }

  /** A share of the theme's strength for the current look; 1 draws the theme's own. */
  setBloomScale(scale: number): void {
    this.bloomScale = scale;
    this.applyBloomStrength();
  }

  /** The theme's blending: normal on the light page, additive on the dark one. See render(). */
  setLightOutput(on: boolean): void {
    this.lightOutput = on;
    this.chain?.output.setStraight(on);
  }

  /**
   * A small canvas (the docked tour panel, a phone) draws the whole figure into a few hundred pixels, where full
   * bloom turns it into one white glow. The strength follows the canvas height down to about a third.
   */
  private applyBloomStrength(): void {
    const chain = this.chain;
    if (!chain) return;
    // Below the small-stage threshold (the docked tour panel) bloom is off altogether: at that size even a third of
    // the strength melts the figure into one glow.
    const scale = this.height < SMALL_STAGE_PX ? 0 : MathUtils.clamp(this.height / 520, 0.35, 1);
    chain.bloom.strength = this.baseBloom * scale * this.bloomScale;
    // A bloom of nothing would still run the high-pass and the whole blur chain; disabled, the composer only
    // renders the scene and the output pass.
    chain.bloom.enabled = this.bloomWanted && chain.bloom.strength > 0;
  }

  /** Frame the head alone (the face look) or the whole figure (null). The small docked stage keeps its own framing. */
  setFaceBounds(bounds: HeadBounds | null): void {
    if (bounds === this.faceBounds) return;
    this.faceBounds = bounds;
    this.layout();
  }

  /**
   * The pointer in -1..1 (x right, y up): the view orbits its target by at most PARALLAX_YAW_DEG of yaw and
   * PARALLAX_PITCH_DEG of pitch, eased, so the fixed sensor's artefacts show from a slightly different side.
   */
  setParallax(x: number, y: number): void {
    this.parallaxGoal.set(MathUtils.clamp(x, -1, 1), MathUtils.clamp(y, -1, 1));
    this.parallaxOn = true;
  }

  /** The drawing surface in CSS pixels. */
  size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** Metres of the scene the frame takes in at the point the camera looks at. */
  frameSize(): { width: number; height: number } {
    const height = visibleHeight(this.framing);
    return { width: height * this.camera.aspect, height };
  }

  /** The camera's distance from the point it looks at. */
  distance(): number {
    return this.framing.distance;
  }

  /** True while the canvas is too small for the extras (bloom, the cloud, the ribbon, the floor). */
  isSmall(): boolean {
    return this.height < SMALL_STAGE_PX;
  }

  hasBloom(): boolean {
    return this.chain !== null;
  }

  /** The current camera layout, 0 portrait to 1 landscape. */
  layoutT(): number {
    return this.framing.t;
  }

  /** Measured frames per second, smoothed. */
  fps(): number {
    return 1000 / this.avgInterval;
  }

  /** The rate the loop is trying for right now: the measured display rate, or the idle cap when that is lower. */
  targetFps(): number {
    return !this.busy && this.idleFps > 0 ? Math.min(this.displayFps, this.idleFps) : this.displayFps;
  }

  drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  triangles(): number {
    return this.renderer.info.render.triangles;
  }

  dispose(): void {
    this.wanted = false;
    this.running = false;
    this.renderer.setAnimationLoop(null);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver?.disconnect();
    this.intersection?.disconnect();
    this.chain?.dispose();
    this.chain = null;
    this.backdrop?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private layout(): void {
    const width = Math.max(1, this.host.clientWidth || this.canvas.clientWidth || 1);
    const height = Math.max(1, this.host.clientHeight || this.canvas.clientHeight || 1);
    this.width = width;
    this.height = height;
    this.renderer.setPixelRatio(this.pixelRatio);
    // CSS owns the canvas box; only the drawing buffer changes here.
    this.renderer.setSize(width, height, false);

    const aspect = width / height;
    const small = height < SMALL_STAGE_PX;
    this.framing = small || !this.faceBounds ? framingFor(aspect, small) : faceFramingFor(aspect, this.faceBounds);
    this.camera.aspect = aspect;
    this.camera.fov = this.framing.fov;
    this.cameraTarget.set(0, this.framing.targetY, this.framing.targetZ);
    this.placeCamera();
    this.camera.updateProjectionMatrix();

    if (this.chain) {
      this.chain.composer.setPixelRatio(this.pixelRatio);
      this.chain.composer.setSize(width, height);
    }
    this.applyBloomStrength();
    this.layoutCallback?.();
  }

  /** The camera on its orbit about the target: level in front of it, turned by the eased parallax. */
  private placeCamera(): void {
    const yaw = this.parallax.x * MathUtils.degToRad(PARALLAX_YAW_DEG);
    const pitch = this.parallax.y * MathUtils.degToRad(PARALLAX_PITCH_DEG);
    const d = this.framing.distance;
    this.camera.position.set(
      this.cameraTarget.x + d * Math.sin(yaw) * Math.cos(pitch),
      this.cameraTarget.y + d * Math.sin(pitch),
      this.cameraTarget.z + d * Math.cos(yaw) * Math.cos(pitch),
    );
    this.camera.lookAt(this.cameraTarget);
  }

  private easeParallax(dt: number): void {
    if (!this.parallaxOn) return;
    const k = 1 - Math.exp(-dt / PARALLAX_EASE_S);
    this.parallax.x += (this.parallaxGoal.x - this.parallax.x) * k;
    this.parallax.y += (this.parallaxGoal.y - this.parallax.y) * k;
    if (Math.abs(this.parallax.x - this.parallaxGoal.x) + Math.abs(this.parallax.y - this.parallaxGoal.y) < 1e-4) {
      this.parallax.copy(this.parallaxGoal);
      this.parallaxOn = false;
    }
    this.placeCamera();
  }

  /**
   * The composer sums the dark theme's additive strokes in linear light before one sRGB transfer, and the dark
   * look is tuned to that, so it stays on even where the bloom itself is off (the docked panel). Normal blending
   * on the light page gains nothing from it: with no bloom to add the frame goes straight to the canvas, the path
   * the lite tier and touch devices take, so the light theme looks the same from tier to tier.
   */
  private render(): void {
    const chain = this.chain;
    if (chain && this.bloomWanted && !(this.lightOutput && chain.bloom.strength === 0)) chain.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /** One probe callback; true while the probe still wants the next one. */
  private probe(now: number): boolean {
    if (Number.isFinite(this.probeLast)) this.probeDeltas.push(now - this.probeLast);
    this.probeLast = now;
    if (this.probeDeltas.length < PROBE_FRAMES) return true;
    const sorted = [...this.probeDeltas].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    if (median !== undefined && median > 0) this.displayFps = MathUtils.clamp(1000 / median, 20, 240);
    this.probing = false;
    // The first drawn frame steps on from here, not from before the probe.
    this.lastTick = now;
    return false;
  }

  private updateRunning(): void {
    const should = this.wanted && this.visible && this.inView && !this.lost;
    if (should === this.running) return;
    this.running = should;
    if (should) {
      this.lastTick = performance.now();
      this.lastRender = Number.NEGATIVE_INFINITY;
      // Every start and resume measures the display rate afresh: a cap may have begun while the loop was away.
      this.probing = true;
      this.probeLast = Number.NEGATIVE_INFINITY;
      this.probeDeltas.length = 0;
      this.renderer.setAnimationLoop(this.tick);
    } else {
      this.renderer.setAnimationLoop(null);
    }
  }
}
