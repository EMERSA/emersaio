/**
 * Mounts the being on documents whose <main data-being> asks for it. Three.js loads only when the device can carry
 * it: after the LCP and an idle moment on hover-capable desktops, on the first tap elsewhere, never under reduced
 * motion or without WebGL2. Every other path keeps the poster and runs the tour with captions alone, and no failure
 * here is allowed to escape: each one ends in that captions-only mode, or, when not even the tour could be built,
 * in the transcript that "Start the tour" points at without JavaScript.
 */
import type { BeingHandle, BeingOptions, Capabilities, SpeakRequest, TourScript } from '@emersa/being';
import { primeAudio } from '@emersa/being/audio';
import type { PageAdapter, TourController, TourState } from '@emersa/being/tour';
import type { TourUi, VoiceAbsence } from './tour-ui.ts';

type Mode = 'tour' | 'talk';
type Theme = 'dark' | 'light';
type TourModule = typeof import('@emersa/being/tour');

interface Elements {
  stage: HTMLElement;
  canvas: HTMLCanvasElement | null;
  dock: HTMLElement | null;
  captions: HTMLElement | null;
  /** The "AI-generated voice" line in the dock, shown while the being speaks. */
  voiceLabel: HTMLElement | null;
  bar: HTMLElement | null;
  notice: HTMLElement | null;
  startButtons: HTMLElement[];
  talkSheet: HTMLDialogElement | null;
}

interface Device {
  reducedMotion: boolean;
  hoverFine: boolean;
  saveData: boolean;
  lowEnd: boolean;
}

interface Mount {
  mode: Mode;
  el: Elements;
  device: Device;
  being: BeingHandle | null;
  loading: Promise<BeingHandle | null> | null;
  /** The tour started without the being; one that arrives afterwards is disposed rather than shown mute. */
  abandoned: boolean;
  /** The being's WebGL context went away; the poster stays whatever the quality ladder reports afterwards. */
  contextLost: boolean;
  /** Why the tour has no voice, once that is known; the notice under the controls picks its sentence from it. */
  noVoice: VoiceAbsence | null;
  tour: TourController | null;
  tourModule: TourModule | null;
  script: TourScript | null;
  ui: TourUi | null;
  state: TourState | null;
  /** A stop id from ?tour=, consumed by the first start. Empty string means "from the beginning". */
  pendingStop: string | null;
  starting: Promise<void> | null;
}

const LCP_TIMEOUT_MS = 2500;
const IDLE_TIMEOUT_MS = 1500;
const BEING_WAIT_MS = 12000;
const SCROLL_WAIT_MS = 900;
const CAPTION_CPS = 14;
/** How often the dock checks whether voice is playing, for the "AI-generated voice" line. */
const VOICE_INTERVAL_MS = 250;
/** A tour left unfinished within this window resumes from its bookmark. */
const RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Pages without a stop of their own link to the nearest one. */
const STOP_ALIASES: Record<string, string> = { docs: 'technology', games: 'studio' };

const mainElement = document.querySelector<HTMLElement>('main[data-being]');
const mode = mainElement?.dataset.being;
const stageElement = document.querySelector<HTMLElement>('[data-being-stage]');
if ((mode === 'tour' || mode === 'talk') && stageElement && stageElement.dataset.mounted === undefined) {
  stageElement.dataset.mounted = 'true';
  try {
    mount(mode, stageElement);
  } catch {
    stageElement.classList.add('is-fallback');
  }
}

