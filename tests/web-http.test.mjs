import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
const require = createRequire(import.meta.url);
const { createWebHttp } = require('../server/web-http.js');
const { csrfFor } = require('../server/web-auth.js');

async function withServer(run) {
  const token = 'x'.repeat(43);
  const session = { sessionToken: token, identity: { openid: 'trusted-web-user' }, origin: 'https://club.example', csrfToken: csrfFor(token) };
  const calls = [];
  const auth = {
    secureCookie: () => true,
    assertOrigin(value) { if (value !== session.origin) throw Object.assign(new Error('origin rejected'), { status: 403, code: 'invalid_origin' }); },
    resolveSession: async (req) => req.headers.cookie ? session : null,
    login: async () => ({ sessionToken: token, csrfToken: session.csrfToken }),
  };
  const handle = createWebHttp({ auth, actionHandler: async (body, context) => { calls.push({ body, context }); return { code: 0, data: { ok: true } }; } });
  const server = http.createServer(async (req, res) => {
    try { if (!await handle(req, res, new URL(req.url, 'http://localhost').pathname, 'test')) { res.writeHead(404); res.end(); } }
    catch (_) { res.writeHead(500); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, session, calls); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
const post = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://club.example', ...headers }, body: JSON.stringify(body) });

test('browser actions enforce origin and CSRF and resolve identity only from server session', async () => withServer(async (base, session, calls) => {
  const body = { action: 'posts/create', clubId: 'club-a', payload: { ownerId: 'forged', role: 'moderator' }, identity: { openid: 'evil' } };
  assert.equal((await fetch(`${base}/v1/web/action`, post(body, { Cookie: 'session=test' }))).status, 403);
  assert.equal((await fetch(`${base}/v1/web/action`, post(body, { Cookie: 'session=test', 'X-CSRF-Token': session.csrfToken, Origin: 'https://evil.example' }))).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await fetch(`${base}/v1/web/action`, post(body, { Cookie: 'session=test', 'X-CSRF-Token': session.csrfToken }))).status, 200);
  assert.equal(calls[0].context.webIdentity.openid, 'trusted-web-user');
  assert.equal(calls[0].body.identity, undefined);
  assert.equal(calls[0].body.clubId, 'club-a');
}));

test('guest cannot mutate and login never returns session secret in JSON', async () => withServer(async (base, _session, calls) => {
  assert.equal((await fetch(`${base}/v1/web/action`, post({ action: 'posts/create' }))).status, 401);
  assert.equal(calls.length, 0);
  const response = await fetch(`${base}/v1/web/auth/login`, post({ username: 'reader', password: 'some password' }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const result = await response.json();
  assert.equal(result.data.sessionToken, undefined);
  assert.ok(result.data.csrfToken);
}));

test('static site files have CSP and do not expose server or hidden files', async () => withServer(async (base) => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(home.headers.get('access-control-allow-origin'), null);
  for (const filename of ['server/index.js', '.env', '%2e%2e%2fserver%2fauth.js', 'missing.mjs']) {
    assert.equal((await fetch(`${base}/web/${filename}`)).status, 404);
  }
}));
