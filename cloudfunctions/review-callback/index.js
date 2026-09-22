/**
 * review-callback 云函数：接收微信内容安全异步检查结果。
 *
 * 配置方式：在小程序管理后台「开发管理 → 消息推送」配置，
 * 或使用云开发的消息推送到云函数能力。
 *
 * ⚠️ 回调处理四条硬规则（docs/10 治理章）：
 * 1. **验签**：确认回调确实来自微信，拒绝伪造请求；
 * 2. **去重**：同一 traceId 可能重复投递，重复处理必须幂等；
 * 3. **超时补偿**：迟到回调若目标已被其他流程处理，不覆盖；
 * 4. **防旧覆盖新**：较旧回调不得覆盖较新版本的结果。
 */

const cloud = require('wx-server-sdk');
const { COLLECTIONS, ASSET_STATUS, REVIEW_TASK_STATUS } = require('./shared/constants');
const db = require('./shared/db');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 校验回调来源。
 * 云开发的消息推送已由平台保证来源可信；若改用 HTTP 网关接入，
 * 必须在此实现签名校验，不能因为"内网"就跳过。
 */
function verifySource(event) {
  // 云函数消息推送场景：event 由平台构造，含 MsgType
  if (event && event.MsgType) return true;
  // HTTP 触发场景：必须带共享密钥
  const secret = process.env.REVIEW_CALLBACK_SECRET;
  if (!secret) return false;
  return event && event.secret === secret;
}

exports.main = async (event = {}) => {
  if (!verifySource(event)) {
    console.warn('[review-callback] rejected: source verification failed');
    return { code: 'forbidden' };
  }

  const traceId = event.trace_id || event.traceId;
  const result = event.result || {};
  const suggest = result.suggest; // pass | review | risky
  const label = result.label;

  if (!traceId) {
    console.warn('[review-callback] missing traceId');
    return { code: 'invalid_input' };
  }

  // 按 traceId 定位附件
  const res = await db
    .coll(COLLECTIONS.assets)
    .where({ traceId })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));

  const asset = res.data && res.data[0];
  if (!asset) {
    // 迟到回调且目标已清理：静默确认，不报错
    console.log('[review-callback] asset not found, ignoring', { traceId });
    return { code: 0, note: 'asset gone' };
  }

  // 去重：已是终态则不再处理（幂等）
  if (asset.status === ASSET_STATUS.VERIFIED || asset.status === ASSET_STATUS.REJECTED) {
    console.log('[review-callback] duplicate callback ignored', { traceId, status: asset.status });
    return { code: 0, note: 'already final' };
  }

  // 防旧覆盖新：回调时间早于附件最后一次提交则丢弃
  const callbackAt = Number(event.event_time || event.eventTime || 0) * 1000;
  const submittedAt = asset.submittedAt ? new Date(asset.submittedAt).getTime() : 0;
  if (callbackAt && submittedAt && callbackAt < submittedAt) {
    console.log('[review-callback] stale callback ignored', { traceId });
    return { code: 0, note: 'stale' };
  }

  if (suggest === 'pass') {
    // 通过后才生成可访问链接
    const urlRes = await cloud.getTempFileURL({ fileList: [asset.fileId] }).catch(() => null);
    const tempFileURL = urlRes && urlRes.fileList && urlRes.fileList[0] ? urlRes.fileList[0].tempFileURL : '';

    await db.coll(COLLECTIONS.assets).doc(asset._id).update({
      data: {
        status: ASSET_STATUS.VERIFIED,
        tempFileURL,
        verifiedAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });

    // 唤醒等待该附件的内容审核任务
    await db
      .coll(COLLECTIONS.reviewTasks)
      .where({ targetType: 'post', targetId: asset.postId, status: REVIEW_TASK_STATUS.QUEUED })
      .update({ data: { updatedAt: db.serverDate() } })
      .catch(() => {});

    return { code: 0, note: 'verified' };
  }

  if (suggest === 'review') {
    // 存疑转人工，内容保持不可展示
    await db.coll(COLLECTIONS.assets).doc(asset._id).update({
      data: { status: ASSET_STATUS.VERIFYING, needsManualReview: true, label, updatedAt: db.serverDate() },
    });
    return { code: 0, note: 'manual review required' };
  }

  await db.coll(COLLECTIONS.assets).doc(asset._id).update({
    data: {
      status: ASSET_STATUS.REJECTED,
      failureReason: '未通过内容检查',
      label,
      tempFileURL: '',
      updatedAt: db.serverDate(),
    },
  });

  return { code: 0, note: 'rejected' };
};
