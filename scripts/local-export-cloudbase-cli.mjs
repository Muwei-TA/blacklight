import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readMigrationSet, safeSqlIdentifier, sha256 } from './local-migration-lib.mjs';

const FORMAT = 'blacklight-cloudbase-snapshot-v1';
const BUCKET_ID = 'blacklight-private';
const IMAGE_PREFIX = 'private/image/';
const TABLE_PAGE_SIZE = 250;
const STORAGE_PAGE_SIZE = 100;
const MAX_CLI_JSON_BYTES = 64 * 1024 * 1024;
const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);

function argumentValue(flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1] || null;
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'EXPORT_FAILED';
}

function privateCliEnvironment() {
  const environment = { ...process.env };
  for (const name of [
    'CLOUDBASE_APIKEY',
    'CLOUDBASE_API_KEY',
    'TCB_APIKEY',
    'TCB_API_KEY',
    'TCB_SECRET_ID',
    'TCB_SECRET_KEY',
    'TENCENTCLOUD_SECRET_ID',
    'TENCENTCLOUD_SECRET_KEY',
    'TENCENTCLOUD_SESSION_TOKEN',
  ]) delete environment[name];
  return environment;
}

async function runTcb(commandArgs, { capture = false, failureCode = 'CLI_COMMAND_FAILED' } = {}) {
  const child = spawn('tcb', commandArgs, {
    env: privateCliEnvironment(),
    stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
  });
  const chunks = [];
  let outputBytes = 0;
  let tooLarge = false;
  if (capture) {
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CLI_JSON_BYTES) {
        tooLarge = true;
        child.kill('SIGTERM');
      } else chunks.push(chunk);
    });
  }

  const code = await new Promise((resolveCode, reject) => {
    child.once('error', reject);
    child.once('close', resolveCode);
  }).catch(() => {
    throw fail('TCB_CLI_UNAVAILABLE', 'CloudBase CLI could not be started');
  });
  if (tooLarge) throw fail('CLI_OUTPUT_TOO_LARGE', 'CloudBase CLI response exceeded the safe page limit');
  if (code !== 0) throw fail(failureCode, 'CloudBase CLI command failed');
  return capture ? Buffer.concat(chunks).toString('utf8') : '';
}

function parseCliJson(output, failureCode) {
  try {
    const result = JSON.parse(output);
    if (!result || typeof result !== 'object' || Array.isArray(result) || !result.data
      || typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('shape');
    return result.data;
  } catch {
    throw fail(failureCode, 'CloudBase CLI JSON response was invalid');
  }
}

function parseJsonArray(value, label) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { throw fail('DB_RESPONSE_INVALID', `${label} was not valid JSON`); }
  }
  if (!Array.isArray(parsed)) throw fail('DB_RESPONSE_INVALID', `${label} was not an array`);
  return parsed;
}

function parseQueryRows(data) {
  const columns = parseJsonArray(data.Columns, 'query columns');
  const rows = parseJsonArray(data.Rows, 'query rows');
  if (columns.length !== 1 || typeof columns[0] !== 'string' || !columns[0]
    || rows.some((row) => typeof row !== 'string')) {
    throw fail('DB_RESPONSE_INVALID', 'query result did not match the expected one-column row format');
  }
  return { column: columns[0], rows };
}

function parsePgFileId(value) {
  const prefix = `pgstore://${BUCKET_ID}/`;
  if (typeof value !== 'string' || !value.startsWith(prefix)) throw fail('MEDIA_ID_INVALID', 'asset media id was invalid');
  const objectKey = value.slice(prefix.length);
  const parts = objectKey.split('/');
  if (!objectKey.startsWith(IMAGE_PREFIX)
    || parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw fail('MEDIA_KEY_INVALID', 'asset media key was invalid');
  }
  return { objectKey, relativePath: objectKey };
}

function normalizeListedObject(entry) {
  const raw = typeof entry === 'string' ? entry : entry?.name;
  if (typeof raw !== 'string' || !raw || raw.startsWith('/')) throw fail('MEDIA_LIST_INVALID', 'storage object entry was invalid');
  const withoutTrailingSlash = raw.replace(/\/$/, '');
  const objectKey = withoutTrailingSlash.startsWith(IMAGE_PREFIX)
    ? withoutTrailingSlash
    : `${IMAGE_PREFIX}${withoutTrailingSlash}`;
  return parsePgFileId(`pgstore://${BUCKET_ID}/${objectKey}`).objectKey;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
    throw fail('SNAPSHOT_DIRECTORY_UNSAFE', 'snapshot directory was not private');
  }
}

async function writeManifest(outDir, manifest) {
  const temporary = resolve(outDir, 'manifest.json.tmp');
  const destination = resolve(outDir, 'manifest.json');
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await chmod(destination, 0o600);
}

async function executeSql(envId, sql, failureCode) {
  const output = await runTcb([
    'db', 'execute', '-e', envId, '--sql', sql, '--json',
  ], { capture: true, failureCode });
  return parseCliJson(output, 'DB_RESPONSE_INVALID');
}

