/**
 * Talk on a phone, at 390 x 844 and 390 x 664 with a device pixel ratio of 3 and touch: the hero's Talk button on
 * the first screen and three.js untouched until a tap, then requested within a second of the Talk tap; the consent
 * sheet with Emily on top (the stage between the header and the foot of the viewport, the monitor under it, the
 * notice scrolling, Start in view); then the chat sheet against a faked session grant whose voice never connects
 * (Convai and LiveKit are left pending): Emily in full view, the field at least 44 px tall with 16 px type, the round
 * microphone at least 64 px, the guide line gone by 10.8 s, the three choices under More, and the prompt still in
 * view at 390 x 400 (the keyboard's stand-in). No CSP violation and no page error anywhere. Screenshots of the hero,
 * the consent and the chat at both heights go to tests/browser/out, or to --shots <dir>.
 *
 *   node tests/browser/phone-talk.mjs [--base <url>] [--shots <dir>]
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch, outDir, parseArgs, report, until, withBase } from './lib.mjs';

const args = parseArgs();
const shots = args.shots ? resolve(args.shots) : outDir();
mkdirSync(shots, { recursive: true });
const SIZES = [
  { width: 390, height: 844 },
  { width: 390, height: 664 },
];
/** The renderer's chunk: never before a tap on touch, and on its way within a second of the Talk tap. */
const THREE_CHUNK = /\/_astro\/three\./;
const TAP_TO_THREE_MS = 1000;
/** The voice service and its transport: held pending, so the session sits connecting with the chat open. */
const VOICE = /convai\.com|livekit/i;
/** The guide line stays ten seconds and fades for 0.6 (apps/web/src/scripts/talk-guide.ts). */
const GUIDE_GONE_MS = 10800;
const grant = () => ({
  ok: true,
  provider: 'convai',
  token: 't',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  characterId: 'c',
  endUserId: 'e',
  session: { turnsLeft: 60, maxMinutes: 5, secondsLeft: 300 },
});

