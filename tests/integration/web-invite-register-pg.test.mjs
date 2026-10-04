import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const enabled = Boolean(process.env.PG_WEB_INVITE_TEST_URL_FILE);

test('invited website registration joins its code club atomically and logout revokes the session', { skip: !enabled }, async (t) => {
  process.env.DATABASE_URL = readFileSync(process.env.PG_WEB_INVITE_TEST_URL_FILE, 'utf8').trim();
  delete process.env.DATABASE_URL_FILE;
  process.env.NODE_ENV = 'test';
  process.env.RUNTIME_KIND = 'nas';
  process.env.REVIEW_PROVIDER = 'manual';
  process.env.MEDIA_URL_SECRET = 'isolated-invite-test-media-secret-long-enough';
  process.env.ANON_ALIAS_SECRET = 'isolated-invite-test-alias-secret-long-enough';
  const pg = require('../../shared/pg-store.js');
  const apiPg = require('../../cloudfunctions/api/shared/pg-store.js');
  const { createServer } = require('../../server/index.js');
  const { createWebAuth } = require('../../server/web-auth.js');
  const auth = createWebAuth({ database: pg });
  const server = createServer({ websiteAuth: auth });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_API_BASE_URL = base;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await pg.close(); await apiPg.close(); });

  const tag = crypto.randomBytes(5).toString('hex');
  const clubId = `invite-test-${tag}`;
  const code = crypto.randomBytes(12).toString('hex').toUpperCase();
  const inviteId = `invite:${crypto.randomUUID()}`;
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const now = new Date().toISOString();
  await pg.query('INSERT INTO public.hg_club_config(id,doc) VALUES($1,$2::jsonb)', [clubId, JSON.stringify({
    _id: clubId, clubId, name: '注册测试社团', description: '仅隔离库测试', rules: '尊重社团成员的隐私。',
    status: 'active', admissionMode: 'invite_required', rulesVersion: 'v1.0', discoverable: true,
    capabilities: { publishing: true, uploads: false, anthology: true, publicScope: false, video: false }, createdAt: now,
  })]);
  await pg.query('INSERT INTO public.hg_invite_codes(id,doc) VALUES($1,$2::jsonb)', [inviteId, JSON.stringify({
    _id: inviteId, clubId, codeHash, mode: 'application', targetUserId: null, rulesVersion: 'v1.0',
    maxUses: 1, usedCount: 0, reservedCount: 0, expiresAt: new Date(Date.now() + 3600000).toISOString(),
    version: 1, createdAt: now, updatedAt: now,
  })]);

  let cookie = '';
  let csrf = '';
  async function request(path, body) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
      ...(body ? { 'Content-Type': 'application/json', Origin: base, 'X-CSRF-Token': csrf } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const result = await response.json();
    if (result.data?.csrfToken) csrf = result.data.csrfToken;
    return { status: response.status, ...result };
  }
  const preview = await request('/v1/web/auth/invite-preview', { inviteCode: code.toLowerCase() });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(preview.data.clubId, clubId);
  assert.equal(preview.data.rulesVersion, 'v1.0');
  assert.equal(JSON.stringify(preview).includes(codeHash), false);

  const invalidName = `bad_${tag}`;
  const invalid = await request('/v1/web/auth/register', {
    username: invalidName, password: 'isolated test password', displayName: '无效码',
    inviteCode: 'BAD0BAD0', rulesVersion: 'v1.0', agreement: true,
  });
  assert.equal(invalid.status, 400, JSON.stringify(invalid));
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM hg_web_accounts WHERE username=$1', [invalidName])).rows[0].n, 0);

  const username = `joined_${tag}`;
  const joined = await request('/v1/web/auth/register', {
    username, password: 'isolated test password', displayName: '新成员',
    inviteCode: code, rulesVersion: 'v1.0', agreement: true,
  });
  assert.equal(joined.status, 200, JSON.stringify(joined));
  assert.equal(joined.data.clubId, clubId);
  assert.ok(cookie.startsWith('blacklight_web='));
  const session = await request('/v1/web/session');
  assert.equal(session.data.authenticated, true);
  const userId = session.data.user.id;
  const scoped = await request('/v1/web/action', { action: 'session/me', clubId, payload: {} });
  assert.equal(scoped.data.memberStatus, 'active');
  const membership = await pg.query("SELECT doc FROM hg_memberships WHERE doc->>'userId'=$1 AND doc->>'clubId'=$2", [userId, clubId]);
  assert.equal(membership.rows[0].doc.role, 'member');
  const application = await pg.query("SELECT doc FROM hg_membership_applications WHERE doc->>'userId'=$1 AND doc->>'clubId'=$2", [userId, clubId]);
  assert.equal(application.rows[0].doc.status, 'active');
  assert.equal(application.rows[0].doc.reservationStatus, 'consumed');
  const invite = await pg.query('SELECT doc FROM hg_invite_codes WHERE id=$1', [inviteId]);
  assert.equal(invite.rows[0].doc.usedCount, 1);

  const exhausted = await request('/v1/web/auth/register', {
    username: `too_late_${tag}`, password: 'isolated test password', displayName: '后来者',
    inviteCode: code, rulesVersion: 'v1.0', agreement: true,
  });
  assert.equal(exhausted.status, 400, JSON.stringify(exhausted));
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM hg_web_accounts WHERE username=$1', [`too_late_${tag}`])).rows[0].n, 0);

  const raceCode = crypto.randomBytes(12).toString('hex').toUpperCase();
  const raceId = `invite:${crypto.randomUUID()}`;
  await pg.query('INSERT INTO public.hg_invite_codes(id,doc) VALUES($1,$2::jsonb)', [raceId, JSON.stringify({
    _id: raceId, clubId, codeHash: crypto.createHash('sha256').update(raceCode).digest('hex'),
    mode: 'application', targetUserId: null, rulesVersion: 'v1.0', maxUses: 1, usedCount: 0,
    reservedCount: 0, expiresAt: new Date(Date.now() + 3600000).toISOString(), version: 1,
    createdAt: now, updatedAt: now,
  })]);
  const raceNames = [`race_a_${tag}`, `race_b_${tag}`];
  const races = await Promise.all(raceNames.map(async (raceName) => {
    const response = await fetch(base + '/v1/web/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ username: raceName, password: 'isolated test password', displayName: '并发测试',
        inviteCode: raceCode, rulesVersion: 'v1.0', agreement: true }),
    });
    return response.status;
  }));
  assert.deepEqual(races.sort(), [200, 400]);
  const raceAccounts = await pg.query('SELECT count(*)::int AS n FROM hg_web_accounts WHERE username=ANY($1)', [raceNames]);
  assert.equal(raceAccounts.rows[0].n, 1);
  assert.equal((await pg.query('SELECT doc FROM hg_invite_codes WHERE id=$1', [raceId])).rows[0].doc.usedCount, 1);

  const loggedOut = await request('/v1/web/auth/logout', {});
  assert.equal(loggedOut.status, 200);
  assert.equal((await request('/v1/web/session')).data.authenticated, false);
});
