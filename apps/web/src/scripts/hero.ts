/**
 * The hero point cloud on the home page. It waits for the heading to paint (the LCP element) and for an idle moment
 * before pulling in the renderer, then follows scroll, pointer, theme and token events. When the being reports
 * ready the cloud dissolves into it and releases its WebGL context. The hero shows the head and shoulders (the
 * being's kinect-demo look), so the cloud is cut to that region here and framed where the runtime will draw it, and
 * the crossfade lands in place.
 */
import { BUST_FLOOR_SHARE, BUST_SHARE, layoutT } from '@emersa/being/framing';
import type { HeroCloud, HeroCloudFrame, HeroCloudOptions } from '@emersa/being/hero-cloud';

type Theme = 'dark' | 'light';
/** Which part of the figure the cloud shows: the whole 1.75 m figure, or the head and shoulders. */
type Region = 'figure' | 'head';

interface CloudOptions {
  region: Region;
}

/** The figure's crown in the sampled cloud, in metres. */
const CROWN_Y_M = 1.75;
const LCP_TIMEOUT_MS = 2500;
const IDLE_TIMEOUT_MS = 1500;
const HANDOVER_MS = 720;

/** The EMCL header: "EMCL", uint16 version 1, uint32 count, 6 reserved bytes; then int16 xyz in metres * 10000. */
const EMCL_HEADER = 16;
/**
 * The head-and-shoulders region: every point from here up, in metres * 10000; the runtime's kinect-demo look crops
 * its depth at the same share of the 1.75 m figure (1.25 m).
 */
const HEAD_MIN_Y = Math.round(CROWN_Y_M * BUST_FLOOR_SHARE * 10000);
/** The cloud fits its points to this share of the frame's height (HeroCloud.ts). */
const CLOUD_FIT = 0.9;

const heroCanvas = document.querySelector('[data-hero-canvas]');
if (heroCanvas instanceof HTMLCanvasElement && heroCanvas.dataset.cloud === undefined) {
  heroCanvas.dataset.cloud = 'queued';
  void boot(heroCanvas, { region: 'head' });
}

async function boot(canvas: HTMLCanvasElement, { region }: CloudOptions): Promise<void> {
  const hero = canvas.closest<HTMLElement>('[data-hero]') ?? canvas.parentElement ?? document.body;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const touch = matchMedia('(hover: none), (pointer: coarse)').matches;
  const cleanups: (() => void)[] = [];
  let cloud: HeroCloud | null = null;
  let handedOver = false;

  // The being announces itself once; the cloud scatters into it and then frees its context for good.
  const handOver = (): void => {
    const active = cloud;
    if (!active) return;
    cloud = null;
    active.dissolve(1, HANDOVER_MS);
    setTimeout(() => {
      for (const undo of cleanups) undo();
      active.dispose();
      hero.classList.remove('is-ready');
      canvas.dataset.cloud = 'released';
    }, HANDOVER_MS + 80);
  };
  document.addEventListener(
    'em:being-ready',
    () => {
      handedOver = true;
      handOver();
    },
    { once: true },
  );

  await afterLcp();
  await whenIdle();
  if (handedOver) return;

  const url = pickUrl(canvas, touch);
  try {
    // The head points are cut from the file while the renderer's chunk is still arriving.
    const [{ createHeroCloud }, points] = await Promise.all([
      import('@emersa/being/hero-cloud'),
      region === 'head' ? loadHeadPoints(url) : Promise.resolve(null),
    ]);
    if (handedOver) return;
    const options: HeroCloudOptions = {
      url,
      theme: currentTheme(),
      reducedMotion,
      maxPixelRatio: touch ? 1.5 : 2,
      onFirstFrame: () => hero.classList.add('is-ready'),
    };
    if (points) options.points = points;
    cloud = createHeroCloud(canvas, options);
  } catch {
    canvas.dataset.cloud = 'unavailable';
    return;
  }
  if (handedOver) {
    handOver();
    return;
  }
  canvas.dataset.cloud = 'live';
  const live = cloud;

  // The cloud stands where the being will appear, so the crossfade happens in place: the head in the runtime's
  // head frame, or the whole figure fitted the way the runtime's camera fits it.
  const stage = hero.querySelector<HTMLElement>('[data-being-stage]');
  const updateFrame = (): void => {
    const c = canvas.getBoundingClientRect();
    const s = stage?.getBoundingClientRect();
    if (!s || s.width === 0 || s.height === 0) {
      live.setFrame(null);
      return;
    }
    live.setFrame(region === 'head' ? headFrame(s, c) : figureFrame(s, c));
  };
  updateFrame();
  const resizeObserver = new ResizeObserver(updateFrame);
  resizeObserver.observe(canvas);
  if (stage) resizeObserver.observe(stage);
  cleanups.push(() => resizeObserver.disconnect());

  let scrollQueued = false;
  const onScroll = (): void => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      live.setScroll(window.scrollY / Math.max(1, hero.offsetHeight * 0.85));
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  cleanups.push(() => window.removeEventListener('scroll', onScroll));
  onScroll();

  const onPointer = (event: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    live.setPointer(((event.clientX - r.left) / r.width) * 2 - 1, 1 - ((event.clientY - r.top) / r.height) * 2);
  };
  hero.addEventListener('pointermove', onPointer, { passive: true });
  cleanups.push(() => hero.removeEventListener('pointermove', onPointer));

  const onTheme = (event: Event): void => live.setTheme(themeFromEvent(event));
  document.addEventListener('em:theme', onTheme);
  cleanups.push(() => document.removeEventListener('em:theme', onTheme));

  const onTokens = (event: Event): void => live.tokens(tokenCount(event));
  document.addEventListener('em:tokens', onTokens);
  cleanups.push(() => document.removeEventListener('em:tokens', onTokens));
}

