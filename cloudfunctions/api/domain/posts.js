/**
 * 内容领域用例。这是**纵向参考实现**：其他模块（topics/collections/…）
 * 必须照此结构编写，不要另创风格。
 *
 * 分层顺序固定：
 *   1) 校验入参（validators）
 *   2) 判权限（policies）—— 绝不在此文件内联写权限分支
 *   3) 读写数据（db）
 *   4) 组装 DTO（presenters）
 */

const { randomUUID, createHash } = require('node:crypto');
const {
  COLLECTIONS,
  POST_STATUS,
  VISIBILITY,
  IDENTITY_MODE,
  ASSET_STATUS,
  NOTIFY_TYPE,
  DEFAULT_CLUB_ID,
} = require('../shared/constants');
const policies = require('../shared/policies');
const validators = require('../shared/validators');
const presenters = require('../shared/presenters');
const errors = require('../shared/errors');
const db = require('../shared/db');
const anonymity = require('../shared/anonymity');

const CATEGORY_TEXT = {
  life: '生活',
  inspiration: '灵感',
  article: '文章',
  video: '视频',
  event: '活动',
  confide: '倾诉',
  reading: '阅读',
  play: '共玩',
};

/**
 * 构造信息流的权限过滤条件。
 * ⚠️ 这是"先鉴权再查询"的关键：过滤条件直接进 where，
 * 而不是查出来再在内存里筛（那样 total 与分页都会泄露信息）。
 */
function buildFeedWhere(viewer, extra = {}) {
  const _ = db.command();
  const base = {
    clubId: DEFAULT_CLUB_ID,
    status: POST_STATUS.PUBLISHED,
    ...extra,
  };

  if (viewer.isMember) {
    // 成员可见公开 + 社内，但私密永不进流（含自己的）
    base.visibility = _.in([VISIBILITY.PUBLIC, VISIBILITY.CLUB]);
  } else {
    base.visibility = VISIBILITY.PUBLIC;
  }
  return base;
}

/** 批量装配卡片所需的关联数据，避免 N+1 */
async function hydrateCards(posts, ctx) {
  if (posts.length === 0) return [];

  const namedOwnerIds = posts
    .filter((p) => p.identityMode !== IDENTITY_MODE.ANONYMOUS)
    .map((p) => p.ownerId);
  const assetIds = posts.flatMap((p) => p.assetIds || []);
  const topicIds = posts.map((p) => p.topicId).filter(Boolean);
  const postIds = posts.map((p) => p._id);

  const [users, assets, topics, myReactions, myBookmarks, aliasDocs] = await Promise.all([
    db.findByIds(COLLECTIONS.users, namedOwnerIds),
    db.findByIds(COLLECTIONS.assets, assetIds),
    db.findByIds(COLLECTIONS.topics, topicIds),
    ctx.viewer.userId ? loadMyFlags(COLLECTIONS.reactions, ctx.viewer.userId, postIds) : Promise.resolve(new Set()),
    ctx.viewer.userId ? loadMyFlags(COLLECTIONS.bookmarks, ctx.viewer.userId, postIds) : Promise.resolve(new Set()),
    loadAliases(posts),
  ]);

  const userById = new Map(users.map((u) => [u._id, u]));
  const topicById = new Map(topics.map((t) => [t._id, t]));

  const readableAssets = await require('./assets').signReadableAssets(assets, posts, ctx);
  return posts.map((post) =>
    presenters.presentPostCard(post, {
      viewer: ctx.viewer,
      authorUser: userById.get(post.ownerId),
      alias: aliasDocs.get(post._id),
      assets: readableAssets,
      topic: topicById.get(post.topicId),
      reacted: myReactions.has(post._id),
      bookmarked: myBookmarks.has(post._id),
      now: ctx.now,
    }),
  );
}

async function loadMyFlags(collection, userId, postIds) {
  const _ = db.command();
  const res = await db
    .coll(collection)
    .where({ userId, postId: _.in(postIds) })
    .limit(postIds.length)
    .get()
    .catch(() => ({ data: [] }));
  return new Set((res.data || []).map((r) => r.postId));
}

/**
 * 读取匿名帖的 alias。
 * 只取 alias 字段；userId 映射留在受限集合中，不进入这里的返回值。
 */
