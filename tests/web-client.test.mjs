import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, safeUrl, createScope, idempotencyKey, routeUrl } from '../web/core.mjs';
import { createApi } from '../web/api.mjs';

test('untrusted post text and media URLs cannot execute code', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/x', 'blob:evil', 'https://user:secret@evil.example']) assert.equal(safeUrl(url), '');
  assert.equal(safeUrl('/v1/media/image?t=signed'), '/v1/media/image?t=signed');
  assert.equal(safeUrl('https://club.example/media'), 'https://club.example/media');
});

test('navigation scope rejects old requests even when switching away and back to same club', () => {
  const scope = createScope();
  const a = scope.begin('club-a');
  assert.equal(scope.current(a), true);
  scope.begin('club-b');
  scope.begin('club-a');
  assert.equal(scope.current(a), false);
});

test('idempotency keys are stable for unchanged form retries and distinct for edited payloads', () => {
  const draft = {};
  const first = idempotencyKey(draft, { body: 'hello' });
  assert.equal(idempotencyKey(draft, { body: 'hello' }), first);
  assert.notEqual(idempotencyKey(draft, { body: 'edited' }), first);
  assert.match(routeUrl('post', 'a/b'), /a%2Fb/);
});

test('browser API keeps cookie credentials and CSRF in memory and propagates server errors', async () => {
  const requests = [];
  const api = createApi(async (url, options = {}) => {
    requests.push({ url, options });
    const result = url.endsWith('/session') ? { authenticated: true, csrfToken: 'csrf-from-server' } : { ok: true };
    return { ok: true, status: 200, json: async () => ({ code: 0, data: result }) };
  });
  await api.session();
  await api.action('posts/list', 'club-b', { cursor: 'server-cursor' });
  assert.equal(requests[1].options.credentials, 'same-origin');
  assert.equal(requests[1].options.headers['X-CSRF-Token'], 'csrf-from-server');
  assert.deepEqual(JSON.parse(requests[1].options.body), { action: 'posts/list', clubId: 'club-b', payload: { cursor: 'server-cursor' } });
  const failed = createApi(async () => ({ ok: false, status: 403, json: async () => ({ code: 'forbidden', message: '权限已变化' }) }));
  await assert.rejects(failed.action('posts/create', 'club-b'), { message: '权限已变化', code: 'forbidden', status: 403 });
});
