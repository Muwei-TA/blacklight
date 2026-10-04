'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { isIP } = require('node:net');
const { WebAuthError, buildCookie, validCsrf } = require('./web-auth');
const { HTTP_BY_KIND } = require('../shared/errors');
const PUBLIC_READS = new Set(['account/me', 'session/me', 'clubs/list', 'clubs/detail', 'posts/list', 'posts/detail', 'posts/comments/list', 'topics/list', 'topics/detail', 'boards/list', 'boards/detail', 'collections/list', 'collections/detail', 'search/query', 'search/suggestions', 'profile/get']);
const STATIC_FILES = new Set(['index.html', 'styles.css', 'api.mjs', 'core.mjs', 'views.mjs', 'flows.mjs', 'app.mjs', 'favicon.svg']);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: http: blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function requestAddress(req, trustedProxies = (process.env.WEB_TRUSTED_PROXY_IPS || '').split(',').map((value) => value.trim()).filter(Boolean)) {
  const normalize = (value) => typeof value === 'string' && value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  const direct = normalize(req.socket.remoteAddress || '');
  if (!trustedProxies.map(normalize).includes(direct)) return direct;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string') return direct;
  const nearest = normalize(forwarded.split(',').at(-1).trim());
  return isIP(nearest) ? nearest : direct;
}
function send(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}
async function readBody(req, maxBytes = 4 * 1024 * 1024) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json' || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) throw new WebAuthError(415, 'invalid_input', '请求格式不正确');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new WebAuthError(413, 'invalid_input', '请求内容过大');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (_) { throw new WebAuthError(400, 'invalid_input', '请求内容不合法'); }
}
function createWebHttp({ auth, actionHandler }) {
  return async function handle(req, res, pathname, requestId) {
    const staticRequest = pathname === '/' || pathname === '/web' || pathname === '/web/' || pathname.startsWith('/web/');
    if (!staticRequest && !pathname.startsWith('/v1/web/')) return false;
    res.removeHeader('access-control-allow-origin');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', CSP);
    try {
      if (staticRequest) {
        if (!['GET', 'HEAD'].includes(req.method)) throw new WebAuthError(405, 'invalid_input', '请求方法不支持');
        const filename = ['/', '/web', '/web/'].includes(pathname) ? 'index.html' : pathname.slice(5);
        if (!STATIC_FILES.has(filename)) throw new WebAuthError(404, 'not_accessible', '页面不存在');
        let content;
        try { content = await fs.readFile(path.join(__dirname, '../web', filename)); }
        catch (error) { if (error.code === 'ENOENT') throw new WebAuthError(404, 'not_accessible', '页面不存在'); throw error; }
        const type = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.svg': 'image/svg+xml' }[path.extname(filename)];
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'content-length': content.length });
        res.end(req.method === 'HEAD' ? undefined : content);
        return true;
      }
      if (pathname === '/v1/web/session' && req.method === 'GET') {
        const session = await auth.resolveSession(req);
        if (req.headers.origin) auth.assertOrigin(req.headers.origin);
        if (!session) { send(res, 200, { code: 0, data: { authenticated: false } }); return true; }
        const result = await actionHandler({ action: 'account/me', payload: {} }, { requestId, webIdentity: session.identity });
        if (result.code !== 0) { send(res, HTTP_BY_KIND[result.code] || 500, result); return true; }
        send(res, 200, { code: 0, data: { authenticated: true, ...result.data, csrfToken: session.csrfToken } });
        return true;
      }
      if (req.method !== 'POST') throw new WebAuthError(405, 'invalid_input', '请求方法不支持');
      auth.assertOrigin(req.headers.origin);
      const body = await readBody(req, pathname === '/v1/web/action' ? undefined : 16 * 1024);
      if (['/v1/web/auth/login', '/v1/web/auth/register'].includes(pathname)) {
        const operation = pathname.endsWith('/login') ? 'login' : 'register';
        const session = await auth[operation]({ ...body, origin: req.headers.origin, remoteAddress: requestAddress(req) });
        res.setHeader('set-cookie', buildCookie(session.sessionToken, { secure: auth.secureCookie() }));
        send(res, 200, { code: 0, data: { csrfToken: session.csrfToken, expiresAt: session.expiresAt } });
        return true;
      }
      const session = await auth.resolveSession(req);
      if (session && !validCsrf(session.sessionToken, req.headers['x-csrf-token'])) throw new WebAuthError(403, 'csrf_failed', '页面状态已过期，请刷新后重试');
      if (pathname === '/v1/web/action') {
        if (typeof body.action !== 'string' || !body.action || (body.clubId !== undefined && (typeof body.clubId !== 'string' || body.clubId.length > 64)) || (body.payload !== undefined && (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)))) throw new WebAuthError(400, 'invalid_input', '请求内容不合法');
        if (!session && !PUBLIC_READS.has(body.action)) throw new WebAuthError(401, 'unauthenticated', '请先登录');
        if (body.action.startsWith('account/web-login/')) throw new WebAuthError(400, 'invalid_input', '请使用网站账号登录');
        if (process.env.REVIEW_PROVIDER === 'manual' && body.action.startsWith('assets/')) throw new WebAuthError(403, 'feature_disabled', '图片上传尚未开放');
        const result = await actionHandler({ action: body.action, clubId: body.clubId, payload: body.payload || {} }, { requestId, webIdentity: session ? session.identity : { openid: null, invalid: false } });
        if (result.code === 0 && body.action === 'session/me' && result.data && process.env.REVIEW_PROVIDER === 'manual') result.data.capabilities = { ...result.data.capabilities, uploads: false, video: false };
        send(res, result.code === 0 ? 200 : HTTP_BY_KIND[result.code] || 500, result);
        return true;
      }
      if (!session) throw new WebAuthError(401, 'unauthenticated', '请先登录');
      if (pathname === '/v1/web/auth/logout') {
        await auth.revokeSession(session);
        res.setHeader('set-cookie', buildCookie('', { secure: auth.secureCookie(), clear: true }));
        send(res, 200, { code: 0, data: { loggedOut: true } });
        return true;
      }
      if (pathname === '/v1/web/auth/password') {
        const result = await auth.changePassword(session, { ...body, remoteAddress: requestAddress(req) });
        res.setHeader('set-cookie', buildCookie('', { secure: auth.secureCookie(), clear: true }));
        send(res, 200, { code: 0, data: result });
        return true;
      }
      throw new WebAuthError(404, 'not_accessible', '接口不存在');
    } catch (error) {
      if (error.status && error.code) send(res, error.status, { code: error.code, message: error.message, requestId });
      else {
        console.error('[web] request failed', { requestId, code: error.code || 'web_error' });
        send(res, 503, { code: 'server', message: '服务暂时不可用，请稍后重试', requestId });
      }
    }
    return true;
  };
}
module.exports = { createWebHttp, requestAddress };
