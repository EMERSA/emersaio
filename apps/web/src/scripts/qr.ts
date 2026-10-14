/**
 * The zero-knowledge QR code generator (ported from sqncy's qr.ts). Every byte the visitor types is processed in
 * their own browser: nothing is sent anywhere, nothing is written to storage, nothing is logged. The codes are
 * static (the data sits in the pattern itself), so they never expire and never pass through a redirect. "Zero
 * knowledge" here means the site has zero knowledge of the data: client-side zero retention, not a cryptographic
 * proof. Loaded by tools-boot.ts on the first focus or tap inside the card; the copy rides on the card's data
 * attributes; the hooks are data-qr-*; downloads are data: URLs.
 */
import QRCode, { type QRCodeErrorCorrectionLevel } from 'qrcode';

type Mode = 'link' | 'text' | 'wifi' | 'contact' | 'email';
type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const MODES: readonly Mode[] = ['link', 'text', 'wifi', 'contact', 'email'];
const RENDER_DELAY_MS = 120;
/** Transparent in CSS hex, the one colour value the encoder needs that no token can express. */
const TRANSPARENT = `#${'0'.repeat(8)}`;

interface Elements {
  root: HTMLElement;
  form: HTMLFormElement;
  canvas: HTMLCanvasElement;
  status: HTMLElement;
  png: HTMLAnchorElement;
  svg: HTMLAnchorElement;
  wipe: HTMLButtonElement | null;
  modes: HTMLInputElement[];
  panels: HTMLElement[];
  sizeValue: HTMLElement | null;
}

