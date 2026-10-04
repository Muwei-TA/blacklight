'use strict';

const crypto = require('node:crypto');
const QRCode = require('qrcode');
const pg = require('../shared/pg-store');

const PAIRING_TTL_MS = 2 * 60 * 1000;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PAIRING_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const LOCAL_COOKIE_NAME = 'bl_admin';
const SECURE_COOKIE_NAME = '__Host-bl_admin';

const ADMIN_WEB_ACTIONS = new Set([
  'admin/overview',
  'admin/queue',
  'admin/content/decide',
  'admin/content/detail',
  'admin/comment/decide',
  'admin/topic/decide',
  'admin/board/decide',
  'admin/appeal/decide',
  'admin/membership/decide',
  'admin/report/decide',
  'admin/collection/decide',
  'admin/security/check',
  'admin/usage/status',
  'admin/members/list',
  'admin/invites/list',
  'admin/invites/create',
  'admin/invites/revoke',
  'admin/member/remove',
  'admin/member/mute',
  'admin/member/role',
  'admin/club/settings',
  'admin/club/update',
  'admin/management/team',
  'admin/management/primary',
  'admin/handovers/list',
  'admin/handovers/create',
  'admin/handovers/cancel',
  'admin/audit/list',
  'platform/clubs/list',
  'platform/clubs/create',
  'platform/clubs/update',
  'platform/clubs/set-status',
  'platform/clubs/set-moderator',
  'platform/recovery/list',
  'platform/recovery/request',
  'platform/recovery/approve',
]);

class AdminWebAuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AdminWebAuthError';
    this.status = status;
    this.code = code;
  }
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function normalizeOrigin(origin) {
  if (typeof origin !== 'string' || !origin || origin === 'null' || origin.length > 512) return null;
  let parsed;
  try { parsed = new URL(origin); } catch (_) { return null; }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

function isAllowedOrigin(origin, baseUrl = process.env.PUBLIC_API_BASE_URL) {
  const canonicalOrigin = normalizeOrigin(origin);
  if (!canonicalOrigin) return false;
  if (!baseUrl) return false;
  let configuredOrigin;
  try { configuredOrigin = new URL(baseUrl).origin; } catch (_) { return false; }
  return normalizeOrigin(configuredOrigin) === canonicalOrigin;
}

function cookieName({ secure = process.env.NODE_ENV === 'production' } = {}) {
  return secure ? SECURE_COOKIE_NAME : LOCAL_COOKIE_NAME;
}

function readCookie(header, name = cookieName()) {
  if (typeof header !== 'string' || header.length > 4096) return null;
  let found = null;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0 || pair.slice(0, index).trim() !== name) continue;
    if (found !== null) return null;
    const value = pair.slice(index + 1).trim();
    if (!TOKEN_PATTERN.test(value)) return null;
    found = value;
  }
  return found;
}

