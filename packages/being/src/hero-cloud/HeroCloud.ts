/**
 * The hero point cloud: a raw WebGL2 sprite renderer that shows the guide's shape before three.js arrives, and on
 * its own where three never loads. It has no dependencies, so it ships as its own very small chunk.
 *
 * Data is an EMCL file: a 16-byte header ("EMCL", uint16 version 1, uint32 count, 6 reserved bytes), then int16 xyz
 * triplets in metres * 10000, then one uint8 seed per point, all little-endian. A missing or malformed file is
 * replaced by a procedural standing figure so the hero never looks empty.
 */
import { cloudFrag } from './cloud.frag.glsl.ts';
import { cloudVert } from './cloud.vert.glsl.ts';

export type HeroCloudTheme = 'dark' | 'light';

export interface HeroCloudOptions {
  /** URL of cloud-12k.bin or cloud-6k.bin. Empty, failing or malformed falls back to the procedural figure. */
  url: string;
  /** A pre-decoded EMCL buffer that replaces the fetch of `url` (the shell cuts the head from the file itself). */
  points?: ArrayBuffer;
  theme: HeroCloudTheme;
  /** Draw one static frame and never animate. */
  reducedMotion: boolean;
  /** Visible pixel ratio cap: 2 on desktop, 1.5 on touch. */
  maxPixelRatio?: number;
  /**
   * Frame cap while animating; 0 or unset draws at the display rate. Touch devices pass 30, the being's own idle
   * rate. Ignored under reduced motion, which draws on demand and must never skip a frame it was asked for.
   */
  maxFps?: number;
  /** Called once, after the first frame with points on screen. */
  onFirstFrame?: () => void;
}

/** Where the figure stands, in CSS pixels relative to the canvas. Null fits it to the whole canvas. */
export interface HeroCloudFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HeroCloud {
  setTheme(theme: HeroCloudTheme): void;
  /** Feed the sparkle: n tokens (or characters) just arrived. */
  tokens(n: number): void;
  /** Scroll progress 0..1; the points scatter outward as it rises. */
  setScroll(progress01: number): void;
  /** Pointer position in -1..1 relative to the canvas (x right, y up); nearby points move out of the way. */
  setPointer(x: number, y: number): void;
  setFrame(frame: HeroCloudFrame | null): void;
  /** Animate the dissolve towards a target 0..1 over ms; it snaps under reduced motion. */
  dissolve(to01: number, ms: number): void;
  /** Stops rendering, frees the buffers and releases the WebGL context. */
  dispose(): void;
}

interface Points {
  xyz: Int16Array;
  seed: Uint8Array;
  count: number;
  /** Metres that move the figure's bounding box onto the origin. */
  offset: [number, number, number];
  /** Figure height in metres, used to fit it to the frame. */
  height: number;
}

const UNIFORMS = [
  'uTime',
  'uScatter',
  'uYaw',
  'uPointer',
  'uPointerOn',
  'uTokens',
  'uCenter',
  'uScale',
  'uAspect',
  'uSize',
  'uOffset',
  'uWire',
  'uGlow',
  'uAlpha',
  'uLift',
] as const;

type UniformName = (typeof UNIFORMS)[number];
type Rgb = [number, number, number];

interface Gpu {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  xyz: WebGLBuffer;
  seed: WebGLBuffer;
  u: Record<UniformName, WebGLUniformLocation | null>;
}

const FALLBACK_POINTS = 6000;
const POINTER_HOLD_MS = 1500;
const EMCL_HEADER = 16;

