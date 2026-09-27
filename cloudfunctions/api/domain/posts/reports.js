/** 举报受理与回执。 */
const { COLLECTIONS, NOTIFY_TYPE } = require('../../shared/constants');
const policies = require('../../shared/policies');
const validators = require('../../shared/validators');
const errors = require('../../shared/errors');
const db = require('../../shared/db');

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

module.exports = { createReport };
