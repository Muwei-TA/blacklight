import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const policies = require('../../shared/policies.js');
const url = process.env.PG_TEST_URL;

test('developer platform management preserves content isolation and audits transactional mutations', { skip: !url }, async () => {
  assert.equal(new URL(url).pathname, '/blacklight_test');
  assert.equal(process.env.HG_TEST_DATABASE_RESET, 'yes');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query("SELECT to_regprocedure('public.hg_platform_clubs(text,text,jsonb)') AS name");
    if (!exists.rows[0].name) await client.query(await readFile(new URL('../../cloudbase/migrations/20261003090000_platform_developer.sql', import.meta.url), 'utf8'));
    for (const [id, role] of [['dev-platform-test', 'developer'], ['member-platform-test', 'none']]) {
      await client.query('INSERT INTO hg_users(id,doc) VALUES($1,$2::jsonb)', [id, JSON.stringify({ _id: id, status: 'active', platformRole: role })]);
    }
    const rpc = (actor, action, payload = {}) => client.query('SELECT hg_platform_clubs($1,$2,$3::jsonb) AS value', [actor, action, JSON.stringify(payload)]);
    const fails = async (call, marker) => {
      await client.query('SAVEPOINT invalid');
      await assert.rejects(call, marker);
      await client.query('ROLLBACK TO SAVEPOINT invalid');
    };
    await fails(() => rpc('member-platform-test', 'list'), /FORBIDDEN/);
    const payload = { id: 'platform-test-club', config: { name: '测试社团', description: '', discoverable: false, publishing: true, uploads: false }, moderatorUserId: 'member-platform-test', reason: '隔离数据库验证开发者社团配置功能' };
    await rpc('dev-platform-test', 'create', payload);
    const listed = (await rpc('dev-platform-test', 'list')).rows[0].value.list;
    assert.ok(listed.some((club) => club.id === payload.id && club.publishing === true && club.uploads === false));
    await fails(() => rpc('dev-platform-test', 'update', { ...payload, expectedVersion: 1, config: { publishing: null } }), /INVALID_INPUT/);
    await fails(() => rpc('dev-platform-test', 'update', { ...payload, expectedVersion: null }), /INVALID_INPUT/);
    await fails(() => rpc('dev-platform-test', 'update', { ...payload, expectedVersion: 0 }), /VERSION_CONFLICT/);
    await fails(() => rpc('dev-platform-test', 'update', { ...payload, expectedVersion: 1, config: { capabilities: { publishing: true } } }), /INVALID_INPUT/);
    await rpc('dev-platform-test', 'set-status', { ...payload, expectedVersion: 1, status: 'paused' });
    await rpc('dev-platform-test', 'set-status', { ...payload, expectedVersion: 2, status: 'active' });
    await fails(() => rpc('dev-platform-test', 'set-moderator', { ...payload, expectedVersion: 3, moderatorUserId: 'does-not-exist' }), /TARGET_USER_INVALID/);
    const audit = await client.query("SELECT doc FROM hg_audit_logs WHERE doc->>'scope'='platform' AND doc->>'targetId'=$1", [payload.id]);
    assert.equal(audit.rows.length, 3);
    assert.ok(audit.rows.every(({ doc }) => doc.reason && doc.before && doc.after && doc.actorId === 'dev-platform-test'));
    await client.query("UPDATE hg_users SET doc=doc||'{\"platformRole\":\"none\"}'::jsonb WHERE id='dev-platform-test'");
    await fails(() => rpc('dev-platform-test', 'list'), /FORBIDDEN/);
    const viewer = policies.buildViewer({ userId: 'dev-platform-test', platformRole: 'developer', clubId: payload.id });
    assert.equal(viewer.isDeveloper, true);
    assert.equal(viewer.isAdmin, false);
    assert.equal(viewer.isModerator, false);
    assert.equal(policies.canReadPost(viewer, { clubId: payload.id, visibility: 'private', status: 'published', ownerId: 'other' }), false);
    assert.equal(policies.canReadPost(viewer, { clubId: 'other-club', visibility: 'public', status: 'published' }), false);
    assert.equal(policies.canRevealAnonymousMapping(viewer, { reason: payload.reason }), false);
  } finally { await client.query('ROLLBACK'); await client.end(); }
});
