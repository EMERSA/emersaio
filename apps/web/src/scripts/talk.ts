/**
 * The Talk shell, loaded by talk-boot.ts when the monitor first opens. It owns the consent view, the optional
 * Turnstile widget, the session mint (POST /api/talk/session), the message log, the typed prompt, the round
 * microphone (push to talk: the microphone is open only while it, or Emily herself, is held), file upload, the
 * memory panel with Forget me, End, the More menu that holds those three, and the guide line. On a phone it also
 * keeps the sheet the conversation opens in: the visible viewport published for hud.css, the page behind locked and
 * inert, and Emily framed as a portrait while the chat shows. The voice itself, and every Convai byte, arrives with
 * the dynamic import of @emersa/being/talk after the visitor taps Start talking. The being is asked for the moment
 * the monitor opens and joins the session whenever it arrives: the session never waits for it.
 *
 * Every dynamic string goes through textContent. No secret ever reaches this file: the Worker mints a one-hour
 * Convai token per session and the visitor cookie is HttpOnly.
 */
import { primeAudio } from '@emersa/being/audio';
import { talkTextTop } from '@emersa/being/framing';
import { site } from '../data/site.ts';
import { guidePlan } from './talk-guide.ts';

const copy = site.talk;
const root = document.documentElement;

/** The exact Turnstile URL the CSP allows. Added to the document only when the monitor opens with a site key. */
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const TURNSTILE_WAIT_MS = 15000;
/** The consent text version the Worker records with the visitor row. Bump it when the consent copy changes. */
export const CONSENT_VERSION = 3;
const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const UPLOAD_TYPES = /\.txt$/i;
/** The Worker keeps 20,000 characters of a document; the session hands Emily the first 6,000 of them. */
const DOCUMENT_MAX_CHARS = 20000;

/** The phone layout of hud.css: the conversation as a sheet under the header. */
const PHONE = matchMedia('(max-width: 719.98px)');
/** A mouse or a trackpad: focusing the field opens no on-screen keyboard over the conversation. */
const FINE_POINTER = matchMedia('(pointer: fine)');
const COARSE_POINTER = matchMedia('(pointer: coarse)');
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
/** A visible viewport shorter than this lays the chat out as it does with the keyboard up (html.is-keyboard). */
const SHORT_VIEWPORT_PX = 520;

type Notice = keyof typeof copy.notices;
type TalkModule = typeof import('@emersa/being/talk');
type TalkSession = InstanceType<TalkModule['TalkSession']>;
type TalkState = TalkSession['state'];
type Speaker = 'user' | 'being';
type TalkBeing = Parameters<TalkModule['TalkSession']['start']>[0]['being'];
/** How the being frames Emily (being-mount.ts passes it on): the hero's bust, or the phone chat's portrait. */
type TalkLayout = 'bust' | 'portrait';

/** The runtime's notices, in the shell's words (site.ts). */
const RUNTIME_NOTICES: Record<string, Notice> = {
  busy: 'busy',
  cap: 'timeUp',
  'mic-denied': 'micDenied',
  'mic-missing': 'micMissing',
  'mic-busy': 'micBusy',
  'mic-failed': 'micFailed',
  reconnecting: 'reconnecting',
  expired: 'failed',
  'audio-blocked': 'audioBlocked',
};

/** Session states that end the attempt, and what the visitor is told. */
const FAILED_STATES: Partial<Record<TalkState, Notice>> = {
  busy: 'busy',
  limited: 'limit',
  unavailable: 'unavailable',
  error: 'failed',
};

/**
 * The being as the session sees it from the first moment. It forwards the face, the audio level, the listening ring
 * and the tokens to the rendered being once that arrives (bind) and drops them until then, so the conversation
 * never waits for the avatar; a device that shows the poster simply never binds one, captions only. The listening
 * state is applied again on bind, so a microphone held before she lands shows on her when she does.
 */
class LateBeing implements TalkBeing {
  private target: TalkBeing | null = null;
  private listening = false;

  readonly face = {
    pushArkit: (frame: ArrayLike<number>): void => this.target?.face.pushArkit(frame),
  };