function mount(activeMode: Mode, stage: HTMLElement): void {
  const m: Mount = {
    mode: activeMode,
    el: collectElements(stage),
    device: probeDevice(),
    being: null,
    loading: null,
    abandoned: false,
    contextLost: false,
    noVoice: null,
    tour: null,
    tourModule: null,
    script: null,
    ui: null,
    state: null,
    pendingStop: requestedStop(),
    starting: null,
  };

  if (m.el.dock) publishDockHeight(m.el.dock);

  // The tour can run from the poster alone, so the start button works before any heavy code arrives.
  for (const button of m.el.startButtons) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      primeVoice(m);
      void beginTour(m).then(() => {
        if (!m.tour) showTranscript(m, button);
      });
    });
  }
  stage.addEventListener('click', () => {
    if (!m.loading && !m.device.reducedMotion) void loadBeing(m);
  });
  document.addEventListener('keydown', (event) => onKey(m, event));

  if (m.device.reducedMotion) {
    m.noVoice = 'still';
    setFallback(m);
    if (m.pendingStop !== null) {
      void beginTour(m).then(() => {
        if (!m.tour) showTranscript(m, null);
      });
    }
    return;
  }
  if (m.device.hoverFine && !m.device.lowEnd && !m.device.saveData) {
    void afterLcp()
      .then(whenIdle)
      .then(() => loadBeing(m))
      .then(() => {
        if (m.pendingStop === null) return;
        return beginTour(m).then(() => {
          if (!m.tour) showTranscript(m, null);
        });
      });
    return;
  }
  // Touch and weak devices keep the poster until the first tap, which also serves as the audio gesture. A deep link
  // keeps its stop for that tap and puts the control that starts it in front of the visitor.
  if (m.pendingStop !== null) m.el.startButtons[0]?.focus();
}

function collectElements(stage: HTMLElement): Elements {
  const canvas = stage.querySelector('[data-being-canvas]');
  const talkSheet = document.querySelector('[data-talk-sheet]');
  return {
    stage,
    canvas: canvas instanceof HTMLCanvasElement ? canvas : null,
    dock: document.querySelector<HTMLElement>('[data-being-dock]'),
    captions: document.querySelector<HTMLElement>('[data-captions]'),
    voiceLabel: document.querySelector<HTMLElement>('[data-voice-label]'),
    bar: document.querySelector<HTMLElement>('[data-tour]'),
    notice: document.querySelector<HTMLElement>('[data-tour-notice]'),
    startButtons: Array.from(document.querySelectorAll<HTMLElement>('[data-tour-start]')),
    talkSheet: talkSheet instanceof HTMLDialogElement ? talkSheet : null,
  };
}

/** A cheap look at the device, taken before any import so three is never fetched just to decide against it. */
function probeDevice(): Device {
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
  return {
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    hoverFine: matchMedia('(hover: hover) and (pointer: fine)').matches,
    saveData: nav.connection?.saveData === true,
    lowEnd: (nav.hardwareConcurrency || 4) <= 2 || (nav.deviceMemory ?? 4) <= 2,
  };
}

function requestedStop(): string | null {
  return new URLSearchParams(window.location.search).get('tour');
}

/**
 * While the dock is pinned, the page keeps that much room at its foot (hud.css reads --dock-h), so the end of the
 * page and anything focus scrolls to the bottom edge can still come out from under it. A custom property set
 * through the CSSOM is not an inline style, so the Content-Security-Policy is kept.
 */
function publishDockHeight(dock: HTMLElement): void {
  if (typeof ResizeObserver !== 'function') return;
  const observer = new ResizeObserver((entries) => {
    const box = entries[0]?.borderBoxSize?.[0];
    const height = box ? box.blockSize : dock.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--dock-h', `${Math.ceil(height)}px`);
  });
  observer.observe(dock);
}

/* Audio ------------------------------------------------------------------------------------------------------ */

/**
 * Runs inside the Start tap or the key press, before any await. iOS Safari lets a page make sound only through an
 * AudioContext and a media element that were started inside a gesture, and the tour's first line arrives seconds
 * later, after the chunks, the script and the scroll. primeAudio (the runtime's audioUnlock.ts) creates and resumes
 * the page's one shared context and plays its shared clip element once, inside the gesture: the very objects the
 * being adopts for the clips. Nothing to prime under reduced motion: no being, no clips.
 */
function primeVoice(m: Mount): void {
  if (m.device.reducedMotion) return;
  primeAudio();
}

/* Loading the being ------------------------------------------------------------------------------------------ */

