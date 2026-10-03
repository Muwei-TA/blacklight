/** 社团管理、邀请码生命周期、届次、交接与平台恢复的 API adapter。 */

const crypto = require('node:crypto');
const policies = require('../shared/policies');
const validators = require('../shared/validators');
const errors = require('../shared/errors');
const db = require('../shared/db');

const INVITE_MODES = ['application', 'direct'];
const ADMISSION_MODES = ['invite_required', 'closed'];
const MEMBER_STATUSES = ['all', 'active', 'removed', 'pending'];

const INVITE_FIELDS = [
  'inviteId', 'mode', 'status', 'maxUses', 'usedCount', 'reservedCount', 'expiresAt', 'version',
  'createdAt', 'revokedAt', 'targetUserId',
];
const MEMBER_FIELDS = ['targetUserId', 'displayName', 'role', 'status', 'mutedUntil', 'version', 'managementTermId'];
const HANDOVER_FIELDS = [
  'id', 'clubId', 'clubName', 'type', 'status', 'creatorId', 'targetUserId', 'primaryUserId', 'proposedTeam',
  'reason', 'expiresAt', 'createdAt', 'acceptedAt', 'version',
];
const RECOVERY_FIELDS = [
  'id', 'clubId', 'clubName', 'type', 'status', 'requesterId', 'targetUserId', 'primaryUserId', 'proposedTeam',
  'reason', 'expiresAt', 'createdAt', 'acceptedAt', 'approvedAt', 'version',
];
const AUDIT_FIELDS = ['id', 'actorId', 'action', 'targetType', 'targetId', 'decision', 'reason', 'createdAt'];

function requiredExpectedVersion(payload = {}, field = 'expectedVersion') {
  const version = Number(payload[field]);
  if (!Number.isInteger(version) || version < 1) throw errors.invalidInput('缺少版本号', { field });
  return version;
}

function requiredReason(payload = {}, { optional = false } = {}) {
  if (optional && (payload.reason === undefined || payload.reason === null || payload.reason === '')) return '';
  const reason = validators.requireString(payload.reason, '处理理由', { max: 500 });
  if (reason.length < 10) throw errors.invalidInput('处理理由至少需要 10 字', { field: 'reason', min: 10 });
  return reason;
}

function requiredNumber(value, field, { fallback, min, max }) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw errors.invalidInput(`${field} 不合法`, { field });
  }
  return number;
}

function mapManagementError(error) {
  const marker = `${error && error.code ? error.code : ''} ${error && error.message ? error.message : ''}`;
  if (/INVITE_INVALID/.test(marker)) return errors.invalidInput('邀请码无效或已过期', { field: 'inviteCode' });
  if (/RATE_LIMITED/.test(marker)) return errors.rateLimited();
  if (/VERSION_CONFLICT|HANDOVER_STALE|HANDOVER_EXPIRED|STALE|CONFLICT|PRIMARY_REQUIRED|PRIMARY_ALREADY_SET|TARGET_ALREADY_PRIMARY|HANDOVER_PENDING|TARGET_ACCEPTANCE_REQUIRED|RECOVERY_COOLDOWN|RECOVERY_SECOND_APPROVAL_REQUIRED|RECOVERY_EXPIRED|RESERVATION_EXPIRED/.test(marker)) {
    return errors.conflict('目标或权限状态已变化，请刷新后重试', { field: 'expectedVersion' });
  }
  if (/NOT_FOUND|CLUB_NOT_FOUND|CLUB_PAUSED|APPLICATION_NOT_FOUND|INVITE_NOT_FOUND|RECOVERY_NOT_FOUND|HANDOVER_NOT_FOUND|MANAGEMENT_TERM_NOT_FOUND/.test(marker)) {
    return errors.notAccessible();
  }
  if (/FORBIDDEN|LAST_MODERATOR|SELF_TARGET|TARGET_USER_INVALID|TARGET_MEMBERSHIP_INACTIVE|ROLE_INVALID/.test(marker)) {
    return errors.forbidden();
  }
  if (/REASON_REQUIRED|INVALID/.test(marker)) return errors.invalidInput('请求参数不合法');
  return error;
}

function resultError(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.ok === false && result.error) {
    const detail = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
    return Object.assign(new Error(detail), { code: result.error.code || result.code || 'P0001' });
  }
  if (result.error) {
    const detail = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
    return Object.assign(new Error(detail), { code: result.error.code || result.code || 'P0001' });
  }
  return null;
}

