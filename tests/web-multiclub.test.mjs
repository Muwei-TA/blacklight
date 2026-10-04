import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../web/core.mjs';
import { shell } from '../web/views.mjs';

test('unselected member website uses neutral community copy and selected club names stay dynamic', () => {
  const unselected = shell({
    account: { authenticated: false },
    clubs: { list: [{ id: 'club-a', name: '青鸟社' }] },
    route: { name: 'clubs', id: '' },
    page: { directory: { items: [] }, mine: { items: [] } },
  });
  assert.match(unselected, /选择社团|多社团空间/);
  assert.doesNotMatch(unselected, /黑光文学社|黑光社区/);
  assert.match(unselected, /<option value="" selected disabled>选择社团<\/option>/);

  const selected = shell({
    account: { authenticated: true, user: { displayName: '测试' } },
    clubId: 'club-b',
    clubs: { list: [{ id: 'club-b', name: '青鸟社' }] },
    session: { club: { name: '青鸟社', intro: '青鸟社介绍' } },
    route: { name: 'home', id: '' },
    page: { items: [] },
  });
  assert.match(selected, /青鸟社/);
  assert.doesNotMatch(selected, /黑光文学社/);
});

test('site metadata and admin login identify the multi-club platform without naming one club', async () => {
  const [siteHtml, adminApp] = await Promise.all([
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../admin-web/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(siteHtml, /name="description" content="黑光树洞多社团空间/);
  assert.doesNotMatch(siteHtml, /黑光文学社/);
  assert.match(adminApp, /黑光树洞 · 多社团治理/);
  assert.doesNotMatch(adminApp, /黑光文学社/);
});

test('only explicit membership and access errors invalidate a selected club preference', () => {
  assert.equal(typeof core.shouldClearSelectedClubPreference, 'function');
  for (const [code, status] of [
    ['membership_invalid', 403],
    ['forbidden', 403],
    ['not_accessible', 404],
  ]) {
    assert.equal(core.shouldClearSelectedClubPreference({ code, status }, 'club-a', 'club-a'), true, `${code}/${status}`);
  }
  for (const error of [
    { code: 'unauthenticated', status: 401 },
    { code: 'server', status: 500 },
    { code: 'forbidden', status: 500 },
    { code: 'not_accessible', status: 403 },
    new TypeError('Failed to fetch'),
  ]) {
    assert.equal(core.shouldClearSelectedClubPreference(error, 'club-a', 'club-a'), false, `${error.code || error.message}/${error.status || ''}`);
  }
  assert.equal(core.shouldClearSelectedClubPreference({ code: 'forbidden', status: 403 }, 'club-a', 'club-b'), false);
  assert.equal(core.shouldClearSelectedClubPreference({ code: 'forbidden', status: 403 }, '', ''), false);
});
