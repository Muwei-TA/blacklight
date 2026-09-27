/** 话题领域用例 */

const { createHash } = require('node:crypto');
const { COLLECTIONS, TOPIC_STATUS, DEFAULT_CLUB_ID } = require('../shared/constants');
const policies = require('../shared/policies');
const validators = require('../shared/validators');
const presenters = require('../shared/presenters');
const errors = require('../shared/errors');
const db = require('../shared/db');
const { escapeRegex } = require('./search');

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
  const cursor = validators.parseCursor(payload.cursor);
  const pageSize = validators.clampPageSize(payload.pageSize);

  // Topics are club-only. Do not run a title query for guests.
  if (!ctx.viewer.isMember) return { items: [], nextCursor: null };

  const activeOnly = payload.status !== undefined && payload.status !== null && payload.status !== '';
  if (activeOnly) validators.requireEnum(payload.status, 'status', [TOPIC_STATUS.ACTIVE]);
  const query = payload.q === undefined || payload.q === null || payload.q === ''
    ? ''
    : validators.validateSearchQuery(payload.q);
  const _ = db.command();

  const where = { clubId: DEFAULT_CLUB_ID };
  if (payload.category && payload.category !== 'all') {
    where.category = validators.requireString(payload.category, 'category', { max: 20 });
  }

  if (activeOnly) {
    // Apply the requested board status before cursor pagination so archived
    // and pending rows cannot crowd active boards off the page.
    where.status = TOPIC_STATUS.ACTIVE;
  } else if (ctx.viewer.isAdmin) {
    where.status = _.in([TOPIC_STATUS.ACTIVE, TOPIC_STATUS.ARCHIVED, TOPIC_STATUS.PENDING]);
  } else {
    // 待审话题只有提交者本人能看到自己的
    where.$or = [
      { status: _.in([TOPIC_STATUS.ACTIVE, TOPIC_STATUS.ARCHIVED]) },
      { status: TOPIC_STATUS.PENDING, ownerId: ctx.viewer.userId },
    ];
  }

  if (query) {
    where.title = db.getDb().RegExp({ regexp: escapeRegex(query), options: 'i' });
  }

  const { items, hasMore } = await db.paginate(COLLECTIONS.topics, where, { cursor, pageSize });

  const follows = ctx.viewer.userId
    ? await db
        .coll(COLLECTIONS.topicFollows)
        .where({ userId: ctx.viewer.userId, topicId: _.in(items.map((t) => t._id)) })
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
  const id = validators.requireId(payload.id, 'id');
  const topic = await db.findOneById(COLLECTIONS.topics, id);
  if (!policies.canReadTopic(ctx.viewer, topic)) throw errors.notAccessible({ topicId: id });

  const posts = require('./posts');
  const where = posts.buildFeedWhere(ctx.viewer, { topicId: id });
  const { items, hasMore } = await db.paginate(COLLECTIONS.posts, where, {
    cursor: validators.parseCursor(payload.cursor),
    pageSize: validators.clampPageSize(payload.pageSize),
  });

  const follow = ctx.viewer.userId
    ? await db.findOneById(COLLECTIONS.topicFollows, `${ctx.viewer.userId}:${id}`)
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

function findTopicsByTitle(title) {
  return db
    .coll(COLLECTIONS.topics)
    .where({ clubId: DEFAULT_CLUB_ID, title })
    .limit(100)
    .get()
    .then((result) => result.data || []);
}

function duplicateTopicResult(topic, viewer) {
  if (!topic) return null;
  if (!policies.canReadTopic(viewer, topic)) {
    // Do not disclose another member's pending topic id or status.
    throw errors.conflict('已有同名话题正在审核，请更换名称后再试');
  }
  return { duplicated: true, id: topic._id, status: topic.status };
}

function topicIdForTitle(title) {
  // A stable id makes simultaneous submissions of the same trimmed title
  // collide on the primary key, without adding a schema migration.
  return createHash('sha256').update(`${DEFAULT_CLUB_ID}\0${title}`, 'utf8').digest('hex');
}

/** POST /topics —— 社员提交话题，进入待审；同名引导参与 */
async function create(payload, ctx) {
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  const input = validators.validateTopicInput(payload);

  // Archived titles remain reserved; reopening is an administrative decision.
  // Prefer a readable active board, then archived, then the caller's pending
  // row. A hidden pending match is reported without its id or status.
  const matchesForTitle = await findTopicsByTitle(input.title);
  const readableMatches = matchesForTitle.filter((topic) => policies.canReadTopic(ctx.viewer, topic));
  const duplicate =
    readableMatches.find((topic) => topic.status === TOPIC_STATUS.ACTIVE)
    || readableMatches.find((topic) => topic.status === TOPIC_STATUS.ARCHIVED)
    || readableMatches.find((topic) => topic.status === TOPIC_STATUS.PENDING && topic.ownerId === ctx.viewer.userId)
    || readableMatches[0];
  if (duplicate) return duplicateTopicResult(duplicate, ctx.viewer);
  if (matchesForTitle.some((topic) => topic.status === TOPIC_STATUS.PENDING)) {
    throw errors.conflict('已有同名话题正在审核，请更换名称后再试');
  }

  const id = topicIdForTitle(input.title);
  const data = {
    _id: id,
    clubId: DEFAULT_CLUB_ID,
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
  };

  let added;
  try {
    added = await db.coll(COLLECTIONS.topics).add({ data });
  } catch (error) {
    if (String(error && error.code) !== '23505') throw error;
    const raced = await db.findOneById(COLLECTIONS.topics, id);
    if (!raced || raced.clubId !== DEFAULT_CLUB_ID || raced.title !== input.title) throw error;
    return duplicateTopicResult(raced, ctx.viewer);
  }

  return { duplicated: false, id: added._id, status: TOPIC_STATUS.PENDING };
}

/** PUT/DELETE /topics/{id}/follow —— 关注只是把话题存到「我的话题」 */
async function toggleFollow(payload, ctx) {
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  const id = validators.requireId(payload.id, 'id');
  const next = payload.next === true;

  const topic = await db.findOneById(COLLECTIONS.topics, id);
  if (!policies.canReadTopic(ctx.viewer, topic)) throw errors.notAccessible({ topicId: id });

  const docId = `${ctx.viewer.userId}:${id}`;
  const existing = await db.findOneById(COLLECTIONS.topicFollows, docId);

  if (next && !existing) {
    await db.coll(COLLECTIONS.topicFollows).add({
      data: { _id: docId, userId: ctx.viewer.userId, topicId: id, createdAt: db.serverDate() },
    });
  } else if (!next && existing) {
    await db.coll(COLLECTIONS.topicFollows).doc(docId).remove();
  }

  return { ok: true };
}

/** GET /me/topics —— 我关注的话题 */
async function myFollows(payload, ctx) {
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();

  const follows = await db.paginate(
    COLLECTIONS.topicFollows,
    { userId: ctx.viewer.userId },
    { cursor: validators.parseCursor(payload.cursor), pageSize: validators.clampPageSize(payload.pageSize) },
  );

  const topics = await db.findByIds(
    COLLECTIONS.topics,
    follows.items.map((f) => f.topicId),
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
