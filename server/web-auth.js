'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const pg = require('../shared/pg-store');
const scrypt = promisify(crypto.scrypt);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

class WebAuthError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
function normalizeUsername(value) {
  if (typeof value !== 'string') throw new WebAuthError(400, 'invalid_input', '账号须为 3–32 位字母、数字或下划线');
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_]{2,31}$/.test(normalized)) throw new WebAuthError(400, 'invalid_input', '账号须为 3–32 位字母、数字或下划线');
  return normalized;
}
function normalizeInviteCode(value) {
  if (typeof value !== 'string') throw new WebAuthError(400, 'invalid_invite', '邀请码无效或已过期');
  const code = value.trim().toUpperCase();
  if (!/^[A-F0-9]{8,64}$/.test(code)) throw new WebAuthError(400, 'invalid_invite', '邀请码无效或已过期');
  return code;
}
function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) throw new WebAuthError(400, 'invalid_input', '密码须为 10–128 个字符');
}
async function hashPassword(password) {
  validatePassword(password);
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 128 || typeof encoded !== 'string') return false;
  const match = /^scrypt:([0-9a-f]{32}):([0-9a-f]{128})$/.exec(encoded);
  if (!match) return false;
  const actual = await scrypt(password, match[1], 64, SCRYPT_OPTIONS);
  return crypto.timingSafeEqual(actual, Buffer.from(match[2], 'hex'));
}
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function csrfFor(token) { return crypto.createHmac('sha256', token).update('blacklight-web-csrf-v1').digest('base64url'); }
function validCsrf(token, value) {
  if (!TOKEN.test(token || '') || typeof value !== 'string' || !TOKEN.test(value)) return false;
  return crypto.timingSafeEqual(Buffer.from(csrfFor(token)), Buffer.from(value));
}
function sameOrigin(supplied, expected) { return typeof supplied === 'string' && supplied === expected; }
function cookieName(secure) { return secure ? '__Host-blacklight_web' : 'blacklight_web'; }
function buildCookie(token, { secure = true, clear = false } = {}) {
  return `${cookieName(secure)}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 604800}${secure ? '; Secure' : ''}`;
}
function readCookie(req, secure) {
  const header = req.headers && req.headers.cookie;
  if (typeof header !== 'string') return null;
  const matches = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName(secure)}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(cookieName(secure).length + 1);
  return TOKEN.test(value) ? value : null;
}

