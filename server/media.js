'use strict';

const { COLLECTIONS, ASSET_STATUS } = require('../shared/constants');
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

async function resolveSubjectContext(userId, clubId) {
  if (!clubId) return null;
  try {
    if (!userId) return await resolveContext(null, clubId);
    const user = await db.findOneById(COLLECTIONS.users, userId);
    if (!user || user.status !== 'active' || !user.wxOpenIdRef) return null;
    const ctx = await resolveContext(user.wxOpenIdRef, clubId);
    if (!ctx.user || ctx.user._id !== userId) return null;
    return ctx;
  } catch (_) {
    return null;
  }
}

async function getAuthorizedMedia({ assetId, token, signature }) {
  const storage = db.getStorage();
  if (typeof storage.verifyAssetUrl !== 'function') return null;
  const claim = storage.verifyAssetUrl({ token, signature });
  if (!claim || claim.assetId !== assetId || typeof claim.clubId !== 'string') return null;

  const asset = await db.findOneById(COLLECTIONS.assets, assetId, claim.clubId);
  if (!asset || asset.clubId !== claim.clubId || asset.status !== ASSET_STATUS.VERIFIED || asset.fileId !== claim.fileId) return null;

  const ctx = await resolveSubjectContext(claim.userId || null, asset.clubId);
  if (!ctx) return null;

  let post = null;
  if (asset.postId) {
    post = await db.findOneById(COLLECTIONS.posts, asset.postId, asset.clubId);
    if (!post || post.clubId !== asset.clubId) return null;
    if (!policies.canReadPost(ctx.viewer, post)) return null;
    if (post._id !== asset.postId || !(post.assetIds || []).includes(asset._id)) return null;
  } else if (!claim.userId || asset.ownerId !== claim.userId || ctx.viewer.userId !== claim.userId || !ctx.viewer.isMember) {
    return null;
  }

  if (!sameVersion(claim.permissionVersion, currentPermissionVersion(asset, post))) return null;
  const downloaded = await storage.downloadFile({ fileID: asset.fileId });
  const content = downloaded && downloaded.fileContent;
  if (!Buffer.isBuffer(content)) return null;
  return { content, contentType: 'image/jpeg', assetId: asset._id };
}

module.exports = { getAuthorizedMedia, currentPermissionVersion, sameVersion };
