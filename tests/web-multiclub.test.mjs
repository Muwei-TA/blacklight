import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../web/core.mjs';
import { renderPage, shell } from '../web/views.mjs';

test('unselected member website uses neutral community copy and selected club names stay dynamic', () => {
  const unselected = shell({
    account: { authenticated: false },
    clubs: { list: [{ id: 'club-a', name: '青鸟社' }] },
    route: { name: 'clubs', id: '' },
    page: { directory: { items: [] }, mine: { items: [] } },
  });
  assert.match(unselected, /社团树洞/);
  assert.doesNotMatch(unselected, /黑光|heiguang|blacklight/i);
  assert.match(unselected, /选择社团|多社团空间/);
  assert.match(unselected, /<option value="" selected disabled>选择社团<\/option>/);

  const selected = shell({
    account: { authenticated: true, user: { displayName: '测试' } },
    clubId: 'club-b',
    clubs: { list: [{ id: 'club-b', name: '黑光文学社' }] },
    session: { club: { name: '黑光文学社', intro: '黑光文学社介绍' } },
    route: { name: 'home', id: '' },
    page: { items: [] },
  });
  assert.match(selected, /社团树洞/);
  assert.match(selected, /黑光文学社/);
  assert.doesNotMatch(selected, /heiguang|blacklight/i);
});

test('visible site and admin branding uses the platform name, while login and privacy remain generic', async () => {
  const [siteHtml, adminHtml, adminApp, favicon] = await Promise.all([
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../admin-web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../admin-web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../web/favicon.svg', import.meta.url), 'utf8'),
  ]);
  assert.match(siteHtml, /name="description" content="社团树洞多社团空间/);
  assert.match(siteHtml, /<title>社团树洞<\/title>/);
  assert.match(siteHtml, /href="\/web\/favicon\.svg"/);
  assert.match(adminHtml, /name="description" content="社团树洞管理工作台/);
  assert.match(adminHtml, /<title>社团树洞 · 社团治理工作台<\/title>/);
  assert.match(adminHtml, /href="\/web\/favicon\.svg"/);
  assert.match(adminApp, /社团树洞 · 多社团治理/);
  assert.match(adminApp, /COMMUNITY · GOVERNANCE/);
  assert.doesNotMatch(adminApp, /黑光|heiguang|blacklight/i);
  assert.match(favicon, /<circle cx="26"/);
  assert.doesNotMatch(favicon, /HEIGUANG|BLACKLIGHT/i);

  const login = renderPage({ account: { authenticated: false }, route: { name: 'login', query: {} } });
  const privacy = renderPage({ route: { name: 'privacy', query: {} } });
  assert.match(login, /WELCOME \/ 社团树洞/);
  assert.doesNotMatch(login, /黑光|heiguang|blacklight/i);
  assert.doesNotMatch(privacy, /黑光|heiguang|blacklight/i);
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