async function callManagementRpc(action, input, ctx, clubId = ctx.viewer.clubId) {
  try {
    const store = db.getDb();
    if (!store || typeof store.rpc !== 'function') throw new Error('admin management RPC is not configured');
    const result = await store.rpc('hg_admin_management', {
      p_actor_id: ctx.viewer.userId,
      p_action: action,
      p_input: input || {},
      p_club_id: clubId,
    });
    const failure = resultError(result);
    if (failure) throw failure;
    return result;
  } catch (error) {
    const mapped = mapManagementError(error);
    if (mapped !== error) throw mapped;
    throw error;
  }
}

function pick(item = {}, fields) {
  return Object.fromEntries(fields.filter((field) => item[field] !== undefined).map((field) => [field, item[field]]));
}

function presentMember(item = {}) { return pick(item, MEMBER_FIELDS); }

function presentInvite(item = {}, { includeCode = false } = {}) {
  return {
    ...pick(item, INVITE_FIELDS),
    ...(includeCode && typeof item.code === 'string' ? { code: item.code } : {}),
  };
}

function presentPage(result, presentItem) {
  return {
    items: result && Array.isArray(result.items) ? result.items.map(presentItem) : [],
    nextCursor: result && typeof result.nextCursor === 'string' ? result.nextCursor : null,
  };
}

function presentTeam(item = {}) {
  const term = pick(item.term || {}, ['id', 'version', 'primaryUserId', 'startAt', 'endAt', 'memberCount']);
  const pending = item.pendingHandover ? pick(item.pendingHandover, ['id', 'status', 'targetUserId', 'expiresAt', 'version']) : null;
  return {
    term,
    members: Array.isArray(item.members) ? item.members.map(presentMember) : [],
    pendingHandover: pending,
  };
}

function presentProposedTeam(items) {
  return Array.isArray(items) ? items.map((item) => pick(item, ['targetUserId', 'displayName', 'role', 'version'])) : [];
}

function presentHandover(item = {}) {
  const result = pick(item, HANDOVER_FIELDS);
  if (item.proposedTeam !== undefined) result.proposedTeam = presentProposedTeam(item.proposedTeam);
  return result;
}

function presentRecovery(item = {}) {
  const result = pick(item, RECOVERY_FIELDS);
  if (item.proposedTeam !== undefined) result.proposedTeam = presentProposedTeam(item.proposedTeam);
  return result;
}

function presentAudit(item = {}) { return pick(item, AUDIT_FIELDS); }

function presentSettings(item = {}) {
  return pick(item, ['clubId', 'description', 'charter', 'admissionMode', 'rulesVersion', 'version']);
}

function presentOverview(item = {}) {
  const club = pick(item.club || {}, ['id', 'name', 'status', 'version', 'rulesVersion']);
  const pending = pick(item.pending || {}, ['memberships', 'manualJoin', 'manualRestore', 'handovers']);
  const term = pick(item.term || {}, ['id', 'version', 'primaryUserId', 'startAt', 'endAt', 'memberCount']);
  const pendingHandover = item.pendingHandover
    ? pick(item.pendingHandover, ['id', 'status', 'targetUserId', 'expiresAt', 'version'])
    : null;
  return { club, pending, activeMembers: Number(item.activeMembers || 0), term, pendingHandover };
}

function requireAuthenticated(ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();
}

function requireReviewManager(ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden();
}

function requireModerator(ctx) {
  if (!policies.canManageMembers(ctx.viewer)) throw errors.forbidden();
}

function requireMemberTarget(ctx, targetUserId) {
  if (!policies.canManageTargetMember(ctx.viewer, targetUserId)) throw errors.forbidden();
}

async function overview(payload = {}, ctx) {
  requireReviewManager(ctx);
  return presentOverview(await callManagementRpc('overview', {}, ctx));
}

async function listMembers(payload = {}, ctx) {
  requireModerator(ctx);
  const status = payload.status === undefined || payload.status === ''
    ? 'all' : validators.requireEnum(payload.status, 'status', MEMBER_STATUSES);
  const cursor = payload.cursor === undefined ? null : validators.requireString(payload.cursor, 'cursor', { max: 200 });
  const limit = requiredNumber(payload.limit, 'limit', { fallback: 50, min: 1, max: 100 });
  const result = await callManagementRpc('members.list', { cursor, limit, status }, ctx);
  return presentPage(result, presentMember);
}

