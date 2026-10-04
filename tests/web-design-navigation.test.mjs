import test from 'node:test';
import assert from 'node:assert/strict';
import { shell } from '../web/views.mjs';

// Publish affordances must respect the same membership/capability gate as the composer.
// Changing navigation back to authentication-only would send restricted members to a dead end.
test('publish navigation sends restricted members to membership status and guests to login', () => {
  const cases = [
    { account: { authenticated: true, user: { displayName: '测试' } }, session: { memberStatus: 'active', capabilities: { publishing: true } }, destination: '#/write' },
    { account: { authenticated: true, user: { displayName: '测试' } }, session: { memberStatus: 'active', capabilities: { publishing: false } }, destination: '#/join' },
    { account: { authenticated: true, user: { displayName: '测试' } }, session: { memberStatus: 'pending', capabilities: { publishing: true } }, destination: '#/join' },
    { account: { authenticated: false }, session: null, destination: '#/login' },
  ];
  for (const { account, session, destination } of cases) {
    const html = shell({ account, session, route: { name: 'home', id: '' }, clubs: { list: [] }, page: { items: [] } });
    const href = html.match(/<a\b[^>]*class="[^"]*write-button[^"]*"[^>]*href="([^"]+)"/);
    assert.equal(href?.[1], destination, `publish destination for ${session?.memberStatus || 'guest'} / ${session?.capabilities?.publishing}`);
  }
});
