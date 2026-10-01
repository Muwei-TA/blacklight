'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const pg = require('../shared/pg-store');

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

class WechatAuthError extends Error {
  constructor(code = 'WECHAT_AUTH_FAILED') {
    super('微信登录失败');
    this.name = 'WechatAuthError';
    this.code = code;
  }
}

function requestJson(url, { timeoutMs = 8000, maxBytes = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { accept: 'application/json' } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy(new WechatAuthError('WECHAT_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new WechatAuthError('WECHAT_HTTP_ERROR'));
        try { return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { return reject(new WechatAuthError('WECHAT_INVALID_RESPONSE')); }
      });
      res.on('error', () => reject(new WechatAuthError('WECHAT_RESPONSE_ERROR')));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new WechatAuthError('WECHAT_TIMEOUT')));
    req.on('error', (error) => reject(error instanceof WechatAuthError ? error : new WechatAuthError('WECHAT_NETWORK_ERROR')));
  });
}

async function exchangeCode(code) {
  if (typeof code !== 'string' || !code.trim() || code.length > 512) throw new WechatAuthError('INVALID_CODE');
  const appId = process.env.MINIPROGRAM_APP_ID;
  const appSecret = process.env.MINIPROGRAM_APP_SECRET;
  if (!appId || !appSecret) throw new WechatAuthError('WECHAT_CONFIG_MISSING');
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', appId);
  url.searchParams.set('secret', appSecret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');
  const result = await requestJson(url);
  if (result.errcode || typeof result.openid !== 'string' || !result.openid) {
    throw new WechatAuthError(`WECHAT_CODE_${Number(result.errcode) || 'INVALID'}`);
  }
  // session_key is intentionally neither retained nor returned to the caller.
  return result.openid;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function sessionTtlSeconds() {
  const configured = Number(process.env.SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS);
  return Number.isInteger(configured) ? Math.max(15 * 60, Math.min(configured, 30 * 24 * 60 * 60)) : DEFAULT_SESSION_TTL_SECONDS;
}

async function issueSession(openid, { now = Date.now(), ttlSeconds = sessionTtlSeconds() } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
  await pg.query(
    `INSERT INTO public.hg_sessions (token_hash, openid_ref, expires_at, revoked_at, created_at)
     VALUES ($1, $2, $3, NULL, NOW())`,
    [tokenHash(token), openid, expiresAt],
  );
  return { token, expiresAt };
}

function readBearerToken(header) {
  if (header === undefined || header === null || header === '') return { token: null, supplied: false };
  if (typeof header !== 'string') return { token: null, supplied: true };
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  return { token: match ? match[1] : null, supplied: true };
}

async function lookupSession(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  const result = await pg.query(
    `SELECT openid_ref
       FROM public.hg_sessions
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()
      LIMIT 1`,
    [tokenHash(token)],
  );
  return result.rows[0] || null;
}

async function resolveBearerIdentity(context = {}) {
  const header = context.request && context.request.headers
    ? context.request.headers.authorization
    : context.authorization;
  const parsed = readBearerToken(header);
  if (!parsed.supplied) return { openid: null, invalid: false };
  if (!parsed.token) return { openid: null, invalid: true };
  const session = await lookupSession(parsed.token);
  if (!session || !session.openid_ref) return { openid: null, invalid: true };
  return { openid: session.openid_ref, invalid: false };
}

async function revokeBearer(header) {
  const parsed = readBearerToken(header);
  if (!parsed.supplied || !parsed.token) return false;
  const result = await pg.query(
    `UPDATE public.hg_sessions
        SET revoked_at = NOW()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()`,
    [tokenHash(parsed.token)],
  );
  return result.rowCount > 0;
}

async function loginWithCode(code) {
  const openid = await exchangeCode(code);
  return issueSession(openid);
}

module.exports = {
  DEFAULT_SESSION_TTL_SECONDS,
  WechatAuthError,
  exchangeCode,
  issueSession,
  readBearerToken,
  lookupSession,
  resolveBearerIdentity,
  revokeBearer,
  loginWithCode,
};
