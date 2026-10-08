/**
 * The Talk shell (Phase 2), loaded by talk-boot.ts when the sheet first opens. It owns the consent view, the
 * Turnstile widget, the session mint (POST /api/talk/session), the message list, the microphone toggle, the typed
 * fallback, file upload, the memory panel with Forget me, and End. The voice itself, and every Convai byte, arrives
 * with the dynamic import of @emersa/being/talk after the visitor taps Start talking.
 *
 * Every dynamic string goes through textContent. No secret ever reaches this file: the Worker mints a one-hour
 * Convai token per session and the visitor cookie is HttpOnly.
 */
import { primeAudio } from '@emersa/being/audio';
import { site } from '../data/site.ts';

const copy = site.talk;

/** Plan 4.5: the exact Turnstile URL the Phase 2 CSP allows. Added to the document only when the sheet opens. */
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const TURNSTILE_WAIT_MS = 15000;
/** The consent text version the Worker records with the visitor row. Bump it when the consent copy changes. */
export const CONSENT_VERSION = 1;
const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const UPLOAD_TYPES = /\.(pdf|txt|md)$/i;
/** The Worker keeps 20,000 characters of a document; the local copy given to Emily is cut the same way. */
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
  sheet: HTMLDialogElement;
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

const wired = new WeakSet<HTMLDialogElement>();

/** Wire the sheet once; later opens only make sure the Turnstile widget is there. */
export function wire(sheet: HTMLDialogElement): void {
  const ui = collect(sheet);
  if (!ui) return;
  if (wired.has(sheet)) {
    if (!ui.session.hidden) return;
    void mountTurnstile(ui);
    return;
  }
  wired.add(sheet);
  new Controller(ui).bind();
}

function collect(sheet: HTMLDialogElement): Ui | null {
  const q = <T extends Element>(selector: string, type: new () => T): T | null => {
    const el = sheet.querySelector(selector);
    return el instanceof type ? el : null;
  };
  const ui = {
    sheet,
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
  return ui as Ui;
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

async function mountTurnstile(ui: Ui): Promise<boolean> {
  const sitekey = ui.turnstile.dataset.sitekey ?? '';
  if (!sitekey) return false;
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
function takeTurnstileToken(): Promise<string> {
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
  private micOn = false;
  private starting = false;
  /** The line being written for each speaker while words still arrive. */
  private live: Partial<Record<Speaker, HTMLElement>> = {};

  constructor(ui: Ui) {
    this.ui = ui;
  }

  bind(): void {
    const { ui } = this;
    ui.start.addEventListener('click', () => this.start());
    ui.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.send();
    });
    ui.mic.addEventListener('click', () => void this.toggleMic());
    ui.file.addEventListener('change', () => void this.upload());
    ui.memoryOpen.addEventListener('click', () => void this.toggleMemory());
    ui.forget.addEventListener('click', () => void this.forget());
    ui.end.addEventListener('click', () => void this.end(true));
    ui.sheet.addEventListener('close', () => void this.end(false));
    void mountTurnstile(ui).then((ok) => {
      if (!ok) this.notice(ui.turnstile.dataset.sitekey ? 'check' : 'unavailable');
    });
  }

  /** The tap: audio first, synchronously inside the gesture; then the grant, the runtime and the session. */
  private start(): void {
    if (this.starting) return;
    this.starting = true;
    primeAudio();
    const { ui } = this;
    ui.start.disabled = true;
    ui.start.textContent = copy.starting;
    this.notice(null);
    if (!turnstileToken) this.notice('checkPending');
    void this.connect().finally(() => {
      this.starting = false;
      ui.start.disabled = false;
      ui.start.textContent = copy.start;
    });
  }

  private async connect(): Promise<void> {
    const { ui } = this;
    const turnstile = await takeTurnstileToken();
    if (!turnstile) return this.notice('check');
    this.notice(null);
    let failed: Notice | null = null;
    try {
      const [mod, being] = await Promise.all([import('@emersa/being/talk'), requestBeing()]);
      this.being = being;
      ui.consent.hidden = true;
      ui.session.hidden = false;
      this.ui.state.textContent = copy.starting;
      const session = await mod.TalkSession.start({
        being,
        turnstile,
        consentVersion: CONSENT_VERSION,
        refreshTurnstile: async () => {
          const token = await takeTurnstileToken();
          if (!token) throw new Error('turnstile');
          return token;
        },
        listen: false,
        onTranscript: (speaker, text, final) => this.caption(speaker, text, final),
        onState: (state) => {
          const notice = FAILED_STATES[state];
          if (notice) failed = notice;
          this.setState(state);
        },
        onNotice: (notice) => this.notice(RUNTIME_NOTICES[notice] ?? 'failed'),
      });
      if (session.state !== 'live') {
        await session.end('error');
        throw new Error(session.state);
      }
      this.session = session;
      await this.setMic(true);
      ui.input.focus();
    } catch {
      this.session = null;
      this.notice(failed ?? 'failed');
      ui.session.hidden = true;
      ui.consent.hidden = false;
    }
  }

  private setState(state: TalkState): void {
    if (state === 'reconnecting') this.ui.state.textContent = copy.notices.reconnecting;
    else if (state === 'requesting' || state === 'connecting') this.ui.state.textContent = copy.starting;
    else if (state === 'live') this.ui.state.textContent = this.micOn ? copy.listening : copy.muted;
    if (state === 'ended' && this.session) void this.end(false);
  }

  private async setMic(on: boolean): Promise<void> {
    if (!this.session) return;
    if (on) {
      // A refused microphone leaves the typed path; the runtime raises the mic-denied notice itself.
      this.micOn = await this.session.startListening().catch(() => false);
    } else {
      await this.session.stopListening().catch(() => undefined);
      this.micOn = false;
    }
    this.ui.mic.setAttribute('aria-pressed', String(this.micOn));
    this.ui.mic.textContent = this.micOn ? copy.micOn : copy.micOff;
    this.ui.state.textContent = this.micOn ? copy.listening : copy.muted;
    this.being.setListening(this.micOn);
  }

  private toggleMic(): Promise<void> {
    return this.setMic(!this.micOn);
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
      const data = (await response.json()) as {
        facts?: Array<{ key: string; value: string }>;
        turns?: Array<{ role: string; text: string }>;
        documents?: Array<{ name: string; chars: number }>;
      };
      fill(
        facts,
        (data.facts ?? []).map((f) => `${f.key}: ${f.value}`),
      );
      fill(
        files,
        (data.documents ?? []).map((d) => d.name),
      );
      fill(
        turns,
        (data.turns ?? []).map((t) => `${t.role === 'user' ? copy.you : copy.emily}: ${t.text}`),
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
      this.status(copy.forgotten);
    } catch {
      this.notice('failed');
    }
  }

  private async end(closeSheet: boolean): Promise<void> {
    const session = this.session;
    this.session = null;
    this.live = {};
    this.micOn = false;
    this.being.setListening(false);
    if (session) {
      try {
        await session.end('visitor');
      } catch {
        // Ending is best effort: the token expires within the hour whatever happens here.
      }
    }
    this.ui.session.hidden = true;
    this.ui.consent.hidden = false;
    this.ui.mic.setAttribute('aria-pressed', 'false');
    this.ui.mic.textContent = copy.micOff;
    if (closeSheet && this.ui.sheet.open) this.ui.sheet.close();
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
