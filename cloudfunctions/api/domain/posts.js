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

  // 附件与话题互不依赖：并行取回后再校验，缩短发布链路的串行开销
  const [assets, topic] = await Promise.all([
    input.assetIds.length > 0 ? db.findByIds(COLLECTIONS.assets, input.assetIds) : Promise.resolve([]),
    input.topicId ? db.findOneById(COLLECTIONS.topics, input.topicId) : Promise.resolve(null),
  ]);

  // 校验附件归属与状态：只能绑定本人已验证的附件
  let hasVideo = false;
  if (input.assetIds.length > 0) {
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
  if (input.topicId && !policies.canPostToTopic(ctx.viewer, topic)) {
    throw errors.notAccessible({ topicId: input.topicId });
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

/** PATCH /posts/{id}/resubmit —— 只修改被退回内容的文字，保留原附件与受众。 */
async function resubmitRejectedPost(payload, ctx) {
  const id = validators.requireId(payload.id, 'id');
  const expectedVersion = Number(payload.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw errors.invalidInput('缺少版本号', { field: 'expectedVersion' });
  }
  const idempotencyKey = validators.requireString(payload.idempotencyKey, '请求标识', { max: 120 });
  const post = await db.findOneById(COLLECTIONS.posts, id);
  if (!post || post.ownerId !== ctx.viewer.userId) throw errors.notAccessible({ postId: id });
  if (!policies.canUsePublishing(ctx.viewer, ctx.capabilities)
    || (post.status === POST_STATUS.REJECTED
      && !policies.canResubmitRejectedPost(ctx.viewer, post, ctx.capabilities))) {
    throw errors.forbidden({ reason: 'post is not resubmittable' });
  }
  if (post.visibility === VISIBILITY.PUBLIC && !policies.canUsePublicVisibility(ctx.viewer, ctx.capabilities)) {
    throw errors.forbidden({ reason: 'publicScope disabled' });
  }
  // An identical retry may arrive after the first call advanced the version.
  // The PG idempotency row decides whether it is a replay or a conflict.
  if (post.status === POST_STATUS.REJECTED && post.version !== expectedVersion) throw errors.conflict();
  const input = validators.validatePostInput({
    ...post,
    title: payload.title,
    body: payload.body,
  });
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ id, expectedVersion, title: input.title, body: input.body }))
    .digest('hex');
  try {
    const result = await db.getDb().rpc('hg_resubmit_rejected_post', {
      p_key: `${ctx.viewer.userId}:resubmitPost:${idempotencyKey}`,
      p_hash: fingerprint,
      p_actor_id: ctx.viewer.userId,
      p_post_id: id,
      p_expected_version: expectedVersion,
      p_title: input.title,
      p_body: input.body,
    });
    await require('./foreground-review').runOwnedReview('post', id, ctx).catch(() => null);
    const current = await db.findOneById(COLLECTIONS.posts, id);
    return { ...result, state: current?.status || result.state, version: current?.version || result.version };
  } catch (err) {
    if (/IDEMPOTENCY_|VERSION_CONFLICT|POST_NOT_REJECTED|ASSET_BINDING_CONFLICT/.test(err.message)) {
      throw errors.conflict('内容已变化，请刷新后重试');
    }
    if (/FORBIDDEN/.test(err.message)) throw errors.forbidden();
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

  // 原帖与旗下回应的共鸣记录一并回收
  await db
    .coll(COLLECTIONS.reactions)
    .where({ postId: id })
    .remove()
    .catch(() => {});

  return { ok: true };
}