async function loadAliases(posts) {
  const anonPosts = posts.filter((p) => p.identityMode === IDENTITY_MODE.ANONYMOUS);
  if (anonPosts.length === 0) return new Map();

  const _ = db.command();
  const res = await db
    .coll(COLLECTIONS.anonymousIdentities)
    .where({ threadId: _.in(anonPosts.map((p) => p._id)), isThreadAuthor: true })
    .limit(anonPosts.length)
    .get()
    .catch(() => ({ data: [] }));

  return new Map((res.data || []).map((doc) => [doc.threadId, doc.alias]));
}

/** GET /posts —— 树洞信息流 */
async function listFeed(payload, ctx) {
  const cursor = validators.parseCursor(payload.cursor);
  const pageSize = validators.clampPageSize(payload.pageSize);

  const extra = {};
  if (payload.topicId) extra.topicId = validators.optionalId(payload.topicId, 'topicId');
  if (payload.type && payload.type !== 'all') {
    if (payload.type === 'article') extra.kind = 'article';
    else if (payload.type === 'video') extra.hasVideo = true;
    else extra.category = payload.type;
  }
  // 待回应：已发布、允许评论、尚无有效文字回应
  if (payload.filter === 'awaiting_reply') {
    extra.commentsEnabled = true;
    extra.commentCount = 0;
  }

  const where = buildFeedWhere(ctx.viewer, extra);
  const { items, hasMore } = await db.paginate(COLLECTIONS.posts, where, { cursor, pageSize });

  const cards = await hydrateCards(items, ctx);
  // 开发期自检：确保没有匿名映射漏出
  if (process.env.NODE_ENV !== 'production') anonymity.assertNoIdentityLeak(cards, 'feed');

  return {
    items: cards,
    nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
  };
}

/** GET /posts/{id} —— 详情。无权与不存在返回同一形态。 */
async function getDetail(payload, ctx) {
  const id = validators.requireId(payload.id, 'id');
  const post = await db.findOneById(COLLECTIONS.posts, id);

  if (!policies.canReadPost(ctx.viewer, post)) {
    throw errors.notAccessible({ postId: id, role: ctx.viewer.role });
  }

  const [authorUser, assets, topic, aliasMap, reacted, bookmarked, consent] = await Promise.all([
    post.identityMode === IDENTITY_MODE.ANONYMOUS
      ? Promise.resolve(null)
      : db.findOneById(COLLECTIONS.users, post.ownerId),
    db.findByIds(COLLECTIONS.assets, post.assetIds || []),
    post.topicId ? db.findOneById(COLLECTIONS.topics, post.topicId) : Promise.resolve(null),
    loadAliases([post]),
    ctx.viewer.userId ? loadMyFlags(COLLECTIONS.reactions, ctx.viewer.userId, [id]) : Promise.resolve(new Set()),
    ctx.viewer.userId ? loadMyFlags(COLLECTIONS.bookmarks, ctx.viewer.userId, [id]) : Promise.resolve(new Set()),
    db.findOneById(COLLECTIONS.consents, `${id}:collection`),
  ]);

  const readableAssets = await require('./assets').signReadableAssets(assets, [post], ctx);
  const dto = presenters.presentPostDetail(post, {
    viewer: ctx.viewer,
    authorUser,
    alias: aliasMap.get(post._id),
    assets: readableAssets,
    topic,
    reacted: reacted.has(id),
    bookmarked: bookmarked.has(id),
    collectionGranted: !!(consent && !consent.revokedAt),
    now: ctx.now,
  });

  if (process.env.NODE_ENV !== 'production') anonymity.assertNoIdentityLeak(dto, 'detail');
  return dto;
}

/**
 * POST /posts —— 创建内容。
 * 事务要点：附件校验 → 幂等占位 → 写 Post → 建审核任务。
 * 任一步失败都不留"列表有帖子但附件还属于临时用户"的中间态。
 */
