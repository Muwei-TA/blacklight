import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const fakeConstants = {
  COLLECTIONS: {
    assets: 'hg_assets',
    reviewTasks: 'hg_review_tasks',
    idempotency: 'hg_idempotency',
    users: 'hg_users',
    posts: 'hg_posts',
    memberships: 'hg_memberships',
    anonymousIdentities: 'hg_anonymous_identities',
  },
  ASSET_STATUS: {
    INTENT: 'intent',
    UPLOADED: 'uploaded',
    VERIFYING: 'verifying',
    VERIFIED: 'verified',
    REJECTED: 'rejected',
    FAILED: 'failed',
  },
  POST_STATUS: { DELETED: 'deleted' },
  REVIEW_TASK_STATUS: {
    QUEUED: 'queued',
    RUNNING: 'running',
    PASSED: 'passed',
    FAILED: 'failed',
    MANUAL: 'manual',
  },
};

let sourceContext = { SOURCE: 'wx_client' };
const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'dynamic',
  init() {},
  getWXContext() {
    return sourceContext;
  },
  async deleteFile() {
    return { fileList: [] };
  },
};

const fakeDb = {
  command() {
    return {
      in: (value) => ({ $in: value }),
      lt: (value) => ({ $lt: value }),
      lte: (value) => ({ $lte: value }),
      gte: (value) => ({ $gte: value }),
      exists: (value) => ({ $exists: value }),
    };
  },
  serverDate() {
    return 'server-date';
  },
};

function requireWithMocks(path, extra = {}) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (extra.modules && extra.modules[request]) return extra.modules[request];
    if (request === 'wx-server-sdk') return fakeCloud;
    if (request.endsWith('/shared/constants')) return fakeConstants;
    if (request.endsWith('/shared/db')) return extra.db || fakeDb;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(path)];
    return require(path);
  } finally {
    Module._load = originalLoad;
  }
}

const callback = requireWithMocks('../cloudfunctions/review-callback/index.js');
const worker = requireWithMocks('../cloudfunctions/worker/index.js', {
  db: { ...fakeDb, getCloud: () => fakeCloud },
  modules: {
    './tasks/review': {},
    './tasks/media': {},
    './tasks/cleanup': {},
    './tasks/digest': {},
    './shared/anonymity': { scrubForLog: (value) => value },
  },
});
const cleanupState = { assets: [], updates: [], removes: 0 };
const cleanupDb = {
  ...fakeDb,
  coll(name) {
    const chain = {
      where(condition) {
        chain.condition = condition;
        return chain;
      },
      limit() {
        return chain;
      },
      async get() {
        if (name === fakeConstants.COLLECTIONS.assets && !chain.claimed) return { data: cleanupState.assets };
        return { data: [] };
      },
      async update({ data }) {
        cleanupState.updates.push({ name, condition: chain.condition, data });
        chain.claimed = true;
        return { stats: { updated: 1 } };
      },
      async remove() {
        cleanupState.removes += 1;
        return { stats: { removed: 1 } };
      },
      doc() {
        return chain;
      },
    };
    return chain;
  },
};
const cleanup = requireWithMocks('../cloudfunctions/worker/tasks/cleanup.js', { db: cleanupDb });

test('租约过期可恢复，等待依赖不增加 attempts，执行失败才退避', () => {
  const recovery = require('../cloudfunctions/worker/recovery.js');
  const now = Date.parse('2026-09-22T12:00:00.000Z');
  const running = { status: 'running', claimedAt: new Date(now - 91_000) };
  assert.equal(recovery.isLeaseExpired(running, now, 90_000), true);

  const waiting = recovery.buildWaitingUpdate({ status: 'queued', note: 'waiting for assets' }, now, 60_000);
  assert.equal(waiting.status, 'queued');
  assert.equal(waiting.attempts, undefined);
  assert.equal(waiting.waitingReason, 'dependency');
  assert.equal(waiting.nextAttemptAt.getTime(), now + 60_000);

  const firstFailure = recovery.buildFailureUpdate(
    { attempts: 0 },
    new Error('temporary service failure'),
    now,
    { maxAttempts: 3, retryBaseMs: 1_000, retryMaxMs: 10_000 },
  );
  assert.equal(firstFailure.update.status, 'queued');
  assert.equal(firstFailure.update.attempts, 1);
  assert.equal(firstFailure.update.nextAttemptAt.getTime(), now + 1_000);

  const exhausted = recovery.buildFailureUpdate(
    { attempts: 2 },
    new Error('third failure'),
    now,
    { maxAttempts: 3, retryBaseMs: 1_000, retryMaxMs: 10_000 },
  );
  assert.equal(exhausted.update.status, 'manual');
  assert.equal(exhausted.update.attempts, 3);
  assert.equal(exhausted.update.nextAttemptAt, null);
});

