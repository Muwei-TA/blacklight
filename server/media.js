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
    if (!policies.canReadPostMedia(ctx.viewer, post)) return null;
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

async function getWebMedia({ assetId, clubId, draftId, postId, version, identity }) {
  if (!clubId || Boolean(draftId) === Boolean(postId) || !/^\d+$/.test(String(version))) return null;
  let ctx;
  try { ctx = await resolveContext(identity?.openid || null, clubId); } catch (_) { return null; }
  const asset = await db.findOneById(COLLECTIONS.assets, assetId, clubId);
  if (!asset) return null;
  let target;
  if (draftId) {
    try { target = await db.getDb().rpc('hg_article_draft', { p_operation: 'get', p_actor: ctx.viewer.userId, p_club_id: clubId, p_input: { id: draftId } }); } catch (_) { return null; }
  } else target = await db.findOneById(COLLECTIONS.posts, postId, clubId);
  let reviewReady = false;
  if (target?.status === 'pending' && ctx.viewer.isAdmin && target.ownerId !== ctx.viewer.userId) {
    const tasks = await db.coll(COLLECTIONS.reviewTasks, clubId).where({ clubId, targetType: 'post', targetId: target._id, postVersion: target.version, status: 'manual' }).limit(1).get();
    reviewReady = tasks.data.length > 0;
  }
  if (!policies.canReadRichAsset(ctx.viewer, asset, target, { draft: !!draftId, version, reviewReady })) return null;
  const downloaded = await db.getStorage().downloadFile({ fileID: asset.fileId });
  if (!Buffer.isBuffer(downloaded?.fileContent)) return null;
  return { content: downloaded.fileContent, contentType: 'image/jpeg' };
}
module.exports.getWebMedia = getWebMedia;
