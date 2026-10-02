import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const constants = require('../shared/constants.js');
const calls = [];
process.env.MINIPROGRAM_APP_ID = 'review-test-app';
let posts = {};
let comments = {};
let users = {};
let assets = [];
let securitySuggest = 'pass';
let usageAllowed = true;
let securityCalls = 0;
let quotaNextAttemptAt = '2026-09-24T00:00:00.000Z';

const fakeWechat = {
  async msgSecCheck({ openid }) {
    assert.ok(openid.startsWith('openid-'));
    securityCalls += 1;
    return { result: { suggest: securitySuggest } };
  },
};
const fakeDb = {
  async findOneById(name, id) {
    if (name === constants.COLLECTIONS.posts) return posts[id] || null;
    if (name === constants.COLLECTIONS.comments) return comments[id] || null;
    if (name === constants.COLLECTIONS.users) return users[id] || null;
    return null;
  },
  async findByIds(name, ids) {
    if (name !== constants.COLLECTIONS.assets) return [];
    return assets.filter((asset) => ids.includes(asset._id));
  },
  getDb() {
    return {
      async rpc(name, args) {
        calls.push({ name, args });
        if (name === 'hg_usage_reserve_review_call') {
          return { allowed: usageAllowed, nextAttemptAt: usageAllowed ? null : quotaNextAttemptAt };
        }
        const status = args.p_decision === 'approve' ? 'passed' : 'failed';
        return { ok: true, status, targetStatus: args.p_decision === 'approve' ? 'published' : 'rejected' };
      },
    };
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === './db' && parent?.filename?.replace(/\\/g, '/').endsWith('/shared/usage.js')) return fakeDb;
  if (request.endsWith('/shared/wechat-api')) return fakeWechat;
  if (request.endsWith('/shared/constants')) return constants;
  if (request.endsWith('/shared/db')) return fakeDb;
  return originalLoad.call(this, request, parent, isMain);
};
const review = require('../cloudfunctions/worker/tasks/review.js');
Module._load = originalLoad;

function reset() {
  calls.length = 0;
  posts = {
    'post-1': {
      _id: 'post-1', clubId: 'heiguang', ownerId: 'u-author', status: constants.POST_STATUS.PENDING,
      version: 3, title: '标题', body: '正文', assetIds: [],
    },
  };
  comments = {
    'comment-1': {
      _id: 'comment-1', clubId: 'heiguang', ownerId: 'u-commenter', postId: 'post-1',
      status: constants.POST_STATUS.PENDING, version: 2, body: '回应',
    },
  };
  users = {
    'u-author': { _id: 'u-author', wxOpenIdRef: 'openid-author' },
    'u-commenter': { _id: 'u-commenter', wxOpenIdRef: 'openid-commenter' },
  };
  assets = [];
  securitySuggest = 'pass';
  usageAllowed = true;
  securityCalls = 0;
}

