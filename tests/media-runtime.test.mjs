import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));

const constants = {
  COLLECTIONS: {
    assets: 'hg_assets',
    posts: 'hg_posts',
  },
  ASSET_STATUS: {
    INTENT: 'intent',
    UPLOADED: 'uploaded',
    VERIFYING: 'verifying',
    VERIFIED: 'verified',
    REJECTED: 'rejected',
    FAILED: 'failed',
  },
  POST_STATUS: { DELETED: 'deleted' },
  REVIEW_TASK_STATUS: { PASSED: 'passed', FAILED: 'failed', QUEUED: 'queued' },
  CONTENT_LIMITS: { videoSize: 20 * 1024 * 1024 },
  DEFAULT_CLUB_ID: 'heiguang',
};

function loadVm(relativePath, mocks) {
  const filename = resolve(BACKEND, relativePath);
  const source = readFileSync(filename, 'utf8');
  const localRequire = (request) => {
    if (request.endsWith('/shared/db')) return {
      ...mocks['../shared/db'],
      getStorage: mocks['../shared/db']?.getStorage || mocks['../shared/db']?.getCloud || (() => mocks['wx-server-sdk']),
    };
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    if (request.endsWith('/shared/constants')) return mocks['../shared/constants'];
    if (request.endsWith('/shared/policies')) return mocks['../shared/policies'];
    if (request.endsWith('/shared/validators')) return mocks['../shared/validators'];
    if (request.endsWith('/shared/errors')) return mocks['../shared/errors'];
    if (request.endsWith('/shared/image-processing')) return mocks['../shared/image-processing'];
    if (request.endsWith('/shared/wechat-api')) return mocks['../shared/wechat-api'];
    return createRequire(filename)(request);
  };
  const module = { exports: {} };
  const context = vm.createContext({
    Buffer,
    Date,
    Promise,
    console,
    process,
    setTimeout,
    clearTimeout,
    module,
    exports: module.exports,
    require: localRequire,
    __filename: filename,
    __dirname: dirname(filename),
  });
  new vm.Script(`(function () {\n${source}\n}).call(null);`, { filename }).runInContext(context);
  return module.exports;
}

function error(kind, message = kind) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

const validators = {
  requireId(value) { if (!value) throw error('invalid_input'); return value; },
  requireString(value) { if (typeof value !== 'string' || value.length < 8) throw error('invalid_input'); return value; },
  validateUploadIntent(payload) { return { size: payload.size, mimeType: payload.mimeType }; },
};

const policies = {
  canUseUploads: (viewer, capabilities) => !!(viewer?.isMember && capabilities?.uploads === true),
  canReadPost: (viewer, post) => !!post && (post.visibility === 'public' || post.ownerId === viewer.userId),
};

const domainErrors = {
  forbidden: () => error('forbidden'),
  membershipInvalid: () => error('membership_invalid'),
  invalidInput: (message) => error('invalid_input', message),
  notAccessible: () => error('not_accessible'),
  conflict: (message) => error('conflict', message),
  rateLimited: () => error('rate_limited'),
};

class ImageProcessingError extends Error {}

test('upload storage failure records reservedFileId before upload and leaves no fake success', async () => {
  const events = [];
  const asset = {
    _id: 'asset-1', ownerId: 'owner-1', mediaType: 'image', status: 'intent',
    declaredSize: 3, mimeType: 'image/jpeg', cloudPath: 'private/image/object.jpg',
  };
  const cloud = {
    async getUploadMetadata() { events.push({ type: 'metadata' }); return { data: { fileId: 'reserved-file-1' } }; },
    async uploadFile() {
      events.push({ type: 'upload' });
      throw new Error('storage unavailable');
    },
  };
  const db = {
    serverDate: () => 'now',
    getCloud: () => cloud,
    getDb: () => ({
      async rpc(name, args) {
        events.push({ type: 'rpc', name, args });
        return { ...asset, uploadClaim: args.p_claim };
      },
    }),
    async findOneById() { return asset; },
    coll() {
      return {
        where(condition) {
          return {
            async update({ data }) {
              events.push({ type: 'update', condition, data });
              return { stats: { updated: 1 } };
            },
          };
        },
      };
    },
  };
  const nodeSdk = {
    init() {
      return {
        async getUploadMetadata(args) {
          events.push({ type: 'metadata', args });
          return { data: { fileId: 'reserved-file-1' } };
        },
      };
    },
  };
  const imageProcessing = {
    ImageProcessingError,
    MAX_DECODED_BYTES: 2 * 1024 * 1024,
    JPEG_MIME: 'image/jpeg',
    PNG_MIME: 'image/png',
    sanitizeImageBase64: () => ({
      buffer: Buffer.from('abc'), actualSize: 3, cleanedSize: 3,
      width: 1, height: 1, sourceMimeType: 'image/jpeg',
    }),
  };
  const assets = loadVm('cloudfunctions/api/domain/assets.js', {
    '../shared/constants': constants,
    '../shared/policies': policies,
    '../shared/validators': validators,
    '../shared/errors': domainErrors,
    '../shared/db': db,
    '../shared/image-processing': imageProcessing,
    '@cloudbase/node-sdk': nodeSdk,
  });

  await assert.rejects(
    assets.uploadImage({ assetId: 'asset-1', idempotencyKey: 'upload-key-1', contentBase64: 'ignored' }, {
      viewer: { userId: 'owner-1', isMember: true }, capabilities: { uploads: true },
    }),
    /storage unavailable/,
  );
  const reservedIndex = events.findIndex((event) => event.type === 'update' && event.data.reservedFileId);
  const uploadIndex = events.findIndex((event) => event.type === 'upload');
  assert.notEqual(reservedIndex, -1, 'reserved file id must be persisted');
  assert.ok(reservedIndex < uploadIndex, 'reservation must be persisted before storage PUT');
  assert.equal(events.filter((event) => event.type === 'update').length, 1, 'failed PUT must not mark asset uploaded');
  assert.equal(events[reservedIndex].data.reservedFileId, 'reserved-file-1');
});

