/** 内容创建、重提、范围调整与删除。 */
const { randomUUID, createHash } = require('node:crypto');
const {
  COLLECTIONS,
  POST_STATUS,
  VISIBILITY,
  IDENTITY_MODE,
  ASSET_STATUS,
  DEFAULT_CLUB_ID,
} = require('../../shared/constants');
const policies = require('../../shared/policies');
const validators = require('../../shared/validators');
const errors = require('../../shared/errors');
const db = require('../../shared/db');
const anonymity = require('../../shared/anonymity');
const foregroundReview = require('../foreground-review');

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
  const [assets, topic, board] = await Promise.all([
    input.assetIds.length > 0 ? db.findByIds(COLLECTIONS.assets, input.assetIds) : Promise.resolve([]),
    input.topicId ? db.findOneById(COLLECTIONS.topics, input.topicId) : Promise.resolve(null),
    input.boardId ? db.findOneById(COLLECTIONS.boards, input.boardId) : Promise.resolve(null),
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
  if (input.boardId && !policies.canPostToBoard(ctx.viewer, board, ctx.capabilities)) {
    throw errors.notAccessible({ boardId: input.boardId });
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
      boardId: input.boardId,
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
      await foregroundReview.runOwnedReview('post', created.id, ctx).catch(() => null);
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
    await foregroundReview.runOwnedReview('post', id, ctx).catch(() => null);
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
    ...(next === VISIBILITY.PRIVATE ? { boardId: '' } : {}),
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

module.exports = { createPost, resubmitRejectedPost, changeVisibility, deletePost };
