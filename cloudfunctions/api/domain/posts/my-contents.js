/** 当前用户内容与收藏列表。 */
const { COLLECTIONS, POST_STATUS, VISIBILITY } = require('../../shared/constants');
const policies = require('../../shared/policies');
const validators = require('../../shared/validators');
const errors = require('../../shared/errors');
const db = require('../../shared/db');
const { hydrateCards } = require('./feed');

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

module.exports = { listMyContents };
