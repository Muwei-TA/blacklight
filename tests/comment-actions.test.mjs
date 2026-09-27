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
const stamp = (n) => new Date(Date.UTC(2026, 8, 24, 0, 0, n)).toISOString();
const memberViewer = (userId) => policies.buildViewer({
  userId, role: constants.ROLE.MEMBER, memberStatus: constants.MEMBER_STATUS.ACTIVE,
});
const ctxFor = (userId) => ({ viewer: memberViewer(userId), user: { _id: userId, displayName: '成员' },
  capabilities: { publishing: true }, now: Date.now() });

/** Isolated fixture with real filtering, limit, ordering, uniqueness and affected-row semantics.
 * SQL atomicity itself is exercised separately against PostgreSQL, not asserted by this mock.
 */
function harness() {
  const store = new Map(Object.entries({
    hg_posts: [{ _id: 'post-1', clubId: 'heiguang', ownerId: 'user-author', kind: 'fragment',
      title: '', body: '正文', visibility: 'club', identityMode: 'named', status: 'published',
      commentsEnabled: true, version: 1, reactionCount: 0, commentCount: 3, createdAt: stamp(0) }],
    hg_comments: [
      { _id: 'c1', postId: 'post-1', ownerId: 'user-1', replyToId: '', body: '一级回应',
        identityMode: 'named', status: 'published', version: 1, createdAt: stamp(1) },
      { _id: 'c2', postId: 'post-1', ownerId: 'user-2', replyToId: 'c1', body: '定向回复',
        identityMode: 'named', status: 'published', version: 1, createdAt: stamp(2) },
      { _id: 'c3', postId: 'post-1', ownerId: 'user-2', replyToId: '', body: '另一条一级回应',
        identityMode: 'named', status: 'published', version: 1, createdAt: stamp(3) },
      { _id: 'c4', postId: 'post-1', ownerId: 'user-1', replyToId: '', body: '待审回应',
        identityMode: 'named', status: 'pending', version: 1, createdAt: stamp(4) },
    ],
    hg_reactions: [], hg_bookmarks: [], hg_topics: [], hg_assets: [], hg_consents: [],
    hg_users: [{ _id: 'user-1', displayName: '成员一' }, { _id: 'user-2', displayName: '成员二' }],
    hg_anonymous_identities: [],
  }));
  const rows = (name) => store.get(name) || [];
  const normalize = (value) => value instanceof Date ? value.toISOString() : value;
  const match = (doc, query) => Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some((part) => match(doc, part));
    if (key === '$and') return value.every((part) => match(doc, part));
    const actual = normalize(doc[key]);
    if (value && value.$op) {
      const expected = normalize(value.value);
      if (value.$op === 'in') return expected.includes(actual);
      if (value.$op === 'exists') return Object.hasOwn(doc, key) === expected;
      if (value.$op === 'neq') return actual !== expected;
      if (value.$op === 'lt') return actual < expected;
      if (value.$op === 'gt') return actual > expected;
    }
    return actual === normalize(value);
  });
  const sortRows = (data, order) => data.slice().sort((a, b) => {
    for (const [key, direction] of order) {
      if (a[key] === b[key]) continue;
      return (a[key] < b[key] ? -1 : 1) * (direction === 'desc' ? -1 : 1);
    }
    return 0;
  });
  const commands = Object.fromEntries(['in', 'exists', 'neq', 'lt', 'gt', 'inc'].map((key) =>
    [key, (value) => ({ $op: key, value })]));
  const rpcCalls = [];
  const fakeDb = {
    command: () => commands,
    serverDate: () => stamp(50),
    findOneById: async (name, id) => structuredClone(rows(name).find((doc) => doc._id === id) || null),
    findByIds: async (name, ids) => structuredClone(rows(name).filter((doc) => ids.includes(doc._id))),
    coll(name) {
      const query = { filter: {}, order: [], take: Infinity,
        where(value) { this.filter = value; return this; },
        orderBy(key, direction) { this.order.push([key, direction]); return this; },
        limit(value) { this.take = value; return this; },
        doc(id) { this.filter = { _id: id }; return this; },
        async get() {
          return { data: structuredClone(sortRows(rows(name).filter((doc) => match(doc, this.filter)), this.order).slice(0, this.take)) };
        },
        async add({ data }) {
          if (rows(name).some((doc) => doc._id === data._id)) {
            throw Object.assign(new Error('duplicate key'), { code: '23505' });
          }
          store.set(name, [...rows(name), structuredClone(data)]);
          return { _id: data._id };
        },
        async remove() {
          const before = rows(name).length;
          const keep = rows(name).filter((doc) => !match(doc, this.filter));
          store.set(name, keep);
          return { stats: { removed: before - keep.length } };
        },
        async update({ data }) {
          const selected = rows(name).filter((doc) => match(doc, this.filter));
          for (const doc of selected) {
            for (const [key, value] of Object.entries(data)) {
              doc[key] = value && value.$op === 'inc' ? (doc[key] || 0) + value.value : value;
            }
          }
          return { stats: { updated: selected.length } };
        },
      };
      return query;
    },
    async paginate(name, where, { cursor, pageSize, order = 'desc' }) {
      const sorted = sortRows(rows(name).filter((doc) => match(doc, where)), [['createdAt', order], ['_id', order]]);
      const after = sorted.filter((doc) => {
        if (!cursor) return true;
        const comparison = doc.createdAt.localeCompare(new Date(cursor.createdAt).toISOString()) || doc._id.localeCompare(cursor.id);
        return order === 'asc' ? comparison > 0 : comparison < 0;
      });
      return { items: structuredClone(after.slice(0, pageSize)), hasMore: after.length > pageSize };
    },
    async updateWithVersion(name, id, version, patch) {
      const doc = rows(name).find((row) => row._id === id);
      if (!doc || doc.version !== version) throw errors.conflict();
      Object.assign(doc, patch, { version: version + 1 });
      return version + 1;
    },
    async incCounter(name, id, field, delta) {
      const doc = rows(name).find((row) => row._id === id);
      if (doc) doc[field] = (doc[field] || 0) + delta;
    },
    getDb() {
      return { rpc: async (name, args) => {
        rpcCalls.push({ name, args });
        assert.equal(name, 'hg_toggle_reaction');
        const { p_actor_id: userId, p_post_id: postId, p_comment_id: commentId, p_next: next } = args;
        const id = commentId ? `${userId}:comment:${commentId}` : `${userId}:${postId}`;
        const target = rows(commentId ? 'hg_comments' : 'hg_posts').find((doc) => doc._id === (commentId || postId));
        const existing = rows('hg_reactions').find((doc) => doc._id === id);
        if (next && !existing) {
          rows('hg_reactions').push({ _id: id, userId, postId, ...(commentId ? { commentId } : {}) });
          target.reactionCount = (target.reactionCount || 0) + 1;
        } else if (!next && existing) {
          store.set('hg_reactions', rows('hg_reactions').filter((doc) => doc._id !== id));
          target.reactionCount -= 1;
        }
        return { ok: true, reacted: next, count: target.reactionCount || 0 };
      } };
    },
  };
  const stubs = {
    '../../shared/constants': constants, '../../shared/policies': policies, '../../shared/validators': validators,
    '../../shared/presenters': presenters, '../../shared/errors': errors, '../../shared/db': fakeDb,
    '../../shared/anonymity': anonymity, '../foreground-review': { runOwnedReview: async () => null },
    '../assets': { signReadableAssets: async () => [] },
  };
  const modulePaths = [
    '../cloudfunctions/api/domain/posts.js',
    '../cloudfunctions/api/domain/posts/feed.js',
    '../cloudfunctions/api/domain/posts/content.js',
    '../cloudfunctions/api/domain/posts/reactions.js',
    '../cloudfunctions/api/domain/posts/comments.js',
    '../cloudfunctions/api/domain/posts/my-contents.js',
    '../cloudfunctions/api/domain/posts/reports.js',
  ].map((id) => require.resolve(id));
  const originalLoad = Module._load;
  try {
    modulePaths.forEach((id) => { delete require.cache[id]; });
    Module._load = function patchedLoad(request, parent, isMain) {
      return Object.hasOwn(stubs, request) ? stubs[request] : originalLoad.call(this, request, parent, isMain);
    };
    const posts = require('../cloudfunctions/api/domain/posts.js');
    return { posts, store, fakeDb, rpcCalls, rows };
  } finally {
    Module._load = originalLoad;
    modulePaths.forEach((id) => { delete require.cache[id]; });
  }
}

