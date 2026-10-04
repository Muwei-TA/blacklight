import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderPage } from '../web/views.mjs';
import * as core from '../web/core.mjs';
const require = createRequire(import.meta.url);
const http = require('../server/web-http.js');
const base = { account: { authenticated: true, user: { id: 'me' } }, session: { memberStatus: 'active', capabilities: { publishing: true } }, clubId: 'club-a' };

test('comment pagination merges new replies under repeated parents without duplicating prior replies', () => {
  assert.equal(typeof core.mergeCommentPages, 'function');
  const first = [{ id: 'parent', body: 'original', replies: [{ id: 'reply-1', body: 'one' }] }];
  const next = [{ id: 'parent', body: 'original', replies: [{ id: 'reply-1', body: 'one' }, { id: 'reply-2', body: 'two' }] }, { id: 'other', replies: [] }];
  const merged = core.mergeCommentPages(first, next);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].replies.map((reply) => reply.id), ['reply-1', 'reply-2']);
  assert.equal(first[0].replies.length, 1);
});

test('reply UI targets root comments and never offers an unsupported second reply level', () => {
  const html = renderPage({ ...base, route: { name: 'post', id: 'post-1', query: {} }, page: { post: { id: 'post-1', body: 'text', commentsEnabled: true, viewer: { canComment: true } }, comments: { items: [{ id: 'parent', body: 'parent', author: {}, replies: [{ id: 'reply', body: 'reply', author: {}, replies: [] }] }] } } });
  assert.equal((html.match(/data-action="reply-to"/g) || []).length, 1);
  assert.match(html, /data-action="reply-to" data-id="parent"/);
});

test('real recovery_requested DTO offers target accept and decline even before joining a club', () => {
  const html = renderPage({ ...base, clubId: '', route: { name: 'confirmations', query: {} }, page: { handovers: { items: [] }, recoveries: { items: [{ id: 'recovery', clubId: 'club-a', status: 'recovery_requested', version: 3 }] } } });
  assert.match(html, /data-decision="accept"/);
  assert.match(html, /data-decision="decline"/);
  assert.match(html, /data-club="club-a"/);
});

test('client source trusts only configured proxy IPs and the nearest forwarded peer', () => {
  assert.equal(typeof http.requestAddress, 'function');
  const req = { socket: { remoteAddress: '::ffff:172.28.42.1' }, headers: { 'x-forwarded-for': '203.0.113.5, 198.51.100.8' } };
  assert.equal(http.requestAddress(req, ['172.28.42.1']), '198.51.100.8');
  assert.equal(http.requestAddress(req, []), '172.28.42.1');
  assert.equal(http.requestAddress({ ...req, socket: { remoteAddress: '198.51.100.100' } }, ['172.28.42.1']), '198.51.100.100');
  assert.equal(http.requestAddress({ ...req, headers: { 'x-forwarded-for': 'bad input' } }, ['172.28.42.1']), '172.28.42.1');
  assert.equal(http.requestAddress({ ...req, headers: { 'x-forwarded-for': ['198.51.100.8'] } }, ['172.28.42.1']), '172.28.42.1');
});

test('all published article pages remain available for collection selection', async () => {
  assert.equal(typeof core.collectPages, 'function');
  const seen = [];
  const result = await core.collectPages(async (cursor) => { seen.push(cursor); return cursor ? { items: [{ id: 'old-article' }], nextCursor: null } : { items: [{ id: 'recent-fragment' }], nextCursor: 'older' }; });
  assert.deepEqual(result.map((item) => item.id), ['recent-fragment', 'old-article']);
  assert.deepEqual(seen, ['', 'older']);
});
