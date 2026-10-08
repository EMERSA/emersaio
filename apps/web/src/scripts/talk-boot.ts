/**
 * The only Talk code on the page before a tap: it opens the sheet and then loads scripts/talk.ts, the SDK-free
 * shell that fetches @emersa/being/talk only when the visitor taps Start talking. Phase 1 renders the sheet hidden
 * and the CTA hidden, so this does nothing there.
 */
const sheet = document.querySelector('[data-talk-sheet]');

function open(event?: Event): void {
  if (!(sheet instanceof HTMLDialogElement) || sheet.hidden) return;
  event?.preventDefault();
  if (!sheet.open) {
    try {
      sheet.showModal();
    } catch {
      return;
    }
  }
  void import('./talk.ts').then((talk) => talk.wire(sheet));
}

if (sheet instanceof HTMLDialogElement && !sheet.hidden) {
  for (const link of document.querySelectorAll('[data-talk-open]')) link.addEventListener('click', open);
  document.addEventListener('em:talk-open', () => open());
}
