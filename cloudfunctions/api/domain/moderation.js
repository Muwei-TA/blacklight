/**
 * 管理台用例（五队列）。
 *
 * 关键约束：
 * 1. 每个 handler 第一行都必须调 policies.canAccessModeration —— 前端隐藏入口不是保护；
 * 2. 退回/隐藏必须带理由，且写审计日志；
 * 3. **不能用审核按钮更改作者的可见范围**；
 * 4. 普通管理员读不到私密手记与匿名映射；
 * 5. 举报记录返回给管理员时也不含 reporterId。
 */

const {
  COLLECTIONS,
  POST_STATUS,
  TOPIC_STATUS,
  MEMBER_STATUS,
  VISIBILITY,
  DEFAULT_CLUB_ID,
} = require('../shared/constants');
const policies = require('../shared/policies');
const validators = require('../shared/validators');
const presenters = require('../shared/presenters');
const errors = require('../shared/errors');
const db = require('../shared/db');

const QUEUES = ['comment', 'content', 'topic', 'member', 'report', 'collection'];

function requiredExpectedVersion(payload) {
  const version = Number(payload.expectedVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw errors.invalidInput('缺少版本号', { field: 'expectedVersion' });
  }
  return version;
}

function mapModerationError(error) {
  const marker = `${error && error.code ? error.code : ''} ${error && error.message ? error.message : ''}`;
  if (/PENDING_MEDIA/.test(marker)) return errors.pendingMedia();
  if (/VERSION_CONFLICT|IDEMPOTENCY_CONFLICT|ALREADY_DECIDED|MEMBERSHIP_EXISTS|CONFLICT/.test(marker)) {
    return errors.conflict('条目已被更新，请刷新后重试', { field: 'expectedVersion' });
  }
  if (/PRIVATE_CONTENT|CAPABILITY_DISABLED|FORBIDDEN|NOT_ALLOWED/.test(marker)) {
    return errors.forbidden();
  }
  if (/NOT_FOUND|POST_NOT_FOUND|COMMENT_NOT_FOUND|TOPIC_NOT_FOUND|REPORT_NOT_FOUND|APPLICATION_NOT_FOUND|TASK_NOT_FOUND/.test(marker)) {
    return errors.notAccessible();
  }
  if (/INVALID|REASON_REQUIRED/.test(marker)) {
    return errors.invalidInput('请求参数不合法');
  }
  return error;
}

async function callModeration(action, input, ctx) {
  try {
    const store = db.getDb();
    if (!store || typeof store.rpc !== 'function') throw new Error('moderation RPC is not configured');
    return await store.rpc('hg_moderate', {
      p_action: action,
      p_actor_id: ctx.viewer.userId,
      p_input: input,
    });
  } catch (error) {
    const mapped = mapModerationError(error);
    if (mapped !== error) throw mapped;
    throw error;
  }
}

