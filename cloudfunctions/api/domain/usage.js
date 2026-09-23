/** Moderator-only aggregate usage and quota alert status. */

const policies = require('../shared/policies');
const errors = require('../shared/errors');
const db = require('../shared/db');

async function getStatus(payload, ctx) {
  if (!policies.canAccessModeration(ctx.viewer)) throw errors.forbidden();
  const store = db.getDb();
  if (!store || typeof store.rpc !== 'function') throw new Error('usage status RPC is not configured');
  return store.rpc('hg_usage_status', { p_club_id: ctx.viewer.clubId });
}

module.exports = { getStatus };
