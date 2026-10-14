/**
 * The Talk shell, loaded by talk-boot.ts when the monitor first opens. It owns the consent view, the optional
 * Turnstile widget, the session mint (POST /api/talk/session), the message log, the typed prompt, the Speak button
 * (push to talk: the microphone is open only while it is held), file upload, the memory panel with Forget me, and
 * End. The voice itself, and every Convai byte, arrives with the dynamic import of @emersa/being/talk after the
 * visitor taps Start talking.
 *
 * Every dynamic string goes through textContent. No secret ever reaches this file: the Worker mints a one-hour
 * Convai token per session and the visitor cookie is HttpOnly.
 */
import { primeAudio } from '@emersa/being/audio';
import { site } from '../data/site.ts';

const copy = site.talk;

/** The exact Turnstile URL the CSP allows. Added to the document only when the monitor opens with a site key. */
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const TURNSTILE_WAIT_MS = 15000;
/** The consent text version the Worker records with the visitor row. Bump it when the consent copy changes. */
export const CONSENT_VERSION = 2;
const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const UPLOAD_TYPES = /\.(pdf|txt|md)$/i;
/** The Worker keeps 20,000 characters of a document; the session hands Emily the first 6,000 of them. */
const DOCUMENT_MAX_CHARS = 20000;

type Notice = keyof typeof copy.notices;
type TalkModule = typeof import('@emersa/being/talk');
type TalkSession = InstanceType<TalkModule['TalkSession']>;
type TalkState = TalkSession['state'];
type Speaker = 'user' | 'being';
type TalkBeing = Parameters<TalkModule['TalkSession']['start']>[0]['being'];

/** The runtime's notices, in the shell's words (site.ts). */
const RUNTIME_NOTICES: Record<string, Notice> = {
  busy: 'busy',
  cap: 'timeUp',
  'mic-denied': 'micDenied',
  reconnecting: 'reconnecting',
  expired: 'failed',
};

/** Session states that end the attempt, and what the visitor is told. */
const FAILED_STATES: Partial<Record<TalkState, Notice>> = {
  busy: 'busy',
  limited: 'limit',
  unavailable: 'unavailable',
  error: 'failed',
};

/** A being that does nothing, for a device that shows the poster: the conversation still runs, captions only. */
const NO_BEING: TalkBeing = {
  face: { pushArkit: () => {} },
  setAudioLevel: () => {},
  setListening: () => {},
  tokens: () => {},
};