export function createHeroCloud(canvas: HTMLCanvasElement, options: HeroCloudOptions): HeroCloud {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'low-power',
  });
  if (!gl) throw new Error('WebGL2 is not available');

  const maxDpr = options.maxPixelRatio ?? 2;
  const maxFps = options.maxFps ?? 0;
  const reduced = options.reducedMotion;
  let theme = options.theme;
  let gpu: Gpu | null = null;
  let points: Points | null = null;
  let frame: HeroCloudFrame | null = null;
  let disposed = false;
  let lost = false;
  let visible = true;
  let raf = 0;
  let firstFrameDone = false;

  let cssW = 1;
  let cssH = 1;
  let width = 0;
  let height = 0;
  let dpr = 1;

  let scroll = 0;
  let scrollSmooth = 0;
  let dissolveFrom = 0;
  let dissolveTo = 0;
  let dissolveStart = 0;
  let dissolveMs = 0;
  let dissolveValue = 0;
  let tokenEnergy = 0;
  let pointerX = 0;
  let pointerY = 0;
  let pointerAt = Number.NEGATIVE_INFINITY;
  let pointerOn = 0;
  let wire: Rgb = [1, 1, 1];
  let glow: Rgb = [1, 1, 1];

  const t0 = performance.now();
  let last = t0;
  let lastDraw = Number.NEGATIVE_INFINITY;

  const uploadPoints = (): void => {
    if (!gpu || !points) return;
    gl.bindVertexArray(gpu.vao);
    const aPosition = gl.getAttribLocation(gpu.program, 'aPosition');
    const aSeed = gl.getAttribLocation(gpu.program, 'aSeed');
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.xyz);
    gl.bufferData(gl.ARRAY_BUFFER, points.xyz, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 3, gl.SHORT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.seed);
    gl.bufferData(gl.ARRAY_BUFFER, points.seed, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(aSeed);
    gl.vertexAttribPointer(aSeed, 1, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.bindVertexArray(null);
  };

  const initGpu = (): Gpu | null => {
    const program = linkProgram(gl, cloudVert, cloudFrag);
    const vao = gl.createVertexArray();
    const xyz = gl.createBuffer();
    const seed = gl.createBuffer();
    if (!program || !vao || !xyz || !seed) return null;
    const u = {} as Record<UniformName, WebGLUniformLocation | null>;
    for (const name of UNIFORMS) u[name] = gl.getUniformLocation(program, name);
    return { program, vao, xyz, seed, u };
  };

  const applyTheme = (): void => {
    const style = getComputedStyle(canvas);
    wire = parseColor(style.getPropertyValue('--wire'));
    glow = parseColor(style.getPropertyValue('--glow'));
  };

  const draw = (now: number): void => {
    if (!gpu || !points || width === 0 || height === 0) return;
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    const t = reduced ? 0 : (now - t0) / 1000;

    scrollSmooth += (scroll - scrollSmooth) * (1 - Math.exp(-dt * 6));
    if (dissolveMs > 0) {
      const k = Math.min(1, (now - dissolveStart) / dissolveMs);
      dissolveValue = dissolveFrom + (dissolveTo - dissolveFrom) * easeInOut(k);
    } else {
      dissolveValue = dissolveTo;
    }
    tokenEnergy *= Math.exp(-dt * 1.8);
    const pointerTarget = now - pointerAt < POINTER_HOLD_MS ? 1 : 0;
    pointerOn += (pointerTarget - pointerOn) * (1 - Math.exp(-dt * 8));

    const scatter = Math.max(scrollSmooth, dissolveValue);
    const yaw = Math.sin(t * 0.15) * 0.22 + pointerX * 0.18 * pointerOn;
    const f = frame ?? { x: 0, y: 0, width: cssW, height: cssH };
    const pxPerMetre = (f.height * 0.9) / points.height;
    const size = Math.min(3.5, Math.max(1.5, pxPerMetre * 0.0075)) * dpr;
    const dark = theme === 'dark';

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    if (dark) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
    else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const { u } = gpu;
    gl.useProgram(gpu.program);
    gl.uniform1f(u.uTime, t);
    gl.uniform1f(u.uScatter, scatter);
    gl.uniform1f(u.uYaw, yaw);
    gl.uniform2f(u.uPointer, pointerX, pointerY);
    gl.uniform1f(u.uPointerOn, pointerOn);
    gl.uniform1f(u.uTokens, tokenEnergy);
    gl.uniform2f(u.uCenter, ((f.x + f.width / 2) / cssW) * 2 - 1, 1 - ((f.y + f.height / 2) / cssH) * 2);
    gl.uniform2f(u.uScale, (2 * pxPerMetre) / cssW, (2 * pxPerMetre) / cssH);
    gl.uniform1f(u.uAspect, cssW / cssH);
    gl.uniform1f(u.uSize, size);
    gl.uniform3f(u.uOffset, points.offset[0], points.offset[1], points.offset[2]);
    gl.uniform3f(u.uWire, wire[0], wire[1], wire[2]);
    gl.uniform3f(u.uGlow, glow[0], glow[1], glow[2]);
    gl.uniform1f(u.uAlpha, dark ? 0.55 : 0.75);
    gl.uniform1f(u.uLift, dark ? 0.35 : 0);
    gl.bindVertexArray(gpu.vao);
    gl.drawArrays(gl.POINTS, 0, points.count);
    gl.bindVertexArray(null);

    if (!firstFrameDone) {
      firstFrameDone = true;
      options.onFirstFrame?.();
    }
  };

  const shouldRun = (): boolean => !disposed && !lost && visible && !document.hidden && gpu !== null && points !== null;

  const loop = (now: number): void => {
    raf = 0;
    if (!shouldRun()) return;
    // The cap skips the draw, never the next callback, so a capped loop still moves on; the first frame is never
    // held back.
    const minInterval = !reduced && maxFps > 0 ? 1000 / maxFps : 0;
    if (now - lastDraw < minInterval - 1.5) {
      raf = requestAnimationFrame(loop);
      return;
    }
    draw(now);
    lastDraw = now;
    // Under reduced motion the loop only runs long enough for a dissolve to settle, then stops on a static frame.
    const settling = dissolveMs > 0 && now - dissolveStart < dissolveMs;
    if (!reduced || settling) raf = requestAnimationFrame(loop);
  };

  const requestFrame = (): void => {
    if (raf !== 0 || !shouldRun()) return;
    raf = requestAnimationFrame(loop);
  };

  const resize = (): void => {
    cssW = Math.max(1, canvas.clientWidth);
    cssH = Math.max(1, canvas.clientHeight);
    dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (w !== width || h !== height) {
      width = w;
      height = h;
      canvas.width = w;
      canvas.height = h;
    }
    requestFrame();
  };

  const onLost = (event: Event): void => {
    event.preventDefault();
    lost = true;
    gpu = null;
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
  };

  const onRestored = (): void => {
    if (disposed) return;
    lost = false;
    gpu = initGpu();
    uploadPoints();
    applyTheme();
    requestFrame();
  };

  const onVisibility = (): void => requestFrame();

  const resizeObserver = new ResizeObserver(resize);
  const viewObserver = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    requestFrame();
  });

  gpu = initGpu();
  applyTheme();
  resize();
  resizeObserver.observe(canvas);
  viewObserver.observe(canvas);
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  document.addEventListener('visibilitychange', onVisibility);

  void loadPoints(options.url, options.points).then((loaded) => {
    if (disposed) return;
    points = loaded;
    uploadPoints();
    requestFrame();
  });

  return {
    setTheme(next) {
      theme = next;
      applyTheme();
      requestFrame();
    },
    tokens(n) {
      if (!Number.isFinite(n) || n <= 0) return;
      tokenEnergy = Math.min(1, tokenEnergy + n * 0.06);
      requestFrame();
    },
    setScroll(progress01) {
      if (reduced) return;
      scroll = clamp01(progress01);
      requestFrame();
    },
    setPointer(x, y) {
      if (reduced) return;
      pointerX = x;
      pointerY = y;
      pointerAt = performance.now();
      requestFrame();
    },
    setFrame(next) {
      frame = next;
      requestFrame();
    },
    dissolve(to01, ms) {
      dissolveFrom = dissolveValue;
      dissolveTo = clamp01(to01);
      dissolveStart = performance.now();
      dissolveMs = reduced ? 0 : Math.max(0, ms);
      requestFrame();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
      resizeObserver.disconnect();
      viewObserver.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      document.removeEventListener('visibilitychange', onVisibility);
      if (gpu && !lost) {
        gl.deleteBuffer(gpu.xyz);
        gl.deleteBuffer(gpu.seed);
        gl.deleteVertexArray(gpu.vao);
        gl.deleteProgram(gpu.program);
      }
      gpu = null;
      points = null;
      // Releasing the context now rather than at garbage collection keeps the being's own context within limits.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

function linkProgram(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vert);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, frag);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

async function loadPoints(url: string, given?: ArrayBuffer): Promise<Points> {
  if (given) {
    const parsed = parseEmcl(given);
    if (parsed) return parsed;
  }
  if (url) {
    try {
      const response = await fetch(url, { priority: 'low' });
      if (response.ok) {
        const parsed = parseEmcl(await response.arrayBuffer());
        if (parsed) return parsed;
      }
    } catch {
      // A network failure is not worth reporting: the procedural figure below covers it.
    }
  }
  return proceduralFigure(FALLBACK_POINTS);
}

function parseEmcl(buffer: ArrayBuffer): Points | null {
  if (buffer.byteLength < EMCL_HEADER) return null;
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'EMCL' || view.getUint16(4, true) !== 1) return null;
  const count = view.getUint32(6, true);
  if (count === 0 || buffer.byteLength < EMCL_HEADER + count * 7) return null;
  const xyz = new Int16Array(buffer, EMCL_HEADER, count * 3);
  const seed = new Uint8Array(buffer, EMCL_HEADER + count * 6, count);
  return measure(xyz, seed, count);
}

