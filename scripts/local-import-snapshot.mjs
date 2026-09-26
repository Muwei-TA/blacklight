import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { REPOSITORY_ROOT, readMigrationSet, sha256 } from './local-migration-lib.mjs';

const SNAPSHOT_FORMAT = 'blacklight-cloudbase-snapshot-v1';
const DATA_ROOT = process.env.NAS_DATA_ROOT || '/vol1/docker/blacklight-nas-data';
const COMPOSE_FILE = resolve(REPOSITORY_ROOT, 'deploy/nas/compose.yaml');
const COMPOSE_ENV = resolve(DATA_ROOT, '.env');
const MEDIA_RECEIVER = '/app/scripts/local-media-receiver.mjs';
const args = process.argv.slice(2);
const argValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const has = (flag) => args.includes(flag);

function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'IMPORT_FAILED';
}

function assertSafePath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.includes('\\') || relativePath.startsWith('/')) {
    throw new Error('invalid relative path');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('invalid relative path');
  const target = resolve(root, relativePath);
  if (!target.startsWith(`${resolve(root)}/`)) throw new Error('relative path escaped root');
  return target;
}

function parseFileId(value) {
  const prefix = 'pgstore://blacklight-private/';
  if (typeof value !== 'string' || !value.startsWith(prefix)) throw new Error('invalid media id');
  const key = value.slice(prefix.length);
  const parts = key.split('/');
  if (!key.startsWith('private/image/') || parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error('invalid media key');
  }
  return key;
}

async function fileDigest(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function assertPrivateDirectory(path) {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory() || details.mode & 0o077) {
    throw new Error('snapshot directory is not private');
  }
  return details;
}

async function assertPrivatePath(root, relativePath, { file = true } = {}) {
  const target = assertSafePath(root, relativePath);
  await assertPrivateDirectory(resolve(root));
  const parts = relativePath.split('/');
  let current = resolve(root);
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]);
    const details = await lstat(current);
    const final = index === parts.length - 1;
    if (details.isSymbolicLink() || details.mode & 0o077
      || (final && file ? !details.isFile() : !details.isDirectory())) {
      throw new Error('snapshot path contains a non-private or non-regular entry');
    }
  }
  return target;
}

async function listPrivateMediaFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const details = await lstat(absolute);
    if (details.isSymbolicLink() || details.mode & 0o077) throw new Error('snapshot media contains an unsafe entry');
    if (details.isDirectory()) files.push(...await listPrivateMediaFiles(root, absolute));
    else if (details.isFile()) files.push(relative(root, absolute).split(sep).join('/'));
    else throw new Error('snapshot media contains an unsupported entry');
  }
  return files;
}

async function walkJsonl(path, onRow) {
  const hash = createHash('sha256');
  let bytes = 0;
  let rows = 0;
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const text = `${line}\n`;
    hash.update(text);
    bytes += Buffer.byteLength(text);
    if (!line) throw new Error('blank row in JSONL file');
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('invalid JSONL row'); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid row shape');
    await onRow(row);
    rows += 1;
  }
  return { sha256: hash.digest('hex'), bytes, rows };
}

