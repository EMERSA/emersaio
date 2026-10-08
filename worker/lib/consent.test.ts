import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newVisitorId, signVisitorId, verifyVisitorId } from './consent.ts';

const SECRET = 'test-key-that-is-long-enough-for-hmac';

test('a fresh id is 32 hex characters and different each time', () => {
  const a = newVisitorId();
  const b = newVisitorId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('a signed id verifies with the same secret and with no other', async () => {
  const id = newVisitorId();
  const signed = await signVisitorId(SECRET, id);
  assert.ok(signed.startsWith(`${id}.`));
  assert.match(signed.slice(33), /^[A-Za-z0-9_-]{43}$/, 'a 32-byte mac as base64url without padding');
  assert.equal(await verifyVisitorId(SECRET, signed), id);
  assert.equal(await verifyVisitorId('another-secret-of-similar-length', signed), null);
  assert.equal(await signVisitorId(SECRET, id), signed, 'signing is deterministic');
});

test('anything altered or malformed verifies to nothing, without throwing', async () => {
  const id = newVisitorId();
  const signed = await signVisitorId(SECRET, id);
  const [, mac = ''] = signed.split('.');
  const flipped = `${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`;
  const cases = [
    '',
    id,
    `${id}.`,
    `.${mac}`,
    `${id}.${flipped}`,
    `${newVisitorId()}.${mac}`,
    `${id}.${mac}.extra`,
    `${id.toUpperCase()}.${mac}`,
    `${id}.${mac.slice(0, 20)}`,
    `${id}.${'!'.repeat(43)}`,
    `${id}.${mac}=`,
  ];
  for (const value of cases) assert.equal(await verifyVisitorId(SECRET, value), null, value);
  assert.equal(await verifyVisitorId('', signed), null, 'no secret, no trust');
});

test('signing refuses what is not an id or has no key', async () => {
  await assert.rejects(signVisitorId(SECRET, 'not-an-id'), /not a visitor id/);
  await assert.rejects(signVisitorId('', newVisitorId()), /VISITOR_HMAC_KEY/);
});
