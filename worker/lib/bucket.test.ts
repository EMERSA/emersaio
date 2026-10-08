/** The token bucket, checked against the same cases as its Rust original, and the limiter built on it. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BucketLimiter, TokenBucket } from './bucket.ts';

test('a bucket allows its burst then stops', () => {
  const bucket = new TokenBucket(3, 1, 0);
  assert.ok(bucket.allow(0));
  assert.ok(bucket.allow(0));
  assert.ok(bucket.allow(0));
  assert.ok(!bucket.allow(0));
});

test('a bucket refills over time', () => {
  const bucket = new TokenBucket(2, 10, 0);
  assert.ok(bucket.allow(0));
  assert.ok(bucket.allow(0));
  assert.ok(!bucket.allow(0));
  // A tenth of a second buys exactly one more token at 10/s.
  assert.ok(bucket.allow(100));
  assert.ok(!bucket.allow(100));
});

test('a bucket never banks more than its burst', () => {
  const bucket = new TokenBucket(2, 10, 0);
  const later = 3600 * 1000;
  assert.ok(bucket.allow(later));
  assert.ok(bucket.allow(later));
  assert.ok(!bucket.allow(later));
});

test('a clock that goes backwards costs nothing and breaks nothing', () => {
  const bucket = new TokenBucket(1, 1, 1000);
  assert.ok(bucket.allow(1000));
  assert.ok(!bucket.allow(500));
  assert.ok(bucket.allow(1500), 'measured from the last call, not from the earlier time');
});

test('the limiter keeps one bucket per key and answers like the binding', async () => {
  let now = 0;
  const limiter = BucketLimiter.simple(2, 60, { now: () => now });
  assert.deepEqual(await limiter.limit({ key: 'a' }), { success: true });
  assert.deepEqual(await limiter.limit({ key: 'a' }), { success: true });
  assert.deepEqual(await limiter.limit({ key: 'a' }), { success: false });
  assert.deepEqual(await limiter.limit({ key: 'b' }), { success: true }, 'a different source has its own allowance');
  now = 30_000;
  assert.deepEqual(await limiter.limit({ key: 'a' }), { success: true }, 'two a minute is one per thirty seconds');
  assert.deepEqual(await limiter.limit({ key: 'a' }), { success: false });
  assert.equal(limiter.tracked, 2);
});

test('sweeping keeps busy keys and forgets quiet ones', async () => {
  let now = 0;
  const limiter = new BucketLimiter(5, 1, { idleMs: 1000, now: () => now });
  await limiter.limit({ key: 'quiet' });
  now = 900;
  await limiter.limit({ key: 'busy' });
  limiter.sweep();
  assert.equal(limiter.tracked, 2, 'nothing is old enough to forget yet');
  now = 1500;
  limiter.sweep();
  assert.equal(limiter.tracked, 1);
  assert.deepEqual(await limiter.limit({ key: 'quiet' }), { success: true }, 'a forgotten key starts afresh');
});