async function verifySnapshot(snapshotDir, migrationSet) {
  const root = resolve(snapshotDir);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || rootStats.mode & 0o077) throw new Error('snapshot is not a private directory');
  const manifestPath = await assertPrivatePath(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.format !== SNAPSHOT_FORMAT || manifest.status !== 'complete' || manifest.safety?.writesQuiesced !== true) {
    throw new Error('snapshot manifest is incomplete or unsafe');
  }
  if (manifest.schema?.fingerprint !== migrationSet.fingerprint
    || JSON.stringify(manifest.schema?.migrations) !== JSON.stringify(migrationSet.migrations)) {
    throw new Error('snapshot migration fingerprint mismatch');
  }
  if (!Array.isArray(manifest.tables) || manifest.tables.length !== migrationSet.tables.length) {
    throw new Error('snapshot table inventory mismatch');
  }

  const mediaReferences = new Set();
  let totalRows = 0;
  for (let index = 0; index < migrationSet.tables.length; index += 1) {
    const expected = migrationSet.tables[index];
    const table = manifest.tables.find((item) => item.name === expected.name);
    if (!table || table.file !== `tables/${expected.name}.jsonl`
      || JSON.stringify(table.primaryKey) !== JSON.stringify(expected.primaryKey)
      || !Number.isSafeInteger(table.rows) || table.rows < 0
      || !/^[0-9a-f]{64}$/.test(table.sha256)) {
      throw new Error(`snapshot metadata invalid for ${expected.name}`);
    }
    const file = await assertPrivatePath(root, table.file);
    const digest = await walkJsonl(file, async (row) => {
      if (expected.name !== 'hg_assets') return;
      let doc = row.doc;
      if (typeof doc === 'string') {
        try { doc = JSON.parse(doc); } catch { throw new Error('invalid asset document'); }
      }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('invalid asset document');
      for (const field of ['fileId', 'cleanedFileId', 'reservedFileId']) if (doc[field]) mediaReferences.add(doc[field]);
    });
    if (digest.sha256 !== table.sha256 || digest.rows !== table.rows || digest.bytes !== table.bytes) {
      throw new Error(`snapshot data checksum/count mismatch for ${expected.name}`);
    }
    totalRows += digest.rows;
  }
  if (totalRows !== manifest.totalRows || totalRows === 0
    || !manifest.tables.find((table) => table.name === 'hg_users')?.rows
    || !manifest.tables.find((table) => table.name === 'hg_club_config')?.rows) {
    throw new Error('snapshot row totals are empty or incomplete');
  }

  const indexPath = await assertPrivatePath(root, manifest.media?.indexFile || '');
  const indexDigest = createHash('sha256');
  const mediaRoot = resolve(root, 'media');
  await assertPrivateDirectory(mediaRoot);
  const indexedIds = new Set();
  const indexedPaths = new Set();
  const indexLines = createInterface({ input: createReadStream(indexPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let mediaObjects = 0;
  let mediaBytes = 0;
  for await (const line of indexLines) {
    const text = `${line}\n`;
    indexDigest.update(text);
    let item;
    try { item = JSON.parse(line); } catch { throw new Error('invalid media index row'); }
    const objectKey = parseFileId(item.fileId);
    if (item.relativePath !== objectKey || indexedIds.has(item.fileId)
      || !Number.isSafeInteger(item.size) || item.size < 1 || !/^[0-9a-f]{64}$/.test(item.sha256)) {
      throw new Error('media index binding mismatch');
    }
    const file = await assertPrivatePath(mediaRoot, item.relativePath);
    const digest = await fileDigest(file);
    if (digest.bytes !== item.size || digest.sha256 !== item.sha256) throw new Error('media file checksum mismatch');
    indexedIds.add(item.fileId);
    indexedPaths.add(item.relativePath);
    mediaObjects += 1;
    mediaBytes += item.size;
  }
  if ([...mediaReferences].some((id) => !indexedIds.has(id))
    || mediaObjects !== manifest.media?.objects
    || manifest.media?.referencedObjects !== mediaReferences.size
    || mediaBytes !== manifest.media?.bytes
    || indexDigest.digest('hex') !== manifest.media?.indexSha256) {
    throw new Error('media inventory is incomplete or does not match asset rows');
  }
  const actualPaths = (await listPrivateMediaFiles(mediaRoot)).sort();
  if (actualPaths.length !== indexedPaths.size || actualPaths.some((path) => !indexedPaths.has(path))) {
    throw new Error('snapshot media directory contains unindexed or missing files');
  }

  return { root, manifest, migrationSet, mediaReferences, mediaObjects, totalRows };
}

function composePrefix() {
  const context = spawnSync('docker', ['context', 'show'], { encoding: 'utf8' });
  if (context.status !== 0) throw Object.assign(new Error('docker context unavailable'), { code: 'DOCKER_CONTEXT_UNAVAILABLE' });
  if (context.stdout.trim() !== 'default' && !has('--allow-remote-docker-context')) {
    throw Object.assign(new Error('refusing non-local Docker context; run this tool on the NAS'), { code: 'NON_LOCAL_DOCKER_CONTEXT' });
  }
  if (!isAbsolute(DATA_ROOT) || COMPOSE_ENV !== resolve(DATA_ROOT, '.env')) throw new Error('invalid NAS data root');
  return ['compose', '--project-directory', REPOSITORY_ROOT, '--file', COMPOSE_FILE, '--env-file', COMPOSE_ENV];
}

async function runDocker(compose, args, { input, capture = false } = {}) {
  const child = spawn('docker', [...compose, ...args], { stdio: ['pipe', capture ? 'pipe' : 'ignore', 'ignore'] });
  const output = [];
  if (capture) child.stdout.on('data', (chunk) => output.push(chunk));
  if (input) input(child.stdin);
  else child.stdin.end();
  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error('docker operation failed');
  return capture ? Buffer.concat(output).toString('utf8') : '';
}

function copyCsvCell(jsonLine) {
  return `"${jsonLine.replaceAll('"', '""')}"\n`;
}

function quoteSqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function assertTargetEmpty(compose, migrationSet, replaceSeed) {
  const tables = migrationSet.tables.map((table) => `SELECT ${quoteSqlString(table.name)} AS table_name, count(*) AS row_count FROM public.${table.name}`);
  const sql = `SELECT table_name || E'\\t' || row_count FROM (${tables.join(' UNION ALL ')}) counts ORDER BY table_name;`;
  const output = await runDocker(compose, [
    'exec', '-T', 'db', 'sh', '-c',
    'exec psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
    'local-import', sql,
  ], { capture: true });
  const rows = new Map(output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, count] = line.split('\t');
    return [name, Number(count)];
  }));
  if (rows.size !== migrationSet.tables.length) throw new Error('target table inventory unavailable');
  const ledgerSql = "SELECT migration_name || E'\\t' || sha256 FROM nas_meta.schema_migrations ORDER BY migration_name";
  const ledgerOutput = await runDocker(compose, [
    'exec', '-T', 'db', 'sh', '-c',
    'exec psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
    'local-import', ledgerSql,
  ], { capture: true });
  const expectedLedger = migrationSet.migrations
    .map((migration) => `${migration.name}\t${migration.sha256}`).join('\n');
  if (ledgerOutput.trim() !== expectedLedger) throw new Error('target migration ledger does not match this checkout');
  const sessions = await runDocker(compose, [
    'exec', '-T', 'db', 'sh', '-c',
    'exec psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
    'local-import', 'SELECT count(*) FROM public.hg_sessions',
  ], { capture: true });
  if (sessions.trim() !== '0') throw new Error('target contains local sessions; clear them through an explicit maintenance procedure before importing');
  const seedState = await runDocker(compose, [
    'exec', '-T', 'db', 'sh', '-c',
    'exec psql -X -A -t -F "|" -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
    'local-import',
    "SELECT count(*)::text || '|' || count(*) FILTER (WHERE id = 'heiguang' AND doc = '{\"_id\":\"heiguang\",\"usageLimits\":{\"userUploadDailyBytes\":20971520,\"clubUploadDailyBytes\":209715200,\"reviewDailyCalls\":1000,\"warningRatio\":0.8}}'::jsonb)::text FROM public.hg_club_config",
  ], { capture: true });
  const [seedTotalText, seedDefaultText] = seedState.trim().split('|');
  const seedTotal = Number(seedTotalText);
  const isDefaultSeed = seedTotal === 1 && seedDefaultText === '1';
  if (seedTotal > 0 && !isDefaultSeed) throw new Error('target has non-default club configuration; refusing to overwrite it');
  const seededConfig = isDefaultSeed;
  for (const [name, count] of rows) {
    if (name === 'hg_club_config' && seededConfig && replaceSeed) continue;
    if (count !== 0) throw new Error(`target table is not empty: ${name}`);
  }
  if (seededConfig && !replaceSeed) throw new Error('target has the local club seed; pass --replace-local-club-seed after confirming it is disposable');
  return rows;
}

