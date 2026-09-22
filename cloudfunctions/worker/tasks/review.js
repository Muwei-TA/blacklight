/**
 * 内容审核任务。
 *
 * ⚠️ 核心规则：审核服务异常或超时时，内容**保持不可公开**。
 * 绝不允许"为了不影响用户体验先发出去"。
 *
 * 首版接微信内容安全接口（msgSecCheck / mediaCheckAsync）。
 * 相关能力是否开通属 G0 核验事项，未开通时 fail-closed 转人工。
 */

const cloud = require('wx-server-sdk');
const {
  COLLECTIONS,
  POST_STATUS,
  REVIEW_TASK_STATUS,
  ASSET_STATUS,
  NOTIFY_TYPE,
} = require('../shared/constants');
const db = require('../shared/db');

/**
 * 文本安全检查。
 * @returns {{ pass: boolean, suspect: boolean, label?: string }}
 */
async function checkText(content, openid) {
  if (!content || !content.trim()) return { pass: true, suspect: false };
  // Every character must be reviewed. Long articles cannot silently bypass
  // review after the first 2500 characters. Overlap preserves boundary context.
  const chars = Array.from(content);
  for (let offset = 0; offset < chars.length; offset += 2300) {
    const chunk = chars.slice(offset, offset + 2500).join('');
    let res;
    try {
      res = await cloud.openapi.security.msgSecCheck({ version: 2, openid, scene: 2, content: chunk });
    } catch (err) {
      throw new Error(`msgSecCheck failed: ${err.errCode || 'unavailable'}`);
    }
    const { label, suggest } = res.result || {};
    if (suggest === 'review') return { pass: false, suspect: true, label };
    if (suggest !== 'pass') return { pass: false, suspect: false, label };
  }
  return { pass: true, suspect: false };
}

/** 审核一条内容 */
async function reviewPost(task) {
  const post = await db.findOneById(COLLECTIONS.posts, task.targetId);
  if (!post) return { status: REVIEW_TASK_STATUS.PASSED, note: 'post gone' };

  // 版本已变（作者重新提交）：旧任务作废，不覆盖新版本结果
  if (task.postVersion && post.version !== task.postVersion) {
    return { status: REVIEW_TASK_STATUS.PASSED, note: 'superseded by newer version' };
  }
  if (post.status !== POST_STATUS.PENDING) {
    return { status: REVIEW_TASK_STATUS.PASSED, note: `status already ${post.status}` };
  }

  // 附件未全部 verified 时不推进：封面与正文过了不代表视频过了
  if (task.needsMedia) {
    const assets = await db.findByIds(COLLECTIONS.assets, post.assetIds || []);
    const allVerified = assets.length === (post.assetIds || []).length && assets.every((a) => a.status === ASSET_STATUS.VERIFIED);
    const anyRejected = assets.some((a) => a.status === ASSET_STATUS.REJECTED);

    if (anyRejected) {
      await rejectPost(post, '附件未通过内容检查');
      return { status: REVIEW_TASK_STATUS.FAILED, note: 'asset rejected' };
    }
    if (!allVerified) {
      // 重新排队等待附件处理完成
      return {
        status: REVIEW_TASK_STATUS.QUEUED,
        note: 'waiting for assets',
        waitingReason: 'assets',
      };
    }
  }

  const owner = await db.findOneById(COLLECTIONS.users, post.ownerId);
  const openid = owner && owner.wxOpenIdRef;
  const textToCheck = `${post.title || ''}\n${post.body || ''}`.trim();

  const result = await checkText(textToCheck, openid);

  if (result.suspect) {
    // 存疑转人工复核，内容仍不公开
    return { status: REVIEW_TASK_STATUS.MANUAL, note: `suspect: ${result.label || 'unknown'}` };
  }

  if (!result.pass) {
    await rejectPost(post, '内容未通过安全检查，请修改后重新提交');
    return { status: REVIEW_TASK_STATUS.FAILED, note: `blocked: ${result.label || 'unknown'}` };
  }

  await approvePost(post);
  return { status: REVIEW_TASK_STATUS.PASSED };
}

