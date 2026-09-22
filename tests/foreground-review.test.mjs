import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../cloudfunctions/api/domain/foreground-review.js', import.meta.url));
const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const requireFromTest = createRequire(import.meta.url);
const recovery = requireFromTest(`${BACKEND}/cloudfunctions/worker/recovery.js`);

const constants = {
  COLLECTIONS: { posts: 'hg_posts', comments: 'hg_comments', assets: 'hg_assets', reviewTasks: 'hg_review_tasks' },
  POST_STATUS: { PENDING: 'pending' },
  ASSET_STATUS: { UPLOADED: 'uploaded', VERIFIED: 'verified', REJECTED: 'rejected' },
  REVIEW_TASK_STATUS: { QUEUED: 'queued', RUNNING: 'running', PASSED: 'passed', FAILED: 'failed', MANUAL: 'manual' },
};
const errorOf = (kind) => Object.assign(new Error(kind), { kind });
const errors = {
  unauthenticated: () => errorOf('unauthenticated'),
  forbidden: () => errorOf('forbidden'),
  notAccessible: () => errorOf('not_accessible'),
  invalidInput: () => errorOf('invalid_input'),
};

const db = {};
const review = {};
const media = {};
const module = { exports: {} };
const localRequire = (id) => ({
  '../shared/constants': constants,
  '../shared/errors': errors,
  '../shared/db': db,
  '../tasks/review': review,
  '../tasks/media': media,
  '../recovery': recovery,
}[id]);
vm.runInNewContext(
  `(function (require, module, exports) {\n${readFileSync(SOURCE, 'utf8')}\n})(__require, module, module.exports);`,
  { __require: localRequire, module, exports: module.exports },
  { filename: SOURCE },
);
const { runOwnedReview } = module.exports;

function configureDb(target, task, { claimUpdated = 1, writeUpdated = 1 } = {}) {
  const whereCalls = [];
  const updateCalls = [];
  const operators = {
    exists: (value) => ({ $op: 'exists', value }),
    lt: (value) => ({ $op: 'lt', value }),
    lte: (value) => ({ $op: 'lte', value }),
  };
  const chain = {
    where(query) { whereCalls.push(query); return this; },
    orderBy() { return this; },
    limit() { return this; },
    async get() { return { data: task ? [task] : [] }; },
    async update({ data }) {
      updateCalls.push(data);
      return { stats: { updated: updateCalls.length === 1 ? claimUpdated : writeUpdated } };
    },
  };
  db.command = () => operators;
  db.findOneById = async () => target;
  db.coll = () => chain;
  return { whereCalls, updateCalls };
}

const viewer = { isAuthenticated: true, userId: 'user-1' };

await assert.rejects(
  runOwnedReview('post', 'post-1', { viewer: { isAuthenticated: false, userId: 'user-1' } }),
  (error) => error.kind === 'unauthenticated',
);
configureDb({ _id: 'post-1', ownerId: 'other-user', status: 'pending', version: 1 }, null);
await assert.rejects(runOwnedReview('post', 'post-1', { viewer }), (error) => error.kind === 'forbidden');

{
  const target = { _id: 'post-1', ownerId: viewer.userId, status: 'pending', version: 3 };
  const task = { _id: 'review:post-1', targetType: 'post', targetId: 'post-1', postVersion: 3, status: 'queued', attempts: 0 };
  const calls = configureDb(target, task);
  review.reviewPost = async () => { throw new Error('wx openapi token unavailable'); };
  const result = await runOwnedReview('post', 'post-1', { viewer });

  assert.equal(result.state, 'pending');
  assert.equal(result.reviewState, 'queued');
  assert.equal(result.version, 3);
  assert.equal(calls.whereCalls[0].postVersion, 3);
  assert.equal(calls.updateCalls[0].status, 'running');
  assert.ok(calls.updateCalls[0].leaseId);
  assert.equal(calls.updateCalls[1].status, 'queued');
  assert.equal(calls.updateCalls[1].attempts, 1);
  assert.equal(calls.whereCalls[2].status, 'running');
  assert.equal(calls.whereCalls[2].leaseId, calls.updateCalls[0].leaseId);
}

{
  const target = { _id: 'comment-1', ownerId: viewer.userId, status: 'pending', version: 1 };
  const task = { _id: 'comment-review:comment-1', targetType: 'comment', targetId: 'comment-1', postVersion: 1, status: 'queued', attempts: 0 };
  const calls = configureDb(target, task);
  review.reviewComment = async (claimed) => { claimed.status = 'passed'; claimed.leaseId = ''; return { status: 'passed', targetStatus: 'published', version: 2 }; };
  const result = await runOwnedReview('comment', 'comment-1', { viewer });

  assert.equal(result.state, 'published');
  assert.equal(result.reviewState, 'passed');
  assert.equal(result.version, 2);
  assert.equal(calls.whereCalls[0].postVersion, 1);
  assert.equal(calls.updateCalls.length, 1, 'post/comment terminal state belongs to the atomic RPC');
}

{
  const target = { _id: 'asset-1', ownerId: viewer.userId, status: 'uploaded', postVersion: 0 };
  const task = { _id: 'asset-review:asset-1', targetType: 'asset', targetId: 'asset-1', status: 'queued', attempts: 0 };
  const calls = configureDb(target, task);
  media.processAsset = async () => ({ status: 'passed' });
  const result = await runOwnedReview('asset', 'asset-1', { viewer });

  assert.equal(result.state, 'verified');
  assert.equal(result.reviewState, 'passed');
  assert.equal(calls.updateCalls.length, 2);
  assert.equal(calls.updateCalls[1].status, 'passed');
  assert.equal(calls.whereCalls[2].status, 'running');
  assert.equal(calls.whereCalls[2].leaseId, calls.updateCalls[0].leaseId);
}

console.log('OK: foreground review VM auth, owner, version, lease, failure, and terminal paths passed');

{
 const target={_id:'post-1',ownerId:viewer.userId,status:'pending',version:1};
 const task={_id:'task-gone',targetType:'post',targetId:'post-1',postVersion:1,status:'queued',attempts:0};
 const calls=configureDb(target,task);
 review.reviewPost=async()=>({status:'passed',note:'post gone'});
 await runOwnedReview('post','post-1',{viewer});
 assert.equal(calls.updateCalls.length,2,'non-RPC early outcomes must release the running lease');
 assert.equal(calls.updateCalls[1].status,'passed');
}