function loadBeing(m: Mount): Promise<BeingHandle | null> {
  if (m.loading) return m.loading;
  m.loading = (async (): Promise<BeingHandle | null> => {
    const { stage, canvas } = m.el;
    if (!canvas) return fail(m, 'still');
    stage.classList.add('is-loading');
    let handle: BeingHandle | null = null;
    try {
      const being = await import('@emersa/being');
      const caps = being.detectCapabilities();
      if (!caps.webgl2 || caps.reducedMotion) return fail(m, 'still');
      const assetUrl = pickAsset(stage, caps);
      if (!assetUrl) return fail(m, 'still');
      // The look is the face: the head alone, large, as wire over its own depth cloud, assembling from pieces on
      // its first frame (at most 1.2 s). Nothing else: no bloom pass, no ribbon, no mirrored floor and no data
      // ring (the shared contract in docs/research/minimal-brief.md); the fan's anchors are the runtime's own.
      const options: BeingOptions & { ring?: boolean } = {
        canvas,
        assetUrl,
        theme: currentTheme(),
        quality: caps.suggestedQuality,
        bloom: false,
        look: 'face',
        intro: true,
        ribbon: false,
        reflection: false,
        ring: false,
        reducedMotion: false,
        maxPixelRatio: caps.maxPixelRatio,
        onReady: () => {
          // A being that arrives after the tour gave it up, or after its context was lost, is disposed below;
          // showing it first would dissolve the hero cloud and fade in a canvas that goes straight back to the poster.
          if (m.abandoned || m.contextLost) return;
          stage.classList.remove('is-loading', 'is-fallback');
          stage.classList.add('is-ready');
          document.dispatchEvent(new CustomEvent('em:being-ready'));
        },
        onError: () => fail(m, 'connection'),
        onContextLost: () => {
          m.contextLost = true;
          fail(m, 'connection');
        },
      };
      handle = being.createBeing(options);
      await handle.ready;
      if (m.abandoned || m.contextLost) {
        handle.dispose();
        return fail(m, 'connection');
      }
      // The handle read the theme once when it was made; a switch during the download would otherwise be lost.
      handle.setTheme(currentTheme());
      m.being = handle;
      wireBeing(m, handle);
      return handle;
    } catch {
      // A failed load must not leave a WebGL context, observers and listeners behind on the canvas.
      handle?.dispose();
      return fail(m, 'connection');
    }
  })();
  return m.loading;
}

function pickAsset(stage: HTMLElement, caps: Capabilities): string {
  const full = stage.dataset.assetUrl ?? '';
  const lite = stage.dataset.assetLiteUrl ?? '';
  const preferLite =
    caps.touch || caps.lowEnd || caps.suggestedQuality === 'lite' || caps.suggestedQuality === 'poster';
  return preferLite ? lite || full : full || lite;
}

function wireBeing(m: Mount, being: BeingHandle): void {
  const { stage } = m.el;
  document.addEventListener('em:theme', (event) => being.setTheme(themeFromEvent(event)));
  stage.addEventListener(
    'pointermove',
    (event) => {
      const r = stage.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      being.lookAt(((event.clientX - r.left) / r.width) * 2 - 1, 1 - ((event.clientY - r.top) / r.height) * 2);
    },
    { passive: true },
  );
  // The quality ladder's last rung is the poster: the shell shows it, and brings the canvas back if the tier recovers.
  stage.addEventListener('em:quality', (event) => {
    const quality = (event as CustomEvent<unknown>).detail;
    if (quality === 'poster') {
      setFallback(m);
    } else if (m.being === being && !m.contextLost && stage.classList.contains('is-fallback')) {
      stage.classList.remove('is-fallback');
      stage.classList.add('is-ready');
    }
  });
  // The fan is decoration: a runtime without it must never cost the being. Its anchors are fixed by the runtime
  // (4 nodes at the right edge, desktop with a fine pointer only); the shell hands it no DOM targets.
  try {
    being.fan.setEnabled(true);
  } catch {
    // The head renders without its data lines.
  }
  watchVoice(m, being);
}

/**
 * The "AI-generated voice" disclosure in the dock: shown whenever voice plays. The runtime's isSpeaking() decides
 * where it exists; an older runtime falls back to the caption adapter's speaking state on the stage.
 */
function watchVoice(m: Mount, being: BeingHandle): void {
  const label = m.el.voiceLabel;
  if (!label) return;
  const handle = being as BeingHandle & { isSpeaking?: () => boolean };
  setInterval(() => {
    if (document.hidden || m.being !== being) return;
    let speaking = false;
    try {
      speaking =
        typeof handle.isSpeaking === 'function' ? handle.isSpeaking() : m.el.stage.classList.contains('is-speaking');
    } catch {
      speaking = false;
    }
    const touring = document.documentElement.classList.contains('is-touring');
    const show = speaking && touring;
    if (label.hidden === show) label.hidden = !show;
  }, VOICE_INTERVAL_MS);
}

