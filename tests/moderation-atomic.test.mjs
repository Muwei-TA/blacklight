import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const rootConstants = require('../shared/constants.js');
const rootPolicies = require('../shared/policies.js');
const rootValidators = require('../shared/validators.js');
const rootErrors = require('../shared/errors.js');
const rootPresenters = require('../shared/presenters.js');
const calls = [];
let moderationPosts = [{ _id: 'post-1', clubId: 'heiguang', title: '文章', body: '正文', status: 'published', visibility: 'public', createdAt: '2026-09-23T00:00:00.000Z' }];
let rpcError = null;
const fakeDb = {
  command: () => ({ in: (value) => ({ $op: 'in', value }) }),
  coll(name) {
    return {
      where: (query) => ({
        limit: () => ({
          get: async () => ({
            data: name === rootConstants.COLLECTIONS.posts
              ? moderationPosts.filter((post) => query.visibility.value.includes(post.visibility))
              : [],
          }),
        }),
      }),
    };
  },
  async paginate(name) {
    if (name === rootConstants.COLLECTIONS.membershipApplications) {
      return { items: [{ _id: 'app-1', displayName: '申请人', status: 'pending', version: 1, createdAt: '2026-09-23T00:00:00.000Z' }], hasMore: false };
    }
    if (name === rootConstants.COLLECTIONS.reports) {
      return { items: [{ _id: 'report-1', targetType: 'post', targetId: 'post-1', reason: '理由', status: 'received', createdAt: '2026-09-23T00:00:00.000Z' }], hasMore: false };
    }
    return { items: [{ _id: 'task-1', targetType: 'collection_submission', targetId: 'post-1', collectionId: 'collection-1', status: 'queued', createdAt: '2026-09-23T00:00:00.000Z' }], hasMore: false };
  },
  async findByIds() {
    return moderationPosts;
  },
  getDb() {
    return {
      async rpc(name, args) {
        calls.push({ name, args });
        if (rpcError) throw rpcError;
        return { ok: true, status: 'published', version: 2 };
      },
    };
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('/shared/constants')) return rootConstants;
  if (request.endsWith('/shared/policies')) return rootPolicies;
  if (request.endsWith('/shared/validators')) return rootValidators;
  if (request.endsWith('/shared/errors')) return rootErrors;
  if (request.endsWith('/shared/presenters')) return rootPresenters;
  if (request.endsWith('/shared/db')) return fakeDb;
  return originalLoad.call(this, request, parent, isMain);
};
const moderation = require('../cloudfunctions/api/domain/moderation.js');
Module._load = originalLoad;

const moderator = rootPolicies.buildViewer({
  userId: 'u_mod',
  clubId: rootConstants.DEFAULT_CLUB_ID,
  role: rootConstants.ROLE.MODERATOR,
  memberStatus: rootConstants.MEMBER_STATUS.ACTIVE,
});
const ctx = (viewer, capabilities = { anthology: true }) => ({ viewer, capabilities });

test('内容决定走 hg_moderate，入社决定走保留额度专用 RPC', async () => {
  calls.length = 0;
  await moderation.decideContent({ id: 'p-1', decision: 'approve', expectedVersion: 4, reason: '' }, ctx(moderator));
  await moderation.decideComment({ id: 'c-1', decision: 'reject', expectedVersion: 2, reason: '不符合规范' }, ctx(moderator));
  await moderation.decideTopic({ id: 't-1', decision: 'archive', expectedVersion: 3, reason: '活动结束' }, ctx(moderator));
  await moderation.decideMembership({ id: 'a-1', decision: 'approve', expectedVersion: 1 }, ctx(moderator));
  await moderation.decideReport({ id: 'r-1', decision: 'hide', expectedVersion: 1, reason: '需要核查' }, ctx(moderator));
  await moderation.decideCollection({ id: 'task-1', decision: 'include', expectedVersion: 1 }, ctx(moderator));

  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map((call) => call.name), [
    'hg_moderate', 'hg_moderate', 'hg_moderate', 'hg_decide_membership_application', 'hg_moderate', 'hg_moderate',
  ]);
  assert.deepEqual(calls.map((call) => call.args.p_actor_id), Array(6).fill('u_mod'));
  assert.deepEqual(calls.map((call) => call.args.p_input.expectedVersion), [4, 2, 3, 1, 1, 1]);
  assert.equal(calls[3].args.p_club_id, rootConstants.DEFAULT_CLUB_ID);
  assert.deepEqual(calls[3].args.p_input, { id: 'a-1', decision: 'approve', reason: '', expectedVersion: 1 });
  assert.equal(calls[0].args.p_input.userId, undefined);
});

