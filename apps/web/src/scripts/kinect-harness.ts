/**
 * The kinect harness (pages/dev/kinect.astro, development only). Mounts a being on the page's own canvas, then
 * swaps the cloud's depth source between the being itself, a live Kinect over Kinectron and a depth video, and
 * binds the selectors and sliders to the look, the shatter, the cloud's mode and its knobs. The Kinectron browser client is loaded from /dev/kinectron-client.js on
 * this origin, only when asked, so no bundle ever carries a line of it; a missing file ends in a status line.
 * Nothing here is imported by the site, and the runtime arrives through the same dynamic import() as on the home
 * page, so the production chunks are untouched.
 */
import type { BeingHandle, KinectMode, Look } from '@emersa/being';
import type { DepthSource, KinectronClient, KinectronKinectType } from '@emersa/being/depth';

type BeingModule = typeof import('@emersa/being');
type DepthModule = typeof import('@emersa/being/depth');
type Theme = 'dark' | 'light';
type KinectronConstructor = new (config: string | { host: string; port: number }) => KinectronClient;

const CLIENT_SRC = '/dev/kinectron-client.js';
const STATS_INTERVAL_MS = 500;
const TOKEN_WINDOW_MS = 2000;
const HEALTH_URL = '/api/health';
/** The point count on the HUD, with thousands separators (76,800). */
const POINTS_FORMAT = new Intl.NumberFormat('en-GB');
const LOOKS: readonly Look[] = ['kinect-demo', 'face', 'hybrid', 'kinect', 'wire'];
const MODES: readonly KinectMode[] = ['points', 'wire', 'mesh', 'shards'];
/** The look the being starts in, which is also the first option of the Look selector. */
const START_LOOK: Look = 'kinect-demo';

const root = document.querySelector<HTMLElement>('[data-kinect-harness]');
if (root && root.dataset.mounted === undefined) {
  root.dataset.mounted = 'true';
  void mount(root);
}

