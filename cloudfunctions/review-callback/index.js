/**
 * review-callback 云函数：接收微信内容安全异步检查结果。
 *
 * 认证边界：MsgType、trace_id、event_time 等都是请求数据，不能证明
 * 来源。来源必须同时满足 wx-server-sdk 的 SOURCE 上下文和部署侧的
 * 回调密钥；CloudBase 函数调用权限仍需在控制台限制为平台/服务端来源。
 * 当前仓库没有真实消息推送验收，实际 SOURCE 值与平台签名格式需部署后
 * 用开发环境验证，不能由单测或普通 event 字段代替。
 */

const crypto = require('node:crypto');
const cloud = require('wx-server-sdk');
const { COLLECTIONS, ASSET_STATUS, REVIEW_TASK_STATUS } = require('./shared/constants');
const db = require('./shared/db');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const ALLOWED_HTTP_SOURCES = new Set(['wx_http', 'wx_trigger', 'wx_cloud_call']);

function constantTimeEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function parseBody(event) {
  if (!event || typeof event.body !== 'string') return {};
  try {
    const parsed = JSON.parse(event.body);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function getHeaders(event) {
  const headers = event && event.headers;
  if (!headers || typeof headers !== 'object') return {};
  return Object.keys(headers).reduce((result, key) => {
    result[key.toLowerCase()] = headers[key];
    return result;
  }, {});
}

function extractSecret(event) {
  const headers = getHeaders(event);
  const authorization = typeof headers.authorization === 'string'
    ? headers.authorization.replace(/^Bearer\s+/i, '')
    : '';
  return String(
    (event && (event.secret || event.callbackSecret || event.callback_secret))
      || headers['x-review-callback-secret']
      || headers['x-review-secret']
      || authorization
      || '',
  );
}

function readWXContext() {
  try {
    return (typeof cloud.getWXContext === 'function' && cloud.getWXContext()) || {};
  } catch (err) {
    return { sourceError: err.message || 'getWXContext failed' };
  }
}

/**
 * Verify the invocation channel. Ordinary event fields, including MsgType,
 * are deliberately ignored for authentication.
 */
function verifySource(event = {}) {
  const wxContext = readWXContext();
  const source = wxContext.SOURCE || '';
  const secret = process.env.REVIEW_CALLBACK_SECRET || '';
  const provided = extractSecret(event);
  const sourceAllowed = ALLOWED_HTTP_SOURCES.has(source);
  const secretValid = !!secret && constantTimeEqual(provided, secret);

  return {
    ok: sourceAllowed && secretValid,
    source,
    hasOpenId: !!wxContext.OPENID,
    sourceAllowed,
    secretValid,
    sourceError: wxContext.sourceError || '',
  };
}

function parsePayload(event = {}) {
  const body = parseBody(event);
  // Explicit top-level fields win for the SDK event shape; body supports an
  // HTTP gateway that forwards the verified request payload.
  return { ...body, ...event, result: event.result || body.result || {} };
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function readTraceId(payload) {
  const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
  return firstPresent(payload.trace_id, payload.traceId, result.trace_id, result.traceId) || '';
}

function readAssetId(payload) {
  const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
  return firstPresent(
    payload.assetId,
    payload.asset_id,
    payload.mediaId,
    payload.media_id,
    result.assetId,
    result.asset_id,
  ) || '';
}

function readReviewVersion(payload) {
  const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
  const value = firstPresent(
    payload.reviewVersion,
    payload.review_version,
    payload.postVersion,
    payload.post_version,
    result.reviewVersion,
    result.review_version,
    result.postVersion,
    result.post_version,
    // Some gateways normalize the binding version to `version`; it is only
    // considered when the field is explicitly supplied by that gateway.
    payload.version,
    result.version,
  );
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function assetBindingMatches(payload, asset) {
  const callbackTraceId = readTraceId(payload);
  if (callbackTraceId && callbackTraceId !== asset.traceId) return false;

  const callbackAssetId = readAssetId(payload);
  if (callbackAssetId && callbackAssetId !== asset._id) return false;

  const callbackVersion = readReviewVersion(payload);
  if (callbackVersion === null) {
    // A malformed explicit version is not allowed to fall through as if the
    // callback had no version. Missing version remains compatible with the
    // current WeChat response shape; deployment tests must confirm whether
    // the selected channel can carry it.
    const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
    const versionWasSupplied = [
      payload.reviewVersion,
      payload.review_version,
      payload.postVersion,
      payload.post_version,
      result.reviewVersion,
      result.review_version,
      result.postVersion,
      result.post_version,
      payload.version,
      result.version,
    ].some((value) => value !== undefined && value !== null && value !== '');
    if (versionWasSupplied) return false;
  } else {
    const expectedVersion = Number(asset.reviewVersion !== undefined ? asset.reviewVersion : (asset.postVersion || 0));
    if (callbackVersion !== expectedVersion) return false;
  }

  return true;
}

function callbackAtMillis(payload) {
  const value = firstPresent(payload.event_time, payload.eventTime);
  if (value === undefined || value === null || value === '') return 0;
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  // WeChat callback timestamps are seconds; accepting ms makes gateway
  // adapters explicit without changing the comparison semantics.
  return number < 1e12 ? number * 1000 : number;
}

function submittedAtMillis(asset) {
  if (!asset || !asset.submittedAt) return 0;
  const result = new Date(asset.submittedAt).getTime();
  return Number.isFinite(result) ? result : 0;
}

function assetCondition(asset) {
  const condition = {
    _id: asset._id,
    clubId: asset.clubId,
    status: ASSET_STATUS.VERIFYING,
    traceId: asset.traceId,
  };
  if (asset.postVersion !== undefined) condition.postVersion = asset.postVersion;
  if (asset.reviewVersion !== undefined) condition.reviewVersion = asset.reviewVersion;
  return condition;
}

async function updateAssetConditionally(asset, data) {
  const result = await db
    .coll(COLLECTIONS.assets, asset.clubId)
    .where(assetCondition(asset))
    .update({ data });
  return !!(result.stats && result.stats.updated === 1);
}

async function wakePostReview(asset) {
  if (!asset.postId) return;
  const condition = {
    clubId: asset.clubId,
    targetType: 'post',
    targetId: asset.postId,
    status: REVIEW_TASK_STATUS.QUEUED,
  };
  if (asset.postVersion !== undefined) condition.postVersion = asset.postVersion;
  await db
    .coll(COLLECTIONS.reviewTasks, asset.clubId)
    .where(condition)
    .update({ data: { nextAttemptAt: new Date(), waitingReason: '' } });
}

exports.main = async (event = {}) => {
  const source = verifySource(event);
  if (!source.ok) {
    console.warn('[review-callback] rejected invocation source', {
      source: source.source,
      sourceAllowed: source.sourceAllowed,
      secretValid: source.secretValid,
      hasOpenId: source.hasOpenId,
      sourceError: source.sourceError,
      // MsgType is intentionally not read as an authentication signal.
      cloudPermissionVerified: false,
    });
    return { code: 'forbidden' };
  }
  console.log('[review-callback] invocation source accepted', {
    source: source.source,
    cloudPermissionVerified: false,
  });

  const payload = parsePayload(event);
  const traceId = readTraceId(payload);
  const result = payload.result && typeof payload.result === 'object' ? payload.result : {};
  const suggest = result.suggest;
  const label = result.label || '';

  if (!traceId) {
    console.warn('[review-callback] missing traceId');
    return { code: 'invalid_input' };
  }

  // traceId is the primary binding. An optional asset ID is checked too when
  // a gateway provides it, so a valid trace cannot be paired with another
  // asset through a forged body field.
  const lookup = { traceId };
  const callbackAssetId = readAssetId(payload);
  if (callbackAssetId) lookup._id = callbackAssetId;
  const clubs = await db.getDb().rpc('hg_all_club_ids', {});
  let asset = null;
  for (const club of (clubs && clubs.items) || []) {
    const res = await db.coll(COLLECTIONS.assets, club.clubId)
      .where({ ...lookup, clubId: club.clubId })
      .limit(1)
      .get();
    asset = res.data && res.data[0];
    if (asset) break;
  }
  if (!asset) {
    // 迟到回调且目标已清理：静默确认，不报错
    console.log('[review-callback] asset not found, ignoring', { traceId });
    return { code: 0, note: 'asset gone' };
  }

  // 终态去重；条件更新 below also protects a simultaneous pass/reject race.
  if (asset.status === ASSET_STATUS.VERIFIED || asset.status === ASSET_STATUS.REJECTED) {
    console.log('[review-callback] duplicate callback ignored', { traceId, status: asset.status });
    return { code: 0, note: 'already final' };
  }
  if (asset.status !== ASSET_STATUS.VERIFYING) {
    return { code: 0, note: 'asset not awaiting callback' };
  }

  if (!assetBindingMatches(payload, asset)) {
    console.warn('[review-callback] asset/version binding mismatch', { traceId });
    return { code: 0, note: 'stale binding' };
  }

  const callbackAt = callbackAtMillis(payload);
  const submittedAt = submittedAtMillis(asset);
  if (callbackAt && submittedAt && callbackAt < submittedAt) {
    console.log('[review-callback] stale callback ignored', { traceId });
    return { code: 0, note: 'stale' };
  }

  if (asset.needsManualReview && suggest === 'pass') {
    // A later automatic pass must not bypass an already requested human review.
    return { code: 0, note: 'manual review required' };
  }

  if (suggest === 'pass') {
    // Through a private bucket, generate a fresh URL only for the currently
    // bound trace/version. Failure to obtain it leaves the asset verifying so
    // the provider can retry; it is never marked verified with an empty URL.
    const urlRes = await cloud.getTempFileURL({ fileList: [asset.fileId] });
    const item = urlRes && urlRes.fileList && urlRes.fileList[0];
    if (!item || Number(item.status) !== 0 || !item.tempFileURL) {
      throw new Error('getTempFileURL failed for verified asset');
    }

    const updated = await updateAssetConditionally(asset, {
      status: ASSET_STATUS.VERIFIED,
      tempFileURL: item.tempFileURL,
      verifiedAt: db.serverDate(),
      updatedAt: db.serverDate(),
      cleanupState: '',
      cleanupLastError: '',
    });
    if (!updated) return { code: 0, note: 'conflict' };

    await wakePostReview(asset);
    return { code: 0, note: 'verified' };
  }

  if (suggest === 'review') {
    const updated = await updateAssetConditionally(asset, {
      status: ASSET_STATUS.VERIFYING,
      needsManualReview: true,
      label,
      updatedAt: db.serverDate(),
    });
    if (!updated) return { code: 0, note: 'conflict' };
    return { code: 0, note: 'manual review required' };
  }

  // Unknown/missing suggestions fail closed. The same trace/version condition
  // prevents an old risky result from replacing a newer callback.
  const updated = await updateAssetConditionally(asset, {
    status: ASSET_STATUS.REJECTED,
    failureReason: '未通过内容检查',
    label,
    tempFileURL: '',
    updatedAt: db.serverDate(),
  });
  if (!updated) return { code: 0, note: 'conflict' };

  await wakePostReview(asset);
  return { code: 0, note: 'rejected' };
};

exports._internals = {
  constantTimeEqual,
  extractSecret,
  verifySource,
  parsePayload,
  readTraceId,
  readAssetId,
  readReviewVersion,
  assetBindingMatches,
  callbackAtMillis,
  submittedAtMillis,
  assetCondition,
};
