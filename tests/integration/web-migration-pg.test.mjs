import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const enabled = Boolean(process.env.PG_WEB_TEST_URL);

test('real PostgreSQL browser migration: accounts, invites, manual review, anonymity, private access and admin login', { skip: !enabled }, async (t) => {
  process.env.DATABASE_URL = process.env.PG_WEB_TEST_URL;
  process.env.NODE_ENV = 'test';
  process.env.RUNTIME_KIND = 'nas';
  process.env.REVIEW_PROVIDER = 'manual';
  process.env.ANON_ALIAS_SECRET = 'isolated-web-test-anonymous-secret-long-enough';
  delete process.env.PUBLIC_API_BASE_URL;
  const pg = require('../../shared/pg-store.js');
  const apiPg = require('../../cloudfunctions/api/shared/pg-store.js');
  const { createServer } = require('../../server/index.js');
  const { createWebAuth, buildCookie } = require('../../server/web-auth.js');
  await pg.query('DELETE FROM public.hg_web_auth_limits');
  const auth = createWebAuth({ database: pg });
  const server = createServer({ websiteAuth: auth });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_API_BASE_URL = base;
  const tag = crypto.randomBytes(4).toString('hex');
  const clubId = `web-test-${tag}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await pg.close(); await apiPg.close(); });
  const userIds = [];
  const database = require('pg');
  const cleanupPool = new database.Pool({ connectionString: process.env.PG_WEB_TEST_URL });
  t.after(async () => {
    // Fixtures live only in the isolated test DB; never runs without explicit URL.
    for (const { table_name } of (await cleanupPool.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='doc' AND table_name LIKE 'hg_%'")).rows) {
      await cleanupPool.query(`DELETE FROM public.${table_name} WHERE doc->>'clubId' = $1 OR id = $1`, [clubId]);
    }
    await cleanupPool.query('DELETE FROM public.hg_users WHERE id = ANY($1)', [userIds]);
    await cleanupPool.end();
  });
  function client() {
    let cookie = '';
    let csrf = '';
    return {
      async request(path, body, headers = {}) {
        const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json', Origin: base, 'X-CSRF-Token': csrf } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        const json = await response.json();
        if (json.data?.csrfToken) csrf = json.data.csrfToken;
        return { status: response.status, ...json };
      },
      action(action, payload = {}, club = clubId) { return this.request('/v1/web/action', { action, clubId: club, payload }); },
      getCookie: () => cookie,
    };
  }
  const moderator = client();
  const member = client();
  const other = client();
  const guest = client();
  async function register(client, suffix) {
    const result = await client.request('/v1/web/auth/register', { username: `web_${tag}_${suffix}`, password: 'browser password 123', displayName: suffix, role: 'moderator', userId: 'forged' });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.data.sessionToken, undefined);
    const session = await client.request('/v1/web/session');
    userIds.push(session.data.user.id);
    assert.equal(session.data.role, 'guest');
    return session.data.user.id;
  }
  const moderatorId = await register(moderator, 'editor');
  const memberId = await register(member, 'reader');
  const otherId = await register(other, 'other');
  const now = new Date().toISOString();
  await pg.query('INSERT INTO public.hg_club_config(id, doc) VALUES ($1, $2)', [clubId, { _id: clubId, clubId, name: '网站测试文学社', status: 'active', discoverable: true, admissionMode: 'invite_required', rulesVersion: 'v1.0', version: 1, managementVersion: 1, capabilities: { publishing: true, uploads: false, anthology: true, publicScope: false, video: false }, createdAt: now }]);
  await pg.query('INSERT INTO public.hg_memberships(id, doc) VALUES ($1, $2)', [`${moderatorId}:${clubId}`, { _id: `${moderatorId}:${clubId}`, userId: moderatorId, clubId, role: 'moderator', status: 'active', version: 1, joinedAt: now }]);
  const invite = await moderator.action('admin/invites/create', { mode: 'application', maxUses: 10, ttlSeconds: 3600, reason: '网站迁移测试创建成员入社邀请' });
  assert.equal(invite.code, 0, JSON.stringify(invite));
  for (const [person, name] of [[member, 'reader'], [other, 'other']]) {
    const joined = await person.action('membership/apply', { inviteCode: invite.data.code, displayName: name, rulesVersion: 'v1.0', idempotencyKey: crypto.randomUUID() });
    assert.equal(joined.code, 0, JSON.stringify(joined));
    const application = await person.action('membership/mine');
    if (application.data.state === 'pending') {
      const approved = await moderator.action('admin/membership/decide', { id: application.data.applicationId, decision: 'approve', expectedVersion: application.data.version });
      assert.equal(approved.code, 0, JSON.stringify(approved));
    }
    assert.equal((await person.action('session/me')).data.memberStatus, 'active');
  }
  const webAdmin = await moderator.request('/v1/admin/session');
  assert.equal(webAdmin.status, 200, JSON.stringify(webAdmin));
  assert.ok(webAdmin.clubs.some((club) => club.id === clubId));
  const deniedAdmin = await member.request('/v1/admin/action', { action: 'admin/members/list', clubId, payload: {} });
  assert.equal(deniedAdmin.status, 403);
  const adminMembers = await moderator.request('/v1/admin/action', { action: 'admin/members/list', clubId, payload: {} });
  assert.equal(adminMembers.code, 0, JSON.stringify(adminMembers));
  const privatePost = await member.action('posts/create', { kind: 'fragment', body: 'only my eyes', visibility: 'private', identityMode: 'named', idempotencyKey: crypto.randomUUID() });
  assert.equal(privatePost.code, 0, JSON.stringify(privatePost));
  const privateId = privatePost.data.id || privatePost.data.postId;
  assert.equal((await moderator.action('posts/detail', { id: privateId })).code, 'not_accessible');
  assert.equal((await other.action('posts/detail', { id: privateId })).code, 'not_accessible');
  const postKey = crypto.randomUUID();
  const input = { kind: 'fragment', title: '', body: '<script>untrusted content</script>', visibility: 'club', identityMode: 'anonymous', commentsEnabled: true, idempotencyKey: postKey };
  const created = await member.action('posts/create', input);
  assert.equal(created.code, 0, JSON.stringify(created));
  assert.equal(created.data.state, 'pending');
  const postId = created.data.id || created.data.postId;
  assert.equal((await member.action('posts/create', input)).data.id, created.data.id);
  const tasks = await pg.query("SELECT doc FROM public.hg_review_tasks WHERE doc->>'targetId' = $1", [postId]);
  assert.equal(tasks.rows[0].doc.status, 'manual');
  const detail = await member.action('posts/detail', { id: postId });
  assert.equal(detail.data.author.userId, null);
  assert.equal(JSON.stringify(detail).includes('wxOpenIdRef'), false);
  assert.equal((await other.action('posts/detail', { id: postId })).code, 'not_accessible');
  const reviewed = await moderator.action('admin/content/decide', { id: postId, decision: 'approve', expectedVersion: detail.data.version });
  assert.equal(reviewed.code, 0, JSON.stringify(reviewed));
  const feed = await other.action('posts/list');
  assert.ok(feed.data.items.some((post) => post.id === postId && post.author.userId === null));
  assert.ok(!feed.data.items.some((post) => post.id === privateId));
  assert.equal((await guest.action('posts/list')).data.items.length, 0);
  assert.equal((await other.action('posts/detail', { id: postId }, 'heiguang')).code, 'not_accessible');
  assert.equal((await other.action('posts/bookmark', { id: postId, next: true })).code, 0);
  assert.equal((await other.action('posts/reaction', { id: postId, next: true })).code, 0);
  const comment = await other.action('posts/comments/create', { id: postId, body: '认真回应', identityMode: 'anonymous', idempotencyKey: crypto.randomUUID() });
  assert.equal(comment.code, 0, JSON.stringify(comment));
  assert.equal(comment.data.state, 'pending');
  const changed = await other.request('/v1/web/auth/password', { currentPassword: 'browser password 123', password: 'changed password 456' });
  assert.equal(changed.status, 200);
  assert.equal((await other.request('/v1/web/session')).data.authenticated, false);
  assert.equal((await other.request('/v1/web/auth/login', { username: `web_${tag}_other`, password: 'browser password 123' })).status, 401);
  assert.equal((await other.request('/v1/web/auth/login', { username: `web_${tag}_other`, password: 'changed password 456' })).status, 200);
  const logoutCookie = other.getCookie();
  await other.request('/v1/web/auth/logout', {});
  assert.equal((await auth.resolveSession({ headers: { cookie: logoutCookie } })), null);
  // New sessions cannot resurrect accounts in deletion_pending state.
  await pg.query("UPDATE public.hg_users SET doc = doc || '{\"status\":\"deletion_pending\"}'::jsonb WHERE id = $1", [memberId]);
  assert.equal((await member.request('/v1/web/session')).data.authenticated, false);
  assert.ok(otherId);
  assert.match(buildCookie('x'.repeat(43), { secure: true }), /Secure/);
});

test('concurrent registration is atomic, sessions expire, and rate limits serialize attempts', { skip: !enabled }, async () => {
  const pg = require('../../shared/pg-store.js');
  process.env.DATABASE_URL = process.env.PG_WEB_TEST_URL;
  const { createWebAuth, buildCookie } = require('../../server/web-auth.js');
  const origin = 'http://127.0.0.1:39000';
  const auth = createWebAuth({ database: pg, origin });
  const tag = crypto.randomBytes(4).toString('hex');
  const input = { username: `race_${tag}`, password: 'some long password', displayName: 'race', origin, remoteAddress: `race-${tag}` };
  const results = await Promise.allSettled([auth.register(input), auth.register(input), auth.register(input)]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected' && item.reason.code === 'account_exists').length, 2);
  const user = await pg.query('SELECT user_id FROM public.hg_web_accounts WHERE username = $1', [input.username]);
  assert.equal((await pg.query("SELECT count(*)::int AS count FROM public.hg_users WHERE doc->>'displayName' = 'race'")).rows[0].count, 1);
  const session = results.find((item) => item.status === 'fulfilled').value;
  const cookie = buildCookie(session.sessionToken, { secure: false }).split(';')[0];
  assert.ok(await auth.resolveSession({ headers: { cookie } }));
  await pg.query("UPDATE public.hg_web_sessions SET last_seen_at = NOW() - INTERVAL '25 hours' WHERE user_id=$1", [user.rows[0].user_id]);
  assert.equal(await auth.resolveSession({ headers: { cookie } }), null);
  const attempts = await Promise.allSettled(Array.from({ length: 14 }, () => auth.login({ ...input, password: 'incorrect password' })));
  assert.equal(attempts.filter((item) => item.status === 'rejected' && item.reason.code === 'unauthenticated').length, 10);
  assert.equal(attempts.filter((item) => item.status === 'rejected' && item.reason.code === 'rate_limited').length, 4);
  await pg.query('DELETE FROM public.hg_users WHERE id=$1', [user.rows[0].user_id]);
  await pg.close();
});