test('orphan cleanup sends fileId, cleanedFileId and reservedFileId and keeps retry state on delete failure', async () => {
  const deleteCalls = [];
  const updates = [];
  const asset = {
    _id: 'asset-orphan', postId: '', status: 'uploaded',
    fileId: 'file-main', cleanedFileId: 'file-cleaned', reservedFileId: 'file-reserved',
    createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
  };
  const cloud = {
    async deleteFile(args) {
      deleteCalls.push(args);
      throw new Error('temporary storage outage');
    },
  };
  const db = {
    command: () => ({
      in: (value) => ({ $in: value }),
      lt: (value) => ({ $lt: value }),
      lte: (value) => ({ $lte: value }),
      exists: (value) => ({ $exists: value }),
    }),
    serverDate: () => 'now',
    coll(name) {
      const chain = {};
      chain.where = (condition) => { chain.condition = condition; return chain; };
      chain.limit = () => chain;
      chain.get = async () => (name === 'hg_assets' ? { data: [asset] } : { data: [] });
      chain.update = async ({ data }) => { updates.push({ condition: chain.condition, data }); return { stats: { updated: 1 } }; };
      chain.remove = async () => ({ stats: { removed: 1 } });
      chain.doc = () => chain;
      return chain;
    },
  };
  const cleanup = loadVm('cloudfunctions/worker/tasks/cleanup.js', {
    'wx-server-sdk': cloud,
    '../shared/constants': constants,
    '../shared/db': db,
  });

  const result = await cleanup.cleanupOrphanAssets();
  assert.deepEqual(JSON.parse(JSON.stringify(deleteCalls)), [{ fileList: ['file-main', 'file-cleaned', 'file-reserved'] }]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { removed: 0, retryable: 1, skipped: 0 });
  assert.equal(updates.some(({ data }) => data.cleanupState === 'retryable'), true);
});

test('purge clears every stored object id after successful delete', async () => {
  const updates = [];
  const asset = {
    _id: 'asset-revoked', postId: 'post-deleted', status: 'revoked',
    fileId: 'file-main', cleanedFileId: 'file-cleaned', reservedFileId: 'file-reserved',
  };
  const cloud = {
    async deleteFile() {
      return { fileList: [
        { fileID: 'file-main', status: 0 },
        { fileID: 'file-cleaned', status: 0 },
        { fileID: 'file-reserved', status: 0 },
      ] };
    },
  };
  const db = {
    command: () => ({ exists: (value) => ({ $exists: value }) }),
    serverDate: () => 'now',
    coll(name) {
      const chain = {};
      chain.where = (condition) => { chain.condition = condition; return chain; };
      chain.limit = () => chain;
      chain.get = async () => (name === 'hg_assets' ? { data: [asset] } : { data: [] });
      chain.update = async ({ data }) => { updates.push({ condition: chain.condition, data }); return { stats: { updated: 1 } }; };
      chain.remove = async () => ({ stats: { removed: 1 } });
      chain.doc = () => chain;
      return chain;
    },
  };
  const cleanup = loadVm('cloudfunctions/worker/tasks/cleanup.js', {
    'wx-server-sdk': cloud,
    '../shared/constants': constants,
    '../shared/db': db,
  });

  const result = await cleanup.cleanupDeletedPostAssets();
  assert.equal(result.purged, 1);
  const purgeUpdate = updates.find(({ data }) => data.status === 'purged');
  assert.ok(purgeUpdate);
  assert.equal(purgeUpdate.data.fileId, '');
  assert.equal(purgeUpdate.data.cleanedFileId, '');
  assert.equal(purgeUpdate.data.reservedFileId, '');
});

