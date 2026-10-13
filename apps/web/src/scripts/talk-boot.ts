/**
 * The only Talk code on the page before a tap: it shows the monitor's consent view over the being and then loads
 * scripts/talk.ts, the SDK-free shell that fetches @emersa/being/talk only when the visitor taps Start talking.
 * Every [data-talk-open] link (the hero button, the header link, Emily's card) opens it; their href is the mailto
 * fallback for a page without scripts. Opening stops a running tour (being-mount.ts listens for em:talk-open).
 */
const panel = document.querySelector<HTMLElement>('[data-monitor]');

function open(event?: Event): void {
  if (!panel) return;
  event?.preventDefault();
  document.dispatchEvent(new CustomEvent('em:talk-open'));
  const hero = document.querySelector('#hero');
  if (hero && hero.getBoundingClientRect().bottom < window.innerHeight * 0.5) {
    hero.scrollIntoView({
      block: 'start',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }
  void import('./talk.ts').then((talk) => talk.open(panel));
}

if (panel) {
  for (const link of document.querySelectorAll('[data-talk-open]')) link.addEventListener('click', open);
  document.addEventListener('em:talk-request', () => open());
}
