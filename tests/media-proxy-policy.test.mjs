import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const backend = fileURLToPath(new URL('..', import.meta.url));
const mediaModule = resolve(backend, 'server/media.js');

function loadMediaService({ db, policies, resolveContext }) {
  const originalLoad = Module._load;
  delete require.cache[mediaModule];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (parent && parent.filename === mediaModule) {
      if (request === '../shared/db') return db;
      if (request === '../shared/policies') return policies;
      if (request === '../shared/session') return { resolveContext };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(mediaModule);
  } finally {
    Module._load = originalLoad;
  }
}

test('a still-valid signed URL stops serving media when its owner is removed', async () => {
  let downloads = 0;
  const claim = {
    assetId: 'asset-history',
    clubId: 'synthetic-review-a',
    fileId: 'pgstore://blacklight-private/private/image/history.jpg',
    userId: 'synthetic-owner',
    permissionVersion: 1,
  };
  const asset = {
    _id: claim.assetId,
    clubId: claim.clubId,
    ownerId: claim.userId,
    postId: 'synthetic-post-a',
    fileId: claim.fileId,
    status: 'verified',
  };
  const post = {
    _id: asset.postId,
    clubId: claim.clubId,
    ownerId: claim.userId,
    visibility: 'club',
    status: 'published',
    permissionVersion: 1,
    assetIds: [asset._id],
  };
  const db = {
    getStorage: () => ({
      verifyAssetUrl: () => claim,
      async downloadFile() { downloads += 1; return { fileContent: Buffer.from('jpeg bytes') }; },
    }),
    async findOneById(collection, _id) {
      if (collection === 'hg_users') return { _id: 'synthetic-owner', wxOpenIdRef: 'synthetic-owner-openid', status: 'active' };
      if (collection === 'hg_assets') return asset;
      if (collection === 'hg_posts') return post;
      return null;
    },
  };
  const policies = {
    canReadPost: () => true,
    canReadPostMedia: (viewer) => viewer.memberStatus !== 'removed' && viewer.isMember,
  };
  const removedViewer = {
    userId: claim.userId,
    clubId: claim.clubId,
    memberStatus: 'removed',
    isMember: false,
  };
  const service = loadMediaService({
    db,
    policies,
    async resolveContext() { return { user: { _id: claim.userId }, viewer: removedViewer }; },
  });

  const result = await service.getAuthorizedMedia({ assetId: asset._id, token: 'still-valid', signature: 'valid' });
  assert.equal(result, null);
  assert.equal(downloads, 0, 'the proxy must check current media permission before reading bytes');
});