test('listComments returns reaction/viewer flags and only the authors own pending comments', async () => {
  const { posts } = harness();
  const data = await posts.listComments({ id: 'post-1' }, ctxFor('user-1'));
  const c1 = data.items.find((c) => c.id === 'c1');
  assert.equal(c1.counters.reactions, 0);
  assert.equal(c1.viewer.reacted, false);
  assert.equal(c1.viewer.canDelete, true);
  assert.equal(c1.replies.length, 1);
  assert.equal(data.items.find((c) => c.id === 'c3').viewer.canDelete, false);
  assert.equal(data.items.find((c) => c.id === 'c4').status, 'pending');
  const other = await posts.listComments({ id: 'post-1' }, ctxFor('user-2'));
  assert.equal(other.items.some((c) => c.id === 'c4'), false);
});

test('F3 duplicate and concurrent toggles use one atomic RPC and keep counts consistent', async () => {
  const { posts, rows, rpcCalls } = harness();
  const payload = { id: 'post-1', commentId: 'c1', next: true };
  await Promise.all([posts.toggleCommentReaction(payload, ctxFor('user-1')), posts.toggleCommentReaction(payload, ctxFor('user-1'))]);
  await posts.toggleCommentReaction(payload, ctxFor('user-2'));
  assert.equal(rows('hg_reactions').length, 2);
  assert.equal(rows('hg_comments')[0].reactionCount, 2);
  await Promise.all([posts.toggleCommentReaction({ ...payload, next: false }, ctxFor('user-1')),
    posts.toggleCommentReaction({ ...payload, next: false }, ctxFor('user-1'))]);
  assert.equal(rows('hg_reactions').length, 1);
  assert.equal(rows('hg_comments')[0].reactionCount, 1);
  assert.ok(rpcCalls.every((c) => c.name === 'hg_toggle_reaction'));
  const data = await posts.listComments({ id: 'post-1' }, ctxFor('user-2'));
  assert.equal(data.items.find((c) => c.id === 'c1').viewer.reacted, true);
});

