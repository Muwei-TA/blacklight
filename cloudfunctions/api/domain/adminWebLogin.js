/** Mini Program confirmation for browser admin QR pairings. */

const validators = require('../shared/validators');
const errors = require('../shared/errors');
const db = require('../shared/db');

function pairingStore() {
  const store = db.getDb();
  if (!store || typeof store.query !== 'function') throw new Error('NAS admin web pairing storage is not configured');
  return store;
}

function presentPairing(row = {}) {
  return {
    id: row.id,
    status: row.status,
    origin: row.origin,
    expiresAt: row.expires_at,
  };
}

function requireAccount(ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();
  return ctx.viewer.userId;
}

async function info(payload = {}, ctx) {
  requireAccount(ctx);
  const id = validators.requireId(payload.id, 'id');
  const result = await pairingStore().query(`
    SELECT id,
           CASE WHEN expires_at <= NOW() AND status <> 'exchanged' THEN 'expired' ELSE status END AS status,
           origin,
           expires_at
      FROM public.hg_admin_web_pairings
     WHERE id = $1
     LIMIT 1
  `, [id]);
  if (!result.rowCount) throw errors.notAccessible();
  return presentPairing(result.rows[0]);
}

async function approve(payload = {}, ctx) {
  const actorId = requireAccount(ctx);
  const id = validators.requireId(payload.id, 'id');
  const result = await pairingStore().query(`
    WITH actor AS MATERIALIZED (
      SELECT u.id, public.hg_admin_web_authorization_hash(u.id) AS authorization_hash
        FROM public.hg_users AS u
       WHERE u.id = $1
         AND u.doc->>'status' = 'active'
         AND public.hg_admin_web_authorization_hash(u.id) IS NOT NULL
    ), updated AS (
      UPDATE public.hg_admin_web_pairings AS p
         SET status = 'approved', approved_user_id = actor.id,
             approved_authorization_hash = actor.authorization_hash, approved_at = NOW()
        FROM actor
       WHERE p.id = $2
         AND p.status = 'pending'
         AND p.expires_at > NOW()
      RETURNING p.id, p.status, p.origin, p.expires_at
    )
    SELECT (SELECT count(*) FROM actor) > 0 AS authorized,
           (SELECT to_jsonb(updated) FROM updated) AS pairing
  `, [actorId, id]);
  const row = result.rows[0] || {};
  if (!row.authorized) throw errors.forbidden();
  if (!row.pairing) throw errors.conflict('扫码事务已处理或过期，请重新扫码');
  return presentPairing(row.pairing);
}

async function reject(payload = {}, ctx) {
  const actorId = requireAccount(ctx);
  const id = validators.requireId(payload.id, 'id');
  const result = await pairingStore().query(`
    WITH actor AS MATERIALIZED (
      SELECT id FROM public.hg_users
       WHERE id = $1 AND doc->>'status' = 'active'
    ), updated AS (
      UPDATE public.hg_admin_web_pairings AS p
         SET status = 'rejected', rejected_at = NOW()
        FROM actor
       WHERE p.id = $2
         AND p.status = 'pending'
         AND p.expires_at > NOW()
      RETURNING p.id, p.status, p.origin, p.expires_at
    )
    SELECT (SELECT count(*) FROM actor) > 0 AS authorized,
           (SELECT to_jsonb(updated) FROM updated) AS pairing
  `, [actorId, id]);
  const row = result.rows[0] || {};
  if (!row.authorized) throw errors.unauthenticated();
  if (!row.pairing) throw errors.conflict('扫码事务已处理或过期，请重新扫码');
  return presentPairing(row.pairing);
}

module.exports = { info, approve, reject, presentPairing };
