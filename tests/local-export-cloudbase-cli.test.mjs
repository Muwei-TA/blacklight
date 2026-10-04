import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readMigrationSet } from '../scripts/local-migration-lib.mjs';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXPORT_SCRIPT = resolve(REPOSITORY_ROOT, 'scripts/local-export-cloudbase-cli.mjs');
const IMPORT_SCRIPT = resolve(REPOSITORY_ROOT, 'scripts/local-import-snapshot.mjs');
const PERSONAL_MARKER = 'PRIVATE_ROW_SENTINEL_93841';
const SIGNED_URL_MARKER = 'SIGNED_URL_SENTINEL_38291';

const fakeCliSource = String.raw`#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

function main() {
const credentialNames = [
  'CLOUDBASE_APIKEY', 'CLOUDBASE_API_KEY', 'TCB_APIKEY', 'TCB_API_KEY',
  'TCB_SECRET_ID', 'TCB_SECRET_KEY', 'TENCENTCLOUD_SECRET_ID',
  'TENCENTCLOUD_SECRET_KEY', 'TENCENTCLOUD_SESSION_TOKEN',
];
if (credentialNames.some((name) => process.env[name])) process.exit(90);

const args = process.argv.slice(2);
const mode = process.env.FAKE_TCB_MODE || 'success';
const json = (value) => process.stdout.write(JSON.stringify(value));
const tableFromSql = (sql) => sql.match(/FROM public\."([a-z][a-z0-9_]*)"/)?.[1];
const rowFor = (table) => {
  if (table === 'hg_users') return { id: 'synthetic-user', nickname: '${PERSONAL_MARKER}' };
  if (table === 'hg_club_config') return { id: 'heiguang', doc: {} };
  if (table === 'hg_assets') return {
    id: 'synthetic-asset',
    doc: { fileId: 'pgstore://blacklight-private/private/image/test.png' },
  };
  return { id: 'synthetic-row' };
};
const rowCount = (table) => {
  if (mode === 'page-mismatch') return 1;
  return ['hg_users', 'hg_club_config', 'hg_assets'].includes(table) ? 1 : 0;
};

if (args[0] === 'db' && args[1] === 'execute') {
  if (mode === 'db-failure') {
    process.stderr.write('${PERSONAL_MARKER} must never reach the exporter output\n');
    process.exit(7);
  }
  const sql = args[args.indexOf('--sql') + 1];
  const table = tableFromSql(sql);
  if (!table) process.exit(8);
  if (/^SELECT count\(\*\)/i.test(sql)) {
    const count = rowCount(table);
    return json({ data: { Columns: ['count'], Rows: [JSON.stringify([String(count)])] } });
  }
  if (mode === 'page-mismatch') {
    return json({ data: { Columns: ['row'], Rows: [] } });
  }
  const match = sql.match(/OFFSET (\d+)$/);
  const offset = Number(match?.[1] || 0);
  const rows = offset === 0 && rowCount(table) > 0
    ? [JSON.stringify([JSON.stringify(rowFor(table))])]
    : [];
  return json({ data: { Columns: ['row'], Rows: rows } });
}

if (args[0] === 'storage' && args[1] === 'objects' && args[2] === 'list') {
  if (mode === 'cursor-invalid') return json({ data: { objects: [], hasNext: true } });
  const cursorIndex = args.indexOf('--cursor');
  const cursor = cursorIndex >= 0 ? args[cursorIndex + 1] : null;
  if (cursor) return json({ data: { objects: [], hasNext: false } });
  return json({ data: {
    objects: [{ name: 'private/image/test.png' }],
    hasNext: true,
    nextCursor: 'synthetic-cursor',
  } });
}

if (args[0] === 'storage' && args[1] === 'objects' && args[2] === 'download') {
  if (mode === 'download-failure') {
    process.stdout.write('https://signed.example/${SIGNED_URL_MARKER}\n');
    process.exit(9);
  }
  writeFileSync(args[4], Buffer.from('synthetic-image-bytes'), { mode: 0o666 });
  return;
}

process.exit(10);
}

main();
`;