test('guests, pending comments and nonexistent comments cannot react', async () => {
  const { posts, rpcCalls } = harness();
  for (const [commentId, ctx] of [['c1', { viewer: policies.buildViewer({}) }], ['c4', ctxFor('user-2')], ['missing', ctxFor('user-2')]]) {
    await assert.rejects(posts.toggleCommentReaction({ id: 'post-1', commentId, next: true }, ctx), (e) => e.kind === 'not_accessible');
  }
  assert.equal(rpcCalls.length, 0);
});

test('author deletion recycles reactions/counts and keeps an authorless tombstone with replies', async () => {
  const { posts, rows } = harness();
  await posts.toggleCommentReaction({ id: 'post-1', commentId: 'c1', next: true }, ctxFor('user-2'));
  await posts.deleteComment({ id: 'post-1', commentId: 'c1', expectedVersion: 1 }, ctxFor('user-1'));
  assert.equal(rows('hg_comments')[0].status, 'deleted');
  assert.equal(rows('hg_comments')[0].version, 2);
  assert.equal(rows('hg_posts')[0].commentCount, 2);
  assert.equal(rows('hg_reactions').length, 0);
  let data = await posts.listComments({ id: 'post-1' }, ctxFor('user-2'));
  const root = data.items.find((c) => c.id === 'c1');
  assert.equal(root.deleted, true);
  assert.equal(root.body, '这条回应已被删除。');
  assert.equal(root.author.userId, null);
  assert.equal(root.viewer.canDelete, false);
  assert.equal(root.replies[0].body, '定向回复');
  await posts.deleteComment({ id: 'post-1', commentId: 'c2', expectedVersion: 1 }, ctxFor('user-2'));
  data = await posts.listComments({ id: 'post-1' }, ctxFor('user-2'));
  assert.equal(data.items.some((c) => c.id === 'c1'), false);
  assert.equal(rows('hg_posts')[0].commentCount, 1);
});

test('non-authors/version conflicts cannot delete; deleting pending does not decrement count', async () => {
  const { posts, rows } = harness();
  await assert.rejects(posts.deleteComment({ commentId: 'c3', expectedVersion: 1 }, ctxFor('user-1')), (e) => e.kind === 'forbidden');
  await assert.rejects(posts.deleteComment({ commentId: 'c3', expectedVersion: 9 }, ctxFor('user-2')), (e) => e.kind === 'conflict');
  await posts.deleteComment({ commentId: 'c4', expectedVersion: 1 }, ctxFor('user-1'));
  assert.equal(rows('hg_comments')[3].status, 'deleted');
  assert.equal(rows('hg_posts')[0].commentCount, 3);
});

