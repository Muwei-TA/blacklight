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
  ROLE,
  NOTIFY_TYPE,
  VISIBILITY,
  DEFAULT_CLUB_ID,
} = require('../shared/constants');
const policies = require('../shared/policies');
const validators = require('../shared/validators');
const presenters = require('../shared/presenters');
const errors = require('../shared/errors');
const db = require('../shared/db');

const QUEUES = ['content', 'topic', 'member', 'report', 'collection'];

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
        version: post.version,
        submittedAtText: presenters.formatRelativeTime(post.createdAt, ctx.now),
        statusText: '等待审核',
      })),
      nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
    };
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
  const posts = await db.findByIds(
    COLLECTIONS.posts,
    items.map((t) => t.targetId),
  );
  const postById = new Map(posts.map((p) => [p._id, p]));

  return {
    items: items.map((task) => {
      const post = postById.get(task.targetId);
      return {
        id: task._id,
        queue,
        title: (post && post.title) || '（文章已不可访问）',
        summary: post ? presenters.excerpt(post.body, 100) : '',
        postId: task.targetId,
        collectionId: task.collectionId,
        submittedAtText: presenters.formatRelativeTime(task.createdAt, ctx.now),
        statusText: '等待收录决定',
      };
    }),
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
  const expectedVersion = Number(payload.expectedVersion);
  if (!Number.isInteger(expectedVersion)) throw errors.invalidInput('缺少版本号', { field: 'expectedVersion' });

  // 退回与隐藏必须有理由
  const reason =
    decision === 'approve'
      ? validators.requireString(payload.reason, '备注', { max: 200, allowEmpty: true })
      : validators.requireString(payload.reason, '处理理由', { max: 200 });

  const post = await db.findOneById(COLLECTIONS.posts, id);
  if (!post) throw errors.notAccessible({ postId: id });
  if (post.visibility === VISIBILITY.PRIVATE) {
    // 私密内容不在治理范围内，防止管理台成为读私密的侧门
    throw errors.forbidden({ reason: 'private content is out of moderation scope' });
  }

  const statusMap = {
    approve: POST_STATUS.PUBLISHED,
    reject: POST_STATUS.REJECTED,
    hide: POST_STATUS.HIDDEN,
  };

  const updates = {
    status: statusMap[decision],
    rejectReason: decision === 'reject' ? reason : '',
    reviewedAt: db.serverDate(),
    reviewedBy: ctx.viewer.userId,
  };
  if (decision === 'hide') updates.permissionVersion = (post.permissionVersion || 0) + 1;

  // 版本锁：并发重复处理时后者抛 conflict，保证幂等
  await db.updateWithVersion(COLLECTIONS.posts, id, expectedVersion, updates);

  await db.writeAudit({
    actorId: ctx.viewer.userId,
    action: `content.${decision}`,
    targetType: 'post',
    targetId: id,
    decision,
    reason,
  });

  // 通知作者：文案中性，不含正文
  const titleMap = {
    approve: '你的内容已通过审核',
    reject: '一条内容需要修改',
    hide: '一条内容已被暂时隐藏',
  };
  await db.coll(COLLECTIONS.notifications).add({
    data: {
      recipientId: post.ownerId,
      eventType: NOTIFY_TYPE.SYSTEM_REVIEW,
      title: titleMap[decision],
      summary: decision === 'approve' ? '现在会在你设定的范围内展示。' : reason,
      targetType: 'post',
      targetId: id,
      icon: decision === 'approve' ? 'check-circle' : 'error-circle',
      createdAt: db.serverDate(),
    },
  });

  if (decision === 'approve' && post.topicId) {
    await db.incCounter(COLLECTIONS.topics, post.topicId, 'postCount', 1);
  }

  return { ok: true, status: statusMap[decision] };
}