function measure(xyz: Int16Array, seed: Uint8Array, count: number): Points {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count * 3; i += 1) {
    const v = xyz[i] ?? 0;
    const axis = i % 3;
    if (v < (min[axis] ?? Infinity)) min[axis] = v;
    if (v > (max[axis] ?? -Infinity)) max[axis] = v;
  }
  const centre = (axis: number): number => -(((min[axis] ?? 0) + (max[axis] ?? 0)) / 2) * 0.0001;
  const height = Math.max(0.1, ((max[1] ?? 0) - (min[1] ?? 0)) * 0.0001);
  return { xyz, seed, count, offset: [centre(0), centre(1), centre(2)], height };
}

/** A standing figure from stacked ellipsoids: enough to read as a person while the real cloud is missing. */
function proceduralFigure(count: number): Points {
  // [cx, cy, cz, rx, ry, rz] in metres; y up, feet at zero, facing +Z.
  const parts: [number, number, number, number, number, number][] = [
    [0, 1.62, 0, 0.1, 0.125, 0.11],
    [0, 1.47, 0, 0.055, 0.06, 0.055],
    [0, 1.26, 0, 0.19, 0.2, 0.11],
    [0, 1.04, 0, 0.15, 0.14, 0.1],
    [0, 0.9, 0, 0.17, 0.1, 0.11],
    [-0.24, 1.22, 0, 0.055, 0.17, 0.055],
    [0.24, 1.22, 0, 0.055, 0.17, 0.055],
    [-0.27, 0.92, 0.02, 0.045, 0.16, 0.045],
    [0.27, 0.92, 0.02, 0.045, 0.16, 0.045],
    [-0.28, 0.72, 0.04, 0.045, 0.06, 0.03],
    [0.28, 0.72, 0.04, 0.045, 0.06, 0.03],
    [-0.1, 0.62, 0, 0.085, 0.24, 0.085],
    [0.1, 0.62, 0, 0.085, 0.24, 0.085],
    [-0.1, 0.22, 0, 0.065, 0.22, 0.065],
    [0.1, 0.22, 0, 0.065, 0.22, 0.065],
    [-0.1, 0.03, 0.05, 0.06, 0.03, 0.11],
    [0.1, 0.03, 0.05, 0.06, 0.03, 0.11],
  ];
  const areas = parts.map(([, , , rx, ry, rz]) => rx * ry + ry * rz + rz * rx);
  const total = areas.reduce((sum, area) => sum + area, 0);
  const xyz = new Int16Array(count * 3);
  const seed = new Uint8Array(count);
  // A fixed-seed generator keeps the fallback identical on every load.
  let state = 0x9e3779b9;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  let i = 0;
  parts.forEach(([cx, cy, cz, rx, ry, rz], index) => {
    const n = index === parts.length - 1 ? count - i : Math.round((count * (areas[index] ?? 0)) / total);
    for (let k = 0; k < n && i < count; k += 1, i += 1) {
      const u = random() * 2 - 1;
      const phi = random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      xyz[i * 3] = Math.round((cx + r * Math.cos(phi) * rx) * 10000);
      xyz[i * 3 + 1] = Math.round((cy + u * ry) * 10000);
      xyz[i * 3 + 2] = Math.round((cz + r * Math.sin(phi) * rz) * 10000);
      seed[i] = Math.floor(random() * 256);
    }
  });
  return measure(xyz, seed, count);
}

/** Accepts #rgb, #rrggbb and rgb()/rgba() values; anything else reads as white. */
function parseColor(value: string): Rgb {
  const v = value.trim();
  if (v.startsWith('#')) {
    const hex = v.length === 4 ? v.slice(1).replace(/./g, (c) => c + c) : v.slice(1, 7);
    const n = Number.parseInt(hex, 16);
    if (Number.isFinite(n) && hex.length === 6)
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const parts = v.match(/\d+(\.\d+)?/g);
  if (parts && parts.length >= 3) return [Number(parts[0]) / 255, Number(parts[1]) / 255, Number(parts[2]) / 255];
  return [1, 1, 1];
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

const easeInOut = (k: number): number => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
