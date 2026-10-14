/**
 * The only tools code on the page before an interaction. It fills the QR colour inputs from the --qr-fg and --qr-bg
 * tokens (the markup carries no colour literal) and loads scripts/qr.ts on the first focus or tap inside the QR
 * card. Nothing of qrcode is reachable before that gesture.
 */
const qrCard = document.querySelector<HTMLElement>('[data-qr]');

if (qrCard) {
  const tokens = getComputedStyle(document.documentElement);
  for (const input of qrCard.querySelectorAll<HTMLInputElement>('[data-qr-color]')) {
    const value = tokens.getPropertyValue(input.dataset.qrColor === 'bg' ? '--qr-bg' : '--qr-fg').trim();
    if (value) input.value = value;
  }
  let loading = false;
  const load = (): void => {
    if (loading) return;
    loading = true;
    void import('./qr.ts').then((qr) => qr.mountQr(qrCard));
  };
  qrCard.addEventListener('focusin', load, { once: true });
  qrCard.addEventListener('pointerdown', load, { once: true });
}

export {};