function fail(m: Mount, reason: VoiceAbsence): null {
  m.noVoice ??= reason;
  setFallback(m);
  return null;
}

function setFallback(m: Mount): void {
  m.el.stage.classList.remove('is-loading', 'is-ready');
  m.el.stage.classList.add('is-fallback');
}

/* The tour --------------------------------------------------------------------------------------------------- */

function beginTour(m: Mount): Promise<void> {
  if (m.starting) return m.starting;
  if (m.tour) {
    const status = m.state?.status;
    if (status && status !== 'idle' && status !== 'ended') {
      m.el.bar?.focus({ preventScroll: true });
      return Promise.resolve();
    }
    const from = m.script && m.tourModule ? resolveStop(m.script, storedStop(m.tourModule)) : undefined;
    return m.tour.start(from).catch(() => setFallback(m));
  }
  m.starting = (async (): Promise<void> => {
    // The dock pins to the viewport inside the Start tap, before any chunk is fetched: the switch then lands within
    // the input window instead of seconds later as a layout shift. The bar shows as a loading state, every button
    // disabled, until the tour binds them.
    setTouring(m, true);
    try {
      // On a tap the being is still arriving; the tour waits for it so the first line is spoken, not just shown.
      const loading = m.device.reducedMotion ? Promise.resolve(null) : loadBeing(m);
      const tourModule = await import('@emersa/being/tour');
      const [being, script, uiModule] = await Promise.all([
        withTimeout(loading, BEING_WAIT_MS, null).then((handle) => {
          // Decided the moment the wait is over, not once the other chunks are in: a being that lands in between
          // would otherwise be wired and shown beside a captions-only tour, mute.
          if (!handle) {
            m.abandoned = true;
            m.noVoice ??= 'connection';
          }
          return handle;
        }),
        tourModule.loadTourScript(),
        import('./tour-ui.ts'),
      ]);
      const active = being ?? createCaptionBeing();
      const ui = m.el.bar
        ? uiModule.createTourUi({
            bar: m.el.bar,
            notice: m.el.notice,
            startButtons: m.el.startButtons,
            captionsOnly: !being,
            voiceAbsence: m.noVoice,
          })
        : null;
      const tour = tourModule.createTour({
        script,
        being: active,
        adapter: createAdapter(m, active),
        // A hidden tab waits at its stop, so a visitor who switches away misses no line; under reduced motion every
        // stop waits for Next, ArrowRight or Space instead of a timer.
        isInteracting: () => document.hidden || m.device.reducedMotion,
        onState: (state) => {
          m.state = state;
          ui?.update(state);
        },
      });
      ui?.bind(tour);
      m.tour = tour;
      m.tourModule = tourModule;
      m.script = script;
      m.ui = ui;
      const from = resolveStop(script, m.pendingStop ?? storedStop(tourModule));
      m.pendingStop = null;
      await tour.start(from);
    } catch {
      // No tour could be built or started (a chunk or the script failed to load): the dock goes back into the hero,
      // and a being that already rendered stays as it is; only a page without one falls back to the poster.
      if (m.tour) {
        try {
          m.tour.stop();
        } catch {
          setTouring(m, false);
        }
      } else {
        setTouring(m, false);
      }
      if (!m.being) setFallback(m);
    } finally {
      m.starting = null;
    }
  })();
  return m.starting;
}

/** The pinned-dock state, which tour-ui.ts also sets from the tour's own state; adding a class twice is harmless. */
function setTouring(m: Mount, on: boolean): void {
  document.documentElement.classList.toggle('is-touring', on);
  const bar = m.el.bar;
  if (!bar) return;
  if (on) {
    for (const button of bar.querySelectorAll('button')) button.disabled = true;
    bar.hidden = false;
  } else {
    bar.hidden = true;
  }
}

/**
 * What "Start the tour" does without JavaScript, for the visitor whose tour could not be built: the transcript
 * opens, the page goes to it (through the link's own hash where that still scrolls) and its summary takes the focus.
 */
