/**
 * 内容审核任务。
 *
 * ⚠️ 核心规则：审核服务异常或超时时，内容**保持不可公开**。
 * 绝不允许"为了不影响用户体验先发出去"。
 *
 * 首版接微信内容安全接口（msgSecCheck / mediaCheckAsync）。
 * 相关能力是否开通属 G0 核验事项，未开通时 fail-closed 转人工。
 */

const {
  COLLECTIONS,
  POST_STATUS,
  REVIEW_TASK_STATUS,
  ASSET_STATUS,
} = require('../shared/constants');
const db = require('../shared/db');
const usage = require('../shared/usage');
const wechat = require('../shared/wechat-api');

/**
 * 文本安全检查。
 * @returns {{ pass: boolean, suspect: boolean, label?: string }}
 */
async function checkText(content, openid, clubId) {
  if (!clubId) throw new Error('review task club is required');
  if (process.env.REVIEW_PROVIDER === 'manual' || String(openid || '').startsWith('web:')) {
    return { pass: false, suspect: true, label: 'manual-review' };
  }
  if (!content || !content.trim()) return { pass: true, suspect: false };
  // Every character must be reviewed. Long articles cannot silently bypass
  // review after the first 2500 characters. Overlap preserves boundary context.
  const chars = Array.from(content);
  for (let offset = 0; offset < chars.length; offset += 2300) {
    const chunk = chars.slice(offset, offset + 2500).join('');
    let res;
    await usage.reserveReviewCall('text', clubId);
    try {
      res = await wechat.msgSecCheck({ version: 2, openid, scene: 2, content: chunk });
    } catch (err) {
      // Upstream messages may echo content or credentials; retain only the code.
      throw new Error(`msgSecCheck failed: ${err.errCode || err.code || 'unavailable'}`);
    }
    const { label, suggest } = res.result || {};
    if (suggest === 'review') return { pass: false, suspect: true, label };
    if (suggest !== 'pass') return { pass: false, suspect: false, label };
  }
  return { pass: true, suspect: false };
}

async function finishReview(task, expectedVersion, decision, reason = '') {
  const store = db.getDb();
  if (!store || typeof store.rpc !== 'function') throw new Error('review RPC is not configured');
  const result = await store.rpc('hg_finish_review', {
    p_task_id: task._id,
    p_lease_id: task.leaseId,
    p_expected_version: expectedVersion,
    p_decision: decision,
    p_reason: reason,
    p_club_id: task.clubId,
  });

  // hg_finish_review owns the terminal task state.  Keep the local lease
  // snapshot in the same shape so the existing worker conditional update can
  // safely refresh metadata without reopening the task.
  if (result && typeof result.status === 'string') {
    task.status = result.status;
    task.leaseId = '';
    task.claimedAt = null;
    task.leaseExpiresAt = null;
  }
  return result;
}

