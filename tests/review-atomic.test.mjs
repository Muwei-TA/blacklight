import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const constants = require('../shared/constants.js');
const calls = [];
process.env.WX_APPID = 'review-test-app';
let posts = {};
let comments = {};
let users = {};
let assets = [];
let securitySuggest = 'pass';

const fakeCloud = {
  openapi({ appid }) {
    assert.equal(appid, 'review-test-app');
    return {
      security: {
        async msgSecCheck() {
          return { result: { suggest: securitySuggest } };
        },
      },
    };
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
        const status = args.p_decision === 'approve' ? 'passed' : 'failed';
        return { ok: true, status, targetStatus: args.p_decision === 'approve' ? 'published' : 'rejected' };
      },
    };
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'wx-server-sdk') return fakeCloud;
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
      _id: 'post-1', ownerId: 'u-author', status: constants.POST_STATUS.PENDING,
      version: 3, title: '标题', body: '正文', assetIds: [],
    },
  };
  comments = {
    'comment-1': {
      _id: 'comment-1', ownerId: 'u-commenter', postId: 'post-1',
      status: constants.POST_STATUS.PENDING, version: 2, body: '回应',
    },
  };
  users = {
    'u-author': { _id: 'u-author', wxOpenIdRef: 'openid-author' },
    'u-commenter': { _id: 'u-commenter', wxOpenIdRef: 'openid-commenter' },
  };
  assets = [];
  securitySuggest = 'pass';
}

function postTask() {
  return {
    _id: 'task-post-1', targetType: 'post', targetId: 'post-1', postVersion: 3,
    status: constants.REVIEW_TASK_STATUS.RUNNING, leaseId: 'lease-1',
    leaseExpiresAt: new Date(Date.now() + 60_000),
  };
}

function commentTask() {
  return {
    _id: 'task-comment-1', targetType: 'comment', targetId: 'comment-1',
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
    name: 'hg_finish_review',
    args: {
      p_task_id: 'task-post-1',
      p_lease_id: 'lease-1',
      p_expected_version: 3,
      p_decision: 'approve',
      p_reason: '',
    },
  });
  assert.equal(task.status, constants.REVIEW_TASK_STATUS.PASSED);
  assert.equal(task.leaseId, '');
});

test('评论安全检查通过后走同一原子 RPC，使用评论版本', async () => {
  reset();
  const task = commentTask();
  const result = await review.reviewComment(task);
  assert.equal(result.status, constants.REVIEW_TASK_STATUS.PASSED);
  assert.equal(calls[0].args.p_task_id, 'task-comment-1');
  assert.equal(calls[0].args.p_expected_version, 2);
  assert.equal(calls[0].args.p_decision, 'approve');
});

test('安全检查明确拒绝时原子标记 failed，服务异常/存疑不绕过 RPC', async () => {
  reset();
  securitySuggest = 'risky';
  const failed = await review.reviewPost(postTask());
  assert.equal(failed.status, constants.REVIEW_TASK_STATUS.FAILED);
  assert.equal(calls[0].args.p_decision, 'reject');

  reset();
  securitySuggest = 'review';
  const manual = await review.reviewPost(postTask());
  assert.equal(manual.status, constants.REVIEW_TASK_STATUS.MANUAL);
  assert.equal(calls.length, 0);
});

test('未验证附件只等待，绑定或归属异常不会发布', async () => {
  reset();
  posts['post-1'].assetIds = ['asset-1'];
  assets = [{ _id: 'asset-1', status: constants.ASSET_STATUS.UPLOADED, ownerId: 'u-author', postId: 'post-1' }];
  const waiting = await review.reviewPost(postTask());
  assert.equal(waiting.status, constants.REVIEW_TASK_STATUS.QUEUED);
  assert.equal(calls.length, 0);

  reset();
  posts['post-1'].assetIds = ['asset-1'];
  assets = [{ _id: 'asset-1', status: constants.ASSET_STATUS.VERIFIED, ownerId: 'other', postId: 'post-1' }];
  const rejected = await review.reviewPost(postTask());
  assert.equal(rejected.status, constants.REVIEW_TASK_STATUS.FAILED);
  assert.equal(calls[0].args.p_decision, 'reject');
});