function showTranscript(m: Mount, link: HTMLElement | null): void {
  const details = document.querySelector<HTMLDetailsElement>('[data-tour-transcript]');
  if (!details) return;
  details.open = true;
  const hash = link instanceof HTMLAnchorElement ? link.hash : '';
  const section = details.closest('section') ?? details;
  if (hash && window.location.hash !== hash) window.location.hash = hash;
  else section.scrollIntoView({ block: 'start', behavior: m.device.reducedMotion ? 'auto' : 'smooth' });
  details.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
}

/** The bookmark of a tour left unfinished recently; a finished tour has none and starts from the beginning. */
function storedStop(tour: TourModule): string | null {
  try {
    const progress = tour.parseProgress(localStorage.getItem(tour.TOUR_STORAGE_KEY));
    return progress && Date.now() - progress.at < RESUME_MAX_AGE_MS ? progress.stopId : null;
  } catch {
    return null;
  }
}

function resolveStop(script: TourScript, requested: string | null): string | undefined {
  if (!requested) return undefined;
  const id = STOP_ALIASES[requested] ?? requested;
  return script.stops.some((stop) => stop.id === id) ? id : undefined;
}

function createAdapter(m: Mount, being: BeingHandle): PageAdapter {
  let highlighted: Element | null = null;
  const adapter: PageAdapter = {
    scrollTo: (selector) => scrollToSelector(selector, m.device.reducedMotion),
    highlight(selector) {
      highlighted?.classList.remove('is-highlighted');
      highlighted = selector ? safeQuery(selector) : null;
      highlighted?.classList.add('is-highlighted');
    },
    caption(text, done) {
      const captions = m.el.captions;
      if (captions) {
        // Revealed characters are the Phase 1 token stream: the hero cloud sparkles from them.
        const previous = captions.textContent ?? '';
        const added = text.startsWith(previous) ? text.length - previous.length : text.length;
        if (added > 0) emitTokens(added);
        setText(captions, text);
        captions.setAttribute('aria-busy', String(!done));
        // The docked bubble is a fixed box that scrolls; the newest words stay in view as they arrive.
        if (captions.scrollHeight > captions.clientHeight) captions.scrollTop = captions.scrollHeight;
      }
      m.el.stage.classList.toggle('is-speaking', !done);
    },
    dispatch(action) {
      switch (action.type) {
        case 'goto':
          void adapter.scrollTo(action.target);
          break;
        case 'highlight':
          adapter.highlight(action.target);
          break;
        case 'point':
        case 'emote':
          being.pose(action);
          break;
        case 'open':
          openTalk(m);
          break;
      }
    },
  };
  return adapter;
}

/** Scrolls to the target and resolves once it is in the middle band of the viewport, or after a short wait. */
function scrollToSelector(selector: string, reducedMotion: boolean): Promise<void> {
  const target = safeQuery(selector);
  if (!target) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) finish();
      },
      { rootMargin: '-25% 0px -25% 0px' },
    );
    const timer = setTimeout(() => finish(), SCROLL_WAIT_MS);
    const finish = (): void => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    observer.observe(target);
    window.scrollTo({ top: scrollTargetTop(target), behavior: reducedMotion ? 'auto' : 'smooth' });
  });
}

/** The scroll position that puts the target just under the sticky header, honouring any scroll margin it sets. */
function scrollTargetTop(target: Element): number {
  const headerHeight =
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 0;
  const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
  const offset = Math.max(headerHeight + 16, margin);
  return Math.max(0, target.getBoundingClientRect().top + window.scrollY - offset);
}

function openTalk(m: Mount): void {
  const sheet = m.el.talkSheet;
  if (!sheet || sheet.hidden || sheet.open) return;
  try {
    sheet.showModal();
  } catch {
    // Phase 1 has nothing behind the sheet; a browser without <dialog> support simply keeps it closed.
  }
}

