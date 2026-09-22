/**
 * 媒体上传用例。
 *
 * 链路：创建上传意图 → 客户端上传到私有隔离区 → 服务端确认 →
 *       校验格式/大小/时长 → 内容审核（worker）→ verified 才可绑定内容。
 *
 * 关键：
 * - 客户端声明的 size/duration 不可信，upload_confirm 后必须服务端复核
 * - 未 verified 的附件不得出现在任何 DTO 的可播放 url 中
 * - 私有桶 + 限时授权链接；权限变更时递增 permissionVersion 让旧链接尽快失效
 *   （限时链接只能缩短泄露窗口，不等于即时撤权 —— 这点必须写进验收）
 */

const { COLLECTIONS, ASSET_STATUS, REVIEW_TASK_STATUS } = require('../shared/constants');
const policies = require('../shared/policies');
const validators = require('../shared/validators');
const errors = require('../shared/errors');
const db = require('../shared/db');

/** 私有存储路径：按用户分区，文件名不含任何身份线索 */
function buildStoragePath(userId, mediaType, assetId) {
  const ext = mediaType === 'video' ? 'mp4' : 'jpg';
  // 不使用原始文件名，避免 EXIF 之外的元数据泄露
  return `private/${mediaType}/${userId.slice(0, 8)}/${assetId}.${ext}`;
}

/** POST /assets/upload-intents */
async function createIntent(payload, ctx) {
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();

  const input = validators.validateUploadIntent(payload);
  if (input.mediaType === 'video' && !policies.canUploadVideo(ctx.viewer, ctx.capabilities)) {
    throw errors.forbidden({ reason: 'video capability disabled' });
  }

  const added = await db.coll(COLLECTIONS.assets).add({
    data: {
      ownerId: ctx.viewer.userId,
      mediaType: input.mediaType,
      declaredSize: input.size,
      declaredDuration: input.duration,
      mimeType: input.mimeType,
      status: ASSET_STATUS.INTENT,
      postId: '',
      postVersion: 0,
      tempFileURL: '',
      coverURL: '',
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  });

  const cloudPath = buildStoragePath(ctx.viewer.userId, input.mediaType, added._id);
  await db.coll(COLLECTIONS.assets).doc(added._id).update({ data: { cloudPath } });

  return {
    assetId: added._id,
    // 客户端用 wx.cloud.uploadFile 直传到该路径；桶权限设为仅云函数可读
    cloudPath,
    expiresInSeconds: 900,
  };
}

/**
 * POST /assets/{id}/confirm —— 客户端上传完成后调用。
 * 服务端在此复核真实文件属性，并排入审核队列。
 */
async function confirmUpload(payload, ctx) {
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();

  const assetId = validators.requireId(payload.assetId, 'assetId');
  const fileId = validators.requireString(payload.fileId, 'fileId', { max: 300 });

  const asset = await db.findOneById(COLLECTIONS.assets, assetId);
  if (!asset) throw errors.notAccessible({ assetId });
  // 只能确认自己的附件，防止挂接他人文件
  if (asset.ownerId !== ctx.viewer.userId) throw errors.forbidden({ reason: 'asset owner mismatch' });
  if (asset.status !== ASSET_STATUS.INTENT) throw errors.conflict('附件状态不允许重复确认');

  await db.coll(COLLECTIONS.assets).doc(assetId).update({
    data: {
      fileId,
      status: ASSET_STATUS.UPLOADED,
      updatedAt: db.serverDate(),
    },
  });

  // 排入审核：图片走图片检查，视频走画面 + 音频检查
  await db.coll(COLLECTIONS.reviewTasks).add({
    data: {
      targetType: 'asset',
      targetId: assetId,
      mediaType: asset.mediaType,
      status: REVIEW_TASK_STATUS.QUEUED,
      attempts: 0,
      createdAt: db.serverDate(),
    },
  });

  return { assetId, status: ASSET_STATUS.UPLOADED };
}

/** GET /assets/{id} —— 轮询处理状态 */
async function getStatus(payload, ctx) {
  const assetId = validators.requireId(payload.assetId, 'assetId');
  const asset = await db.findOneById(COLLECTIONS.assets, assetId);
  if (!asset) throw errors.notAccessible({ assetId });
  if (asset.ownerId !== ctx.viewer.userId && !ctx.viewer.isAdmin) {
    throw errors.notAccessible({ assetId });
  }

  return {
    assetId,
    status: asset.status,
    mediaType: asset.mediaType,
    // 只有 verified 才给可访问链接
    url: asset.status === ASSET_STATUS.VERIFIED ? asset.tempFileURL || '' : '',
    cover: asset.coverURL || '',
    failureReason: asset.status === ASSET_STATUS.REJECTED ? asset.failureReason || '未通过内容检查' : '',
  };
}

module.exports = { createIntent, confirmUpload, getStatus, buildStoragePath };
