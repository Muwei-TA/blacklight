/** 评论列表、创建、删除与评论共鸣。 */
const { randomUUID, createHash } = require('node:crypto');
const { COLLECTIONS, POST_STATUS, IDENTITY_MODE } = require('../../shared/constants');
const policies = require('../../shared/policies');
const validators = require('../../shared/validators');
const presenters = require('../../shared/presenters');
const errors = require('../../shared/errors');
const db = require('../../shared/db');
const anonymity = require('../../shared/anonymity');
const foregroundReview = require('../foreground-review');
const reactions = require('./reactions');

/** 当前用户在多条回应上的共鸣标记；计数存于评论文档 reactionCount 字段 */
async function loadMyCommentFlags(userId, commentIds, clubId) {
  if (!userId || commentIds.length === 0) return new Set();
  const _ = db.command();
  const res = await db
    .coll(COLLECTIONS.reactions, clubId)
    .where({ userId, clubId, commentId: _.in(commentIds) })
    .limit(commentIds.length)
    .get()
    .catch(() => ({ data: [] }));
  return new Set((res.data || []).map((r) => r.commentId));
}

/** GET /posts/{id}/comments —— 一级评论 + 定向回复 */
async function listComments(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  const id = validators.requireId(payload.id, 'id');
  const post = await db.findOneById(COLLECTIONS.posts, id, clubId);
  if (!policies.canReadPost(ctx.viewer, post)) throw errors.notAccessible({ postId: id });

  const _ = db.command();
  const ownerHistoryOnly = !ctx.viewer.isMember && post.ownerId === ctx.viewer.userId;
  // 游标只遍历实际可见的评论/回复；无回复的删除项不消耗分页额度。
  const where = ownerHistoryOnly
    ? { postId: id, ownerId: ctx.viewer.userId, status: _.in([POST_STATUS.PUBLISHED, POST_STATUS.PENDING]) }
    : {
      postId: id,
      ...(ctx.viewer.userId ? { $or: [
        { status: POST_STATUS.PUBLISHED },
        { status: POST_STATUS.PENDING, ownerId: ctx.viewer.userId },
      ] } : { status: POST_STATUS.PUBLISHED }),
    };
  const page = await db.paginate(COLLECTIONS.comments, { ...where, clubId }, {
    cursor: validators.parseCursor(payload.cursor),
    pageSize: validators.clampPageSize(payload.pageSize),
    order: 'asc',
    clubId,
  });
  const pageIds = new Set(page.items.map((c) => c._id));
  const parentIds = page.items.map((c) => c.replyToId).filter((parentId) => parentId && !pageIds.has(parentId));
  // 回复跨页时附带父级。客户端按稳定 ID 合并，不能把父级重新当成新评论。
  const fetchedParents = (await db.findByIds(COLLECTIONS.comments, parentIds, clubId)).filter((c) =>
    c.postId === id && !c.replyToId && (!ownerHistoryOnly || c.ownerId === ctx.viewer.userId) && (
      c.status === POST_STATUS.PUBLISHED || c.status === POST_STATUS.DELETED
      || (c.status === POST_STATUS.PENDING && c.ownerId === ctx.viewer.userId)
    ));
  const fetchedParentIds = new Set(fetchedParents.map((c) => c._id));
  // 自己的回复可能指向其他成员的评论。保留通用墓碑以维持线程结构，不暴露原文或作者。
  const hiddenParentPlaceholders = ownerHistoryOnly
    ? parentIds.filter((parentId) => !fetchedParentIds.has(parentId)).map((parentId) => ({
      _id: parentId,
      clubId,
      postId: id,
      ownerId: '',
      replyToId: '',
      body: '',
      identityMode: IDENTITY_MODE.ANONYMOUS,
      status: POST_STATUS.DELETED,
      version: 1,
      createdAt: post.createdAt,
    }))
    : [];
  const parents = [...fetchedParents, ...hiddenParentPlaceholders];
  const comments = [...parents, ...page.items];
  const namedIds = comments
    .filter((c) => c.identityMode !== IDENTITY_MODE.ANONYMOUS && c.status !== POST_STATUS.DELETED)
    .map((c) => c.ownerId);
  const publishedIds = comments.filter((c) => c.status === POST_STATUS.PUBLISHED).map((c) => c._id);

  // 用户 / 匿名别名 / 我的共鸣标记互不依赖，并行取回
  const [users, aliasRes, myCommentReactions] = await Promise.all([
    db.findByIds(COLLECTIONS.users, namedIds),
    // 线程内匿名别名：同一用户在同帖内保持一致
    db
      .coll(COLLECTIONS.anonymousIdentities, clubId)
      .where({ clubId, threadId: id, userId: _.in([...new Set(comments.map((c) => c.ownerId).filter(Boolean))]) })
      .limit(Math.max(1, comments.length))
      .get()
      .catch(() => ({ data: [] })),
    loadMyCommentFlags(ctx.viewer.userId, publishedIds, clubId),
  ]);
  const userById = new Map(users.map((u) => [u._id, u]));
  const aliasByUser = new Map((aliasRes.data || []).map((d) => [d.userId, d.alias]));

  const topLevel = comments.filter((c) => !c.replyToId);
  const repliesByParent = new Map();
  comments
    .filter((c) => c.replyToId)
    .forEach((c) => {
      if (!repliesByParent.has(c.replyToId)) repliesByParent.set(c.replyToId, []);
      repliesByParent.get(c.replyToId).push(c);
    });

  const items = topLevel
    // 已删除的一级回应仅在有可见回复时保留墓碑，否则彻底隐藏
    .filter((c) => c.status !== POST_STATUS.DELETED || (repliesByParent.get(c._id) || []).length > 0)
    .map((comment) =>
      presenters.presentComment(comment, {
        viewer: ctx.viewer,
        authorUser: userById.get(comment.ownerId),
        alias: aliasByUser.get(comment.ownerId),
        isAuthor: comment.ownerId === post.ownerId,
        reacted: myCommentReactions.has(comment._id),
        now: ctx.now,
        replies: (repliesByParent.get(comment._id) || []).map((reply) =>
          presenters.presentComment(reply, {
            viewer: ctx.viewer,
            authorUser: userById.get(reply.ownerId),
            alias: aliasByUser.get(reply.ownerId),
            isAuthor: reply.ownerId === post.ownerId,
            reacted: myCommentReactions.has(reply._id),
            now: ctx.now,
          }),
        ),
      }),
    );

  if (process.env.NODE_ENV !== 'production') anonymity.assertNoIdentityLeak(items, 'comments');
  return {
    items,
    nextCursor: page.hasMore && page.items.length > 0
      ? validators.buildCursor(page.items[page.items.length - 1]) : null,
  };
}