async function listInvites(payload = {}, ctx) {
  requireModerator(ctx);
  const result = await callManagementRpc('invites.list', {
    cursor: payload.cursor === undefined ? null : validators.requireString(payload.cursor, 'cursor', { max: 200 }),
    limit: requiredNumber(payload.limit, 'limit', { fallback: 50, min: 1, max: 100 }),
    status: payload.status === undefined || payload.status === ''
      ? 'all' : validators.requireEnum(payload.status, 'status', ['all', 'active', 'exhausted', 'expired', 'revoked']),
  }, ctx);
  return presentPage(result, (item) => presentInvite(item));
}

async function createInvite(payload = {}, ctx) {
  requireModerator(ctx);
  const mode = validators.requireEnum(payload.mode, 'mode', INVITE_MODES);
  const maxUses = requiredNumber(payload.maxUses, 'maxUses', { fallback: mode === 'direct' ? 1 : 100, min: 1, max: 1000 });
  const ttlSeconds = requiredNumber(payload.ttlSeconds, 'ttlSeconds', { fallback: 7 * 24 * 60 * 60, min: 60, max: 90 * 24 * 60 * 60 });
  const reason = requiredReason(payload);
  const targetUserId = validators.optionalId(payload.targetUserId, 'targetUserId');
  if (mode === 'direct' && (!targetUserId || maxUses !== 1)) throw errors.invalidInput('定向邀请码必须绑定账号且只能使用一次');
  if (mode === 'application' && targetUserId) throw errors.invalidInput('公开申请邀请码不能绑定目标账号');

  const code = crypto.randomBytes(16).toString('hex').toUpperCase();
  const codeHash = crypto.createHash('sha256').update(code, 'utf8').digest('hex');
  const result = await callManagementRpc('invites.create', {
    mode,
    maxUses,
    ttlSeconds,
    ...(targetUserId ? { targetUserId } : {}),
    reason,
    codeHash,
  }, ctx);
  return { ...presentInvite(result), code };
}

async function revokeInvite(payload = {}, ctx) {
  requireModerator(ctx);
  const id = validators.requireId(payload.inviteId || payload.id, 'inviteId');
  const expectedVersion = requiredExpectedVersion(payload);
  const reason = requiredReason(payload);
  return presentInvite(await callManagementRpc('invites.revoke', { id, expectedVersion, reason }, ctx));
}

async function getSettings(payload = {}, ctx) {
  requireModerator(ctx);
  return presentSettings(await callManagementRpc('settings.get', {}, ctx));
}

async function updateSettings(payload = {}, ctx) {
  requireModerator(ctx);
  const input = { expectedVersion: requiredExpectedVersion(payload), reason: requiredReason(payload) };
  let updated = 0;
  if (payload.description !== undefined) {
    input.description = validators.requireString(payload.description, 'description', { max: 300, allowEmpty: true });
    updated += 1;
  }
  if (payload.charter !== undefined) {
    input.charter = validators.requireString(payload.charter, 'charter', { max: 5000, allowEmpty: true });
    updated += 1;
  }
  if (payload.admissionMode !== undefined) {
    input.admissionMode = validators.requireEnum(payload.admissionMode, 'admissionMode', ADMISSION_MODES);
    updated += 1;
  }
  if (!updated) throw errors.invalidInput('至少提供一项社团设置');
  return presentSettings(await callManagementRpc('settings.update', input, ctx));
}

async function getTeam(payload = {}, ctx) {
  requireModerator(ctx);
  return presentTeam(await callManagementRpc('team.get', {}, ctx));
}

async function setPrimary(payload = {}, ctx) {
  requireModerator(ctx);
  const targetUserId = validators.requireId(payload.targetUserId || payload.primaryUserId, 'targetUserId');
  const expectedVersion = requiredExpectedVersion(payload);
  const expectedMembershipVersion = requiredNumber(payload.expectedMembershipVersion, 'expectedMembershipVersion', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const reason = requiredReason(payload);
  return presentTeam(await callManagementRpc('team.primary', {
    targetUserId,
    expectedVersion,
    expectedMembershipVersion,
    reason,
  }, ctx));
}

async function listHandovers(payload = {}, ctx) {
  requireModerator(ctx);
  return presentPage(await callManagementRpc('handovers.list', {
    cursor: payload.cursor === undefined ? null : validators.requireString(payload.cursor, 'cursor', { max: 200 }),
    limit: requiredNumber(payload.limit, 'limit', { fallback: 50, min: 1, max: 100 }),
    status: payload.status === undefined ? 'all' : validators.requireEnum(payload.status, 'status', ['all', 'proposed', 'completed', 'cancelled', 'declined', 'expired', 'stale']),
  }, ctx), presentHandover);
}

function presentTeamInput(value = {}) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) throw errors.invalidInput('团队名单不合法', { field: 'team' });
  const team = value.map((member) => ({
    targetUserId: validators.requireId(member && member.targetUserId, 'team.targetUserId'),
    role: validators.requireEnum(member && member.role, 'team.role', ['admin', 'moderator']),
    expectedVersion: requiredExpectedVersion(member || {}, 'expectedVersion'),
  }));
  if (!team.some((member) => member.role === 'moderator')) throw errors.invalidInput('新一届团队至少需要一位社团负责人', { field: 'team' });
  if (new Set(team.map((member) => member.targetUserId)).size !== team.length) throw errors.invalidInput('团队名单不能重复成员', { field: 'team' });
  return team;
}

