/**
 * The scripted tour on "/": Start shows the tour bar, the captions change as Emily speaks, Next advances the
 * progress readout to "2 / 9", Escape ends the tour. The dock is checked as the brief describes it: a flat panel
 * with no blur, the "AI-generated voice" line in place, Back, Next, Replay, Mute and End tour each at least 44px
 * tall, and the highlighted step ringed by a 1px outline. Then "/?tour=<stop>" under reduced motion resumes a stop
 * without three.js. Captions-only is enough here: a build without voice clips passes, a tour that never starts
 * does not.
 *
 *   node tests/browser/tour-smoke.mjs [--base <url>]
 */
import { join } from 'node:path';
import { launch, newPage, outDir, parseArgs, report, until, withBase } from './lib.mjs';

const args = parseArgs();
const { base, close } = await withBase(args);
const browser = await launch();
const shots = outDir();
const rows = [];
const check = (name, ok, detail) => rows.push([name, ok ? 'PASS' : 'FAIL', detail]);

/** The "n / total" readout, from a dedicated hook when the bar has one, else from the bar's text. */
async function progress(bar) {
  const explicit = bar.locator('[data-tour-progress]');
  if (await explicit.count()) return ((await explicit.first().textContent()) ?? '').trim();
  const text = await bar.innerText().catch(() => '');
  const m = text.match(/(\d+)\s*(?:\/|of)\s*(\d+)/);
  return m ? `${m[1]} / ${m[2]}` : '';
}

