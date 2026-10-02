import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommentMemoryDatabase, createLocalApiHarness } from './support/local-api.mjs';

function makeDatabase({ withRemovedMember = false } = {}) {
  const now = '2026-10-02T00:00:00.000Z';
  const users = [
    { _id: 'user-a', wxOpenIdRef: 'openid-a', displayName: 'A', avatar: '', status: 'active' },
    { _id: 'user-b', wxOpenIdRef: 'openid-b', displayName: 'B', avatar: '', status: 'active' },
  ];
  const memberships = [
    { _id: 'user-a:alpha', userId: 'user-a', clubId: 'alpha', role: 'moderator', status: 'active' },
    { _id: 'user-b:beta', userId: 'user-b', clubId: 'beta', role: 'member', status: 'active' },
  ];
  const applications = [
    { _id: 'user-a:beta', userId: 'user-a', clubId: 'beta', status: 'pending', displayName: 'A', createdAt: now },
  ];
  const clubs = [
    { _id: 'alpha', clubId: 'alpha', name: 'Alpha', description: 'Alpha intro', status: 'active', discoverable: true,
      capabilities: { publishing: true, uploads: true } },
    { _id: 'beta', clubId: 'beta', name: 'Beta', description: 'Beta intro', status: 'active', discoverable: false,
      capabilities: { publishing: true, uploads: true } },
    { _id: 'paused', clubId: 'paused', name: 'Paused', description: 'Hidden', status: 'paused', discoverable: true,
      capabilities: { publishing: true } },
  ];
  const posts = [
    { _id: 'post-alpha', clubId: 'alpha', ownerId: 'user-a', kind: 'fragment', title: 'A', body: 'Alpha body',
      visibility: 'club', identityMode: 'named', status: 'published', commentsEnabled: true, version: 1,
      assetIds: [], reactionCount: 0, commentCount: 0, createdAt: now },
    { _id: 'post-beta', clubId: 'beta', ownerId: 'user-a', kind: 'fragment', title: 'B', body: 'Beta secret',
      visibility: 'club', identityMode: 'named', status: 'published', commentsEnabled: true, version: 1,
      assetIds: ['asset-beta'], reactionCount: 0, commentCount: 0, createdAt: now },
  ];
  const comments = [];
  const bookmarks = [
    { _id: 'user-a:post-alpha', userId: 'user-a', clubId: 'alpha', postId: 'post-alpha', createdAt: now },
    { _id: 'user-a:post-beta', userId: 'user-a', clubId: 'beta', postId: 'post-beta', createdAt: now },
  ];
  if (withRemovedMember) {
    users.push({ _id: 'user-c', wxOpenIdRef: 'openid-c', displayName: 'C', avatar: '', status: 'active' });
    users.push({ _id: 'user-d', wxOpenIdRef: 'openid-d', displayName: 'D', avatar: '', status: 'active' });
    memberships.push({ _id: 'user-c:alpha', userId: 'user-c', clubId: 'alpha', role: 'member', status: 'removed' });
    applications.push({ _id: 'user-d:gamma', userId: 'user-d', clubId: 'gamma', status: 'rejected', displayName: 'D', createdAt: now });
    clubs.push({ _id: 'gamma', clubId: 'gamma', name: 'Gamma', description: 'Gamma intro', status: 'active', discoverable: false,
      capabilities: { publishing: true } });
    posts.push({ _id: 'post-c-history', clubId: 'alpha', ownerId: 'user-c', kind: 'fragment', title: 'C',
      body: '本人历史正文', visibility: 'club', identityMode: 'named', status: 'published', commentsEnabled: true,
      version: 1, assetIds: [], reactionCount: 0, commentCount: 3, createdAt: now });
    comments.push(
      { _id: 'comment-other', clubId: 'alpha', postId: 'post-c-history', ownerId: 'user-a', replyToId: '',
        body: '其他社员评论正文', identityMode: 'named', status: 'published', version: 1, createdAt: now },
      { _id: 'comment-c-reply', clubId: 'alpha', postId: 'post-c-history', ownerId: 'user-c', replyToId: 'comment-other',
        body: '本人旧回复', identityMode: 'named', status: 'published', version: 1, createdAt: now },
      { _id: 'comment-c-root', clubId: 'alpha', postId: 'post-c-history', ownerId: 'user-c', replyToId: '',
        body: '本人旧评论', identityMode: 'named', status: 'published', version: 1, createdAt: now },
    );
    bookmarks.push({ _id: 'user-c:post-alpha', userId: 'user-c', clubId: 'alpha', postId: 'post-alpha', createdAt: now });
  }
  return createCommentMemoryDatabase({
    hg_users: users,
    hg_memberships: memberships,
    hg_membership_applications: applications,
    hg_club_config: clubs,
    hg_posts: posts,
    hg_comments: comments,
    hg_reactions: [],
    hg_bookmarks: bookmarks,
    hg_topic_follows: [
      { _id: 'user-a:topic-alpha', userId: 'user-a', clubId: 'alpha', topicId: 'topic-alpha', createdAt: now },
      { _id: 'user-a:topic-beta', userId: 'user-a', clubId: 'beta', topicId: 'topic-beta', createdAt: now },
    ],
    hg_topics: [
      { _id: 'topic-beta', clubId: 'beta', ownerId: 'user-b', title: 'Beta topic', status: 'active', createdAt: now },
    ],
    hg_boards: [
      { _id: 'board-beta', clubId: 'beta', ownerId: 'user-b', title: 'Beta board', status: 'active', createdAt: now },
    ],
    hg_collections: [
      { _id: 'collection-beta', clubId: 'beta', title: 'Beta collection', visibility: 'club' },
    ],
    hg_assets: [
      { _id: 'asset-beta', clubId: 'beta', ownerId: 'user-a', postId: 'post-beta', fileId: 'file-beta',
        status: 'verified', mediaType: 'image', permissionVersion: 0 },
    ],
    hg_notifications: [
      { _id: 'notice-alpha', recipientId: 'user-a', clubId: 'alpha', eventType: 'system_notice', targetType: 'system',
        targetId: 'alpha', title: 'Alpha notice', readAt: null, createdAt: now },
      { _id: 'notice-beta', recipientId: 'user-a', clubId: 'beta', eventType: 'system_notice', targetType: 'system',
        targetId: 'beta', title: 'Beta notice', readAt: null, createdAt: now },
    ],
    hg_reports: [
      { _id: 'report-alpha', clubId: 'alpha', status: 'received', targetType: 'post', targetId: 'post-alpha', reason: 'alpha', createdAt: now },
      { _id: 'report-beta', clubId: 'beta', status: 'received', targetType: 'post', targetId: 'post-beta', reason: 'beta', createdAt: now },
    ],
  });
}

