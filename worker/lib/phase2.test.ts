/**
 * The Phase 2 helpers on their own: the Convai calls, SSE framing, the markers, distillation, PDF text and the
 * cookie helpers.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mockFetch } from '../test/harness.ts';
import { MarkerParser, parseMarker } from './actions.ts';
import {
  CONSENT_VERSION,
  clearVisitorCookie,
  cookieVisitor,
  endUserId,
  newVisitorId,
  readCookie,
  signVisitorId,
  visitorCookie,
} from './consent.ts';
import { apiBase, CONNECT_URL, CONVAI_API, ConvaiError, connect, deleteMemories, TOKEN_TTL_MS } from './convai.ts';
import { distill } from './distill.ts';
import { contentText, pdfText } from './pdf.ts';
import { frame, readSse, sseStream } from './sse.ts';

let restore = (): void => {};
afterEach(() => {
  restore();
  restore = () => {};
});

test('connect posts {} with the key header and answers the token with a one-hour expiry', async () => {
  let seen: { url: string; key: string | null; body: string } | undefined;
  restore = mockFetch((url, init) => {
    seen = { url, key: new Headers(init.headers).get('convai-api-key'), body: String(init.body) };
    return Response.json({ apiAuthToken: 'abc' });
  });
  const at = Date.UTC(2026, 9, 8);
  assert.deepEqual(await connect('k-1', at), { token: 'abc', expiresAt: new Date(at + TOKEN_TTL_MS).toISOString() });
  assert.deepEqual(seen, { url: CONNECT_URL, key: 'k-1', body: '{}' });
});

test('connect fails with a typed error: 401, 500, timeout, network, bad body', async () => {
  const kind = async (handler: () => Response | Promise<Response>): Promise<string> => {
    restore();
    restore = mockFetch(handler);
    try {
      await connect('k');
      return 'none';
    } catch (error) {
      assert.ok(error instanceof ConvaiError);
      return error.kind;
    }
  };
  assert.equal(await kind(() => new Response('', { status: 401 })), 'unauthorized');
  assert.equal(await kind(() => new Response('', { status: 500 })), 'upstream');
  assert.equal(
    await kind(() => {
      throw new DOMException('t', 'TimeoutError');
    }),
    'timeout',
  );
  assert.equal(
    await kind(() => {
      throw new TypeError('down');
    }),
    'network',
  );
  assert.equal(await kind(() => new Response('nope')), 'bad-response');
  assert.equal(await kind(() => Response.json({ token: 'x' })), 'bad-response');
});

test('connect is cut off after its timeout', async () => {
  restore = mockFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  );
  const started = Date.now();
  await assert.rejects(connect('k'), (e: unknown) => e instanceof ConvaiError && e.kind === 'timeout');
  assert.ok(Date.now() - started < 7000);
});

test('deleteMemories is best effort', async () => {
  restore = mockFetch(() => new Response(null, { status: 404 }));
  assert.equal(await deleteMemories('k', 'u'), false);
  restore();
  restore = mockFetch(() => {
    throw new TypeError('down');
  });
  assert.equal(await deleteMemories('k', 'u'), false);
});

test('SSE frames are one JSON line each, and a stream reads back in order', async () => {
  assert.equal(frame('token', { text: 'a\nb' }), 'event: token\ndata: {"text":"a\\nb"}\n\n');
  const { writer, response } = sseStream();
  await writer.send('token', { text: 'hi' });
  await writer.send('done', {});
  await writer.close();
  await writer.send('token', { text: 'late' });
  assert.equal(await response.text(), 'event: token\ndata: {"text":"hi"}\n\nevent: done\ndata: {}\n\n');
});

test('readSse copes with lines split across chunks', async () => {
  const parts = ['data: {"a"', ':1}\n\n: comment\nda', 'ta: [DONE]\n'];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  });
  const got: string[] = [];
  for await (const d of readSse(body)) got.push(d);
  assert.deepEqual(got, ['{"a":1}', '[DONE]']);
});

test('markers: only whitelisted shapes, split markers held, text never leaks a marker', () => {
  assert.deepEqual(parseMarker('point:left'), { type: 'point', side: 'left' });
  assert.deepEqual(parseMarker('emote:nod'), { type: 'emote', name: 'nod' });
  assert.deepEqual(parseMarker('open:talk'), { type: 'open', what: 'talk' });
  assert.equal(parseMarker('goto:../etc'), null);
  assert.equal(parseMarker('emote:rage'), null);
  const p = new MarkerParser();
  assert.deepEqual(p.push('a ['), { text: 'a ', actions: [] });
  assert.deepEqual(p.push('[highlight:te'), { text: '', actions: [] });
  assert.deepEqual(p.push('am]] b'), { text: ' b', actions: [{ type: 'highlight', target: 'team' }] });
  assert.deepEqual(p.push('[1] x'), { text: '[1] x', actions: [] });
  p.push('[[never closed');
  assert.equal(p.flush(), '[[never closed');
});

test('distillation finds a name, a company and an interest, latest wins', () => {
  assert.deepEqual(distill(['hi', "I'm Grace Hopper", 'I work for Navy Labs', 'curious about voice agents']), [
    { key: 'name', value: 'Grace Hopper', confidence: 0.7 },
    { key: 'company', value: 'Navy Labs', confidence: 0.6 },
    { key: 'interest', value: 'voice agents', confidence: 0.5 },
  ]);
  assert.deepEqual(distill(["I'm just looking", 'nothing here']), []);
});

test('PDF text: literal, escaped, hex and TJ strings, a FlateDecode stream, and refusals', async () => {
  assert.equal(contentText('BT (Hello\\051 \\(x\\)) Tj ET'), 'Hello) (x)\n');
  assert.equal(contentText('BT [(Wor) -20 (ld)] TJ 0 -14 Td <4869> Tj ET'), 'World\nHi\n');
  const stream = 'BT /F1 12 Tf (Compressed text that a museum would like to read aloud.) Tj ET';
  const deflated = new Uint8Array(
    await new Response(new Blob([stream]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer(),
  );
  const head = new TextEncoder().encode(
    `%PDF-1.5\n5 0 obj << /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`,
  );
  const tail = new TextEncoder().encode('\nendstream\nendobj\n%%EOF');
  const pdf = new Uint8Array([...head, ...deflated, ...tail]);
  assert.equal(await pdfText(pdf, 1000), 'Compressed text that a museum would like to read aloud.');
  assert.equal(await pdfText(pdf, 10), 'Compressed');
  assert.equal(await pdfText(new TextEncoder().encode('not a pdf'), 100), null);
  assert.equal(await pdfText(new TextEncoder().encode('%PDF-1.4\n/Encrypt 3 0 R'), 100), null);
});

test('cookie helpers: read, set and clear with fixed attributes; endUserId is opaque and stable', async () => {
  const key = 'test-key-that-is-long-enough-for-hmac';
  const id = newVisitorId();
  const signed = await signVisitorId(key, id);
  const request = new Request('https://emersa.io/api/memory', { headers: { cookie: `a=1; em_vid=${signed}; b=2` } });
  assert.equal(readCookie(request), signed);
  assert.equal(await cookieVisitor(request, key), id);
  assert.equal(await cookieVisitor(request, undefined), null);
  assert.equal(readCookie(new Request('https://emersa.io/')), null);
  assert.equal(
    visitorCookie(signed, true),
    `em_vid=${signed}; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=34164000`,
  );
  assert.equal(clearVisitorCookie(false), 'em_vid=; HttpOnly; SameSite=Lax; Path=/api; Max-Age=0');
  const user = await endUserId(key, id);
  assert.match(user, /^[0-9a-f]{32}$/);
  assert.notEqual(user, id);
  assert.equal(await endUserId(key, id), user);
  assert.equal(CONSENT_VERSION, 1);
});

test('apiBase: CONVAI_API_BASE overrides only outside production and only for http(s) origins', () => {
  assert.equal(apiBase({}), CONVAI_API);
  assert.equal(apiBase({ CONVAI_API_BASE: 'http://127.0.0.1:8851/x', ENV: 'development' }), 'http://127.0.0.1:8851');
  assert.equal(apiBase({ CONVAI_API_BASE: 'http://127.0.0.1:8851', ENV: 'production' }), CONVAI_API);
  assert.equal(apiBase({ CONVAI_API_BASE: 'javascript:alert(1)' }), CONVAI_API);
});