async function createHandover(payload = {}, ctx) {
  requireModerator(ctx);
  const targetUserId = validators.requireId(payload.targetUserId, 'targetUserId');
  requireMemberTarget(ctx, targetUserId);
  const expectedVersion = requiredExpectedVersion(payload);
  const reason = requiredReason(payload);
  const team = presentTeamInput(payload.team);
  if (!team.some((member) => member.targetUserId === targetUserId && member.role === 'moderator')) {
    throw errors.invalidInput('继任负责人必须在新团队中担任社团负责人', { field: 'targetUserId' });
  }
  const retainInviteIds = Array.isArray(payload.retainInviteIds)
    ? payload.retainInviteIds.map((id) => validators.requireId(id, 'retainInviteIds'))
    : [];
  if (retainInviteIds.length > 5000 || new Set(retainInviteIds).size !== retainInviteIds.length) {
    throw errors.invalidInput('保留邀请码清单不合法', { field: 'retainInviteIds' });
  }
  let termEndAt;
  if (payload.termEndAt !== undefined && payload.termEndAt !== null && payload.termEndAt !== '') {
    const time = new Date(validators.requireString(payload.termEndAt, 'termEndAt', { max: 40 })).getTime();
    if (!Number.isFinite(time) || time < Date.now()) throw errors.invalidInput('任期结束时间必须是未来时间', { field: 'termEndAt' });
    termEndAt = new Date(time).toISOString();
  }
  const result = await callManagementRpc('handovers.create', {
    targetUserId, team, expectedVersion, reason, retainInviteIds, ...(termEndAt ? { termEndAt } : {}),
  }, ctx);
  return presentHandover(result);
}

async function acceptHandover(payload = {}, ctx) {
  requireAuthenticated(ctx);
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  const id = validators.requireId(payload.id, 'id');
  return presentHandover(await callManagementRpc('handovers.accept', { id, expectedVersion: requiredExpectedVersion(payload) }, ctx));
}

async function cancelHandover(payload = {}, ctx) {
  requireModerator(ctx);
  const id = validators.requireId(payload.id, 'id');
  return presentHandover(await callManagementRpc('handovers.cancel', {
    id, expectedVersion: requiredExpectedVersion(payload), reason: requiredReason(payload),
  }, ctx));
}

async function declineHandover(payload = {}, ctx) {
  requireAuthenticated(ctx);
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  const id = validators.requireId(payload.id, 'id');
  return presentHandover(await callManagementRpc('handovers.decline', {
    id, expectedVersion: requiredExpectedVersion(payload), reason: requiredReason(payload),
  }, ctx));
}

async function listMyHandovers(payload = {}, ctx) {
  requireAuthenticated(ctx);
  const result = await callManagementRpc('handovers.mine', {
    cursor: payload.cursor === undefined ? null : validators.requireString(payload.cursor, 'cursor', { max: 200 }),
    limit: requiredNumber(payload.limit, 'limit', { fallback: 50, min: 1, max: 100 }),
  }, ctx, null);
  return presentPage(result, presentHandover);
}

async function listMyRecoveries(payload = {}, ctx) {
  requireAuthenticated(ctx);
  const result = await callManagementRpc('recovery.mine', {
    cursor: payload.cursor === undefined ? null : validators.requireString(payload.cursor, 'cursor', { max: 200 }),
    limit: requiredNumber(payload.limit, 'limit', { fallback: 50, min: 1, max: 100 }),
  }, ctx, null);
  return presentPage(result, presentRecovery);
}

async function getMyRecovery(payload = {}, ctx) {
  requireAuthenticated(ctx);
  const recoveryId = validators.requireId(payload.recoveryId, 'recoveryId');
  return presentRecovery(await callManagementRpc('recovery.info', { recoveryId }, ctx, null));
}