test('F2 comment reactions cannot mark posts or crowd out another posts real reaction', async () => {
  const { posts, rows } = harness();
  rows('hg_posts').push({ ...rows('hg_posts')[0], _id: 'post-2' });
  for (let n = 0; n < 30; n += 1) rows('hg_reactions').push({ _id: `r${n}`, userId: 'user-1', postId: 'post-1', commentId: `c${n}` });
  rows('hg_reactions').push({ _id: 'user-1:post-2', userId: 'user-1', postId: 'post-2' });
  rows('hg_bookmarks').push({ _id: 'user-1:post-1', userId: 'user-1', postId: 'post-1' });
  const cards = await posts.hydrateCards(rows('hg_posts'), ctxFor('user-1'));
  assert.equal(cards[0].viewer.reacted, false);
  assert.equal(cards[1].viewer.reacted, true);
  assert.equal(cards[0].viewer.bookmarked, true);
  await posts.toggleReaction({ id: 'post-1', next: true }, ctxFor('user-1'));
  const both = await posts.hydrateCards(rows('hg_posts'), ctxFor('user-1'));
  assert.equal(both[0].viewer.reacted, true);
});

test('F5 more than 100 deleted rows cannot block live comments or consume their cursor pages', async () => {
  const { posts, store, rows } = harness();
  const template = rows('hg_comments')[0];
  store.set('hg_comments', [
    ...Array.from({ length: 120 }, (_, n) => ({ ...template, _id: `deleted-${n}`, status: 'deleted', createdAt: stamp(n) })),
    ...Array.from({ length: 25 }, (_, n) => ({ ...template, _id: `live-${n}`, createdAt: stamp(n + 120) })),
  ]);
  const ids = [];
  let cursor;
  do {
    const page = await posts.listComments({ id: 'post-1', pageSize: 5, cursor }, ctxFor('user-1'));
    ids.push(...page.items.map((c) => c.id));
    cursor = page.nextCursor;
    assert.ok(ids.length <= 25);
  } while (cursor);
  assert.equal(ids.length, 25);
  assert.equal(new Set(ids).size, 25);
  assert.ok(ids.every((id) => id.startsWith('live-')));
});

test('F5 a reply on a later page brings its deleted parent without exposing its body or identity', async () => {
  const { posts, rows } = harness();
  rows('hg_comments')[0].status = 'deleted';
  let page = await posts.listComments({ id: 'post-1', pageSize: 1 }, ctxFor('user-2'));
  assert.equal(page.items[0].id, 'c1');
  assert.equal(page.items[0].deleted, true);
  assert.equal(page.items[0].author.userId, null);
  assert.equal(page.items[0].replies[0].id, 'c2');
  assert.ok(page.nextCursor);
  page = await posts.listComments({ id: 'post-1', pageSize: 1, cursor: page.nextCursor }, ctxFor('user-2'));
  assert.equal(page.items[0].id, 'c3');
});

test('F1 createComment returns the current reviewed DTO/version, not the initial pending version', async () => {
  const { posts, fakeDb, rows } = harness();
  fakeDb.getDb = () => ({ rpc: async (name, args) => {
    assert.equal(name, 'hg_create_comment');
    rows('hg_comments').push({ ...args.p_comment, status: 'published', version: 7 });
    return { id: args.p_comment._id, state: 'pending' };
  } });
  const result = await posts.createComment({ id: 'post-1', body: '新回应', identityMode: 'named', idempotencyKey: 'key' }, ctxFor('user-1'));
  assert.equal(result.state, 'published');
  assert.equal(result.version, 7);
  assert.equal(result.comment.id, result.id);
  assert.equal(result.comment.viewer.canDelete, true);
});

test('F3 database failures surface and never fall back to partially applied writes', async () => {
  const { posts, fakeDb, rows } = harness();
  fakeDb.getDb = () => ({ rpc: async () => { throw new Error('database unavailable'); } });
  await assert.rejects(posts.toggleCommentReaction({ id: 'post-1', commentId: 'c1', next: true }, ctxFor('user-1')), /database unavailable/);
  assert.equal(rows('hg_reactions').length, 0);
});
