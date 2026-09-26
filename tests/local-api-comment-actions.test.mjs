import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommentMemoryDatabase, createLocalApiHarness } from './support/local-api.mjs';

test('wx.cloud.callFunction bridge exercises the real API router and comment handlers', async (t) => {
  const db = createCommentMemoryDatabase();
  const member1 = createLocalApiHarness({ db, openid: 'openid-member-1' });
  const member2 = createLocalApiHarness({ db, openid: 'openid-member-2' });
  t.after(() => { member1.dispose(); member2.dispose(); });
  const call = (harness, action, payload = {}) => harness.callFunction({ name: 'api', data: { action, payload } });

  const [listed, listedByOtherMember] = await Promise.all([
    call(member1, 'posts/comments/list', { id: 'post-1' }),
    call(member2, 'posts/comments/list', { id: 'post-1' }),
  ]);
  assert.equal(listed.result.code, 0);
  const root = listed.result.data.items.find((comment) => comment.id === 'c1');
  assert.equal(root.viewer.canDelete, true);
  assert.equal(root.replies[0].id, 'c2');
  const pending = listed.result.data.items.find((comment) => comment.id === 'c4');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.viewer.canDelete, true);
  assert.equal(listedByOtherMember.result.data.items.find((comment) => comment.id === 'c1').viewer.canDelete, false);

  const reacted = await call(member1, 'posts/comments/reaction', {
    id: 'post-1', commentId: 'c3', next: true, userId: 'user-2',
  });
  assert.equal(reacted.result.code, 0);
  assert.equal(reacted.result.data.count, 1);
  assert.equal(db.dump('hg_reactions')[0].userId, 'user-1');

  const staleVersion = await call(member1, 'posts/comments/delete', {
    id: 'post-1', commentId: 'c1', expectedVersion: 9,
  });
  assert.equal(staleVersion.result.code, 'conflict');
  const wrongAuthor = await call(member2, 'posts/comments/delete', {
    id: 'post-1', commentId: 'c1', expectedVersion: 1,
  });
  assert.equal(wrongAuthor.result.code, 'forbidden');

  const deletedRoot = await call(member1, 'posts/comments/delete', {
    id: 'post-1', commentId: 'c1', expectedVersion: 1,
  });
  assert.equal(deletedRoot.result.code, 0);
  const afterRootDelete = await call(member2, 'posts/comments/list', { id: 'post-1' });
  const tombstone = afterRootDelete.result.data.items.find((comment) => comment.id === 'c1');
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.body, '这条回应已被删除。');
  assert.equal(tombstone.author.userId, null);
  assert.equal(tombstone.replies[0].id, 'c2');

  const created = await call(member2, 'posts/comments/create', {
    id: 'post-1', body: '经真实 handler 创建', identityMode: 'named', idempotencyKey: 'local-create-1',
  });
  assert.equal(created.result.code, 0);
  assert.equal(created.result.data.state, 'pending');
  assert.equal(created.result.data.comment.viewer.canDelete, true);

  const deletedReply = await call(member2, 'posts/comments/delete', {
    id: 'post-1', commentId: 'c2', expectedVersion: 1,
  });
  assert.equal(deletedReply.result.code, 0);
  const afterReplyDelete = await call(member1, 'posts/comments/list', { id: 'post-1' });
  assert.equal(afterReplyDelete.result.data.items.some((comment) => comment.id === 'c1'), false);
});