interface Turnstile {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id?: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

interface Ui {
  panel: HTMLElement;
  label: HTMLElement;
  voice: HTMLElement;
  close: HTMLButtonElement;
  stage: HTMLElement | null;
  consent: HTMLElement;
  session: HTMLElement;
  start: HTMLButtonElement;
  turnstile: HTMLElement;
  notice: HTMLElement;
  state: HTMLElement;
  log: HTMLElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  mic: HTMLButtonElement;
  file: HTMLInputElement;
  memoryOpen: HTMLButtonElement;
  memory: HTMLElement;
  facts: HTMLElement;
  files: HTMLElement;
  turns: HTMLElement;
  forget: HTMLButtonElement;
  end: HTMLButtonElement;
}

const controllers = new WeakMap<HTMLElement, Controller>();

/** Show the monitor's consent view (or the open conversation) over the being; wire the panel on the first open. */
export function open(panel: HTMLElement): void {
  let controller = controllers.get(panel);
  if (!controller) {
    const ui = collect(panel);
    if (!ui) return;
    controller = new Controller(ui);
    controller.bind();
    controllers.set(panel, controller);
  }
  controller.show();
}

function collect(panel: HTMLElement): Ui | null {
  const q = <T extends Element>(selector: string, type: new () => T): T | null => {
    const el = panel.querySelector(selector);
    return el instanceof type ? el : null;
  };
  const ui = {
    panel,
    label: q('[data-monitor-label]', HTMLElement),
    voice: q('[data-voice-label]', HTMLElement),
    close: q('[data-talk-close]', HTMLButtonElement),
    consent: q('[data-talk-consent]', HTMLElement),
    session: q('[data-talk-session]', HTMLElement),
    start: q('[data-talk-start]', HTMLButtonElement),
    turnstile: q('[data-talk-turnstile]', HTMLElement),
    notice: q('[data-talk-notice]', HTMLElement),
    state: q('[data-talk-state]', HTMLElement),
    log: q('[data-talk-log]', HTMLElement),
    form: q('[data-talk-form]', HTMLFormElement),
    input: q('[data-talk-input]', HTMLInputElement),
    mic: q('[data-talk-mic]', HTMLButtonElement),
    file: q('[data-talk-file]', HTMLInputElement),
    memoryOpen: q('[data-talk-memory-open]', HTMLButtonElement),
    memory: q('[data-talk-memory]', HTMLElement),
    facts: q('[data-memory-facts]', HTMLElement),
    files: q('[data-memory-files]', HTMLElement),
    turns: q('[data-memory-turns]', HTMLElement),
    forget: q('[data-talk-forget]', HTMLButtonElement),
    end: q('[data-talk-end]', HTMLButtonElement),
  };
  for (const value of Object.values(ui)) if (!value) return null;
  return { ...(ui as Omit<Ui, 'stage'>), stage: document.querySelector<HTMLElement>('[data-being-stage]') };
}

/* Turnstile ------------------------------------------------------------------------------------------------- */

let turnstileLoad: Promise<Turnstile | null> | null = null;
let widgetId: string | null = null;
let turnstileToken = '';
let tokenWaiters: Array<(token: string) => void> = [];

function loadTurnstile(): Promise<Turnstile | null> {
  if (turnstileLoad) return turnstileLoad;
  turnstileLoad = new Promise((resolve) => {
    if (window.turnstile) return resolve(window.turnstile);
    const script = document.createElement('script');
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.addEventListener('load', () => resolve(window.turnstile ?? null));
    script.addEventListener('error', () => {
      turnstileLoad = null;
      resolve(null);
    });
    document.head.append(script);
  });
  return turnstileLoad;
}

/** 'skip' when the build carries no site key (the Worker then mints without the check), true once the widget is up. */
async function mountTurnstile(ui: Ui): Promise<boolean | 'skip'> {
  const sitekey = ui.turnstile.dataset.sitekey ?? '';
  if (!sitekey) return 'skip';
  const turnstile = await loadTurnstile();
  if (!turnstile) return false;
  if (widgetId !== null) return true;
  widgetId = turnstile.render(ui.turnstile, {
    sitekey,
    appearance: 'interaction-only',
    action: 'talk',
    callback: (token: string) => {
      turnstileToken = token;
      for (const waiter of tokenWaiters) waiter(token);
      tokenWaiters = [];
    },
    'expired-callback': () => {
      turnstileToken = '';
    },
    'error-callback': () => {
      turnstileToken = '';
    },
  });
  return true;
}

/** The current token, consumed: a Turnstile token is single use, so the widget is reset for the next one. */
function takeTurnstileToken(ui: Ui): Promise<string> {
  if (!ui.turnstile.dataset.sitekey) return Promise.resolve('');
  const ready = turnstileToken;
  if (ready) {
    turnstileToken = '';
    if (widgetId !== null) window.turnstile?.reset(widgetId);
    return Promise.resolve(ready);
  }
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(''), TURNSTILE_WAIT_MS);
    tokenWaiters.push((token) => {
      window.clearTimeout(timer);
      turnstileToken = '';
      if (widgetId !== null) window.turnstile?.reset(widgetId);
      resolve(token);
    });
  });
}

/* Network --------------------------------------------------------------------------------------------------- */

function requestBeing(): Promise<TalkBeing> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(NO_BEING), 8000);
    document.dispatchEvent(
      new CustomEvent('em:being-request', {
        detail: (being: TalkBeing | null) => {
          window.clearTimeout(timer);
          resolve(being ?? NO_BEING);
        },
      }),
    );
  });
}

/* The controller -------------------------------------------------------------------------------------------- */

class Controller {
  private readonly ui: Ui;
  private session: TalkSession | null = null;
  private being: TalkBeing = NO_BEING;
  /** The microphone as achieved (open) and as intended (the button down): they differ while it is opening. */
  private held = false;
  private wantMic = false;
  private micOp: Promise<void> = Promise.resolve();
  private starting = false;
  /** The person check is skipped when the build has no site key. */
  private guarded = true;
  /** The line being written for each speaker while words still arrive. */
  private live: Partial<Record<Speaker, HTMLElement>> = {};

