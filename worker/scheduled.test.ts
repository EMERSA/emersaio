import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTurn, getVisitor, RETENTION_MS, recordConsent, turnCount } from './lib/memory.ts';
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
    visitors: 0,
    quota: 0,
    totals: [{ scope: 'contact', key: 'sends', days: 2, total: 3 }],
  });
  assert.deepEqual(await runScheduled({ MEMORY: asD1(db) }, AT), {
    purged: 0,
    visitors: 0,
    quota: 0,
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

test('the retention purge removes visitors idle 12 months with every row, and keeps recent ones', async () => {
  const db = testDatabase();
  const d1 = asD1(db);
  const old = 'a'.repeat(32);
  const recent = 'b'.repeat(32);
  await recordConsent(d1, old, 1, AT - RETENTION_MS - 1000);
  await recordConsent(d1, recent, 1, AT - 1000);
  await addTurn(d1, old, null, 'user', 'hello', AT - RETENTION_MS - 1000);
  await addTurn(d1, recent, null, 'user', 'hello', AT - 1000);
  const report = await runScheduled({ MEMORY: d1 }, AT);
  assert.equal(report.visitors, 1);
  assert.equal(await getVisitor(d1, old), null);
  assert.equal(await turnCount(d1, old), 0);
  assert.ok(await getVisitor(d1, recent));
  assert.equal(await turnCount(d1, recent), 1);
  db.close();
});