async function createPost(payload, ctx) {
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  if (!policies.canUsePublishing(ctx.viewer, ctx.capabilities)) throw errors.forbidden({ reason: 'publishing unavailable' });

  const input = validators.validatePostInput(payload);

  // 公开范围受能力开关控制，前端隐藏不构成保护
  if (input.visibility === VISIBILITY.PUBLIC && !policies.canUsePublicVisibility(ctx.viewer, ctx.capabilities)) {
    throw errors.forbidden({ reason: 'publicScope disabled' });
  }

  const idempotencyKey = validators.requireString(payload.idempotencyKey, '请求标识', { max: 120 });
  if (input.assetIds.length && !policies.canUseUploads(ctx.viewer, ctx.capabilities)) throw errors.forbidden({ reason: 'uploads disabled' });

  // 校验附件归属与状态：只能绑定本人已验证的附件
  let hasVideo = false;
  if (input.assetIds.length > 0) {
    const assets = await db.findByIds(COLLECTIONS.assets, input.assetIds);
    if (assets.length !== input.assetIds.length) throw errors.invalidInput('附件不存在', { field: 'assetIds' });

    for (const asset of assets) {
      if (asset.ownerId !== ctx.viewer.userId) throw errors.forbidden({ reason: 'asset owner mismatch' });
      if (asset.status !== ASSET_STATUS.VERIFIED) throw errors.pendingMedia({ assetId: asset._id });
      if (asset.mediaType === 'video') hasVideo = true;
    }

    const videoCount = assets.filter((a) => a.mediaType === 'video').length;
    const imageCount = assets.filter((a) => a.mediaType === 'image').length;
    if (videoCount > 0 && imageCount > 0) throw errors.invalidInput('图片与视频只能选一种', { field: 'assetIds' });
    if (videoCount > 1) throw errors.invalidInput('一条内容只能有一个视频', { field: 'assetIds' });
    if (hasVideo && !policies.canUploadVideo(ctx.viewer, ctx.capabilities)) {
      throw errors.forbidden({ reason: 'video capability disabled' });
    }
  }

  // 话题必须存在且可投稿
  if (input.topicId) {
    const topic = await db.findOneById(COLLECTIONS.topics, input.topicId);
    if (!policies.canPostToTopic(ctx.viewer, topic)) throw errors.notAccessible({ topicId: input.topicId });
  }

  // 仅自己内容不进审核流程，直接保存
  const isPrivate = input.visibility === VISIBILITY.PRIVATE;
  const status = isPrivate ? POST_STATUS.PUBLISHED : POST_STATUS.PENDING;

  const postId = randomUUID();
  const post = {
      clubId: DEFAULT_CLUB_ID,
      ownerId: ctx.viewer.userId,
      kind: input.kind,
      category: input.kind === 'article' ? 'article' : payload.category || 'life',
      categoryText: CATEGORY_TEXT[input.kind === 'article' ? 'article' : payload.category || 'life'] || '',
      title: input.title,
      body: input.body,
      assetIds: input.assetIds,
      hasVideo,
      visibility: input.visibility,
      identityMode: input.identityMode,
      commentsEnabled: input.commentsEnabled,
      topicId: input.topicId,
      status,
      version: 1,
      reactionCount: 0,
      commentCount: 0,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    };
  post._id = postId;
  let aliasDoc = null;
  if (input.identityMode === IDENTITY_MODE.ANONYMOUS) {
    const { alias, aliasKey } = anonymity.deriveAlias(postId, ctx.viewer.userId, process.env.ANON_ALIAS_SECRET);
    aliasDoc = { _id: randomUUID(), threadId: postId, userId: ctx.viewer.userId, alias, aliasKey, isThreadAuthor: true, createdAt: post.createdAt };
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...input, category: post.category })).digest('hex');
  try {
    const created = await db.getDb().rpc('hg_create_post', {
      p_key: `${ctx.viewer.userId}:createPost:${idempotencyKey}`,
      p_hash: fingerprint, p_post: post, p_alias: aliasDoc,
    });
    if (created.state !== 'private_saved') {
      await require('./foreground-review').runOwnedReview('post', created.id, ctx).catch(() => null);
      const current = await db.findOneById(COLLECTIONS.posts, created.id);
      return { ...created, state: current?.status || 'pending', version: current?.version || created.version };
    }
    return created;
  } catch (err) {
    if (/IDEMPOTENCY_|ASSET_BINDING_CONFLICT/.test(err.message)) throw errors.conflict('请求内容或附件状态已变化，请刷新后重试');
    throw err;
  }
}

/** PATCH /posts/{id}/visibility —— 首版只允许缩小 */
async function changeVisibility(payload, ctx) {
  const id = validators.requireId(payload.id, 'id');
  const next = validators.requireEnum(payload.visibility, 'visibility', VISIBILITY);
  const expectedVersion = Number(payload.expectedVersion);
  if (!Number.isInteger(expectedVersion)) throw errors.invalidInput('缺少版本号', { field: 'expectedVersion' });

  const post = await db.findOneById(COLLECTIONS.posts, id);
  if (!policies.canReadPost(ctx.viewer, post)) throw errors.notAccessible({ postId: id });
  if (!policies.canChangeVisibility(ctx.viewer, post, next)) {
    throw errors.forbidden({ reason: 'visibility can only shrink' });
  }

  const version = await db.updateWithVersion(COLLECTIONS.posts, id, expectedVersion, {
    visibility: next,
    // 权限版本号递增：用于媒体链接与缓存失效
    permissionVersion: (post.permissionVersion || 0) + 1,
  });

  // 缩小范围后清理聚合入口：文集目录与收藏占位
  await db
    .coll(COLLECTIONS.collectionEntries)
    .where({ postId: id })
    .remove()
    .catch(() => {});

  return { ok: true, visibility: next, version };
}

