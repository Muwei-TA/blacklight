import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
const exec = promisify(execFile);
const url = process.env.PG_TEST_URL;
if (!url || new URL(url).pathname !== '/blacklight_test' || process.env.HG_TEST_DATABASE_RESET !== 'yes') {
  throw new Error('Use an isolated blacklight_test database and HG_TEST_DATABASE_RESET=yes; never run on application data.');
}
async function sql(text) {
  const { stdout } = await exec('psql', [url, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', text]);
  return stdout.trim();
}
const toggle = (user, next, comment = "'c1'") => sql(`SELECT public.hg_toggle_reaction('${user}', 'p1', ${comment}, ${next})`);
const counts = async () => JSON.parse(await sql(`SELECT jsonb_build_object('relations',
  (SELECT count(*) FROM hg_reactions WHERE doc->>'commentId'='c1'), 'counter',
  (SELECT (doc->>'reactionCount')::int FROM hg_comments WHERE id='c1'))`));
before(async () => {
  await sql(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
  END $$;
  CREATE TABLE IF NOT EXISTS hg_posts(id text PRIMARY KEY, doc jsonb NOT NULL CHECK(doc->>'_id'=id));
  CREATE TABLE IF NOT EXISTS hg_comments(id text PRIMARY KEY, doc jsonb NOT NULL CHECK(doc->>'_id'=id));
  CREATE TABLE IF NOT EXISTS hg_reactions(id text PRIMARY KEY, doc jsonb NOT NULL CHECK(doc->>'_id'=id));
  CREATE TABLE IF NOT EXISTS hg_memberships(id text PRIMARY KEY, doc jsonb NOT NULL CHECK(doc->>'_id'=id));
  GRANT ALL ON hg_posts,hg_comments,hg_reactions,hg_memberships TO service_role;`);
  await sql(readFileSync(new URL('../../cloudbase/migrations/20260925130000_atomic_reaction_toggle.sql', import.meta.url), 'utf8'));
});
beforeEach(async () => {
  await sql(`TRUNCATE hg_posts,hg_comments,hg_reactions,hg_memberships;
    INSERT INTO hg_posts VALUES('p1','{"_id":"p1","clubId":"heiguang","status":"published","visibility":"club","reactionCount":0}');
    INSERT INTO hg_comments VALUES('c1','{"_id":"c1","postId":"p1","status":"published","reactionCount":0}');
    INSERT INTO hg_memberships VALUES
      ('m1','{"_id":"m1","userId":"u1","clubId":"heiguang","status":"active"}'),
      ('m2','{"_id":"m2","userId":"u2","clubId":"heiguang","status":"active"}');`);
});
test('parallel add and remove affect the count exactly once per relationship', async () => {
  await Promise.all(Array.from({ length: 8 }, () => toggle('u1', true)));
  await toggle('u2', true);
  assert.deepEqual(await counts(), { relations: 2, counter: 2 });
  await Promise.all(Array.from({ length: 8 }, () => toggle('u1', false)));
  assert.deepEqual(await counts(), { relations: 1, counter: 1 });
});
test('post and comment reactions remain separate even for the same user and post', async () => {
  await Promise.all([toggle('u1', true), toggle('u1', true, 'NULL')]);
  assert.deepEqual(await counts(), { relations: 1, counter: 1 });
  assert.equal(await sql("SELECT doc->>'reactionCount' FROM hg_posts WHERE id='p1'"), '1');
  await toggle('u1', false, 'NULL');
  assert.deepEqual(await counts(), { relations: 1, counter: 1 });
});
test('a failed counter write rolls back the relation insert, and retry succeeds', async () => {
  await toggle('u1', true);
  await sql("ALTER TABLE hg_comments ADD CONSTRAINT injected_failure CHECK((doc->>'reactionCount')::int < 2)");
  try {
    await assert.rejects(toggle('u2', true), /injected_failure/);
    assert.deepEqual(await counts(), { relations: 1, counter: 1 });
  } finally {
    await sql('ALTER TABLE hg_comments DROP CONSTRAINT injected_failure');
  }
  await toggle('u2', true);
  assert.deepEqual(await counts(), { relations: 2, counter: 2 });
});
test('deleted or inaccessible targets fail closed', async () => {
  await sql("UPDATE hg_comments SET doc=doc||'{\"status\":\"deleted\"}'::jsonb WHERE id='c1'");
  await assert.rejects(toggle('u1', true), /REACTION_TARGET_CHANGED/);
  await assert.rejects(toggle('outsider', true, 'NULL'), /REACTION_TARGET_CHANGED/);
  assert.equal(await sql('SELECT count(*) FROM hg_reactions'), '0');
});
test('anonymous and authenticated database roles cannot execute the privileged RPC', async () => {
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(sql(`SET ROLE ${role}; SELECT hg_toggle_reaction('u1','p1','c1',true)`), /permission denied/);
  }
  await sql("SET ROLE service_role; SELECT hg_toggle_reaction('u1','p1','c1',true)");
  assert.deepEqual(await counts(), { relations: 1, counter: 1 });
});