/** Escapes the reserved characters of the Wi-Fi and vCard grammars. */
const esc = (value: string): string => value.replace(/([\\;,:"])/g, '\\$1');

export function mountQr(root: HTMLElement): void {
  if (root.dataset.qrMounted) return;
  root.dataset.qrMounted = 'true';
  const form = root.querySelector<HTMLFormElement>('[data-qr-form]');
  const canvas = root.querySelector<HTMLCanvasElement>('[data-qr-canvas]');
  const status = root.querySelector<HTMLElement>('[data-qr-status]');
  const png = root.querySelector<HTMLAnchorElement>('[data-qr-png]');
  const svg = root.querySelector<HTMLAnchorElement>('[data-qr-svg]');
  if (!form || !canvas || !status || !png || !svg) return;
  const el: Elements = {
    root,
    form,
    canvas,
    status,
    png,
    svg,
    wipe: root.querySelector<HTMLButtonElement>('[data-qr-wipe]'),
    modes: Array.from(root.querySelectorAll<HTMLInputElement>('[data-qr-mode]')),
    panels: Array.from(root.querySelectorAll<HTMLElement>('[data-qr-panel]')),
    sizeValue: root.querySelector<HTMLElement>('[data-qr-size-value]'),
  };

  const field = (name: string): Field | null => root.querySelector<Field>(`[data-qr-field="${name}"]`);
  const text = (name: string): string => field(name)?.value.trim() ?? '';
  const checked = (name: string): boolean => {
    const input = field(name);
    return input instanceof HTMLInputElement && input.checked;
  };
  const colour = (which: 'fg' | 'bg'): string =>
    root.querySelector<HTMLInputElement>(`[data-qr-color="${which}"]`)?.value ?? '';
  const copy = (key: 'Empty' | 'Ready' | 'Wiped' | 'TooLong'): string => root.dataset[`qrStatus${key}`] ?? '';

  const mode = (): Mode => {
    const picked = el.modes.find((input) => input.checked)?.value;
    return MODES.find((m) => m === picked) ?? 'link';
  };

  const payload = (): string => {
    switch (mode()) {
      case 'link': {
        const value = text('url');
        if (!value) return '';
        // A scheme makes scanners open it as a URL.
        return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
      }
      case 'text':
        return text('text');
      case 'wifi': {
        const ssid = text('ssid');
        if (!ssid) return '';
        const auth = text('auth');
        if (auth === 'nopass') return `WIFI:T:nopass;S:${esc(ssid)};;`;
        return `WIFI:T:${auth};S:${esc(ssid)};P:${esc(text('password'))};H:${checked('hidden')};;`;
      }
      case 'contact': {
        const first = text('first');
        const last = text('last');
        if (!first && !last) return '';
        // vCard 3.0: the contact format scanners agree on most widely.
        const lines = [
          'BEGIN:VCARD',
          'VERSION:3.0',
          `N:${esc(last)};${esc(first)}`,
          `FN:${esc(`${first} ${last}`.trim())}`,
        ];
        const org = text('org');
        const tel = text('tel');
        const email = text('cemail');
        const url = text('curl');
        if (org) lines.push(`ORG:${esc(org)}`);
        if (tel) lines.push(`TEL;TYPE=CELL:${tel}`);
        if (email) lines.push(`EMAIL:${email}`);
        if (url) lines.push(`URL:${url}`);
        lines.push('END:VCARD');
        return lines.join('\n');
      }
      case 'email': {
        const to = text('to');
        if (!to) return '';
        const params: string[] = [];
        const subject = text('subject');
        const body = text('body');
        if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
        if (body) params.push(`body=${encodeURIComponent(body)}`);
        return `mailto:${to}${params.length ? `?${params.join('&')}` : ''}`;
      }
    }
  };

  const options = () => {
    const ec = text('ec') as QRCodeErrorCorrectionLevel;
    const size = Number.parseInt(text('size'), 10) || 512;
    return {
      errorCorrectionLevel: ec || 'M',
      margin: 2,
      width: size,
      color: { dark: colour('fg'), light: checked('transparent') ? TRANSPARENT : colour('bg') },
    };
  };

  const clearCanvas = (): void => {
    el.canvas.getContext('2d')?.clearRect(0, 0, el.canvas.width, el.canvas.height);
    el.canvas.style.width = '';
    el.canvas.style.height = '';
  };
  const disableDownloads = (): void => {
    for (const link of [el.png, el.svg]) {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
    }
  };

  let token = 0;
  const render = async (): Promise<void> => {
    const mine = ++token;
    const data = payload();
    if (!data) {
      clearCanvas();
      disableDownloads();
      el.status.textContent = copy('Empty');
      return;
    }
    const opts = options();
    try {
      await QRCode.toCanvas(el.canvas, data, opts);
      if (mine !== token) return;
      // The encoder sizes the element to the export resolution through the CSSOM; the stylesheet's preview size wins.
      el.canvas.style.width = '';
      el.canvas.style.height = '';
      el.png.href = el.canvas.toDataURL('image/png');
      el.png.setAttribute('aria-disabled', 'false');
      const markup = await QRCode.toString(data, { ...opts, type: 'svg' });
      if (mine !== token) return;
      el.svg.href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
      el.svg.setAttribute('aria-disabled', 'false');
      el.status.textContent = copy('Ready').replace('{n}', String(data.length));
    } catch {
      if (mine !== token) return;
      clearCanvas();
      disableDownloads();
      el.status.textContent = copy('TooLong');
    }
  };

  let timer = 0;
  const schedule = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void render(), RENDER_DELAY_MS);
  };

  const showMode = (): void => {
    const current = mode();
    for (const panel of el.panels) panel.hidden = panel.dataset.qrPanel !== current;
    void render();
  };

  const showSize = (): void => {
    if (el.sizeValue) el.sizeValue.textContent = `${text('size')} px`;
  };

  const wipe = (): void => {
    for (const input of el.form.querySelectorAll<Field>('[data-qr-field]')) {
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = false;
      else if (input instanceof HTMLInputElement && input.type === 'range') continue;
      else if (input instanceof HTMLSelectElement) continue;
      else input.value = '';
    }
    void render().then(() => {
      el.status.textContent = copy('Wiped');
    });
  };

  for (const input of el.modes) input.addEventListener('change', showMode);
  el.form.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.dataset.qrField === 'size') showSize();
    schedule();
  });
  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    void render();
  });
  el.wipe?.addEventListener('click', wipe);
  // A download that is not ready does nothing.
  for (const link of [el.png, el.svg]) {
    link.addEventListener('click', (event) => {
      if (link.getAttribute('aria-disabled') === 'true' || !link.hasAttribute('href')) event.preventDefault();
    });
  }
  showSize();
  showMode();
}
