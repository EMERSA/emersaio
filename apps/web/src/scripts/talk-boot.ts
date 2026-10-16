/**
 * The only Talk code on the page before a tap: it shows the monitor's consent view over the being inside the
 * click itself, then loads scripts/talk.ts, the SDK-free shell that fetches @emersa/being/talk only when the
 * visitor taps Start talking. Every [data-talk-open] link (the hero button, the header link, Emily's card) opens
 * it; their href is the mailto fallback for a page without scripts. Opening stops a running tour and starts loading
 * the being, in the same tap (being-mount.ts listens for em:talk-open). Hovering or focusing a link warms the shell
 * chunk, so the tap has nothing to fetch.
 */
const panel = document.querySelector<HTMLElement>('[data-monitor]');
let shell: Promise<typeof import('./talk.ts')> | null = null;

const warm = (): Promise<typeof import('./talk.ts')> => {
  shell ??= import('./talk.ts');
  return shell;
};

function open(event?: Event): void {
  if (!panel) return;
  event?.preventDefault();
  const opener = event?.currentTarget instanceof Element ? event.currentTarget : null;
  document.dispatchEvent(new CustomEvent('em:talk-open'));
  // The first frame is drawn here, synchronously in the gesture: the panel and the consent view, before any
  // chunk arrives (the markup carries the consent label), the way being-mount.ts pins the tour bar on Start.
  panel.hidden = false;
  const consent = panel.querySelector<HTMLElement>('[data-talk-consent]');
  const close = panel.querySelector<HTMLElement>('[data-talk-close]');
  if (consent && !panel.querySelector('[data-talk-session]:not([hidden])')) consent.hidden = false;
  if (close) close.hidden = false;
  document.documentElement.classList.add('is-talking');
  // From 720px the monitor sits over the hero, so a hero scrolled half away comes back; on a phone the conversation
  // opens as a sheet over the page wherever it is (hud.css), and the page stays put.
  const hero = document.querySelector('#hero');
  if (
    hero &&
    !matchMedia('(max-width: 719.98px)').matches &&
    hero.getBoundingClientRect().bottom < window.innerHeight * 0.5
  ) {
    hero.scrollIntoView({
      block: 'start',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }
  void warm().then((talk) => talk.open(panel, opener));
}

if (panel) {
  for (const link of document.querySelectorAll('[data-talk-open]')) {
    link.addEventListener('click', open);
    link.addEventListener('pointerenter', () => void warm(), { once: true });
    link.addEventListener('focus', () => void warm(), { once: true });
  }
  document.addEventListener('em:talk-request', () => open());
  // Back from Stripe: Talk opens by itself and says whether the minutes are there (talk.ts paidReturn).
  if (new URLSearchParams(window.location.search).has('paid')) open();
}