test('回调来源不信 MsgType，必须有 wx context 来源和 secret', () => {
  const oldSecret = process.env.REVIEW_CALLBACK_SECRET;
  process.env.REVIEW_CALLBACK_SECRET = 'callback-secret';
  try {
    sourceContext = { SOURCE: 'wx_client' };
    assert.equal(callback._internals.verifySource({ MsgType: 'security', secret: 'callback-secret' }).ok, false);

    sourceContext = { SOURCE: 'wx_http' };
    assert.equal(callback._internals.verifySource({ MsgType: 'forged', secret: 'callback-secret' }).ok, true);
    assert.equal(callback._internals.verifySource({ MsgType: 'security', secret: 'wrong' }).ok, false);
  } finally {
    if (oldSecret === undefined) delete process.env.REVIEW_CALLBACK_SECRET;
    else process.env.REVIEW_CALLBACK_SECRET = oldSecret;
  }
});

test('worker 不把伪造 Timer event 当作可信来源', () => {
  sourceContext = { SOURCE: 'wx_client' };
  assert.equal(worker._internals.verifyWorkerSource(fakeCloud, { Type: 'Timer', TriggerName: 'review-tick' }).ok, false);
  sourceContext = { SOURCE: 'wx_trigger' };
  assert.equal(worker._internals.verifyWorkerSource(fakeCloud, { Type: 'forged' }).ok, true);
});

test('回调 trace/version 绑定拒绝旧版本', () => {
  const { assetBindingMatches, assetCondition } = callback._internals;
  const asset = { _id: 'asset-1', traceId: 'trace-new', postVersion: 4, reviewVersion: 2 };
  assert.equal(assetBindingMatches({ traceId: 'trace-old', result: { reviewVersion: 2 } }, asset), false);
  assert.equal(assetBindingMatches({ result: { reviewVersion: 1 } }, asset), false);
  assert.equal(assetBindingMatches({ result: { reviewVersion: 2 } }, asset), true);
  assert.equal(assetBindingMatches({ assetId: 'asset-other', result: { reviewVersion: 2 } }, asset), false);
  assert.deepEqual(assetCondition(asset), {
    _id: 'asset-1',
    status: 'verifying',
    traceId: 'trace-new',
    postVersion: 4,
    reviewVersion: 2,
  });
});

test('云存储删除失败保留资产记录并写 retryable 状态', async () => {
  cleanupState.assets = [{
    _id: 'asset-orphan',
    fileId: 'cloud://orphan',
    postId: '',
    status: 'uploaded',
    createdAt: new Date(Date.now() - cleanup.ORPHAN_ASSET_TTL - 1_000),
  }];
  cleanupState.updates = [];
  cleanupState.removes = 0;
  fakeCloud.deleteFile = async () => {
    throw new Error('storage temporarily unavailable');
  };

  const result = await cleanup.cleanupOrphanAssets();
  assert.equal(result.removed, 0);
  assert.equal(result.retryable, 1);
  assert.equal(cleanupState.removes, 0);
  assert.equal(cleanupState.updates.some(({ data }) => data.cleanupState === 'retryable'), true);
});

test('worker cleanup 分支在文件确认删除后才把 revoked 标成 purged', async () => {
  cleanupState.assets = [{
    _id: 'asset-revoked',
    fileId: 'cloud://revoked',
    postId: 'post-deleted',
    status: 'revoked',
  }];
  cleanupState.updates = [];
  cleanupState.removes = 0;
  fakeCloud.deleteFile = async () => ({ fileList: [{ fileID: 'cloud://revoked', status: 0 }] });

  const result = await cleanup.cleanupDeletedPostAssets();
  assert.equal(result.purged, 1);
  assert.equal(result.retryable, 0);
  assert.equal(cleanupState.updates.some(({ data }) => data.status === 'purged'), true);
});