function recoveryClubId(payload, ctx) {
  const clubId = ctx.requestedClubId || payload.clubId;
  return validators.requireId(clubId, 'clubId');
}

async function acceptMyRecovery(payload = {}, ctx) {
  requireAuthenticated(ctx);
  const recoveryId = validators.requireId(payload.recoveryId, 'recoveryId');
  return presentRecovery(await callManagementRpc('recovery.accept', {
    recoveryId,
    expectedVersion: requiredExpectedVersion(payload),
  }, ctx, recoveryClubId(payload, ctx)));
}

async function declineMyRecovery(payload = {}, ctx) {
  requireAuthenticated(ctx);
  const recoveryId = validators.requireId(payload.recoveryId, 'recoveryId');
  return presentRecovery(await callManagementRpc('recovery.decline', {
    recoveryId,
    expectedVersion: requiredExpectedVersion(payload),
    reason: requiredReason(payload, { optional: true }),
  }, ctx, recoveryClubId(payload, ctx)));
}

async function requestRecovery(payload = {}, ctx) {
  if (!ctx.viewer.isDeveloper) throw errors.forbidden();
  const targetUserId = validators.requireId(payload.targetUserId, 'targetUserId');
  if (payload.team !== undefined) throw errors.invalidInput('失联恢复仅将管理权限交接给目标账号', { field: 'team' });
  const expectedVersion = requiredExpectedVersion(payload);
  const reason = requiredReason(payload);
  const input = { targetUserId, expectedVersion, reason };
  const result = await callManagementRpc('recovery.request', input, ctx, recoveryClubId(payload, ctx));
  return presentRecovery(result);
}

async function listPlatformRecoveries(payload = {}, ctx) {
  if (!ctx.viewer.isDeveloper) throw errors.forbidden();
  return presentPage(await callManagementRpc('recovery.list', {
    cursor: payload.cursor === undefined ? null : validators.requireString(payload.cursor, 'cursor', { max: 200 }),
    limit: requiredNumber(payload.limit, 'limit', { fallback: 50, min: 1, max: 100 }),
    status: payload.status === undefined || payload.status === ''
      ? 'all' : validators.requireEnum(payload.status, 'status', ['all', 'recovery_requested', 'completed', 'recovery_rejected', 'expired', 'stale']),
  }, ctx, recoveryClubId(payload, ctx)), presentRecovery);
}

async function approveRecovery(payload = {}, ctx) {
  if (!ctx.viewer.isDeveloper) throw errors.forbidden();
  const id = validators.requireId(payload.recoveryId || payload.id, 'recoveryId');
  const decision = validators.requireEnum(payload.decision, 'decision', ['approve', 'reject']);
  const reason = requiredReason(payload);
  return presentRecovery(await callManagementRpc('recovery.approve', {
    id,
    expectedVersion: requiredExpectedVersion(payload),
    decision,
    reason,
  }, ctx, recoveryClubId(payload, ctx)));
}

async function listAudit(payload = {}, ctx) {
  requireModerator(ctx);
  const result = await callManagementRpc('audit.list', {
    cursor: payload.cursor === undefined ? null : validators.requireString(payload.cursor, 'cursor', { max: 200 }),
    limit: requiredNumber(payload.limit, 'limit', { fallback: 50, min: 1, max: 100 }),
  }, ctx);
  return presentPage(result, presentAudit);
}

async function cancelApplication(payload = {}, ctx) {
  requireAuthenticated(ctx);
  const id = validators.requireId(payload.applicationId || payload.id, 'applicationId');
  return callManagementRpc('applications.cancel', {
    id,
    expectedVersion: requiredExpectedVersion(payload),
    reason: requiredReason(payload, { optional: true }),
  }, ctx);
}

module.exports = {
  callManagementRpc,
  overview,
  listMembers,
  listInvites,
  createInvite,
  revokeInvite,
  getSettings,
  updateSettings,
  getTeam,
  setPrimary,
  listHandovers,
  createHandover,
  acceptHandover,
  cancelHandover,
  declineHandover,
  listMyHandovers,
  listMyRecoveries,
  getMyRecovery,
  acceptMyRecovery,
  declineMyRecovery,
  requestRecovery,
  listPlatformRecoveries,
  approveRecovery,
  listAudit,
  cancelApplication,
  presentMember,
  presentInvite,
  presentSettings,
  presentTeam,
  presentHandover,
  presentRecovery,
  presentAudit,
  presentOverview,
  mapManagementError,
  INVITE_MODES,
  ADMISSION_MODES,
};