async function countTable(envId, table) {
  const quotedTable = safeSqlIdentifier(table.name);
  const data = await executeSql(envId,
    `SELECT count(*)::text AS count FROM public.${quotedTable}`,
    'TABLE_COUNT_FAILED');
  const result = parseQueryRows(data);
  if (result.column !== 'count' || result.rows.length !== 1 || !/^\d+$/.test(result.rows[0])) {
    throw fail('TABLE_COUNT_UNAVAILABLE', 'table row count was unavailable');
  }
  const count = Number(result.rows[0]);
  if (!Number.isSafeInteger(count)) throw fail('TABLE_COUNT_UNAVAILABLE', 'table row count exceeded the safe integer range');
  return count;
}

async function exportTable(envId, table, outDir) {
  const relativeFile = `tables/${table.name}.jsonl`;
  const tablesDirectory = resolve(outDir, 'tables');
  await ensurePrivateDirectory(tablesDirectory);
  const filePath = resolve(outDir, relativeFile);
  const handle = await open(filePath, 'wx', 0o600);
  const digest = createHash('sha256');
  let rowsWritten = 0;
  let bytesWritten = 0;
  const objectIds = [];

  try {
    const expectedRows = await countTable(envId, table);
    const orderBy = table.primaryKey.map((column) => `t.${safeSqlIdentifier(column)} ASC`).join(', ');
    for (let offset = 0; offset < expectedRows; offset += TABLE_PAGE_SIZE) {
      const limit = Math.min(TABLE_PAGE_SIZE, expectedRows - offset);
      const sql = `SELECT row_to_json(t)::text AS row FROM public.${safeSqlIdentifier(table.name)} t ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
      const data = await executeSql(envId, sql, 'TABLE_READ_FAILED');
      const result = parseQueryRows(data);
      if (result.column !== 'row' || result.rows.length === 0 || rowsWritten + result.rows.length > expectedRows) {
        throw fail('TABLE_PAGE_MISMATCH', 'table page did not match its count');
      }

      let block = '';
      for (const encodedRow of result.rows) {
        let row;
        try { row = JSON.parse(encodedRow); } catch { throw fail('INVALID_TABLE_ROW', 'database row JSON was invalid'); }
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw fail('INVALID_TABLE_ROW', 'database row shape was invalid');
        block += `${JSON.stringify(row)}\n`;
        if (table.name === 'hg_assets') {
          let doc = row.doc;
          if (typeof doc === 'string') {
            try { doc = JSON.parse(doc); } catch { throw fail('INVALID_ASSET_ROW', 'asset document JSON was invalid'); }
          }
          if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw fail('INVALID_ASSET_DOCUMENT', 'asset document shape was invalid');
          for (const field of ['fileId', 'cleanedFileId', 'reservedFileId']) if (doc[field]) objectIds.push(doc[field]);
        }
      }
      digest.update(block);
      await handle.writeFile(block);
      rowsWritten += result.rows.length;
      bytesWritten += Buffer.byteLength(block);
    }

    const verifiedCount = await countTable(envId, table);
    if (verifiedCount !== expectedRows || rowsWritten !== expectedRows) {
      throw fail('TABLE_EXPORT_INCOMPLETE', 'table export count changed or was incomplete');
    }

    return {
      name: table.name,
      primaryKey: table.primaryKey,
      file: relativeFile,
      rows: rowsWritten,
      sha256: digest.digest('hex'),
      bytes: bytesWritten,
      objectIds,
    };
  } finally {
    await handle.close();
    await chmod(filePath, 0o600);
  }
}

async function listPrivateImageObjectKeys(envId) {
  const keys = new Set();
  const cursors = new Set();
  let cursor = null;
  let pages = 0;
  for (;;) {
    const commandArgs = [
      'storage', 'objects', 'list', '-e', envId, '-b', BUCKET_ID,
      '--prefix', IMAGE_PREFIX, '--limit', String(STORAGE_PAGE_SIZE),
      '--sort-by', 'name', '--sort-order', 'asc', '--json',
    ];
    if (cursor) commandArgs.push('--cursor', cursor);
    const output = await runTcb(commandArgs, { capture: true, failureCode: 'MEDIA_LIST_FAILED' });
    const data = parseCliJson(output, 'MEDIA_LIST_INVALID');
    if (!Array.isArray(data.objects) || typeof data.hasNext !== 'boolean') {
      throw fail('MEDIA_LIST_INCOMPLETE', 'storage listing did not include objects and pagination state');
    }
    for (const item of data.objects) {
      const key = normalizeListedObject(item);
      if (keys.has(key)) throw fail('MEDIA_LIST_DUPLICATE', 'storage listing repeated an object key');
      keys.add(key);
    }
    if (!data.hasNext) break;
    if (typeof data.nextCursor !== 'string' || !data.nextCursor || cursors.has(data.nextCursor)) {
      throw fail('MEDIA_LIST_CURSOR_INVALID', 'storage listing cursor did not advance');
    }
    cursors.add(data.nextCursor);
    cursor = data.nextCursor;
    pages += 1;
    if (pages > 100000) throw fail('MEDIA_LIST_PAGE_LIMIT', 'storage listing exceeded the safe page limit');
  }
  return [...keys].sort();
}

async function exportMedia(envId, objectIds, outDir) {
  const referencedIds = new Set(objectIds);
  const objectKeys = await listPrivateImageObjectKeys(envId);
  const listedIds = new Set(objectKeys.map((key) => `pgstore://${BUCKET_ID}/${key}`));
  if ([...referencedIds].some((fileId) => !listedIds.has(fileId))) {
    throw fail('REFERENCED_MEDIA_NOT_LISTED', 'asset media was absent from the complete bucket listing');
  }
  const allIds = [...new Set([...referencedIds, ...listedIds])].sort();
  const mediaRoot = resolve(outDir, 'media');
  const indexPath = resolve(outDir, 'media-index.jsonl');
  await ensurePrivateDirectory(mediaRoot);
  const index = await open(indexPath, 'wx', 0o600);
  const indexHash = createHash('sha256');
  let bytes = 0;

  try {
    for (const fileId of allIds) {
      const { objectKey, relativePath } = parsePgFileId(fileId);
      const target = resolve(mediaRoot, relativePath);
      if (!target.startsWith(`${mediaRoot}/`)) throw fail('MEDIA_PATH_INVALID', 'media path escaped the snapshot directory');
      await ensurePrivateDirectory(dirname(target));
      await runTcb([
        'storage', 'objects', 'download', objectKey, target,
        '-e', envId, '-b', BUCKET_ID, '--json',
      ], { failureCode: 'MEDIA_DOWNLOAD_FAILED' });

      const details = await lstat(target).catch(() => null);
      if (!details || !details.isFile() || details.isSymbolicLink()) throw fail('MEDIA_DOWNLOAD_INVALID', 'download did not create a regular media file');
      await chmod(target, 0o600);
      const content = await readFile(target);
      if (content.length === 0) throw fail('MEDIA_EMPTY', 'downloaded media object was empty');
      const item = { fileId, relativePath, size: content.length, sha256: sha256(content) };
      const line = `${JSON.stringify(item)}\n`;
      await index.writeFile(line);
      indexHash.update(line);
      bytes += content.length;
    }
  } finally {
    await index.close();
    await chmod(indexPath, 0o600);
  }

  return {
    objects: allIds.length,
    referencedObjects: referencedIds.size,
    bytes,
    indexFile: 'media-index.jsonl',
    indexSha256: indexHash.digest('hex'),
  };
}

async function main() {
  process.umask(0o077);
  if (!hasFlag('--writes-quiesced')) throw fail('WRITES_NOT_QUIESCED', 'pass --writes-quiesced only after API and worker writes are stopped');
  const outArgument = argumentValue('--out');
  if (!outArgument || !isAbsolute(outArgument)) throw fail('OUTPUT_PATH_REQUIRED', 'missing absolute --out <new-private-directory>');
  const outDir = resolve(outArgument);
  const envId = argumentValue('--env-id') || process.env.TCB_ENV_ID || process.env.TCB_ENV;
  if (!envId || !/^[A-Za-z0-9._-]{1,128}$/.test(envId)) throw fail('ENV_ID_REQUIRED', 'set --env-id or TCB_ENV_ID');

  const migrations = await readMigrationSet();
  const manifest = {
    format: FORMAT,
    status: 'incomplete',
    createdAt: new Date().toISOString(),
    safety: { writesQuiesced: true, sourceReadMethod: 'CloudBase CLI tcb; authenticated login session; no API key required' },
    schema: migrations,
    tables: [],
    media: null,
  };
  await mkdir(dirname(outDir), { recursive: true, mode: 0o700 });
  await mkdir(outDir, { recursive: false, mode: 0o700 });
  await chmod(outDir, 0o700);

  try {
    await writeManifest(outDir, manifest);
    const objectIds = [];
    let totalRows = 0;
    for (const table of migrations.tables) {
      const result = await exportTable(envId, table, outDir);
      objectIds.push(...result.objectIds);
      totalRows += result.rows;
      const summary = { ...result };
      delete summary.objectIds;
      manifest.tables.push(summary);
      manifest.totalRows = totalRows;
    }
    if (totalRows === 0 || !manifest.tables.find((table) => table.name === 'hg_users')?.rows
      || !manifest.tables.find((table) => table.name === 'hg_club_config')?.rows) {
      throw fail('EMPTY_SOURCE', 'source snapshot was empty or structurally incomplete');
    }
    manifest.media = await exportMedia(envId, objectIds, outDir);
    manifest.status = 'complete';
    manifest.completedAt = new Date().toISOString();
    await writeManifest(outDir, manifest);
    console.log(`snapshot complete: tables=${manifest.tables.length}, rows=${manifest.totalRows}, media=${manifest.media.objects}`);
  } catch (error) {
    manifest.status = 'incomplete';
    manifest.failureCode = safeCode(error);
    manifest.failedAt = new Date().toISOString();
    await writeManifest(outDir, manifest);
    console.error(`snapshot incomplete (${manifest.failureCode}); manifest is not importable`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`snapshot refused: ${safeCode(error)}`);
  process.exitCode = 1;
});