/** POST /posts/{id}/comments —— 提交后 pending，审核通过才展示 */
async function createComment(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  if (!policies.canUsePublishing(ctx.viewer, ctx.capabilities)) throw errors.forbidden({ reason: 'publishing unavailable' });
  const id = validators.requireId(payload.id, 'id');
  const input = validators.validateCommentInput(payload);

  const post = await db.findOneById(COLLECTIONS.posts, id, clubId);
  if (!policies.canReadPost(ctx.viewer, post)) throw errors.notAccessible({ postId: id });
  if (!policies.canComment(ctx.viewer, post)) throw errors.forbidden({ reason: 'comments disabled or not member' });

  // replyTo 必须属于同帖
  if (input.replyToId) {
    const parent = await db.findOneById(COLLECTIONS.comments, input.replyToId, clubId);
    if (!parent || parent.clubId !== clubId || parent.postId !== id) throw errors.invalidInput('回复对象不存在', { field: 'replyToId' });
  }

  const key = validators.requireString(payload.idempotencyKey, '请求标识', { max: 120 });
  const commentId = randomUUID();
  const createdAt = db.serverDate();
  const identityMode = post.identityMode === IDENTITY_MODE.ANONYMOUS && post.ownerId === ctx.viewer.userId
    ? IDENTITY_MODE.ANONYMOUS : input.identityMode;
  const comment = { _id: commentId, clubId, postId: id, ownerId: ctx.viewer.userId,
    replyToId: input.replyToId, body: input.body, identityMode,
    status: POST_STATUS.PENDING, version: 1, createdAt, updatedAt: createdAt };
  let alias = null;
  if (identityMode === IDENTITY_MODE.ANONYMOUS) {
    const derived = anonymity.deriveAlias(id, ctx.viewer.userId, process.env.ANON_ALIAS_SECRET);
    alias = { _id: randomUUID(), clubId, threadId: id, userId: ctx.viewer.userId, ...derived,
      isThreadAuthor: post.ownerId === ctx.viewer.userId, createdAt };
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, ...input, identityMode })).digest('hex');
  try {
    const created = await db.getDb().rpc('hg_create_comment', {
      p_key: `${ctx.viewer.userId}:createComment:${key}`, p_hash: fingerprint,
      p_comment: comment, p_alias: alias, p_club_id: clubId,
    });
    await foregroundReview.runOwnedReview('comment', created.id, ctx).catch(() => null);
    const current = await db.findOneById(COLLECTIONS.comments, created.id, clubId);
    if (!current) throw errors.conflict('回应状态暂时无法确认，请重试');
    // 返回审核后的当前版本与白名单 DTO；客户端不得拿临时 ID 假装删除成功。
    const dto = presenters.presentComment(current, {
      viewer: ctx.viewer,
      authorUser: ctx.user,
      alias: alias && alias.alias,
      isAuthor: current.ownerId === post.ownerId,
      now: ctx.now,
    });
    return { ...created, state: current.status, version: dto.version, comment: dto };
  } catch (err) {
    if (/IDEMPOTENCY_|COMMENT_TARGET_CHANGED/.test(err.message)) throw errors.conflict('内容或请求状态已变化，请刷新后重试');
    throw err;
  }
}

