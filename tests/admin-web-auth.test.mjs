import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createServer } = require('../server/index.js');
const {
  ADMIN_WEB_ACTIONS,
  buildSessionCookie,
  cookieName,
  deriveCsrfToken,
  isAllowedOrigin,
  normalizeOrigin,
  readCookie,
  validCsrfToken,
} = require('../server/admin-web-auth.js');

const ORIGIN = 'https://admin.example.test';
const SESSION_TOKEN = 'a'.repeat(43);
const CSRF_TOKEN = deriveCsrfToken(SESSION_TOKEN);
const COOKIE_NAME = cookieName();

function makeAuthStub() {
  return {
    async createPairing({ origin }) {
      assert.equal(origin, ORIGIN);
      return {
        id: 'pairing-123',
        qrText: 'blacklight-admin:pairing-123',
        qrSvg: '<svg></svg>',
        expiresAt: '2026-10-03T12:02:00.000Z',
        pollKey: 'p'.repeat(43),
      };
    },
    async getPairingStatus() { return { status: 'pending' }; },
    async redeemPairing() {
      return { sessionToken: SESSION_TOKEN, csrfToken: CSRF_TOKEN };
    },
    async resolveSession(req) {
      if (!String(req.headers.cookie || '').includes(`${COOKIE_NAME}=${SESSION_TOKEN}`)) return null;
      return {
        sessionToken: SESSION_TOKEN,
        csrfToken: CSRF_TOKEN,
        origin: ORIGIN,
        identity: { openid: 'synthetic-openid', invalid: false },
        publicSession: {
          user: { id: 'synthetic-user', displayName: '测试用户' },
          platformRole: 'none',
          clubs: [],
          csrfToken: CSRF_TOKEN,
        },
      };
    },
    async revokeSession() { return true; },
  };
}

test('browser security helpers bind canonical Origin, cookie CSRF, and secure production flags', () => {
  assert.equal(normalizeOrigin(ORIGIN), ORIGIN);
  assert.equal(isAllowedOrigin(ORIGIN, 'https://admin.example.test/v1'), true);
  assert.equal(isAllowedOrigin('https://admin.example.test.attacker.invalid', 'https://admin.example.test/v1'), false);
  assert.equal(normalizeOrigin('https://admin.example.test/path'), null);
  assert.equal(readCookie(`other=x; ${COOKIE_NAME}=${SESSION_TOKEN}`), SESSION_TOKEN);
  assert.equal(readCookie(`${COOKIE_NAME}=${SESSION_TOKEN}; ${COOKIE_NAME}=${SESSION_TOKEN}`), null);
  assert.equal(deriveCsrfToken(SESSION_TOKEN), 'KVlVrSw7nYcTGJ5fhgXqvtCHNN25AttH3zcevn6uzsw');
  assert.equal(validCsrfToken(SESSION_TOKEN, CSRF_TOKEN), true);
  assert.equal(validCsrfToken(SESSION_TOKEN, 'wrong'), false);
  assert.match(buildSessionCookie(SESSION_TOKEN, { secure: true }), /HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/);
  assert.equal(ADMIN_WEB_ACTIONS.has('admin/overview'), true);
  assert.equal(ADMIN_WEB_ACTIONS.has('admin/appeal/decide'), true);
  assert.equal(ADMIN_WEB_ACTIONS.has('admin/anonymous/reveal'), false);
  assert.equal(ADMIN_WEB_ACTIONS.has('account/recovery/accept'), false);
});

async function withServer(run, webActionHandler = null) {
  const server = createServer({ adminWebAuth: makeAuthStub(), webActionHandler });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('pairing creation returns a QR payload and keeps its poll key outside the QR text', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/admin/auth/pairings`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.qrText, 'blacklight-admin:pairing-123');
    assert.equal(result.pollKey, 'p'.repeat(43));
    assert.equal(result.qrText.includes(result.pollKey), false);
    assert.match(result.qrSvg, /^<svg/);
  });
});

test('cookie-authenticated admin actions reject a browser origin different from the QR-approved origin', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/admin/action`, {
      method: 'POST',
      headers: {
        origin: 'https://attacker.example.test',
        cookie: `${COOKIE_NAME}=${SESSION_TOKEN}`,
        'x-csrf-token': CSRF_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'admin/overview', clubId: 'club-a', payload: {} }),
    });
    assert.equal(response.status, 403);
  });
});

test('cookie-authenticated admin actions reject missing CSRF tokens even on the approved origin', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/admin/action`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        cookie: `${COOKIE_NAME}=${SESSION_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'admin/overview', clubId: 'club-a', payload: {} }),
    });
    assert.equal(response.status, 403);
  });
});

test('same-origin action with the matching CSRF token reaches the router with server-derived identity', async () => {
  let received = null;
  const actionHandler = async (event, context) => {
    received = { event, context };
    return { code: 0, message: 'ok', data: { overview: true }, requestId: 'request-1' };
  };
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/admin/action`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        cookie: `${COOKIE_NAME}=${SESSION_TOKEN}`,
        'x-csrf-token': CSRF_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'admin/overview', clubId: 'club-a', payload: {} }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { code: 0, message: 'ok', data: { overview: true }, requestId: 'request-1' });
  }, actionHandler);
  assert.equal(received.event.action, 'admin/overview');
  assert.equal(received.context.adminWebIdentity.openid, 'synthetic-openid');
});

test('browser admin action endpoint rejects actions outside the management whitelist', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/admin/action`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        cookie: `${COOKIE_NAME}=${SESSION_TOKEN}`,
        'x-csrf-token': CSRF_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'admin/anonymous/reveal', clubId: 'club-a', payload: { reason: 'test' } }),
    });
    assert.equal(response.status, 400);
  });
});