/** 审核一条内容 */
async function reviewPost(task) {
  const post = await db.findOneById(COLLECTIONS.posts, task.targetId, task.clubId);
  if (!post) return { status: REVIEW_TASK_STATUS.PASSED, note: 'post gone' };
  if (post.clubId !== task.clubId) return { status: REVIEW_TASK_STATUS.MANUAL, note: 'post club mismatch' };

  // 版本已变（作者重新提交）：旧任务作废，不覆盖新版本结果
  if (task.postVersion && post.version !== task.postVersion) {
    return { status: REVIEW_TASK_STATUS.PASSED, note: 'superseded by newer version' };
  }
  if (post.status !== POST_STATUS.PENDING) {
    return { status: REVIEW_TASK_STATUS.PASSED, note: `status already ${post.status}` };
  }

  // 附件未全部 verified 时不推进：封面与正文过了不代表视频过了。
  // The RPC repeats the binding/owner checks; this early read only decides
  // whether the task should wait instead of spending a retry attempt.
  const assetIds = post.assetIds || [];
  let assetRejected = false;
  if (assetIds.length > 0) {
    const assets = await db.findByIds(COLLECTIONS.assets, assetIds, task.clubId);
    const allVerified = assets.length === assetIds.length && assets.every((a) => (
      a.status === ASSET_STATUS.VERIFIED
      && a.clubId === task.clubId
      && a.postId === post._id
      && a.ownerId === post.ownerId
    ));
    const anyRejected = assets.some((a) => (
      a.status === ASSET_STATUS.REJECTED
      || a.clubId !== task.clubId
      || a.postId !== post._id
      || a.ownerId !== post.ownerId
    ));

    assetRejected = anyRejected;
    if (!allVerified && !assetRejected) {
      // 重新排队等待附件处理完成
      return {
        status: REVIEW_TASK_STATUS.QUEUED,
        note: 'waiting for assets',
        waitingReason: 'assets',
      };
    }
    // A rejected or misbound asset is a terminal rejection, but we still run
    // checkText first so every terminal decision follows a completed safety
    // service call.
  }

  const owner = await db.findOneById(COLLECTIONS.users, post.ownerId);
  const openid = owner && owner.wxOpenIdRef;
  const textToCheck = `${post.title || ''}\n${post.body || ''}`.trim();

  let result;
  try {
    result = await checkText(textToCheck, openid, post.clubId);
  } catch (error) {
    const waiting = usage.waitingForQuota(error);
    if (waiting) return waiting;
    throw error;
  }

  if (result.suspect) {
    // 存疑转人工复核，内容仍不公开
    return { status: REVIEW_TASK_STATUS.MANUAL, note: `suspect: ${result.label || 'unknown'}` };
  }

  if (!result.pass) {
    return finishReview(task, post.version || 1, 'reject', '内容未通过安全检查，请修改后重新提交');
  }

  if (assetRejected) return finishReview(task, post.version || 1, 'reject', '附件未通过内容检查');

  // Articles are collaborative publications: complete every automated safety
  // check first, then leave the version pending for an editor. Short posts are
  // published automatically after the same safety checks above.
  if (post.kind === 'article') {
    return { status: REVIEW_TASK_STATUS.MANUAL, note: 'article awaiting editorial approval' };
  }

  return finishReview(task, post.version || 1, 'approve');
}

/** 审核评论 */
async function reviewComment(task) {
  const comment = await db.findOneById(COLLECTIONS.comments, task.targetId, task.clubId);
  if (!comment) return { status: REVIEW_TASK_STATUS.PASSED, note: 'comment gone' };
  if (comment.clubId !== task.clubId) return { status: REVIEW_TASK_STATUS.MANUAL, note: 'comment club mismatch' };
  if (comment.status !== POST_STATUS.PENDING) {
    return { status: REVIEW_TASK_STATUS.PASSED, note: `status already ${comment.status}` };
  }

  const owner = await db.findOneById(COLLECTIONS.users, comment.ownerId);
  let result;
  try {
    result = await checkText(comment.body, owner && owner.wxOpenIdRef, comment.clubId);
  } catch (error) {
    const waiting = usage.waitingForQuota(error);
    if (waiting) return waiting;
    throw error;
  }

  if (result.suspect) return { status: REVIEW_TASK_STATUS.MANUAL, note: 'suspect comment' };

  if (!result.pass) {
    return finishReview(task, comment.version || 1, 'reject', '未通过安全检查');
  }

  return finishReview(task, comment.version || 1, 'approve');
}

/**
 * 文集投稿预检：只确认原文仍然合法可用，
 * 是否收录由人工编辑在管理台决定（安全合格 ≠ 被选中）。
 */
async function precheckCollectionSubmission(task) {
  const post = await db.findOneById(COLLECTIONS.posts, task.targetId, task.clubId);
  if (!post || post.status !== POST_STATUS.PUBLISHED) {
    return { status: REVIEW_TASK_STATUS.FAILED, note: 'post not published' };
  }
  const consent = await db.findOneById(COLLECTIONS.consents, `${task.targetId}:collection:${task.collectionId}`, task.clubId);
  if (!consent || consent.revokedAt) {
    return { status: REVIEW_TASK_STATUS.FAILED, note: 'consent missing or revoked' };
  }
  // 保持 queued 由管理台取走处理
  return { status: REVIEW_TASK_STATUS.QUEUED, note: 'awaiting editor decision' };
}

module.exports = { checkText, reviewPost, reviewComment, precheckCollectionSubmission, finishReview };
