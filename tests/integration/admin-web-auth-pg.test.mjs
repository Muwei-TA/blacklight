import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const connectionString = process.env.PG_TEST_URL;
const runtimeConnectionString = process.env.PG_APP_TEST_URL || connectionString;
const origin = new URL(process.env.ADMIN_WEB_TEST_ORIGIN || process.env.PUBLIC_API_BASE_URL || 'http://127.0.0.1:3000').origin;
if (connectionString) {
  process.env.DATABASE_URL = runtimeConnectionString || process.env.DATABASE_URL || connectionString;
  process.env.PUBLIC_API_BASE_URL = origin;
}

const require = createRequire(import.meta.url);
const { Client, Pool } = require('pg');
const {
  cookieName,
  createAdminWebAuth,
  tokenHash,
} = require('../../server/admin-web-auth.js');
const policies = require('../../shared/policies.js');
const { ROLE, MEMBER_STATUS, DEFAULT_CLUB_ID } = require('../../shared/constants.js');
const webLogin = require('../../cloudfunctions/api/domain/adminWebLogin.js');
const apiPgStore = require('../../cloudfunctions/api/shared/pg-store.js');
after(async () => apiPgStore.close());

async function createRuntimePool(applicationName) {
  const probe = new Client({ connectionString: runtimeConnectionString, application_name: applicationName });
  await probe.connect();
  const initial = await probe.query('SELECT current_user AS role');
  await probe.end();
  const directAppRole = initial.rows[0].role === 'blacklight_app';
  const pool = new Pool({ connectionString: runtimeConnectionString, max: directAppRole ? 10 : 1, application_name: applicationName });
  const client = await pool.connect();
  try {
    const connected = await client.query('SELECT current_user AS role');
    if (connected.rows[0].role !== 'blacklight_app') await client.query('SET ROLE blacklight_app');
    const result = await client.query(`
      SELECT current_user AS role,
        pg_has_role(current_user, 'service_role', 'member') AS service_member,
        r.rolbypassrls AS bypass_rls
      FROM pg_roles r WHERE r.rolname = current_user
    `);
    assert.equal(result.rows[0].role, 'blacklight_app');
    assert.equal(result.rows[0].service_member, true);
    assert.equal(result.rows[0].bypass_rls, true);
    client.release();
    return pool;
  } catch (error) {
    client.release(error);
    await pool.end();
    throw error;
  }
}

test('authentication table grants and RLS policies match the NAS application role', { skip: !connectionString }, async () => {
  const pool = await createRuntimePool('blacklight-admin-web-auth-role-test');
  try {
    const access = await pool.query(`
      SELECT table_name,
        has_table_privilege(current_user, 'public.' || table_name, 'SELECT') AS can_select,
        has_table_privilege(current_user, 'public.' || table_name, 'INSERT') AS can_insert,
        has_table_privilege(current_user, 'public.' || table_name, 'UPDATE') AS can_update,
        has_table_privilege(current_user, 'public.' || table_name, 'DELETE') AS can_delete,
        has_table_privilege('anon', 'public.' || table_name, 'SELECT') AS anon_can_select,
        has_table_privilege('authenticated', 'public.' || table_name, 'SELECT') AS authenticated_can_select
      FROM unnest(ARRAY['hg_admin_web_pairings','hg_admin_web_sessions','hg_admin_web_pairing_limits']) AS table_name
    `);
    assert.equal(access.rows.length, 3);
    for (const row of access.rows) {
      assert.equal(row.can_select, true, `${row.table_name} SELECT`);
      assert.equal(row.can_insert, true, `${row.table_name} INSERT`);
      assert.equal(row.can_update, true, `${row.table_name} UPDATE`);
      assert.equal(row.can_delete, true, `${row.table_name} DELETE`);
      assert.equal(row.anon_can_select, false, `${row.table_name} anon SELECT`);
      assert.equal(row.authenticated_can_select, false, `${row.table_name} authenticated SELECT`);
    }
    const rls = await pool.query(`
      SELECT c.relname, c.relrowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = ANY($1::text[])
    `, [['hg_admin_web_pairings', 'hg_admin_web_sessions', 'hg_admin_web_pairing_limits']]);
    assert.equal(rls.rows.length, 3);
    for (const row of rls.rows) assert.equal(row.relrowsecurity, true, `${row.relname} RLS enabled`);
    const policies = await pool.query(`
      SELECT tablename, policyname FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
        AND 'service_role' = ANY(roles)
        AND cmd = 'ALL'
        AND qual = 'true'
        AND with_check = 'true'
    `, [['hg_admin_web_pairings', 'hg_admin_web_sessions', 'hg_admin_web_pairing_limits']]);
    assert.equal(policies.rows.length, 3);
  } finally {
    await pool.end();
  }
});

