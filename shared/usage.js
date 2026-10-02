/** Shared server-only quota helpers. A denied review call is a scheduled wait,
 * not a failed review attempt; callers must keep the task queued until next UTC day.
 */

const db = require('./db');

async function reserveReviewCall(kind, clubId) {
  if (!clubId) throw new Error('review quota club is required');
  const store = db.getDb();
  if (!store || typeof store.rpc !== 'function') throw new Error('usage quota RPC is not configured');
  const result = await store.rpc('hg_usage_reserve_review_call', {
    p_club_id: clubId,
    p_kind: kind,
  });
  if (!result || typeof result.allowed !== 'boolean') throw new Error('usage quota RPC returned invalid result');
  if (result.allowed) return result;
  const error = new Error('review quota window exhausted');
  error.code = 'USAGE_QUOTA';
  error.nextAttemptAt = result.nextAttemptAt;
  throw error;
}

function waitingForQuota(error) {
  if (!error || error.code !== 'USAGE_QUOTA') return null;
  const nextAttemptAt = error.nextAttemptAt ? new Date(error.nextAttemptAt) : null;
  if (!nextAttemptAt || Number.isNaN(nextAttemptAt.getTime())) {
    throw new Error('usage quota RPC returned invalid next window');
  }
  return {
    status: 'queued',
    note: 'waiting for next review quota window',
    waitingReason: 'usage_quota',
    nextAttemptAt,
  };
}

module.exports = { reserveReviewCall, waitingForQuota };