/** PUT/DELETE /posts/{id}/reaction —— 幂等开关 */
async function toggleReaction(payload, ctx) {
  const id = validators.requireId(payload.id, 'id');
  const next = payload.next === true;

  const docId = `${ctx.viewer.userId}:${id}`;
  const [post, existing] = await Promise.all([
    db.findOneById(COLLECTIONS.posts, id),
    db.findOneById(COLLECTIONS.reactions, docId),
  ]);
  if (!policies.canInteract(ctx.viewer, post)) throw errors.notAccessible({ postId: id });

  if (next && !existing) {
    // 并发双击撞唯一 _id 时按"已共鸣"处理，不重复计数
    const added = await db.coll(COLLECTIONS.reactions)
      .add({
        data: { _id: docId, userId: ctx.viewer.userId, postId: id, type: 'resonance', createdAt: db.serverDate() },
      })
      .catch((err) => {
        if (!/23505|duplicate key/i.test(`${err.code || ''} ${err.message || ''}`)) throw err;
        return null;
      });
    if (added !== null) await db.incCounter(COLLECTIONS.posts, id, 'reactionCount', 1);
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

  const docId = `${ctx.viewer.userId}:${id}`;
  const [post, existing] = await Promise.all([
    db.findOneById(COLLECTIONS.posts, id),
    db.findOneById(COLLECTIONS.bookmarks, docId),
  ]);
  if (!policies.canInteract(ctx.viewer, post)) throw errors.notAccessible({ postId: id });

  if (next && !existing) {
    await db.coll(COLLECTIONS.bookmarks)
      .add({
        data: { _id: docId, userId: ctx.viewer.userId, postId: id, createdAt: db.serverDate() },
      })
      .catch((err) => {
        // 并发双击撞唯一 _id：视为已收藏，幂等成功
        if (!/23505|duplicate key/i.test(`${err.code || ''} ${err.message || ''}`)) throw err;
      });
  } else if (!next && existing) {
    await db.coll(COLLECTIONS.bookmarks).doc(docId).remove();
  }

  return { ok: true };
}

/** 当前用户在多条回应上的共鸣标记；计数存于评论文档 reactionCount 字段 */
async function loadMyCommentFlags(userId, commentIds) {
  if (!userId || commentIds.length === 0) return new Set();
  const _ = db.command();
  const res = await db
    .coll(COLLECTIONS.reactions)
    .where({ userId, commentId: _.in(commentIds) })
    .limit(commentIds.length)
    .get()
    .catch(() => ({ data: [] }));
  return new Set((res.data || []).map((r) => r.commentId));
}

/** GET /posts/{id}/comments —— 一级评论 + 定向回复 */
async function listComments(payload, ctx) {
  const id = validators.requireId(payload.id, 'id');
  const post = await db.findOneById(COLLECTIONS.posts, id);
  if (!policies.canReadPost(ctx.viewer, post)) throw errors.notAccessible({ postId: id });

  const _ = db.command();
  const res = await db
    .coll(COLLECTIONS.comments)
    .where({
      postId: id,
      // 仅作者能在刷新后看到自己的待审回应；已删除的一级回应取回用于墓碑判断
      ...(ctx.viewer.userId ? { $or: [
        { status: _.in([POST_STATUS.PUBLISHED, POST_STATUS.DELETED]) },
        { status: POST_STATUS.PENDING, ownerId: ctx.viewer.userId },
      ] } : { status: _.in([POST_STATUS.PUBLISHED, POST_STATUS.DELETED]) }),
    })
    .orderBy('createdAt', 'asc')
    .limit(100)
    .get();

  // 已删除的定向回复不展示；已删除的一级回应保留用于墓碑判断
  const comments = (res.data || []).filter((c) => !c.replyToId || c.status !== POST_STATUS.DELETED);
  const namedIds = comments
    .filter((c) => c.identityMode !== IDENTITY_MODE.ANONYMOUS && c.status !== POST_STATUS.DELETED)
    .map((c) => c.ownerId);
  const publishedIds = comments.filter((c) => c.status === POST_STATUS.PUBLISHED).map((c) => c._id);

  // 用户 / 匿名别名 / 我的共鸣标记互不依赖，并行取回
  const [users, aliasRes, myCommentReactions] = await Promise.all([
    db.findByIds(COLLECTIONS.users, namedIds),
    // 线程内匿名别名：同一用户在同帖内保持一致
    db
      .coll(COLLECTIONS.anonymousIdentities)
      .where({ threadId: id })
      .limit(100)
      .get()
      .catch(() => ({ data: [] })),
    loadMyCommentFlags(ctx.viewer.userId, publishedIds),
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

/** PUT/DELETE /posts/{id}/comments/{commentId}/reaction —— 幂等开关 */
async function toggleCommentReaction(payload, ctx) {
  const commentId = validators.requireId(payload.commentId, 'commentId');
  const next = payload.next === true;

  const docId = ctx.viewer.userId + ':comment:' + commentId;
  const [comment, existing] = await Promise.all([
    db.findOneById(COLLECTIONS.comments, commentId),
    db.findOneById(COLLECTIONS.reactions, docId),
  ]);
  // 待审/已删除的回应不可共鸣；无权与不存在返回同一形态
  if (!comment || comment.status !== POST_STATUS.PUBLISHED) throw errors.notAccessible({ commentId });
  if (payload.id && comment.postId !== payload.id) throw errors.invalidInput('回应不属于这条内容', { field: 'commentId' });
  const post = await db.findOneById(COLLECTIONS.posts, comment.postId);
  if (!policies.canInteract(ctx.viewer, post)) throw errors.notAccessible({ postId: comment.postId });

  if (next && !existing) {
    // 并发双击撞唯一 _id 时按"已共鸣"处理，不重复计数
    const added = await db.coll(COLLECTIONS.reactions)
      .add({
        // postId 便于随原帖一并回收；worker 共鸣聚合只统计无 commentId 的记录
        data: { _id: docId, userId: ctx.viewer.userId, postId: comment.postId, commentId, type: 'resonance', createdAt: db.serverDate() },
      })
      .catch((err) => {
        if (!/23505|duplicate key/i.test(`${err.code || ''} ${err.message || ''}`)) throw err;
        return null;
      });
    if (added !== null) await db.incCounter(COLLECTIONS.comments, commentId, 'reactionCount', 1);
  } else if (!next && existing) {
    await db.coll(COLLECTIONS.reactions).doc(docId).remove();
    await db.incCounter(COLLECTIONS.comments, commentId, 'reactionCount', -1);
  }

  return { ok: true };
}

/** DELETE /posts/{id}/comments/{commentId} —— 评论者删除自己的回应 */
async function deleteComment(payload, ctx) {
  const commentId = validators.requireId(payload.commentId, 'commentId');
  const expectedVersion = Number(payload.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw errors.invalidInput('缺少版本号', { field: 'expectedVersion' });
  }

  const comment = await db.findOneById(COLLECTIONS.comments, commentId);
  if (!comment) throw errors.notAccessible({ commentId });
  const post = await db.findOneById(COLLECTIONS.posts, comment.postId);
  if (!policies.canReadPost(ctx.viewer, post)) throw errors.notAccessible({ postId: comment.postId });
  if (!policies.canDeleteComment(ctx.viewer, comment)) throw errors.forbidden({ reason: 'not comment author' });

  const wasPublished = comment.status === POST_STATUS.PUBLISHED;
  await db.updateWithVersion(COLLECTIONS.comments, commentId, expectedVersion, {
    status: POST_STATUS.DELETED,
    deletedAt: db.serverDate(),
  });

  if (wasPublished) await db.incCounter(COLLECTIONS.posts, comment.postId, 'commentCount', -1);

  // 这条回应的共鸣记录一并回收；其定向回复保留，父级以墓碑占位
  await db
    .coll(COLLECTIONS.reactions)
    .where({ commentId })
    .remove()
    .catch(() => {});

  return { ok: true };
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
  resubmitRejectedPost,
  changeVisibility,
  deletePost,
  toggleReaction,
  toggleBookmark,
  listComments,
  createComment,
  toggleCommentReaction,
  deleteComment,
  listMyContents,
  createReport,
  buildFeedWhere,
  hydrateCards,
};