  constructor(ui: Ui) {
    this.ui = ui;
  }

  bind(): void {
    const { ui } = this;
    ui.start.addEventListener('click', () => this.start());
    ui.close.addEventListener('click', () => void this.end(true));
    ui.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.send();
    });
    // Push to talk: the microphone opens on the press and closes on the release, never otherwise.
    const press = (event: Event): void => {
      event.preventDefault();
      void this.hold(true);
    };
    const release = (): void => void this.hold(false);
    ui.mic.addEventListener('pointerdown', press);
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) ui.mic.addEventListener(type, release);
    ui.mic.addEventListener('keydown', (event) => {
      if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) press(event);
    });
    ui.mic.addEventListener('keyup', (event) => {
      if (event.key === ' ' || event.key === 'Enter') release();
    });
    // Losing the button, the window or the tab releases it too: the microphone is open only while it is held.
    ui.mic.addEventListener('blur', release);
    window.addEventListener('blur', release);
    window.addEventListener('pagehide', release);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) release();
    });
    ui.file.addEventListener('change', () => void this.upload());
    ui.memoryOpen.addEventListener('click', () => void this.toggleMemory());
    ui.forget.addEventListener('click', () => void this.forget());
    ui.end.addEventListener('click', () => void this.end(false));
    ui.panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.documentElement.classList.contains('is-talking')) void this.end(true);
    });
    // A tour that starts takes the monitor; the conversation ends.
    document.addEventListener('em:tour-start', () => void this.end(true));
  }

  /** Show the panel over the being: the consent view, or the conversation if one is open. */
  show(): void {
    const { ui } = this;
    ui.panel.hidden = false;
    ui.close.hidden = false;
    document.documentElement.classList.add('is-talking');
    if (this.session) {
      ui.input.focus({ preventScroll: true });
      return;
    }
    ui.consent.hidden = false;
    ui.session.hidden = true;
    ui.label.textContent = copy.monitorConsentLabel;
    this.guarded = Boolean(ui.turnstile.dataset.sitekey);
    ui.start.focus({ preventScroll: true });
  }

  /** The tap: audio first, synchronously inside the gesture; then the grant, the runtime and the session. */
  private start(): void {
    if (this.starting) return;
    this.starting = true;
    primeAudio();
    const { ui } = this;
    ui.start.setAttribute('aria-disabled', 'true');
    ui.start.textContent = copy.starting;
    this.notice(null);
    // The person check loads only now, on the tap, never on opening the panel.
    if (this.guarded && !turnstileToken) this.notice('checkPending');
    void mountTurnstile(ui)
      .then((state) => {
        if (state === false) throw new Error('turnstile');
        return this.connect();
      })
      .catch(() => this.notice('check'))
      .finally(() => {
        this.starting = false;
        ui.start.removeAttribute('aria-disabled');
        ui.start.textContent = copy.start;
      });
  }

  private async connect(): Promise<void> {
    const { ui } = this;
    const turnstile = await takeTurnstileToken(ui);
    if (this.guarded && !turnstile) return this.notice('check');
    this.notice(null);
    let failed: Notice | null = null;
    let detail = '';
    try {
      const [mod, being] = await Promise.all([import('@emersa/being/talk'), requestBeing()]);
      this.being = being;
      ui.consent.hidden = true;
      ui.session.hidden = false;
      ui.label.textContent = copy.monitorLabel;
      ui.state.textContent = copy.starting;
      const session = new mod.TalkSession({
        being,
        turnstile,
        consentVersion: CONSENT_VERSION,
        refreshTurnstile: async () => {
          const token = await takeTurnstileToken(ui);
          if (this.guarded && !token) throw new Error('turnstile');
          return token;
        },
        listen: false,
        onTranscript: (speaker, text, final) => this.caption(speaker, text, final),
        onState: (state, why) => {
          const notice = FAILED_STATES[state];
          if (notice) {
            failed = notice;
            // The Worker's own sentence (the free minutes, the day's cap) is more precise than the generic line.
            detail = state === 'limited' || state === 'unavailable' ? (why ?? '') : '';
          }
          this.setState(state);
        },
        onNotice: (notice) => this.notice(RUNTIME_NOTICES[notice] ?? 'failed'),
        onVoice: (speaking) => this.setSpeaking(speaking),
      });
      // Held from the first moment, so Close, Escape or a tour start during the connect ends this session rather
      // than leaving it live behind a hidden panel.
      this.session = session;
      await session.start();
      if (this.session !== session) {
        await session.end('visitor').catch(() => undefined);
        return;
      }
      if (session.state !== 'live') {
        this.session = null;
        await session.end('error');
        throw new Error(session.state);
      }
      ui.input.focus({ preventScroll: true });
    } catch {
      this.session = null;
      if (detail) this.status(detail);
      else this.notice(failed ?? 'failed');
      ui.session.hidden = true;
      ui.consent.hidden = false;
      ui.label.textContent = copy.monitorConsentLabel;
    }
  }

  private setState(state: TalkState): void {
    if (state === 'reconnecting') this.ui.state.textContent = copy.notices.reconnecting;
    else if (state === 'requesting' || state === 'connecting') this.ui.state.textContent = copy.starting;
    else if (state === 'live') this.ui.state.textContent = this.held ? copy.listening : '';
    if (state === 'ended' && this.session) void this.end(false);
  }

  /** Emily's voice: the disclosure line and the stage's speaking state, which moves her mouth's shards. */
  private setSpeaking(speaking: boolean): void {
    this.ui.voice.hidden = !speaking;
    this.ui.label.textContent = speaking ? copy.monitorSpeaking : copy.monitorLabel;
    this.ui.stage?.classList.toggle('is-speaking', speaking);
  }

  /**
   * The microphone button pressed (the microphone opens) or released (it closes). Opening takes time (the browser's
   * permission prompt, the audio track), and the visitor may let go meanwhile, so the intended state is recorded
   * at once and every change is applied in order, each one re-reading the intent when it finishes: a button that
   * is up by then closes the microphone it just opened. A refused microphone leaves the typed path.
   */
  private hold(down: boolean): Promise<void> {
    if (!this.session && !this.held) return Promise.resolve();
    if (down) primeAudio();
    this.wantMic = down;
    this.micOp = this.micOp.then(() => this.settleMic());
    return this.micOp;
  }

  private async settleMic(): Promise<void> {
    const session = this.session;
    if (this.wantMic && !this.held && session) {
      this.held = await session.startListening().catch(() => false);
      this.reflectMic();
      // Released while it was opening: close it again, in order.
      if (!this.wantMic && this.held) await this.closeMic(session);
    } else if (!this.wantMic && this.held) {
      await this.closeMic(session);
    }
  }

  private async closeMic(session: TalkSession | null): Promise<void> {
    if (session) await session.stopListening().catch(() => undefined);
    this.held = false;
    this.reflectMic();
  }

  private reflectMic(): void {
    this.ui.mic.setAttribute('aria-pressed', String(this.held));
    this.ui.state.textContent = this.held ? copy.listening : '';
    this.being.setListening(this.held);
  }

  private send(): void {
    const text = this.ui.input.value.trim();
    if (!text || !this.session) return;
    this.ui.input.value = '';
    // The session captions the line and records it as the visitor's turn.
    if (!this.session.sendText(text)) this.notice('failed');
  }

  /** Captions for both sides: the line grows while words arrive, and a final line closes it. */
  private caption(role: Speaker, text: string, final: boolean): void {
    let line = this.live[role];
    if (!line) {
      line = document.createElement('li');
      line.dataset.role = role;
      const who = document.createElement('span');
      who.className = 'talk-who';
      who.textContent = role === 'user' ? copy.you : copy.emily;
      const words = document.createElement('span');
      line.append(who, words);
      this.ui.log.append(line);
      this.live[role] = line;
    }
    const words = line.lastElementChild;
    if (words) words.textContent = text;
    line.setAttribute('aria-busy', String(!final));
    if (final) delete this.live[role];
    this.ui.log.scrollTop = this.ui.log.scrollHeight;
  }

  private async upload(): Promise<void> {
    const file = this.ui.file.files?.[0];
    this.ui.file.value = '';
    if (!file) return;
    if (!UPLOAD_TYPES.test(file.name)) return this.notice('fileType');
    if (file.size > UPLOAD_MAX_BYTES) return this.notice('fileTooBig');
    const body = new FormData();
    body.append('file', file);
    try {
      const response = await fetch('/api/talk/upload', { method: 'POST', credentials: 'same-origin', body });
      if (response.status === 429) return this.notice('limit');
      if (!response.ok) return this.notice('fileFailed');
      const doc = (await response.json()) as { id: string; name: string; chars: number; text?: string };
      // Text files are read here, so Emily gets the words without a second round trip; a PDF's words come from the
      // Worker's extraction when it returns them.
      const text = doc.text ?? (/\.pdf$/i.test(file.name) ? '' : (await file.text()).slice(0, DOCUMENT_MAX_CHARS));
      if (text) this.session?.addDocument(doc.name, text);
      this.status(`${copy.uploaded} ${doc.name}`);
    } catch {
      this.notice('fileFailed');
    }
  }

  private async toggleMemory(): Promise<void> {
    const { memory, memoryOpen } = this.ui;
    const opening = memory.hidden;
    memory.hidden = !opening;
    memoryOpen.setAttribute('aria-expanded', String(opening));
    if (opening) await this.loadMemory();
  }

  private async loadMemory(): Promise<void> {
    const { facts, files, turns } = this.ui;
    try {
      const response = await fetch('/api/memory', { credentials: 'same-origin' });
      if (!response.ok) throw new Error(String(response.status));
      const data: unknown = await response.json();
      const list = (name: string): Record<string, unknown>[] => {
        const value = data && typeof data === 'object' ? (data as Record<string, unknown>)[name] : undefined;
        return Array.isArray(value)
          ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          : [];
      };
      const text = (value: unknown): string => (typeof value === 'string' ? value : '');
      fill(
        facts,
        list('facts').map((f) => `${text(f.key)}: ${text(f.value)}`),
      );
      fill(
        files,
        list('documents').map((d) => text(d.name)),
      );
      fill(
        turns,
        list('turns').map((t) => `${t.role === 'user' ? copy.you : copy.emily}: ${text(t.text)}`),
      );
    } catch {
      this.notice('failed');
    }
  }

  private async forget(): Promise<void> {
    try {
      const response = await fetch('/api/memory', { method: 'DELETE', credentials: 'same-origin' });
      if (!response.ok && response.status !== 204) throw new Error(String(response.status));
      for (const list of [this.ui.facts, this.ui.files, this.ui.turns]) fill(list, []);
      this.ui.log.replaceChildren();
      await this.end(false);
      (await import('@emersa/being/talk')).forgetSdkStorage();
      this.status(copy.forgotten);
    } catch {
      this.notice('failed');
    }
  }

  /** End the conversation; with `close` the monitor goes as well and the hero copy comes back. */
  private async end(close: boolean): Promise<void> {
    const session = this.session;
    this.session = null;
    this.live = {};
    this.wantMic = false;
    this.held = false;
    this.being.setListening(false);
    this.setSpeaking(false);
    if (session) {
      try {
        await session.end('visitor');
      } catch {
        // Ending is best effort: the token expires within the hour whatever happens here.
      }
    }
    const { ui } = this;
    ui.session.hidden = true;
    ui.consent.hidden = false;
    ui.mic.setAttribute('aria-pressed', 'false');
    ui.label.textContent = copy.monitorConsentLabel;
    if (close) {
      document.documentElement.classList.remove('is-talking');
      ui.close.hidden = true;
      ui.consent.hidden = true;
      // The tour keeps the panel if it is running; otherwise it goes.
      if (!document.documentElement.classList.contains('is-touring')) ui.panel.hidden = true;
      this.notice(null);
      document.querySelector<HTMLElement>('.hero-ctas [data-talk-open]')?.focus({ preventScroll: true });
    }
  }

  private notice(kind: Notice | null): void {
    if (kind === null) {
      this.ui.notice.hidden = true;
      this.ui.notice.textContent = '';
      return;
    }
    this.status(copy.notices[kind]);
  }

  private status(text: string): void {
    this.ui.notice.textContent = text;
    this.ui.notice.hidden = false;
  }
}

function fill(list: HTMLElement, lines: readonly string[]): void {
  const items = (lines.length ? lines : [copy.memoryEmpty]).map((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    return li;
  });
  list.replaceChildren(...items);
}