/** POST /admin/topics/{id}/decision */
async function decideTopic(payload, ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });

  const id = validators.requireId(payload.id, 'id');
  const decision = validators.requireEnum(payload.decision, 'decision', ['approve', 'archive', 'reject']);
  const reason =
    decision === 'approve'
      ? ''
      : validators.requireString(payload.reason, '处理理由', { max: 200 });

  const topic = await db.findOneById(COLLECTIONS.topics, id);
  if (!topic) throw errors.notAccessible({ topicId: id });

  const statusMap = {
    approve: TOPIC_STATUS.ACTIVE,
    archive: TOPIC_STATUS.ARCHIVED,
    reject: TOPIC_STATUS.ARCHIVED,
  };

  await db.updateWithVersion(COLLECTIONS.topics, id, topic.version || 1, {
    status: statusMap[decision],
    decisionReason: reason,
  });

  await db.writeAudit({
    actorId: ctx.viewer.userId,
    action: `topic.${decision}`,
    targetType: 'topic',
    targetId: id,
    decision,
    reason,
  });

  return { ok: true, status: statusMap[decision] };
}

/** POST /admin/members/applications/{id} */
async function decideMembership(payload, ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });

  const id = validators.requireId(payload.id, 'id');
  const decision = validators.requireEnum(payload.decision, 'decision', ['approve', 'reject']);
  const reason =
    decision === 'approve' ? '' : validators.requireString(payload.reason, '拒绝理由', { max: 200 });

  const app = await db.findOneById(COLLECTIONS.membershipApplications, id);
  if (!app) throw errors.notAccessible({ applicationId: id });
  if (app.status !== MEMBER_STATUS.PENDING) throw errors.conflict('该申请已被处理');

  await db.coll(COLLECTIONS.membershipApplications).doc(id).update({
    data: {
      status: decision === 'approve' ? MEMBER_STATUS.ACTIVE : MEMBER_STATUS.REJECTED,
      decisionReason: reason,
      decidedBy: ctx.viewer.userId,
      decidedAt: db.serverDate(),
    },
  });

  if (decision === 'approve') {
    await db.coll(COLLECTIONS.memberships).add({
      data: {
        _id: `${app.userId}:${app.clubId}`,
        userId: app.userId,
        clubId: app.clubId,
        role: ROLE.MEMBER,
        status: MEMBER_STATUS.ACTIVE,
        joinedAt: db.serverDate(),
        rulesVersion: app.rulesVersion,
      },
    }).catch(() => {});

    // 昵称以申请时填写的为准
    await db
      .coll(COLLECTIONS.users)
      .doc(app.userId)
      .update({ data: { displayName: app.displayName, updatedAt: db.serverDate() } })
      .catch(() => {});
  }

  await db.writeAudit({
    actorId: ctx.viewer.userId,
    action: `membership.${decision}`,
    targetType: 'membership_application',
    targetId: id,
    decision,
    reason,
  });

  await db.coll(COLLECTIONS.notifications).add({
    data: {
      recipientId: app.userId,
      eventType: NOTIFY_TYPE.SYSTEM_MEMBERSHIP,
      title: decision === 'approve' ? '欢迎加入黑光文学社' : '入社申请未通过',
      summary: decision === 'approve' ? '现在可以在社内写下第一笔了。' : reason,
      targetType: 'system',
      targetId: 'membership',
      icon: 'usergroup',
      createdAt: db.serverDate(),
    },
  });

  return { ok: true };
}

/**
 * POST /admin/reports/{id}/decision
 * 区分临时措施（隐藏待查）与最终认定，被举报次数不等于违规事实。
 */
