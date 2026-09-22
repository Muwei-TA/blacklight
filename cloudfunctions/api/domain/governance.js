/**
 * 成员治理与申诉用例。
 *
 * 这些写入必须走 PG 的 hg_governance RPC：RPC 在同一事务中重新校验
 * moderator 身份、目标状态/版本、业务变更、审计和通知。云函数只负责
 * 校验形状、读取作者内容以调用纯策略，并把可信 actorId 从 ctx.viewer
 * 传入；绝不接受客户端字段作为调用者身份。
 */

const { COLLECTIONS, ROLE } = require('../shared/constants');
const policies = require('../shared/policies');
const validators = require('../shared/validators');
const errors = require('../shared/errors');
const db = require('../shared/db');

const APPEAL_DECISIONS = ['approve', 'reject'];
const MANAGEABLE_ROLES = [ROLE.MEMBER, ROLE.MODERATOR, ROLE.ADMIN];
const APPEAL_DTO_FIELDS = [
  'appealId',
  'postId',
  'contentVersion',
  'status',
  'reason',
  'decision',
  'decisionReason',
  'version',
  'createdAt',
  'updatedAt',
];
const MEMBER_DTO_FIELDS = ['targetUserId', 'displayName', 'role', 'status', 'mutedUntil', 'version'];
const DEFAULT_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

function requiredReason(payload, field = 'reason') {
  return validators.requireString(payload[field], '处理理由', { max: 500 });
}

function requiredExpectedVersion(payload) {
  const version = Number(payload.expectedVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw errors.invalidInput('缺少版本号', { field: 'expectedVersion' });
  }
  return version;
}

function requireMemberManager(ctx, targetUserId) {
  if (!policies.canManageTargetMember(ctx.viewer, targetUserId)) {
    throw errors.forbidden({ reason: 'member management requires moderator and cannot target self' });
  }
}

function mapGovernanceError(error) {
  const marker = `${error && error.code ? error.code : ''} ${error && error.message ? error.message : ''}`;
  if (/VERSION_CONFLICT|APPEAL_EXISTS|IDEMPOTENCY_CONFLICT|CONFLICT/.test(marker)) {
    return errors.conflict('目标已被更新，请刷新后重试', { field: 'expectedVersion' });
  }
  if (/NOT_FOUND|NOT_OWNER|POST_NOT_APPEALABLE|APPEAL_NOT_FOUND/.test(marker)) {
    return errors.notAccessible();
  }
  if (/LAST_MODERATOR|FORBIDDEN|SELF_TARGET|ROLE_INVALID/.test(marker)) {
    return errors.forbidden();
  }
  if (/INVALID|REASON_REQUIRED/.test(marker)) {
    return errors.invalidInput('请求参数不合法');
  }
  return error;
}

async function callGovernance(action, input, ctx) {
  try {
    const store = db.getDb();
    if (!store || typeof store.rpc !== 'function') {
      throw new Error('governance RPC is not configured');
    }
    return await store.rpc('hg_governance', {
      p_action: action,
      p_actor_id: ctx.viewer.userId,
      p_input: input,
    });
  } catch (error) {
    const mapped = mapGovernanceError(error);
    if (mapped !== error) throw mapped;
    throw error;
  }
}

async function callAdminGovernance(action, input, ctx) {
  try {
    const store = db.getDb();
    if (!store || typeof store.rpc !== 'function') {
      throw new Error('governance admin RPC is not configured');
    }
    return await store.rpc('hg_governance_admin', {
      p_action: action,
      p_actor_id: ctx.viewer.userId,
      p_input: input,
    });
  } catch (error) {
    const mapped = mapGovernanceError(error);
    if (mapped !== error) throw mapped;
    throw error;
  }
}

async function callInviteCreate(input, ctx) {
  try {
    const store = db.getDb();
    if (!store || typeof store.rpc !== 'function') {
      throw new Error('invite RPC is not configured');
    }
    return await store.rpc('hg_create_invite', {
      p_actor_id: ctx.viewer.userId,
      p_input: input,
    });
  } catch (error) {
    const mapped = mapGovernanceError(error);
    if (mapped !== error) throw mapped;
    throw error;
  }
}

/** `admin/member/remove`: moderator removes another active member. */
async function removeMember(payload, ctx) {
  const targetUserId = validators.requireId(payload.targetUserId, 'targetUserId');
  requireMemberManager(ctx, targetUserId);
  const expectedVersion = requiredExpectedVersion(payload);
  const reason = requiredReason(payload);
  return callGovernance('member.remove', { targetUserId, expectedVersion, reason }, ctx);
}

/** `admin/member/mute`: mutedUntil=null is an explicit unmute. */
async function muteMember(payload, ctx) {
  const targetUserId = validators.requireId(payload.targetUserId, 'targetUserId');
  requireMemberManager(ctx, targetUserId);
  const expectedVersion = requiredExpectedVersion(payload);
  const reason = requiredReason(payload);

  let mutedUntil = null;
  if (payload.mutedUntil !== null) {
    const raw = validators.requireString(payload.mutedUntil, 'mutedUntil', { max: 40 });
    const timestamp = new Date(raw).getTime();
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
      throw errors.invalidInput('mutedUntil 必须是未来时间', { field: 'mutedUntil' });
    }
    mutedUntil = new Date(timestamp).toISOString();
  }

  return callGovernance('member.mute', { targetUserId, expectedVersion, mutedUntil, reason }, ctx);
}