async function checkServicesStopped(compose) {
  const output = await runDocker(compose, ['ps', '--services', '--status', 'running'], { capture: true });
  const running = output.split(/\r?\n/).filter(Boolean);
  if (running.includes('api') || running.includes('worker')) {
    throw new Error('stop api and worker before data import');
  }
}

async function importMedia(compose, snapshot) {
  const index = resolve(snapshot.root, snapshot.manifest.media.indexFile);
  const childArgs = [
    ...compose,
    'run', '--rm', '--no-deps', '-T', 'api', 'node', MEDIA_RECEIVER,
  ];
  const child = spawn('docker', childArgs, { stdio: ['pipe', 'pipe', 'ignore'] });
  const summaries = [];
  child.stdout.on('data', (chunk) => summaries.push(chunk));
  const lines = createInterface({ input: createReadStream(index, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const item = JSON.parse(line);
      const mediaFile = await assertPrivatePath(resolve(snapshot.root, 'media'), item.relativePath);
      const content = await readFile(mediaFile);
      const payload = `${JSON.stringify({ ...item, contentBase64: content.toString('base64') })}\n`;
      if (!child.stdin.write(payload)) await once(child.stdin, 'drain');
    }
    child.stdin.end();
    const [code] = await once(child, 'close');
    if (code !== 0) throw new Error('NAS media receiver failed');
  } catch (error) {
    child.stdin.destroy();
    if (child.exitCode === null) child.kill('SIGTERM');
    throw error;
  }
  let result;
  try { result = JSON.parse(Buffer.concat(summaries).toString('utf8')); } catch { throw new Error('NAS media receiver summary invalid'); }
  if (result.files !== snapshot.mediaObjects || result.bytes !== snapshot.manifest.media.bytes) {
    throw new Error('NAS media receiver count mismatch');
  }
}

async function importRows(compose, snapshot) {
  const replaceSeed = has('--replace-local-club-seed');
  const initialSeed = replaceSeed ? `DELETE FROM public.hg_club_config WHERE id = 'heiguang';\n` : '';
  const child = spawn('docker', [
    ...compose,
    'exec', '-T', 'db', 'sh', '-c',
    'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
  ], { stdio: ['pipe', 'ignore', 'ignore'] });
  const codePromise = once(child, 'close').then(([code]) => code);

  try {
    child.stdin.write('BEGIN;\nSET LOCAL statement_timeout = \'10min\';\nSET LOCAL lock_timeout = \'10s\';\nSET LOCAL session_replication_role = replica;\n');
    child.stdin.write(initialSeed);
    child.stdin.write('CREATE TEMP TABLE nas_import_rows(payload jsonb) ON COMMIT DROP;\n');

    for (const table of snapshot.migrationSet.tables) {
      const details = snapshot.manifest.tables.find((item) => item.name === table.name);
      const filePath = resolve(snapshot.root, details.file);
      child.stdin.write('TRUNCATE nas_import_rows;\nCOPY nas_import_rows(payload) FROM STDIN WITH (FORMAT csv);\n');
      const lines = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!child.stdin.write(copyCsvCell(line))) await once(child.stdin, 'drain');
      }
      child.stdin.write('\\.\n');
      const upsert = table.name === 'hg_club_config' && replaceSeed ? ' ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc' : '';
      child.stdin.write(`INSERT INTO public.${table.name} SELECT (jsonb_populate_record(NULL::public.${table.name}, payload)).* FROM nas_import_rows${upsert};\n`);
      child.stdin.write(`DO $$ BEGIN IF (SELECT count(*) FROM public.${table.name}) <> ${details.rows} THEN RAISE EXCEPTION 'snapshot row count mismatch'; END IF; END $$;\n`);
    }

    child.stdin.write('SET LOCAL session_replication_role = origin;\nCOMMIT;\n');
    child.stdin.end();
    const code = await codePromise;
    if (code !== 0) throw new Error('PostgreSQL import transaction failed; database transaction rolled back');
  } catch (error) {
    child.stdin.destroy();
    if (child.exitCode === null) child.kill('SIGTERM');
    throw error;
  }
}

