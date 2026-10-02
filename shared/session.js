/**
 * 会话解析：openid → 内部用户 → 成员资格 → viewer。
 *
 * 硬约束：
 * 1. openid 只能来自 cloud.getWXContext()，绝不接受客户端传入；
 * 2. 成员资格每次请求实时查询，不缓存到客户端可控的地方 ——
 *    退社/被移除必须立即生效（docs/05 5.4）；
 * 3. 解析失败一律降级为访客（fail-closed），不抛异常中断只读接口。
 */

const { COLLECTIONS, ROLE, MEMBER_STATUS, DEFAULT_CLUB_ID } = require('./constants');
const { coll, findOneById, serverDate, command } = require('./db');
const { buildViewer } = require('./policies');
const errors = require('./errors');
const validators = require('./validators');

/** 能力开关默认全关。读取失败时保持关闭（fail-closed）。 */
const DEFAULT_CAPABILITIES = {
  publishing: false,
  uploads: false,
  publicScope: false,
  video: false,
  anthology: false,
  export: false,
};

/**
 * 按 openid 查内部用户；不存在则创建。
 * openid 存在 wxOpenIdRef 字段，且该字段不进入任何 DTO。
 */
async function resolveUser(openid) {
  if (!openid) return null;

  const res = await coll(COLLECTIONS.users).where({ wxOpenIdRef: openid }).limit(1).get();
  if (res.data && res.data.length > 0) return res.data[0];

  let added;
  try {
    added = await coll(COLLECTIONS.users).add({
    data: {
      wxOpenIdRef: openid,
      displayName: '',
      avatar: '',
      status: 'active',
      createdAt: serverDate(),
      updatedAt: serverDate(),
    },
  });
  } catch (err) {
    if (!/23505/.test(String(err.code))) throw err;
    const raced = await coll(COLLECTIONS.users).where({ wxOpenIdRef: openid }).limit(1).get();
    if (!raced.data[0]) throw err;
    return raced.data[0];
  }
  return findOneById(COLLECTIONS.users, added._id);
}

async function resolveMembership(userId, clubId = DEFAULT_CLUB_ID) {
  if (!userId) return null;
  const res = await coll(COLLECTIONS.memberships, clubId).where({ userId, clubId }).limit(1).get();
  return res.data && res.data.length > 0 ? res.data[0] : null;
}

/** 社团配置与能力开关。未知/停用社团没有默认兜底。 */
async function loadClubConfig(clubId = DEFAULT_CLUB_ID) {
  const doc = await findOneById(COLLECTIONS.clubConfig, clubId, clubId);
  if (!doc || (doc.status || (doc._id === DEFAULT_CLUB_ID ? 'active' : 'paused')) !== 'active') {
    throw errors.notAccessible({ clubId });
  }
  return {
    ...doc,
    clubId: doc.clubId || doc._id,
    capabilities: { ...DEFAULT_CAPABILITIES, ...(doc.capabilities || {}) },
  };
}

/**
 * 解析完整上下文。每个 handler 执行前调用一次。
 * @returns {{ viewer, user, membership, club, capabilities }}
 */
async function resolveContext(openid, clubId = DEFAULT_CLUB_ID) {
  const requestedClubId = validators.requireId(clubId, 'clubId');
  // 社团配置与用户解析互不依赖：并行取回，缩短每个请求的固定串行开销
  const [club, user] = await Promise.all([
    loadClubConfig(requestedClubId),
    openid ? resolveUser(openid) : null,
  ]);
  const capabilities = club.capabilities;

  if (!user || user.status !== 'active') {
    return { viewer: buildViewer({ clubId: requestedClubId }), user: null, membership: null, club, capabilities };
  }

  const membership = await resolveMembership(user._id, requestedClubId);
  const viewer = buildViewer({
    userId: user._id,
    platformRole: user.platformRole,
    role: membership ? membership.role || ROLE.MEMBER : ROLE.GUEST,
    memberStatus: membership ? membership.status : MEMBER_STATUS.NONE,
    clubId: requestedClubId,
    mutedUntil: membership ? membership.mutedUntil || null : null,
  });

  return { viewer, user, membership, club, capabilities };
}

/** Account-wide context used only by the club directory actions. */
async function resolveDirectoryContext(openid) {
  const user = openid ? await resolveUser(openid) : null;
  const activeUser = user && user.status === 'active' ? user : null;
  return {
    viewer: buildViewer({ userId: activeUser ? activeUser._id : null, platformRole: activeUser ? activeUser.platformRole : 'none', clubId: null }),
    user: activeUser,
    membership: null,
    club: null,
    capabilities: { ...DEFAULT_CAPABILITIES },
  };
}

/**
 * 简单频次限制。用于邀请码校验、举报、搜索等易滥用入口。
 * 基于 users 文档上的计数窗口，够用且不引入额外依赖。
 */
async function checkRateLimit(userId, action, { windowMs = 60 * 1000, max = 10 } = {}) {
  if (!userId) return true;
  const _ = command();
  const now = Date.now();
  const field = `rate.${action}`;

  const user = await findOneById(COLLECTIONS.users, userId);
  const bucket = (user && user.rate && user.rate[action]) || null;

  if (bucket && now - bucket.startedAt < windowMs) {
    if (bucket.count >= max) return false;
    await coll(COLLECTIONS.users)
      .doc(userId)
      .update({ data: { [`${field}.count`]: _.inc(1) } })
      .catch(() => {});
    return true;
  }

  await coll(COLLECTIONS.users)
    .doc(userId)
    .update({ data: { [field]: { startedAt: now, count: 1 } } })
    .catch(() => {});
  return true;
}

module.exports = {
  DEFAULT_CAPABILITIES,
  resolveUser,
  resolveMembership,
  loadClubConfig,
  resolveContext,
  resolveDirectoryContext,
  checkRateLimit,
};
