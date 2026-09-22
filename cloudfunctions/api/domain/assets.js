/**
 * 图片资产链路（R04/R05）。
 *
 * 客户端只拿到短 TTL upload intent，不拿任意 fileId 或可写 cloudPath。
 * assets/upload 在云函数内接收 base64，验证实际格式/像素后清洗为 JPEG，
 * 再写入随机不可关联路径。assets/confirm 只确认这条已上传资产，不接受外来 fileId。
 * 视频能力保持关闭，任何视频 intent 都拒绝。
 */

const crypto = require('node:crypto');
const { COLLECTIONS, ASSET_STATUS, REVIEW_TASK_STATUS } = require('../shared/constants');
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
const MAX_PENDING_INTENTS = 3;
const DAILY_IMAGE_QUOTA_BYTES = 20 * 1024 * 1024;
// Keep the public asset status enum unchanged. An intent with uploadStartedAt
// set is already claimed, while status `intent` remains visible to the
// existing cleanup worker and can still expire safely.

function buildStoragePath() {
  return `private/image/${crypto.randomBytes(24).toString('hex')}.jpg`;
}

function nowMillis() {
  return Date.now();
}

function readIdempotencyKey(payload) {
  if (payload.idempotencyKey === undefined || payload.idempotencyKey === '') return '';
  return validators.requireString(payload.idempotencyKey, '请求标识', { max: 120 });
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
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

async function loadOwnerQuota(ownerId) {
  const res = await db
    .coll(COLLECTIONS.assets)
    .where({ ownerId, mediaType: 'image' })
    // The daily byte quota counts failed attempts too. Keep enough history to
    // cover the quota boundary instead of allowing many tiny requests to hide
    // behind the repository's default 100-row limit.
    .limit(10000)
    .get();
  const now = nowMillis();
  const cutoff = now - 24 * 60 * 60 * 1000;
  let pending = 0;
  let dailyBytes = 0;
  for (const asset of res.data || []) {
    const createdAt = toMillis(asset.createdAt);
    if (createdAt >= cutoff) dailyBytes += Number(asset.declaredSize) || 0;
    if (asset.status === ASSET_STATUS.INTENT && toMillis(asset.expiresAt) > now) pending += 1;
  }
  return { pending, dailyBytes };
}

async function createIntent(payload, ctx) {
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  if (ctx.capabilities.uploads !== true) throw errors.forbidden({ reason: 'uploads disabled until media validation' });

  const input = ensureImageIntentPayload(payload);
  const quota = await loadOwnerQuota(ctx.viewer.userId);
  if (quota.pending >= MAX_PENDING_INTENTS || quota.dailyBytes + input.size > DAILY_IMAGE_QUOTA_BYTES) {
    throw errors.rateLimited({ reason: 'image upload quota exceeded' });
  }

  const idempotencyKey = readIdempotencyKey(payload);
  const claim = await db.claimIdempotency(idempotencyKey, ctx.viewer.userId, 'createImageIntent');
  if (!claim.isNew) {
    if (claim.result) return claim.result;
    throw errors.conflict('请求正在处理中，请稍后重试');
  }

  const assetId = crypto.randomUUID();
  const uploadAttemptId = crypto.randomUUID();
  const expiresAt = new Date(nowMillis() + INTENT_TTL_MS).toISOString();
  await db.coll(COLLECTIONS.assets).add({
    data: {
      _id: assetId,
      ownerId: ctx.viewer.userId,
      mediaType: 'image',
      declaredSize: input.size,
      declaredDuration: 0,
      mimeType: input.mimeType,
      status: ASSET_STATUS.INTENT,
      postId: '',
      postVersion: 0,
      fileId: '',
      cleanedFileId: '',
      cloudPath: '',
      uploadAttemptId,
      uploadStartedAt: null,
      expiresAt,
      reviewTaskId: '',
      tempFileURL: '',
      coverURL: '',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  });

  const result = { assetId, expiresAt, expiresInSeconds: Math.floor(INTENT_TTL_MS / 1000), mediaType: 'image' };
  await db.completeIdempotency(idempotencyKey, ctx.viewer.userId, 'createImageIntent', result);
  return result;
}

async function findOwnedIntent(assetId, ctx) {
  const asset = await db.findOneById(COLLECTIONS.assets, assetId);
  if (!asset) throw errors.notAccessible({ assetId });
  if (asset.ownerId !== ctx.viewer.userId) throw errors.forbidden({ reason: 'asset owner mismatch' });
  if (asset.mediaType !== 'image') throw errors.forbidden({ reason: 'video uploads are disabled' });
  return asset;
}

function ensureIntentIsUsable(asset) {
  if (asset.status !== ASSET_STATUS.INTENT) throw errors.conflict('上传意图已经使用或已失效');
  if (asset.uploadStartedAt) throw errors.conflict('上传意图已经开始处理，不能重复使用');
  if (!asset.expiresAt || toMillis(asset.expiresAt) <= nowMillis()) throw errors.conflict('上传意图已过期，请重新申请');
}

async function markUploadRejected(asset, reason) {
  await db
    .coll(COLLECTIONS.assets)
    .where({ _id: asset._id, status: ASSET_STATUS.INTENT, uploadAttemptId: asset.uploadAttemptId })
    .update({ data: { status: ASSET_STATUS.REJECTED, failureReason: reason, updatedAt: db.serverDate() } })
    .catch(() => {});
}

/** POST /assets/upload —— 受控接收 base64，客户端永远不能指定 fileId。 */
async function uploadImage(payload, ctx) {
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  if (ctx.capabilities.uploads !== true) throw errors.forbidden({ reason: 'uploads disabled until media validation' });

  const idempotencyKey = readIdempotencyKey(payload);
  const assetId = validators.requireId(payload.assetId, 'assetId');
  const asset = await findOwnedIntent(assetId, ctx);
  if (asset.status === ASSET_STATUS.INTENT) ensureIntentIsUsable(asset);
  else if (asset.status !== ASSET_STATUS.UPLOADED || !asset.fileId) throw errors.conflict('上传意图已经使用或已失效');
  const claim = await db.claimIdempotency(idempotencyKey, ctx.viewer.userId, 'uploadImage');
  if (!claim.isNew) {
    if (claim.result) {
      if (claim.result.assetId && claim.result.assetId !== assetId) {
        throw errors.conflict('请求标识已用于其他资产');
      }
      return claim.result;
    }
    if (asset.status === ASSET_STATUS.UPLOADED && asset.fileId) {
      const result = {
        assetId,
        status: ASSET_STATUS.UPLOADED,
        width: asset.width || 0,
        height: asset.height || 0,
        actualSize: asset.actualSize || 0,
        cleanedSize: asset.cleanedSize || 0,
      };
      await db.completeIdempotency(idempotencyKey, ctx.viewer.userId, 'uploadImage', result);
      return result;
    }
    throw errors.conflict('上传请求正在处理中，请稍后重试');
  }
  if (asset.status === ASSET_STATUS.UPLOADED && asset.fileId) {
    const result = {
      assetId,
      status: ASSET_STATUS.UPLOADED,
      width: asset.width || 0,
      height: asset.height || 0,
      actualSize: asset.actualSize || 0,
      cleanedSize: asset.cleanedSize || 0,
    };
    await db.completeIdempotency(idempotencyKey, ctx.viewer.userId, 'uploadImage', result);
    return result;
  }

  const _ = db.command();
  const claimed = await db
    .coll(COLLECTIONS.assets)
    .where({
      _id: asset._id,
      ownerId: ctx.viewer.userId,
      status: ASSET_STATUS.INTENT,
      uploadStartedAt: _.eq(null),
    })
    .update({ data: { uploadStartedAt: db.serverDate(), updatedAt: db.serverDate() } });
  if (!claimed.stats || claimed.stats.updated !== 1) throw errors.conflict('上传意图已经开始处理，不能重复使用');

  let cleaned;
  try {
    cleaned = sanitizeImageBase64(payload.contentBase64, { declaredMimeType: asset.mimeType });
  } catch (err) {
    await markUploadRejected(asset, err instanceof ImageProcessingError ? err.message : '图片无法处理');
    if (err instanceof ImageProcessingError) {
      throw errors.invalidInput(err.message, { code: err.code });
    }
    throw err;
  }

  const cloud = db.getCloud();
  const cloudPath = buildStoragePath();
  let uploaded;
  try {
    uploaded = await cloud.uploadFile({ cloudPath, fileContent: cleaned.buffer });
  } catch (err) {
    await markUploadRejected(asset, '图片存储失败');
    throw err;
  }
  const fileId = uploaded && (uploaded.fileID || uploaded.fileId);
  if (!fileId) {
    await markUploadRejected(asset, '图片存储未返回文件标识');
    throw new Error('controlled image upload returned no file id');
  }

  const updated = await db
    .coll(COLLECTIONS.assets)
    .where({ _id: asset._id, ownerId: ctx.viewer.userId, status: ASSET_STATUS.INTENT, uploadAttemptId: asset.uploadAttemptId })
    .update({
      data: {
        status: ASSET_STATUS.UPLOADED,
        fileId,
        cleanedFileId: fileId,
        cloudPath: '',
        actualSize: cleaned.actualSize,
        cleanedSize: cleaned.cleanedSize,
        width: cleaned.width,
        height: cleaned.height,
        sourceMimeType: cleaned.sourceMimeType,
        mimeType: JPEG_MIME,
        cleanedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
  if (!updated.stats || updated.stats.updated !== 1) {
    await cloud.deleteFile({ fileList: [fileId] }).catch(() => {});
    throw new Error('asset changed before controlled upload binding');
  }

  const result = {
    assetId,
    status: ASSET_STATUS.UPLOADED,
    width: cleaned.width,
    height: cleaned.height,
    actualSize: cleaned.actualSize,
    cleanedSize: cleaned.cleanedSize,
  };
  await db.completeIdempotency(idempotencyKey, ctx.viewer.userId, 'uploadImage', result);
  return result;
}

/** POST /assets/confirm —— 只确认服务端已绑定的上传，不接受外来 fileId。 */
async function confirmUpload(payload, ctx) {
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  if (ctx.capabilities.uploads !== true) throw errors.forbidden({ reason: 'uploads disabled until media validation' });
  if (payload.fileId) throw errors.invalidInput('客户端不能提交 fileId', { field: 'fileId' });

  const idempotencyKey = readIdempotencyKey(payload);
  const assetId = validators.requireId(payload.assetId, 'assetId');
  const asset = await findOwnedIntent(assetId, ctx);
  const claim = await db.claimIdempotency(idempotencyKey, ctx.viewer.userId, 'confirmImageUpload');
  if (!claim.isNew) {
    if (claim.result) {
      if (claim.result.assetId && claim.result.assetId !== assetId) {
        throw errors.conflict('请求标识已用于其他资产');
      }
      return claim.result;
    }
    if (asset.reviewTaskId) {
      const result = { assetId, status: asset.status };
      await db.completeIdempotency(idempotencyKey, ctx.viewer.userId, 'confirmImageUpload', result);
      return result;
    }
    throw errors.conflict('确认请求正在处理中，请稍后重试');
  }
  if (asset.status !== ASSET_STATUS.UPLOADED || !asset.fileId) {
    if (asset.reviewTaskId) {
      const result = { assetId, status: asset.status };
      await db.completeIdempotency(idempotencyKey, ctx.viewer.userId, 'confirmImageUpload', result);
      return result;
    }
    throw errors.conflict('请先完成受控图片上传');
  }
  if (asset.reviewTaskId) {
    const result = { assetId, status: asset.status };
    await db.completeIdempotency(idempotencyKey, ctx.viewer.userId, 'confirmImageUpload', result);
    return result;
  }

  const taskId = `asset-review:${assetId}`;
  await db
    .coll(COLLECTIONS.reviewTasks)
    .add({
      data: {
        _id: taskId,
        targetType: 'asset',
        targetId: assetId,
        mediaType: 'image',
        status: REVIEW_TASK_STATUS.QUEUED,
        attempts: 0,
        needsMedia: true,
        createdAt: db.serverDate(),
      },
    })
    .catch((err) => {
      if (!/23505|duplicate|exists/i.test(String(err.code || err.message))) throw err;
    });
  await db.coll(COLLECTIONS.assets).doc(assetId).update({ data: { reviewTaskId: taskId, updatedAt: db.serverDate() } });
  const result = { assetId, status: ASSET_STATUS.UPLOADED };
  await db.completeIdempotency(idempotencyKey, ctx.viewer.userId, 'confirmImageUpload', result);
  return result;
}

async function canReadAsset(asset, ctx) {
  if (asset.ownerId === ctx.viewer.userId && !asset.postId) return true;
  if (!asset.postId) return false;
  const post = await db.findOneById(COLLECTIONS.posts, asset.postId);
  return policies.canReadPost(ctx.viewer, post);
}

async function authorizedUrl(asset) {
  if (asset.status !== ASSET_STATUS.VERIFIED || !asset.fileId) return '';
  const cloud = db.getCloud();
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

module.exports = {
  MAX_PENDING_INTENTS,
  DAILY_IMAGE_QUOTA_BYTES,
  buildStoragePath,
  createIntent,
  uploadImage,
  confirmUpload,
  getStatus,
  loadOwnerQuota,
  canReadAsset,
  authorizedUrl,
};
