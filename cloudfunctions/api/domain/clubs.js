/** Account-wide club directory and public club card. */

const { COLLECTIONS, DEFAULT_CLUB_ID, MEMBER_STATUS } = require('../shared/constants');
const validators = require('../shared/validators');
const errors = require('../shared/errors');
const db = require('../shared/db');

const PUBLIC_CAPABILITIES = ['publishing', 'uploads', 'publicScope', 'video', 'anthology', 'export'];

function presentClub(club, membership = null) {
  return {
    id: club.clubId || club._id,
    name: club.name || '',
    description: club.description || club.intro || '',
    status: club.status || (club._id === DEFAULT_CLUB_ID ? 'active' : 'paused'),
    ...(membership ? { role: membership.role || 'member', memberStatus: membership.status || 'none' } : {}),
  };
}

async function mine(_payload, ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();
  const result = await db.getDb().rpc('hg_user_clubs', { p_actor_id: ctx.viewer.userId });
  const items = Array.isArray(result) ? result : (result && (result.items || result.list)) || [];
  return { list: items.map((item) => {
    const memberStatus = item.memberStatus || item.membershipStatus || 'active';
    return {
      id: item.id || item.clubId || item._id,
      name: item.name || '',
      description: item.description || '',
      status: item.status || 'active',
      role: memberStatus === MEMBER_STATUS.ACTIVE ? (item.role || 'member') : null,
      memberStatus,
    };
  }).filter((item) => item.id) };
}

async function list(_payload, _ctx) {
  const result = await db.coll(COLLECTIONS.clubConfig, null)
    .where({ status: 'active', discoverable: true })
    .orderBy('name', 'asc')
    .limit(100)
    .get();
  return { list: (result.data || []).map((club) => presentClub(club)) };
}

async function detail(payload, ctx) {
  const id = validators.requireId(payload.id, 'id');
  if (!ctx.club || id !== (ctx.viewer.clubId)) throw errors.notAccessible({ clubId: id });
  return {
    ...presentClub(ctx.club),
    rulesVersion: ctx.club.rulesVersion || 'v1.0',
    rules: ctx.club.rules || '',
    capabilities: Object.fromEntries(PUBLIC_CAPABILITIES.map((key) => [key, ctx.capabilities[key] === true])),
  };
}

module.exports = { mine, list, detail, presentClub };
