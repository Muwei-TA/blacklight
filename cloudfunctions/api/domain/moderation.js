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
  REVIEW_TASK_STATUS,
  TOPIC_STATUS,
  BOARD_STATUS,
  MEMBER_STATUS,
  VISIBILITY,
  DEFAULT_CLUB_ID,
} = require('../shared/constants');
const policies = require('../shared/policies');
const validators = require('../shared/validators');
const presenters = require('../shared/presenters');
const errors = require('../shared/errors');
const db = require('../shared/db');

const QUEUES = ['all', 'comment', 'content', 'topic', 'board', 'member', 'report', 'collection', 'appeals'];
const ALL_QUEUES = ['content', 'comment', 'topic', 'board', 'member', 'report', 'collection', 'appeals'];

function makeQueueItem(item, source, internal = false) {
  const timestamp = new Date(source.createdAt).getTime();
  return {
    ...item,
    submittedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    ...(internal ? {
      _cursorId: source._id || source.appealId,
      _cursorCreatedAt: source.createdAt,
    } : {}),
  };
}

function buildInternalCursor(item) {
  const createdAt = typeof item._cursorCreatedAt === 'number'
    ? item._cursorCreatedAt
    : new Date(item._cursorCreatedAt).getTime();
  if (!Number.isFinite(createdAt) || !item._cursorId || !item.queue) {
    throw new Error('Cannot build queue cursor from invalid item');
  }
  return Buffer.from(JSON.stringify({ createdAt, id: item._cursorId, queue: item.queue }), 'utf8').toString('base64');
}

function compareQueueItems(left, right) {
  const timeDelta = new Date(left.submittedAt).getTime() - new Date(right.submittedAt).getTime();
  if (timeDelta !== 0) return timeDelta;
  const idOrder = left._cursorId.localeCompare(right._cursorId);
  if (idOrder !== 0) return idOrder;
  return left.queue.localeCompare(right.queue);
}

async function listManualContentQueue(cursor, pageSize, ctx, internal, includeEqualId) {
  let taskCursor = cursor;
  let includeEqual = includeEqualId;
  let hasMoreTasks = true;
  const candidates = [];

  // Old/superseded manual tasks can remain in the task table. Drain them while
  // filling the visible page so they cannot hide current review work.
  while (hasMoreTasks && candidates.length <= pageSize) {
    const page = await db.paginate(
      COLLECTIONS.reviewTasks,
      { targetType: 'post', status: REVIEW_TASK_STATUS.MANUAL },
      { cursor: taskCursor, pageSize, order: 'asc', includeEqualId: includeEqual },
    );
    if (page.items.length === 0) break;

    const posts = await db.findByIds(COLLECTIONS.posts, page.items.map((task) => task.targetId));
    const postById = new Map(posts.map((post) => [post._id, post]));
    for (const task of page.items) {
      const post = postById.get(task.targetId);
      if (!post
        || task.status !== REVIEW_TASK_STATUS.MANUAL
        || post.clubId !== DEFAULT_CLUB_ID
        || post.status !== POST_STATUS.PENDING
        || ![VISIBILITY.PUBLIC, VISIBILITY.CLUB].includes(post.visibility)
        || Number(task.postVersion || 1) !== Number(post.version || 1)) continue;

      candidates.push(makeQueueItem({
        id: post._id,
        queue: 'content',
        title: post.title || '（无标题碎片）',
        summary: presenters.excerpt(post.body, 100),
        assetIds: post.assetIds || [],
        visibility: post.visibility,
        isAnonymous: post.identityMode === 'anonymous',
        kind: post.kind || 'fragment',
        version: post.version || 1,
        submittedAtText: presenters.formatRelativeTime(task.createdAt, ctx.now),
        statusText: post.kind === 'article' ? '等待管理员审批' : '等待人工复核',
      }, task, true));
    }

    taskCursor = validators.parseCursor(validators.buildCursor(page.items[page.items.length - 1]));
    includeEqual = false;
    hasMoreTasks = page.hasMore;
  }

  const selected = candidates.slice(0, pageSize);
  const items = internal
    ? selected
    : selected.map(({ _cursorId, _cursorCreatedAt, ...item }) => item);
  return {
    items,
    nextCursor: (candidates.length > pageSize || hasMoreTasks) && selected.length > 0
      ? buildInternalCursor(selected[selected.length - 1])
      : null,
  };
}