async function main() {
  if (!has('--writes-paused')) throw new Error('pass --writes-paused only after API and worker are stopped');
  const snapshotArgument = argValue('--snapshot');
  if (!snapshotArgument || !isAbsolute(snapshotArgument)) throw new Error('missing absolute --snapshot path');
  const migrationSet = await readMigrationSet();
  const snapshot = await verifySnapshot(snapshotArgument, migrationSet);
  if (has('--verify-only')) {
    console.log(`snapshot verified: tables=${migrationSet.tables.length}, rows=${snapshot.totalRows}, media=${snapshot.mediaObjects}`);
    return;
  }
  const compose = composePrefix();
  await checkServicesStopped(compose);
  await assertTargetEmpty(compose, migrationSet, has('--replace-local-club-seed'));
  await importMedia(compose, snapshot);
  await importRows(compose, snapshot);

  const receipt = {
    format: 'blacklight-nas-import-receipt-v1',
    importedAt: new Date().toISOString(),
    snapshotManifestSha256: sha256(await readFile(resolve(snapshot.root, 'manifest.json'))),
    migrationFingerprint: migrationSet.fingerprint,
    tables: migrationSet.tables.length,
    rows: snapshot.totalRows,
    mediaObjects: snapshot.mediaObjects,
    mediaBytes: snapshot.manifest.media.bytes,
  };
  const receiptPath = resolve(DATA_ROOT, `import-receipt-${Date.now()}.json`);
  await mkdir(DATA_ROOT, { recursive: true, mode: 0o700 });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`import complete: tables=${receipt.tables}, rows=${receipt.rows}, media=${receipt.mediaObjects}`);
}

main().catch((error) => {
  console.error(`snapshot import refused/incomplete (${safeCode(error)}); no target rows were overwritten`);
  process.exitCode = 1;
});