async function approvePost(post) {
  await db.updateWithVersion(COLLECTIONS.posts, post._id, post.version || 1, {
    status: POST_STATUS.PUBLISHED,
    reviewedAt: db.serverDate(),
    reviewedBy: 'system',
  });

  if (post.topicId) await db.incCounter(COLLECTIONS.topics, post.topicId, 'postCount', 1);

  await db.coll(COLLECTIONS.notifications).add({
    data: {
      recipientId: post.ownerId,
      eventType: NOTIFY_TYPE.SYSTEM_REVIEW,
      title: '你的内容已通过审核',
      summary: '现在会在你设定的范围内展示。',
      targetType: 'post',
      targetId: post._id,
      icon: 'check-circle',
      createdAt: db.serverDate(),
    },
  });
}

async function rejectPost(post, reason) {
  await db.updateWithVersion(COLLECTIONS.posts, post._id, post.version || 1, {
    status: POST_STATUS.REJECTED,
    rejectReason: reason,
    reviewedAt: db.serverDate(),
    reviewedBy: 'system',
  });

  await db.coll(COLLECTIONS.notifications).add({
    data: {
      recipientId: post.ownerId,
      eventType: NOTIFY_TYPE.SYSTEM_REVIEW,
      title: '一条内容需要修改',
      // 保留原记录，作者取消编辑不会丢失内容
      summary: `${reason}。原文已保留，可以修改后重新提交。`,
      targetType: 'post',
      targetId: post._id,
      icon: 'error-circle',
      createdAt: db.serverDate(),
    },
  });
}

/** 审核评论 */
async function reviewComment(task) {
  const comment = await db.findOneById(COLLECTIONS.comments, task.targetId);
  if (!comment) return { status: REVIEW_TASK_STATUS.PASSED, note: 'comment gone' };
  if (comment.status !== POST_STATUS.PENDING) {
    return { status: REVIEW_TASK_STATUS.PASSED, note: `status already ${comment.status}` };
  }

  const owner = await db.findOneById(COLLECTIONS.users, comment.ownerId);
  const result = await checkText(comment.body, owner && owner.wxOpenIdRef);

  if (result.suspect) return { status: REVIEW_TASK_STATUS.MANUAL, note: 'suspect comment' };

  if (!result.pass) {
    await db.coll(COLLECTIONS.comments).doc(comment._id).update({
      data: { status: POST_STATUS.REJECTED, rejectReason: '未通过安全检查', updatedAt: db.serverDate() },
    });
    return { status: REVIEW_TASK_STATUS.FAILED };
  }

  await db.coll(COLLECTIONS.comments).doc(comment._id).update({
    data: { status: POST_STATUS.PUBLISHED, updatedAt: db.serverDate() },
  });
  await db.incCounter(COLLECTIONS.posts, comment.postId, 'commentCount', 1);

  // 通知被回应者：文案中性，不含正文原文
  const post = await db.findOneById(COLLECTIONS.posts, comment.postId);
  if (post && post.ownerId !== comment.ownerId) {
    await db.coll(COLLECTIONS.notifications).add({
      data: {
        recipientId: post.ownerId,
        eventType: comment.replyToId ? NOTIFY_TYPE.REPLY : NOTIFY_TYPE.COMMENT,
        title: '有人回应了你的内容',
        summary: '',
        targetType: 'post',
        targetId: comment.postId,
        icon: 'chat-bubble-1',
        createdAt: db.serverDate(),
      },
    });
  }

  return { status: REVIEW_TASK_STATUS.PASSED };
}

/**
 * 文集投稿预检：只确认原文仍然合法可用，
 * 是否收录由人工编辑在管理台决定（安全合格 ≠ 被选中）。
 */
async function precheckCollectionSubmission(task) {
  const post = await db.findOneById(COLLECTIONS.posts, task.targetId);
  if (!post || post.status !== POST_STATUS.PUBLISHED) {
    return { status: REVIEW_TASK_STATUS.FAILED, note: 'post not published' };
  }
  const consent = await db.findOneById(COLLECTIONS.consents, `${task.targetId}:collection:${task.collectionId}`);
  if (!consent || consent.revokedAt) {
    return { status: REVIEW_TASK_STATUS.FAILED, note: 'consent missing or revoked' };
  }
  // 保持 queued 由管理台取走处理
  return { status: REVIEW_TASK_STATUS.QUEUED, note: 'awaiting editor decision' };
}

module.exports = { checkText, reviewPost, reviewComment, precheckCollectionSubmission, approvePost, rejectPost };
