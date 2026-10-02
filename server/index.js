'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { validateConfig } = require('./config');

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

function createServer() {
  // Local HTTP API uses the same action handlers and envelope as the former
  // cloud function. The second router argument is server-created and never
  // comes from the JSON body.
  const api = require('../cloudfunctions/api');
  const auth = require('./auth');
  const pg = require('../shared/pg-store');
  const media = require('./media');
  const { HTTP_BY_KIND } = require('../shared/errors');
  const actionHandler = api.createHandler({ identityResolver: auth.resolveBearerIdentity });

  async function handle(req, res) {
    setCorsHeaders(res);
    const requestId = getRequestId();
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = requestUrl.pathname;
    res.setHeader('x-request-id', requestId);

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