test('入社/举报/话题/文集决定缺少 expectedVersion 会在 RPC 前拒绝', async () => {
  for (const invoke of [
    () => moderation.decideMembership({ id: 'a-1', decision: 'approve' }, ctx(moderator)),
    () => moderation.decideReport({ id: 'r-1', decision: 'keep', reason: '已核查' }, ctx(moderator)),
    () => moderation.decideTopic({ id: 't-1', decision: 'approve' }, ctx(moderator)),
    () => moderation.decideCollection({ id: 'task-1', decision: 'skip', reason: '本期已满' }, ctx(moderator)),
  ]) {
    await assert.rejects(invoke(), (error) => error.kind === 'invalid_input');
  }
});

test('文集能力关闭时不能由管理决定旁路开启', async () => {
  calls.length = 0;
  await assert.rejects(
    moderation.decideCollection({ id: 'task-1', decision: 'include', expectedVersion: 1 }, ctx(moderator, { anthology: false })),
    (error) => error.kind === 'forbidden',
  );
  assert.equal(calls.length, 0);
});

test('评论奖励遇到成员资格并发更新时以可重试冲突返回', async () => {
  rpcError = Object.assign(new Error('XP_MEMBERSHIP_BUSY'), { code: '55P03' });
  await assert.rejects(
    moderation.decideComment({ id: 'c-1', decision: 'approve', expectedVersion: 1, reason: '' }, ctx(moderator)),
    (error) => error.kind === 'conflict' && /成员状态正在变更/.test(error.message),
  );
  rpcError = null;
});

test('普通成员不能调用原子管理决定', async () => {
  const member = rootPolicies.buildViewer({
    userId: 'u_member',
    clubId: rootConstants.DEFAULT_CLUB_ID,
    role: rootConstants.ROLE.MEMBER,
    memberStatus: rootConstants.MEMBER_STATUS.ACTIVE,
  });
  await assert.rejects(
    moderation.decideContent({ id: 'p-1', decision: 'hide', expectedVersion: 1, reason: '理由' }, ctx(member)),
    (error) => error.kind === 'forbidden',
  );
});

test('成员/举报/文集队列 DTO 为旧记录补 version=1', async () => {
  const member = await moderation.listQueue({ queue: 'member' }, ctx(moderator));
  const report = await moderation.listQueue({ queue: 'report' }, ctx(moderator));
  const collection = await moderation.listQueue({ queue: 'collection' }, ctx(moderator));
  assert.equal(member.items[0].version, 1);
  assert.equal(report.items[0].version, 1);
  assert.equal(collection.items[0].version, 1);
});

test('文集队列不会把私密手记正文带到管理员 DTO', async () => {
  moderationPosts = [{ _id: 'post-1', clubId: 'heiguang', title: '私密', body: '私密正文', status: 'published', visibility: 'private' }];
  const collection = await moderation.listQueue({ queue: 'collection' }, ctx(moderator));
  assert.deepEqual(collection.items, []);
  moderationPosts = [{ _id: 'post-1', clubId: 'heiguang', title: '文章', body: '正文', status: 'published', visibility: 'public', createdAt: '2026-09-23T00:00:00.000Z' }];
});
