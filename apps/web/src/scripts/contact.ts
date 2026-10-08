/**
 * Progressive enhancement for the contact form (components/Contact.astro).
 *
 * Without this file the form still works: a plain POST to /api/contact, which the Worker answers with a redirect to
 * /contact/sent or /contact/error. With it, the page preselects the topic a link asked for (?topic=emily), stamps the
 * moment the form appeared (the Worker treats anything filled in faster than a person could as a bot), submits in
 * place and shows the outcome inline. Every word shown comes from the markup, never from this file.
 */

interface Reply {
  ok?: boolean;
  error?: string;
}

/** Topic values are short lowercase words; anything else in the query string is ignored. */
const TOPIC = /^[a-z]{1,20}$/;

const preselectTopic = (select: HTMLSelectElement): void => {
  const wanted = new URLSearchParams(window.location.search).get('topic') ?? '';
  if (!TOPIC.test(wanted)) return;
  if (Array.from(select.options).some((option) => option.value === wanted)) select.value = wanted;
};

/** The Worker reads urlencoded bodies; FormData would arrive as multipart. */
const encode = (form: HTMLFormElement): URLSearchParams => {
  const body = new URLSearchParams();
  for (const [key, value] of new FormData(form)) {
    if (typeof value === 'string') body.append(key, value);
  }
  return body;
};

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const reveal = (element: HTMLElement): void => {
  element.hidden = false;
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
};

export function initContactForm(root: ParentNode = document): void {
  const form = root.querySelector<HTMLFormElement>('[data-contact-form]');
  // The script can be pulled in by more than one bundle; the second run must be a no-op.
  if (!form || form.dataset.enhanced === 'true') return;
  form.dataset.enhanced = 'true';

  const started = form.querySelector<HTMLInputElement>('[data-contact-started]');
  if (started) started.value = String(Date.now());

  const topic = form.querySelector<HTMLSelectElement>('[data-contact-topic]');
  if (topic) preselectTopic(topic);

  const submit = form.querySelector<HTMLButtonElement>('[data-contact-submit]');
  const status = form.querySelector<HTMLElement>('[data-contact-status]');
  const done = form.parentElement?.querySelector<HTMLElement>('[data-contact-done]') ?? null;
  let busy = false;

  const setBusy = (value: boolean): void => {
    busy = value;
    submit?.setAttribute('aria-busy', String(value));
  };

  const showError = (message: string | undefined): void => {
    setBusy(false);
    if (!status) return;
    status.textContent = message || form.dataset.errorFallback || '';
    reveal(status);
  };

  const showSent = (): void => {
    setBusy(false);
    form.hidden = true;
    if (done) reveal(done);
  };

  form.addEventListener('submit', (event) => {
    // Native validation has already passed by the time submit fires (the form carries no novalidate).
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    if (status) status.hidden = true;

    void (async () => {
      let response: Response;
      try {
        response = await fetch(form.action, {
          method: 'POST',
          headers: { accept: 'application/json' },
          body: encode(form),
        });
      } catch {
        // Offline, blocked or unreachable: let the browser post the form the ordinary way.
        setBusy(false);
        form.submit();
        return;
      }

      // A Worker that answered with the no-script redirect instead of JSON: follow it.
      if (response.redirected) {
        window.location.assign(response.url);
        return;
      }

      const payload = (await response.json().catch(() => null)) as Reply | null;
      if (response.ok && payload?.ok) showSent();
      else showError(payload?.error);
    })();
  });
}

initContactForm();