function postTask() {
  return {
    _id: 'task-post-1', clubId: 'heiguang', targetType: 'post', targetId: 'post-1', postVersion: 3,
    status: constants.REVIEW_TASK_STATUS.RUNNING, leaseId: 'lease-1',
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
}

function commentTask() {
  return {
    _id: 'task-comment-1', clubId: 'heiguang', targetType: 'comment', targetId: 'comment-1',
    status: constants.REVIEW_TASK_STATUS.RUNNING, leaseId: 'lease-2',
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
}

test('安全检查通过后，post review 只调用 hg_finish_review 并传 lease/CAS', async () => {
  reset();
  const task = postTask();
  const result = await review.reviewPost(task);
  assert.equal(result.status, constants.REVIEW_TASK_STATUS.PASSED);
  assert.deepEqual(calls[0], {
    name: 'hg_usage_reserve_review_call',
    args: { p_club_id: 'heiguang', p_kind: 'text' },
  });
  assert.deepEqual(calls[1], {
    name: 'hg_finish_review',
    args: {
      p_task_id: 'task-post-1',
      p_lease_id: 'lease-1',
      p_expected_version: 3,
      p_decision: 'approve',
      p_reason: '',
      p_club_id: 'heiguang',
    },
  });
  assert.equal(task.status, constants.REVIEW_TASK_STATUS.PASSED);
  assert.equal(task.leaseId, '');
});

test('文章通过自动安全检查后等待管理员，普通碎片仍由自动检查通过后发布', async () => {
  reset();
  posts['post-1'].kind = 'article';
  const manual = await review.reviewPost(postTask());
  assert.equal(manual.status, constants.REVIEW_TASK_STATUS.MANUAL);
  assert.match(manual.note, /editorial approval/);
  assert.equal(calls.filter((call) => call.name === 'hg_usage_reserve_review_call').length, 1);
  assert.equal(calls.some((call) => call.name === 'hg_finish_review'), false);

  reset();
  const fragment = await review.reviewPost(postTask());
  assert.equal(fragment.status, constants.REVIEW_TASK_STATUS.PASSED);
  assert.equal(calls.at(-1).name, 'hg_finish_review');
  assert.equal(calls.at(-1).args.p_decision, 'approve');
});

test('评论安全检查通过后走同一原子 RPC，使用评论版本', async () => {
  reset();
  const task = commentTask();
  const result = await review.reviewComment(task);
  assert.equal(result.status, constants.REVIEW_TASK_STATUS.PASSED);
  assert.equal(calls[0].name, 'hg_usage_reserve_review_call');
  assert.equal(calls[1].args.p_task_id, 'task-comment-1');
  assert.equal(calls[1].args.p_expected_version, 2);
  assert.equal(calls[1].args.p_decision, 'approve');
});

test('安全检查明确拒绝时原子标记 failed，服务异常/存疑不绕过 RPC', async () => {
  reset();
  securitySuggest = 'risky';
  const failed = await review.reviewPost(postTask());
  assert.equal(failed.status, constants.REVIEW_TASK_STATUS.FAILED);
  assert.equal(calls[1].args.p_decision, 'reject');

  reset();
  securitySuggest = 'review';
  const manual = await review.reviewPost(postTask());
  assert.equal(manual.status, constants.REVIEW_TASK_STATUS.MANUAL);
  assert.equal(calls.length, 1, 'the external check is metered even when it requests manual review');
  assert.equal(calls[0].name, 'hg_usage_reserve_review_call');
  assert.equal(securityCalls, 1);
});

test('未验证附件只等待，绑定或归属异常不会发布', async () => {
  reset();
  posts['post-1'].assetIds = ['asset-1'];
  assets = [{ _id: 'asset-1', clubId: 'heiguang', status: constants.ASSET_STATUS.UPLOADED, ownerId: 'u-author', postId: 'post-1' }];
  const waiting = await review.reviewPost(postTask());
  assert.equal(waiting.status, constants.REVIEW_TASK_STATUS.QUEUED);
  assert.equal(calls.length, 0);

  reset();
  posts['post-1'].assetIds = ['asset-1'];
  assets = [{ _id: 'asset-1', clubId: 'heiguang', status: constants.ASSET_STATUS.VERIFIED, ownerId: 'other', postId: 'post-1' }];
  const rejected = await review.reviewPost(postTask());
  assert.equal(rejected.status, constants.REVIEW_TASK_STATUS.FAILED);
  assert.equal(calls[1].args.p_decision, 'reject');
});

test('审核配额触顶时不调用外部接口，任务延期到下一 UTC 日且不走失败决定', async () => {
  reset();
  usageAllowed = false;
  quotaNextAttemptAt = '2026-09-24T00:00:00.000Z';
  const result = await review.reviewPost(postTask());
  assert.equal(result.status, constants.REVIEW_TASK_STATUS.QUEUED);
  assert.equal(result.waitingReason, 'usage_quota');
  assert.equal(new Date(result.nextAttemptAt).toISOString(), quotaNextAttemptAt);
  assert.equal(calls.length, 1, 'a denied quota reservation makes no finish-review RPC');
  assert.equal(calls[0].name, 'hg_usage_reserve_review_call');
  assert.equal(securityCalls, 0, 'no external moderation API call occurs after the cap');
});
