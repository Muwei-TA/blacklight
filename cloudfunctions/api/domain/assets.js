/**
 * 图片资产链路（R04/R05）。
 *
 * 客户端只拿到短 TTL upload intent，不拿任意 fileId 或可写 cloudPath。
 * assets/upload 在云函数内接收 base64，验证实际格式/像素后清洗为 JPEG，
 * 再写入随机不可关联路径。assets/confirm 只确认这条已上传资产，不接受外来 fileId。
 * 视频能力保持关闭，任何视频 intent 都拒绝。
 */

const crypto = require('node:crypto');
const { COLLECTIONS, ASSET_STATUS } = require('../shared/constants');
const policies = require('../shared/policies');
const validators = require('../shared/validators');
const errors = require('../shared/errors');
const db = require('../shared/db');
const {
  ImageProcessingError,
  MAX_DECODED_BYTES,
  JPEG_MIME,
  PNG_MIME,
  sanitizeImageBase64,
} = require('../shared/image-processing');

const INTENT_TTL_MS = 15 * 60 * 1000;
// Keep the public asset status enum unchanged. An intent with uploadStartedAt
// set is already claimed, while status `intent` remains visible to the
// existing cleanup worker and can still expire safely.

function buildStoragePath() {
  return `private/image/${crypto.randomBytes(24).toString('hex')}.jpg`;
}

function nowMillis() {
  return Date.now();
}

function ensureImageIntentPayload(payload) {
  if (payload.mediaType !== 'image') {
    throw errors.forbidden({ reason: 'only jpeg/png image uploads are enabled' });
  }
  const input = validators.validateUploadIntent(payload);
  const mimeType = String(input.mimeType || '').toLowerCase();
  if (mimeType !== JPEG_MIME && mimeType !== PNG_MIME) {
    throw errors.invalidInput('只支持 JPEG 或 PNG 图片', { field: 'mimeType' });
  }
  if (input.size > MAX_DECODED_BYTES) {
    throw errors.invalidInput('图片文件不能超过 2MiB', { field: 'size' });
  }
  return { ...input, mimeType };
}

async function imageRpc(name, args) {
  try { return await db.getDb().rpc(name, args); } catch (err) {
    if (/IMAGE_EXPIRED/.test(err.message)) throw errors.invalidInput('上传已过期，请重新选择图片', { code: 'image_expired' });
    if (/IMAGE_QUOTA/.test(err.message)) throw errors.rateLimited({ reason: 'image quota reached' });
    if (/CLUB_UPLOAD_QUOTA/.test(err.message)) throw errors.rateLimited({ reason: 'club upload quota reached' });
    if (/IMAGE_NOT_FOUND/.test(err.message)) throw errors.notAccessible();
    if (/IMAGE_/.test(err.message)) throw errors.conflict('图片状态已变化或请求处理中，请稍后重试');
    throw err;
  }
}
async function createIntent(payload, ctx) {
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  if (!policies.canUseUploads(ctx.viewer, ctx.capabilities)) throw errors.forbidden();
  const input = ensureImageIntentPayload(payload);
  const key = validators.requireString(payload.idempotencyKey, '请求标识', { min: 8, max: 120 });
  const assetId = crypto.randomUUID();
  const createdAt = db.serverDate();
  const asset = {
    _id: assetId, ownerId: ctx.viewer.userId, clubId: ctx.viewer.clubId, mediaType: 'image', declaredSize: input.size,
    quotaBytes: MAX_DECODED_BYTES, declaredDuration: 0, mimeType: input.mimeType,
    status: ASSET_STATUS.INTENT, postId: '', postVersion: 0, fileId: '', cleanedFileId: '',
    cloudPath: buildStoragePath(), expiresAt: new Date(nowMillis()+INTENT_TTL_MS).toISOString(),
    reviewTaskId: '', tempFileURL: '', coverURL: '', createdAt, updatedAt: createdAt,
  };
  return imageRpc('hg_image_intent', {
    p_owner: ctx.viewer.userId, p_club_id: ctx.viewer.clubId, p_key: key, p_asset: asset,
  });
}

async function findOwnedIntent(assetId, ctx) {
  const asset = await db.findOneById(COLLECTIONS.assets, assetId);
  if (!asset) throw errors.notAccessible({ assetId });
  if (asset.ownerId !== ctx.viewer.userId) throw errors.forbidden({ reason: 'asset owner mismatch' });
  if (asset.mediaType !== 'image') throw errors.forbidden({ reason: 'video uploads are disabled' });
  return asset;
}

/** Controlled bytes upload. The reserved random object path is persisted before
 * storage writes, so process loss never leaves an untracked object. A retry
 * after lease expiry must use identical bytes; published objects cannot change.
 */