/** GET /admin/queues/{queue} */
async function listQueue(payload, ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });

  const queue = validators.requireEnum(payload.queue || 'content', 'queue', QUEUES);
  const cursor = validators.parseCursor(payload.cursor);
  const pageSize = validators.clampPageSize(payload.pageSize);
  const _ = db.command();

  if (queue === 'content') {
    const { items, hasMore } = await db.paginate(
      COLLECTIONS.posts,
      {
        clubId: DEFAULT_CLUB_ID,
        status: POST_STATUS.PENDING,
        // 私密内容不进审核队列：它不对外展示，管理员默认无权读
        visibility: _.in([VISIBILITY.PUBLIC, VISIBILITY.CLUB]),
      },
      { cursor, pageSize, order: 'asc' },
    );

    return {
      items: items.map((post) => ({
        id: post._id,
        queue,
        title: post.title || '（无标题碎片）',
        summary: presenters.excerpt(post.body, 100),
        // 审核需要看到媒体，因此返回附件 ID 供审片接口取用
        assetIds: post.assetIds || [],
        visibility: post.visibility,
        // 不返回 ownerId，避免匿名帖在管理台暴露作者
        isAnonymous: post.identityMode === 'anonymous',
        version: post.version || 1,
        submittedAtText: presenters.formatRelativeTime(post.createdAt, ctx.now),
        statusText: '等待审核',
      })),
      nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
    };
  }

  if (queue === 'comment') {
    const rows = await db.getDb().rpc('hg_comment_queue', { p_actor: ctx.viewer.userId, p_cursor: cursor || null, p_limit: pageSize + 1 });
    const items = rows.slice(0, pageSize);
    return { items: items.map((comment) => ({
      id: comment._id, queue, title: '回应', summary: comment.body || '',
      postId: comment.postId, version: comment.version || 1,
      isAnonymous: comment.identityMode === 'anonymous',
      submittedAtText: presenters.formatRelativeTime(comment.createdAt, ctx.now), statusText: '等待审核',
    })), nextCursor: rows.length > pageSize ? validators.buildCursor(items[items.length-1]) : null };
  }

  if (queue === 'topic') {
    const { items, hasMore } = await db.paginate(
      COLLECTIONS.topics,
      { clubId: DEFAULT_CLUB_ID, status: TOPIC_STATUS.PENDING },
      { cursor, pageSize, order: 'asc' },
    );
    return {
      items: items.map((topic) => ({
        id: topic._id,
        queue,
        title: topic.title,
        summary: topic.description || '',
        version: topic.version || 1,
        submittedAtText: presenters.formatRelativeTime(topic.createdAt, ctx.now),
        statusText: '等待确认',
      })),
      nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
    };
  }

  if (queue === 'member') {
    const { items, hasMore } = await db.paginate(
      COLLECTIONS.membershipApplications,
      { clubId: DEFAULT_CLUB_ID, status: MEMBER_STATUS.PENDING },
      { cursor, pageSize, order: 'asc' },
    );
    return {
      items: items.map((app) => ({
        id: app._id,
        queue,
        title: app.displayName,
        summary: `邀请码 ${app.inviteCode} · 已阅读规则 ${app.rulesVersion}`,
        version: app.version || 1,
        submittedAtText: presenters.formatRelativeTime(app.createdAt, ctx.now),
        statusText: '等待批准',
      })),
      nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
    };
  }

  if (queue === 'report') {
    const { items, hasMore } = await db.paginate(
      COLLECTIONS.reports,
      { status: 'received' },
      { cursor, pageSize, order: 'asc' },
    );
    return {
      items: items.map((report) => ({
        id: report._id,
        queue,
        title: `${report.targetType === 'post' ? '内容' : '评论'}被举报`,
        summary: report.reason,
        targetType: report.targetType,
        targetId: report.targetId,
        version: report.version || 1,
        // 绝不返回 reporterId
        submittedAtText: presenters.formatRelativeTime(report.createdAt, ctx.now),
        statusText: '待核查',
      })),
      nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
    };
  }

  // collection：文集收录申请
  const { items, hasMore } = await db.paginate(
    COLLECTIONS.reviewTasks,
    { targetType: 'collection_submission', status: 'queued' },
    { cursor, pageSize, order: 'asc' },
  );
  // Only join posts that are eligible for an editor queue.  In particular a
  // malformed/legacy collection task must not turn a private note into an
  // admin-readable title or excerpt.
  const visiblePostIds = items.map((task) => task.targetId).filter(Boolean);
  const postsRes = visiblePostIds.length
    ? await db
      .coll(COLLECTIONS.posts)
      .where({
        _id: _.in(visiblePostIds),
        visibility: _.in([VISIBILITY.PUBLIC, VISIBILITY.CLUB]),
      })
      .limit(visiblePostIds.length)
      .get()
    : { data: [] };
  const posts = postsRes.data || [];
  const postById = new Map(posts.map((p) => [p._id, p]));

  return {
    items: items.map((task) => {
      const post = postById.get(task.targetId);
      if (!post) return null;
      return {
        id: task._id,
        queue,
        title: (post && post.title) || '（文章已不可访问）',
        summary: post ? presenters.excerpt(post.body, 100) : '',
        postId: task.targetId,
        collectionId: task.collectionId,
        version: task.version || 1,
        submittedAtText: presenters.formatRelativeTime(task.createdAt, ctx.now),
        statusText: '等待收录决定',
      };
    }).filter(Boolean),
    nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
  };
}

/**
 * POST /admin/reviews/{id}/decision —— 内容审核决定。
 * approve → published；reject → rejected（带理由）；hide → hidden。
 * 注意：任何分支都不修改 visibility。
 */
async function decideContent(payload, ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });

  const id = validators.requireId(payload.id, 'id');
  const decision = validators.requireEnum(payload.decision, 'decision', ['approve', 'reject', 'hide']);
  const expectedVersion = requiredExpectedVersion(payload);

  // 退回与隐藏必须有理由
  const reason =
    decision === 'approve'
      ? validators.requireString(payload.reason, '备注', { max: 200, allowEmpty: true })
      : validators.requireString(payload.reason, '处理理由', { max: 200 });
  return callModeration('content.decide', { id, decision, reason, expectedVersion }, ctx);
}

