import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  REPOSITORY_ROOT,
  readMigrationSet,
  sha256,
} from './local-migration-lib.mjs';

const FORMAT = 'blacklight-cloudbase-snapshot-v1';
const PAGE_SIZE = 250;
const BUCKET_ID = 'blacklight-private';
const APP_REQUIRE = createRequire(resolve(REPOSITORY_ROOT, 'cloudfunctions/api/package.json'));
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

function failSafeCode(err) {
  return typeof err?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code) ? err.code : 'EXPORT_FAILED';
}

function parsePgFileId(value) {
  const prefix = `pgstore://${BUCKET_ID}/`;
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    throw new Error('unsupported media file id');
  }
  const objectKey = value.slice(prefix.length);
  const parts = objectKey.split('/');
  if (!objectKey.startsWith('private/image/') || parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error('invalid media object key');
  }
  return { objectKey, relativePath: objectKey };
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function writeManifest(outDir, manifest) {
  const temporary = join(outDir, 'manifest.json.tmp');
  const destination = join(outDir, 'manifest.json');
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'w' });
  await rename(temporary, destination);
}

async function exportTable(db, table, outDir) {
  const file = `tables/${table.name}.jsonl`;
  const filePath = resolve(outDir, file);
  const baseDir = resolve(outDir, 'tables');
  await ensurePrivateDir(baseDir);
  const handle = await open(filePath, 'wx', 0o600);
  const digest = createHash('sha256');
  let rowsWritten = 0;
  let bytesWritten = 0;
  const objectIds = [];
  let expectedRows = null;

  try {
    let countResult;
    try {
      countResult = await db.from(table.name).select('*', { count: 'exact', head: true });
    } catch {
      throw Object.assign(new Error('table count failed'), { code: 'TABLE_COUNT_FAILED' });
    }
    if (countResult?.error || !Number.isSafeInteger(Number(countResult?.count)) || Number(countResult.count) < 0) {
      throw Object.assign(new Error('table count unavailable'), { code: 'TABLE_COUNT_UNAVAILABLE' });
    }
    expectedRows = Number(countResult.count);

    for (let offset = 0; offset < expectedRows; offset += PAGE_SIZE) {
      let query = db.from(table.name).select('*');
      for (const column of table.primaryKey) query = query.order(column, { ascending: true });
      let result;
      try {
        result = await query.range(offset, Math.min(offset + PAGE_SIZE - 1, expectedRows - 1));
      } catch {
        throw Object.assign(new Error('table read failed'), { code: 'TABLE_READ_FAILED' });
      }
      if (result?.error || !Array.isArray(result?.data)) {
        throw Object.assign(new Error('table page unavailable'), { code: 'TABLE_PAGE_UNAVAILABLE' });
      }
      const page = result.data;
      if (page.length === 0 || rowsWritten + page.length > expectedRows) {
        throw Object.assign(new Error('table page count mismatch'), { code: 'TABLE_PAGE_MISMATCH' });
      }

      let block = '';
      for (const row of page) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw Object.assign(new Error('invalid table row'), { code: 'INVALID_TABLE_ROW' });
        }
        const line = `${JSON.stringify(row)}\n`;
        block += line;
        if (table.name === 'hg_assets') {
          let doc = row.doc;
          if (typeof doc === 'string') {
            try { doc = JSON.parse(doc); } catch { throw Object.assign(new Error('invalid asset row'), { code: 'INVALID_ASSET_ROW' }); }
          }
          if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
            throw Object.assign(new Error('invalid asset document'), { code: 'INVALID_ASSET_DOCUMENT' });
          }
          for (const field of ['fileId', 'cleanedFileId', 'reservedFileId']) {
            if (doc[field]) objectIds.push(doc[field]);
          }
        }
      }
      digest.update(block);
      await handle.writeFile(block);
      rowsWritten += page.length;
      bytesWritten += Buffer.byteLength(block);
    }

    let verify;
    try {
      verify = await db.from(table.name).select('*', { count: 'exact', head: true });
    } catch {
      throw Object.assign(new Error('post-export count failed'), { code: 'POST_EXPORT_COUNT_FAILED' });
    }
    if (verify?.error || Number(verify?.count) !== expectedRows || rowsWritten !== expectedRows) {
      throw Object.assign(new Error('table export incomplete'), { code: 'TABLE_EXPORT_INCOMPLETE' });
    }
  } finally {
    await handle.close();
  }

  return {
    name: table.name,
    primaryKey: table.primaryKey,
    file,
    rows: rowsWritten,
    sha256: digest.digest('hex'),
    bytes: bytesWritten,
    objectIds,
  };
}

