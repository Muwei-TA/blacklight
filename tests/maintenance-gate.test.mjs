import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const helper = require('../shared/write-gate.js');

const apiEntryPath = require.resolve('../cloudfunctions/api/index.js');
const workerEntryPath = require.resolve('../cloudfunctions/worker/index.js');
const callbackEntryPath = require.resolve('../cloudfunctions/review-callback/index.js');

const counters = {
  apiDispatch: 0,
  workerGetCloud: 0,
  workerDb: 0,
  workerTasks: 0,
  callbackDb: 0,
  callbackContext: 0,
};

const fakeCloud = {
  DYNAMIC_CURRENT_ENV: 'dynamic',
  init() {},
  getWXContext() {
    counters.callbackContext += 1;
    return { SOURCE: 'wx_http' };
  },
};

const fakeConstants = {
  COLLECTIONS: { assets: 'hg_assets', reviewTasks: 'hg_review_tasks' },
  ASSET_STATUS: { VERIFYING: 'verifying', VERIFIED: 'verified', REJECTED: 'rejected' },
  REVIEW_TASK_STATUS: { QUEUED: 'queued' },
};

const fakeWorkerDb = {
  getCloud() {
    counters.workerGetCloud += 1;
    return fakeCloud;
  },
  coll() {
    counters.workerDb += 1;
    throw new Error('worker database must not be touched while paused');
  },
  command() {
    counters.workerDb += 1;
    throw new Error('worker database must not be touched while paused');
  },
};

const fakeCallbackDb = {
  coll() {
    counters.callbackDb += 1;
    throw new Error('callback database must not be touched while paused');
  },
};

function loadEntry(entryPath, mockLoad) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const mock = mockLoad(request, parent, isMain);
    if (mock && mock.handled) return mock.value;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[entryPath];
    return require(entryPath);
  } finally {
    Module._load = originalLoad;
  }
}

const api = loadEntry(apiEntryPath, (request, parent) => {
  if (!parent || parent.filename !== apiEntryPath) return null;
  if (request === './shared/router') {
    return {
      handled: true,
      value: {
        createRouter() {
          return async () => {
            counters.apiDispatch += 1;
            return { code: 0, data: 'router ran' };
          };
        },
      },
    };
  }
  if (request.startsWith('./domain/')) return { handled: true, value: {} };
  return null;
});

const worker = loadEntry(workerEntryPath, (request, parent) => {
  if (!parent || parent.filename !== workerEntryPath) return null;
  if (request === './shared/db') return { handled: true, value: fakeWorkerDb };
  if (request === './shared/anonymity') return { handled: true, value: { scrubForLog: (value) => value } };
  if (request === './tasks/review' || request === './tasks/media'
    || request === './tasks/cleanup' || request === './tasks/digest' || request === './tasks/usage') {
    return {
      handled: true,
      value: new Proxy({}, {
        get() {
          return async () => {
            counters.workerTasks += 1;
            throw new Error('worker business task must not run while paused');
          };
        },
      }),
    };
  }
  return null;
});

const callback = loadEntry(callbackEntryPath, (request, parent) => {
  if (!parent || parent.filename !== callbackEntryPath) return null;
  if (request === 'wx-server-sdk') return { handled: true, value: fakeCloud };
  if (request === './shared/constants') return { handled: true, value: fakeConstants };
  if (request === './shared/db') return { handled: true, value: fakeCallbackDb };
  return null;
});