/** DELETE /posts/{id} */
async function deletePost(payload, ctx) {
  const id = validators.requireId(payload.id, 'id');
  const expectedVersion = Number(payload.expectedVersion);
  if (!Number.isInteger(expectedVersion)) throw errors.invalidInput('缺少版本号', { field: 'expectedVersion' });

  const post = await db.findOneById(COLLECTIONS.posts, id);
  if (!policies.canReadPost(ctx.viewer, post)) throw errors.notAccessible({ postId: id });
  if (!policies.canDeletePost(ctx.viewer, post)) throw errors.forbidden({ reason: 'not owner' });

  await db.updateWithVersion(COLLECTIONS.posts, id, expectedVersion, {
    status: POST_STATUS.DELETED,
    deletedAt: db.serverDate(),
    permissionVersion: (post.permissionVersion || 0) + 1,
  });

  // 媒体权限回收 + 异步物理清理交给 worker
  await db
    .coll(COLLECTIONS.assets)
    .where({ postId: id })
    .update({ data: { status: 'revoked', updatedAt: db.serverDate() } })
    .catch(() => {});

  await db
    .coll(COLLECTIONS.collectionEntries)
    .where({ postId: id })
    .remove()
    .catch(() => {});

  return { ok: true };
}

/** PUT/DELETE /posts/{id}/reaction —— 幂等开关 */
async function toggleReaction(payload, ctx) {
  const id = validators.requireId(payload.id, 'id');
  const next = payload.next === true;

  const post = await db.findOneById(COLLECTIONS.posts, id);
  if (!policies.canInteract(ctx.viewer, post)) throw errors.notAccessible({ postId: id });

  const docId = `${ctx.viewer.userId}:${id}`;
  const existing = await db.findOneById(COLLECTIONS.reactions, docId);

  if (next && !existing) {
    await db.coll(COLLECTIONS.reactions).add({
      data: { _id: docId, userId: ctx.viewer.userId, postId: id, type: 'resonance', createdAt: db.serverDate() },
    });
    await db.incCounter(COLLECTIONS.posts, id, 'reactionCount', 1);
  } else if (!next && existing) {
    await db.coll(COLLECTIONS.reactions).doc(docId).remove();
    await db.incCounter(COLLECTIONS.posts, id, 'reactionCount', -1);
  }

  return { ok: true };
}

/** PUT/DELETE /posts/{id}/bookmark */
async function toggleBookmark(payload, ctx) {
  const id = validators.requireId(payload.id, 'id');
  const next = payload.next === true;

  const post = await db.findOneById(COLLECTIONS.posts, id);
  if (!policies.canInteract(ctx.viewer, post)) throw errors.notAccessible({ postId: id });

  const docId = `${ctx.viewer.userId}:${id}`;
  const existing = await db.findOneById(COLLECTIONS.bookmarks, docId);

  if (next && !existing) {
    await db.coll(COLLECTIONS.bookmarks).add({
      data: { _id: docId, userId: ctx.viewer.userId, postId: id, createdAt: db.serverDate() },
    });
  } else if (!next && existing) {
    await db.coll(COLLECTIONS.bookmarks).doc(docId).remove();
  }

  return { ok: true };
}

