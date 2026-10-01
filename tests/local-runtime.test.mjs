import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { readMigrationSet } from '../scripts/local-migration-lib.mjs';
import { assertPublicTableInventory, assertTargetRowsEmpty } from '../scripts/local-import-policy.mjs';

const require = createRequire(import.meta.url);
const { createLocalStorageAdapter } = require('../shared/local-storage.js');
const { readBearerToken } = require('../server/auth.js');
const constants = require('../shared/constants.js');

test('local media storage keeps legacy pgstore IDs, stores private bytes, and issues opaque revocable links', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'blacklight-local-media-'));
  const previous = {
    NAS_MEDIA_DIR: process.env.NAS_MEDIA_DIR,
    MEDIA_URL_SECRET: process.env.MEDIA_URL_SECRET,
    PUBLIC_API_BASE_URL: process.env.PUBLIC_API_BASE_URL,
    NODE_ENV: process.env.NODE_ENV,
  };
  process.env.NAS_MEDIA_DIR = tempRoot;
  process.env.MEDIA_URL_SECRET = 'local-runtime-test-key-that-is-long-enough-32bytes';
  process.env.PUBLIC_API_BASE_URL = 'https://api.example.test';
  process.env.NODE_ENV = 'test';
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const storage = createLocalStorageAdapter();
  const cloudPath = 'private/image/0123456789abcdef0123456789abcdef0123456789abcdef.jpg';
  const metadata = await storage.getUploadMetadata({ cloudPath });
  assert.equal(metadata.data.fileId, `pgstore://blacklight-private/${cloudPath}`);
  const bytes = Buffer.from('already-cleaned-jpeg-bytes');
  await storage.uploadFile({ cloudPath, fileContent: bytes });
  const downloaded = await storage.downloadFile({ fileID: metadata.data.fileId });
  assert.deepEqual(downloaded.fileContent, bytes);
  const file = await stat(join(tempRoot, cloudPath));
  assert.equal(file.mode & 0o777, 0o600);

  const url = storage.createAssetUrl({
    assetId: 'asset-123',
    fileId: metadata.data.fileId,
    userId: 'internal-user-id',
    permissionVersion: 7,
  });
  assert.ok(url.startsWith('https://api.example.test/v1/media/asset-123?'));
  assert.equal(url.includes('internal-user-id'), false);
  const parsed = new URL(url);
  const claim = storage.verifyAssetUrl({ token: parsed.searchParams.get('t'), signature: parsed.searchParams.get('s') });
  assert.equal(claim.userId, 'internal-user-id');
  assert.equal(claim.permissionVersion, 7);
  assert.equal(storage.verifyAssetUrl({ token: parsed.searchParams.get('t'), signature: 'tampered' }), null);
  assert.equal(storage.verifyAssetUrl({ token: parsed.searchParams.get('t'), signature: parsed.searchParams.get('s'), now: (claim.exp + 1) * 1000 }), null);
  await assert.rejects(storage.getUploadMetadata({ cloudPath: '../outside.jpg' }), /invalid storage object key/);
  await storage.deleteFile({ fileList: [metadata.data.fileId] });
  await assert.rejects(readFile(join(tempRoot, cloudPath)), { code: 'ENOENT' });
});

test('Bearer parsing accepts only the opaque 32-byte token shape', () => {
  const token = 'A'.repeat(43);
  assert.deepEqual(readBearerToken(undefined), { token: null, supplied: false });
  assert.deepEqual(readBearerToken('Basic token'), { token: null, supplied: true });
  assert.deepEqual(readBearerToken(`Bearer ${token}`), { token, supplied: true });
  assert.deepEqual(readBearerToken(`Bearer ${token}=`), { token: null, supplied: true });
});

test('NAS migration inventory matches the current CloudBase source schema', async () => {
  const schema = await readMigrationSet();
  assert.equal(schema.migrations.length, 22);
  assert.equal(schema.latestVersion, '20260927160000');
  assert.equal(schema.tables.length, 27);
  assert.equal(schema.tables.some((table) => table.name === 'hg_sessions'), false);
});

test('snapshot import refuses table drift and any target business rows', () => {
  assert.throws(
    () => assertPublicTableInventory(['hg_assets', 'hg_sessions'], ['hg_assets']),
    /inventory does not match/,
  );
  assert.throws(
    () => assertTargetRowsEmpty(new Map([['hg_daily_usage', 6], ['hg_users', 0]])),
    /target table is not empty: hg_daily_usage/,
  );
  assert.throws(
    () => assertTargetRowsEmpty(new Map([['hg_club_config', 1]]), { seededConfig: true }),
    /pass --replace-local-club-seed/,
  );
  assert.doesNotThrow(() => assertTargetRowsEmpty(
    new Map([['hg_club_config', 1], ['hg_users', 0]]),
    { seededConfig: true, replaceSeed: true },
  ));
});