test('默认未启用时走原 handler，环境变量和标记文件可独立启用门闩', async () => {
  const originalPause = process.env.CLOUDBASE_WRITES_PAUSED;
  delete process.env.CLOUDBASE_WRITES_PAUSED;
  try {
    const markerDir = mkdtempSync(join(tmpdir(), 'cloudbase-write-gate-'));
    const markerPath = join(markerDir, helper.PAUSE_FILE);
    try {
      assert.equal(helper.isCloudbaseWritesPaused({ env: {}, markerPath }), false);

      let handled = 0;
      const gate = helper.withCloudbaseWriteGate(async () => {
        handled += 1;
        return { code: 0 };
      }, { env: {}, markerPath });
      assert.deepEqual(await gate({ action: 'posts/create' }, { requestId: 'normal-request' }), { code: 0 });
      assert.equal(handled, 1);

      writeFileSync(markerPath, '1\n');
      assert.equal(helper.isCloudbaseWritesPaused({ env: {}, markerPath }), true);
      assert.equal(helper.isCloudbaseWritesPaused({ env: { CLOUDBASE_WRITES_PAUSED: '1' }, markerPath: join(markerDir, 'missing') }), true);
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  } finally {
    if (originalPause === undefined) delete process.env.CLOUDBASE_WRITES_PAUSED;
    else process.env.CLOUDBASE_WRITES_PAUSED = originalPause;
  }
});

test('三个入口暂停时在路由、timer 初始化、回调认证和业务写入之前返回', async () => {
  const originalPause = process.env.CLOUDBASE_WRITES_PAUSED;
  const originalWarn = console.warn;
  const warnings = [];
  process.env.CLOUDBASE_WRITES_PAUSED = '1';
  console.warn = (...args) => warnings.push(args);

  counters.apiDispatch = 0;
  counters.workerGetCloud = 0;
  counters.workerDb = 0;
  counters.workerTasks = 0;
  counters.callbackDb = 0;
  counters.callbackContext = 0;

  try {
    const apiResult = await api.main({
      action: 'posts/create',
      payload: { content: 'private body' },
      headers: { authorization: 'secret' },
    }, { requestId: 'api-request-1' });
    const workerResult = await worker.main({ mode: 'all', secret: 'secret' }, { requestId: 'worker-request-1' });
    const callbackResult = await callback.main({
      secret: 'callback-secret',
      headers: { 'x-review-callback-secret': 'callback-secret' },
    }, { requestId: 'callback-request-1' });

    assert.deepEqual(apiResult, { code: 'maintenance', status: 'paused', requestId: 'api-request-1' });
    assert.deepEqual(workerResult, { code: 'maintenance', status: 'paused', requestId: 'worker-request-1' });
    assert.deepEqual(callbackResult, { code: 'maintenance', status: 'paused', requestId: 'callback-request-1' });

    assert.equal(counters.apiDispatch, 0);
    assert.equal(counters.workerGetCloud, 0);
    assert.equal(counters.workerDb, 0);
    assert.equal(counters.workerTasks, 0);
    assert.equal(counters.callbackDb, 0);
    assert.equal(counters.callbackContext, 0);
    assert.deepEqual(warnings, [
      [helper.MAINTENANCE_MARKER, { requestId: 'api-request-1' }],
      [helper.MAINTENANCE_MARKER, { requestId: 'worker-request-1' }],
      [helper.MAINTENANCE_MARKER, { requestId: 'callback-request-1' }],
    ]);
  } finally {
    console.warn = originalWarn;
    if (originalPause === undefined) delete process.env.CLOUDBASE_WRITES_PAUSED;
    else process.env.CLOUDBASE_WRITES_PAUSED = originalPause;
  }
});

test('普通 requestId 不从 event 或 headers 取值，无法用 event 内容污染停写日志', async () => {
  const originalWarn = console.warn;
  const warnings = [];
  const markerDir = mkdtempSync(join(tmpdir(), 'cloudbase-write-gate-'));
  const markerPath = resolve(markerDir, helper.PAUSE_FILE);
  writeFileSync(markerPath, '1\n');
  console.warn = (...args) => warnings.push(args);

  try {
    const gate = helper.withCloudbaseWriteGate(async () => assert.fail('paused handler ran'), { env: {}, markerPath });
    const result = await gate({ requestId: 'event-secret', headers: { authorization: 'secret' } }, null);
    assert.deepEqual(result, { code: 'maintenance', status: 'paused', requestId: 'unknown' });
    assert.deepEqual(warnings, [[helper.MAINTENANCE_MARKER, { requestId: 'unknown' }]]);
  } finally {
    console.warn = originalWarn;
    rmSync(markerDir, { recursive: true, force: true });
  }
});