test('账号目录、目标社团会话与目录可见性按合同返回', async (t) => {
  const db = makeDatabase();
  const api = createLocalApiHarness({ db, openid: 'openid-a' });
  t.after(() => api.dispose());
  const invoke = (action, clubId, payload = {}) => api.invoke({ action, clubId, payload });

  const account = await invoke('account/me');
  assert.equal(account.code, 0);
  assert.equal(account.data.club, null);
  assert.equal(account.data.role, 'guest');
  assert.equal(account.data.user.id, 'user-a');

  const mine = await invoke('clubs/mine');
  assert.deepEqual(mine.data.list.map(({ id, memberStatus }) => [id, memberStatus]), [
    ['alpha', 'active'], ['beta', 'pending'],
  ]);
  const list = await invoke('clubs/list');
  assert.deepEqual(list.data.list.map(({ id }) => id), ['alpha']);

  const session = await invoke('session/me', 'alpha');
  assert.equal(session.code, 0);
  assert.equal(session.data.club.id, 'alpha');
  assert.equal(session.data.role, 'moderator');

  const betaJoinPage = await invoke('clubs/detail', 'beta', { id: 'beta' });
  assert.equal(betaJoinPage.code, 0);
  assert.deepEqual(
    { id: betaJoinPage.data.id, name: betaJoinPage.data.name, description: betaJoinPage.data.description },
    { id: 'beta', name: 'Beta', description: 'Beta intro' },
  );
  assert.equal(Object.hasOwn(betaJoinPage.data, 'capabilities'), true);
});

