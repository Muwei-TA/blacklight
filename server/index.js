'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { validateConfig } = require('./config');
const { createWebAuth, validCsrf, buildCookie } = require('./web-auth');
const { createWebHttp } = require('./web-http');
const {
  ADMIN_WEB_ACTIONS,
  AdminWebAuthError,
  createAdminWebAuth,
  normalizeOrigin,
  validCsrfToken,
  buildSessionCookie,
} = require('./admin-web-auth');

const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;
const MAX_AUTH_BODY_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', body.length);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(body);
}

async function readJson(req, limitBytes) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'invalid_input', '请求格式不正确');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw new HttpError(415, 'invalid_input', '请求格式不正确');
  }
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > limitBytes) throw new HttpError(413, 'invalid_input', '请求内容过大');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'invalid_input', '请求内容过大');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
    return value;
  } catch (_) {
    throw new HttpError(400, 'invalid_input', '请求内容不合法');
  }
}

function getRequestId() {
  return crypto.randomUUID();
}

function setCorsHeaders(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
  res.setHeader('access-control-max-age', '600');
}

function createServer({ adminWebAuth = createAdminWebAuth(), webActionHandler = null, websiteAuth = createWebAuth() } = {}) {
  // Local HTTP API uses the same action handlers and envelope as the former
  // cloud function. The second router argument is server-created and never
  // comes from the JSON body.
  const api = require('../cloudfunctions/api');
  const auth = require('./auth');
  const pg = require('../shared/pg-store');
  const media = require('./media');
  const { HTTP_BY_KIND } = require('../shared/errors');
  const actionHandler = api.createHandler({ identityResolver: auth.resolveBearerIdentity });
  const adminActionHandler = webActionHandler || api.createHandler({
    identityResolver: async (context = {}) => ({ ...(context.adminWebIdentity || { openid: null, invalid: false }), channel: 'web' }),
  });

  const websiteHandler = api.createHandler({ identityResolver: async (context = {}) => ({ ...(context.webIdentity || { openid: null, invalid: false }), channel: 'web' }) });
  const handleWebsite = createWebHttp({ auth: websiteAuth, actionHandler: websiteHandler, mediaSessionResolver: resolveAdminSession });
  async function resolveAdminSession(req) {
    return await adminWebAuth.resolveSession(req) || websiteAuth.resolveSession(req);
  }
  function validAdminCsrf(session, supplied) {
    return session.website ? validCsrf(session.sessionToken, supplied) : validCsrfToken(session.sessionToken, supplied);
  }

  async function handle(req, res) {
    const requestId = getRequestId();
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = requestUrl.pathname;
    res.setHeader('x-request-id', requestId);

    if (!pathname.startsWith('/v1/admin/') && pathname !== '/admin' && !pathname.startsWith('/admin/')) {
      setCorsHeaders(res);
    } else {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('cross-origin-resource-policy', 'same-origin');
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('content-security-policy', "frame-ancestors 'none'");
    }

    if (await handleWebsite(req, res, pathname, requestId)) return;

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/health') {
      try {
        await pg.ping();
        let worker = 'starting';
        try {
          const result = await pg.query(`
            SELECT count(*) AS active_count,
              count(*) FILTER (WHERE NULLIF(doc->>'workerLastRunAt', '')::timestamptz >= now() - interval '3 minutes') AS healthy_count
            FROM public.hg_club_config
            WHERE COALESCE(doc->>'status', CASE WHEN id = 'heiguang' THEN 'active' END) = 'active'
          `);
          const activeCount = Number(result.rows[0] && result.rows[0].active_count || 0);
          const healthyCount = Number(result.rows[0] && result.rows[0].healthy_count || 0);
          if (activeCount > 0) worker = healthyCount === activeCount ? 'healthy' : 'stale';
        } catch (_) {
          worker = 'unknown';
        }
        sendJson(res, 200, { code: 0, message: 'ok', data: { status: 'ok', database: 'ok', worker }, requestId });
      } catch (error) {
        console.error('[http] health check failed', { requestId, code: error.code || 'database_unavailable' });
        sendJson(res, 503, { code: 'server', message: '服务暂时不可用，请稍后重试', requestId });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/auth/wechat') {
      try {
        const body = await readJson(req, MAX_AUTH_BODY_BYTES);
        const session = await auth.loginWithCode(body.code);
        sendJson(res, 200, {
          code: 0,
          message: 'ok',
          data: { token: session.token, expiresAt: session.expiresAt },
          requestId,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { code: error.code, message: error.message, requestId });
        } else if (error instanceof auth.WechatAuthError) {
          sendJson(res, 401, { code: 'unauthenticated', message: '微信登录失败，请重新登录', requestId });
        } else {
          console.error('[http] login failed', { requestId, code: error.code || 'login_error' });
          sendJson(res, 503, { code: 'server', message: '服务暂时不可用，请稍后重试', requestId });
        }
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/auth/logout') {
      const parsed = auth.readBearerToken(req.headers.authorization);
      if (!parsed.supplied || !parsed.token) {
        sendJson(res, 401, { code: 'unauthenticated', message: '需要先完成授权', requestId });
        return;
      }
      try {
        await auth.revokeBearer(req.headers.authorization);
        sendJson(res, 200, { code: 0, message: 'ok', data: { loggedOut: true }, requestId });
      } catch (error) {
        console.error('[http] logout failed', { requestId, code: error.code || 'logout_error' });
        sendJson(res, 503, { code: 'server', message: '服务暂时不可用，请稍后重试', requestId });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/admin/auth/pairings') {
      try {
        await readJson(req, MAX_AUTH_BODY_BYTES);
        const pairing = await adminWebAuth.createPairing({
          origin: req.headers.origin,
          remoteAddress: req.socket.remoteAddress || '',
        });
        sendJson(res, 200, pairing);
      } catch (error) {
        sendAdminError(res, error, requestId, 'pairing_create');
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/admin/auth/pairings/status') {
      try {
        const body = await readJson(req, MAX_AUTH_BODY_BYTES);
        const status = await adminWebAuth.getPairingStatus({
          id: body.id,
          pollKey: body.pollKey,
          origin: req.headers.origin,
        });
        sendJson(res, 200, status);
      } catch (error) {
        sendAdminError(res, error, requestId, 'pairing_status');
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/admin/auth/exchange') {
      try {
        const body = await readJson(req, MAX_AUTH_BODY_BYTES);
        const session = await adminWebAuth.redeemPairing({
          id: body.id,
          pollKey: body.pollKey,
          exchangeCode: body.exchangeCode,
          origin: req.headers.origin,
        });
        res.setHeader('set-cookie', buildSessionCookie(session.sessionToken));
        sendJson(res, 200, { csrfToken: session.csrfToken });
      } catch (error) {
        sendAdminError(res, error, requestId, 'pairing_exchange');
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/v1/admin/session') {
      try {
        const session = await resolveAdminSession(req);
        if (!session) throw new HttpError(401, 'unauthenticated', '请重新扫码登录');
        const suppliedOrigin = req.headers.origin;
        if (suppliedOrigin && normalizeOrigin(suppliedOrigin) !== session.origin) {
          throw new HttpError(403, 'invalid_origin', '管理台来源不匹配');
        }
        const context = { requestId, adminWebIdentity: session.identity };
        const [accountResult, clubsResult] = await Promise.all([
          adminActionHandler({ action: 'account/me', payload: {} }, context),
          adminActionHandler({ action: 'clubs/mine', payload: {} }, context),
        ]);
        if (!accountResult || accountResult.code !== 0 || !clubsResult || clubsResult.code !== 0) {
          const result = accountResult && accountResult.code !== 0 ? accountResult : clubsResult;
          const status = result && result.code === 'unauthenticated' ? 401 : 503;
          throw new HttpError(status, result && result.code || 'session_unavailable', '管理会话暂不可用，请重新登录');
        }
        const account = accountResult.data || {};
        const clubs = clubsResult.data && Array.isArray(clubsResult.data.list) ? clubsResult.data.list : [];
        sendJson(res, 200, {
          user: account.user ? { id: account.user.id, displayName: account.user.displayName || '' } : null,
          platformRole: account.platformRole === 'developer' ? 'developer' : 'none',
          clubs: clubs.filter((club) => club.status === 'active' && club.memberStatus === 'active'
            && ['admin', 'moderator'].includes(club.role))
            .map((club) => ({ id: club.id, name: club.name || '', role: club.role })),
          csrfToken: session.csrfToken,
        });
      } catch (error) {
        sendAdminError(res, error, requestId, 'session_read');
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/admin/action') {
      try {
        const body = await readJson(req, MAX_JSON_BODY_BYTES);
        if (typeof body.action !== 'string' || !ADMIN_WEB_ACTIONS.has(body.action)) {
          throw new HttpError(400, 'invalid_input', '请求动作不受管理台支持');
        }
        if (body.clubId !== undefined && (typeof body.clubId !== 'string' || body.clubId.length > 64)) {
          throw new HttpError(400, 'invalid_input', '请求内容不合法');
        }
        if (body.payload !== undefined && (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload))) {
          throw new HttpError(400, 'invalid_input', '请求内容不合法');
        }
        const session = await resolveAdminSession(req);
        if (!session) throw new HttpError(401, 'unauthenticated', '请重新扫码登录');
        if (normalizeOrigin(req.headers.origin) !== session.origin) {
          throw new HttpError(403, 'invalid_origin', '管理台来源不匹配');
        }
        if (!validAdminCsrf(session, req.headers['x-csrf-token'])) {
          throw new HttpError(403, 'csrf_failed', '页面状态已过期，请刷新后重试');
        }
        const result = await adminActionHandler({
          action: body.action,
          clubId: body.clubId,
          payload: body.payload || {},
        }, { requestId, adminWebIdentity: session.identity });
        const status = result.code === 0 ? 200 : (HTTP_BY_KIND[result.code] || 500);
        sendJson(res, status, result);
      } catch (error) {
        sendAdminError(res, error, requestId, 'admin_action');
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/admin/auth/logout') {
      try {
        const body = await readJson(req, MAX_AUTH_BODY_BYTES);
        if (Object.keys(body).length > 0) throw new HttpError(400, 'invalid_input', '请求内容不合法');
        const session = await resolveAdminSession(req);
        if (!session) throw new HttpError(401, 'unauthenticated', '请重新扫码登录');
        if (normalizeOrigin(req.headers.origin) !== session.origin) {
          throw new HttpError(403, 'invalid_origin', '管理台来源不匹配');
        }
        if (!validAdminCsrf(session, req.headers['x-csrf-token'])) {
          throw new HttpError(403, 'csrf_failed', '页面状态已过期，请刷新后重试');
        }
        if (session.website) {
          await websiteAuth.revokeSession(session);
          res.setHeader('set-cookie', buildCookie('', { secure: websiteAuth.secureCookie(), clear: true }));
        } else {
          await adminWebAuth.revokeSession(session);
          res.setHeader('set-cookie', buildSessionCookie('', { clear: true }));
        }
        sendJson(res, 200, { loggedOut: true });
      } catch (error) {
        sendAdminError(res, error, requestId, 'session_logout');
      }
      return;
    }

    if (pathname === '/v1/review/callback') {
      // CloudBase supplied invocation provenance for the callback function.
      // NAS has no verified WeChat signature or trusted ingress yet, so this
      // endpoint must not mutate review state from ordinary HTTP fields.
      sendJson(res, 503, { code: 'feature_disabled', message: '审核回调尚未启用', requestId });
      return;
    }

    if (req.method === 'POST' && pathname === '/v1/action') {
      try {
        const body = await readJson(req, MAX_JSON_BODY_BYTES);
        if (typeof body.action !== 'string' || !body.action || (body.payload !== undefined && (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)))) {
          throw new HttpError(400, 'invalid_input', '请求内容不合法');
        }
        const result = await actionHandler(
          { action: body.action, clubId: body.clubId, payload: body.payload || {} },
          { requestId, request: { headers: req.headers } },
        );
        const status = result.code === 0 ? 200 : (HTTP_BY_KIND[result.code] || 500);
        sendJson(res, status, result);
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, error.status, { code: error.code, message: error.message, requestId });
        } else {
          console.error('[http] action failed', { requestId, code: error.code || 'action_error' });
          sendJson(res, 503, { code: 'server', message: '服务暂时不可用，请稍后重试', requestId });
        }
      }
      return;
    }

    const mediaMatch = /^\/v1\/media\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
    if (req.method === 'GET' && mediaMatch) {
      try {
        const item = await media.getAuthorizedMedia({
          assetId: mediaMatch[1],
          token: requestUrl.searchParams.get('t'),
          signature: requestUrl.searchParams.get('s'),
        });
        if (!item) {
          sendJson(res, 404, { code: 'not_accessible', message: '这条内容当前不可访问', requestId });
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', item.contentType);
        res.setHeader('content-length', item.content.length);
        res.setHeader('cache-control', 'private, no-store');
        res.setHeader('x-content-type-options', 'nosniff');
        // WeChat renders signed HTTPS images inside a separate WebView origin.
        // The short-lived signature and server-side permission check guard
        // access; same-site CORP would prevent that WebView from displaying it.
        res.setHeader('cross-origin-resource-policy', 'cross-origin');
        res.end(item.content);
      } catch (error) {
        console.error('[http] media request failed', { requestId, code: error.code || 'media_error' });
        sendJson(res, 503, { code: 'server', message: '服务暂时不可用，请稍后重试', requestId });
      }
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/admin' || pathname.startsWith('/admin/'))) {
      try {
        if (pathname === '/admin') {
          res.statusCode = 308;
          res.setHeader('location', '/admin/');
          res.end();
          return;
        }
        const encodedRelativePath = pathname.slice('/admin/'.length) || 'index.html';
        let relativePath;
        try { relativePath = decodeURIComponent(encodedRelativePath); }
        catch (_) { throw new HttpError(400, 'invalid_input', '请求路径不合法'); }
        if (!relativePath || relativePath.split('/').some((part) => !part || part.startsWith('.'))) {
          throw new HttpError(404, 'not_accessible', '页面不存在');
        }
        const root = path.resolve(__dirname, '../admin-web');
        const filePath = path.resolve(root, relativePath);
        if (!filePath.startsWith(`${root}${path.sep}`)) throw new HttpError(404, 'not_accessible', '页面不存在');
        const content = await fs.readFile(filePath);
        const contentTypes = {
          '.css': 'text/css; charset=utf-8',
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.mjs': 'text/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
        };
        res.statusCode = 200;
        res.setHeader('content-type', contentTypes[path.extname(filePath)] || 'application/octet-stream');
        res.setHeader('content-length', content.length);
        if (req.method === 'HEAD') res.end();
        else res.end(content);
      } catch (error) {
        if (error instanceof HttpError) sendJson(res, error.status, { code: error.code, message: error.message, requestId });
        else if (error && error.code === 'ENOENT') sendJson(res, 404, { code: 'not_accessible', message: '页面不存在', requestId });
        else {
          console.error('[http] admin static file failed', { requestId, code: error.code || 'static_error' });
          sendJson(res, 503, { code: 'server', message: '页面暂时不可用', requestId });
        }
      }
      return;
    }

    sendJson(res, 404, { code: 'not_accessible', message: '这条内容当前不可访问', requestId });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const requestId = res.getHeader('x-request-id') || getRequestId();
      console.error('[http] unhandled request failure', { requestId, code: error.code || 'http_error' });
      if (!res.headersSent) sendJson(res, 500, { code: 'server', message: '服务暂时不可用，请稍后重试', requestId });
      else res.destroy();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}

function sendAdminError(res, error, requestId, operation) {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { code: error.code, message: error.message, requestId });
  } else if (error instanceof AdminWebAuthError) {
    sendJson(res, error.status, { code: error.code, message: error.message, requestId });
  } else {
    console.error(`[http] admin ${operation} failed`, { requestId, code: error.code || 'admin_error' });
    sendJson(res, 503, { code: 'server', message: '管理台服务暂时不可用，请稍后重试', requestId });
  }
}

async function start() {
  validateConfig();
  const server = createServer();
  const port = Number(process.env.PORT || 3000);
  server.listen(Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3000, '0.0.0.0', () => {
    console.log('[http] API listening', { port: server.address().port });
  });
  const close = () => {
    server.close(async () => {
      await require('../shared/pg-store').close().catch(() => {});
      process.exit(0);
    });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error('[http] startup failed', { code: error.code || 'startup_error' });
    process.exitCode = 1;
  });
}

module.exports = { createServer, start, readJson, MAX_JSON_BODY_BYTES, MAX_AUTH_BODY_BYTES };