async function setupFakeCli(t, mode = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'blacklight-cli-export-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await mkdir(bin, { mode: 0o700 });
  const fakeCli = join(bin, 'fake-tcb.mjs');
  const wrapper = join(bin, 'tcb');
  await writeFile(fakeCli, fakeCliSource, { mode: 0o600 });
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fakeCli}" "$@"\n`, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  const snapshot = join(root, 'snapshot');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH || ''}`,
    TCB_ENV_ID: 'synthetic-env',
    FAKE_TCB_MODE: mode,
    CLOUDBASE_APIKEY: 'SYNTHETIC_KEY_MUST_NOT_BE_PASSED',
    CLOUDBASE_API_KEY: 'SYNTHETIC_KEY_MUST_NOT_BE_PASSED',
    TCB_APIKEY: 'SYNTHETIC_KEY_MUST_NOT_BE_PASSED',
    TCB_API_KEY: 'SYNTHETIC_KEY_MUST_NOT_BE_PASSED',
    TCB_SECRET_ID: 'SYNTHETIC_KEY_MUST_NOT_BE_PASSED',
    TCB_SECRET_KEY: 'SYNTHETIC_KEY_MUST_NOT_BE_PASSED',
    TENCENTCLOUD_SECRET_ID: 'SYNTHETIC_KEY_MUST_NOT_BE_PASSED',
    TENCENTCLOUD_SECRET_KEY: 'SYNTHETIC_KEY_MUST_NOT_BE_PASSED',
    TENCENTCLOUD_SESSION_TOKEN: 'SYNTHETIC_KEY_MUST_NOT_BE_PASSED',
  };
  return { root, snapshot, env };
}

function runNode(script, parameters, env) {
  return spawnSync(process.execPath, [script, ...parameters], {
    cwd: REPOSITORY_ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function runExport(t, mode = 'success') {
  const fixture = await setupFakeCli(t, mode);
  const result = runNode(EXPORT_SCRIPT, ['--writes-quiesced', '--out', fixture.snapshot], fixture.env);
  return { ...fixture, result };
}

test('CLI exporter produces a private snapshot accepted by verify-only', async (t) => {
  const { snapshot, env, result } = await runExport(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /snapshot complete: tables=37, rows=3, media=1/);
  for (const secret of ['SYNTHETIC_KEY_MUST_NOT_BE_PASSED', PERSONAL_MARKER, SIGNED_URL_MARKER]) {
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  }

  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'blacklight-cloudbase-snapshot-v1');
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.schema.fingerprint, (await readMigrationSet()).fingerprint);
  const snapshotStat = await stat(snapshot);
  const manifestStat = await stat(join(snapshot, 'manifest.json'));
  const tableDirectoryStat = await stat(join(snapshot, 'tables'));
  const tableFileStat = await stat(join(snapshot, 'tables', 'hg_users.jsonl'));
  const mediaIndexStat = await stat(join(snapshot, 'media-index.jsonl'));
  const mediaFileStat = await stat(join(snapshot, 'media', 'private', 'image', 'test.png'));
  assert.equal(snapshotStat.mode & 0o777, 0o700);
  assert.equal(manifestStat.mode & 0o777, 0o600);
  assert.equal(tableDirectoryStat.mode & 0o777, 0o700);
  assert.equal(tableFileStat.mode & 0o777, 0o600);
  assert.equal(mediaIndexStat.mode & 0o777, 0o600);
  assert.equal(mediaFileStat.mode & 0o777, 0o600);

  const verified = runNode(IMPORT_SCRIPT, ['--writes-paused', '--snapshot', snapshot, '--verify-only'], env);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /snapshot verified: tables=37, rows=3, media=1/);
});

for (const [mode, expectedCode] of [
  ['db-failure', 'TABLE_COUNT_FAILED'],
  ['page-mismatch', 'TABLE_PAGE_MISMATCH'],
  ['cursor-invalid', 'MEDIA_LIST_CURSOR_INVALID'],
  ['download-failure', 'MEDIA_DOWNLOAD_FAILED'],
]) {
  test(`CLI exporter leaves an incomplete manifest on ${mode}`, async (t) => {
    const { snapshot, result } = await runExport(t, mode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`snapshot incomplete \\(${expectedCode}\\)`));
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(output.includes(PERSONAL_MARKER), false);
    assert.equal(output.includes(SIGNED_URL_MARKER), false);
    assert.equal(output.includes('SYNTHETIC_KEY_MUST_NOT_BE_PASSED'), false);
    const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.status, 'incomplete');
    assert.equal(manifest.failureCode, expectedCode);
  });
}

test('CLI exporter refuses to start without the writes-quiesced gate', async (t) => {
  const { snapshot, env } = await setupFakeCli(t);
  const result = runNode(EXPORT_SCRIPT, ['--out', snapshot], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /WRITES_NOT_QUIESCED/);
  await assert.rejects(stat(snapshot), { code: 'ENOENT' });
});