/** Runs before any page script: CSP violations, as metrics.mjs collects them. */
const instrument = () => {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`);
  });
};

/** Boxes in CSS px, the viewport and the header's foot, read in one go. */
const measure = (page) =>
  page.evaluate(() => {
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
        fontSize: Number.parseFloat(cs.fontSize),
        radius: cs.borderTopLeftRadius,
      };
    };
    return {
      vh: window.innerHeight,
      vw: window.innerWidth,
      header: box('[data-header]'),
      stage: box('[data-being-stage]'),
      monitor: box('[data-monitor]'),
      start: box('[data-talk-start]'),
      input: box('[data-talk-input]'),
      mic: box('[data-talk-mic]'),
      cta: box('.hero-ctas [data-talk-open]'),
    };
  });

const inView = (b, top, bottom) => Boolean(b) && b.visible && b.top >= top - 1 && b.bottom <= bottom + 1;
const px = (n) => (typeof n === 'number' ? Math.round(n) : n);

const { base, close } = await withBase(args);
const browser = await launch();
const rows = [];
const check = (name, ok, detail = '') => rows.push([name, ok ? 'PASS' : 'FAIL', detail]);

try {
  for (const size of SIZES) {
    const tag = `${size.width}x${size.height}`;
    const ctx = await browser.newContext({
      viewport: size,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    try {
      await ctx.addInitScript((value) => {
        try {
          localStorage.setItem('em-theme', value);
        } catch {}
      }, 'dark');
      await ctx.addInitScript(instrument);
      // The mint answers with a grant; the voice service never answers, so the conversation stays connecting.
      let minted = 0;
      await ctx.route('**/api/talk/session', (route) => {
        minted += 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(grant()) });
      });
      await ctx.route(VOICE, () => {});
      await ctx.routeWebSocket(VOICE, () => {});
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const threeAt = [];
      page.on('request', (r) => {
        if (THREE_CHUNK.test(new URL(r.url()).pathname)) threeAt.push(Date.now());
      });

      await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
      // Emily is there from the start on a phone too: three arrives after the LCP and an idle moment, without a tap.
      await page.waitForTimeout(2500);
      for (let i = 0; i < 40 && threeAt.length === 0; i++) await page.waitForTimeout(250);
      check(`${tag} Emily loads without a tap`, threeAt.length > 0, `${threeAt.length} request(s)`);
      const hero = await measure(page);
      check(
        `${tag} Talk button fully above the fold`,
        inView(hero.cta, 0, hero.vh),
        hero.cta ? `top ${px(hero.cta.top)} bottom ${px(hero.cta.bottom)} of ${hero.vh}` : 'no button',
      );
      check(
        `${tag} Talk button at least 56 px tall`,
        Boolean(hero.cta) && hero.cta.height >= 56 - 0.5,
        `${px(hero.cta?.height)} px`,
      );
      const headerLink = await page.evaluate(() => {
        const link = document.querySelector('header [data-talk-open]');
        const r = link?.getBoundingClientRect();
        return r && r.width > 0 ? { width: r.width, height: r.height, text: link.innerText.trim() } : null;
      });
      check(
        `${tag} header Talk link reads "Talk", at least 44 x 44`,
        Boolean(headerLink) &&
          headerLink.width >= 44 - 0.5 &&
          headerLink.height >= 44 - 0.5 &&
          /^talk$/i.test(headerLink.text),
        headerLink ? `${px(headerLink.width)} x ${px(headerLink.height)} "${headerLink.text}"` : 'not shown',
      );
      await page.screenshot({ path: join(shots, `phone-${tag}-hero.png`) });

      // The tap: the consent sheet at once, three.js on its way within a second.
      const tapAt = Date.now();
      await page.locator('.hero-ctas [data-talk-open]').tap();
      await until(() => threeAt.length > 0, { timeout: 3000, interval: 25 });
      const threeDelay = threeAt.length ? threeAt[0] - tapAt : null;
      check(
        `${tag} the Talk tap requests three.js within 1 s`,
        threeDelay !== null && threeDelay <= TAP_TO_THREE_MS,
        threeDelay === null ? 'never requested' : `${threeDelay} ms`,
      );
      await page.locator('[data-talk-consent]').waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForTimeout(600);
      const consent = await measure(page);
      const headerFoot = consent.header?.bottom ?? 0;
      check(
        `${tag} consent: the stage between the header and the viewport's foot`,
        inView(consent.stage, headerFoot, consent.vh),
        `stage ${px(consent.stage?.top)}..${px(consent.stage?.bottom)}, header foot ${px(headerFoot)}, viewport ${consent.vh}`,
      );
      check(
        `${tag} consent: the monitor starts at or below the stage`,
        Boolean(consent.monitor && consent.stage) && consent.monitor.top >= consent.stage.bottom - 1,
        `monitor top ${px(consent.monitor?.top)}, stage bottom ${px(consent.stage?.bottom)}`,
      );
      const scrolls = await page.evaluate(() => {
        const body = document.querySelector('[data-talk-consent-body]');
        if (!body) return null;
        const overflow = body.scrollHeight - body.clientHeight;
        body.scrollTop = 60;
        const moved = body.scrollTop;
        body.scrollTop = 0;
        return { overflow, moved };
      });
      check(
        `${tag} consent: the notice scrolls`,
        Boolean(scrolls) && scrolls.overflow > 4 && scrolls.moved > 0,
        scrolls ? `overflow ${px(scrolls.overflow)} px, scrolled ${px(scrolls.moved)}` : 'no consent body',
      );
      check(
        `${tag} consent: Start in view`,
        inView(consent.start, headerFoot, consent.vh),
        `Start ${px(consent.start?.top)}..${px(consent.start?.bottom)} of ${consent.vh}`,
      );
      const locked = await page.evaluate(() => {
        const monitor = document.querySelector('[data-monitor]');
        const behind = [...document.querySelectorAll('main > *, body > footer, .hero-inner')].filter(
          (el) => monitor && !el.contains(monitor),
        );
        return {
          overflow: getComputedStyle(document.documentElement).overflowY,
          behind: behind.length,
          inert: behind.filter((el) => el.closest('[inert]')).length,
          header: Boolean(document.querySelector('[data-header]')?.closest('[inert]')),
        };
      });
      check(
        `${tag} consent: the page is not locked, it still scrolls under the conversation`,
        locked.overflow !== 'hidden' && locked.inert === 0 && !locked.header,
        `overflow ${locked.overflow}, ${locked.inert} of ${locked.behind} inert, header inert ${locked.header}`,
      );
      await page.screenshot({ path: join(shots, `phone-${tag}-consent.png`) });

      // Start: the grant arrives, the voice never does, the chat view opens and stays connecting.
      await page.locator('[data-talk-start]').tap();
      await page.locator('[data-talk-session]').waitFor({ state: 'visible', timeout: 10000 });
      const chatAt = Date.now();
      await until(() => minted > 0, { timeout: 5000 });
      check(`${tag} chat: the session was requested`, minted > 0, `${minted} mint(s)`);
      await page.waitForTimeout(800);
      const chat = await measure(page);
      const chatHeader = chat.header?.bottom ?? 0;
      check(
        `${tag} chat: the stage fully in view`,
        inView(chat.stage, chatHeader, chat.vh) && Boolean(chat.monitor) && chat.monitor.top >= chat.stage.bottom - 1,
        `stage ${px(chat.stage?.top)}..${px(chat.stage?.bottom)}, monitor from ${px(chat.monitor?.top)}`,
      );
      check(
        `${tag} chat: the field at least 44 px tall with 16 px type`,
        Boolean(chat.input) && chat.input.height >= 44 - 0.5 && chat.input.fontSize >= 16,
        `${px(chat.input?.height)} px, ${chat.input?.fontSize} px type`,
      );
      check(
        `${tag} chat: the microphone round and at least 64 px`,
        Boolean(chat.mic) &&
          chat.mic.width >= 64 - 0.5 &&
          chat.mic.height >= 64 - 0.5 &&
          Math.abs(chat.mic.width - chat.mic.height) < 1 &&
          chat.mic.radius === '50%',
        `${px(chat.mic?.width)} x ${px(chat.mic?.height)}, radius ${chat.mic?.radius}`,
      );
      check(
        `${tag} chat: the prompt and the microphone in view`,
        inView(chat.input, chatHeader, chat.vh) && inView(chat.mic, chatHeader, chat.vh),
        `field ${px(chat.input?.top)}..${px(chat.input?.bottom)}, mic ${px(chat.mic?.top)}..${px(chat.mic?.bottom)}`,
      );
      const guideShown = await page.locator('[data-talk-guide]').isVisible();
      check(`${tag} chat: the guide line shows when the chat opens`, guideShown);
      await page.screenshot({ path: join(shots, `phone-${tag}-chat-guide.png`) });

      // Add a file is beside the microphone, a 44 px target.
      const attach = await page.evaluate(() => {
        const r = document.querySelector('.talk-attach')?.getBoundingClientRect();
        return r ? [Math.round(r.width), Math.round(r.height), r.right <= innerWidth] : null;
      });
      check(
        `${tag} chat: Add a file beside the microphone`,
        !!attach && attach[0] >= 44 && attach[1] >= 44 && attach[2],
        JSON.stringify(attach),
      );
      // More holds the two choices; Escape and a tap outside close it.
      await page.locator('[data-talk-more] > summary').tap();
      const items = await page.evaluate(
        () =>
          [
            ...document.querySelectorAll('[data-talk-more] [data-talk-memory-open], [data-talk-more] [data-talk-end]'),
          ].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height >= 44 - 0.5;
          }).length,
      );
      check(`${tag} chat: More holds What Emily remembers and End`, items === 2, `${items} item(s)`);
      await page.screenshot({ path: join(shots, `phone-${tag}-chat-more.png`) });
      await page.keyboard.press('Escape');
      const closedByEscape = await page.evaluate(() => !document.querySelector('[data-talk-more]')?.open);
      await page.locator('[data-talk-more] > summary').tap();
      // Outside the menu (it opens over the log, so the label in the head row is the safe spot).
      await page.locator('[data-monitor-label]').tap();
      const closedByTap = await page.evaluate(() => !document.querySelector('[data-talk-more]')?.open);
      const memoryShut = await page.evaluate(() => Boolean(document.querySelector('[data-talk-memory]')?.hidden));
      check(
        `${tag} chat: More closes on Escape and on a tap outside`,
        closedByEscape && closedByTap && memoryShut,
        `Escape ${closedByEscape}, tap ${closedByTap}, nothing chosen ${memoryShut}`,
      );
      const stillTalking = await page.evaluate(() => document.documentElement.classList.contains('is-talking'));
      check(`${tag} chat: Escape on More leaves the conversation open`, stillTalking);

      await page.waitForTimeout(Math.max(0, chatAt + GUIDE_GONE_MS - Date.now()));
      const guideGone = !(await page.locator('[data-talk-guide]').isVisible());
      check(`${tag} chat: the guide line is gone by 10.8 s`, guideGone);
      await page.screenshot({ path: join(shots, `phone-${tag}-chat.png`) });

      // The keyboard's stand-in: a 400 px tall viewport keeps the prompt in view.
      await page.setViewportSize({ width: size.width, height: 400 });
      await page.waitForTimeout(500);
      const keyboard = await measure(page);
      check(
        `${tag} at 390x400 the prompt stays in view`,
        inView(keyboard.input, 0, keyboard.vh) && inView(keyboard.mic, 0, keyboard.vh),
        `field ${px(keyboard.input?.top)}..${px(keyboard.input?.bottom)}, mic ${px(keyboard.mic?.top)}..${px(keyboard.mic?.bottom)} of ${keyboard.vh}`,
      );
      check(
        `${tag} at 390x400 the stage still in view`,
        inView(keyboard.stage, keyboard.header?.bottom ?? 0, keyboard.vh),
        `stage ${px(keyboard.stage?.top)}..${px(keyboard.stage?.bottom)}`,
      );
      await page.screenshot({ path: join(shots, `phone-${tag}-keyboard.png`) });

      const csp = await page.evaluate(() => window.__cspViolations);
      check(`${tag} no CSP violations`, csp.length === 0, csp.slice(0, 2).join('; '));
      check(`${tag} no page errors`, errors.length === 0, errors.slice(0, 2).join('; '));
    } catch (error) {
      check(`${tag} run`, false, `threw: ${String(error.message ?? error).slice(0, 200)}`);
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await close();
}

process.exit(report(`phone-talk against ${base}`, rows) ? 1 : 0);
