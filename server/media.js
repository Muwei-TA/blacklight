'use strict';

const { COLLECTIONS, DEFAULT_CLUB_ID, ASSET_STATUS } = require('../shared/constants');
const { resolveContext } = require('../shared/session');
const policies = require('../shared/policies');
const db = require('../shared/db');

function currentPermissionVersion(asset, post) {
  if (post) return post.permissionVersion === undefined ? 0 : post.permissionVersion;
  return asset.permissionVersion === undefined ? 0 : asset.permissionVersion;
}

function sameVersion(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return left === right;
  return String(left) === String(right);
}

async function resolveSubjectContext(userId) {
  if (!userId) return resolveContext(null, DEFAULT_CLUB_ID);
  const user = await db.findOneById(COLLECTIONS.users, userId);
  if (!user || user.status !== 'active' || !user.wxOpenIdRef) return null;
  const ctx = await resolveContext(user.wxOpenIdRef, DEFAULT_CLUB_ID);
  if (!ctx.user || ctx.user._id !== userId) return null;
  return ctx;
}

async function getAuthorizedMedia({ assetId, token, signature }) {
  const storage = db.getStorage();
  if (typeof storage.verifyAssetUrl !== 'function') return null;
  const claim = storage.verifyAssetUrl({ token, signature });
  if (!claim || claim.assetId !== assetId) return null;

  const asset = await db.findOneById(COLLECTIONS.assets, assetId);
  if (!asset || asset.status !== ASSET_STATUS.VERIFIED || asset.fileId !== claim.fileId) return null;

  const ctx = await resolveSubjectContext(claim.userId || null);
  if (!ctx) return null;

  let post = null;
  if (asset.postId) {
    post = await db.findOneById(COLLECTIONS.posts, asset.postId);
    if (!post || !policies.canReadPost(ctx.viewer, post)) return null;
    if (post._id !== asset.postId || !(post.assetIds || []).includes(asset._id)) return null;
  } else if (!claim.userId || asset.ownerId !== claim.userId || ctx.viewer.userId !== claim.userId) {
    return null;
  }

  if (!sameVersion(claim.permissionVersion, currentPermissionVersion(asset, post))) return null;
  const downloaded = await storage.downloadFile({ fileID: asset.fileId });
  const content = downloaded && downloaded.fileContent;
  if (!Buffer.isBuffer(content)) return null;
  return { content, contentType: 'image/jpeg', assetId: asset._id };
}

module.exports = { getAuthorizedMedia, currentPermissionVersion, sameVersion };