async function listVisibleCollectionQueue(cursor, pageSize, ctx, internal, includeEqualId) {
  let taskCursor = cursor;
  let includeEqual = includeEqualId;
  let hasMoreTasks = true;
  const candidates = [];

  // Keep scanning past malformed/stale tasks so they cannot starve visible
  // collection submissions on later pages.
  while (hasMoreTasks && candidates.length <= pageSize) {
    const page = await db.paginate(
      COLLECTIONS.reviewTasks,
      { targetType: 'collection_submission', status: 'queued' },
      { cursor: taskCursor, pageSize, order: 'asc', includeEqualId: includeEqual },
    );
    if (page.items.length === 0) break;

    const posts = await db.findByIds(COLLECTIONS.posts, page.items.map((task) => task.targetId));
    const postById = new Map(posts.map((post) => [post._id, post]));
    for (const task of page.items) {
      const post = postById.get(task.targetId);
      if (!post || post.clubId !== DEFAULT_CLUB_ID || post.status !== POST_STATUS.PUBLISHED
        || ![VISIBILITY.PUBLIC, VISIBILITY.CLUB].includes(post.visibility)) continue;

      candidates.push(makeQueueItem({
        id: task._id,
        queue: 'collection',
        title: post.title || '（文章已不可访问）',
        summary: presenters.excerpt(post.body, 100),
        postId: task.targetId,
        collectionId: task.collectionId,
        version: task.version || 1,
        submittedAtText: presenters.formatRelativeTime(task.createdAt, ctx.now),
        statusText: '等待收录决定',
      }, task, true));
    }

    taskCursor = validators.parseCursor(validators.buildCursor(page.items[page.items.length - 1]));
    includeEqual = false;
    hasMoreTasks = page.hasMore;
  }

  const selected = candidates.slice(0, pageSize);
  const items = internal
    ? selected
    : selected.map(({ _cursorId, _cursorCreatedAt, ...item }) => item);
  return {
    items,
    nextCursor: (candidates.length > pageSize || hasMoreTasks) && selected.length > 0
      ? buildInternalCursor(selected[selected.length - 1])
      : null,
  };
}

async function listAllQueues(payload, pageSize, ctx) {
  const pages = await Promise.all(ALL_QUEUES.map((queue) => listQueue({
    queue,
    cursor: payload.cursor,
    pageSize,
  }, ctx, true)));
  const candidates = pages.flatMap((page) => page.items).sort(compareQueueItems);
  const items = candidates.slice(0, pageSize).map(({ _cursorId, _cursorCreatedAt, ...item }) => item);
  const last = candidates[Math.min(pageSize, candidates.length) - 1];
  const hasMore = candidates.length > pageSize || pages.some((page) => page.nextCursor);
  return {
    items,
    nextCursor: hasMore && last ? buildInternalCursor(last) : null,
  };
}

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
  if (/REVIEW_NOT_READY/.test(marker)) {
    return errors.conflict('自动安全检查尚未完成，请稍后刷新审核队列', { field: 'reviewState' });
  }
  if (/XP_MEMBERSHIP_BUSY|55P03/.test(marker)) {
    return errors.conflict('成员状态正在变更，请稍后重试');
  }
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

async function callBoardModeration(input, ctx) {
  try {
    return await db.getDb().rpc('hg_decide_board', {
      p_actor_id: ctx.viewer.userId,
      p_input: input,
    });
  } catch (error) {
    const marker = `${error && error.code ? error.code : ''} ${error && error.message ? error.message : ''}`;
    if (/FORBIDDEN/.test(marker)) throw errors.forbidden();
    if (/BOARD_NOT_FOUND/.test(marker)) throw errors.notAccessible();
    if (/VERSION_CONFLICT|BOARD_ALREADY_DECIDED/.test(marker)) {
      throw errors.conflict('板块已被更新，请刷新后重试', { field: 'expectedVersion' });
    }
    if (/INVALID|REASON_REQUIRED/.test(marker)) throw errors.invalidInput('请求参数不合法');
    throw error;
  }
}