/** POST /admin/topics/{id}/decision */
async function decideTopic(payload, ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });

  const id = validators.requireId(payload.id, 'id');
  const decision = validators.requireEnum(payload.decision, 'decision', ['approve', 'archive', 'reject']);
  const expectedVersion = requiredExpectedVersion(payload);
  const reason =
    decision === 'approve'
      ? ''
      : validators.requireString(payload.reason, '处理理由', { max: 200 });
  return callModeration('topic.decide', { id, decision, reason, expectedVersion }, ctx);
}

/** POST /admin/members/applications/{id} */
async function decideMembership(payload, ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });

  const id = validators.requireId(payload.id, 'id');
  const decision = validators.requireEnum(payload.decision, 'decision', ['approve', 'reject']);
  const expectedVersion = requiredExpectedVersion(payload);
  const reason =
    decision === 'approve' ? '' : validators.requireString(payload.reason, '拒绝理由', { max: 200 });
  return callModeration('membership.decide', { id, decision, reason, expectedVersion }, ctx);
}

/**
 * POST /admin/reports/{id}/decision
 * 区分临时措施（隐藏待查）与最终认定，被举报次数不等于违规事实。
 */
async function decideReport(payload, ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });

  const id = validators.requireId(payload.id, 'id');
  const decision = validators.requireEnum(payload.decision, 'decision', ['keep', 'hide', 'escalate']);
  const expectedVersion = requiredExpectedVersion(payload);
  const reason = validators.requireString(payload.reason, '处理理由', { max: 200 });
  return callModeration('report.decide', { id, decision, reason, expectedVersion }, ctx);
}

/**
 * POST /admin/collections/{id}/decision —— 收录或暂不收录。
 * 收录前再次校验范围交集与授权有效性。
 */
async function decideCollection(payload, ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });
  if (ctx.capabilities.anthology !== true) throw errors.forbidden({ reason: 'anthology capability disabled' });

  const taskId = validators.requireId(payload.id, 'id');
  const decision = validators.requireEnum(payload.decision, 'decision', ['include', 'skip']);
  const expectedVersion = requiredExpectedVersion(payload);
  const reason = decision === 'skip' ? validators.requireString(payload.reason, '说明', { max: 200 }) : '';
  return callModeration('collection.decide', { id: taskId, decision, reason, expectedVersion }, ctx);
}

/** POST /admin/comments/{id}/decision —— comment moderation decision. */
async function decideComment(payload, ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });
  const id = validators.requireId(payload.id, 'id');
  const decision = validators.requireEnum(payload.decision, 'decision', ['approve', 'reject', 'hide']);
  const expectedVersion = requiredExpectedVersion(payload);
  const reason =
    decision === 'approve'
      ? validators.requireString(payload.reason, '备注', { max: 200, allowEmpty: true })
      : validators.requireString(payload.reason, '处理理由', { max: 200 });
  return callModeration('comment.decide', { id, decision, reason, expectedVersion }, ctx);
}

/**
 * POST /admin/anonymous/reveal —— 受控查询匿名映射。
 * 必须是 moderator + 明确理由（≥10 字）+ 强制审计。
 * 这不是管理台的常规按钮，只在合法必要时使用。
 */
async function revealAnonymous(payload, ctx) {
  const reason = validators.requireString(payload.reason, '查询理由', { max: 500 });
  if (!policies.canRevealAnonymousMapping(ctx.viewer, { reason })) {
    throw errors.forbidden({ reason: 'insufficient role or reason too short' });
  }

  const threadId = validators.requireId(payload.threadId, 'threadId');

  // 先写审计，再返回数据 —— 审计写失败则不返回
  await db.writeAudit({
    actorId: ctx.viewer.userId,
    action: 'anonymous.reveal',
    targetType: 'thread',
    targetId: threadId,
    reason,
  });

  const res = await db
    .coll(COLLECTIONS.anonymousIdentities)
    .where({ threadId })
    .limit(50)
    .get()
    .catch(() => ({ data: [] }));

  return {
    threadId,
    // 仅返回本次查询所需的最小集合
    mappings: (res.data || []).map((d) => ({ alias: d.alias, userId: d.userId })),
  };
}

module.exports = {
  QUEUES,
  listQueue,
  decideContent,
  decideComment,
  decideTopic,
  decideMembership,
  decideReport,
  decideCollection,
  revealAnonymous,
};
