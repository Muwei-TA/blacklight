import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const constants = require('../shared/constants.js');
const policies = require('../shared/policies.js');
const validators = require('../shared/validators.js');
const errors = require('../shared/errors.js');
const presenters = require('../shared/presenters.js');
const anonymity = require('../shared/anonymity.js');

/** 内存版存储：只实现 posts/comments 用例实际用到的查询子集 */
function createStore() {
  const store = new Map(Object.entries({
    hg_posts: [
      {
        _id: 'post-1', clubId: 'heiguang', ownerId: 'user-author', kind: 'fragment',
        title: '', body: '正文', visibility: 'club', identityMode: 'named',
        status: 'published', commentsEnabled: true, version: 1,
        reactionCount: 0, commentCount: 2,
      },
    ],
    hg_comments: [
      {
        _id: 'c1', postId: 'post-1', ownerId: 'user-1', replyToId: '',
        body: '一级回应', identityMode: 'named', status: 'published', version: 1,
      },
      {
        _id: 'c2', postId: 'post-1', ownerId: 'user-2', replyToId: 'c1',
        body: '定向回复', identityMode: 'named', status: 'published', version: 1,
      },
      {
        _id: 'c3', postId: 'post-1', ownerId: 'user-2', replyToId: '',
        body: '另一条一级回应', identityMode: 'named', status: 'published', version: 1,
      },
      {
        _id: 'c4', postId: 'post-1', ownerId: 'user-1', replyToId: '',
        body: '待审回应', identityMode: 'named', status: 'pending', version: 1,
      },
    ],
    hg_reactions: [],
    hg_users: [
      { _id: 'user-1', displayName: '成员一' },
      { _id: 'user-2', displayName: '成员二' },
      { _id: 'user-author', displayName: '作者' },
    ],
    hg_anonymous_identities: [],
  }));

  const matchesAtom = (doc, key, expected) => {
    const actual = doc[key];
    if (expected && typeof expected === 'object' && expected.$op === 'in') {
      return expected.value.includes(actual);
    }
    return actual === expected;
  };
  const matches = (doc, query) => Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some((sub) => matches(doc, sub));
    return matchesAtom(doc, key, expected);
  });

  const command = () => ({
    in: (value) => ({ $op: 'in', value }),
    exists: (value) => ({ $op: 'exists', value }),
    neq: (value) => ({ $op: 'neq', value }),
    gte: (value) => ({ $op: 'gte', value }),
    inc: (value) => ({ $op: 'inc', value }),
  });

  const fakeDb = {
    command,
    serverDate: () => new Date('2026-09-25T10:00:00Z').toISOString(),
    async findOneById(name, id) {
      return (store.get(name) || []).find((doc) => doc._id === id) || null;
    },
    async findByIds(name, ids = []) {
      return (store.get(name) || []).filter((doc) => ids.includes(doc._id));
    },
    coll(name) {
      const rows = () => store.get(name) || [];
      const chain = {
        _query: {},
        where(query) {
          this._query = query;
          return this;
        },
        orderBy() { return this; },
        limit() { return this; },
        async get() {
          return { data: rows().filter((doc) => matches(doc, this._query)) };
        },
        async remove() {
          const keep = rows().filter((doc) => !matches(doc, this._query));
          store.set(name, keep);
          return { stats: { removed: rows().length - keep.length } };
        },
        async add({ data }) {
          rows().push(data);
          return { _id: data._id };
        },
        doc(id) {
          return {
            async remove() {
              store.set(name, rows().filter((doc) => doc._id !== id));
              return { stats: { removed: 1 } };
            },
            async update({ data }) {
              Object.assign(rows().find((doc) => doc._id === id) || {}, data);
              return { stats: { updated: 1 } };
            },
          };
        },
      };
      return chain;
    },
    async updateWithVersion(name, id, expectedVersion, data) {
      const doc = (store.get(name) || []).find((row) => row._id === id);
      if (!doc || doc.version !== expectedVersion) {
        throw errors.conflict('内容已被更新，请刷新后重试', { field: 'expectedVersion' });
      }
      Object.assign(doc, data, { version: expectedVersion + 1 });
      return expectedVersion + 1;
    },
    async incCounter(name, id, field, delta) {
      const doc = (store.get(name) || []).find((row) => row._id === id);
      if (doc) doc[field] = Math.max(0, (doc[field] || 0) + delta);
    },
  };
  return { store, fakeDb };
}

const { store, fakeDb } = createStore();
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  const stubs = {
    '../shared/constants': constants,
    '../shared/policies': policies,
    '../shared/validators': validators,
    '../shared/presenters': presenters,
    '../shared/errors': errors,
    '../shared/db': fakeDb,
    '../shared/anonymity': anonymity,
    './foreground-review': { runOwnedReview: async () => null },
    './assets': { signReadableAssets: async () => [] },
  };
  return Object.hasOwn(stubs, request) ? stubs[request] : originalLoad.call(this, request, parent, isMain);
};
const posts = require('../cloudfunctions/api/domain/posts.js');

const memberViewer = (userId) => policies.buildViewer({
  userId,
  role: constants.ROLE.MEMBER,
  memberStatus: constants.MEMBER_STATUS.ACTIVE,
});
const ctxFor = (userId) => ({ viewer: memberViewer(userId), capabilities: { publishing: true }, now: Date.now() });
const comments = () => store.get('hg_comments');
const reactions = () => store.get('hg_reactions');
const findComment = (id) => comments().find((c) => c._id === id);
const post = () => store.get('hg_posts')[0];