test('signReadableAssets re-signs only currently readable post assets and never signs private admin access', async () => {
  const signed = [];
  const db = {
    getCloud: () => ({
      async getTempFileURL({ fileList }) {
        signed.push(fileList[0]);
        return { fileList: [{ fileID: fileList[0], status: 0, tempFileURL: `https://signed/${fileList[0]}` }] };
      },
    }),
  };
  const assets = loadVm('cloudfunctions/api/domain/assets.js', {
    '../shared/constants': constants,
    '../shared/policies': policies,
    '../shared/validators': validators,
    '../shared/errors': domainErrors,
    '../shared/db': db,
    '../shared/image-processing': {
      ImageProcessingError, MAX_DECODED_BYTES: 2 * 1024 * 1024,
      JPEG_MIME: 'image/jpeg', PNG_MIME: 'image/png', sanitizeImageBase64() {},
    },
  });
  const viewer = { userId: 'admin', isMember: true };
  const posts = [
    { _id: 'public-post', ownerId: 'other', visibility: 'public', assetIds: ['public-asset'] },
    { _id: 'private-post', ownerId: 'owner', visibility: 'private', assetIds: ['private-asset'] },
  ];
  const input = [
    { _id: 'public-asset', postId: 'public-post', status: 'verified', fileId: 'file-public' },
    { _id: 'private-asset', postId: 'private-post', status: 'verified', fileId: 'file-private' },
  ];
  const first = await assets.signReadableAssets(input, posts, { viewer });
  const second = await assets.signReadableAssets(input, posts, { viewer });
  assert.deepEqual(signed, ['file-public', 'file-public']);
  assert.equal(first[0].tempFileURL, 'https://signed/file-public');
  assert.equal(first[1].tempFileURL, '');
  assert.equal(second[1].tempFileURL, '');
});

test('media verification update is guarded by the observed status and fileId', async () => {
  const updates = [];
  const usageCalls = [];
  let denyQuota = false;
  let imageCheckCalls = 0;
  const asset = { _id: 'asset-media', mediaType: 'image', status: 'uploaded', fileId: 'file-v1' };
  const storage = {
    async getTempFileURL() { return { fileList: [{ status: 0, tempFileURL: 'unused' }] }; },
    async downloadFile() { return { fileContent: Buffer.from('jpeg') }; },
  };
  const db = {
    getStorage: () => storage,
    async findOneById() { return asset; },
    serverDate: () => 'now',
    coll() {
      return {
        where(condition) {
          return {
            async update({ data }) {
              updates.push({ condition, data });
              return { stats: { updated: 0 } };
            },
          };
        },
      };
    },
  };
  const media = loadVm('cloudfunctions/worker/tasks/media.js', {
    '../shared/constants': constants,
    '../shared/db': db,
    '../shared/usage': {
      async reserveReviewCall(kind, clubId) {
        usageCalls.push({ kind, clubId });
        if (denyQuota) throw Object.assign(new Error('limit'), { code: 'USAGE_QUOTA', nextAttemptAt: '2026-09-24T00:00:00.000Z' });
      },
      waitingForQuota(error) {
        return error.code === 'USAGE_QUOTA' ? {
          status: 'queued', waitingReason: 'usage_quota', nextAttemptAt: new Date(error.nextAttemptAt),
        } : null;
      },
    },
    '../shared/wechat-api': { async imgSecCheck() { imageCheckCalls += 1; } },
    '../shared/image-processing': {
      ImageProcessingError,
      JPEG_MIME: 'image/jpeg',
      MAX_DECODED_BYTES: 2 * 1024 * 1024,
      inspectImageBuffer: () => ({ mimeType: 'image/jpeg', hasExif: false, width: 1, height: 1 }),
    },
  });

  const result = await media.processAsset({ targetId: asset._id });
  assert.equal(result.status, 'passed');
  assert.equal(updates.length, 1);
  assert.deepEqual(usageCalls, [{ kind: 'image', clubId: 'heiguang' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(updates[0].condition)), { _id: 'asset-media', status: 'uploaded', fileId: 'file-v1' });
  assert.equal(updates[0].data.status, 'verified');
  assert.equal(imageCheckCalls, 1);

  denyQuota = true;
  const waiting = await media.processAsset({ targetId: asset._id });
  assert.equal(waiting.status, 'queued');
  assert.equal(waiting.waitingReason, 'usage_quota');
  assert.equal(new Date(waiting.nextAttemptAt).toISOString(), '2026-09-24T00:00:00.000Z');
  assert.equal(imageCheckCalls, 1, 'quota denial prevents the next imgSecCheck call');
  assert.equal(updates.length, 1, 'quota wait does not change the asset review state');
});
