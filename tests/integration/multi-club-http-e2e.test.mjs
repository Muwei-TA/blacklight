import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pgPackage from 'pg';

const connection = new URL(process.env.PG_TEST_URL || 'postgresql://invalid/invalid');
if (connection.pathname !== '/blacklight_test'
  || !['localhost', '127.0.0.1'].includes(connection.hostname)
  || process.env.HG_TEST_DATABASE_RESET !== 'yes') {
  throw new Error('Use a local isolated blacklight_test database and HG_TEST_DATABASE_RESET=yes.');
}

test('real NAS HTTP and PostgreSQL isolate two communities, roles, media, XP and notifications', async () => {
  const require = createRequire(import.meta.url);
  const prefix = `http-club-${process.pid}`;
  const clubs = [`${prefix}-a`, `${prefix}-b`];
  const users = [`${prefix}-dual`, `${prefix}-only-a`, `${prefix}-only-b`];
  const mediaRoot = await mkdtemp(join(tmpdir(), 'blacklight-http-club-media-'));
  const pool = new pgPackage.Pool({ connectionString: connection.toString() });
  Object.assign(process.env, {
    DATABASE_URL: connection.toString(),
    RUNTIME_KIND: 'nas',
    NODE_ENV: 'test',
    NAS_MEDIA_DIR: mediaRoot,
    PUBLIC_API_BASE_URL: 'https://local-test.invalid',
    MINIPROGRAM_APP_ID: 'local-test',
    MINIPROGRAM_APP_SECRET: randomBytes(32).toString('hex'),
    MEDIA_URL_SECRET: randomBytes(32).toString('hex'),
    ANON_ALIAS_SECRET: randomBytes(32).toString('hex'),
  });
  const store = require('../../shared/pg-store');
  const db = require('../../shared/db');
  const auth = require('../../server/auth');
  const { createServer } = require('../../server/index');
  const server = createServer();
  const createdPostIds = [];
  const now = new Date().toISOString();
  const insert = async (table, document) => {
    assert.match(table, /^hg_[a-z_]+$/);
    await pool.query(`INSERT INTO public.${table}(id,doc) VALUES($1,$2::jsonb)`, [document._id, JSON.stringify(document)]);
  };
  try {
    await pool.query(readFileSync(new URL('../../deploy/nas/compat/020_hg_sessions.sql', import.meta.url), 'utf8'));
    for (const clubId of clubs) {
      await insert('hg_club_config', {
        _id: clubId, name: clubId === clubs[0] ? '合成文学社' : '合成摄影社',
        description: '仅本机测试', status: 'active', discoverable: true, rulesVersion: '1',
        capabilities: { publishing: true, uploads: true, publicScope: false },
        usageLimits: { userUploadDailyBytes: 20971520, clubUploadDailyBytes: 209715200, reviewDailyCalls: 1000, warningRatio: 0.8 },
      });
    }
    for (const userId of users) {
      await insert('hg_users', { _id: userId, wxOpenIdRef: `${userId}-openid`, displayName: '本机测试账号', status: 'active', createdAt: now });
    }
    for (const [userId, clubId, role] of [
      [users[0], clubs[0], 'admin'], [users[0], clubs[1], 'member'],
      [users[1], clubs[0], 'member'], [users[2], clubs[1], 'admin'],
    ]) {
      await insert('hg_memberships', { _id: `${userId}:${clubId}`, userId, clubId, role, status: 'active', joinedAt: now, version: 1 });
    }
    const tokens = await Promise.all(users.map((userId) => auth.issueSession(`${userId}-openid`)));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = async (index, clubId, action, payload = {}) => {
      const response = await fetch(`${origin}/v1/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[index].token}` },
        body: JSON.stringify({ clubId, action, payload }),
      });
      const body = await response.json();
      return { status: response.status, body };
    };
    for (const [clubId, role] of [[clubs[0], 'admin'], [clubs[1], 'member']]) {
      const result = await call(0, clubId, 'session/me');
      assert.equal(result.body.code, 0);
      assert.equal(result.body.data.club.id, clubId);
      assert.equal(result.body.data.role, role);
    }
    const concurrentSessions = await Promise.all(Array.from({ length: 8 }, (_, index) => call(0, clubs[index % 2], 'session/me')));
    concurrentSessions.forEach((result, index) => assert.equal(result.body.data.club.id, clubs[index % 2]));
    const mine = await call(0, undefined, 'clubs/mine');
    assert.equal(mine.body.code, 0);
    assert.deepEqual(mine.body.data.list.filter((club) => clubs.includes(club.id)).map((club) => club.id).sort(), [...clubs].sort());
    const directory = await call(0, undefined, 'clubs/list');
    assert.equal(directory.body.code, 0);
    assert.deepEqual(directory.body.data.list.filter((club) => clubs.includes(club.id)).map((club) => club.id).sort(), [...clubs].sort(),
      'the public directory must include discoverable clubs other than heiguang');
    const originalDefault = (await pool.query("SELECT doc FROM public.hg_club_config WHERE id='heiguang'")).rows[0];
    if (originalDefault) {
      try {
        await pool.query("UPDATE public.hg_club_config SET doc=doc || '{\"status\":\"paused\"}'::jsonb WHERE id='heiguang'");
        const account = await call(2, undefined, 'account/me');
        assert.equal(account.body.code, 0, 'account bootstrap must work even if the default club is paused');
        assert.equal(account.body.data.user.id, users[2]);
        assert.equal(account.body.data.club, null);
      } finally {
        await pool.query("UPDATE public.hg_club_config SET doc=$1::jsonb WHERE id='heiguang'", [JSON.stringify(originalDefault.doc)]);
      }
    }
    const unknown = await call(0, `${prefix}-missing`, 'session/me');
    assert.notEqual(unknown.body.code, 0);
    const invalidRole = await call(0, clubs[1], 'admin/usage/status', { role: 'admin', userId: users[2], clubId: clubs[0] });
    assert.notEqual(invalidRole.body.code, 0);
    assert.notEqual((await call(0, undefined, 'platform/clubs/list', {
      platformRole: 'developer', userId: users[2],
    })).body.code, 0, 'client-supplied platform privileges must be ignored');
    const changePlatformRole = (role, expected) => promisify(execFile)(process.execPath, [
      new URL('../../scripts/local-platform-role.mjs', import.meta.url).pathname,
      '--user-id', users[0], '--role', role, '--expected-role', expected,
      '--reason', '本机隔离环境验证账号级开发者授予与撤销', '--operator', 'synthetic-local-test',
    ], { env: { ...process.env, DATABASE_URL: connection.toString() } });
    await changePlatformRole('developer', 'none');
    const developerAccount = await call(0, undefined, 'account/me');
    assert.equal(developerAccount.body.data.platformRole, 'developer');
    assert.equal(developerAccount.body.data.club, null);
    const developerClubSession = await call(0, clubs[1], 'session/me');
    assert.equal(developerClubSession.body.data.platformRole, 'developer');
    assert.equal(developerClubSession.body.data.role, 'member', 'platform role must preserve club membership role');
    assert.equal((await call(0, undefined, 'platform/clubs/list')).body.code, 0,
      'developer administration must work without a selected club');

    for (const clubId of clubs) {
      await insert('hg_posts', {
        _id: `${clubId}-post`, clubId, ownerId: clubId === clubs[0] ? users[1] : users[2], kind: 'fragment', title: '', body: `${clubId} 私有社内内容`,
        identityMode: 'named', visibility: 'club', status: 'published', version: 1,
        commentsEnabled: true, assetIds: [], reactionCount: 0, commentCount: 0, createdAt: now,
      });
      await insert('hg_notifications', {
        _id: `${clubId}-notice`, clubId, recipientId: users[0], eventType: 'system',
        targetType: 'post', targetId: `${clubId}-post`, readAt: null, createdAt: now,
      });
    }
    assert.equal((await call(1, clubs[0], 'posts/detail', { id: `${clubs[0]}-post` })).body.code, 0);
    for (const [index, selectedClub, postClub] of [[1, clubs[0], clubs[1]], [2, clubs[1], clubs[0]], [0, clubs[1], clubs[0]]]) {
      assert.notEqual((await call(index, selectedClub, 'posts/detail', { id: `${postClub}-post` })).body.code, 0);
    }
    for (const clubId of clubs) {
      const feed = await call(0, clubId, 'posts/list');
      assert.equal(feed.body.code, 0);
      assert.deepEqual(feed.body.data.items.map((post) => post.id), [`${clubId}-post`]);
      assert.equal((await call(0, clubId, 'notifications/unread-count')).body.data.count, 1);
    }
    assert.equal((await call(0, clubs[0], 'notifications/read-all')).body.code, 0);
    assert.equal((await call(0, clubs[0], 'notifications/unread-count')).body.data.count, 0);
    assert.equal((await call(0, clubs[1], 'notifications/unread-count')).body.data.count, 1);

    const storage = db.getStorage();
    const uploaded = await storage.uploadFile({ cloudPath: `${prefix}/sample.jpg`, fileContent: Buffer.from('synthetic-media-fixture') });
    const assetId = `${prefix}-asset`;
    await insert('hg_assets', { _id: assetId, clubId: clubs[0], ownerId: users[1], postId: `${clubs[0]}-post`, fileId: uploaded.fileID,
      mediaType: 'image', status: 'verified', permissionVersion: 1, sizeBytes: 23, createdAt: now });
    await pool.query("UPDATE public.hg_posts SET doc=doc || jsonb_build_object('assetIds', $1::jsonb, 'permissionVersion', 1) WHERE id=$2",
      [JSON.stringify([assetId]), `${clubs[0]}-post`]);
    assert.notEqual((await call(0, clubs[1], 'assets/status', { assetId })).body.code, 0);
    const signed = await call(0, clubs[0], 'assets/status', { assetId });
    assert.equal(signed.body.code, 0);
    const mediaUrl = new URL(signed.body.data.tempFileURL || signed.body.data.url);
    const download = () => fetch(`${origin}${mediaUrl.pathname}${mediaUrl.search}`);
    assert.equal((await download()).status, 200);

    const privatePayload = { kind: 'fragment', title: '', body: '本机私密草稿验收', visibility: 'private', identityMode: 'named', commentsEnabled: false, assetIds: [], idempotencyKey: `${prefix}-same-key` };
    for (const clubId of clubs) {
      const created = await call(0, clubId, 'posts/create', privatePayload);
      assert.equal(created.body.code, 0, JSON.stringify(created.body));
      createdPostIds.push(created.body.data.id);
      const retry = await call(0, clubId, 'posts/create', privatePayload);
      assert.equal(retry.body.data.id, created.body.data.id);
    }
    assert.notEqual(createdPostIds[0], createdPostIds[1]);
    const otherActor = await call(1, clubs[0], 'posts/create', privatePayload);
    assert.equal(otherActor.body.code, 0, JSON.stringify(otherActor.body));
    assert.notEqual(otherActor.body.data.id, createdPostIds[0], 'the same client key must be independent for another account');
    for (const clubId of clubs) {
      const checked = await call(0, clubId, 'me/check-in');
      assert.equal(checked.body.code, 0, JSON.stringify(checked.body));
      assert.equal(checked.body.data.awardedXp, 5);
      assert.equal((await call(0, clubId, 'me/check-in')).body.data.awardedXp, 0);
    }
    await pool.query("UPDATE public.hg_memberships SET doc=doc || '{\"status\":\"removed\"}'::jsonb WHERE id=$1", [`${users[0]}:${clubs[0]}`]);
    assert.equal((await call(0, clubs[0], 'session/me')).body.data.role, 'guest');
    assert.notEqual((await call(0, clubs[0], 'posts/detail', { id: `${clubs[0]}-post` })).body.code, 0);
    assert.equal((await call(0, clubs[0], 'posts/detail', { id: createdPostIds[0] })).body.code, 0,
      'removal retains the author own-data access inside the original club');
    assert.notEqual((await call(0, clubs[0], 'posts/detail', { id: createdPostIds[1] })).body.code, 0);
    assert.equal((await download()).status, 404);
    assert.equal((await call(0, clubs[1], 'posts/detail', { id: `${clubs[1]}-post` })).body.code, 0);
    await changePlatformRole('none', 'developer');
    assert.notEqual((await call(0, undefined, 'platform/clubs/list')).body.code, 0,
      'revoking developer role must apply to the existing session token immediately');
    assert.equal((await call(0, clubs[1], 'session/me')).body.data.role, 'member');
    const roleAudits = await pool.query("SELECT doc FROM public.hg_audit_logs WHERE doc->>'targetId'=$1 AND doc->>'action'='platform.role.set'", [users[0]]);
    assert.equal(roleAudits.rows.length, 2, 'both grant and revoke must leave an audit record');
  } finally {
    await new Promise((resolve) => server.listening ? server.close(resolve) : resolve());
    await store.close();
    await pool.query('DELETE FROM public.hg_sessions WHERE openid_ref=ANY($1::text[])', [users.map((userId) => `${userId}-openid`)]);
    await pool.query('DELETE FROM public.hg_user_xp_events WHERE user_id=ANY($1::text[])', [users]);
    await pool.query('DELETE FROM public.hg_user_xp_accounts WHERE user_id=ANY($1::text[])', [users]);
    for (const table of Object.values(require('../../shared/constants').COLLECTIONS)) {
      assert.match(table, /^hg_[a-z_]+$/);
      await pool.query(`DELETE FROM public.${table} WHERE id LIKE $1 OR doc->>'clubId'=ANY($2::text[])
        OR doc->>'userId'=ANY($3::text[]) OR doc->>'ownerId'=ANY($3::text[]) OR doc->>'recipientId'=ANY($3::text[])
        OR doc->>'targetId'=ANY($3::text[])`,
      [`${prefix}%`, clubs, users]);
    }
    await pool.end();
    await rm(mediaRoot, { recursive: true, force: true });
  }
});