test('listComments 返回共鸣计数与本人 viewer 标记', async () => {
  const data = await posts.listComments({ id: 'post-1' }, ctxFor('user-1'));
  const c1 = data.items.find((item) => item.id === 'c1');
  const c3 = data.items.find((item) => item.id === 'c3');
  const pending = data.items.find((item) => item.id === 'c4');

  assert.equal(c1.counters.reactions, 0);
  assert.equal(c1.viewer.reacted, false);
  assert.equal(c1.viewer.canDelete, true); // 本人回应
  assert.equal(c3.viewer.canDelete, false); // 他人回应
  assert.equal(c1.replies.length, 1);
  // 仅作者能在刷新后看到自己的待审回应
  assert.equal(pending.status, 'pending');
  const otherData = await posts.listComments({ id: 'post-1' }, ctxFor('user-2'));
  assert.equal(otherData.items.some((item) => item.id === 'c4'), false);
});

test('成员可以给回应共鸣，幂等开关不会重复计数', async () => {
  await posts.toggleCommentReaction({ id: 'post-1', commentId: 'c1', next: true }, ctxFor('user-2'));
  let reactionDoc = reactions().find((r) => r._id === 'user-2:comment:c1');
  assert.ok(reactionDoc);
  assert.equal(reactionDoc.postId, 'post-1');
  assert.equal(findComment('c1').reactionCount, 1);

  // 重复打开是幂等 no-op
  await posts.toggleCommentReaction({ id: 'post-1', commentId: 'c1', next: true }, ctxFor('user-2'));
  assert.equal(reactions().filter((r) => r.commentId === 'c1').length, 1);
  assert.equal(findComment('c1').reactionCount, 1);

  const data = await posts.listComments({ id: 'post-1' }, ctxFor('user-2'));
  const c1 = data.items.find((item) => item.id === 'c1');
  assert.equal(c1.viewer.reacted, true);
  assert.equal(c1.counters.reactions, 1);

  // 关闭后回滚计数
  await posts.toggleCommentReaction({ id: 'post-1', commentId: 'c1', next: false }, ctxFor('user-2'));
  reactionDoc = reactions().find((r) => r._id === 'user-2:comment:c1');
  assert.equal(reactionDoc, undefined);
  assert.equal(findComment('c1').reactionCount, 0);
});

test('访客与待审回应不能共鸣，且不泄露存在性', async () => {
  await assert.rejects(
    posts.toggleCommentReaction({ id: 'post-1', commentId: 'c1', next: true }, { viewer: policies.buildViewer({}), now: Date.now() }),
    (err) => err.kind === 'not_accessible',
  );
  await assert.rejects(
    posts.toggleCommentReaction({ id: 'post-1', commentId: 'c4', next: true }, ctxFor('user-2')),
    (err) => err.kind === 'not_accessible',
  );
  await assert.rejects(
    posts.toggleCommentReaction({ id: 'post-1', commentId: 'missing', next: true }, ctxFor('user-2')),
    (err) => err.kind === 'not_accessible',
  );
  assert.equal(reactions().length, 0);
});

test('评论者可删除已发布回应：计数回收、有回复时保留墓碑', async () => {
  await posts.toggleCommentReaction({ id: 'post-1', commentId: 'c1', next: true }, ctxFor('user-2'));
  const result = await posts.deleteComment({ id: 'post-1', commentId: 'c1', expectedVersion: 1 }, ctxFor('user-1'));
  assert.equal(result.ok, true);
  assert.equal(findComment('c1').status, 'deleted');
  assert.equal(findComment('c1').version, 2);
  // 原帖计数回收
  assert.equal(post().commentCount, 1);
  // 回应的共鸣记录一并回收
  assert.equal(reactions().filter((r) => r.commentId === 'c1').length, 0);

  // c1 有可见回复 c2：以墓碑展示，不携带原文与作者
  const data = await posts.listComments({ id: 'post-1' }, ctxFor('user-2'));
  const tombstone = data.items.find((item) => item.id === 'c1');
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.body, '这条回应已被删除。');
  assert.equal(tombstone.author.userId, null);
  assert.equal(tombstone.viewer.canDelete, false);
  assert.equal(tombstone.replies.length, 1);
  // 回复本体仍可读
  assert.equal(tombstone.replies[0].body, '定向回复');
});

test('墓碑的最后一条回复被删除后，墓碑随之隐藏', async () => {
  await posts.deleteComment({ id: 'post-1', commentId: 'c2', expectedVersion: 1 }, ctxFor('user-2'));
  const data = await posts.listComments({ id: 'post-1' }, ctxFor('user-2'));
  assert.equal(data.items.some((item) => item.id === 'c1'), false);
  assert.equal(data.items.some((item) => item.id === 'c2'), false);
  assert.equal(post().commentCount, 0);
});

test('非评论者不能删除，版本不匹配抛 conflict', async () => {
  await assert.rejects(
    posts.deleteComment({ id: 'post-1', commentId: 'c3', expectedVersion: 1 }, ctxFor('user-1')),
    (err) => err.kind === 'forbidden',
  );
  await assert.rejects(
    posts.deleteComment({ id: 'post-1', commentId: 'c3', expectedVersion: 9 }, ctxFor('user-2')),
    (err) => err.kind === 'conflict',
  );
  assert.equal(findComment('c3').status, 'published');
});

test('作者可删除自己的待审回应，且不回退原帖计数', async () => {
  const before = post().commentCount;
  const result = await posts.deleteComment({ id: 'post-1', commentId: 'c4', expectedVersion: 1 }, ctxFor('user-1'));
  assert.equal(result.ok, true);
  assert.equal(findComment('c4').status, 'deleted');
  assert.equal(post().commentCount, before);
  const data = await posts.listComments({ id: 'post-1' }, ctxFor('user-1'));
  assert.equal(data.items.some((item) => item.id === 'c4'), false);
});