  bind(being: TalkBeing): void {
    this.target = being;
    being.setListening(this.listening);
  }

  setAudioLevel(level: number): void {
    this.target?.setAudioLevel(level);
  }

  setListening(on: boolean): void {
    this.listening = on;
    this.target?.setListening(on);
  }

  tokens(n: number): void {
    this.target?.tokens(n);
  }
}

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
  retry: HTMLButtonElement;
  stage: HTMLElement | null;
  consent: HTMLElement;
  consentBody: HTMLElement;
  session: HTMLElement;
  start: HTMLButtonElement;
  turnstile: HTMLElement;
  notice: HTMLElement;
  state: HTMLElement;
  guide: HTMLElement;
  log: HTMLElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  mic: HTMLButtonElement;
  more: HTMLDetailsElement;
  moreButton: HTMLElement;
  file: HTMLInputElement;
  attach: HTMLButtonElement;
  fileNote: HTMLElement;
  fileCancel: HTMLButtonElement;
  memoryOpen: HTMLButtonElement;
  memory: HTMLElement;
  facts: HTMLElement;
  files: HTMLElement;
  turns: HTMLElement;
  forget: HTMLButtonElement;
  end: HTMLButtonElement;
}

const controllers = new WeakMap<HTMLElement, Controller>();

/**
 * Show the monitor's consent view (or the open conversation) over the being; wire the panel on the first open.
 * The opener (the link that was tapped) gets the focus back when the monitor closes.
 */