async function mount(host: HTMLElement): Promise<void> {
  const canvas = host.querySelector('[data-harness-canvas]');
  const form = host.querySelector<HTMLFormElement>('[data-harness-form]');
  const status = host.querySelector<HTMLElement>('[data-harness-status]');
  const statsOut = host.querySelector<HTMLElement>('[data-harness-stats]');
  if (!(canvas instanceof HTMLCanvasElement) || !form) return;
  const say = (text: string): void => {
    if (status && status.textContent !== text) status.textContent = text;
  };
  form.addEventListener('submit', (event) => event.preventDefault());

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    say('Reduced motion is on, so the being does not render here.');
    return;
  }
  let being: BeingModule;
  let depth: DepthModule;
  try {
    // The video and Kinectron sources are dev-only inputs, exported from the depth subpath alone.
    [being, depth] = await Promise.all([import('@emersa/being'), import('@emersa/being/depth')]);
  } catch {
    say('The being runtime failed to load.');
    return;
  }
  const caps = being.detectCapabilities();
  if (!caps.webgl2) {
    say('WebGL2 is not available in this browser.');
    return;
  }
  const full = host.dataset.assetUrl ?? '';
  const lite = host.dataset.assetLiteUrl ?? '';
  const assetUrl = caps.touch || caps.lowEnd ? lite || full : full || lite;
  if (!assetUrl) {
    say('No avatar file was found; run the avatar pipeline first.');
    return;
  }
  const desktop = caps.hoverFine && !caps.touch;
  const handle: BeingHandle = being.createBeing({
    canvas,
    assetUrl,
    theme: currentTheme(),
    quality: caps.suggestedQuality,
    bloom: desktop,
    look: START_LOOK,
    ribbon: desktop,
    reflection: desktop,
    reducedMotion: false,
    maxPixelRatio: caps.maxPixelRatio,
    onReady: () => say('Being ready. Its own depth feeds the cloud.'),
    onError: () => say('The being failed to load.'),
    onContextLost: () => say('The WebGL context was lost; reload the page.'),
  });
  try {
    await handle.ready;
  } catch {
    return;
  }
  document.addEventListener('em:theme', (event) => handle.setTheme(themeFromEvent(event)));

  // The harness owns the external sources: the being only reads them, so the one replaced is disposed here.
  let source: DepthSource | null = null;
  let sourceLabel = 'being';
  let videoUrl: string | null = null;
  const use = (next: DepthSource | null, label: string): void => {
    handle.setDepthSource(next);
    source?.dispose();
    source = next;
    sourceLabel = label;
  };

  const clipping = { near: 0.85, far: 4 };
  const applyClipping = (): void => {
    if (!(clipping.far > clipping.near)) return;
    handle.kinect.setClipping(clipping.near, clipping.far);
    source?.setClipping?.(clipping.near, clipping.far);
  };

  const connect = host.querySelector<HTMLButtonElement>('[data-harness-connect]');
  connect?.addEventListener('click', async () => {
    const data = new FormData(form);
    const kinectHost = String(data.get('host') ?? '').trim();
    if (!kinectHost) {
      say('Enter the Kinectron host first.');
      return;
    }
    const port = Number(data.get('port'));
    const kinectType: KinectronKinectType = data.get('kinectType') === 'windows' ? 'windows' : 'azure';
    const feed = data.get('feed') === 'rawDepth' ? 'rawDepth' : 'depth';
    connect.disabled = true;
    say(`Loading ${CLIENT_SRC}.`);
    const Kinectron = await loadClient();
    connect.disabled = false;
    if (!Kinectron) {
      say(
        `${CLIENT_SRC} is not served. Put the Kinectron browser client there; apps/web/public/dev/README.md says how.`,
      );
      return;
    }
    let client: KinectronClient;
    try {
      client = new Kinectron(port > 0 ? { host: kinectHost, port } : kinectHost);
    } catch (error) {
      say(`The Kinectron client could not be created: ${String(error)}`);
      return;
    }
    const address = port > 0 ? `${kinectHost}:${port}` : kinectHost;
    use(
      new depth.KinectronDepthSource({
        host: kinectHost,
        port: port > 0 ? port : undefined,
        feed,
        kinectType,
        client,
        near: clipping.near,
        far: clipping.far,
      }),
      `kinectron ${address}`,
    );
    say(`Connecting to ${address} (${kinectType}, ${feed}). The cloud appears once frames arrive.`);
  });

  host.querySelector<HTMLButtonElement>('[data-harness-being]')?.addEventListener('click', () => {
    use(null, 'being');
    say("The being's own depth feeds the cloud.");
  });

  const video = host.querySelector<HTMLInputElement>('[data-harness-video]');
  video?.addEventListener('change', () => {
    const file = video.files?.[0];
    if (!file) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(file);
    const next = new depth.VideoDepthSource(videoUrl);
    // The change event is the gesture; a browser that still refuses autoplay says so instead of showing nothing.
    void next.play().catch(() => say('The browser refused to play the video; choose the file again.'));
    use(next, `video ${file.name}`);
    say(`Playing ${file.name} as depth: white is near, black is far.`);
  });

  const look = host.querySelector<HTMLSelectElement>('[data-harness-look]');
  look?.addEventListener('change', () => {
    const next = look.value;
    if (LOOKS.includes(next as Look)) handle.setLook(next as Look);
  });
  bindRange(host, 'shatter', 2, (value) => handle.setShatter(value));

  const mode = host.querySelector<HTMLSelectElement>('[data-harness-mode]');
  mode?.addEventListener('change', () => {
    const next = mode.value;
    if (MODES.includes(next as KinectMode)) handle.kinect.setMode(next as KinectMode);
  });
  // Three-Kinectron's knobs, at the runtime's defaults until a slider moves.
  bindRange(host, 'displacement', 2, (value) => handle.kinect.setDisplacement(value));
  bindRange(host, 'brightness', 2, (value) => handle.kinect.setBrightness(value));
  bindRange(host, 'contrast', 2, (value) => handle.kinect.setContrast(value));
  bindRange(host, 'opacity', 2, (value) => handle.kinect.setOpacity(value));
  bindRange(host, 'line-width', 1, (value) => handle.kinect.setLineWidth(value));

  bindRange(host, 'near', 2, (value) => {
    clipping.near = value;
    applyClipping();
  });
  bindRange(host, 'far', 2, (value) => {
    clipping.far = value;
    applyClipping();
  });
  bindRange(host, 'size', 1, (value) => handle.kinect.setPointSize(value));
  // The z offset keeps the source kind's default (0 for the being, 2 m for a sensor) until the slider moves.
  bindRange(host, 'z', 2, (value) => handle.kinect.setZOffset(value));

  // The engineering readouts (Hud.astro) live on this page only: the home page carries no instrument plate.
  const hud = host.querySelector<HTMLElement>('[data-hud]');
  const readout = (name: string): Element | null => hud?.querySelector(`[data-hud-${name}]`) ?? null;
  const fpsOut = readout('fps');
  const depthOut = readout('depth');
  const pointsOut = readout('points');
  const modeOut = readout('mode');
  startTokenMeter(readout('tokens'));
  void fillColo(readout('colo'));
  if (statsOut || hud) {
    setInterval(() => {
      if (document.hidden) return;
      const stats = handle.stats();
      const frames = source ? (source.ready ? 'frames arriving' : 'no frames yet') : 'own depth';
      const text = [
        `${Math.round(stats.fps)} fps`,
        `${stats.points} pts`,
        `${stats.depth.near.toFixed(2)} to ${stats.depth.far.toFixed(2)} m`,
        stats.quality,
        stats.look,
        stats.mode,
        `${sourceLabel} (${frames})`,
      ].join(' · ');
      if (statsOut && statsOut.textContent !== text) statsOut.textContent = text;
      // The cloud's readouts show only while it draws; a blank one is hidden by the component's own style.
      const drawing = stats.points > 0;
      setText(fpsOut, String(Math.round(stats.fps)));
      setText(depthOut, drawing ? `${stats.depth.near.toFixed(2)} to ${stats.depth.far.toFixed(2)} m` : '');
      setText(pointsOut, drawing ? POINTS_FORMAT.format(stats.points) : '');
      setText(modeOut, drawing ? stats.mode : '');
    }, STATS_INTERVAL_MS);
  }
}