test('NAS LAN profile creates HTTP media links only for the fixed LAN host and port', (t) => {
  const previous = Object.fromEntries([
    'RUNTIME_KIND', 'NAS_LAN_MODE', 'API_BIND_IP', 'API_BIND_PORT',
    'PUBLIC_API_BASE_URL', 'MEDIA_URL_SECRET', 'NODE_ENV',
  ].map((name) => [name, process.env[name]]));
  process.env.RUNTIME_KIND = 'nas';
  process.env.NAS_LAN_MODE = '1';
  process.env.API_BIND_IP = '192.168.50.28';
  process.env.API_BIND_PORT = '18089';
  process.env.PUBLIC_API_BASE_URL = 'http://192.168.50.28:18089';
  process.env.MEDIA_URL_SECRET = 'local-runtime-lan-profile-test-key-32bytes';
  process.env.NODE_ENV = 'production';
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const storage = createLocalStorageAdapter();
  const options = {
    assetId: 'asset-lan-test',
    fileId: 'pgstore://blacklight-private/private/image/test.jpg',
    userId: 'user-lan-test',
    permissionVersion: 1,
  };
  assert.ok(storage.createAssetUrl(options).startsWith('http://192.168.50.28:18089/v1/media/'));

  process.env.PUBLIC_API_BASE_URL = 'http://192.168.50.29:18089';
  assert.throws(() => storage.createAssetUrl(options), { code: 'INVALID_PUBLIC_URL' });
  process.env.PUBLIC_API_BASE_URL = 'http://192.168.50.28:18088';
  assert.throws(() => storage.createAssetUrl(options), { code: 'INVALID_PUBLIC_URL' });
  process.env.NAS_LAN_MODE = '0';
  process.env.PUBLIC_API_BASE_URL = 'http://192.168.50.28:18089';
  assert.throws(() => storage.createAssetUrl(options), { code: 'INVALID_PUBLIC_URL' });
});

test('NAS review callback remains disabled without a verified source path', async (t) => {
  const { createServer } = require('../server/index.js');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/review/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-review-callback-secret': 'unverified' },
    body: JSON.stringify({ trace_id: 'unverified', result: { suggest: 'pass' } }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'feature_disabled');
});

test('assets/upload sanitizes an image and writes it through the local private adapter', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'blacklight-upload-'));
  const previous = {
    NAS_MEDIA_DIR: process.env.NAS_MEDIA_DIR,
    MEDIA_URL_SECRET: process.env.MEDIA_URL_SECRET,
    PUBLIC_API_BASE_URL: process.env.PUBLIC_API_BASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    RUNTIME_KIND: process.env.RUNTIME_KIND,
  };
  process.env.NAS_MEDIA_DIR = tempRoot;
  process.env.MEDIA_URL_SECRET = 'local-runtime-upload-key-that-is-long-enough-32bytes';
  process.env.PUBLIC_API_BASE_URL = 'https://api.example.test';
  process.env.NODE_ENV = 'test';
  process.env.RUNTIME_KIND = 'nas';
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const { PNG } = require('pngjs');
  const Module = require('node:module');
  const png = new PNG({ width: 1, height: 1 });
  png.data = Buffer.from([255, 32, 8, 255]);
  const input = PNG.sync.write(png);
  const asset = {
    _id: 'asset-upload-1', ownerId: 'user-upload-1', mediaType: 'image', mimeType: 'image/png',
    declaredSize: input.length, status: constants.ASSET_STATUS.INTENT,
    cloudPath: 'private/image/abcdef0123456789abcdef0123456789abcdef0123456789.jpg',
  };
  const storage = createLocalStorageAdapter({ root: tempRoot });
  const updates = [];
  const fakeDb = {
    serverDate: () => new Date().toISOString(),
    getStorage: () => storage,
    getDb: () => ({
      async rpc(name, args) {
        assert.equal(name, 'hg_claim_image');
        return { cloudPath: asset.cloudPath, status: constants.ASSET_STATUS.INTENT, claim: args.p_claim };
      },
    }),
    async findOneById(name, id) {
      assert.equal(name, constants.COLLECTIONS.assets);
      assert.equal(id, asset._id);
      return asset;
    },
    coll(name) {
      assert.equal(name, constants.COLLECTIONS.assets);
      return { where: (condition) => ({ update: async ({ data }) => {
        updates.push({ condition, data });
        return { stats: { updated: 1 } };
      } }) };
    },
  };

  const originalLoad = Module._load;
  const assetsModulePath = require.resolve('../cloudfunctions/api/domain/assets.js');
  delete require.cache[assetsModulePath];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../shared/db' && parent?.filename?.replace(/\\/g, '/').endsWith('/cloudfunctions/api/domain/assets.js')) return fakeDb;
    return originalLoad.call(this, request, parent, isMain);
  };
  let assets;
  try { assets = require(assetsModulePath); }
  finally {
    Module._load = originalLoad;
    delete require.cache[assetsModulePath];
  }

  const result = await assets.uploadImage({ assetId: asset._id, contentBase64: input.toString('base64'), idempotencyKey: 'upload-key-1' }, {
    viewer: { userId: asset.ownerId, isMember: true },
    capabilities: { uploads: true },
  });
  assert.equal(result.status, constants.ASSET_STATUS.UPLOADED);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].data.reservedFileId, `pgstore://blacklight-private/${asset.cloudPath}`);
  assert.equal(updates[1].data.cleanedMimeType, 'image/jpeg');
  assert.ok(updates[1].data.cleanedSize > 0);
  const saved = await storage.downloadFile({ fileID: result.status === constants.ASSET_STATUS.UPLOADED ? updates[1].data.fileId : '' });
  assert.equal(saved.fileContent.subarray(0, 2).toString('hex'), 'ffd8');
  const savedStat = await stat(join(tempRoot, asset.cloudPath));
  assert.equal(savedStat.mode & 0o777, 0o600);
});