/**
 * The frame that lands the cloud on the runtime's head and shoulders (framing.ts, the kinect-demo look): the bust,
 * from BUST_FLOOR_SHARE of the crown's height up to the crown, fills BUST_SHARE of the stage's height, centred, on
 * any aspect. The cloud fits its own points (cut at the same height) to 90% of the frame's height, centred.
 */
function headFrame(s: DOMRect, c: DOMRect): HeroCloudFrame {
  const height = (BUST_SHARE / CLOUD_FIT) * s.height;
  return { x: s.left - c.left, y: s.top - c.top + (s.height - height) / 2, width: s.width, height };
}

/**
 * The whole figure: the cloud fits it to 90% of its frame, while the being's camera shows it at about 87% of a
 * portrait canvas and 85% of a squarer one, from the same top (Stage.ts framingFor); the frame is shortened to
 * match on the bleeding stage.
 */
function figureFrame(s: DOMRect, c: DOMRect): HeroCloudFrame {
  const fit = 0.972 + (0.917 - 0.972) * layoutT(s.width / s.height);
  return { x: s.left - c.left, y: s.top - c.top, width: s.width, height: s.height * fit };
}

/**
 * The EMCL file with every point below the head removed, re-encoded as EMCL for the cloud to upload. Null when
 * the file is missing or malformed, which leaves the cloud to load on its own as before (the whole figure, or the
 * procedural one when that fails too).
 */
async function loadHeadPoints(url: string): Promise<ArrayBuffer | null> {
  if (!url) return null;
  try {
    const response = await fetch(url, { priority: 'low' });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength < EMCL_HEADER) return null;
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'EMCL' || view.getUint16(4, true) !== 1) return null;
    const count = view.getUint32(6, true);
    if (count === 0 || buffer.byteLength < EMCL_HEADER + count * 7) return null;
    const xyz = new Int16Array(buffer, EMCL_HEADER, count * 3);
    const seed = new Uint8Array(buffer, EMCL_HEADER + count * 6, count);
    const keep: number[] = [];
    for (let i = 0; i < count; i += 1) if ((xyz[i * 3 + 1] ?? 0) >= HEAD_MIN_Y) keep.push(i);
    if (keep.length === 0) return null;
    const out = new ArrayBuffer(EMCL_HEADER + keep.length * 7);
    new Uint8Array(out, 0, EMCL_HEADER).set(new Uint8Array(buffer, 0, EMCL_HEADER));
    new DataView(out).setUint32(6, keep.length, true);
    const outXyz = new Int16Array(out, EMCL_HEADER, keep.length * 3);
    const outSeed = new Uint8Array(out, EMCL_HEADER + keep.length * 6, keep.length);
    keep.forEach((i, n) => {
      outXyz[n * 3] = xyz[i * 3] ?? 0;
      outXyz[n * 3 + 1] = xyz[i * 3 + 1] ?? 0;
      outXyz[n * 3 + 2] = xyz[i * 3 + 2] ?? 0;
      outSeed[n] = seed[i] ?? 0;
    });
    return out;
  } catch {
    return null;
  }
}

function pickUrl(canvas: HTMLCanvasElement, touch: boolean): string {
  const { cloudTouch = '', cloudDesktop = '' } = canvas.dataset;
  return touch ? cloudTouch || cloudDesktop : cloudDesktop || cloudTouch;
}

/** Resolves after the first largest-contentful-paint entry, or after a timeout where the observer is unavailable. */
function afterLcp(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, LCP_TIMEOUT_MS);
    try {
      const observer = new PerformanceObserver(() => {
        clearTimeout(timer);
        observer.disconnect();
        finish();
      });
      observer.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      clearTimeout(timer);
      setTimeout(finish, 500);
    }
  });
}

function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS });
    else setTimeout(resolve, 300);
  });
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function themeFromEvent(event: Event): Theme {
  const detail = (event as CustomEvent<unknown>).detail;
  if (detail === 'light' || detail === 'dark') return detail;
  return currentTheme();
}

function tokenCount(event: Event): number {
  const detail = (event as CustomEvent<unknown>).detail;
  return typeof detail === 'number' && Number.isFinite(detail) ? detail : 1;
}