/** GET /posts/{id}/comments —— 一级评论 + 定向回复 */
async function listComments(payload, ctx) {
  const id = validators.requireId(payload.id, 'id');
  const post = await db.findOneById(COLLECTIONS.posts, id);
  if (!policies.canReadPost(ctx.viewer, post)) throw errors.notAccessible({ postId: id });

  const res = await db
    .coll(COLLECTIONS.comments)
    .where({
      postId: id,
      // 仅作者能在刷新后看到自己的待审回应。
      ...(ctx.viewer.userId ? { $or: [
        { status: POST_STATUS.PUBLISHED },
        { status: POST_STATUS.PENDING, ownerId: ctx.viewer.userId },
      ] } : { status: POST_STATUS.PUBLISHED }),
    })
    .orderBy('createdAt', 'asc')
    .limit(100)
    .get();

  const comments = res.data || [];
  const namedIds = comments.filter((c) => c.identityMode !== IDENTITY_MODE.ANONYMOUS).map((c) => c.ownerId);
  const users = await db.findByIds(COLLECTIONS.users, namedIds);
  const userById = new Map(users.map((u) => [u._id, u]));

  // 线程内匿名别名：同一用户在同帖内保持一致
  const aliasRes = await db
    .coll(COLLECTIONS.anonymousIdentities)
    .where({ threadId: id })
    .limit(100)
    .get()
    .catch(() => ({ data: [] }));
  const aliasByUser = new Map((aliasRes.data || []).map((d) => [d.userId, d.alias]));

  const topLevel = comments.filter((c) => !c.replyToId);
  const repliesByParent = new Map();
  comments
    .filter((c) => c.replyToId)
    .forEach((c) => {
      if (!repliesByParent.has(c.replyToId)) repliesByParent.set(c.replyToId, []);
      repliesByParent.get(c.replyToId).push(c);
    });

  const items = topLevel.map((comment) =>
    presenters.presentComment(comment, {
      authorUser: userById.get(comment.ownerId),
      alias: aliasByUser.get(comment.ownerId),
      isAuthor: comment.ownerId === post.ownerId,
      now: ctx.now,
      replies: (repliesByParent.get(comment._id) || []).map((reply) =>
        presenters.presentComment(reply, {
          authorUser: userById.get(reply.ownerId),
          alias: aliasByUser.get(reply.ownerId),
          isAuthor: reply.ownerId === post.ownerId,
          now: ctx.now,
        }),
      ),
    }),
  );

  if (process.env.NODE_ENV !== 'production') anonymity.assertNoIdentityLeak(items, 'comments');
  return { items, nextCursor: null };
}

/** POST /posts/{id}/comments —— 提交后 pending，审核通过才展示 */
async function createComment(payload, ctx) {
  if (!policies.canUsePublishing(ctx.viewer, ctx.capabilities)) throw errors.forbidden({ reason: 'publishing unavailable' });
  const id = validators.requireId(payload.id, 'id');
  const input = validators.validateCommentInput(payload);

  const post = await db.findOneById(COLLECTIONS.posts, id);
  if (!policies.canReadPost(ctx.viewer, post)) throw errors.notAccessible({ postId: id });
  if (!policies.canComment(ctx.viewer, post)) throw errors.forbidden({ reason: 'comments disabled or not member' });

  // replyTo 必须属于同帖
  if (input.replyToId) {
    const parent = await db.findOneById(COLLECTIONS.comments, input.replyToId);
    if (!parent || parent.postId !== id) throw errors.invalidInput('回复对象不存在', { field: 'replyToId' });
  }

  const key = validators.requireString(payload.idempotencyKey, '请求标识', { max: 120 });
  const commentId = randomUUID();
  const createdAt = db.serverDate();
  const identityMode = post.identityMode === IDENTITY_MODE.ANONYMOUS && post.ownerId === ctx.viewer.userId
    ? IDENTITY_MODE.ANONYMOUS : input.identityMode;
  const comment = { _id: commentId, postId: id, ownerId: ctx.viewer.userId,
    replyToId: input.replyToId, body: input.body, identityMode,
    status: POST_STATUS.PENDING, version: 1, createdAt, updatedAt: createdAt };
  let alias = null;
  if (identityMode === IDENTITY_MODE.ANONYMOUS) {
    const derived = anonymity.deriveAlias(id, ctx.viewer.userId, process.env.ANON_ALIAS_SECRET);
    alias = { _id: randomUUID(), threadId: id, userId: ctx.viewer.userId, ...derived,
      isThreadAuthor: post.ownerId === ctx.viewer.userId, createdAt };
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, ...input, identityMode })).digest('hex');
  try {
    const created = await db.getDb().rpc('hg_create_comment', {
      p_key: `${ctx.viewer.userId}:createComment:${key}`, p_hash: fingerprint,
      p_comment: comment, p_alias: alias,
    });
    await require('./foreground-review').runOwnedReview('comment', created.id, ctx).catch(() => null);
    const current = await db.findOneById(COLLECTIONS.comments, created.id);
    return { ...created, state: current?.status || 'pending' };
  } catch (err) {
    if (/IDEMPOTENCY_|COMMENT_TARGET_CHANGED/.test(err.message)) throw errors.conflict('内容或请求状态已变化，请刷新后重试');
    throw err;
  }
}