async function uploadImage(payload, ctx) {
  if (!policies.canUseUploads(ctx.viewer, ctx.capabilities)) throw errors.forbidden();
  const assetId = validators.requireId(payload.assetId, 'assetId');
  const key = validators.requireString(payload.idempotencyKey, '请求标识', { min: 8, max: 120 });
  const asset = await findOwnedIntent(assetId, ctx);
  let cleaned;
  try { cleaned = sanitizeImageBase64(payload.contentBase64, { declaredMimeType: asset.mimeType }); }
  catch (err) { if (err instanceof ImageProcessingError) throw errors.invalidInput(err.message, { code: err.code }); throw err; }
  if (cleaned.actualSize !== asset.declaredSize) throw errors.invalidInput('图片大小与上传意图不一致');
  const hash = crypto.createHash('sha256').update(cleaned.buffer).digest('hex');
  const claimId = crypto.randomUUID();
  const reserved = await imageRpc('hg_claim_image', { p_owner: ctx.viewer.userId, p_asset_id: assetId, p_key: key, p_hash: hash, p_claim: claimId });
  const toResult = (a) => ({ assetId, status: a.status, width: a.width || 0, height: a.height || 0, actualSize: a.actualSize || 0, cleanedSize: a.cleanedSize || 0 });
  if (reserved.fileId && reserved.status !== ASSET_STATUS.INTENT) return toResult(reserved);
  const cloud = db.getStorage();
  // Persist the storage-assigned identifier before sending bytes. If the
  // process dies after upload, cleanup can still delete the reserved object.
  const storage = cloud;
  const metadata = await storage.getUploadMetadata({ cloudPath: reserved.cloudPath });
  const reservedFileId = metadata && metadata.data && metadata.data.fileId;
  if (!reservedFileId) throw new Error('storage reservation failed');
  const tracked = await db.coll(COLLECTIONS.assets).where({ _id: assetId, status: ASSET_STATUS.INTENT, uploadClaim: claimId }).update({ data: { reservedFileId } });
  if (!tracked.stats || tracked.stats.updated !== 1) throw errors.conflict('上传租约已更新');
  const uploaded = await cloud.uploadFile({ cloudPath: reserved.cloudPath, fileContent: cleaned.buffer });
  const fileId = uploaded && (uploaded.fileID || uploaded.fileId);
  if (!fileId) throw new Error('storage returned no file identifier');
  const data = {
    status: ASSET_STATUS.UPLOADED, fileId, cleanedFileId: fileId,
    actualSize: cleaned.actualSize, cleanedSize: cleaned.cleanedSize,
    quotaBytes: Math.max(cleaned.actualSize, cleaned.cleanedSize),
    quotaChargedAt: db.serverDate(),
    width: cleaned.width, height: cleaned.height, sourceMimeType: cleaned.sourceMimeType,
    cleanedMimeType: JPEG_MIME, cleanedAt: db.serverDate(), updatedAt: db.serverDate(),
    uploadLeaseUntil: null,
  };
  const updated = await db.coll(COLLECTIONS.assets).where({ _id: assetId, ownerId: ctx.viewer.userId, status: ASSET_STATUS.INTENT, uploadClaim: claimId }).update({ data });
  if (!updated.stats || updated.stats.updated !== 1) throw errors.conflict('上传租约已更新，请使用同一图片重试');
  return toResult(data);
}

async function confirmUpload(payload, ctx) {
  if (!policies.canUseUploads(ctx.viewer, ctx.capabilities)) throw errors.forbidden();
  if (payload.fileId) throw errors.invalidInput('客户端不能提交 fileId', { field: 'fileId' });
  const assetId = validators.requireId(payload.assetId, 'assetId');
  await imageRpc('hg_confirm_image', { p_owner: ctx.viewer.userId, p_asset_id: assetId });
  await require('./foreground-review').runOwnedReview('asset', assetId, ctx).catch(() => null);
  const current = await findOwnedIntent(assetId, ctx);
  return { assetId, status: current.status };
}

async function canReadAsset(asset, ctx) {
  if (asset.ownerId === ctx.viewer.userId && !asset.postId) return true;
  if (!asset.postId) return false;
  const post = await db.findOneById(COLLECTIONS.posts, asset.postId);
  return policies.canReadPost(ctx.viewer, post);
}

async function authorizedUrl(asset) {
  if (asset.status !== ASSET_STATUS.VERIFIED || !asset.fileId) return '';
  const cloud = db.getStorage();
  const result = await cloud.getTempFileURL({ fileList: [asset.fileId] }).catch(() => null);
  const file = result && result.fileList && result.fileList[0];
  return file && Number(file.status) === 0 ? file.tempFileURL || '' : '';
}

/** GET /assets/{id} —— 每次按内容权限重新签发 URL；管理员不能绕过私密内容。 */
async function getStatus(payload, ctx) {
  const assetId = validators.requireId(payload.assetId, 'assetId');
  const asset = await db.findOneById(COLLECTIONS.assets, assetId);
  if (!asset || !(await canReadAsset(asset, ctx))) throw errors.notAccessible({ assetId });

  return {
    assetId,
    status: asset.status,
    mediaType: asset.mediaType,
    url: await authorizedUrl(asset),
    cover: '',
    failureReason: asset.status === ASSET_STATUS.REJECTED ? asset.failureReason || '未通过内容检查' : '',
    width: asset.width || 0,
    height: asset.height || 0,
  };
}

async function signReadableAssets(assets, posts, ctx) {
  const allowed = new Map(posts.filter((p) => policies.canReadPost(ctx.viewer, p)).map((p) => [p._id, p]));
  return Promise.all(assets.map(async (asset) => ({
    ...asset, tempFileURL: allowed.has(asset.postId) && (allowed.get(asset.postId).assetIds || []).includes(asset._id)
      ? await authorizedUrl(asset) : '', coverURL: '',
  })));
}

module.exports = {
  signReadableAssets,
  buildStoragePath,
  createIntent,
  uploadImage,
  confirmUpload,
  getStatus,
  canReadAsset,
  authorizedUrl,
};
