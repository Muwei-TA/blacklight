import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_BUCKET_ID,
  SIGNED_URL_TTL_SECONDS,
  PgStorageAdapterError,
  createPgStorageAdapter,
  makePgFileId,
  parsePgFileId,
} = require('../shared/pg-storage.js');

function makeFakeApp() {
  const calls = { from: [], upload: [], signed: [], download: [], remove: [] };
  const bucket = {
    async upload(path, body, options) {
      calls.upload.push({ path, body, options });
      return { data: { id: 'server-generated-id', path, fullPath: `${DEFAULT_BUCKET_ID}/${path}` }, error: null };
    },
    async createSignedUrl(path, expiresIn) {
      calls.signed.push({ path, expiresIn });
      if (path === 'private/image/fail.jpg') {
        return { data: null, error: { code: 'STORAGE_PERMISSION_DENIED', message: 'denied' } };
      }
      return { data: { fullSignedURL: `https://signed.example/${path}` }, error: null };
    },
    async download(path) {
      calls.download.push(path);
      return { data: new Blob([Buffer.from(`bytes:${path}`)]), error: null };
    },
    async remove(paths) {
      calls.remove.push(paths);
      if (paths[0] === 'private/image/fail.jpg') {
        return { data: null, error: { code: 'STORAGE_PERMISSION_DENIED', message: 'denied' } };
      }
      return { data: [{ name: paths[0] }], error: null };
    },
  };
  return {
    calls,
    app: {
      storage: {
        from(bucketId) {
          calls.from.push(bucketId);
          return bucket;
        },
      },
    },
  };
}

test('file IDs are private-bucket scoped and reject URLs/traversal', () => {
  const fileId = makePgFileId(DEFAULT_BUCKET_ID, 'private/image/a.jpg');
  assert.equal(fileId, 'pgstore://blacklight-private/private/image/a.jpg');
  assert.deepEqual(parsePgFileId(fileId), {
    bucketId: DEFAULT_BUCKET_ID,
    objectKey: 'private/image/a.jpg',
    fileId,
  });
  for (const invalid of [
    'cloud://legacy/path.jpg',
    'https://example.invalid/file.jpg',
    'pgstore://other-bucket/path.jpg',
    'pgstore://blacklight-private/../secret.jpg',
    'pgstore://blacklight-private/private//file.jpg',
  ]) {
    assert.throws(() => parsePgFileId(invalid), PgStorageAdapterError);
  }
});

test('getUploadMetadata is local and returns a persistable PG file ID', async () => {
  const fake = makeFakeApp();
  const storage = createPgStorageAdapter({ app: fake.app });
  const result = await storage.getUploadMetadata({ cloudPath: 'private/image/a.jpg' });
  assert.deepEqual(result, { data: { fileId: 'pgstore://blacklight-private/private/image/a.jpg' } });
  assert.deepEqual(fake.calls.from, [DEFAULT_BUCKET_ID]);
  assert.equal(fake.calls.upload.length, 0);
});

test('upload uses PG bucket JPEG upsert and returns canonical fileID', async () => {
  const fake = makeFakeApp();
  const storage = createPgStorageAdapter({ app: fake.app });
  const body = Buffer.from('jpeg-bytes');
  const result = await storage.uploadFile({ cloudPath: 'private/image/a.jpg', fileContent: body });
  assert.equal(result.fileID, 'pgstore://blacklight-private/private/image/a.jpg');
  assert.equal(result.statusCode, 200);
  assert.equal(fake.calls.upload.length, 1);
  assert.equal(fake.calls.upload[0].path, 'private/image/a.jpg');
  assert.ok(Buffer.isBuffer(fake.calls.upload[0].body));
  assert.equal(fake.calls.upload[0].body.toString(), body.toString());
  assert.deepEqual(fake.calls.upload[0].options, { contentType: 'image/jpeg', upsert: true });
});

test('Blob input is normalized to binary Buffer so SDK uses its content-type header branch', async () => {
  const fake = makeFakeApp();
  const storage = createPgStorageAdapter({ app: fake.app });
  await storage.uploadFile({
    cloudPath: 'private/image/blob.jpg',
    fileContent: new Blob([Buffer.from('jpeg-blob')], { type: 'image/jpeg' }),
  });
  assert.ok(Buffer.isBuffer(fake.calls.upload[0].body));
  assert.equal(fake.calls.upload[0].body.toString(), 'jpeg-blob');
  assert.deepEqual(fake.calls.upload[0].options, { contentType: 'image/jpeg', upsert: true });
});

test('signed URLs use five-minute TTL and preserve per-file errors', async () => {
  const fake = makeFakeApp();
  const storage = createPgStorageAdapter({ app: fake.app });
  const result = await storage.getTempFileURL({
    fileList: [
      makePgFileId(DEFAULT_BUCKET_ID, 'private/image/a.jpg'),
      makePgFileId(DEFAULT_BUCKET_ID, 'private/image/fail.jpg'),
    ],
  });
  assert.equal(fake.calls.signed[0].expiresIn, SIGNED_URL_TTL_SECONDS);
  assert.equal(result.fileList[0].status, 0);
  assert.equal(result.fileList[0].tempFileURL, 'https://signed.example/private/image/a.jpg');
  assert.equal(result.fileList[1].status, 1);
  assert.equal(result.fileList[1].tempFileURL, '');
  assert.match(result.fileList[1].errMsg, /denied/);
});

test('download converts SDK Blob to Buffer and never fetches arbitrary URLs', async () => {
  const fake = makeFakeApp();
  const storage = createPgStorageAdapter({ app: fake.app });
  const result = await storage.downloadFile({ fileID: makePgFileId(DEFAULT_BUCKET_ID, 'private/image/a.jpg') });
  assert.ok(Buffer.isBuffer(result.fileContent));
  assert.equal(result.fileContent.toString(), 'bytes:private/image/a.jpg');
  assert.deepEqual(fake.calls.download, ['private/image/a.jpg']);
  await assert.rejects(
    storage.downloadFile({ fileID: 'https://example.invalid/private/image/a.jpg' }),
    PgStorageAdapterError,
  );
});

test('delete calls PG remove per item and retains failures in legacy response shape', async () => {
  const fake = makeFakeApp();
  const storage = createPgStorageAdapter({ app: fake.app });
  const result = await storage.deleteFile({
    fileList: [
      makePgFileId(DEFAULT_BUCKET_ID, 'private/image/a.jpg'),
      makePgFileId(DEFAULT_BUCKET_ID, 'private/image/fail.jpg'),
    ],
  });
  assert.deepEqual(fake.calls.remove, [['private/image/a.jpg'], ['private/image/fail.jpg']]);
  assert.equal(result.fileList[0].status, 0);
  assert.equal(result.fileList[1].status, 1);
  assert.match(result.fileList[1].message, /denied/);
});

test('server initialization requires server-only environment configuration', () => {
  const oldKey = process.env.CLOUDBASE_APIKEY;
  delete process.env.CLOUDBASE_APIKEY;
  try {
    assert.throws(
      () => createPgStorageAdapter({ env: 'test-env', cloudbase: { init() { throw new Error('should not init'); } } }),
      (error) => error instanceof PgStorageAdapterError && error.code === 'MISSING_SERVER_KEY',
    );
  } finally {
    if (oldKey === undefined) delete process.env.CLOUDBASE_APIKEY;
    else process.env.CLOUDBASE_APIKEY = oldKey;
  }
});
