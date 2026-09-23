/** Rebuild and log the current UTC-day quota snapshot for the default club. */

const { DEFAULT_CLUB_ID } = require('../shared/constants');
const db = require('../shared/db');

async function refreshUsageSummary() {
  const store = db.getDb();
  if (!store || typeof store.rpc !== 'function') throw new Error('usage summary RPC is not configured');
  const snapshot = await store.rpc('hg_usage_status', { p_club_id: DEFAULT_CLUB_ID });
  return {
    date: snapshot.date,
    upload: snapshot.upload,
    review: snapshot.review,
    updatedAt: snapshot.updatedAt,
  };
}

module.exports = { refreshUsageSummary };