try {
  const { ctx, page } = await newPage(browser, { width: 1280, height: 900, theme: 'dark' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(1500);
    const start = page.locator('[data-tour-start]').first();
    const hasStart = (await start.count()) > 0 && (await start.isVisible());
    check('start control present', hasStart, hasStart ? 'visible [data-tour-start]' : 'no visible [data-tour-start]');
    if (hasStart) {
      await start.click();
      const bar = page.locator('[data-tour]').first();
      const barShown = await until(() => bar.isVisible().catch(() => false), { timeout: 5000 });
      check(
        'tour bar visible after Start',
        barShown,
        barShown ? '[data-tour] visible' : '[data-tour] never became visible',
      );

      // The dock: flat, no blur, the voice line, 44px buttons with their labels.
      const dock = await page.evaluate(() => {
        const dockEl = document.querySelector('[data-being-dock]');
        const cs = dockEl ? getComputedStyle(dockEl) : null;
        const label = (selector) => {
          const el = document.querySelector(selector);
          return el ? { text: (el.textContent ?? '').trim(), height: el.getBoundingClientRect().height } : null;
        };
        const voice = document.querySelector('[data-voice-label]');
        return {
          present: Boolean(dockEl),
          position: cs?.position,
          backdrop: cs ? cs.backdropFilter || cs.webkitBackdropFilter || 'none' : 'none',
          voice: voice ? (voice.textContent ?? '').trim() : null,
          buttons: {
            back: label('[data-tour-back]'),
            next: label('[data-tour-next]'),
            replay: label('[data-tour-replay]'),
            mute: label('[data-tour-mute]'),
            end: label('[data-tour-end]'),
          },
        };
      });
      check(
        'dock is a flat pinned panel',
        dock.present && dock.position === 'fixed' && dock.backdrop === 'none',
        `position=${dock.position} backdrop-filter=${dock.backdrop}`,
      );
      check('dock carries the voice disclosure', dock.voice === 'AI-generated voice', `"${dock.voice}"`);
      const wanted = { back: 'Back', next: 'Next', replay: 'Replay', mute: 'Mute', end: 'End tour' };
      const wrong = Object.entries(wanted).filter(([key, text]) => {
        const b = dock.buttons[key];
        return !b || b.text !== text || b.height < 44;
      });
      check(
        'dock buttons labelled and at least 44px',
        wrong.length === 0,
        wrong.length
          ? wrong.map(([key]) => `${key}: ${JSON.stringify(dock.buttons[key])}`).join('; ')
          : Object.values(dock.buttons)
              .map((b) => `${b.text} ${Math.round(b.height)}px`)
              .join(', '),
      );

      const captions = page.locator('[data-captions]').first();
      const seen = [];
      const started = Date.now();
      while (Date.now() - started < 12000 && seen.length < 3) {
        const text = ((await captions.textContent().catch(() => '')) ?? '').trim();
        if (text && seen.at(-1) !== text) seen.push(text);
        await page.waitForTimeout(120);
      }
      check(
        'captions change at least twice',
        seen.length >= 3,
        `${Math.max(0, seen.length - 1)} change(s); last: "${(seen.at(-1) ?? '').slice(0, 60)}"`,
      );
      await page.screenshot({ path: join(shots, 'tour-running.png') });

      const before = await progress(bar);
      const next = page.locator('[data-tour-next]').first();
      if (await next.count()) {
        await next.click();
        const after = await until(
          async () => {
            const now = await progress(bar);
            return now && now !== before ? now : '';
          },
          { timeout: 5000 },
        );
        check('progress advances on Next', Boolean(after), `"${before}" -> "${after || before}"`);
        check('progress reads "2 / 9" at the second stop', after === '2 / 9', `"${after || before}"`);
        // The highlighted step: a 1px ring, not a 2px box.
        const ring = await until(
          () =>
            page.evaluate(() => {
              const el = document.querySelector('.is-highlighted');
              if (!el) return null;
              const cs = getComputedStyle(el);
              return { width: cs.outlineWidth, style: cs.outlineStyle, offset: cs.outlineOffset };
            }),
          { timeout: 4000 },
        );
        check(
          'highlighted step has a 1px ring',
          Boolean(ring) && ring.width === '1px' && ring.style === 'solid',
          ring ? `outline ${ring.width} ${ring.style} at ${ring.offset}` : 'no .is-highlighted element',
        );
      } else check('progress advances on Next', false, 'no [data-tour-next]');

      await page.keyboard.press('Escape');
      const ended = await until(
        async () => {
          const visible = await bar.isVisible().catch(() => false);
          const touring = await page.evaluate(() => Boolean(document.querySelector('.is-touring')));
          return !visible || !touring;
        },
        { timeout: 4000 },
      );
      check(
        'Escape ends the tour',
        ended,
        ended ? 'tour bar hidden or is-touring cleared' : 'still touring after Escape',
      );
    }
    check('no page errors during the tour', errors.length === 0, errors[0] ?? 'none');
  } finally {
    await ctx.close();
  }

  // Deep link under reduced motion: the poster path, captions only, no WebGL needed.
  {
    const { ctx: ctx2, page: page2 } = await newPage(browser, {
      width: 1280,
      height: 900,
      theme: 'light',
      reducedMotion: 'reduce',
    });
    try {
      await page2.goto(`${base}/?tour=emily`, { waitUntil: 'load', timeout: 60000 });
      const bar = page2.locator('[data-tour]').first();
      const shown = await until(() => bar.isVisible().catch(() => false), { timeout: 6000 });
      const caption = shown
        ? (
            (await page2
              .locator('[data-captions]')
              .first()
              .textContent()
              .catch(() => '')) ?? ''
          ).trim()
        : '';
      check(
        '/?tour=emily resumes under reduced motion',
        shown,
        shown ? `caption: "${caption.slice(0, 60)}"` : 'tour bar not shown',
      );
      await page2.screenshot({ path: join(shots, 'tour-resume-reduced-motion.png') });
    } catch (error) {
      check(
        '/?tour=emily resumes under reduced motion',
        false,
        `threw: ${String(error.message ?? error).slice(0, 160)}`,
      );
    } finally {
      await ctx2.close();
    }
  }
} finally {
  await browser.close();
  await close();
}

process.exit(report(`tour smoke against ${base}`, rows) ? 1 : 0);
