/**
 * Buying minutes, end to end in the page with the Worker and Stripe stood in for: the free conversations run out
 * and the refusal offers Buy; Buy asks the Worker for a Checkout and goes to Stripe's page; the return
 * (?paid=<id>) opens Talk, confirms the payment and says how many minutes there are, and cleans the address; a
 * cancelled payment says no payment was taken.
 *
 *   node tests/browser/pay-smoke.mjs                 (serves apps/web/dist itself)
 */
import { launch, newPage, parseArgs, report, until, withBase } from './lib.mjs';

const args = parseArgs();
const { base, close } = await withBase(args);
const browser = await launch();
const rows = [];
const check = (name, ok, detail = '') => rows.push([name, ok ? 'PASS' : 'FAIL', detail]);
const STRIPE = 'https://checkout.stripe.com/c/pay/cs_test_smoke';
const REFUSAL = 'That is your three free conversations for today. To keep talking now, buy 60 minutes for £5 below.';

const notice = (page) => page.evaluate(() => document.querySelector('[data-talk-notice]')?.textContent ?? '');

try {
  // Out of free conversations: the refusal and the Buy button.
  {
    const { ctx, page } = await newPage(browser);
    await ctx.route('**/api/talk/session', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: REFUSAL, reason: 'allowance', buy: true }),
      }),
    );
    let checkoutCalls = 0;
    await ctx.route('**/api/pay/checkout', (route) => {
      checkoutCalls += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, url: STRIPE }),
      });
    });
    await ctx.route('https://checkout.stripe.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Stripe</title>' }),
    );
    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.locator('.hero-ctas [data-talk-open]').click();
    await page.locator('[data-talk-start]').click();
    const shown = await until(() => page.evaluate(() => !document.querySelector('[data-talk-buy]')?.hidden), {
      timeout: 15000,
    });
    check('the refusal offers Buy', Boolean(shown), shown ? '' : 'Buy stayed hidden');
    check('the refusal says why', (await notice(page)) === REFUSAL, await notice(page));
    check(
      'Retry gives way to Buy',
      await page.evaluate(() => document.querySelector('[data-talk-retry]')?.hidden === true),
    );
    await page.locator('[data-talk-buy-go]').click();
    await page.waitForURL(STRIPE, { timeout: 10000 }).catch(() => undefined);
    check(
      'Buy goes to Stripe’s page',
      page.url() === STRIPE && checkoutCalls === 1,
      `${page.url()}, ${checkoutCalls} call(s)`,
    );
    await ctx.close();
  }

  // Back from Stripe, paid: Talk opens, the minutes are confirmed, the address is clean.
  {
    const { ctx, page } = await newPage(browser);
    const asked = [];
    await ctx.route('**/api/pay/status**', (route) => {
      asked.push(new URL(route.request().url()).searchParams.get('id'));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, seconds: 3600, added: true }),
      });
    });
    await page.goto(`${base}/?paid=cs_test_smoke#hero`, { waitUntil: 'load' });
    const text = await until(async () => ((await notice(page)).includes('60 minutes') ? notice(page) : ''), {
      timeout: 15000,
    });
    check('the return says the minutes are there', Boolean(text), text || (await notice(page)));
    check('the return asks for this Checkout', asked[0] === 'cs_test_smoke', String(asked[0]));
    check(
      'Talk opens by itself on the return',
      await page.evaluate(() => document.documentElement.classList.contains('is-talking')),
    );
    check('the address is cleaned', !page.url().includes('paid='), page.url());
    await ctx.close();
  }

  // Nothing left as Talk opens: the sentence, Buy and the form at once; the form sent gives 10 minutes and Start.
  {
    const { ctx, page } = await newPage(browser);
    await ctx.route('**/api/talk/allowance', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, left: 0, of: 1, creditMinutes: 0, buy: true, earn: true, message: REFUSAL }),
      }),
    );
    let sent = null;
    await ctx.route('**/api/form/minutes', (route) => {
      sent = JSON.parse(route.request().postData() ?? '{}');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, minutes: 10 }),
      });
    });
    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.locator('.hero-ctas [data-talk-open]').click();
    const early = await until(
      () =>
        page.evaluate(() => ({
          buy: !document.querySelector('[data-talk-buy]')?.hidden,
          earn: !document.querySelector('[data-talk-earn]')?.hidden,
          start: !document.querySelector('[data-talk-start]')?.hidden,
        })),
      { timeout: 10000 },
    );
    await page.waitForTimeout(500);
    const now = await page.evaluate(() => ({
      buy: !document.querySelector('[data-talk-buy]')?.hidden,
      earn: !document.querySelector('[data-talk-earn]')?.hidden,
      start: !document.querySelector('[data-talk-start]')?.hidden,
    }));
    check(
      'nothing left: told as Talk opens, Buy and the form, no Start',
      now.buy && now.earn && !now.start,
      JSON.stringify(early && now),
    );
    await page.locator('[data-talk-earn-open]').click();
    await page.fill('[data-talk-earn-form] [name=name]', 'Ada Lovelace');
    await page.fill('[data-talk-earn-form] [name=email]', 'ada@example.com');
    await page.check('[data-talk-earn-form] [name=role][value=investor]');
    await page.check('[data-talk-earn-form] [name=agree]');
    await page.locator('[data-talk-earn-send]').click();
    const thanks = await until(async () => ((await notice(page)).includes('10 minutes') ? notice(page) : ''), {
      timeout: 10000,
    });
    check(
      'the form sends its fields',
      sent?.email === 'ada@example.com' && sent?.role === 'investor' && sent?.agree === 'yes',
      JSON.stringify(sent),
    );
    check(
      'the form gives 10 minutes and Start comes back',
      Boolean(thanks) && (await page.evaluate(() => !document.querySelector('[data-talk-start]')?.hidden)),
      thanks,
    );
    await ctx.close();
  }

  // Back from Stripe, cancelled.
  {
    const { ctx, page } = await newPage(browser);
    await page.goto(`${base}/?paid=cancelled#hero`, { waitUntil: 'load' });
    const text = await until(async () => ((await notice(page)) ? notice(page) : ''), { timeout: 15000 });
    check('a cancelled payment says none was taken', text === 'No payment was taken.', text);
    await ctx.close();
  }
} finally {
  await browser.close();
  await close();
}

process.exitCode = report(`pay smoke against ${base}`, rows) ? 1 : 0;