function onKey(m: Mount, event: KeyboardEvent): void {
  const { tour, state } = m;
  if (!tour || !state || state.status === 'idle' || state.status === 'ended') return;
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  if (target instanceof HTMLElement) {
    if (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName)) return;
    if (target.closest('dialog[open]')) return;
  }
  // Printable single-key shortcuts work only while the tour's own controls have the focus (SC 2.1.4); the arrow
  // keys and Escape, which no speech-input user utters by accident, work from anywhere on the page.
  const inDock = target instanceof Element && target.closest('[data-tour], [data-being-dock]') !== null;
  try {
    switch (event.key) {
      case 'ArrowRight':
        primeVoice(m);
        tour.next();
        break;
      case ' ':
        // A focused button or link keeps its own activation; Space advances only from the dock itself.
        if (!inDock) return;
        if (target instanceof HTMLElement && /^(button|a|summary)$/i.test(target.tagName)) return;
        primeVoice(m);
        tour.next();
        break;
      case 'ArrowLeft':
        primeVoice(m);
        tour.back();
        break;
      case 'm':
      case 'M':
        if (!inDock) return;
        primeVoice(m);
        tour.setMuted(!state.muted);
        break;
      case 'Escape':
        tour.stop();
        break;
      default:
        return;
    }
  } catch {
    return;
  }
  event.preventDefault();
}

/* Captions-only being ---------------------------------------------------------------------------------------- */

/**
 * A BeingHandle with no mesh: a typewriter at reading pace that times the captions and nothing else. Every other
 * member of the contract is here as a no-op, so the tour can drive it exactly as it drives the rendered being.
 */
function createCaptionBeing(): BeingHandle {
  let cancel: (() => void) | null = null;
  const stopSpeaking = (): void => {
    cancel?.();
    cancel = null;
  };
  const noop = (): void => undefined;
  return {
    ready: Promise.resolve(),
    speak(request: SpeakRequest): Promise<void> {
      stopSpeaking();
      return new Promise<void>((resolve) => {
        const text = request.text;
        const startedAt = performance.now();
        let shown = 0;
        let raf = 0;
        const end = (complete: boolean): void => {
          if (raf !== 0) cancelAnimationFrame(raf);
          raf = 0;
          cancel = null;
          request.signal?.removeEventListener('abort', onAbort);
          request.onCaption?.(complete ? text : text.slice(0, shown), true);
          resolve();
        };
        const onAbort = (): void => end(false);
        const tick = (now: number): void => {
          const revealed = Math.min(text.length, Math.floor(((now - startedAt) / 1000) * CAPTION_CPS));
          if (revealed > shown) {
            shown = revealed;
            request.onCaption?.(text.slice(0, shown), false);
          }
          if (shown >= text.length) {
            end(true);
            return;
          }
          raf = requestAnimationFrame(tick);
        };
        if (request.signal?.aborted) {
          end(false);
          return;
        }
        request.signal?.addEventListener('abort', onAbort, { once: true });
        cancel = () => end(false);
        raf = requestAnimationFrame(tick);
      });
    },
    stopSpeaking,
    isSpeaking: () => false,
    setTheme: noop,
    setQuality: noop,
    getQuality: () => 'poster',
    setAudioLevel: noop,
    tokens: (n) => emitTokens(n),
    pose: noop,
    lookAt: noop,
    setListening: noop,
    setLook: noop,
    getLook: () => 'wire',
    setShatter: noop,
    fan: { setTargets: noop, setActivity: noop, setEnabled: noop },
    setDepthSource: noop,
    kinect: {
      setClipping: noop,
      setPointSize: noop,
      setZOffset: noop,
      setMode: noop,
      setDisplacement: noop,
      setBrightness: noop,
      setContrast: noop,
      setOpacity: noop,
      setLineWidth: noop,
    },
    stats: () => ({
      fps: 0,
      drawCalls: 0,
      triangles: 0,
      quality: 'poster',
      points: 0,
      depth: { near: 0, far: 0 },
      look: 'wire',
      mode: 'points',
    }),
    dispose: stopSpeaking,
  };
}

/* Helpers ---------------------------------------------------------------------------------------------------- */

function setText(element: Element | null | undefined, text: string): void {
  if (element && element.textContent !== text) element.textContent = text;
}

function emitTokens(n: number): void {
  if (n > 0) document.dispatchEvent(new CustomEvent('em:tokens', { detail: n }));
}

function safeQuery(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function themeFromEvent(event: Event): Theme {
  const detail = (event as CustomEvent<unknown>).detail;
  if (detail === 'light' || detail === 'dark') return detail;
  return currentTheme();
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
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