export function open(panel: HTMLElement, opener?: Element | null): void {
  let controller = controllers.get(panel);
  if (!controller) {
    const ui = collect(panel);
    if (!ui) return;
    controller = new Controller(ui);
    controller.bind();
    controllers.set(panel, controller);
  }
  controller.show(opener instanceof HTMLElement ? opener : null);
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
    retry: q('[data-talk-retry]', HTMLButtonElement),
    consent: q('[data-talk-consent]', HTMLElement),
    consentBody: q('[data-talk-consent-body]', HTMLElement),
    session: q('[data-talk-session]', HTMLElement),
    start: q('[data-talk-start]', HTMLButtonElement),
    turnstile: q('[data-talk-turnstile]', HTMLElement),
    notice: q('[data-talk-notice]', HTMLElement),
    state: q('[data-talk-state]', HTMLElement),
    guide: q('[data-talk-guide]', HTMLElement),
    log: q('[data-talk-log]', HTMLElement),
    form: q('[data-talk-form]', HTMLFormElement),
    input: q('[data-talk-input]', HTMLInputElement),
    mic: q('[data-talk-mic]', HTMLButtonElement),
    more: q('[data-talk-more]', HTMLDetailsElement),
    moreButton: q('[data-talk-more] > summary', HTMLElement),
    file: q('[data-talk-file]', HTMLInputElement),
    attach: q('[data-talk-attach]', HTMLButtonElement),
    fileNote: q('[data-talk-file-note]', HTMLElement),
    fileCancel: q('[data-talk-file-cancel]', HTMLButtonElement),
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

/* The controller -------------------------------------------------------------------------------------------- */

class Controller {
  private readonly ui: Ui;
  private session: TalkSession | null = null;
  /** The being the session drives; the rendered one is bound to it when being-mount.ts hands it over. */
  private readonly being = new LateBeing();
  private beingAsked = false;
  /** The microphone as achieved (open) and as intended (the button down): they differ while it is opening. */
  private held = false;
  private wantMic = false;
  private micOp: Promise<void> = Promise.resolve();
  private starting = false;
  /** The person check is skipped when the build has no site key. */
  private guarded = true;
  /** The line being written for each speaker while words still arrive. */
  private live: Partial<Record<Speaker, HTMLElement>> = {};
  /** The framing last asked of the being. */
  private layout: TalkLayout = 'bust';
  /** The guide line shows once per page. */
  private guided = false;
  /** The page behind the phone sheet: what this made inert, where the page was scrolled, and whether to go back. */
  private inerted: HTMLElement[] = [];
  private scrollY = 0;
  private restoreScroll = true;
  /** The control that opened the monitor: the focus goes back to it. */
  private opener: HTMLElement | null = null;
  private tracking = false;
  private viewportFrame = 0;

  constructor(ui: Ui) {
    this.ui = ui;
  }

  bind(): void {
    const { ui } = this;
    ui.start.addEventListener('click', () => this.start());
    ui.retry.addEventListener('click', () => this.start());
    // Hovering or focusing Start warms the runtime chunk (first-party, no side effects); the SDK itself waits for
    // the tap, as the privacy policy says.
    for (const type of ['pointerenter', 'focus', 'pointerdown'] as const) {
      ui.start.addEventListener(type, () => void import('@emersa/being/talk').catch(() => undefined), { once: true });
    }
    ui.close.addEventListener('click', () => void this.end(true));
    ui.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.send();
    });
    // Push to talk: the microphone opens on the press and closes on the release, never otherwise. The press is
    // captured, so a finger that drifts off the round button keeps holding until it lifts.
    const press = (event: Event): void => {
      event.preventDefault();
      void this.hold(true);
    };
    const release = (): void => void this.hold(false);
    ui.mic.addEventListener('pointerdown', (event) => {
      try {
        ui.mic.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone; the release below still closes the microphone.
      }
      press(event);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture'] as const) {
      ui.mic.addEventListener(type, release);
    }
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
    // A long press on the microphone or on Emily is a hold, never the browser's menu.
    const noMenu = (event: Event): void => {
      if (root.classList.contains('is-talking')) event.preventDefault();
    };
    ui.mic.addEventListener('contextmenu', noMenu);
    ui.stage?.addEventListener('contextmenu', noMenu);
    // Holding Emily herself opens the microphone too: the runtime tells a hold from a drag (which turns her) and
    // says so with em:being-hold from her canvas. Only a live session listens; a release always closes. The hold
    // is announced a moment after the press, outside the gesture, so the press itself primes the audio.
    ui.stage?.addEventListener('em:being-hold', (event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const active = typeof detail === 'object' && detail !== null && (detail as { active?: unknown }).active === true;
      if (!active) void this.hold(false);
      else if (this.session?.state === 'live') void this.hold(true);
    });
    ui.stage?.addEventListener(
      'pointerdown',
      () => {
        if (this.session?.state === 'live') primeAudio();
      },
      { capture: true },
    );
    // Add a file sits beside the microphone; More holds What Emily remembers and End, and closes on a choice, on
    // Escape and on a tap outside it.
    // The paperclip opens the file note (what Emily reads and keeps) with Choose and Cancel; the picker opens from
    // Choose.
    const fileNote = (open: boolean): void => {
      ui.fileNote.hidden = !open;
      ui.attach.setAttribute('aria-expanded', String(open));
    };
    ui.attach.addEventListener('click', () => fileNote(ui.fileNote.hidden));
    ui.fileCancel.addEventListener('click', () => {
      fileNote(false);
      ui.attach.focus();
    });
    ui.file.addEventListener('change', () => {
      fileNote(false);
      void this.upload();
    });
    ui.memoryOpen.addEventListener('click', () => {
      this.closeMore();
      void this.setMemory(ui.memory.hidden);
    });
    ui.forget.addEventListener('click', () => void this.forget());
    ui.end.addEventListener('click', () => {
      this.closeMore();
      void this.end(false);
    });
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (ui.more.open && !(event.target instanceof Node && ui.more.contains(event.target))) this.closeMore();
      },
      { capture: true },
    );
    // Escape shuts an open More and nothing else (wherever the focus is); with More shut it ends the conversation.
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || !ui.more.open) return;
        event.preventDefault();
        event.stopPropagation();
        this.closeMore(true);
      },
      { capture: true },
    );
    ui.panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && root.classList.contains('is-talking')) void this.end(true);
    });
    // The notice scrolls where the room is short; its foot fades while more of it is below.
    const body = ui.consentBody;
    const overflowing = (): void => {
      body.classList.toggle('is-overflowing', body.scrollTop + body.clientHeight < body.scrollHeight - 2);
    };
    body.addEventListener('scroll', overflowing, { passive: true });
    if (typeof ResizeObserver === 'function') new ResizeObserver(overflowing).observe(body);
    // A tour that starts takes the monitor; the conversation ends.
    document.addEventListener('em:tour-start', () => void this.end(true));
    // A link to a part of this page (the header menu's, which stays usable over the phone sheet) ends the
    // conversation the sheet would otherwise keep covering it with, and the page stays where the link took it.
    window.addEventListener('hashchange', () => {
      if (this.inerted.length === 0) return;
      this.restoreScroll = false;
      void this.end(true);
    });
    // The sheet comes and goes with the width (a phone turned, a window resized); the field's focus is the keyboard.
    PHONE.addEventListener('change', () => this.relayout());
    ui.input.addEventListener('focus', this.onViewport);
    ui.input.addEventListener('blur', this.onViewport);
    this.observeStage();
  }

  /** Show the panel over the being: the consent view, or the conversation if one is open. */
  show(opener: HTMLElement | null): void {
    const { ui } = this;
    this.opener = opener;
    ui.panel.hidden = false;
    ui.close.hidden = false;
    root.classList.add('is-talking');
    this.requestBeing();
    this.trackViewport(true);
    // Phones open the conversation as a sheet over a locked page; from 720px it stays in the page, the hero one
    // window tall (Hero.astro), and the page scrolls on as usual.
    this.lockPage(PHONE.matches);
    if (!PHONE.matches) document.querySelector('.hero')?.scrollIntoView({ block: 'start' });
    if (this.session) {
      this.focusInput();
      return;
    }
    ui.consent.hidden = false;
    ui.session.hidden = true;
    ui.label.textContent = copy.monitorConsentLabel;
    this.guarded = Boolean(ui.turnstile.dataset.sitekey);
    ui.start.focus({ preventScroll: true });
  }

  /**
   * Ask being-mount.ts for the being: it loads in the tap that opened the monitor (or is already drawn) and joins
   * the session whenever it arrives. A device that shows the poster answers null and the talk runs on alone; the
   * next opening asks again, since a being the tour gave up on can still be loaded then.
   */
  private requestBeing(): void {
    if (this.beingAsked) return;
    this.beingAsked = true;
    document.dispatchEvent(
      new CustomEvent('em:being-request', {
        detail: (being: TalkBeing | null) => {
          if (being) this.being.bind(being);
          else this.beingAsked = false;
        },
      }),
    );
  }

  /** The tap: audio first, synchronously inside the gesture; then the grant, the runtime and the session. */
  private start(): void {
    if (this.starting) return;
    this.starting = true;
    primeAudio();
    performance.mark('talk:tap');
    // The voice service's code starts downloading now, in the tap, so it overlaps the person check and the mint
    // instead of following them.
    void import('@emersa/being/talk').then((mod) => mod.loadConvaiSdk()).catch(() => undefined);
    const { ui } = this;
    ui.retry.hidden = true;
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
      .catch(() => this.fail('check'))
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
    let reached: TalkState = 'idle';
    // A policy that blocks the voice service shows up here, not as an error the SDK can name.
    let blocked = false;
    const onViolation = (): void => {
      blocked = true;
    };
    document.addEventListener('securitypolicyviolation', onViolation);
    try {
      // The runtime alone: the being is not waited for (it joins through the LateBeing whenever it lands).
      const mod = await import('@emersa/being/talk');
      // Closed while the code arrived: nothing to start.
      if (!root.classList.contains('is-talking')) return;
      ui.consent.hidden = true;
      ui.session.hidden = false;
      ui.label.textContent = copy.monitorLabel;
      ui.state.textContent = copy.starting;
      this.setChatting(true);
      const session = new mod.TalkSession({
        being: this.being,
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
            // Where it broke: the site itself unreachable, or the voice service after the grant.
            if (state === 'error')
              failed = why === 'network' ? 'offline' : reached === 'connecting' ? 'voiceBlocked' : 'failed';
          } else if (state === 'requesting' || state === 'connecting') reached = state;
          this.setState(state);
        },
        onNotice: (notice) => {
          this.notice(RUNTIME_NOTICES[notice] ?? 'failed');
          if (notice === 'audio-blocked') this.resumeOnTap(session);
        },
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
      performance.mark('talk:live');
      performance.measure('talk:tap-to-live', 'talk:tap', 'talk:live');
      this.focusInput();
    } catch {
      this.session = null;
      if (detail) this.fail(detail, true);
      else this.fail(blocked ? 'policyBlocked' : (failed ?? 'failed'));
      ui.session.hidden = true;
      ui.consent.hidden = false;
      ui.label.textContent = copy.monitorConsentLabel;
      this.setChatting(false);
    } finally {
      document.removeEventListener('securitypolicyviolation', onViolation);
    }
  }

  /**
   * The browser held Emily's sound back (autoplay): the next tap or key anywhere on the page starts it, and the
   * notice goes. Registered once per refusal.
   */
  private resumeOnTap(session: TalkSession): void {
    const resume = (): void => {
      document.removeEventListener('pointerdown', resume, true);
      document.removeEventListener('keydown', resume, true);
      if (this.session !== session) return;
      primeAudio();
      session.resumeAudio();
      this.notice(null);
    };
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
  }

  /** A failed attempt: the sentence that names where it broke, and a Retry beside it. */
  private fail(what: Notice | string, verbatim = false): void {
    if (verbatim) this.status(what);
    else this.notice(what as Notice);
    this.ui.retry.hidden = false;
  }

  private setState(state: TalkState): void {
    if (state === 'reconnecting') this.ui.state.textContent = copy.notices.reconnecting;
    else if (state === 'requesting' || state === 'connecting') this.ui.state.textContent = copy.starting;
    else if (state === 'live') {
      this.ui.state.textContent = this.held ? copy.listening : '';
      // Still held from a press made while connecting: open the microphone now.
      if (this.wantMic && !this.held) this.micOp = this.micOp.then(() => this.settleMic());
    }
    if (state === 'ended' && this.session) void this.end(false);
  }

  /** Emily's voice: the disclosure line and the stage's speaking state, which moves her mouth's shards. */
  private setSpeaking(speaking: boolean): void {
    this.ui.voice.hidden = !speaking;
    this.ui.label.textContent = speaking ? copy.monitorSpeaking : copy.monitorLabel;
    this.ui.stage?.classList.toggle('is-speaking', speaking);
  }

  /**
   * The microphone button (or Emily) pressed: the microphone opens; released: it closes. Opening takes time (the
   * browser's permission prompt, the audio track), and the visitor may let go meanwhile, so the intended state is
   * recorded at once and every change is applied in order, each one re-reading the intent when it finishes: a
   * press that is over by then closes the microphone it just opened. A refused microphone leaves the typed path.
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
      // Pressed before her voice is connected: say so, and the microphone opens once it is (setState).
      if (!this.held && session.state !== 'live') this.ui.state.textContent = copy.starting;
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
    // The line sent goes into the conversation, so the conversation comes back if the memory panel had its place.
    if (!this.ui.memory.hidden) void this.setMemory(false);
    // The session captions the line and records it as the visitor's turn.
    if (!this.session.sendText(text)) this.notice('failed');
  }

  /** Captions for both sides: the line grows while words arrive, and a final line closes it. */
  private caption(role: Speaker, text: string, final: boolean): void {
    let line = this.live[role];
    // No line for no words: a bubble the runtime opened before any word arrived would print a bare name.
    if (!line && text.trim() === '') return;
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
      // The file is read here, so Emily gets the words without a second round trip.
      const text = doc.text ?? (await file.text()).slice(0, DOCUMENT_MAX_CHARS);
      if (text) this.session?.addDocument(doc.name, text);
      this.status(`${copy.uploaded} ${doc.name}`);
    } catch {
      this.notice('fileFailed');
    }
  }

  /** What Emily remembers, in the log's place while it is open (hud.css); the log comes back when it closes. */
  private async setMemory(open: boolean): Promise<void> {
    const { memory, memoryOpen } = this.ui;
    memory.hidden = !open;
    memoryOpen.setAttribute('aria-expanded', String(open));
    if (open) await this.loadMemory();
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

  /**
   * End the conversation; with `close` the monitor goes as well, the page behind a phone's sheet comes back where
   * it was, and the focus returns to the control that opened it. The monitor answers at once; the session is ended
   * behind it.
   */
  private async end(close: boolean): Promise<void> {
    const session = this.session;
    const wasOpen = root.classList.contains('is-talking');
    this.session = null;
    this.live = {};
    this.wantMic = false;
    this.held = false;
    this.being.setListening(false);
    this.setSpeaking(false);
    this.closeMore();
    const { ui } = this;
    ui.session.hidden = true;
    ui.consent.hidden = false;
    ui.mic.setAttribute('aria-pressed', 'false');
    ui.label.textContent = copy.monitorConsentLabel;
    this.setChatting(false);
    if (close) {
      root.classList.remove('is-talking', 'is-keyboard');
      ui.close.hidden = true;
      ui.consent.hidden = true;
      // The tour keeps the panel if it is running; otherwise it goes.
      if (!root.classList.contains('is-touring')) ui.panel.hidden = true;
      this.notice(null);
      this.trackViewport(false);
      this.lockPage(false);
      if (wasOpen) {
        const back = this.opener?.isConnected
          ? this.opener
          : document.querySelector<HTMLElement>('.hero-ctas [data-talk-open]');
        back?.focus({ preventScroll: true });
      }
      this.opener = null;
    }
    if (session) {
      try {
        await session.end('visitor');
      } catch {
        // Ending is best effort: the token expires within the hour whatever happens here.
      }
    }
  }

  /* The chat view, the phone sheet and the being's framing ------------------------------------------------ */

  /**
   * The chat view opens (or closes): html.is-chatting for hud.css, More in the head row, the being's framing, and
   * the guide line the first time.
   */
  private setChatting(on: boolean): void {
    root.classList.toggle('is-chatting', on);
    this.ui.more.hidden = !on;
    if (!on) {
      this.closeMore();
      void this.setMemory(false);
    }
    this.applyLayout();
    if (on) this.showGuide();
  }

  /** A phone showing the chat frames Emily as a portrait over it; everything else keeps the hero's bust. */
  private applyLayout(): void {
    const chatting = root.classList.contains('is-talking') && root.classList.contains('is-chatting');
    const layout: TalkLayout = chatting && PHONE.matches ? 'portrait' : 'bust';
    if (layout === this.layout) return;
    this.layout = layout;
    document.dispatchEvent(new CustomEvent<TalkLayout>('em:talk-layout', { detail: layout }));
  }

  /** The guide line (site.talk.howTo), once per page: ten seconds, a short fade, then only the conversation. */
  private showGuide(): void {
    if (this.guided) return;
    this.guided = true;
    const { guide } = this.ui;
    const plan = guidePlan(REDUCED_MOTION.matches);
    guide.hidden = false;
    if (plan.fadeAt !== null) window.setTimeout(() => guide.classList.add('is-fading'), plan.fadeAt);
    window.setTimeout(() => {
      guide.hidden = true;
      guide.classList.remove('is-fading');
    }, plan.hideAt);
  }

  private closeMore(focus = false): void {
    const { more, moreButton } = this.ui;
    if (!more.open) return;
    more.open = false;
    if (focus) moreButton.focus();
  }

  /** The field takes the focus only where that opens no on-screen keyboard over Emily and the conversation. */
  private focusInput(): void {
    if (FINE_POINTER.matches) this.ui.input.focus({ preventScroll: true });
  }

  /** The width crossed the phone breakpoint while the monitor is open: the sheet, the lock and the framing follow. */
  private relayout(): void {
    if (!root.classList.contains('is-talking')) return;
    this.lockPage(PHONE.matches);
    this.publishViewport();
    this.applyLayout();
  }

  /**
   * The visible viewport, for the phone sheet: visualViewport's height and offset as --vv-h and --vv-top on <html>,
   * and html.is-keyboard while the keyboard is up (the field focused on a touch screen) or the viewport is as short
   * as that. Custom properties set through the CSSOM are not inline styles, so the Content-Security-Policy keeps.
   */
  private trackViewport(on: boolean): void {
    if (on === this.tracking) return;
    this.tracking = on;
    const viewport = window.visualViewport;
    if (on) {
      viewport?.addEventListener('resize', this.onViewport);
      viewport?.addEventListener('scroll', this.onViewport);
      window.addEventListener('resize', this.onViewport);
      this.publishViewport();
    } else {
      viewport?.removeEventListener('resize', this.onViewport);
      viewport?.removeEventListener('scroll', this.onViewport);
      window.removeEventListener('resize', this.onViewport);
      root.classList.remove('is-keyboard');
    }
  }

  private readonly onViewport = (): void => {
    if (!this.tracking || this.viewportFrame) return;
    this.viewportFrame = requestAnimationFrame(() => {
      this.viewportFrame = 0;
      this.publishViewport();
    });
  };

  private publishViewport(): void {
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    root.style.setProperty('--vv-h', `${Math.round(height)}px`);
    root.style.setProperty('--vv-top', `${Math.round(viewport?.offsetTop ?? 0)}px`);
    const typing = document.activeElement === this.ui.input && COARSE_POINTER.matches;
    const keyboard = PHONE.matches && (typing || height < SHORT_VIEWPORT_PX);
    if (keyboard !== root.classList.contains('is-keyboard')) root.classList.toggle('is-keyboard', keyboard);
    // A shorter log keeps its newest line on the prompt.
    this.ui.log.scrollTop = this.ui.log.scrollHeight;
  }

  /**
   * Behind the phone sheet the page is still: it does not scroll (hud.css) and everything but the header, the stage
   * and the monitor is inert, so neither a tap nor the keyboard reaches what the sheet covers. Closing gives it all
   * back, at the scroll position it had.
   */
  private lockPage(on: boolean): void {
    if (on && this.inerted.length === 0) {
      this.scrollY = window.scrollY;
      const keep = [this.ui.panel, this.ui.stage, document.querySelector('[data-header]')].filter(
        (element): element is HTMLElement => element instanceof HTMLElement,
      );
      // From the monitor up to <body>: every sibling on the way that holds none of the kept parts goes inert.
      let node: HTMLElement = this.ui.panel;
      while (node !== document.body) {
        const parent = node.parentElement;
        if (!parent) break;
        for (const sibling of Array.from(parent.children)) {
          if (!(sibling instanceof HTMLElement) || sibling.inert) continue;
          if (keep.some((element) => sibling.contains(element))) continue;
          sibling.inert = true;
          this.inerted.push(sibling);
        }
        node = parent;
      }
    } else if (!on && this.inerted.length > 0) {
      for (const element of this.inerted) element.inert = false;
      this.inerted = [];
      // A link the visitor followed meanwhile has moved the page on purpose (its scroll may still be running).
      const restore = this.restoreScroll;
      this.restoreScroll = true;
      if (restore && Math.abs(window.scrollY - this.scrollY) > 1) {
        window.scrollTo({ top: this.scrollY, behavior: 'instant' });
      }
    }
  }

  /**
   * From 720px the monitor starts at the foot of Emily's neck: talkTextTop (the runtime's framing, three-free) for
   * the stage's aspect, published as --talk-top for hud.css and kept current as the stage resizes.
   */
  private observeStage(): void {
    const { stage } = this.ui;
    if (!stage || typeof ResizeObserver !== 'function') return;
    const publish = (): void => {
      const { width, height } = stage.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      root.style.setProperty('--talk-top', `${(talkTextTop(width / height) * 100).toFixed(2)}%`);
    };
    new ResizeObserver(publish).observe(stage);
    publish();
  }

  private notice(kind: Notice | null): void {
    if (kind === null) {
      this.ui.notice.hidden = true;
      this.ui.notice.textContent = '';
      this.ui.retry.hidden = true;
      return;
    }
    this.status(copy.notices[kind]);
  }

  private status(text: string): void {
    this.ui.notice.textContent = text;
    this.ui.notice.hidden = false;
    // Below the fold on a short window it would go unseen: bring it into view.
    this.ui.notice.scrollIntoView({ block: 'nearest' });
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
