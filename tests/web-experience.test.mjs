import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../web/core.mjs';
import { renderPage } from '../web/views.mjs';
const member = { account: { authenticated: true, user: { id: 'me', displayName: '测试' } }, session: { memberStatus: 'active', capabilities: { publishing: true } }, clubId: 'club-a' };

test('authentication continuations accept only known internal routes and preserve task query', () => {
  assert.equal(typeof core.parseInternalRoute, 'function');
  assert.deepEqual(core.parseInternalRoute('#/contents/bookmark'), { name: 'contents', id: 'bookmark', query: {} });
  assert.deepEqual(core.parseInternalRoute('#/write?topicId=a%2Fb'), { name: 'write', id: '', query: { topicId: 'a/b' } });
  for (const route of ['https://evil.example', '//evil.example', 'javascript:alert(1)', '#//evil.example', '#/login', '#/register', '#/unknown', '#/post/%zz', '#/post/a/b', '#/../home', null, { next: '#/home' }]) assert.equal(core.parseInternalRoute(route), null, String(route));
});

test('guests joining a club see authentication choices instead of a form they cannot submit', () => {
  const html = renderPage({ ...member, account: { authenticated: false }, session: { memberStatus: 'none' }, route: { name: 'join', query: {} }, page: { club: { name: '测试社团', rules: '约定' } } });
  assert.doesNotMatch(html, /data-form="join"/);
  assert.match(html, /#\/login\?next=/);
  assert.match(html, /#\/register\?next=/);
});

test('reading privacy preserves the registration form and authentication continuation', () => {
  const html = renderPage({ account: { authenticated: false }, route: { name: 'register', query: { next: '#/join' } } });
  assert.match(html, /href="#\/privacy"[^>]*target="_blank"/);
  assert.match(html, /href="#\/login\?next=%23%2Fjoin"/);
});

test('registration collects and verifies an invitation before one-step club entry', () => {
  const html = renderPage({ account: { authenticated: false }, route: { name: 'register', query: {} } });
  assert.match(html, /name="inviteCode"/);
  assert.match(html, /data-action="preview-invite"/);
  assert.match(html, /name="rulesVersion"/);
  assert.match(html, /注册并加入社团/);
  assert.doesNotMatch(html, /注册后使用管理员提供的邀请码加入社团/);
});

test('authenticated personal page exposes logout without entering settings', () => {
  const html = renderPage({ ...member, route: { name: 'me', query: {} }, page: {} });
  assert.match(html, /data-action="logout"/);
});

test('post opened from bookmarks returns to bookmarks, while invalid return paths fall back to home', () => {
  const detail = { post: { id: 'post-a', status: 'published', body: '正文', viewer: {} }, comments: { items: [] } };
  const html = renderPage({ ...member, route: { name: 'post', id: 'post-a', query: { back: '#/contents/bookmark' } }, page: detail });
  assert.match(html, /class="text-link back-link" href="#\/contents\/bookmark"/);
  assert.match(html, /回到收藏/);
  const invalid = renderPage({ ...member, route: { name: 'post', id: 'post-a', query: { back: 'https://evil.example' } }, page: detail });
  assert.match(invalid, /class="text-link back-link" href="#\/home"/);
});

test('notification post links preserve the originating notification tab', () => {
  const html = renderPage({ ...member, route: { name: 'messages', id: 'system', query: {} }, page: { items: [{ id: 'notice', title: '审核结果', target: { type: 'post', id: 'post-a', accessible: true } }] } });
  assert.match(html, /#\/post\/post-a\?back=%23%2Fmessages%2Fsystem/);
});