/** PUT/DELETE /posts/{id}/comments/{commentId}/reaction —— 幂等开关 */
async function toggleCommentReaction(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  const commentId = validators.requireId(payload.commentId, 'commentId');
  const next = payload.next === true;

  const comment = await db.findOneById(COLLECTIONS.comments, commentId, clubId);
  // 待审/已删除的回应不可共鸣；无权与不存在返回同一形态
  if (!comment || comment.status !== POST_STATUS.PUBLISHED) throw errors.notAccessible({ commentId });
  if (payload.id && comment.postId !== payload.id) throw errors.invalidInput('回应不属于这条内容', { field: 'commentId' });
  const post = await db.findOneById(COLLECTIONS.posts, comment.postId, clubId);
  if (!policies.canInteract(ctx.viewer, post)) throw errors.notAccessible({ postId: comment.postId });

  return reactions.persistReaction(ctx.viewer.userId, comment.postId, commentId, next, clubId);
}

/** DELETE /posts/{id}/comments/{commentId} —— 评论者删除自己的回应 */
async function deleteComment(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  const commentId = validators.requireId(payload.commentId, 'commentId');
  const expectedVersion = Number(payload.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw errors.invalidInput('缺少版本号', { field: 'expectedVersion' });
  }

  const comment = await db.findOneById(COLLECTIONS.comments, commentId, clubId);
  if (!comment) throw errors.notAccessible({ commentId });
  const post = await db.findOneById(COLLECTIONS.posts, comment.postId, clubId);
  if (!policies.canReadPost(ctx.viewer, post)) throw errors.notAccessible({ postId: comment.postId });
  if (!policies.canDeleteComment(ctx.viewer, comment)) throw errors.forbidden({ reason: 'not comment author' });

  const wasPublished = comment.status === POST_STATUS.PUBLISHED;
  await db.updateWithVersion(COLLECTIONS.comments, commentId, expectedVersion, {
    status: POST_STATUS.DELETED,
    deletedAt: db.serverDate(),
  }, clubId);

  if (wasPublished) await db.incCounter(COLLECTIONS.posts, comment.postId, 'commentCount', -1, clubId);

  // 这条回应的共鸣记录一并回收；其定向回复保留，父级以墓碑占位
  await db
    .coll(COLLECTIONS.reactions, clubId)
    .where({ clubId, commentId })
    .remove()
    .catch(() => {});

  return { ok: true };
}

module.exports = { listComments, createComment, toggleCommentReaction, deleteComment };
