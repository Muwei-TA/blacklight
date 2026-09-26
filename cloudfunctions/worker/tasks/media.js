/**
 * 媒体处理任务。
 *
 * 视频不是"图片审核加一个播放按钮"：
 * 建议链路 = 校验格式/大小/时长 → 生成封面 → 画面与音频内容检查 →
 *            必要人工复核 → 全部必需任务完成后才允许展示。
 *
 * 当前落地范围：
 * - 图片：只处理 API 清洗后的 JPEG，重新验证真实字节与像素，再同步
 *   imgSecCheck；服务错误保持可重试，不会放行。
 * - 视频：能力关闭。历史视频任务也不会进入检查或展示链路。
 */

const {
  COLLECTIONS,
  ASSET_STATUS,
  REVIEW_TASK_STATUS,
  CONTENT_LIMITS,
  DEFAULT_CLUB_ID,
} = require('../shared/constants');
const db = require('../shared/db');
const usage = require('../shared/usage');
const wechat = require('../shared/wechat-api');
const {
  ImageProcessingError,
  JPEG_MIME,
  MAX_DECODED_BYTES,
  inspectImageBuffer,
} = require('../shared/image-processing');

/** 服务端复核真实文件属性：客户端声明的 size/duration 不可信 */
async function verifyFileMetadata(asset) {
  if (!asset.fileId) throw new Error('asset has no bound file');
  const res = await db.getStorage().getTempFileURL({ fileList: [asset.fileId] });
  const file = res.fileList && res.fileList[0];
  if (!file || file.status !== 0) throw new Error('getTempFileURL failed');

  // 通过 downloadFile 读取真实字节数
  const downloaded = await db.getStorage().downloadFile({ fileID: asset.fileId });
  const actualSize = downloaded.fileContent ? downloaded.fileContent.length : 0;

  const limit = asset.mediaType === 'video' ? CONTENT_LIMITS.videoSize : MAX_DECODED_BYTES;
  if (actualSize > limit) {
    throw Object.assign(new Error('file exceeds size limit'), { fatal: true, code: 'size_limit' });
  }

  if (!downloaded.fileContent || !Buffer.isBuffer(downloaded.fileContent)) {
    throw Object.assign(new Error('downloaded file has no content'), { fatal: true });
  }

  let imageInfo;
  try {
    imageInfo = inspectImageBuffer(downloaded.fileContent);
  } catch (err) {
    if (err instanceof ImageProcessingError) {
      throw Object.assign(new Error(err.message), { fatal: true, code: err.code });
    }
    throw err;
  }
  if (asset.mediaType !== 'image' || imageInfo.mimeType !== JPEG_MIME || imageInfo.hasExif) {
    throw Object.assign(new Error('stored image is not a cleaned JPEG'), { fatal: true });
  }

  return {
    tempFileURL: file.tempFileURL,
    actualSize,
    buffer: downloaded.fileContent,
    width: imageInfo.width,
    height: imageInfo.height,
    mimeType: imageInfo.mimeType,
  };
}

/** 图片内容检查：同步返回，可直接闭环 */
async function checkImage(buffer, clubId = DEFAULT_CLUB_ID) {
  await usage.reserveReviewCall('image', clubId);
  try {
    await wechat.imgSecCheck({
      media: { contentType: JPEG_MIME, value: buffer },
    });
    return { pass: true };
  } catch (err) {
    // 87014 = 内容含违规信息
    if (Number(err.errCode) === 87014) return { pass: false, label: 'risky' };
    throw new Error(`imgSecCheck failed: ${err.errCode || ''}`);
  }
}

async function processAsset(task) {
  const asset = await db.findOneById(COLLECTIONS.assets, task.targetId);
  if (!asset) return { status: REVIEW_TASK_STATUS.PASSED, note: 'asset gone' };
  if (asset.status === ASSET_STATUS.VERIFIED || asset.status === ASSET_STATUS.REJECTED) {
    return { status: REVIEW_TASK_STATUS.PASSED, note: `already ${asset.status}` };
  }
  if (['revoked', 'purged'].includes(asset.status) || asset.cleanupState === 'running') {
    return { status: REVIEW_TASK_STATUS.PASSED, note: 'asset unavailable' };
  }
  if (asset.mediaType !== 'image') {
    await markRejected(asset, '视频上传能力已关闭');
    return { status: REVIEW_TASK_STATUS.FAILED, note: 'video disabled' };
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
  if (asset.status !== ASSET_STATUS.UPLOADED) {
    return { status: REVIEW_TASK_STATUS.QUEUED, note: `waiting upload, now ${asset.status}` };
  }

  let meta;
  try {
    meta = await verifyFileMetadata(asset);
  } catch (err) {
    if (err.fatal) {
      await markRejected(asset, err.code === 'size_limit' ? '文件超出大小限制' : '图片文件校验失败');
      return { status: REVIEW_TASK_STATUS.FAILED, note: err.message };
    }
    throw err;
  }

  if (asset.mediaType === 'image') {
    let result;
    try {
      result = await checkImage(meta.buffer, asset.clubId || DEFAULT_CLUB_ID);
    } catch (error) {
      const waiting = usage.waitingForQuota(error);
      if (waiting) return waiting;
      throw error;
    }
    if (!result.pass) {
      await markRejected(asset, '图片未通过内容检查');
      return { status: REVIEW_TASK_STATUS.FAILED, note: 'image blocked' };
    }

    await db.coll(COLLECTIONS.assets).where({ _id: asset._id, status: asset.status, fileId: asset.fileId }).update({
      data: {
        status: ASSET_STATUS.VERIFIED,
        tempFileURL: '',
        actualSize: meta.actualSize,
        width: meta.width,
        height: meta.height,
        mimeType: JPEG_MIME,
        verifiedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
    return { status: REVIEW_TASK_STATUS.PASSED };
  }

  // The media type guard above makes this unreachable. Keep a fail-closed
  // branch for malformed historical records and future callers.
  throw new Error('unsupported media type');
}

async function markRejected(asset, reason) {
  await db.coll(COLLECTIONS.assets).where({ _id: asset._id, status: asset.status, fileId: asset.fileId }).update({
    data: {
      status: ASSET_STATUS.REJECTED,
      failureReason: reason,
      tempFileURL: '',
      updatedAt: db.serverDate(),
    },
  });
}

module.exports = { processAsset, checkImage, verifyFileMetadata, markRejected };
