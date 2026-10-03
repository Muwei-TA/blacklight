import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';

const databaseUrl = process.env.PG_TEST_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/blacklight_test' || process.env.HG_TEST_DATABASE_RESET !== 'yes') {
  throw new Error('Use an isolated blacklight_test database and HG_TEST_DATABASE_RESET=yes; never run on application data.');
}
const runtimeDatabaseUrl = process.env.PG_APP_TEST_URL || databaseUrl;
process.env.DATABASE_URL = runtimeDatabaseUrl;

const require = createRequire(import.meta.url);
const { ROLE, MEMBER_STATUS } = require('../../shared/constants.js');
const policies = require('../../shared/policies.js');
const session = require('../../cloudfunctions/api/domain/session.js');
const adminManagement = require('../../cloudfunctions/api/domain/adminManagement.js');
const apiPgStore = require('../../cloudfunctions/api/shared/pg-store.js');
after(async () => apiPgStore.close());

test('pending membership API returns cancellation data and its version cancels the real reservation', async () => {
  const pool = new pg.Pool({ connectionString: runtimeDatabaseUrl, max: 4, application_name: 'blacklight-membership-application-api-test' });
  const suffix = randomBytes(10).toString('hex');
  const clubId = `membership-api-${suffix}`;
  const userId = `membership-api-user-${suffix}`;
  const inviteId = `invite:membership-api-${suffix}`;
  const inviteCode = randomBytes(16).toString('hex').toUpperCase();
  const codeHash = createHash('sha256').update(inviteCode).digest('hex');
  const viewer = policies.buildViewer({
    userId,
    clubId,
    role: ROLE.GUEST,
    memberStatus: MEMBER_STATUS.NONE,
  });
  const ctx = { viewer, now: Date.now() };
  let fixturesCreated = false;
  let testError = null;
  const client = await pool.connect();

  try {
    const database = await client.query('SELECT current_database() AS name');
    assert.equal(database.rows[0].name, 'blacklight_test');
    await client.query('BEGIN');
    await client.query(`INSERT INTO public.hg_users (id,doc) VALUES ($1,$2::jsonb)`, [userId, JSON.stringify({
      _id: userId, status: 'active', platformRole: 'none', displayName: '入社申请测试用户',
    })]);
    await client.query(`INSERT INTO public.hg_club_config (id,doc) VALUES ($1,$2::jsonb)`, [clubId, JSON.stringify({
      _id: clubId, name: 'API reservation regression', status: 'active', rulesVersion: 'v1.0',
      admissionMode: 'invite_required', createdAt: new Date().toISOString(),
    })]);
    await client.query(`INSERT INTO public.hg_invite_codes (id,doc) VALUES ($1,$2::jsonb)`, [inviteId, JSON.stringify({
      _id: inviteId, clubId, codeHash, mode: 'application', rulesVersion: 'v1.0',
      maxUses: 1, usedCount: 0, reservedCount: 0,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), version: 1,
    })]);
    await client.query('COMMIT');
    fixturesCreated = true;

    const applied = await session.apply({
      displayName: '申请成员', inviteCode, rulesVersion: 'v1.0', idempotencyKey: `membership-api-${suffix}`,
    }, ctx);
    assert.equal(applied.state, 'pending');
    assert.equal(applied.error, undefined);

    const pending = await session.myApplication({}, ctx);
    assert.equal(pending.state, 'pending');
    assert.equal(pending.applicationId, applied.applicationId);
    assert.equal(pending.version, 1);
    assert.equal(Number.isSafeInteger(pending.version) && pending.version > 0, true);
    assert.equal(typeof pending.reservationExpiresAt, 'string');
    assert.equal(JSON.stringify(pending).includes(inviteCode), false);
    assert.equal(JSON.stringify(pending).includes(codeHash), false);

    const cancelled = await adminManagement.cancelApplication({
      applicationId: pending.applicationId,
      expectedVersion: pending.version,
    }, ctx);
    assert.deepEqual(cancelled, {
      ok: true, id: pending.applicationId, status: 'cancelled', version: 2,
    });

    const afterCancel = await session.myApplication({}, ctx);
    assert.equal(afterCancel.applicationId, pending.applicationId);
    assert.equal(afterCancel.version, 2);
    assert.equal(afterCancel.state, 'cancelled');
    assert.equal(afterCancel.reservationExpiresAt, pending.reservationExpiresAt);

    const stored = await client.query(`
      SELECT a.doc AS application, i.doc AS invite
      FROM public.hg_membership_applications a
      JOIN public.hg_invite_codes i ON i.id=a.doc->>'inviteId'
      WHERE a.id=$1 AND a.doc->>'clubId'=$2
    `, [pending.applicationId, clubId]);
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].application.status, 'cancelled');
    assert.equal(stored.rows[0].application.reservationStatus, 'released');
    assert.equal(stored.rows[0].application.version, 2);
    assert.equal(stored.rows[0].invite.reservedCount, 0);
  } catch (error) {
    testError = error;
    try { await client.query('ROLLBACK'); } catch { /* no open setup transaction */ }
  }

  if (fixturesCreated) {
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM public.hg_audit_logs WHERE doc->>\'clubId\'=$1', [clubId]);
      await client.query('DELETE FROM public.hg_invitation_rate_limits WHERE user_id=$1 AND club_id=$2', [userId, clubId]);
      await client.query('DELETE FROM public.hg_membership_applications WHERE doc->>\'userId\'=$1 AND doc->>\'clubId\'=$2', [userId, clubId]);
      await client.query('DELETE FROM public.hg_invite_codes WHERE id=$1', [inviteId]);
      await client.query('DELETE FROM public.hg_management_terms WHERE doc->>\'clubId\'=$1', [clubId]);
      await client.query('DELETE FROM public.hg_club_config WHERE id=$1', [clubId]);
      await client.query('DELETE FROM public.hg_users WHERE id=$1', [userId]);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the test result */ }
      if (!testError) testError = error;
    }
  }
  client.release();
  await pool.end();
  if (testError) throw testError;
});
