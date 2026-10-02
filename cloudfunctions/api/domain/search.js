/**
 * 站内搜索用例。
 *
 * 核心顺序：**先鉴权，再匹配，再排序分页**。
 * 反面做法（先全量匹配再过滤）会通过总数与分页边界泄露私密内容的存在。
 *
 * 其他约束：
 * - 匿名帖不得因搜索真实作者昵称而被检出
 * - 仅自己的内容不进站内搜索（只在「我的私密手记」里另查）
 * - 搜索日志不长期留存原始关键词明文
 */

const { COLLECTIONS, VISIBILITY, POST_STATUS } = require('../shared/constants');
const validators = require('../shared/validators');
const presenters = require('../shared/presenters');
const errors = require('../shared/errors');
const db = require('../shared/db');
const policies = require('../shared/policies');

/** 转义正则元字符，防止用户输入被当作模式执行 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** GET /search */
async function search(payload, ctx) {
  const q = validators.validateSearchQuery(payload.q);
  const clubId = ctx.viewer.clubId;
  const scope = validators.requireEnum(payload.scope || 'post', 'scope', ['post', 'topic']);
  const pageSize = validators.clampPageSize(payload.pageSize);
  const _ = db.command();
  const pattern = db.getDb().RegExp({ regexp: escapeRegex(q), options: 'i' });

  if (scope === 'topic') {
    if (!ctx.viewer.isMember) return { items: [], nextCursor: null };
    const res = await db
      .coll(COLLECTIONS.topics, clubId)
      .where(
        _.and([
          { clubId },
          { status: _.in(['active', 'archived']) },
          _.or([{ title: pattern }, { description: pattern }]),
        ]),
      )
      .limit(pageSize)
      .get()
      .catch(() => ({ data: [] }));

    return {
      items: (res.data || []).map((topic) =>
        presenters.presentTopic(topic, { viewer: ctx.viewer, statsText: '', followed: false }),
      ),
      nextCursor: null,
    };
  }

  const posts = require('./posts');

  // 权限条件先进 where：访客只搜公开，成员搜公开+社内，私密永不参与
  const scopeWhere = ctx.viewer.isMember
    ? { visibility: _.in([VISIBILITY.PUBLIC, VISIBILITY.CLUB]) }
    : { visibility: VISIBILITY.PUBLIC };

  // 游标分页（权限条件在 where 内，分页边界不泄露内容存在性）。
  // 只匹配正文与标题；作者昵称不参与匹配，
  // 否则搜真实昵称就能反查出该用户的匿名帖
  const where = {
    status: POST_STATUS.PUBLISHED,
    ...scopeWhere,
    $or: [{ title: pattern }, { body: pattern }],
  };
  const { items, hasMore } = await db.paginate(COLLECTIONS.posts, { ...where, clubId }, {
    cursor: validators.parseCursor(payload.cursor),
    pageSize,
    clubId,
  });

  // 二次复核（防御性：即使 where 写错，也不会漏出）
  const readable = items.filter((post) => policies.canListPost(ctx.viewer, post));
  const cards = await posts.hydrateCards(readable, ctx);

  return {
    items: cards,
    nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
  };
}

/**
 * GET /search/suggestions —— 编辑维护的推荐词。
 * 绝不从私密内容或用户草稿中自动抽取。
 */
async function suggestions(payload, ctx) {
  const club = ctx.club || {};
  const words = Array.isArray(club.searchSuggestions) ? club.searchSuggestions : [];
  return { items: words.slice(0, 12) };
}

/** GET /me/private-search —— 仅在自己的私密手记内查找 */
async function searchPrivate(payload, ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();
  const clubId = ctx.viewer.clubId;
  const q = validators.validateSearchQuery(payload.q);
  const pattern = db.getDb().RegExp({ regexp: escapeRegex(q), options: 'i' });

  const { items, hasMore } = await db.paginate(
    COLLECTIONS.posts,
    {
      clubId,
      ownerId: ctx.viewer.userId,
      visibility: VISIBILITY.PRIVATE,
      status: POST_STATUS.PUBLISHED,
      $or: [{ title: pattern }, { body: pattern }],
    },
    { cursor: validators.parseCursor(payload.cursor), pageSize: validators.clampPageSize(payload.pageSize), clubId },
  );

  const posts = require('./posts');
  return {
    items: await posts.hydrateCards(items, ctx),
    nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
  };
}

module.exports = { search, suggestions, searchPrivate, escapeRegex };