function createWebAuth({ database = pg, origin = process.env.PUBLIC_API_BASE_URL } = {}) {
  // Resolve configuration lazily: existing tests and mini-program API can create
  // a server before web configuration is installed, without widening origins.
  function configuredOrigin() {
    try {
      const url = new URL(origin || process.env.PUBLIC_API_BASE_URL);
      if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error();
      if (url.protocol === 'http:' && process.env.NODE_ENV === 'production' && process.env.NAS_LAN_MODE !== '1') throw new Error();
      return url.origin;
    } catch (_) { throw new WebAuthError(503, 'web_unconfigured', '网站访问地址尚未配置'); }
  }
  function assertOrigin(value) {
    if (!sameOrigin(value, configuredOrigin())) throw new WebAuthError(403, 'invalid_origin', '请求来源不匹配，请在网站内操作');
  }
  function secureCookie() { return configuredOrigin().startsWith('https:'); }
  async function rateLimit(operation, username, address) {
    // A single upsert serializes concurrent requests in each bucket. Network
    // address is resolved from the socket or an explicitly trusted proxy by web-http.
    for (const [key, max] of [[`${operation}:ip:${address || 'unknown'}`, operation === 'register' ? 5 : 30], [`${operation}:account:${username}`, 10]]) {
      const result = await database.query(`
        INSERT INTO public.hg_web_auth_limits (bucket_hash, window_started_at, attempts)
        VALUES ($1, NOW(), 1)
        ON CONFLICT (bucket_hash) DO UPDATE
          SET window_started_at = CASE WHEN hg_web_auth_limits.window_started_at <= NOW() - INTERVAL '15 minutes' THEN NOW() ELSE hg_web_auth_limits.window_started_at END,
              attempts = CASE WHEN hg_web_auth_limits.window_started_at <= NOW() - INTERVAL '15 minutes' THEN 1 ELSE hg_web_auth_limits.attempts + 1 END
          WHERE hg_web_auth_limits.window_started_at <= NOW() - INTERVAL '15 minutes' OR hg_web_auth_limits.attempts < $2
        RETURNING bucket_hash`, [digest(key), max]);
      if (!result.rowCount) throw new WebAuthError(429, 'rate_limited', '尝试次数较多，请 15 分钟后重试');
    }
  }
  async function issueSession(userId, passwordHash) {
    const token = crypto.randomBytes(32).toString('base64url');
    const result = await database.query(`
      INSERT INTO public.hg_web_sessions (token_hash, user_id, credential_version, origin, expires_at)
      SELECT $1, a.user_id, a.version, $3, NOW() + INTERVAL '7 days'
        FROM public.hg_web_accounts a JOIN public.hg_users u ON u.id = a.user_id
       WHERE a.user_id = $2 AND a.password_hash = $4 AND u.doc->>'status' = 'active'
      RETURNING expires_at`, [digest(token), userId, configuredOrigin(), passwordHash]);
    if (!result.rowCount) throw new WebAuthError(401, 'unauthenticated', '账号状态已变化，请重新登录');
    return { sessionToken: token, csrfToken: csrfFor(token), expiresAt: result.rows[0].expires_at };
  }
  async function previewInvite({ inviteCode, origin: requestOrigin, remoteAddress }) {
    assertOrigin(requestOrigin);
    const code = normalizeInviteCode(inviteCode);
    const codeHash = digest(code);
    await rateLimit('invite-preview', codeHash, remoteAddress);
    const result = await database.query(`
      SELECT c.id, c.doc FROM public.hg_invite_codes i
        JOIN public.hg_club_config c ON c.id = i.doc->>'clubId'
      WHERE i.doc->>'codeHash' = $1 AND i.doc->>'mode' = 'application'
        AND COALESCE(i.doc->>'targetUserId','') = ''
        AND public.hg_admin_invite_status(i.doc) = 'active'
        AND i.doc->>'rulesVersion' = COALESCE(NULLIF(c.doc->>'rulesVersion',''),'v1.0')
        AND COALESCE(c.doc->>'status','active') = 'active'
        AND COALESCE(c.doc->>'admissionMode','invite_required') <> 'closed'`, [codeHash]);
    if (result.rowCount !== 1) throw new WebAuthError(400, 'invalid_invite', '邀请码无效或已过期');
    const { id, doc } = result.rows[0];
    return { clubId: id, name: doc.name || id, description: doc.description || doc.intro || '',
      rules: doc.rules || doc.charter || '尊重彼此的表达，不泄露他人隐私。',
      rulesVersion: doc.rulesVersion || 'v1.0' };
  }
  async function register({ username, password, displayName, inviteCode, rulesVersion, agreement, origin: requestOrigin, remoteAddress }) {
    assertOrigin(requestOrigin);
    if (process.env.WEB_REGISTRATION === 'closed') throw new WebAuthError(403, 'registration_closed', '注册暂未开放，请联系社团管理员');
    const name = normalizeUsername(username);
    validatePassword(password);
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 20) throw new WebAuthError(400, 'invalid_input', '昵称须为 1–20 个字符');
    const code = inviteCode === undefined ? null : normalizeInviteCode(inviteCode);
    if (code && (agreement !== true || typeof rulesVersion !== 'string' || !rulesVersion || rulesVersion.length > 20)) {
      throw new WebAuthError(400, 'invalid_input', '请先阅读并同意社团约定');
    }
    await rateLimit('register', name, remoteAddress);
    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();
    const identityRef = `web:${crypto.randomUUID()}`;
    if (code) {
      if (typeof database.withTransaction !== 'function') throw new Error('invited registration requires transaction support');
      const codeHash = digest(code);
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      try {
        const clubId = await database.withTransaction(async (client) => {
          // Read the club id before locking, then recheck the invite after taking
          // the same club lock used by normal admission and invite revocation.
          const candidate = await client.query("SELECT id, doc->>'clubId' AS club_id FROM public.hg_invite_codes WHERE doc->>'codeHash'=$1", [codeHash]);
          if (candidate.rowCount !== 1 || !candidate.rows[0].club_id) throw new WebAuthError(400, 'invalid_invite', '邀请码无效或已过期');
          const targetClub = candidate.rows[0].club_id;
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('hg-governance:'||$1::text||':members',0))", [targetClub]);
          const clubResult = await client.query('SELECT doc FROM public.hg_club_config WHERE id=$1 FOR SHARE', [targetClub]);
          const inviteResult = await client.query(`SELECT doc, public.hg_admin_invite_status(doc) AS status
            FROM public.hg_invite_codes WHERE id=$1 AND doc->>'codeHash'=$2 FOR UPDATE`, [candidate.rows[0].id, codeHash]);
          const club = clubResult.rows[0]?.doc;
          const invite = inviteResult.rows[0]?.doc;
          const currentRules = club?.rulesVersion || 'v1.0';
          if (!club || (club.status || 'active') !== 'active' || club.admissionMode === 'closed'
            || !invite || inviteResult.rows[0].status !== 'active' || invite.clubId !== targetClub
            || invite.mode !== 'application' || invite.targetUserId
            || invite.rulesVersion !== currentRules) throw new WebAuthError(400, 'invalid_invite', '邀请码无效或已过期');
          if (rulesVersion !== currentRules) throw new WebAuthError(409, 'rules_changed', '社团约定已更新，请重新核对邀请码');
          const stamp = new Date().toISOString();
          const userDoc = { _id: userId, wxOpenIdRef: identityRef, displayName: displayName.trim(), status: 'active', avatar: '', createdAt: stamp, updatedAt: stamp };
          const applicationId = `application:${crypto.randomUUID()}`;
          const membershipId = `${userId}:${targetClub}`;
          await client.query('INSERT INTO public.hg_users(id,doc) VALUES($1,$2::jsonb)', [userId, JSON.stringify(userDoc)]);
          await client.query('INSERT INTO public.hg_web_accounts(username,user_id,password_hash) VALUES($1,$2,$3)', [name, userId, passwordHash]);
          await client.query('INSERT INTO public.hg_membership_applications(id,doc) VALUES($1,$2::jsonb)', [applicationId, JSON.stringify({
            _id: applicationId, userId, clubId: targetClub, displayName: displayName.trim(),
            inviteId: candidate.rows[0].id, inviteVersion: Number(invite.version) || 1,
            rulesVersion: currentRules, status: 'active', admissionMethod: 'invite',
            reservationStatus: 'consumed', idempotencyKey: crypto.randomUUID(),
            version: 1, createdAt: stamp, updatedAt: stamp, decidedAt: stamp,
          })]);
          await client.query('INSERT INTO public.hg_memberships(id,doc) VALUES($1,$2::jsonb)', [membershipId, JSON.stringify({
            _id: membershipId, userId, clubId: targetClub, status: 'active', role: 'member',
            applicationId, rulesVersion: currentRules, version: 1, joinedAt: stamp, updatedAt: stamp,
          })]);
          await client.query('UPDATE public.hg_invite_codes SET doc=doc||jsonb_build_object(\'usedCount\',$2::integer,\'updatedAt\',$3::text) WHERE id=$1',
            [candidate.rows[0].id, (Number(invite.usedCount) || 0) + 1, stamp]);
          await client.query(`INSERT INTO public.hg_web_sessions(token_hash,user_id,credential_version,origin,expires_at)
            VALUES($1,$2,1,$3,$4)`, [digest(token), userId, configuredOrigin(), expiresAt]);
          return targetClub;
        });
        return { sessionToken: token, csrfToken: csrfFor(token), expiresAt, clubId };
      } catch (error) {
        if (error.code === '23505') throw new WebAuthError(409, 'account_exists', '该账号无法注册，请更换账号或登录');
        throw error;
      }
    }
    try {
      // Conflict aborts both inserts. No orphan user on racing registration.
      await database.query(`
        WITH created AS (
          INSERT INTO public.hg_users (id, doc) VALUES ($1, $2::jsonb) RETURNING id
        ) INSERT INTO public.hg_web_accounts (username, user_id, password_hash)
          SELECT $3, id, $4 FROM created`, [userId, JSON.stringify({ _id: userId, wxOpenIdRef: identityRef, displayName: displayName.trim(), status: 'active', avatar: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), name, passwordHash]);
    } catch (error) {
      if (error.code === '23505') throw new WebAuthError(409, 'account_exists', '该账号无法注册，请更换账号或登录');
      throw error;
    }
    return issueSession(userId, passwordHash);
  }
  async function login({ username, password, origin: requestOrigin, remoteAddress }) {
    assertOrigin(requestOrigin);
    const name = normalizeUsername(username);
    validatePassword(password);
    await rateLimit('login', name, remoteAddress);
    const result = await database.query(`
      SELECT a.user_id, a.password_hash, u.doc->>'status' AS status
        FROM public.hg_web_accounts a JOIN public.hg_users u ON u.id = a.user_id WHERE a.username = $1`, [name]);
    const account = result.rows[0];
    // An unknown account pays the same scrypt cost as a known one.
    const encoded = account ? account.password_hash : `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const valid = await verifyPassword(password, encoded);
    if (!valid || !account || account.status !== 'active') throw new WebAuthError(401, 'unauthenticated', '账号或密码不正确');
    return issueSession(account.user_id, account.password_hash);
  }
  async function resolveSession(req) {
    const token = readCookie(req, secureCookie());
    if (!token) return null;
    const result = await database.query(`
      UPDATE public.hg_web_sessions s SET last_seen_at = NOW()
        FROM public.hg_web_accounts a, public.hg_users u
       WHERE s.token_hash = $1 AND s.user_id = a.user_id AND u.id = a.user_id
         AND s.credential_version = a.version AND s.revoked_at IS NULL
         AND s.origin = $2 AND s.expires_at > NOW() AND s.last_seen_at > NOW() - INTERVAL '24 hours'
         AND u.doc->>'status' = 'active'
      RETURNING s.user_id, u.doc->>'wxOpenIdRef' AS identity_ref, s.expires_at`, [digest(token), configuredOrigin()]);
    if (!result.rowCount || !result.rows[0].identity_ref) return null;
    return { sessionToken: token, userId: result.rows[0].user_id, identity: { openid: result.rows[0].identity_ref, invalid: false }, csrfToken: csrfFor(token), origin: configuredOrigin(), expiresAt: result.rows[0].expires_at, website: true };
  }
  async function revokeSession(session) {
    if (!session) return false;
    const result = await database.query('UPDATE public.hg_web_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL', [digest(session.sessionToken)]);
    return result.rowCount > 0;
  }
  async function changePassword(session, { currentPassword, password, remoteAddress }) {
    validatePassword(password);
    await rateLimit('password', session.userId, remoteAddress);
    const result = await database.query('SELECT password_hash FROM public.hg_web_accounts WHERE user_id = $1', [session.userId]);
    const current = result.rows[0];
    if (!current || !await verifyPassword(currentPassword, current.password_hash)) throw new WebAuthError(401, 'wrong_password', '原密码不正确');
    const passwordHash = await hashPassword(password);
    const changed = await database.query(`
      WITH changed AS (
        UPDATE public.hg_web_accounts SET password_hash = $2, version = version + 1, updated_at = NOW()
        WHERE user_id = $1 AND password_hash = $3 RETURNING user_id
      ) UPDATE public.hg_web_sessions SET revoked_at = NOW()
        WHERE user_id IN (SELECT user_id FROM changed) RETURNING token_hash`, [session.userId, passwordHash, current.password_hash]);
    if (!changed.rowCount) throw new WebAuthError(409, 'conflict', '密码已变化，请重新登录');
    return { changed: true };
  }
  async function provisionAccount({ userId, username, password }) {
    const name = normalizeUsername(username);
    const passwordHash = await hashPassword(password);
    const result = await database.query(`
      WITH configured AS (
        INSERT INTO public.hg_web_accounts (username, user_id, password_hash)
        SELECT $2, id, $3 FROM public.hg_users WHERE id = $1 AND doc->>'status' = 'active'
          AND length(COALESCE(doc->>'wxOpenIdRef', '')) > 0
        ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, version = hg_web_accounts.version + 1, updated_at = NOW()
          WHERE hg_web_accounts.username = EXCLUDED.username
        RETURNING user_id
      ), revoked AS (
        UPDATE public.hg_web_sessions SET revoked_at = NOW() WHERE user_id IN (SELECT user_id FROM configured)
      ) SELECT user_id FROM configured`, [userId, name, passwordHash]);
    if (!result.rowCount) throw new WebAuthError(400, 'invalid_account', '用户不存在、已停用，或已有不同的网站账号');
    return { configured: true };
  }
  return { register, previewInvite, login, resolveSession, revokeSession, changePassword, provisionAccount, assertOrigin, secureCookie };
}
module.exports = { WebAuthError, createWebAuth, hashPassword, verifyPassword, normalizeUsername, normalizeInviteCode, buildCookie, cookieName, readCookie, csrfFor, validCsrf, sameOrigin, digest };
