/** 话题领域用例 */

const { COLLECTIONS, TOPIC_STATUS } = require('../shared/constants');
const policies = require('../shared/policies');
const validators = require('../shared/validators');
const presenters = require('../shared/presenters');
const errors = require('../shared/errors');
const db = require('../shared/db');

const CATEGORY_TEXT = {
  life: '生活',
  reading: '阅读',
  inspiration: '灵感',
  confide: '倾诉',
  event: '活动',
  play: '共玩',
};

/** GET /topics */
async function list(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  const cursor = validators.parseCursor(payload.cursor);
  const pageSize = validators.clampPageSize(payload.pageSize);
  const _ = db.command();

  const where = { clubId };
  if (payload.category && payload.category !== 'all') {
    where.category = validators.requireString(payload.category, 'category', { max: 20 });
  }

  if (ctx.viewer.isAdmin) {
    where.status = _.in([TOPIC_STATUS.ACTIVE, TOPIC_STATUS.ARCHIVED, TOPIC_STATUS.PENDING]);
  } else if (ctx.viewer.isMember) {
    // 待审话题只有提交者本人能看到自己的
    where.$or = [
      { status: _.in([TOPIC_STATUS.ACTIVE, TOPIC_STATUS.ARCHIVED]) },
      { status: TOPIC_STATUS.PENDING, ownerId: ctx.viewer.userId },
    ];
  } else {
    // 访客：首版话题均为社内，不返回任何话题
    return { items: [], nextCursor: null };
  }

  const { items, hasMore } = await db.paginate(COLLECTIONS.topics, where, { cursor, pageSize, clubId });

  const follows = ctx.viewer.userId
    ? await db
        .coll(COLLECTIONS.topicFollows, clubId)
        .where({ userId: ctx.viewer.userId, clubId, topicId: _.in(items.map((t) => t._id)) })
        .limit(items.length || 1)
        .get()
        .catch(() => ({ data: [] }))
    : { data: [] };
  const followed = new Set((follows.data || []).map((f) => f.topicId));

  return {
    items: items.map((topic) =>
      presenters.presentTopic(topic, {
        viewer: ctx.viewer,
        statsText: buildStatsText(topic),
        followed: followed.has(topic._id),
      }),
    ),
    nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
  };
}

function buildStatsText(topic) {
  if (topic.status === TOPIC_STATUS.ARCHIVED) return '已归档 · 可读不可新增';
  if (topic.status === TOPIC_STATUS.PENDING) return '';
  const count = topic.postCount || 0;
  return count > 0 ? `社内 · ${count} 人写过` : '社内 · 还没有人写过';
}

/** GET /topics/{id} —— 详情 + 参与内容 */
async function detail(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  const id = validators.requireId(payload.id, 'id');
  const topic = await db.findOneById(COLLECTIONS.topics, id, clubId);
  if (!policies.canReadTopic(ctx.viewer, topic)) throw errors.notAccessible({ topicId: id });

  const posts = require('./posts');
  const where = posts.buildFeedWhere(ctx.viewer, { topicId: id });
  const { items, hasMore } = await db.paginate(COLLECTIONS.posts, where, {
    cursor: validators.parseCursor(payload.cursor),
    pageSize: validators.clampPageSize(payload.pageSize),
    clubId,
  });

  const follow = ctx.viewer.userId
    ? await db.findOneById(COLLECTIONS.topicFollows, `${ctx.viewer.userId}:${id}`, clubId)
    : null;

  return {
    topic: presenters.presentTopic(topic, {
      viewer: ctx.viewer,
      statsText: buildStatsText(topic),
      followed: !!follow,
    }),
    canPost: policies.canPostToTopic(ctx.viewer, topic),
    items: await posts.hydrateCards(items, ctx),
    nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
  };
}

/** POST /topics —— 社员提交话题，进入待审；同名引导参与 */
async function create(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  const input = validators.validateTopicInput(payload);

  const existing = await db
    .coll(COLLECTIONS.topics, clubId)
    .where({ clubId, title: input.title })
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));

  if (existing.data && existing.data.length > 0) {
    // 不创建重复项，返回已有话题让前端引导参与
    return { duplicated: true, id: existing.data[0]._id, status: existing.data[0].status };
  }

  const added = await db.coll(COLLECTIONS.topics, clubId).add({
    data: {
      clubId,
      ownerId: ctx.viewer.userId,
      title: input.title,
      description: input.description,
      category: input.category,
      categoryText: CATEGORY_TEXT[input.category] || '',
      icon: 'chat-bubble-1',
      // 新话题一律社内，且需管理员确认
      status: TOPIC_STATUS.PENDING,
      postCount: 0,
      version: 1,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate(),
    },
  });

  return { duplicated: false, id: added._id, status: TOPIC_STATUS.PENDING };
}

/** PUT/DELETE /topics/{id}/follow —— 关注只是把话题存到「我的话题」 */
async function toggleFollow(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  const id = validators.requireId(payload.id, 'id');
  const next = payload.next === true;

  const topic = await db.findOneById(COLLECTIONS.topics, id, clubId);
  if (!policies.canReadTopic(ctx.viewer, topic)) throw errors.notAccessible({ topicId: id });

  const docId = `${ctx.viewer.userId}:${id}`;
  const existing = await db.findOneById(COLLECTIONS.topicFollows, docId, clubId);

  if (next && !existing) {
    await db.coll(COLLECTIONS.topicFollows, clubId).add({
      data: { _id: docId, userId: ctx.viewer.userId, clubId, topicId: id, createdAt: db.serverDate() },
    });
  } else if (!next && existing) {
    await db.coll(COLLECTIONS.topicFollows, clubId).doc(docId).remove();
  }

  return { ok: true };
}

/** GET /me/topics —— 我关注的话题 */
async function myFollows(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();

  const follows = await db.paginate(
    COLLECTIONS.topicFollows,
    { userId: ctx.viewer.userId, clubId },
    { cursor: validators.parseCursor(payload.cursor), pageSize: validators.clampPageSize(payload.pageSize), clubId },
  );

  const topics = await db.findByIds(
    COLLECTIONS.topics,
    follows.items.map((f) => f.topicId),
    clubId,
  );
  // 关注列表是本人数据，无计数泄露面；话题可读性在这里复核即可
  const readable = topics.filter((t) => policies.canReadTopic(ctx.viewer, t));

  return {
    items: readable.map((topic) =>
      presenters.presentTopic(topic, { viewer: ctx.viewer, statsText: buildStatsText(topic), followed: true }),
    ),
    // 游标基于 follows（本人数据）而非展示结果，被过滤的话题不会造成分页断头
    nextCursor: follows.hasMore && follows.items.length > 0
      ? validators.buildCursor(follows.items[follows.items.length - 1])
      : null,
  };
}

module.exports = { list, detail, create, toggleFollow, myFollows };
