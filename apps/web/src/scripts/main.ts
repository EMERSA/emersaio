/**
 * The site script every page loads: the theme toggle, the mobile menu's close behaviour, reveal-on-scroll (opacity
 * only, whole sections, once), rel=noopener on outbound links and the partner marquee's pause control. Nothing else
 * lives here so content pages stay tiny; the being is mounted by being-mount.ts on the pages that ask for it. A module
 * script runs after the document has been parsed, so there is no load event to wait for.
 */

type Theme = 'dark' | 'light';

const THEME_KEY = 'em-theme';
const MENU_BREAKPOINT = '(min-width: 960px)';
const root = document.documentElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const currentTheme = (): Theme => (root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

/** The choice kept in storage, if there is one; theme-boot.js reads the same key before the first paint. */
function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

/** The address bar follows --bg, read from the live tokens so the colour values stay in tokens.css. */
function syncThemeColor(): void {
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (!bg) return;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = bg;
}

function initTheme(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  if (!button) return;
  // The button is labelled "Dark mode", so pressed means dark.
  const reflect = (): void => button.setAttribute('aria-pressed', String(currentTheme() === 'dark'));
  const apply = (next: Theme): void => {
    root.setAttribute('data-theme', next);
    reflect();
    syncThemeColor();
    document.dispatchEvent(new CustomEvent<Theme>('em:theme', { detail: next, bubbles: true }));
  };
  reflect();
  button.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage can be blocked (private mode, site data off); the choice then lasts for this page only.
    }
    apply(next);
  });
  // A page restored from the back/forward cache still wears the theme it was frozen with, while a switch made on
  // the page visited in between sits in storage: the stored choice wins, and the being and the cloud hear of it.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    const stored = storedTheme();
    if (stored && stored !== currentTheme()) apply(stored);
  });
}

function initMenu(): void {
  const menu = document.querySelector<HTMLDetailsElement>('[data-menu]');
  if (!menu) return;
  const close = (): void => {
    menu.open = false;
  };
  // A tap on a link closes the sheet; a same-page anchor would otherwise leave it covering its target.
  menu.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) close();
  });
  // Escape closes the sheet. The listener runs in the capture phase and claims the event, so the tour's own Escape
  // (which ends the tour) never acts on the same press.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !menu.open) return;
      event.preventDefault();
      close();
      menu.querySelector<HTMLElement>('summary')?.focus();
    },
    { capture: true },
  );
  // The sheet covers the page, so focus leaving it (Tab past the last link, Shift+Tab before the first) closes it:
  // the element that takes the focus is never hidden underneath.
  menu.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (menu.open && next instanceof Node && !menu.contains(next)) close();
  });
  // The sheet exists only under the breakpoint; forget an open state once the viewport grows past it.
  const wide = window.matchMedia(MENU_BREAKPOINT);
  wide.addEventListener('change', () => {
    if (wide.matches) close();
  });
}

function initReveal(): void {
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
  if (items.length === 0) return;
  const show = (element: Element): void => {
    element.classList.remove('is-pending');
    element.classList.add('is-in');
  };
  if (reducedMotion || !('IntersectionObserver' in window)) {
    for (const item of items) show(item);
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        show(entry.target);
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px 20% 0px', threshold: 0.05 },
  );
  // Nothing is hidden until this runs, and only what sits below the first screen waits for the scroll: a crawler,
  // a print, a screenshot or a restored scroll position all see the page without the observer ever firing. Every
  // box is measured before the first class is added, so the loop forces one layout rather than one per element.
  const fold = window.innerHeight;
  const below = items.map((item) => item.getBoundingClientRect().top > fold);
  items.forEach((item, index) => {
    if (below[index]) {
      item.classList.add('is-pending');
      observer.observe(item);
    } else {
      show(item);
    }
  });
}

function initExternalLinks(): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href^="http"]')) {
    if (link.host === window.location.host) continue;
    const rel = new Set(link.rel.split(' ').filter(Boolean));
    rel.add('noopener');
    link.rel = [...rel].join(' ');
  }
}

/**
 * The partner marquee moves on its own for longer than five seconds, so it needs a control that stops it. The button
 * is hidden in the markup (it can do nothing without scripts) and stays hidden under reduced motion, where nothing
 * moves. Its label never changes; aria-pressed carries the state.
 */
function initMarquee(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-marquee-toggle]');
  const marquee = document.querySelector<HTMLElement>('[data-marquee]');
  if (!button || !marquee || reducedMotion) return;
  button.hidden = false;
  button.addEventListener('click', () => {
    const paused = marquee.classList.toggle('is-paused');
    button.setAttribute('aria-pressed', String(paused));
  });
}

initTheme();
initMenu();
initReveal();
initExternalLinks();
initMarquee();

// Marks the file as a module for the type checker without exporting anything.
export {};