async function decideReport(payload, ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });

  const id = validators.requireId(payload.id, 'id');
  const decision = validators.requireEnum(payload.decision, 'decision', ['keep', 'hide', 'escalate']);
  const reason = validators.requireString(payload.reason, '处理理由', { max: 200 });

  const report = await db.findOneById(COLLECTIONS.reports, id);
  if (!report) throw errors.notAccessible({ reportId: id });

  await db.coll(COLLECTIONS.reports).doc(id).update({
    data: {
      status: decision === 'escalate' ? 'escalated' : 'closed',
      decision,
      decisionReason: reason,
      decidedBy: ctx.viewer.userId,
      decidedAt: db.serverDate(),
    },
  });

  if (decision === 'hide' && report.targetType === 'post') {
    const post = await db.findOneById(COLLECTIONS.posts, report.targetId);
    if (post) {
      await db.updateWithVersion(COLLECTIONS.posts, report.targetId, post.version || 1, {
        status: POST_STATUS.HIDDEN,
        hiddenReason: reason,
        permissionVersion: (post.permissionVersion || 0) + 1,
      });

      // 告知作者并提供申诉入口；不透露举报人
      await db.coll(COLLECTIONS.notifications).add({
        data: {
          recipientId: post.ownerId,
          eventType: NOTIFY_TYPE.SYSTEM_REPORT,
          title: '一条内容已被暂时隐藏',
          summary: `${reason}。如果你认为这是误判，可以申诉。`,
          targetType: 'post',
          targetId: report.targetId,
          icon: 'flag',
          createdAt: db.serverDate(),
        },
      });
    }
  }

  await db.writeAudit({
    actorId: ctx.viewer.userId,
    action: `report.${decision}`,
    targetType: report.targetType,
    targetId: report.targetId,
    decision,
    reason,
  });

  return { ok: true };
}

/**
 * POST /admin/collections/{id}/decision —— 收录或暂不收录。
 * 收录前再次校验范围交集与授权有效性。
 */
async function decideCollection(payload, ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });

  const taskId = validators.requireId(payload.id, 'id');
  const decision = validators.requireEnum(payload.decision, 'decision', ['include', 'skip']);
  const reason = decision === 'skip' ? validators.requireString(payload.reason, '说明', { max: 200 }) : '';

  const task = await db.findOneById(COLLECTIONS.reviewTasks, taskId);
  if (!task) throw errors.notAccessible({ taskId });

  const [collection, post, consent] = await Promise.all([
    db.findOneById(COLLECTIONS.collections, task.collectionId),
    db.findOneById(COLLECTIONS.posts, task.targetId),
    db.findOneById(COLLECTIONS.consents, `${task.targetId}:collection:${task.collectionId}`),
  ]);

  if (decision === 'include') {
    // 授权必须有效且未撤回
    if (!consent || consent.revokedAt) throw errors.forbidden({ reason: 'consent missing or revoked' });
    if (!policies.canIncludeInCollection(collection, post)) {
      throw errors.forbidden({ reason: 'collection scope exceeds post scope' });
    }

    const countRes = await db
      .coll(COLLECTIONS.collectionEntries)
      .where({ collectionId: task.collectionId })
      .count()
      .catch(() => ({ total: 0 }));

    await db.coll(COLLECTIONS.collectionEntries).add({
      data: {
        collectionId: task.collectionId,
        postId: task.targetId,
        consentId: consent._id,
        order: (countRes.total || 0) + 1,
        createdAt: db.serverDate(),
      },
    });
    await db.incCounter(COLLECTIONS.collections, task.collectionId, 'entryCount', 1);
  }

  await db.coll(COLLECTIONS.reviewTasks).doc(taskId).update({
    data: { status: decision === 'include' ? 'passed' : 'skipped', decisionReason: reason },
  });

  await db.writeAudit({
    actorId: ctx.viewer.userId,
    action: `collection.${decision}`,
    targetType: 'post',
    targetId: task.targetId,
    decision,
    reason,
  });

  if (post) {
    await db.coll(COLLECTIONS.notifications).add({
      data: {
        recipientId: post.ownerId,
        eventType: NOTIFY_TYPE.SYSTEM_COLLECTION,
        title: decision === 'include' ? '你的文章被收录了' : '这一期暂时没有收录',
        // 未入选的告知必须温和，且明确不等于作品违规
        summary: decision === 'include' ? '已加入文集目录。' : `${reason}。这不代表作品有问题。`,
        targetType: 'post',
        targetId: task.targetId,
        icon: 'book-open',
        createdAt: db.serverDate(),
      },
    });
  }

  return { ok: true };
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
  decideTopic,
  decideMembership,
  decideReport,
  decideCollection,
  revealAnonymous,
};
