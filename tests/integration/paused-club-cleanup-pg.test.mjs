import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const databaseUrl = process.env.PG_TEST_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/blacklight_test' || process.env.HG_TEST_DATABASE_RESET !== 'yes') {
  throw new Error('Use an isolated blacklight_test database and HG_TEST_DATABASE_RESET=yes; never run on application data.');
}

const connection = new URL(databaseUrl);
connection.searchParams.set('application_name', 'paused-club-cleanup-test');
const sql = async (statement, role = true) => exec('psql', [
  connection.toString(), '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
  '-c', role ? `SET ROLE service_role; ${statement}` : statement,
], { maxBuffer: 4 * 1024 * 1024 });
const sqlValue = (value) => `'${String(value).replaceAll("'", "''")}'`;

function loadCleanupWithStorage(storage) {
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const workerDbPath = resolve('cloudfunctions/worker/shared/db.js');
  const cleanupPath = resolve('cloudfunctions/worker/tasks/cleanup.js');
  const workerDb = require(workerDbPath);
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === '../shared/db' && parent?.filename === cleanupPath) {
      return { ...workerDb, getStorage: () => storage };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[cleanupPath];
    const cleanup = require(cleanupPath);
    return { cleanup, close: () => workerDb.getDb().close() };
  } finally {
    Module._load = originalLoad;
  }
}

test('worker completes account deletion across an unrelated paused club and purges owned paused-club media', async () => {
  const prefix = `paused-cleanup-${process.pid}`;
  const userId = `${prefix}-user`;
  const ownedClub = `${prefix}-owned-club`;
  const emptyClub = `${prefix}-empty-club`;
  const postId = `${prefix}-post`;
  const assetId = `${prefix}-asset`;
  const deletedFiles = [];
  const mediaRoot = await mkdtemp(join(tmpdir(), 'blacklight-paused-cleanup-'));
  const require = createRequire(import.meta.url);
  const storage = require('../../shared/local-storage').createLocalStorageAdapter({ root: mediaRoot });
  const uploaded = await storage.uploadFile({ cloudPath: `${prefix}/fixture.jpg`, fileContent: Buffer.from('local deletion fixture') });
  const trackedStorage = {
    ...storage,
    async deleteFile(options) {
      deletedFiles.push(...options.fileList);
      return storage.deleteFile(options);
    },
  };
  const oldDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrl;
  const { cleanup, close } = loadCleanupWithStorage(trackedStorage);

  try {
    const migration = await sql("SELECT to_regprocedure('public.hg_cleanup_asset(text,text,text,jsonb,jsonb)')");
    assert.match(migration.stdout, /hg_cleanup_asset/);
    const fixture = await sql(`
      BEGIN;
      INSERT INTO public.hg_club_config (id, doc) VALUES
        (${sqlValue(ownedClub)}, jsonb_build_object('_id', ${sqlValue(ownedClub)}, 'clubId', ${sqlValue(ownedClub)}, 'name', 'Paused owned', 'status', 'paused', 'discoverable', false)),
        (${sqlValue(emptyClub)}, jsonb_build_object('_id', ${sqlValue(emptyClub)}, 'clubId', ${sqlValue(emptyClub)}, 'name', 'Paused empty', 'status', 'paused', 'discoverable', false));
      INSERT INTO public.hg_users (id, doc) VALUES
        (${sqlValue(userId)}, jsonb_build_object('_id', ${sqlValue(userId)}, 'wxOpenIdRef', ${sqlValue(`${prefix}-openid`)}, 'displayName', 'Cleanup fixture', 'status', 'active'));
      INSERT INTO public.hg_memberships (id, doc) VALUES
        (${sqlValue(`${userId}:${ownedClub}`)}, jsonb_build_object('_id', ${sqlValue(`${userId}:${ownedClub}`)}, 'userId', ${sqlValue(userId)}, 'clubId', ${sqlValue(ownedClub)}, 'role', 'member', 'status', 'active'));
      INSERT INTO public.hg_posts (id, doc) VALUES
        (${sqlValue(postId)}, jsonb_build_object('_id', ${sqlValue(postId)}, 'clubId', ${sqlValue(ownedClub)}, 'ownerId', ${sqlValue(userId)}, 'title', 'Cleanup fixture', 'body', 'Private cleanup test body', 'status', 'published', 'visibility', 'club', 'assetIds', jsonb_build_array(${sqlValue(assetId)})));
      INSERT INTO public.hg_assets (id, doc) VALUES
        (${sqlValue(assetId)}, jsonb_build_object('_id', ${sqlValue(assetId)}, 'clubId', ${sqlValue(ownedClub)}, 'ownerId', ${sqlValue(userId)}, 'postId', ${sqlValue(postId)}, 'status', 'verified', 'fileId', ${sqlValue(uploaded.fileID)}, 'cleanedFileId', '', 'reservedFileId', '', 'createdAt', now()::text));
      COMMIT;
    `);
    assert.equal(fixture.stderr, '');

    await sql(`SELECT public.hg_request_account_deletion(${sqlValue(userId)})`);
    await sql(`UPDATE public.hg_users SET doc=doc||jsonb_build_object(
      'deletionRequestedAt',(clock_timestamp()-interval '8 days')::text,
      'deletionNextAttemptAt',null,'deletionLeaseUntil',null
    ) WHERE id=${sqlValue(userId)}`);

    const result = await cleanup.processAccountDeletions([emptyClub, ownedClub]);
    assert.deepEqual(result, { processed: 1, retryable: 0 });
    assert.deepEqual(deletedFiles, [uploaded.fileID]);
    await assert.rejects(storage.downloadFile({ fileID: uploaded.fileID }), /ENOENT/);

    const state = JSON.parse((await sql(`SELECT jsonb_build_object(
      'user',(SELECT doc->>'status' FROM public.hg_users WHERE id=${sqlValue(userId)}),
      'membership',(SELECT doc->>'status' FROM public.hg_memberships WHERE id=${sqlValue(`${userId}:${ownedClub}`)}),
      'post',(SELECT jsonb_build_object('status',doc->>'status','ownerId',doc->'ownerId','body',doc->>'body') FROM public.hg_posts WHERE id=${sqlValue(postId)}),
      'assets',(SELECT count(*) FROM public.hg_assets WHERE doc->>'ownerId'=${sqlValue(userId)})
    )`)).stdout.trim());
    assert.deepEqual(state, {
      user: 'deleted',
      membership: 'removed',
      post: { status: 'deleted', ownerId: null, body: '' },
      assets: 0,
    });
  } finally {
    await sql(`
      DELETE FROM public.hg_audit_logs WHERE id IN (
        ${sqlValue(`account-deletion-request:${userId}`)}, ${sqlValue(`account-deletion:${userId}`)}
      );
      DELETE FROM public.hg_posts WHERE id=${sqlValue(postId)};
      DELETE FROM public.hg_assets WHERE id=${sqlValue(assetId)};
      DELETE FROM public.hg_memberships WHERE id=${sqlValue(`${userId}:${ownedClub}`)};
      DELETE FROM public.hg_users WHERE id=${sqlValue(userId)};
      DELETE FROM public.hg_club_config WHERE id IN (${sqlValue(ownedClub)},${sqlValue(emptyClub)});
    `).catch(() => {});
    await close().catch(() => {});
    await rm(mediaRoot, { recursive: true, force: true });
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
  }
});
