/** Rebuild the UTC-day quota snapshot for one club. */

const db = require('../shared/db');

async function refreshUsageSummary(clubId) {
  if (!clubId) throw new Error('usage club is required');
  const store = db.getDb();
  if (!store || typeof store.rpc !== 'function') throw new Error('usage summary RPC is not configured');
  const snapshot = await store.rpc('hg_usage_status', { p_club_id: clubId });
  return {
    date: snapshot.date,
    upload: snapshot.upload,
    review: snapshot.review,
    updatedAt: snapshot.updatedAt,
  };
}

module.exports = { refreshUsageSummary };