async function exportMedia(bucket, objectIds, outDir) {
  const referencedIds = new Set(objectIds);
  const objectKeys = await listPrivateImageObjectKeys(bucket);
  const listedIds = new Set(objectKeys.map((key) => `pgstore://${BUCKET_ID}/${key}`));
  if ([...referencedIds].some((fileId) => !listedIds.has(fileId))) {
    throw Object.assign(new Error('an asset image is absent from the complete bucket listing'), { code: 'REFERENCED_MEDIA_NOT_LISTED' });
  }
  const uniqueIds = [...new Set([...referencedIds, ...listedIds])].sort();
  const mediaRoot = resolve(outDir, 'media');
  const indexPath = resolve(outDir, 'media-index.jsonl');
  await ensurePrivateDir(mediaRoot);
  const index = await open(indexPath, 'wx', 0o600);
  const indexHash = createHash('sha256');
  let bytes = 0;

  try {
    for (const fileId of uniqueIds) {
      const { objectKey, relativePath } = parsePgFileId(fileId);
      const target = resolve(mediaRoot, relativePath);
      if (!target.startsWith(`${mediaRoot}/`)) throw new Error('media path escaped snapshot');
      await ensurePrivateDir(dirname(target));

      let response;
      try {
        response = await bucket.download(objectKey);
      } catch {
        throw Object.assign(new Error('media download failed'), { code: 'MEDIA_DOWNLOAD_FAILED' });
      }
      if (response?.error || response?.data == null) {
        throw Object.assign(new Error('referenced media is unavailable'), { code: 'MEDIA_MISSING' });
      }
      let content;
      if (Buffer.isBuffer(response.data)) content = response.data;
      else if (response.data instanceof ArrayBuffer) content = Buffer.from(response.data);
      else if (typeof response.data.arrayBuffer === 'function') content = Buffer.from(await response.data.arrayBuffer());
      else throw Object.assign(new Error('unsupported media response'), { code: 'MEDIA_RESPONSE_INVALID' });
      if (content.length === 0) throw Object.assign(new Error('empty media object'), { code: 'MEDIA_EMPTY' });

      const objectHash = sha256(content);
      await writeFile(target, content, { mode: 0o600, flag: 'wx' });
      const item = { fileId, relativePath, size: content.length, sha256: objectHash };
      const line = `${JSON.stringify(item)}\n`;
      await index.writeFile(line);
      indexHash.update(line);
      bytes += content.length;
    }
  } finally {
    await index.close();
  }

  return {
    objects: uniqueIds.length,
    referencedObjects: referencedIds.size,
    bytes,
    indexFile: 'media-index.jsonl',
    indexSha256: indexHash.digest('hex'),
  };
}

function normalizeListedPath(prefix, entry) {
  const raw = typeof entry === 'string' ? entry : entry?.name;
  if (typeof raw !== 'string' || !raw) throw new Error('invalid storage listing entry');
  const withoutTrailingSlash = raw.replace(/\/$/, '');
  const full = withoutTrailingSlash.startsWith(`${prefix}/`) || withoutTrailingSlash === prefix
    ? withoutTrailingSlash
    : `${prefix.replace(/\/$/, '')}/${withoutTrailingSlash.replace(/^\//, '')}`;
  if (full.includes('//')) throw new Error('invalid storage listing path');
  return full;
}

async function listPrivateImageObjectKeys(bucket) {
  const keys = new Set();
  const visitedFolders = new Set();

  async function listFolder(prefix) {
    if (visitedFolders.has(prefix)) return;
    visitedFolders.add(prefix);
    let cursor;
    const childFolders = new Set();
    for (;;) {
      let result;
      try {
        result = await bucket.list(prefix, {
          limit: 100,
          cursor,
          withDelimiter: true,
          sortBy: { column: 'name', order: 'asc' },
        });
      } catch {
        throw Object.assign(new Error('media bucket listing failed'), { code: 'MEDIA_LIST_FAILED' });
      }
      const page = result?.data;
      if (result?.error || !page || !Array.isArray(page.objects) || !Array.isArray(page.folders)
        || typeof page.hasNext !== 'boolean') {
        throw Object.assign(new Error('media bucket listing unavailable'), { code: 'MEDIA_LIST_INCOMPLETE' });
      }
      for (const object of page.objects) {
        const key = normalizeListedPath(prefix, object);
        const { objectKey } = parsePgFileId(`pgstore://${BUCKET_ID}/${key}`);
        keys.add(objectKey);
      }
      for (const folder of page.folders) {
        const path = normalizeListedPath(prefix, folder);
        if (!path.startsWith('private/image/')) throw new Error('storage listing escaped the private image prefix');
        childFolders.add(path);
      }
      if (!page.hasNext) break;
      if (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor === cursor) {
        throw Object.assign(new Error('media listing cursor did not advance'), { code: 'MEDIA_LIST_CURSOR_INVALID' });
      }
      cursor = page.nextCursor;
    }

    for (const child of childFolders) await listFolder(child);
  }

  await listFolder('private/image');
  return [...keys].sort();
}

