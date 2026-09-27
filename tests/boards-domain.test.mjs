import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommentMemoryDatabase, createLocalApiHarness } from './support/local-api.mjs';

const timestamp = '2026-09-26T00:00:00.000Z';

function boardFixtures() {
  return createCommentMemoryDatabase({
    hg_users: [
      { _id: 'user-1', wxOpenIdRef: 'openid-member-1', displayName: '成员一', status: 'active' },
      { _id: 'user-2', wxOpenIdRef: 'openid-member-2', displayName: '成员二', status: 'active' },
      { _id: 'post-author', wxOpenIdRef: 'openid-post-author', displayName: '帖子作者', status: 'active' },
      { _id: 'admin-1', wxOpenIdRef: 'openid-admin-1', displayName: '管理员', status: 'active' },
    ],
    hg_memberships: [
      { _id: 'user-1:heiguang', userId: 'user-1', clubId: 'heiguang', role: 'member', status: 'active' },
      { _id: 'user-2:heiguang', userId: 'user-2', clubId: 'heiguang', role: 'member', status: 'active' },
      { _id: 'post-author:heiguang', userId: 'post-author', clubId: 'heiguang', role: 'member', status: 'active' },
      { _id: 'admin-1:heiguang', userId: 'admin-1', clubId: 'heiguang', role: 'admin', status: 'active' },
    ],
    hg_club_config: [
      { _id: 'heiguang', clubId: 'heiguang', name: '黑光文学社', capabilities: { publishing: true } },
    ],
    hg_boards: [
      { _id: 'board-active', clubId: 'heiguang', ownerId: 'admin-1', title: '日常', description: '日常分享', status: 'active', version: 1, createdAt: timestamp },
      { _id: 'board-hidden-pending', clubId: 'heiguang', ownerId: 'user-2', title: '隐藏待审', description: '', status: 'pending', version: 1, createdAt: timestamp },
    ],
    hg_topics: [
      { _id: 'topic-active', clubId: 'heiguang', ownerId: 'admin-1', title: '读书', status: 'active', version: 1, createdAt: timestamp },
    ],
    hg_posts: [
      {
        _id: 'board-post', clubId: 'heiguang', ownerId: 'post-author', kind: 'fragment', title: '', body: '板块与话题并存',
        visibility: 'club', identityMode: 'named', status: 'published', commentsEnabled: true,
        boardId: 'board-active', topicId: 'topic-active', assetIds: [], version: 1,
        reactionCount: 0, commentCount: 0, createdAt: timestamp,
      },
      {
        _id: 'plain-post', clubId: 'heiguang', ownerId: 'post-author', kind: 'fragment', title: '', body: '未分类帖子',
        visibility: 'club', identityMode: 'named', status: 'published', commentsEnabled: true,
        boardId: '', topicId: '', assetIds: [], version: 1,
        reactionCount: 0, commentCount: 0, createdAt: '2026-09-26T00:00:01.000Z',
      },
    ],
  });
}

function call(harness, action, payload = {}) {
  return harness.callFunction({ name: 'api', data: { action, payload } });
}

test('board create derives owner and status on the server and hides another member pending ID', async (t) => {
  const db = boardFixtures();
  const member = createLocalApiHarness({ db, openid: 'openid-member-1' });
  const admin = createLocalApiHarness({ db, openid: 'openid-admin-1' });
  t.after(() => { member.dispose(); admin.dispose(); });

  const created = await call(member, 'boards/create', {
    title: ' 新板块 ', description: '成员申请', ownerId: 'admin-1', status: 'active',
    version: 99, _id: 'spoofed-id', createdAt: '2000-01-01',
  });
  assert.equal(created.result.code, 0);
  assert.equal(created.result.data.duplicated, false);
  assert.equal(created.result.data.status, 'pending');
  const memberBoard = db.dump('hg_boards').find((board) => board._id === created.result.data.id);
  assert.equal(memberBoard.ownerId, 'user-1');
  assert.equal(memberBoard.status, 'pending');
  assert.equal(memberBoard.version, 1);
  assert.notEqual(memberBoard._id, 'spoofed-id');
  assert.notEqual(memberBoard.createdAt, '2000-01-01');

  const hiddenConflict = await call(member, 'boards/create', { title: ' 隐藏待审 ', description: '' });
  assert.equal(hiddenConflict.result.code, 'conflict');
  assert.equal(JSON.stringify(hiddenConflict.result).includes('board-hidden-pending'), false);
  assert.equal('data' in hiddenConflict.result, false);

  const adminCreated = await call(admin, 'boards/create', { title: '管理板块', description: '立即生效' });
  assert.equal(adminCreated.result.code, 0);
  assert.equal(adminCreated.result.data.status, 'active');
  assert.equal(db.dump('hg_boards').find((board) => board._id === adminCreated.result.data.id).ownerId, 'admin-1');

  const activeDuplicate = await call(member, 'boards/create', { title: ' 管理板块 ', description: '重复' });
  assert.deepEqual(activeDuplicate.result.data, {
    duplicated: true, id: adminCreated.result.data.id, status: 'active',
  });
});

