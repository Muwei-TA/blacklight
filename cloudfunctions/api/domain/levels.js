/** 私有用户等级与经验值用例。XP 来源和业务日由 PostgreSQL 服务端决定。 */

const db = require('../shared/db');
const errors = require('../shared/errors');

function requireMember(ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  return ctx.viewer.userId;
}

function mapMembershipError(error) {
  const marker = `${error && error.code ? error.code : ''} ${error && error.message ? error.message : ''}`;
  if (/MEMBERSHIP_REQUIRED|FORBIDDEN/.test(marker)) throw errors.membershipInvalid();
  throw error;
}

async function getMyLevels(_payload, ctx) {
  const actorId = requireMember(ctx);
  const clubId = ctx.viewer.clubId;
  const store = db.getDb();
  if (!store || typeof store.rpc !== 'function') throw new Error('user levels RPC is not configured');
  try {
    return await store.rpc('hg_user_levels_snapshot', { p_actor_id: actorId, p_club_id: clubId });
  } catch (error) {
    mapMembershipError(error);
  }
}

async function checkIn(_payload, ctx) {
  const actorId = requireMember(ctx);
  const clubId = ctx.viewer.clubId;
  const store = db.getDb();
  if (!store || typeof store.rpc !== 'function') throw new Error('user levels RPC is not configured');
  try {
    return await store.rpc('hg_user_levels_check_in', { p_actor_id: actorId, p_club_id: clubId });
  } catch (error) {
    mapMembershipError(error);
  }
}

module.exports = { getMyLevels, checkIn };
