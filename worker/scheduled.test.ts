import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTACT_SENDS } from './lib/quota.ts';
import { KEEP_DAYS, runScheduled } from './scheduled.ts';
import { asD1, seedCounter, testDatabase } from './test/d1.ts';

const AT = Date.UTC(2026, 9, 7, 3, 0, 0);

test('without the database the run says it skipped', async () => {
  assert.deepEqual(await runScheduled({}, AT), { skipped: 'no database' });
});

test('with the database: counters older than two days go, and what is left is logged as totals', async () => {
  const db = testDatabase();
  seedCounter(db, CONTACT_SENDS, '2026-10-07', 1);
  seedCounter(db, CONTACT_SENDS, '2026-10-06', 2);
  seedCounter(db, CONTACT_SENDS, '2026-10-05', 4);
  seedCounter(db, CONTACT_SENDS, '2026-10-04', 8);
  assert.equal(KEEP_DAYS, 2);
  assert.deepEqual(await runScheduled({ MEMORY: asD1(db) }, AT), {
    purged: 2,
    totals: [{ scope: 'contact', key: 'sends', days: 2, total: 3 }],
  });
  assert.deepEqual(await runScheduled({ MEMORY: asD1(db) }, AT), {
    purged: 0,
    totals: [{ scope: 'contact', key: 'sends', days: 2, total: 3 }],
  });
  db.close();
});

test('a failing task is reported, not thrown, and does not stop the other', async () => {
  const db = testDatabase();
  db.break();
  const report = await runScheduled({ MEMORY: asD1(db) }, AT);
  assert.match(String(report.purged), /^failed: D1_ERROR/);
  assert.match(String(report.totals), /^failed: D1_ERROR/);
  db.close();
});
