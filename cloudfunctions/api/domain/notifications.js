/**
 * 站内通知用例。
 *
 * 关键：渲染前必须复核 target 是否仍可访问。
 * 成员资格失效后，旧通知不能成为读取社内内容的侧门（docs/05 5.5）。
 */

const { COLLECTIONS, NOTIFY_TYPE } = require('../shared/constants');
const policies = require('../shared/policies');
const validators = require('../shared/validators');
const presenters = require('../shared/presenters');
const errors = require('../shared/errors');
const db = require('../shared/db');

const ADMIN_TARGETS = ['admin_queue', 'admin_appeals'];

const REPLY_TYPES = [NOTIFY_TYPE.COMMENT, NOTIFY_TYPE.REPLY, NOTIFY_TYPE.REACTION_DIGEST];

/** GET /notifications */
async function list(payload, ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();
  const clubId = ctx.viewer.clubId;

  const tab = validators.requireEnum(payload.tab || 'reply', 'tab', ['reply', 'system']);
  const cursor = validators.parseCursor(payload.cursor);
  const pageSize = validators.clampPageSize(payload.pageSize);
  const _ = db.command();

  const where = {
    recipientId: ctx.viewer.userId,
    clubId,
    eventType: tab === 'reply' ? _.in(REPLY_TYPES) : _.nin(REPLY_TYPES),
  };

  if (!policies.canAccessModeration(ctx.viewer)) where.targetType = _.nin(ADMIN_TARGETS);

  const { items, hasMore } = await db.paginate(COLLECTIONS.notifications, where, { cursor, pageSize, clubId });

  // 复核每条通知指向的内容是否仍可访问
  const postIds = items.filter((n) => n.targetType === 'post').map((n) => n.targetId);
  const posts = await db.findByIds(COLLECTIONS.posts, postIds, clubId);
  const postById = new Map(posts.map((p) => [p._id, p]));

  const dtos = items.map((notification) => {
    let accessible = true;
    if (notification.targetType === 'post') {
      accessible = policies.canReadPost(ctx.viewer, postById.get(notification.targetId));
    }
    return presenters.presentNotification(notification, { accessible, now: ctx.now });
  });

  return {
    items: dtos,
    nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
  };
}

/** POST /notifications/read-all —— 只更新本人状态 */
async function markAllRead(payload, ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();
  const clubId = ctx.viewer.clubId;

  await db
    .coll(COLLECTIONS.notifications, clubId)
    .where({ recipientId: ctx.viewer.userId, clubId, readAt: null })
    .update({ data: { readAt: db.serverDate() } })
    .catch(() => {});

  return { ok: true };
}

/** GET /notifications/unread-count */
async function unreadCount(payload, ctx) {
  if (!ctx.viewer.isAuthenticated) return { count: 0 };
  const clubId = ctx.viewer.clubId;

  const where = { recipientId: ctx.viewer.userId, clubId, readAt: null };
  if (!policies.canAccessModeration(ctx.viewer)) where.targetType = db.command().nin(ADMIN_TARGETS);

  const res = await db
    .coll(COLLECTIONS.notifications, clubId)
    .where(where)
    .count()
    .catch(() => ({ total: 0 }));

  return { count: res.total || 0 };
}

module.exports = { list, markAllRead, unreadCount };