/** GET /admin/queues/{queue} */
async function listQueue(payload, ctx, internal = false) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });

  const queue = validators.requireEnum(payload.queue || 'content', 'queue', QUEUES);
  const cursor = validators.parseCursor(payload.cursor);
  if (cursor && cursor.queue !== undefined && !ALL_QUEUES.includes(cursor.queue)) {
    throw errors.invalidInput('游标不合法', { field: 'cursor' });
  }
  const pageSize = validators.clampPageSize(payload.pageSize);
  const includeEqualId = !!(cursor && cursor.queue && queue.localeCompare(cursor.queue) > 0);

  if (queue === 'all') return listAllQueues(payload, pageSize, ctx);

  if (queue === 'content') {
    return listManualContentQueue(cursor, pageSize, ctx, internal, includeEqualId);
  }

  if (queue === 'comment') {
    const rows = await db.getDb().rpc('hg_comment_queue', {
      p_actor: ctx.viewer.userId,
      p_cursor: cursor ? { ...cursor, inclusiveId: includeEqualId } : null,
      p_limit: pageSize + 1,
    });
    const items = rows.slice(0, pageSize);
    return { items: items.map((comment) => makeQueueItem({
      id: comment._id, queue, title: '回应', summary: comment.body || '',
      postId: comment.postId, version: comment.version || 1,
      isAnonymous: comment.identityMode === 'anonymous',
      submittedAtText: presenters.formatRelativeTime(comment.createdAt, ctx.now), statusText: '等待审核',
    }, comment, internal)), nextCursor: rows.length > pageSize ? validators.buildCursor(items[items.length-1]) : null };
  }

  if (queue === 'topic') {
    const { items, hasMore } = await db.paginate(
      COLLECTIONS.topics,
      { clubId: DEFAULT_CLUB_ID, status: TOPIC_STATUS.PENDING },
      { cursor, pageSize, order: 'asc', includeEqualId },
    );
    return {
      items: items.map((topic) => makeQueueItem({
        id: topic._id,
        queue,
        title: topic.title,
        summary: topic.description || '',
        version: topic.version || 1,
        submittedAtText: presenters.formatRelativeTime(topic.createdAt, ctx.now),
        statusText: '等待确认',
      }, topic, internal)),
      nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
    };
  }

  if (queue === 'board') {
    const { items, hasMore } = await db.paginate(
      COLLECTIONS.boards,
      { clubId: DEFAULT_CLUB_ID, status: BOARD_STATUS.PENDING },
      { cursor, pageSize, order: 'asc', includeEqualId },
    );
    return {
      items: items.map((board) => makeQueueItem({
        id: board._id,
        queue,
        title: board.title || '',
        summary: board.description || '',
        status: board.status,
        version: board.version || 1,
        submittedAtText: presenters.formatRelativeTime(board.createdAt, ctx.now),
        statusText: '等待管理员审核',
      }, board, internal)),
      nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
    };
  }

  if (queue === 'member') {
    const { items, hasMore } = await db.paginate(
      COLLECTIONS.membershipApplications,
      { clubId: DEFAULT_CLUB_ID, status: MEMBER_STATUS.PENDING },
      { cursor, pageSize, order: 'asc', includeEqualId },
    );
    return {
      items: items.map((app) => makeQueueItem({
        id: app._id,
        queue,
        title: app.displayName,
        summary: `邀请码 ${app.inviteCode} · 已阅读规则 ${app.rulesVersion}`,
        version: app.version || 1,
        submittedAtText: presenters.formatRelativeTime(app.createdAt, ctx.now),
        statusText: '等待批准',
      }, app, internal)),
      nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
    };
  }

  if (queue === 'report') {
    const { items, hasMore } = await db.paginate(
      COLLECTIONS.reports,
      { status: 'received' },
      { cursor, pageSize, order: 'asc', includeEqualId },
    );
    return {
      items: items.map((report) => makeQueueItem({
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
      }, report, internal)),
      nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
    };
  }

  if (queue === 'appeals') {
    const rows = await db.getDb().rpc('hg_admin_appeals_queue', {
      p_actor: ctx.viewer.userId,
      p_cursor: cursor ? { ...cursor, inclusiveId: includeEqualId } : null,
      p_limit: pageSize + 1,
    });
    const appeals = Array.isArray(rows) ? rows : [];
    const items = appeals.slice(0, pageSize);
    return {
      items: items.map((appeal) => makeQueueItem({
        id: appeal.appealId || appeal._id,
        appealId: appeal.appealId || appeal._id,
        queue,
        title: '内容申诉',
        summary: appeal.reason || '',
        postId: appeal.postId,
        contentVersion: appeal.contentVersion,
        version: appeal.version || 1,
        statusText: '等待复核',
        submittedAtText: presenters.formatRelativeTime(appeal.createdAt, ctx.now),
      }, { ...appeal, _id: appeal.appealId || appeal._id }, internal)),
      nextCursor: appeals.length > pageSize ? validators.buildCursor({
        _id: items[items.length - 1].appealId || items[items.length - 1]._id,
        createdAt: items[items.length - 1].createdAt,
      }) : null,
    };
  }

  // collection：文集收录申请
  return listVisibleCollectionQueue(cursor, pageSize, ctx, internal, includeEqualId);
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

/** POST /admin/board/decide —— 板块审核与话题审核完全分离。 */
async function decideBoard(payload, ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });

  const id = validators.requireId(payload.id, 'id');
  const decision = validators.requireEnum(payload.decision, 'decision', ['approve', 'reject']);
  const expectedVersion = requiredExpectedVersion(payload);
  const reason = decision === 'approve'
    ? validators.requireString(payload.reason, '备注', { max: 200, allowEmpty: true })
    : validators.requireString(payload.reason, '处理理由', { max: 200 });
  return callBoardModeration({ id, decision, reason, expectedVersion }, ctx);
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
  decideBoard,
  decideMembership,
  decideReport,
  decideCollection,
  revealAnonymous,
};