function setText(element: Element | null, text: string): void {
  if (element && element.textContent !== text) element.textContent = text;
}

/** Tokens per second over the last two seconds, from the em:tokens events the captions and the cloud emit. */
function startTokenMeter(out: Element | null): void {
  if (!out) return;
  const arrivals: [at: number, count: number][] = [];
  document.addEventListener('em:tokens', (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    arrivals.push([performance.now(), typeof detail === 'number' && Number.isFinite(detail) ? detail : 1]);
  });
  setInterval(() => {
    const cutoff = performance.now() - TOKEN_WINDOW_MS;
    while (arrivals.length > 0 && (arrivals[0]?.[0] ?? Infinity) < cutoff) arrivals.shift();
    const perSecond = arrivals.reduce((sum, [, count]) => sum + count, 0) / (TOKEN_WINDOW_MS / 1000);
    setText(out, String(Math.round(perSecond)));
  }, STATS_INTERVAL_MS);
}

/** The edge colo from /api/health, fetched once per session (sessionStorage em-colo, listed on /privacy). */
async function fillColo(out: Element | null): Promise<void> {
  if (!out) return;
  try {
    const cached = sessionStorage.getItem('em-colo');
    if (cached) {
      setText(out, cached);
      return;
    }
    const response = await fetch(HEALTH_URL, { headers: { accept: 'application/json' } });
    if (!response.ok) return;
    const json: unknown = await response.json();
    const colo = json && typeof json === 'object' ? (json as Record<string, unknown>).colo : undefined;
    if (typeof colo !== 'string' || !/^[A-Z]{3}$/.test(colo)) return;
    setText(out, colo);
    sessionStorage.setItem('em-colo', colo);
  } catch {
    // The readout stays blank: storage may be unavailable and health is optional.
  }
}

/** A range input and its output: the value is shown as it moves and handed on. */
function bindRange(host: HTMLElement, name: string, digits: number, onInput: (value: number) => void): void {
  const input = host.querySelector<HTMLInputElement>(`[data-harness-${name}]`);
  const out = host.querySelector<HTMLElement>(`[data-harness-${name}-out]`);
  if (!input) return;
  input.addEventListener('input', () => {
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    if (out) out.textContent = value.toFixed(digits);
    onInput(value);
  });
}

let clientLoading: Promise<KinectronConstructor | null> | null = null;

/** The Kinectron constructor: already on the page, or loaded once from this origin; null when the file is absent. */
function loadClient(): Promise<KinectronConstructor | null> {
  const existing = (globalThis as { Kinectron?: unknown }).Kinectron;
  if (typeof existing === 'function') return Promise.resolve(existing as KinectronConstructor);
  clientLoading ??= new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = CLIENT_SRC;
    script.async = true;
    script.addEventListener('load', () => {
      const ctor = (globalThis as { Kinectron?: unknown }).Kinectron;
      resolve(typeof ctor === 'function' ? (ctor as KinectronConstructor) : null);
    });
    script.addEventListener('error', () => {
      clientLoading = null;
      script.remove();
      resolve(null);
    });
    document.head.append(script);
  });
  return clientLoading;
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function themeFromEvent(event: Event): Theme {
  const detail = (event as CustomEvent<unknown>).detail;
  if (detail === 'light' || detail === 'dark') return detail;
  return currentTheme();
}