test('boards list and detail enforce board visibility, and boardId filtering happens before pagination', async (t) => {
  const db = boardFixtures();
  const member = createLocalApiHarness({ db, openid: 'openid-member-1' });
  t.after(() => member.dispose());

  const listed = await call(member, 'boards/list');
  assert.deepEqual(listed.result.data.items.map((board) => board.id), ['board-active']);

  const titleSearch = await call(member, 'boards/list', { q: '日' });
  assert.deepEqual(titleSearch.result.data.items.map((board) => board.id), ['board-active']);
  const literalSearch = await call(member, 'boards/list', { q: '[' });
  assert.deepEqual(literalSearch.result.data.items, []);
  const unsupportedStatus = await call(member, 'boards/list', { status: 'pending' });
  assert.equal(unsupportedStatus.result.code, 'invalid_input');

  const inaccessibleBefore = db.paginationCalls;
  const hiddenList = await call(member, 'posts/list', { boardId: 'board-hidden-pending' });
  assert.equal(hiddenList.result.code, 'not_accessible');
  assert.equal(db.paginationCalls, inaccessibleBefore);

  const activeDetail = await call(member, 'boards/detail', { id: 'board-active' });
  assert.equal(activeDetail.result.code, 0);
  assert.equal(activeDetail.result.data.board.status, 'active');
  assert.equal(activeDetail.result.data.items.length, 1);
  assert.deepEqual(activeDetail.result.data.items[0].topic, { id: 'topic-active', title: '读书' });
  assert.deepEqual(activeDetail.result.data.items[0].board, { id: 'board-active', title: '日常' });

  const filtered = await call(member, 'posts/list', { boardId: 'board-active' });
  assert.deepEqual(filtered.result.data.items.map((post) => post.id), ['board-post']);
});

test('board moderation uses its own queue and atomically records versioned decisions', async (t) => {
  const db = boardFixtures();
  const member = createLocalApiHarness({ db, openid: 'openid-member-1' });
  const admin = createLocalApiHarness({ db, openid: 'openid-admin-1' });
  t.after(() => { member.dispose(); admin.dispose(); });

  const forbidden = await call(member, 'admin/queue', { queue: 'board' });
  assert.equal(forbidden.result.code, 'forbidden');

  const queue = await call(admin, 'admin/queue', { queue: 'board' });
  assert.equal(queue.result.code, 0);
  assert.deepEqual(queue.result.data.items.map((item) => item.id), ['board-hidden-pending']);
  assert.equal(queue.result.data.items[0].version, 1);
  assert.equal('ownerId' in queue.result.data.items[0], false);

  const decision = await call(admin, 'admin/board/decide', {
    id: 'board-hidden-pending', decision: 'reject', reason: '范围说明不清楚', expectedVersion: 1,
  });
  assert.deepEqual(decision.result.data, { ok: true, status: 'rejected', version: 2 });
  assert.equal(db.dump('hg_boards').find((board) => board._id === 'board-hidden-pending').rejectReason, '范围说明不清楚');
  assert.equal(db.dump('hg_audit_logs')[0].targetType, 'board');

  const owner = createLocalApiHarness({ db, openid: 'openid-member-2' });
  t.after(() => owner.dispose());
  const rejectedDetail = await call(owner, 'boards/detail', { id: 'board-hidden-pending' });
  assert.equal(rejectedDetail.result.code, 0);
  assert.equal(rejectedDetail.result.data.board.rejectReason, '范围说明不清楚');
  assert.equal(rejectedDetail.result.data.canPost, false);
  assert.deepEqual(rejectedDetail.result.data.items, []);
});

test('posts can retain boardId and topicId together; private association is rejected and resubmit preserves both', async (t) => {
  const db = boardFixtures();
  const member = createLocalApiHarness({ db, openid: 'openid-member-1' });
  t.after(() => member.dispose());

  const created = await call(member, 'posts/create', {
    kind: 'fragment', title: '', body: '同时属于板块和话题', visibility: 'club',
    identityMode: 'named', topicId: 'topic-active', boardId: 'board-active', idempotencyKey: 'board-post-create-1',
  });
  assert.equal(created.result.code, 0);
  const createdPost = db.dump('hg_posts').find((post) => post._id === created.result.data.id);
  assert.equal(createdPost.boardId, 'board-active');
  assert.equal(createdPost.topicId, 'topic-active');

  const madePrivate = await call(member, 'posts/visibility', {
    id: created.result.data.id, visibility: 'private', expectedVersion: 1,
  });
  assert.equal(madePrivate.result.code, 0);
  assert.equal(db.dump('hg_posts').find((post) => post._id === created.result.data.id).boardId, '');

  const privateAttempt = await call(member, 'posts/create', {
    kind: 'fragment', title: '', body: '仅自己', visibility: 'private',
    identityMode: 'named', boardId: 'board-active', idempotencyKey: 'board-private-post-1',
  });
  assert.equal(privateAttempt.result.code, 'invalid_input');
  assert.equal(privateAttempt.result.detail.field, 'boardId');

  await db.coll('hg_posts').add({ data: {
    _id: 'rejected-board-post', clubId: 'heiguang', ownerId: 'user-1', kind: 'fragment', title: '', body: '待重提',
    visibility: 'club', identityMode: 'named', status: 'rejected', commentsEnabled: true,
    boardId: 'board-active', topicId: 'topic-active', assetIds: [], version: 2, createdAt: timestamp,
  } });
  const resubmitted = await call(member, 'posts/resubmit', {
    id: 'rejected-board-post', expectedVersion: 2, title: '', body: '修订后重提', idempotencyKey: 'board-resubmit-1',
  });
  assert.equal(resubmitted.result.code, 0);
  const saved = db.dump('hg_posts').find((post) => post._id === 'rejected-board-post');
  assert.equal(saved.boardId, 'board-active');
  assert.equal(saved.topicId, 'topic-active');
});
