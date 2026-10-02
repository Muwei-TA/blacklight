import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const constants = require('../shared/constants.js');
const policies = require('../shared/policies.js');
const validators = require('../shared/validators.js');
const errors = require('../shared/errors.js');

const fixtures = new Map();
let posts = [];
const rpcCalls = [];
const fakeDb = {
  command() { return {}; },
  async paginate(name, where = {}, { cursor = null, pageSize = 20, includeEqualId = false } = {}) {
    let rows = (fixtures.get(name) || []).filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
    if (cursor) {
      rows = rows.filter((row) => {
        const date = new Date(row.createdAt).getTime();
        if (date > cursor.createdAt) return true;
        if (date < cursor.createdAt) return false;
        const compare = row._id.localeCompare(cursor.id);
        return compare > 0 || (includeEqualId && compare === 0);
      });
    }
    rows.sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt) || left._id.localeCompare(right._id));
    const page = rows.slice(0, pageSize + 1);
    return { items: page.slice(0, pageSize), hasMore: page.length > pageSize };
  },
  async findByIds(_name, ids = []) {
    return posts.filter((post) => ids.includes(post._id));
  },
  getDb() {
    return {
      async rpc(name, args) {
        rpcCalls.push({ name, args });
        if (name === 'hg_comment_queue') return [];
        if (name === 'hg_admin_appeals_queue') return [];
        return { ok: true };
      },
    };
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('/shared/constants')) return constants;
  if (request.endsWith('/shared/policies')) return policies;
  if (request.endsWith('/shared/validators')) return validators;
  if (request.endsWith('/shared/presenters')) return require('../shared/presenters.js');
  if (request.endsWith('/shared/errors')) return errors;
  if (request.endsWith('/shared/db')) return fakeDb;
  return originalLoad.call(this, request, parent, isMain);
};
const moderation = require('../cloudfunctions/api/domain/moderation.js');
Module._load = originalLoad;

const admin = policies.buildViewer({
  userId: 'admin-1',
  clubId: constants.DEFAULT_CLUB_ID,
  role: constants.ROLE.ADMIN,
  memberStatus: constants.MEMBER_STATUS.ACTIVE,
});
const ctx = { viewer: admin, now: Date.now(), capabilities: { anthology: true } };
const allCursor = (cursor) => JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));

function reset() {
  fixtures.clear();
  posts = [];
  rpcCalls.length = 0;
}

test('统一审核游标保留跨队列同时间同 ID 的后一项', async () => {
  reset();
  const createdAt = '2026-09-27T08:00:00.000Z';
  fixtures.set(constants.COLLECTIONS.boards, [{
    _id: 'same-id', clubId: constants.DEFAULT_CLUB_ID, status: constants.BOARD_STATUS.PENDING,
    title: '新板块', description: '', version: 1, createdAt,
  }]);
  fixtures.set(constants.COLLECTIONS.reports, [{
    _id: 'same-id', clubId: constants.DEFAULT_CLUB_ID, status: 'received', targetType: 'post', targetId: 'post-1',
    reason: '请核查', reporterId: 'must-not-cross-dto', version: 2, createdAt,
  }]);

  const first = await moderation.listQueue({ queue: 'all', pageSize: 1 }, ctx);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].queue, 'board');
  assert.equal(first.items[0].reporterId, undefined);
  assert.deepEqual(allCursor(first.nextCursor), {
    createdAt: new Date(createdAt).getTime(), id: 'same-id', queue: 'board',
  });

  const second = await moderation.listQueue({ queue: 'all', cursor: first.nextCursor, pageSize: 1 }, ctx);
  assert.deepEqual(second.items.map((item) => item.queue), ['report']);
  assert.equal(second.items[0].id, 'same-id');
  assert.equal(second.nextCursor, null);
});

test('内容队列跳过排队中和过期版本，只呈现人工任务的当前公开内容', async () => {
  reset();
  const staleAt = '2026-09-27T08:00:00.000Z';
  const currentAt = '2026-09-27T08:01:00.000Z';
  fixtures.set(constants.COLLECTIONS.reviewTasks, [
    { _id: 'review:stale', clubId: constants.DEFAULT_CLUB_ID, targetType: 'post', targetId: 'stale', postVersion: 1, status: 'manual', createdAt: staleAt },
    { _id: 'review:queued', clubId: constants.DEFAULT_CLUB_ID, targetType: 'post', targetId: 'queued', postVersion: 1, status: 'queued', createdAt: '2026-09-27T08:00:30.000Z' },
    { _id: 'review:article', clubId: constants.DEFAULT_CLUB_ID, targetType: 'post', targetId: 'article', postVersion: 2, status: 'manual', createdAt: currentAt },
  ]);
  posts = [
    { _id: 'stale', clubId: constants.DEFAULT_CLUB_ID, status: 'pending', visibility: 'public', version: 2, title: '旧版本' },
    { _id: 'queued', clubId: constants.DEFAULT_CLUB_ID, status: 'pending', visibility: 'public', version: 1, title: '自动审查中' },
    { _id: 'article', clubId: constants.DEFAULT_CLUB_ID, status: 'pending', visibility: 'club', version: 2, kind: 'article', title: '文章', body: '正文', createdAt: staleAt, ownerId: 'must-not-cross-dto' },
  ];

  const result = await moderation.listQueue({ queue: 'content', pageSize: 1 }, ctx);
  assert.deepEqual(result.items.map((item) => item.id), ['article']);
  assert.equal(result.items[0].kind, 'article');
  assert.equal(result.items[0].submittedAt, currentAt);
  assert.equal(result.items[0].ownerId, undefined);
  assert.equal(result.nextCursor, null);
});

test('统一队列越过不可见文集任务继续填充后续可见待办', async () => {
  reset();
  fixtures.set(constants.COLLECTIONS.reviewTasks, [
    {
      _id: 'collection:private', clubId: constants.DEFAULT_CLUB_ID, targetType: 'collection_submission', targetId: 'private-post',
      collectionId: 'collection-1', status: 'queued', version: 1, createdAt: '2026-09-27T08:00:00.000Z',
    },
    {
      _id: 'collection:visible', clubId: constants.DEFAULT_CLUB_ID, targetType: 'collection_submission', targetId: 'visible-post',
      collectionId: 'collection-1', status: 'queued', version: 2, createdAt: '2026-09-27T08:01:00.000Z',
    },
  ]);
  posts = [
    {
      _id: 'private-post', clubId: constants.DEFAULT_CLUB_ID, status: 'published', visibility: 'private',
      title: '私密手记', body: '不可返回', ownerId: 'private-owner',
    },
    {
      _id: 'visible-post', clubId: constants.DEFAULT_CLUB_ID, status: 'published', visibility: 'club',
      title: '可收录文章', body: '社内正文', ownerId: 'must-not-cross-dto',
    },
  ];

  const result = await moderation.listQueue({ queue: 'all', pageSize: 1 }, ctx);
  assert.deepEqual(result.items.map((item) => item.id), ['collection:visible']);
  assert.equal(result.items[0].title, '可收录文章');
  assert.equal(result.items[0].ownerId, undefined);
  assert.equal(result.items[0].summary.includes('不可返回'), false);
});

test('不接受伪造的全队列 cursor 分类', async () => {
  reset();
  const cursor = Buffer.from(JSON.stringify({ createdAt: Date.now(), id: 'x', queue: 'private' })).toString('base64');
  await assert.rejects(
    moderation.listQueue({ queue: 'all', cursor }, ctx),
    (error) => error.kind === 'invalid_input',
  );
});