test('20 concurrent pairing requests from one source admit exactly eight and persist the atomic limit', { skip: !connectionString }, async () => {
  const pool = await createRuntimePool('blacklight-admin-web-auth-test');
  const database = await pool.query('SELECT current_database() AS name');
  assert.equal(database.rows[0].name, 'blacklight_test');
  const requester = `admin-web-auth-rate-${cryptoRandomHex()}`;
  const requesterHash = tokenHash(requester);
  await pool.query('DELETE FROM public.hg_admin_web_pairings WHERE requester_hash = $1', [requesterHash]);
  await pool.query('DELETE FROM public.hg_admin_web_pairing_limits WHERE requester_hash = $1', [requesterHash]);
  const auth = createAdminWebAuth({ database: pool });

  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => auth.createPairing({ origin, remoteAddress: requester })));
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 8);
    assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 12);
    assert.equal(outcomes.filter((item) => item.status === 'rejected' && item.reason.code === 'rate_limited').length, 12);
    const [limit, pairings] = await Promise.all([
      pool.query('SELECT attempts FROM public.hg_admin_web_pairing_limits WHERE requester_hash = $1', [requesterHash]),
      pool.query('SELECT count(*)::int AS count FROM public.hg_admin_web_pairings WHERE requester_hash = $1', [requesterHash]),
    ]);
    assert.equal(limit.rows[0].attempts, 8);
    assert.equal(pairings.rows[0].count, 8);
  } finally {
    await pool.query('DELETE FROM public.hg_admin_web_pairings WHERE requester_hash = $1', [requesterHash]);
    await pool.query('DELETE FROM public.hg_admin_web_pairing_limits WHERE requester_hash = $1', [requesterHash]);
    await pool.end();
  }
});

test('QR approval and exchange are single-use; membership downgrade invalidates the old Web session', { skip: !connectionString }, async () => {
  const pool = await createRuntimePool('blacklight-admin-web-auth-test');
  const database = await pool.query('SELECT current_database() AS name');
  assert.equal(database.rows[0].name, 'blacklight_test');
  const suffix = cryptoRandomHex();
  const userId = `admin-web-auth-user-${suffix}`;
  const openid = `admin-web-auth-openid-${suffix}`;
  const membershipId = `${userId}:${DEFAULT_CLUB_ID}`;
  const auth = createAdminWebAuth({ database: pool });
  const pair = await auth.createPairing({ origin, remoteAddress: `admin-web-auth-pair-${suffix}` });
  const viewer = policies.buildViewer({ userId, clubId: null, role: ROLE.GUEST, memberStatus: MEMBER_STATUS.NONE });
  const ctx = { viewer };

  try {
    assert.equal(pair.qrText, `blacklight-admin:${pair.id}`);
    assert.equal(pair.qrText.includes(pair.pollKey), false);
    assert.match(pair.qrSvg, /^<svg/);
    await assert.rejects(
      auth.getPairingStatus({ id: pair.id, pollKey: pair.pollKey, origin: 'https://attacker.invalid' }),
      (error) => error.code === 'pairing_not_found',
    );

    await pool.query(`
      INSERT INTO public.hg_users (id, doc) VALUES ($1, $2::jsonb)
    `, [userId, JSON.stringify({ _id: userId, wxOpenIdRef: openid, status: 'active', platformRole: 'none', displayName: '临时管理测试账号' })]);
    await pool.query(`
      INSERT INTO public.hg_memberships (id, doc) VALUES ($1, $2::jsonb)
    `, [membershipId, JSON.stringify({
      _id: membershipId,
      userId,
      clubId: DEFAULT_CLUB_ID,
      role: 'moderator',
      status: 'active',
      version: 1,
      joinedAt: new Date().toISOString(),
    })]);

    const pending = await webLogin.info({ id: pair.id }, ctx);
    assert.deepEqual(Object.keys(pending).sort(), ['expiresAt', 'id', 'origin', 'status']);
    assert.equal(pending.origin, origin);
    assert.equal(pending.status, 'pending');

    const approved = await webLogin.approve({ id: pair.id }, ctx);
    assert.equal(approved.status, 'approved');
    const status = await auth.getPairingStatus({ id: pair.id, pollKey: pair.pollKey, origin });
    assert.equal(status.status, 'approved');
    assert.match(status.exchangeCode, /^[A-Za-z0-9_-]{43}$/);

    const exchanges = await Promise.allSettled([
      auth.redeemPairing({ id: pair.id, pollKey: pair.pollKey, exchangeCode: status.exchangeCode, origin }),
      auth.redeemPairing({ id: pair.id, pollKey: pair.pollKey, exchangeCode: status.exchangeCode, origin }),
    ]);
    assert.equal(exchanges.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(exchanges.filter((item) => item.status === 'rejected').length, 1);
    const issued = exchanges.find((item) => item.status === 'fulfilled').value;
    const request = { headers: { cookie: `${cookieName()}=${issued.sessionToken}` } };
    const currentSession = await auth.resolveSession(request);
    assert.equal(currentSession.identity.openid, openid);

    await pool.query(`
      UPDATE public.hg_memberships
         SET doc = doc || jsonb_build_object('role', 'member', 'version', 2)
       WHERE id = $1
    `, [membershipId]);
    assert.equal(await auth.resolveSession(request), null);

    const replayStatus = await auth.getPairingStatus({ id: pair.id, pollKey: pair.pollKey, origin });
    assert.equal(replayStatus.status, 'exchanged');
    await assert.rejects(
      auth.redeemPairing({ id: pair.id, pollKey: pair.pollKey, exchangeCode: status.exchangeCode, origin }),
      (error) => error.code === 'exchange_failed',
    );
  } finally {
    await pool.query('DELETE FROM public.hg_admin_web_sessions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM public.hg_admin_web_pairings WHERE id = $1', [pair.id]);
    await pool.query('DELETE FROM public.hg_memberships WHERE id = $1', [membershipId]);
    await pool.query('DELETE FROM public.hg_users WHERE id = $1', [userId]);
    await pool.end();
  }
});

function cryptoRandomHex() {
  return require('node:crypto').randomBytes(12).toString('hex');
}
