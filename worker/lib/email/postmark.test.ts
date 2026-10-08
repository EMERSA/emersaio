import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mockFetch, noFetch } from '../../test/harness.ts';
import { emailAdapter } from './index.ts';
import { DEFAULT_FROM, POSTMARK_API, postmark } from './postmark.ts';

let restore = (): void => {};
afterEach(() => {
  restore();
  restore = () => {};
});

const message = {
  to: 'inbox@example.com',
  subject: 'Hello\r\nthere',
  text: 'Body',
  replyTo: 'ada@example.com',
  tag: 't',
};

test('the adapter is picked by the token: Postmark with one, the unconfigured Cloudflare adapter without', async () => {
  assert.equal(emailAdapter({ POSTMARK_TOKEN: 'pm' }).name, 'postmark');
  assert.equal(emailAdapter({ POSTMARK_TOKEN: 'pm' }).configured, true);
  const none = emailAdapter({});
  assert.equal(none.name, 'cloudflare');
  assert.equal(none.configured, false);
  restore = noFetch();
  assert.equal((await none.send(message)).ok, false);
});

test('a message goes to the Postmark API with the token, one-line headers and no HTML body', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  restore = mockFetch(async (url, init) => {
    seen.push({ url, init });
    return Response.json({ MessageID: 'abc', ErrorCode: 0, Message: 'OK' });
  });
  const result = await postmark({ POSTMARK_TOKEN: 'pm-1' }).send(message);
  assert.deepEqual(result, { ok: true, id: 'abc' });
  assert.equal(seen[0]?.url, POSTMARK_API);
  assert.equal(new Headers(seen[0]?.init.headers).get('X-Postmark-Server-Token'), 'pm-1');
  assert.deepEqual(JSON.parse(String(seen[0]?.init.body)), {
    From: DEFAULT_FROM,
    To: 'inbox@example.com',
    ReplyTo: 'ada@example.com',
    Subject: 'Hello  there',
    TextBody: 'Body',
    MessageStream: 'outbound',
    Tag: 't',
  });
  await postmark({ POSTMARK_TOKEN: 'pm-1', POSTMARK_FROM: 'Me <me@example.com>' }).send({
    ...message,
    replyTo: undefined,
  });
  const second = JSON.parse(String(seen[1]?.init.body)) as Record<string, unknown>;
  assert.equal(second.From, 'Me <me@example.com>');
  assert.ok(!('ReplyTo' in second));
});

test('refusals keep only the codes, so the result can be logged', async () => {
  restore = mockFetch(async () =>
    Response.json({ ErrorCode: 300, Message: "Invalid 'To' address: 'x@y'" }, { status: 422 }),
  );
  assert.deepEqual(await postmark({ POSTMARK_TOKEN: 'pm' }).send(message), {
    ok: false,
    error: 'Postmark 422 (code 300)',
  });
  restore();
  restore = mockFetch(async () => Response.json({ ErrorCode: 10, Message: 'Bad token' }, { status: 401 }));
  assert.equal((await postmark({ POSTMARK_TOKEN: 'pm' }).send(message)).error, 'Postmark 401 (code 10)');
  restore();
  restore = mockFetch(async () => new Response('gateway', { status: 502 }));
  assert.equal((await postmark({ POSTMARK_TOKEN: 'pm' }).send(message)).error, 'Postmark 502 (code none)');
  restore();
  restore = mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  assert.equal((await postmark({ POSTMARK_TOKEN: 'pm' }).send(message)).error, 'Postmark unreachable (TypeError)');
  restore();
  restore = noFetch();
  assert.equal((await postmark({}).send(message)).ok, false, 'no token, no call');
});
