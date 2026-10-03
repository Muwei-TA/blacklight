/** 会话与成员资格用例 */

const crypto = require('node:crypto');
const { COLLECTIONS, MEMBER_STATUS, NOTIFY_TYPE } = require('../shared/constants');
const validators = require('../shared/validators');
const presenters = require('../shared/presenters');
const errors = require('../shared/errors');
const db = require('../shared/db');
const { checkRateLimit } = require('../shared/session');

/** GET /session/me —— 冷启动恢复会话 */
async function me(payload, ctx) {
  return presenters.presentSession({
    viewer: ctx.viewer,
    user: ctx.user,
    capabilities: ctx.capabilities,
    club: ctx.club,
  });
}

/** Account bootstrap deliberately carries no selected community. */
async function accountMe(payload, ctx) {
  return presenters.presentSession({
    viewer: ctx.viewer,
    user: ctx.user,
    capabilities: ctx.capabilities,
    club: null,
  });
}

/**
 * POST /membership/applications —— 提交入社申请
 * 有效邀请码在事务内直接激活普通成员；被移除成员仍走人工恢复。
 * 已提交成功的入社可安全重试，邀请码不会重复计次。
 */
async function apply(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();

  // 限频，防止暴力猜码
  const allowed = await checkRateLimit(ctx.viewer.userId, 'applyMembership', {
    windowMs: 10 * 60 * 1000,
    max: 5,
  });
  if (!allowed) throw errors.rateLimited({ action: 'applyMembership' });

  const displayName = validators.validateDisplayName(payload.displayName);
  const inviteCode = validators.requireString(payload.inviteCode, '邀请码', { max: 64 }).toUpperCase();
  if (!/^[A-F0-9]{8,64}$/.test(inviteCode)) {
    throw errors.invalidInput('邀请码无效或已过期', { field: 'inviteCode' });
  }
  const rulesVersion = validators.requireString(payload.rulesVersion, '规则版本', { max: 20 });
  const idempotencyKey = payload.idempotencyKey === undefined
    ? crypto.randomUUID()
    : validators.requireString(payload.idempotencyKey, 'idempotencyKey', { max: 100 });
  const codeHash = crypto.createHash('sha256').update(inviteCode, 'utf8').digest('hex');

  try {
    const store = db.getDb();
    if (!store || typeof store.rpc !== 'function') throw new Error('membership RPC is not configured');
    const result = await store.rpc('hg_apply_invitation', {
      p_actor_id: ctx.viewer.userId,
      p_input: { codeHash, displayName, rulesVersion, idempotencyKey },
      p_club_id: clubId,
    });
    if (result && result.error) {
      const detail = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      throw Object.assign(new Error(detail), { code: result.error.code || result.code || 'P0001' });
    }
    return result;
  } catch (error) {
    const marker = `${error && error.code ? error.code : ''} ${error && error.message ? error.message : ''}`;
    if (/INVITE_INVALID/.test(marker)) {
      // 统一文案，不区分「不存在 / 已过期 / 用尽」，减少枚举空间。
      throw errors.invalidInput('邀请码无效或已过期', { field: 'inviteCode' });
    }
    if (/RULES_VERSION_INVALID/.test(marker)) {
      throw errors.invalidInput('规则版本已更新，请刷新后重试', { field: 'rulesVersion' });
    }
    if (/RATE_LIMITED/.test(marker)) throw errors.rateLimited();
    if (/RESERVATION_EXPIRED/.test(marker)) throw errors.conflict('入社申请已过期，请使用新邀请码重新申请');
    if (/ALREADY_MEMBER/.test(marker)) throw errors.invalidInput('你已经是社内成员');
    if (/FORBIDDEN/.test(marker)) throw errors.forbidden();
    if (/INVALID/.test(marker)) throw errors.invalidInput('请求参数不合法');
    throw error;
  }
}

/** GET /membership/applications/mine —— 申请状态与理由 */
async function myApplication(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();

  const res = await db
    .coll(COLLECTIONS.membershipApplications, clubId)
    .where({ userId: ctx.viewer.userId, clubId })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get()
    .catch(() => ({ data: [] }));

  if (!res.data || res.data.length === 0) return { state: MEMBER_STATUS.NONE, reason: '' };
  const app = res.data[0];
  const rawVersion = Number(app.version);
  const version = Number.isSafeInteger(rawVersion) && rawVersion > 0 ? rawVersion : 1;
  const applicationId = typeof app._id === 'string' ? app._id : (typeof app.id === 'string' ? app.id : '');
  return {
    applicationId,
    version,
    reservationExpiresAt: typeof app.reservationExpiresAt === 'string' ? app.reservationExpiresAt : null,
    state: app.status,
    reason: app.decisionReason || '',
    appliedAtText: presenters.formatRelativeTime(app.createdAt, ctx.now),
  };
}

/** PATCH /me/profile —— 昵称与头像。不采集手机号、位置、学号。 */
async function updateProfile(payload, ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();

  const data = { updatedAt: db.serverDate() };
  if (payload.displayName !== undefined) data.displayName = validators.validateDisplayName(payload.displayName);
  if (payload.avatarAssetId !== undefined) {
    const assetId = validators.optionalId(payload.avatarAssetId, 'avatarAssetId');
    if (assetId) throw errors.forbidden({ reason: 'avatar upload disabled' });
  }

  await db.coll(COLLECTIONS.users).doc(ctx.viewer.userId).update({ data });
  const user = await db.findOneById(COLLECTIONS.users, ctx.viewer.userId);
  return presenters.presentUser(user);
}

