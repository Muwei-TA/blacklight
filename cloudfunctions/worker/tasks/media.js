/**
 * 媒体处理任务。
 *
 * 视频不是"图片审核加一个播放按钮"：
 * 建议链路 = 校验格式/大小/时长 → 生成封面 → 画面与音频内容检查 →
 *            必要人工复核 → 全部必需任务完成后才允许展示。
 *
 * 首版落地范围（诚实声明）：
 * - 图片：同步 imgSecCheck，可完整闭环
 * - 视频：mediaCheckAsync 只提交任务，结果由 review-callback 函数接收；
 *   转码与封面生成需要额外的云服务，本仓库只留接入点，未实现
 *   → 因此 capabilities.video 默认 false，验收通过后才开启
 */

const cloud = require('wx-server-sdk');
const { COLLECTIONS, ASSET_STATUS, REVIEW_TASK_STATUS, CONTENT_LIMITS } = require('../shared/constants');
const db = require('../shared/db');

/** 服务端复核真实文件属性：客户端声明的 size/duration 不可信 */
async function verifyFileMetadata(asset) {
  const res = await cloud.getTempFileURL({ fileList: [asset.fileId] });
  const file = res.fileList && res.fileList[0];
  if (!file || file.status !== 0) throw new Error('getTempFileURL failed');

  // 通过 downloadFile 读取真实字节数
  const downloaded = await cloud.downloadFile({ fileID: asset.fileId });
  const actualSize = downloaded.fileContent ? downloaded.fileContent.length : 0;

  const limit = asset.mediaType === 'video' ? CONTENT_LIMITS.videoSize : CONTENT_LIMITS.imageSize;
  if (actualSize > limit) {
    throw Object.assign(new Error('file exceeds size limit'), { fatal: true });
  }

  return { tempFileURL: file.tempFileURL, actualSize, buffer: downloaded.fileContent };
}

/** 图片内容检查：同步返回，可直接闭环 */
async function checkImage(buffer) {
  try {
    await cloud.openapi.security.imgSecCheck({
      media: { contentType: 'image/png', value: buffer },
    });
    return { pass: true };
  } catch (err) {
    // 87014 = 内容含违规信息
    if (err.errCode === 87014) return { pass: false, label: 'risky' };
    throw new Error(`imgSecCheck failed: ${err.errCode || ''} ${err.message}`);
  }
}

/**
 * 视频内容检查：异步提交，结果由 review-callback 接收。
 * 提交成功后 asset 停在 verifying，绝不提前置为 verified。
 */
async function submitVideoCheck(asset, tempFileURL, openid) {
  try {
    const res = await cloud.openapi.security.mediaCheckAsync({
      mediaUrl: tempFileURL,
      mediaType: 2, // 2 = 视频
      version: 2,
      openid,
      scene: 2,
    });
    return { traceId: res.traceId || '' };
  } catch (err) {
    throw new Error(`mediaCheckAsync failed: ${err.errCode || ''} ${err.message}`);
  }
}

async function processAsset(task) {
  const asset = await db.findOneById(COLLECTIONS.assets, task.targetId);
  if (!asset) return { status: REVIEW_TASK_STATUS.PASSED, note: 'asset gone' };
  if (asset.status === ASSET_STATUS.VERIFIED || asset.status === ASSET_STATUS.REJECTED) {
    return { status: REVIEW_TASK_STATUS.PASSED, note: `already ${asset.status}` };
  }
  if (asset.status === ASSET_STATUS.VERIFYING) {
    // A callback may still be in flight. Re-submitting the same file would
    // create a second trace and let an older callback race the newer one.
    return {
      status: REVIEW_TASK_STATUS.QUEUED,
      note: 'waiting for async media callback',
      waitingReason: 'media_callback',
    };
  }
  if (asset.status !== ASSET_STATUS.UPLOADED && asset.status !== ASSET_STATUS.VERIFYING) {
    return { status: REVIEW_TASK_STATUS.QUEUED, note: `waiting upload, now ${asset.status}` };
  }

  let meta;
  try {
    meta = await verifyFileMetadata(asset);
  } catch (err) {
    if (err.fatal) {
      await markRejected(asset, '文件超出大小限制');
      return { status: REVIEW_TASK_STATUS.FAILED, note: err.message };
    }
    throw err;
  }

  if (asset.mediaType === 'image') {
    const result = await checkImage(meta.buffer);
    if (!result.pass) {
      await markRejected(asset, '图片未通过内容检查');
      return { status: REVIEW_TASK_STATUS.FAILED, note: 'image blocked' };
    }

    await db.coll(COLLECTIONS.assets).doc(asset._id).update({
      data: {
        status: ASSET_STATUS.VERIFIED,
        tempFileURL: meta.tempFileURL,
        actualSize: meta.actualSize,
        verifiedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
    return { status: REVIEW_TASK_STATUS.PASSED };
  }

  // 视频：提交异步检查后停在 verifying，等回调
  const owner = await db.findOneById(COLLECTIONS.users, asset.ownerId);
  const { traceId } = await submitVideoCheck(asset, meta.tempFileURL, owner && owner.wxOpenIdRef);
  if (!traceId) throw new Error('mediaCheckAsync returned no traceId');

  const reviewVersion = (Number(asset.reviewVersion) || 0) + 1;
  const bindCondition = { _id: asset._id, status: ASSET_STATUS.UPLOADED };
  if (asset.postVersion !== undefined) bindCondition.postVersion = asset.postVersion;
  const bound = await db.coll(COLLECTIONS.assets).where(bindCondition).update({
    data: {
      status: ASSET_STATUS.VERIFYING,
      traceId,
      reviewVersion,
      tempFileURL: '',
      actualSize: meta.actualSize,
      submittedAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  });
  if (!bound.stats || bound.stats.updated !== 1) {
    throw new Error('asset changed before async review binding');
  }

  return {
    status: REVIEW_TASK_STATUS.MANUAL,
    note: 'video submitted for async check; awaiting callback + transcode (not implemented)',
  };
}

async function markRejected(asset, reason) {
  await db.coll(COLLECTIONS.assets).doc(asset._id).update({
    data: {
      status: ASSET_STATUS.REJECTED,
      failureReason: reason,
      tempFileURL: '',
      updatedAt: db.serverDate(),
    },
  });
}

module.exports = { processAsset, checkImage, submitVideoCheck, verifyFileMetadata, markRejected };
