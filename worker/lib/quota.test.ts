import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asD1, seedCounter, testDatabase } from '../test/d1.ts';
import {
  CONTACT_SENDS,
  type Counter,
  count,
  counterTotals,
  dayKey,
  increment,
  purgeCounters,
  reserve,
  secondsUntilTomorrow,
} from './quota.ts';

const NOON = Date.UTC(2026, 9, 7, 12, 0, 0);

test('days are UTC dates and Retry-After reaches the next one', () => {
  assert.equal(dayKey(NOON), '2026-10-07');
  assert.equal(dayKey(Date.UTC(2026, 9, 7, 23, 59, 59)), '2026-10-07');
  assert.equal(dayKey(Date.UTC(2026, 9, 8, 0, 0, 0)), '2026-10-08');
  assert.equal(secondsUntilTomorrow(Date.UTC(2026, 9, 7, 23, 59, 30)), 30);
  assert.equal(secondsUntilTomorrow(Date.UTC(2026, 9, 7, 0, 0, 0)), 86_400);
  assert.equal(secondsUntilTomorrow(Date.UTC(2026, 9, 7, 23, 59, 59, 500)), 1);
});

test('increment is one statement that returns the new value; reserve compares it with the cap', async () => {
  const db = testDatabase();
  const d1 = asD1(db);
  const small: Counter = { scope: 't', key: 'k', cap: 2, full: 'full' };
  const day = dayKey(NOON);
  assert.equal(await count(d1, small, day), 0);
  assert.equal(await increment(d1, small, day), 1);
  assert.equal(await increment(d1, small, day), 2);
  assert.equal(await count(d1, small, day), 2);
  assert.deepEqual(await reserve(d1, small, day), { allowed: false, n: 3 });
  assert.equal(await count(d1, small, dayKey(NOON + 86_400_000)), 0, 'a new day starts at zero');
  assert.equal(await count(d1, CONTACT_SENDS, day), 0, 'other counters are untouched');
  db.close();
});

test('the purge keeps today and yesterday; the totals sum what is left', async () => {
  const db = testDatabase();
  const d1 = asD1(db);
  const other: Counter = { scope: 'talk', key: 'sessions', cap: 20, full: 'full' };
  seedCounter(db, CONTACT_SENDS, '2026-10-07', 5);
  seedCounter(db, CONTACT_SENDS, '2026-10-06', 7);
  seedCounter(db, CONTACT_SENDS, '2026-10-05', 9);
  seedCounter(db, CONTACT_SENDS, '2026-09-01', 11);
  seedCounter(db, other, '2026-10-04', 1);
  assert.equal(await purgeCounters(d1, NOON, 2), 3);
  assert.deepEqual(await counterTotals(d1), [{ scope: 'contact', key: 'sends', days: 2, total: 12 }]);
  assert.equal(await purgeCounters(d1, NOON, 2), 0, 'a repeated run does nothing more');
  db.close();
});