/** GET /me/profile —— 个人页统计。仅面向本人。 */
async function myProfile(payload, ctx) {
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  const clubId = ctx.viewer.clubId;
  const _ = db.command();

  const [posts, bookmarks, topics] = await Promise.all([
    db.coll(COLLECTIONS.posts, clubId).where({ clubId, ownerId: ctx.viewer.userId, status: _.neq('deleted') }).count(),
    db.coll(COLLECTIONS.bookmarks, clubId).where({ clubId, userId: ctx.viewer.userId }).count(),
    db.coll(COLLECTIONS.topicFollows, clubId).where({ clubId, userId: ctx.viewer.userId }).count(),
  ]);

  return {
    user: presenters.presentUser(ctx.user),
    memberSince: ctx.membership
      ? `${presenters.formatRelativeTime(ctx.membership.joinedAt, ctx.now)}加入`
      : '社内成员',
    // 统计只给本人；不得作为公开徽章
    stats: { posts: posts.total, bookmarks: bookmarks.total, topics: topics.total },
  };
}

/**
 * GET /profile/{userId} —— 对外社员主页。
 * 只返回署名且当前访问者有权阅读的作品；不含匿名历史与私密统计。
 *
 * 参数命名说明：用 targetUserId 而非 userId，明确它是"被查看者"，
 * 避免与"调用者身份"混淆 —— 调用者身份只能来自 ctx.viewer。
 */
async function publicProfile(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  const targetUserId = validators.requireId(payload.targetUserId, 'targetUserId');
  const posts = require('./posts');
  const where = posts.buildFeedWhere(ctx.viewer, {
    ownerId: targetUserId,
    // 关键：排除匿名内容，匿名历史不出现在主页
    identityMode: 'named',
  });

  // 用户 / 成员资格 / 作品列表互不依赖，并行取回
  const [user, membershipRes, page] = await Promise.all([
    db.findOneById(COLLECTIONS.users, targetUserId),
    db
      .coll(COLLECTIONS.memberships, clubId)
      .where({ userId: targetUserId, clubId })
      .limit(1)
      .get()
      .catch(() => ({ data: [] })),
    db.paginate(COLLECTIONS.posts, where, {
      cursor: validators.parseCursor(payload.cursor),
      pageSize: validators.clampPageSize(payload.pageSize),
      clubId,
    }),
  ]);
  if (!user) throw errors.notAccessible({ targetUserId });
  if (!membershipRes.data || membershipRes.data.length === 0) throw errors.notAccessible({ targetUserId });
  const isActive = membershipRes.data && membershipRes.data[0] && membershipRes.data[0].status === MEMBER_STATUS.ACTIVE;

  const cards = await posts.hydrateCards(page.items, ctx);

  return {
    user: presenters.presentUser(user),
    memberStatusText: isActive ? '社内成员' : '已不在社内',
    // 计数按当前访问者可见集合计算，不暴露社内发帖总量
    visibleCount: cards.length,
    items: cards,
    nextCursor: page.hasMore && page.items.length > 0
      ? validators.buildCursor(page.items[page.items.length - 1])
      : null,
  };
}

/** POST /me/exports —— 异步导出任务 */
async function requestExport(payload, ctx) {
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  if (!ctx.capabilities.export) throw errors.forbidden({ reason: 'export capability disabled' });

  await db.writeAudit({
    actorId: ctx.viewer.userId,
    action: 'export.request',
    targetType: 'user',
    targetId: ctx.viewer.userId,
    clubId: ctx.viewer.clubId,
  });

  await db.coll(COLLECTIONS.notifications, ctx.viewer.clubId).add({
    data: {
      recipientId: ctx.viewer.userId,
      clubId: ctx.viewer.clubId,
      eventType: NOTIFY_TYPE.SYSTEM_NOTICE,
      title: '导出任务已创建',
      summary: '完成后会在这里通知你。',
      targetType: 'system',
      targetId: 'export',
      icon: 'download',
      createdAt: db.serverDate(),
    },
  });

  return { state: 'queued' };
}

/**
 * DELETE /me/account —— 注销申请。
 * 不立即物理删除：先停止展示，再按保留策略由 worker 清理。
 * 失败时状态保持 pending，绝不返回虚假的"已完成"。
 */
async function requestAccountDeletion(payload, ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();
  const confirm = validators.requireString(payload.confirm, '确认串', { max: 20 });
  if (confirm !== '注销') throw errors.invalidInput('请输入「注销」以确认', { field: 'confirm' });

  try { return await db.getDb().rpc('hg_request_account_deletion', { p_user: ctx.viewer.userId }); }
  catch (err) {
    if (/LAST_MODERATOR/.test(err.message)) throw errors.conflict('请先指定另一位管理员，再申请注销');
    throw err;
  }
}

module.exports = {
  me,
  accountMe,
  apply,
  myApplication,
  updateProfile,
  myProfile,
  publicProfile,
  requestExport,
  requestAccountDeletion,
};
