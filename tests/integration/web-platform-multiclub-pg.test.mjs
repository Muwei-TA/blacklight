import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readMigrationSet } from '../../scripts/local-migration-lib.mjs';

const require = createRequire(import.meta.url);
const connectionString = process.env.PG_TEST_URL;
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

if (connectionString) {
  const target = new URL(connectionString);
  if (!allowedHosts.has(target.hostname)
    || target.pathname !== '/blacklight_test'
    || process.env.HG_TEST_DATABASE_RESET !== 'yes') {
    throw new Error('Use only a local disposable blacklight_test with HG_TEST_DATABASE_RESET=yes.');
  }
}

const execFileAsync = promisify(execFile);

test('website developer account creates isolated clubs through its cookie session', { skip: !connectionString }, async (t) => {
  const originalEnv = Object.fromEntries([
    'DATABASE_URL', 'DATABASE_URL_FILE', 'NODE_ENV', 'RUNTIME_KIND', 'REVIEW_PROVIDER',
    'PUBLIC_API_BASE_URL', 'WEB_REGISTRATION', 'WEB_TRUSTED_PROXY_IPS', 'ANON_ALIAS_SECRET',
  ].map((key) => [key, process.env[key]]));
  process.env.DATABASE_URL = connectionString;
  delete process.env.DATABASE_URL_FILE;
  process.env.NODE_ENV = 'test';
  process.env.RUNTIME_KIND = 'nas';
  process.env.REVIEW_PROVIDER = 'manual';
  process.env.WEB_TRUSTED_PROXY_IPS = '127.0.0.1';
  process.env.ANON_ALIAS_SECRET = crypto.randomBytes(32).toString('hex');
  delete process.env.PUBLIC_API_BASE_URL;
  delete process.env.WEB_REGISTRATION;

  const pg = require('../../shared/pg-store.js');
  const apiPg = require('../../cloudfunctions/api/shared/pg-store.js');
  const { Pool } = require('pg');
  const { createWebAuth, digest } = require('../../server/web-auth.js');
  const { createServer } = require('../../server/index.js');
  const { COLLECTIONS } = require('../../shared/constants.js');
  const cleanupPool = new Pool({ connectionString, max: 1, application_name: 'blacklight-web-platform-test-cleanup' });

  const tag = crypto.randomBytes(6).toString('hex');
  const username = `dev_${tag}`;
  const clubIds = [`web-dev-${tag}-a`, `web-dev-${tag}-b`, `web-dev-${tag}-unassigned`];
  const [clubA, clubB, unassignedClub] = clubIds;
  const proxyAddress = `10.233.${crypto.randomBytes(1)[0]}.${crypto.randomBytes(1)[0]}`;
  const rateLimitBuckets = [
    digest(`register:ip:${proxyAddress}`),
    digest(`register:account:${username}`),
  ];
  let developerId = null;
  let privatePostId = null;
  const auth = createWebAuth({ database: pg });
  const server = createServer({ websiteAuth: auth });

  t.after(async () => {
    try {
      if (server.listening) await new Promise((resolve) => server.close(resolve));

      const account = await cleanupPool.query('SELECT user_id FROM public.hg_web_accounts WHERE username = $1', [username]);
      const userId = developerId || account.rows[0]?.user_id || '';
      const entityIds = [userId, ...clubIds, ...(privatePostId ? [privatePostId, `review:${privatePostId}`] : [])].filter(Boolean);
      const targetIds = [userId, privatePostId].filter(Boolean);
      for (const table of Object.values(COLLECTIONS)) {
        assert.match(table, /^hg_[a-z_]+$/);
        await cleanupPool.query(`
          DELETE FROM public.${table}
           WHERE id = ANY($1::text[])
              OR doc->>'clubId' = ANY($2::text[])
              OR doc->>'userId' = $3
              OR doc->>'ownerId' = $3
              OR doc->>'actorId' = $3
              OR doc->>'recipientId' = $3
              OR doc->>'targetId' = ANY($4::text[])
        `, [entityIds, clubIds, userId, targetIds]);
      }
      await cleanupPool.query('DELETE FROM public.hg_web_auth_limits WHERE bucket_hash = ANY($1::text[])', [rateLimitBuckets]);
      if (userId) {
        await cleanupPool.query('DELETE FROM public.hg_web_accounts WHERE user_id = $1', [userId]);
        await cleanupPool.query('DELETE FROM public.hg_users WHERE id = $1', [userId]);
      }
    } finally {
      await cleanupPool.end();
      await pg.close();
      await apiPg.close();
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  const preflight = await cleanupPool.query(`
    SELECT current_database() AS database_name, inet_server_addr()::text AS server_address,
      to_regclass('public.hg_web_accounts') IS NOT NULL AS web_accounts,
      to_regclass('public.hg_web_sessions') IS NOT NULL AS web_sessions,
      to_regclass('public.hg_web_auth_limits') IS NOT NULL AS web_limits,
      to_regclass('nas_meta.schema_migrations') IS NOT NULL AS migration_ledger,
      to_regprocedure('public.hg_platform_clubs(text,text,jsonb)') IS NOT NULL AS platform_rpc,
      to_regprocedure('public.hg_user_clubs(text)') IS NOT NULL AS user_clubs_rpc,
      to_regprocedure('public.hg_create_post(text,text,jsonb,jsonb,text)') IS NOT NULL AS create_post_rpc
  `);
  assert.equal(preflight.rows[0].database_name, 'blacklight_test');
  assert.ok(preflight.rows[0].server_address, 'connect to the database over the validated loopback TCP endpoint');
  for (const key of ['web_accounts', 'web_sessions', 'web_limits', 'migration_ledger', 'platform_rpc', 'user_clubs_rpc', 'create_post_rpc']) {
    assert.equal(preflight.rows[0][key], true, `isolated DB migration is missing ${key}`);
  }
  const migrationSet = await readMigrationSet();
  const trackedMigrations = ['20261003100000_admin_governance.sql', '20261004100000_fix_platform_club_advisory_lock.sql'];
  const expectedChecksums = new Map(migrationSet.migrations
    .filter(({ name }) => trackedMigrations.includes(name))
    .map(({ name, sha256 }) => [name, sha256]));
  assert.equal(expectedChecksums.size, trackedMigrations.length);
  const recordedChecksums = await cleanupPool.query(
    'SELECT migration_name, sha256 FROM nas_meta.schema_migrations WHERE migration_name = ANY($1::text[])',
    [trackedMigrations],
  );
  assert.equal(recordedChecksums.rows.length, trackedMigrations.length, 'isolated DB migration ledger must include the old and forward migrations');
  for (const row of recordedChecksums.rows) {
    assert.equal(row.sha256, expectedChecksums.get(row.migration_name), `${row.migration_name} checksum`);
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_API_BASE_URL = base;

  function browser() {
    let cookie = '';
    let csrfToken = '';
    return {
      async request(path, body, extraHeaders = {}) {
        const headers = {
          ...(body ? { 'content-type': 'application/json', origin: base, 'x-csrf-token': csrfToken } : {}),
          ...(cookie ? { cookie } : {}),
          ...extraHeaders,
        };
        const response = await fetch(`${base}${path}`, {
          method: body ? 'POST' : 'GET',
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        const json = await response.json();
        if (json.data?.csrfToken) csrfToken = json.data.csrfToken;
        return { status: response.status, ...json };
      },
      action(action, payload = {}, clubId) {
        return this.request('/v1/web/action', { action, payload, ...(clubId ? { clubId } : {}) }, {
          'x-forwarded-for': proxyAddress,
        });
      },
      getCookie: () => cookie,
    };
  }

  const account = browser();
  const registration = await account.request('/v1/web/auth/register', {
    username,
    password: 'isolated web test password 123',
    displayName: '隔离测试开发者',
    platformRole: 'developer',
    userId: 'forged-user-id',
    role: 'moderator',
  }, { 'x-forwarded-for': proxyAddress });
  assert.equal(registration.status, 200, JSON.stringify(registration));
  assert.equal(registration.data.sessionToken, undefined);

  const initialSession = await account.request('/v1/web/session');
  assert.equal(initialSession.status, 200);
  assert.equal(initialSession.data.authenticated, true);
  developerId = initialSession.data.user.id;
  assert.ok(developerId);
  assert.equal(initialSession.data.platformRole, 'none', 'registration payload cannot grant the platform role');
  assert.equal(initialSession.data.role, 'guest');
  assert.equal(initialSession.data.club, null);
  assert.deepEqual((await account.action('clubs/mine')).data.list, [], 'new website account starts with no memberships');

  await execFileAsync(process.execPath, [
    fileURLToPath(new URL('../../scripts/local-platform-role.mjs', import.meta.url)),
    '--user-id', developerId,
    '--role', 'developer',
    '--expected-role', 'none',
    '--reason', '隔离网站多社团平台开发者授权验收',
    '--operator', 'isolated-test-harness',
  ], {
    env: { ...process.env, DATABASE_URL: connectionString, DATABASE_URL_FILE: '' },
    timeout: 15000,
    maxBuffer: 4096,
  });

  const developerSession = await account.request('/v1/web/session');
  assert.equal(developerSession.data.user.id, developerId);
  assert.equal(developerSession.data.platformRole, 'developer', 'server-side role grant is visible on the existing cookie session');
  assert.equal(developerSession.data.role, 'guest');
  assert.deepEqual((await account.action('clubs/mine')).data.list, []);

  for (const [clubId, name] of [[clubA, '隔离测试社团 A'], [clubB, '隔离测试社团 B']]) {
    const created = await account.action('platform/clubs/create', {
      id: clubId,
      moderatorUserId: developerId,
      config: { name, description: '仅供隔离验收', discoverable: true, publishing: true },
      reason: '隔离网站多社团创建权限验收',
      platformRole: 'none',
      userId: 'forged-user-id',
    });
    assert.equal(created.status, 200);
    assert.equal(created.code, 0, JSON.stringify(created));
    assert.equal(created.data.id, clubId);
  }

  const platformDirectory = await account.action('platform/clubs/list');
  assert.equal(platformDirectory.code, 0, JSON.stringify(platformDirectory));
  assert.deepEqual(
    platformDirectory.data.list.filter(({ id }) => clubIds.slice(0, 2).includes(id)).map(({ id }) => id).sort(),
    [clubA, clubB].sort(),
  );
  const publicDirectory = await account.action('clubs/list');
  assert.equal(publicDirectory.code, 0, JSON.stringify(publicDirectory));
  assert.ok(clubIds.slice(0, 2).every((id) => publicDirectory.data.list.some((club) => club.id === id)));
  const memberships = await account.action('clubs/mine');
  assert.equal(memberships.code, 0, JSON.stringify(memberships));
  assert.deepEqual(
    memberships.data.list.filter(({ id }) => clubIds.slice(0, 2).includes(id))
      .map(({ id, role, memberStatus }) => ({ id, role, memberStatus }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    [clubA, clubB].sort().map((id) => ({ id, role: 'moderator', memberStatus: 'active' }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );

  for (const clubId of [clubA, clubB, clubA]) {
    const selected = await account.action('session/me', {}, clubId);
    assert.equal(selected.code, 0, JSON.stringify(selected));
    assert.equal(selected.data.user.id, developerId);
    assert.equal(selected.data.club.id, clubId, 'the same cookie resolves against the explicitly selected club');
    assert.equal(selected.data.role, 'moderator');
    assert.equal(selected.data.platformRole, 'developer');
  }

  await cleanupPool.query('INSERT INTO public.hg_club_config(id, doc) VALUES ($1, $2::jsonb)', [unassignedClub, JSON.stringify({
    _id: unassignedClub,
    clubId: unassignedClub,
    name: '未指定权限隔离夹具',
    status: 'active',
    discoverable: false,
    capabilities: { publishing: true },
  })]);
  const unassignedSession = await account.action('session/me', {}, unassignedClub);
  assert.equal(unassignedSession.code, 0, JSON.stringify(unassignedSession));
  assert.equal(unassignedSession.data.platformRole, 'developer');
  assert.equal(unassignedSession.data.role, 'guest', 'platform developer is not a moderator in an unassigned club');
  assert.equal(unassignedSession.data.memberStatus, 'none');
  const deniedQueue = await account.action('admin/queue', { queue: 'content' }, unassignedClub);
  assert.equal(deniedQueue.code, 'forbidden', JSON.stringify(deniedQueue));

  const privatePost = await account.action('posts/create', {
    kind: 'fragment',
    body: '仅用于跨社团权限隔离验收的私密内容',
    visibility: 'private',
    identityMode: 'named',
    commentsEnabled: false,
    idempotencyKey: crypto.randomUUID(),
  }, clubA);
  assert.equal(privatePost.code, 0, JSON.stringify(privatePost));
  privatePostId = privatePost.data.id;
  assert.ok(privatePostId);
  assert.equal((await account.action('posts/detail', { id: privatePostId }, clubA)).code, 0);
  const crossClubPrivate = await account.action('posts/detail', { id: privatePostId }, clubB);
  assert.equal(crossClubPrivate.code, 'not_accessible', JSON.stringify(crossClubPrivate));
});