/** `admin/member/role`: role changes are guarded against self-promotion. */
async function changeMemberRole(payload, ctx) {
  const targetUserId = validators.requireId(payload.targetUserId, 'targetUserId');
  requireMemberManager(ctx, targetUserId);
  const expectedVersion = requiredExpectedVersion(payload);
  const requestedRole = payload['role'];
  const role = validators.requireEnum(requestedRole, 'role', MANAGEABLE_ROLES);
  const reason = requiredReason(payload);
  return callGovernance('member.role', { targetUserId, expectedVersion, role, reason }, ctx);
}

/** `appeals/create`: the read is only to apply the shared author/status policy. */
async function createAppeal(payload, ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();
  const postId = validators.requireId(payload.postId, 'postId');
  const reason = validators.requireString(payload.reason, '申诉理由', { max: 1000 });
  const post = await db.findOneById(COLLECTIONS.posts, postId);
  if (!policies.canSubmitAppeal(ctx.viewer, post)) throw errors.notAccessible({ postId });

  const contentVersion = post.version || 1;
  if (payload.contentVersion !== undefined && Number(payload.contentVersion) !== contentVersion) {
    throw errors.conflict('内容版本已变化，请刷新后重试', { field: 'contentVersion' });
  }

  return callGovernance('appeal.create', {
    postId,
    ownerId: ctx.viewer.userId,
    contentVersion,
    reason,
  }, ctx);
}

/** `admin/appeal/decide`: both decisions require a reason and are audited. */
async function decideAppeal(payload, ctx) {
  if (!policies.canDecideAppeal(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });
  const appealId = validators.requireId(payload.appealId, 'appealId');
  const expectedVersion = requiredExpectedVersion(payload);
  const decision = validators.requireEnum(payload.decision, 'decision', APPEAL_DECISIONS);
  const reason = requiredReason(payload);
  return callGovernance('appeal.decide', { appealId, expectedVersion, decision, reason }, ctx);
}

/**
 * Keep appeal reads as an explicit allow-list DTO.  The RPC already projects
 * these fields, but this second boundary prevents a future SQL change from
 * accidentally returning post bodies, owner identity, or reporter data.
 */
function presentAppeal(item = {}) {
  return Object.fromEntries(APPEAL_DTO_FIELDS.map((field) => [field, item[field] === undefined ? null : item[field]]));
}

function presentAppealList(result) {
  return {
    ok: result && result.ok === true,
    items: result && Array.isArray(result.items) ? result.items.map(presentAppeal) : [],
  };
}

/** `appeals/mine`: an authenticated author can see only their own appeal DTOs. */
async function listMyAppeals(payload = {}, ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();
  const limit = validators.clampPageSize(payload.limit);
  return presentAppealList(await callGovernance('appeals.mine', { limit }, ctx));
}

/** `admin/appeals/list`: moderation queue with no private post content. */
async function listAppeals(payload = {}, ctx) {
  if (!policies.canDecideAppeal(ctx.viewer)) throw errors.forbidden({ reason: 'not moderator' });
  const limit = validators.clampPageSize(payload.limit);
  return presentAppealList(await callGovernance('admin.appeals.list', { limit }, ctx));
}

function presentMember(item = {}) {
  return Object.fromEntries(MEMBER_DTO_FIELDS.map((field) => [field, item[field] === undefined ? null : item[field]]));
}

function presentMemberList(result) {
  return {
    ok: result && result.ok === true,
    items: result && Array.isArray(result.items) ? result.items.map(presentMember) : [],
  };
}

/** `admin/members/list`: moderator-only roster projection without openid. */
async function listMembers(payload = {}, ctx) {
  if (!policies.canManageMembers(ctx.viewer)) throw errors.forbidden({ reason: 'member roster requires moderator' });
  const limit = validators.clampPageSize(payload.limit);
  return presentMemberList(await callAdminGovernance('members.list', { limit }, ctx));
}

function parseBoundedInteger(value, field, { fallback, min, max }) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw errors.invalidInput(`${field} 不合法`, { field });
  }
  return number;
}

/** `admin/invites/create`: server generates and returns a one-time invite secret. */
async function createInvite(payload = {}, ctx) {
  if (!policies.canManageMembers(ctx.viewer)) throw errors.forbidden({ reason: 'invite creation requires moderator' });
  const maxUses = parseBoundedInteger(payload.maxUses, 'maxUses', { fallback: 1, min: 1, max: 1000 });
  const ttlSeconds = parseBoundedInteger(payload.ttlSeconds, 'ttlSeconds', {
    fallback: DEFAULT_INVITE_TTL_SECONDS,
    min: 60,
    max: 90 * 24 * 60 * 60,
  });
  // The returned code is intentionally not logged or copied into audit input.
  return callInviteCreate({ maxUses, ttlSeconds }, ctx);
}

module.exports = {
  removeMember,
  muteMember,
  changeMemberRole,
  createAppeal,
  decideAppeal,
  listMyAppeals,
  listAppeals,
  listMembers,
  createInvite,
  presentAppeal,
  presentAppealList,
  presentMember,
  presentMemberList,
  APPEAL_DECISIONS,
  MANAGEABLE_ROLES,
  APPEAL_DTO_FIELDS,
  MEMBER_DTO_FIELDS,
  DEFAULT_INVITE_TTL_SECONDS,
  mapGovernanceError,
};
