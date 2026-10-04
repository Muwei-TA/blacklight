/** 信息流、详情读取及卡片装配。 */
const {
  COLLECTIONS,
  POST_STATUS,
  VISIBILITY,
  IDENTITY_MODE,
  BOARD_STATUS,
} = require('../../shared/constants');
const policies = require('../../shared/policies');
const validators = require('../../shared/validators');
const presenters = require('../../shared/presenters');
const errors = require('../../shared/errors');
const db = require('../../shared/db');
const anonymity = require('../../shared/anonymity');
const assetDomain = require('../assets');

/**
 * 构造信息流的权限过滤条件。
 * ⚠️ 这是"先鉴权再查询"的关键：过滤条件直接进 where，
 * 而不是查出来再在内存里筛（那样 total 与分页都会泄露信息）。
 */
function buildFeedWhere(viewer, extra = {}) {
  const _ = db.command();
  const base = {
    clubId: viewer.clubId,
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
  const clubId = ctx.viewer.clubId;

  const namedOwnerIds = posts
    .filter((p) => p.identityMode !== IDENTITY_MODE.ANONYMOUS)
    .map((p) => p.ownerId);
  const assetIds = posts.flatMap((p) => p.assetIds || []);
  const topicIds = posts.map((p) => p.topicId).filter(Boolean);
  const boardIds = posts.map((p) => p.boardId).filter(Boolean);
  const postIds = posts.map((p) => p._id);

  const [users, assets, topics, boards, myReactions, myBookmarks, aliasDocs] = await Promise.all([
    db.findByIds(COLLECTIONS.users, namedOwnerIds),
    db.findByIds(COLLECTIONS.assets, assetIds, clubId),
    db.findByIds(COLLECTIONS.topics, topicIds, clubId),
    db.findByIds(COLLECTIONS.boards, boardIds, clubId),
    ctx.viewer.userId ? loadMyFlags(COLLECTIONS.reactions, ctx.viewer.userId, postIds, clubId) : Promise.resolve(new Set()),
    ctx.viewer.userId ? loadMyFlags(COLLECTIONS.bookmarks, ctx.viewer.userId, postIds, clubId) : Promise.resolve(new Set()),
    loadAliases(posts, clubId),
  ]);

  const userById = new Map(users.map((u) => [u._id, u]));
  const topicById = new Map(topics.map((t) => [t._id, t]));
  const boardById = new Map(boards.map((b) => [b._id, b]));

  const readableAssets = await assetDomain.signReadableAssets(assets, posts, ctx);
  return posts.map((post) => {
    const card = presenters.presentPostCard(post, {
      viewer: ctx.viewer,
      authorUser: userById.get(post.ownerId),
      alias: aliasDocs.get(post._id),
      assets: readableAssets,
      topic: topicById.get(post.topicId),
      board: policies.canReadBoard(ctx.viewer, boardById.get(post.boardId)) ? boardById.get(post.boardId) : null,
      reacted: myReactions.has(post._id),
      bookmarked: myBookmarks.has(post._id),
      now: ctx.now,
    });
    if (post.format === 'richtext-v1') {
      card.assets = readableAssets.filter((a) => (post.assetIds || []).includes(a._id)).map((a) => ({ assetId: a._id, status: a.status, width: a.width || 0, height: a.height || 0, url: policies.canReadRichAsset(ctx.viewer, a, post, { version: post.version }) ? require('../drafts').mediaUrl(a, post) : '' }));
      card.coverUrl = card.assets.find((a) => a.assetId === post.coverAssetId)?.url || card.assets.find((a) => a.url)?.url || '';
    }
    return card;
  });
}

async function loadMyFlags(collection, userId, postIds, clubId) {
  const _ = db.command();
  const res = await db
    .coll(collection, clubId)
    .where({
      userId,
      clubId,
      postId: _.in(postIds),
      // 评论共鸣与原帖共鸣共表；收藏查询不附加共鸣类型条件。
      ...(collection === COLLECTIONS.reactions ? { commentId: _.exists(false) } : {}),
    })
    .limit(postIds.length)
    .get()
    .catch(() => ({ data: [] }));
  return new Set((res.data || []).map((r) => r.postId));
}

/**
 * 读取匿名帖的 alias。
 * 只取 alias 字段；userId 映射留在受限集合中，不进入这里的返回值。
 */
async function loadAliases(posts, clubId) {
  const anonPosts = posts.filter((p) => p.identityMode === IDENTITY_MODE.ANONYMOUS);
  if (anonPosts.length === 0) return new Map();

  const _ = db.command();
  const res = await db
    .coll(COLLECTIONS.anonymousIdentities, clubId)
    .where({ clubId, threadId: _.in(anonPosts.map((p) => p._id)), isThreadAuthor: true })
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
  const boardId = validators.optionalId(payload.boardId, 'boardId');
  if (boardId) {
    const board = await db.findOneById(COLLECTIONS.boards, boardId, ctx.viewer.clubId);
    if (!policies.canReadBoard(ctx.viewer, board)) throw errors.notAccessible({ boardId });
    if (board.status !== BOARD_STATUS.ACTIVE) return { items: [], nextCursor: null };
    extra.boardId = boardId;
  }
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
  const { items, hasMore } = await db.paginate(COLLECTIONS.posts, where, { cursor, pageSize, clubId: ctx.viewer.clubId });

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
  const post = await db.findOneById(COLLECTIONS.posts, id, ctx.viewer.clubId);

  if (!policies.canReadPost(ctx.viewer, post)) {
    throw errors.notAccessible({ postId: id, role: ctx.viewer.role });
  }

  const [authorUser, assets, topic, board, aliasMap, reacted, bookmarked, consent] = await Promise.all([
    post.identityMode === IDENTITY_MODE.ANONYMOUS
      ? Promise.resolve(null)
      : db.findOneById(COLLECTIONS.users, post.ownerId),
    db.findByIds(COLLECTIONS.assets, post.assetIds || [], ctx.viewer.clubId),
    post.topicId ? db.findOneById(COLLECTIONS.topics, post.topicId, ctx.viewer.clubId) : Promise.resolve(null),
    post.boardId ? db.findOneById(COLLECTIONS.boards, post.boardId, ctx.viewer.clubId) : Promise.resolve(null),
    loadAliases([post], ctx.viewer.clubId),
    ctx.viewer.userId ? loadMyFlags(COLLECTIONS.reactions, ctx.viewer.userId, [id], ctx.viewer.clubId) : Promise.resolve(new Set()),
    ctx.viewer.userId ? loadMyFlags(COLLECTIONS.bookmarks, ctx.viewer.userId, [id], ctx.viewer.clubId) : Promise.resolve(new Set()),
    db.findOneById(COLLECTIONS.consents, `${id}:collection`, ctx.viewer.clubId),
  ]);

  const readableAssets = await assetDomain.signReadableAssets(assets, [post], ctx);
  const dto = presenters.presentPostDetail(post, {
    viewer: ctx.viewer,
    authorUser,
    alias: aliasMap.get(post._id),
    assets: readableAssets,
    topic,
    board: policies.canReadBoard(ctx.viewer, board) ? board : null,
    reacted: reacted.has(id),
    bookmarked: bookmarked.has(id),
    collectionGranted: !!(consent && !consent.revokedAt),
    now: ctx.now,
  });

  if (post.format === 'richtext-v1') {
    let reviewReady = false;
    if (ctx.viewer.isAdmin && post.status === 'pending') {
      const tasks = await db.coll(COLLECTIONS.reviewTasks, ctx.viewer.clubId).where({ clubId: ctx.viewer.clubId, targetType: 'post', targetId: id, postVersion: post.version, status: 'manual' }).limit(1).get();
      reviewReady = tasks.data.length > 0;
    }
    dto.assets = assets.map((asset) => ({ assetId: asset._id, status: asset.status, width: asset.width || 0, height: asset.height || 0,
      url: policies.canReadRichAsset(ctx.viewer, asset, post, { version: post.version, reviewReady }) ? require('../drafts').mediaUrl(asset, post) : '' }));
  }
  if (process.env.NODE_ENV !== 'production') anonymity.assertNoIdentityLeak(dto, 'detail');
  return dto;
}

module.exports = { listFeed, getDetail, buildFeedWhere, hydrateCards };