function deriveCsrfToken(sessionToken) {
  if (typeof sessionToken !== 'string' || !TOKEN_PATTERN.test(sessionToken)) return null;
  return crypto.createHmac('sha256', sessionToken).update('blacklight-admin-csrf-v1', 'utf8').digest('base64url');
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function validCsrfToken(sessionToken, candidate) {
  return constantTimeEqual(deriveCsrfToken(sessionToken), candidate);
}

function deriveExchangeCode(id, pollKey) {
  if (!PAIRING_ID_PATTERN.test(String(id || '')) || !TOKEN_PATTERN.test(String(pollKey || ''))) return null;
  return crypto.createHmac('sha256', pollKey)
    .update(`blacklight-admin-exchange-v1:${id}`, 'utf8')
    .digest('base64url');
}

function buildSessionCookie(token, { clear = false, secure = process.env.NODE_ENV === 'production' } = {}) {
  const name = cookieName({ secure });
  const value = clear ? '' : token;
  const maxAge = clear ? 0 : Math.floor(SESSION_ABSOLUTE_MS / 1000);
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function createAdminWebAuth({ database = pg, now = () => new Date() } = {}) {
  async function createPairing({ origin, remoteAddress = '' }) {
    const canonicalOrigin = isAllowedOrigin(origin) ? normalizeOrigin(origin) : null;
    if (!canonicalOrigin) throw new AdminWebAuthError(400, 'invalid_origin', '管理台来源不合法');

    const id = crypto.randomBytes(18).toString('base64url');
    const pollKey = crypto.randomBytes(32).toString('base64url');
    const requesterHash = tokenHash(String(remoteAddress || 'unknown'));
    const expiresAt = new Date(now().getTime() + PAIRING_TTL_MS).toISOString();
    const result = await database.query(`
      WITH attempt AS (
        INSERT INTO public.hg_admin_web_pairing_limits AS limits (requester_hash, window_started_at, attempts)
        VALUES ($1, NOW(), 1)
        ON CONFLICT (requester_hash) DO UPDATE
           SET window_started_at = CASE
                 WHEN limits.window_started_at <= NOW() - INTERVAL '10 minutes' THEN NOW()
                 ELSE limits.window_started_at
               END,
               attempts = CASE
                 WHEN limits.window_started_at <= NOW() - INTERVAL '10 minutes' THEN 1
                 ELSE limits.attempts + 1
               END
         WHERE limits.window_started_at <= NOW() - INTERVAL '10 minutes'
            OR limits.attempts < 8
        RETURNING requester_hash
      ), inserted AS (
        INSERT INTO public.hg_admin_web_pairings
          (id, poll_key_hash, origin, requester_hash, status, created_at, expires_at)
        SELECT $2, $3, $4, $1, 'pending', $5, $6
          FROM attempt
        RETURNING expires_at
      )
      SELECT expires_at FROM inserted
    `, [requesterHash, id, tokenHash(pollKey), canonicalOrigin, now().toISOString(), expiresAt]);
    if (!result.rowCount) throw new AdminWebAuthError(429, 'rate_limited', '扫码请求过于频繁，请稍后重试');

    const qrText = `blacklight-admin:${id}`;
    const qrSvg = await QRCode.toString(qrText, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 240,
    });
    return { id, qrText, qrSvg, expiresAt: result.rows[0].expires_at, pollKey };
  }

  async function findPairing({ id, pollKey, origin }) {
    const canonicalOrigin = isAllowedOrigin(origin) ? normalizeOrigin(origin) : null;
    if (!canonicalOrigin || !PAIRING_ID_PATTERN.test(String(id || '')) || !TOKEN_PATTERN.test(String(pollKey || ''))) {
      throw new AdminWebAuthError(401, 'pairing_not_found', '扫码登录已失效，请重新扫码');
    }
    const result = await database.query(`
      SELECT id, origin, status, expires_at
        FROM public.hg_admin_web_pairings
       WHERE id = $1 AND poll_key_hash = $2 AND origin = $3
       LIMIT 1
    `, [id, tokenHash(pollKey), canonicalOrigin]);
    if (!result.rowCount) throw new AdminWebAuthError(401, 'pairing_not_found', '扫码登录已失效，请重新扫码');
    return result.rows[0];
  }

  async function getPairingStatus({ id, pollKey, origin }) {
    const pairing = await findPairing({ id, pollKey, origin });
    const expired = new Date(pairing.expires_at).getTime() <= now().getTime();
    const status = expired && pairing.status !== 'exchanged' ? 'expired' : pairing.status;
    return {
      status,
      ...(status === 'approved' ? { exchangeCode: deriveExchangeCode(id, pollKey) } : {}),
    };
  }

  async function redeemPairing({ id, pollKey, exchangeCode, origin }) {
    const canonicalOrigin = isAllowedOrigin(origin) ? normalizeOrigin(origin) : null;
    const expectedCode = deriveExchangeCode(id, pollKey);
    if (!canonicalOrigin || !expectedCode || !constantTimeEqual(expectedCode, exchangeCode)) {
      throw new AdminWebAuthError(401, 'exchange_failed', '扫码登录已失效，请重新扫码');
    }

    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const result = await database.query(`
      WITH candidate AS MATERIALIZED (
        SELECT p.id, p.approved_user_id, p.origin, p.approved_authorization_hash,
               u.doc->>'wxOpenIdRef' AS openid_ref
          FROM public.hg_admin_web_pairings AS p
          JOIN public.hg_users AS u ON u.id = p.approved_user_id
         WHERE p.id = $1
           AND p.poll_key_hash = $2
           AND p.origin = $3
           AND p.status = 'approved'
           AND p.expires_at > NOW()
           AND u.doc->>'status' = 'active'
           AND length(COALESCE(u.doc->>'wxOpenIdRef', '')) > 0
           AND p.approved_authorization_hash = public.hg_admin_web_authorization_hash(u.id)
         FOR UPDATE OF p
      ), redeemed AS (
        UPDATE public.hg_admin_web_pairings AS p
           SET status = 'exchanged', exchanged_at = NOW()
          FROM candidate AS c
         WHERE p.id = c.id
           AND p.status = 'approved'
        RETURNING c.approved_user_id, c.origin, c.openid_ref, c.approved_authorization_hash
      )
      INSERT INTO public.hg_admin_web_sessions
        (token_hash, user_id, openid_ref, authorization_hash, origin, created_at, last_seen_at, absolute_expires_at)
      SELECT $4, approved_user_id, openid_ref, approved_authorization_hash, origin, NOW(), NOW(), NOW() + INTERVAL '8 hours'
        FROM redeemed
      RETURNING token_hash
    `, [id, tokenHash(pollKey), canonicalOrigin, tokenHash(sessionToken)]);
    if (!result.rowCount) throw new AdminWebAuthError(401, 'exchange_failed', '扫码登录已失效，请重新扫码');
    return {
      sessionToken,
      csrfToken: deriveCsrfToken(sessionToken),
      expiresAt: new Date(now().getTime() + SESSION_ABSOLUTE_MS).toISOString(),
    };
  }

  async function resolveSession(req) {
    const sessionToken = readCookie(req && req.headers && req.headers.cookie);
    if (!sessionToken) return null;
    const result = await database.query(`
      UPDATE public.hg_admin_web_sessions
         SET last_seen_at = NOW()
        FROM public.hg_users AS u
       WHERE token_hash = $1
         AND public.hg_admin_web_sessions.user_id = u.id
         AND public.hg_admin_web_sessions.openid_ref = u.doc->>'wxOpenIdRef'
         AND u.doc->>'status' = 'active'
         AND public.hg_admin_web_sessions.authorization_hash = public.hg_admin_web_authorization_hash(u.id)
         AND revoked_at IS NULL
         AND absolute_expires_at > NOW()
         AND last_seen_at > NOW() - INTERVAL '30 minutes'
      RETURNING openid_ref, origin, absolute_expires_at
    `, [tokenHash(sessionToken)]);
    if (!result.rowCount || !result.rows[0].openid_ref) return null;
    return {
      sessionToken,
      csrfToken: deriveCsrfToken(sessionToken),
      origin: result.rows[0].origin,
      identity: { openid: result.rows[0].openid_ref, invalid: false },
      expiresAt: result.rows[0].absolute_expires_at,
    };
  }

  async function revokeSession(session) {
    if (!session || typeof session.sessionToken !== 'string') return false;
    const result = await database.query(`
      UPDATE public.hg_admin_web_sessions
         SET revoked_at = NOW()
       WHERE token_hash = $1 AND revoked_at IS NULL
    `, [tokenHash(session.sessionToken)]);
    return result.rowCount > 0;
  }

  return { createPairing, getPairingStatus, redeemPairing, resolveSession, revokeSession };
}

module.exports = {
  ADMIN_WEB_ACTIONS,
  AdminWebAuthError,
  PAIRING_TTL_MS,
  SESSION_IDLE_MS,
  SESSION_ABSOLUTE_MS,
  TOKEN_PATTERN,
  PAIRING_ID_PATTERN,
  tokenHash,
  normalizeOrigin,
  isAllowedOrigin,
  cookieName,
  readCookie,
  deriveCsrfToken,
  deriveExchangeCode,
  constantTimeEqual,
  validCsrfToken,
  buildSessionCookie,
  createAdminWebAuth,
};