test('selected club blocks cross-club IDs, lists, writes, media and personal aggregates', async (t) => {
  const db = makeDatabase();
  const api = createLocalApiHarness({ db, openid: 'openid-a' });
  t.after(() => api.dispose());
  const invoke = (action, payload = {}) => api.invoke({ action, clubId: 'alpha', payload });

  const feed = await invoke('posts/list');
  assert.deepEqual(feed.data.items.map((item) => item.id), ['post-alpha']);
  for (const [action, payload] of [
    ['posts/detail', { id: 'post-beta' }],
    ['topics/detail', { id: 'topic-beta' }],
    ['boards/detail', { id: 'board-beta' }],
    ['collections/detail', { id: 'collection-beta' }],
    ['assets/status', { assetId: 'asset-beta' }],
    ['profile/get', { targetUserId: 'user-b' }],
  ]) {
    assert.equal((await invoke(action, payload)).code, 'not_accessible', action);
  }

  const beforePost = db.dump('hg_posts').find((post) => post._id === 'post-beta');
  for (const [action, payload] of [
    ['posts/delete', { id: 'post-beta', expectedVersion: 1 }],
    ['posts/reaction', { id: 'post-beta', next: true }],
    ['posts/bookmark', { id: 'post-beta', next: true }],
    ['posts/comments/create', { id: 'post-beta', body: '跨社团', idempotencyKey: 'cross-club-comment-key' }],
  ]) {
    assert.equal((await invoke(action, payload)).code, 'not_accessible', action);
  }
  assert.equal(db.dump('hg_posts').find((post) => post._id === 'post-beta').status, beforePost.status);
  assert.equal(db.dump('hg_reactions').length, 0);
  assert.equal(db.dump('hg_comments').length, 0);
  assert.equal(db.dump('hg_bookmarks').length, 2);

  const contents = await invoke('me/contents', { tab: 'bookmark' });
  assert.deepEqual(contents.data.items.map((item) => item.id), ['post-alpha']);
  const profile = await invoke('me/profile');
  assert.deepEqual(profile.data.stats, { posts: 1, bookmarks: 1, topics: 1 });

  const notices = await invoke('notifications/list', { tab: 'system' });
  assert.deepEqual(notices.data.items.map((item) => item.id), ['notice-alpha']);
  await invoke('notifications/read-all');
  assert.notEqual(db.dump('hg_notifications').find((item) => item._id === 'notice-alpha').readAt, null);
  assert.equal(db.dump('hg_notifications').find((item) => item._id === 'notice-beta').readAt, null);

  const queue = await invoke('admin/queue', { queue: 'report' });
  assert.deepEqual(queue.data.items.map((item) => item.id), ['report-alpha']);
});

test('removed members get only their own club history, without feeds, bookmarks, or other comments', async (t) => {
  const db = makeDatabase({ withRemovedMember: true });
  const api = createLocalApiHarness({ db, openid: 'openid-c' });
  t.after(() => api.dispose());
  const invoke = (action, payload = {}) => api.invoke({ action, clubId: 'alpha', payload });

  const removedDirectory = await api.invoke({ action: 'clubs/mine' });
  assert.deepEqual(removedDirectory.data.list.map(({ id, role, memberStatus }) => [id, role, memberStatus]), [
    ['alpha', null, 'removed'],
  ]);
  const rejectedApi = createLocalApiHarness({ db, openid: 'openid-d' });
  t.after(() => rejectedApi.dispose());
  const rejectedDirectory = await rejectedApi.invoke({ action: 'clubs/mine' });
  assert.deepEqual(rejectedDirectory.data.list.map(({ id, role, memberStatus }) => [id, role, memberStatus]), [
    ['gamma', null, 'rejected'],
  ]);

  const feed = await invoke('posts/list');
  assert.deepEqual(feed.data.items, []);
  const history = await invoke('me/contents', { tab: 'published' });
  assert.deepEqual(history.data.items.map(({ id }) => id), ['post-c-history']);
  const detail = await invoke('posts/detail', { id: 'post-c-history' });
  assert.equal(detail.code, 0);
  assert.equal(detail.data.body, '本人历史正文');

  const comments = await invoke('posts/comments/list', { id: 'post-c-history' });
  const commentJson = JSON.stringify(comments.data.items);
  assert.match(commentJson, /本人旧回复/);
  assert.match(commentJson, /本人旧评论/);
  assert.doesNotMatch(commentJson, /其他社员评论正文/);
  assert.equal((await invoke('me/contents', { tab: 'bookmark' })).code, 'membership_invalid');

  const visibility = await invoke('posts/visibility', {
    id: 'post-c-history', expectedVersion: 1, visibility: 'private',
  });
  assert.equal(visibility.code, 0);
  assert.equal(visibility.data.visibility, 'private');
  const removed = await invoke('posts/delete', { id: 'post-c-history', expectedVersion: 2 });
  assert.equal(removed.code, 0);
  assert.equal(db.dump('hg_posts').find(({ _id }) => _id === 'post-c-history').status, 'deleted');
});

test('unknown and paused explicit target clubs fail closed without default fallback', async (t) => {
  const db = makeDatabase();
  const api = createLocalApiHarness({ db, openid: 'openid-a' });
  t.after(() => api.dispose());

  assert.equal((await api.invoke({ action: 'session/me', clubId: 'missing' })).code, 'not_accessible');
  assert.equal((await api.invoke({ action: 'session/me', clubId: 'paused' })).code, 'not_accessible');
});