/** GET /me/contents —— 我的内容各状态列表 */
async function listMyContents(payload, ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();

  const tab = validators.requireEnum(payload.tab || 'published', 'tab', [
    'published',
    'pending',
    'private',
    'bookmark',
  ]);
  const cursor = validators.parseCursor(payload.cursor);
  const pageSize = validators.clampPageSize(payload.pageSize);
  const _ = db.command();

  let where;
  if (tab === 'bookmark') {
    // 收藏：先取收藏关系，再逐条复核权限 —— 失效项返回占位而非摘要
    const bookmarks = await db.paginate(
      COLLECTIONS.bookmarks,
      { userId: ctx.viewer.userId },
      { cursor, pageSize },
    );
    const posts = await db.findByIds(
      COLLECTIONS.posts,
      bookmarks.items.map((b) => b.postId),
    );
    const readable = posts.filter((p) => policies.canListPost(ctx.viewer, p));
    const cards = await hydrateCards(readable, ctx);

    const readableIds = new Set(readable.map((p) => p._id));
    const stale = bookmarks.items
      .filter((b) => !readableIds.has(b.postId))
      .map((b) => ({ id: b.postId, unavailable: true, placeholder: '这条内容当前不可访问' }));

    return {
      items: [...cards, ...stale],
      nextCursor:
        bookmarks.hasMore && bookmarks.items.length > 0
          ? validators.buildCursor(bookmarks.items[bookmarks.items.length - 1])
          : null,
    };
  }

  if (tab === 'published') {
    where = {
      ownerId: ctx.viewer.userId,
      status: POST_STATUS.PUBLISHED,
      visibility: _.in([VISIBILITY.PUBLIC, VISIBILITY.CLUB]),
    };
  } else if (tab === 'pending') {
    where = {
      ownerId: ctx.viewer.userId,
      status: _.in([POST_STATUS.PENDING, POST_STATUS.REJECTED, POST_STATUS.HIDDEN, POST_STATUS.UPLOADING]),
    };
  } else {
    where = { ownerId: ctx.viewer.userId, visibility: VISIBILITY.PRIVATE, status: POST_STATUS.PUBLISHED };
  }

  const { items, hasMore } = await db.paginate(COLLECTIONS.posts, where, { cursor, pageSize });
  const ownItems = items.map((post) => post.status === POST_STATUS.HIDDEN
    ? { ...post, body: '', title: '已暂时隐藏的内容', assetIds: [] } : post);
  const cards = await hydrateCards(ownItems, ctx);
  return {
    items: cards,
    nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
  };
}

/** POST /reports —— 举报回执，不暴露举报人 */
async function createReport(payload, ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();

  const targetType = validators.requireEnum(payload.targetType, 'targetType', ['post', 'comment']);
  const targetId = validators.requireId(payload.targetId, 'targetId');
  const reason = validators.requireString(payload.reason, '举报原因', { max: 200 });

  if (targetType === 'post') {
    const post = await db.findOneById(COLLECTIONS.posts, targetId);
    if (!policies.canReportPost(ctx.viewer, post)) throw errors.notAccessible({ targetId });
  }

  const added = await db.coll(COLLECTIONS.reports).add({
    data: {
      targetType,
      targetId,
      // reporterId 存在受限集合，任何面向用户的响应都不返回
      reporterId: ctx.viewer.userId,
      reason,
      evidence: validators.requireString(payload.evidence, '补充说明', { max: 500, allowEmpty: true }),
      status: 'received',
      createdAt: db.serverDate(),
    },
  });

  await db.coll(COLLECTIONS.notifications).add({
    data: {
      recipientId: ctx.viewer.userId,
      eventType: NOTIFY_TYPE.SYSTEM_REPORT,
      title: '已收到你的举报',
      summary: '运营者会核查。举报不等于认定违规。',
      targetType,
      targetId,
      icon: 'flag',
      createdAt: db.serverDate(),
    },
  });

  return { receiptId: added._id, state: 'received' };
}

module.exports = {
  listFeed,
  getDetail,
  createPost,
  changeVisibility,
  deletePost,
  toggleReaction,
  toggleBookmark,
  listComments,
  createComment,
  listMyContents,
  createReport,
  buildFeedWhere,
  hydrateCards,
};