async function main() {
  if (!hasFlag('--writes-quiesced')) {
    throw new Error('pass --writes-quiesced only after API and worker writes are stopped');
  }
  const outArgument = valueAfter('--out');
  if (!outArgument) throw new Error('missing --out <new-private-directory>');
  const outDir = resolve(outArgument);
  if (!isAbsolute(outDir)) throw new Error('--out must be absolute');
  const envId = process.env.TCB_ENV_ID || process.env.TCB_ENV;
  const keyFile = process.env.CLOUDBASE_APIKEY_FILE;
  if (!envId || !keyFile) throw new Error('set TCB_ENV_ID and CLOUDBASE_APIKEY_FILE');

  const migrations = await readMigrationSet();
  const manifest = {
    format: FORMAT,
    status: 'incomplete',
    createdAt: new Date().toISOString(),
    safety: { writesQuiesced: true, sourceReadMethod: 'CloudBase PG JS SDK; no pg_dump assumption' },
    schema: migrations,
    tables: [],
    media: null,
  };
  await ensurePrivateDir(dirname(outDir));
  await mkdir(outDir, { recursive: false, mode: 0o700 });

  try {
    const keyFileStat = await lstat(keyFile);
    if (keyFileStat.isSymbolicLink() || !keyFileStat.isFile() || keyFileStat.mode & 0o077) {
      throw new Error('CloudBase API key file must be a private regular file');
    }
    const apiKey = (await readFile(keyFile, 'utf8')).trim();
    if (!apiKey) throw new Error('empty CloudBase API key file');
    let cloudbase;
    try { cloudbase = APP_REQUIRE('@cloudbase/js-sdk'); } catch {
      throw Object.assign(new Error('CloudBase SDK unavailable; install the api function lockfile dependencies locally'), { code: 'SDK_MISSING' });
    }
    // CloudBase's server API Key is read from CLOUDBASE_APIKEY by the Node adapter.
    // Keep it in process memory only; never put it on the command line or log it.
    process.env.CLOUDBASE_APIKEY = apiKey;
    const app = cloudbase.init({ env: envId, region: 'ap-shanghai' });
    const db = app.rdb();
    const bucket = app.storage?.from?.(BUCKET_ID);
    if (!db || typeof db.from !== 'function' || !bucket || typeof bucket.download !== 'function') {
      throw Object.assign(new Error('CloudBase PG or storage SDK capability unavailable'), { code: 'SDK_CAPABILITY_MISSING' });
    }

    const objectIds = [];
    let totalRows = 0;
    for (const table of migrations.tables) {
      const result = await exportTable(db, table, outDir);
      objectIds.push(...result.objectIds);
      totalRows += result.rows;
      const summary = { ...result };
      delete summary.objectIds;
      manifest.tables.push(summary);
    }
    manifest.totalRows = totalRows;
    if (totalRows === 0 || !manifest.tables.find((table) => table.name === 'hg_users')?.rows
      || !manifest.tables.find((table) => table.name === 'hg_club_config')?.rows) {
      throw Object.assign(new Error('empty or structurally incomplete source snapshot'), { code: 'EMPTY_SOURCE' });
    }
    manifest.media = await exportMedia(bucket, objectIds, outDir);
    manifest.status = 'complete';
    manifest.completedAt = new Date().toISOString();
    await writeManifest(outDir, manifest);
    console.log(`snapshot complete: tables=${manifest.tables.length}, rows=${manifest.totalRows}, media=${manifest.media.objects}`);
  } catch (error) {
    manifest.failureCode = failSafeCode(error);
    manifest.failedAt = new Date().toISOString();
    await writeManifest(outDir, manifest);
    console.error(`snapshot incomplete (${manifest.failureCode}); manifest is not importable`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`snapshot refused: ${failSafeCode(error)}`);
  process.exitCode = 1;
});
