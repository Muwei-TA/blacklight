import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const requirePg = createRequire(new URL('../package.json', import.meta.url));

function reviewDatabaseUrl(value = process.env.DATABASE_URL, resetGate = process.env.HG_TEST_DATABASE_RESET) {
  assert.equal(resetGate, 'yes', 'rate-limit integration test requires the isolated database reset gate');
  const databaseUrl = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '::1', 'postgres'].includes(databaseUrl.hostname), 'integration test must use loopback or the CI PostgreSQL service');
  assert.equal(databaseUrl.pathname, '/blacklight_test', 'integration test must use the isolated review database');
  return databaseUrl;
}

test('rate-limit database guard accepts only loopback or CI postgres with the reset gate', () => {
  assert.doesNotThrow(() => reviewDatabaseUrl('postgresql://postgres:postgres@postgres:5432/blacklight_test', 'yes'));
  assert.doesNotThrow(() => reviewDatabaseUrl('postgresql://review_admin@127.0.0.1:55484/blacklight_test', 'yes'));
  assert.throws(() => reviewDatabaseUrl('postgresql://postgres:postgres@remote-db:5432/blacklight_test', 'yes'));
  assert.throws(() => reviewDatabaseUrl('postgresql://postgres:postgres@postgres:5432/blacklight_test', 'no'));
});

test('concurrent rate checks at count 4 and max 5 allow exactly one request', {
  skip: process.env.RATE_LIMIT_PG_TEST !== '1' || !process.env.DATABASE_URL || process.env.HG_TEST_DATABASE_RESET !== 'yes',
}, async () => {
  reviewDatabaseUrl();
  process.env.PG_POOL_MAX = '32';
  process.env.PG_APPLICATION_NAME = 'rate-limit-atomic-test';

  const { Pool } = requirePg('pg');
  const seedPool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'rate-limit-seed' });
  const observerPool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'rate-limit-observer' });
  const userId = `rate-limit-test-${randomUUID()}`;
  const now = Date.now();
  let lockClient;
  let pending;
  const appDb = require('../shared/pg-store.js');

  try {
    await seedPool.query(
      `INSERT INTO public.hg_users(id,doc) VALUES($1,$2::jsonb)`,
      [userId, JSON.stringify({
        _id: userId,
        wxOpenIdRef: `${userId}-openid`,
        status: 'active',
        rate: { applyMembership: { startedAt: now, count: 4 } },
      })],
    );
    lockClient = await seedPool.connect();
    await lockClient.query('BEGIN');
    await lockClient.query('LOCK TABLE public.hg_users IN SHARE MODE');

    const { checkRateLimit } = require('../shared/session.js');
    pending = Promise.all(Array.from({ length: 20 }, () => checkRateLimit(userId, 'applyMembership', {
      windowMs: 10 * 60 * 1000,
      max: 5,
    })));

    const deadline = Date.now() + 10000;
    let waiting = 0;
    while (Date.now() < deadline && waiting < 20) {
      const result = await observerPool.query(`
        SELECT count(*)::int AS waiting
          FROM pg_stat_activity
         WHERE application_name='rate-limit-atomic-test'
           AND state='active'
           AND wait_event_type='Lock'
      `);
      waiting = result.rows[0].waiting;
      if (waiting < 20) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, 20, 'all requests must reach the database write while sharing the original count');

    await lockClient.query('COMMIT');
    lockClient.release();
    lockClient = null;

    const allowed = await pending;
    assert.equal(allowed.filter(Boolean).length, 1);
    const row = await seedPool.query(`SELECT doc#>>'{rate,applyMembership,count}' AS count FROM public.hg_users WHERE id=$1`, [userId]);
    assert.equal(Number(row.rows[0].count), 5);
  } finally {
    if (lockClient) {
      await lockClient.query('ROLLBACK').catch(() => {});
      lockClient.release();
    }
    if (pending) await Promise.allSettled([pending]);
    await seedPool.query('DELETE FROM public.hg_users WHERE id=$1', [userId]).catch(() => {});
    await seedPool.end();
    await observerPool.end();
    await appDb.close().catch(() => {});
  }
});

test('concurrent first checks create the missing rate object and stop at max', {
  skip: process.env.RATE_LIMIT_PG_TEST !== '1' || !process.env.DATABASE_URL || process.env.HG_TEST_DATABASE_RESET !== 'yes',
}, async () => {
  reviewDatabaseUrl();
  process.env.PG_POOL_MAX = '32';
  process.env.PG_APPLICATION_NAME = 'rate-limit-atomic-test';

  const { Pool } = requirePg('pg');
  const seedPool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'rate-limit-seed' });
  const observerPool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: 'rate-limit-observer' });
  const userId = `rate-limit-test-${randomUUID()}`;
  let lockClient;
  let pending;
  const appDb = require('../shared/pg-store.js');

  try {
    await seedPool.query(
      `INSERT INTO public.hg_users(id,doc) VALUES($1,$2::jsonb)`,
      [userId, JSON.stringify({ _id: userId, wxOpenIdRef: `${userId}-openid`, status: 'active' })],
    );
    lockClient = await seedPool.connect();
    await lockClient.query('BEGIN');
    await lockClient.query('LOCK TABLE public.hg_users IN SHARE MODE');

    const { checkRateLimit } = require('../shared/session.js');
    pending = Promise.all(Array.from({ length: 20 }, () => checkRateLimit(userId, 'applyMembership', {
      windowMs: 10 * 60 * 1000,
      max: 5,
    })));

    const deadline = Date.now() + 10000;
    let waiting = 0;
    while (Date.now() < deadline && waiting < 20) {
      const result = await observerPool.query(`
        SELECT count(*)::int AS waiting
          FROM pg_stat_activity
         WHERE application_name='rate-limit-atomic-test'
           AND state='active'
           AND wait_event_type='Lock'
      `);
      waiting = result.rows[0].waiting;
      if (waiting < 20) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, 20, 'all first checks must reach the database write while the user has no rate object');

    await lockClient.query('COMMIT');
    lockClient.release();
    lockClient = null;

    const allowed = await pending;
    assert.equal(allowed.filter(Boolean).length, 5);
    const row = await seedPool.query(`SELECT doc#>>'{rate,applyMembership,count}' AS count FROM public.hg_users WHERE id=$1`, [userId]);
    assert.equal(Number(row.rows[0].count), 5);
  } finally {
    if (lockClient) {
      await lockClient.query('ROLLBACK').catch(() => {});
      lockClient.release();
    }
    if (pending) await Promise.allSettled([pending]);
    await seedPool.query('DELETE FROM public.hg_users WHERE id=$1', [userId]).catch(() => {});
    await seedPool.end();
    await observerPool.end();
    await appDb.close().catch(() => {});
  }
});
