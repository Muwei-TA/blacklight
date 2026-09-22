import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const routerPath = new URL('../shared/router.js', import.meta.url);
const source = readFileSync(routerPath, 'utf8');

let wxContext = { OPENID: 'openid-a', APPID: 'wx39773ed34aa30776', SOURCE: 'wx' };
const seenOpenids = [];

const modules = {
  './errors': {
    AppError: class AppError extends Error {},
    KIND: { INVALID_INPUT: 'invalid_input', SERVER: 'server' },
    MESSAGE_BY_KIND: { SERVER: '服务暂时不可用，请稍后重试' },
    serverError: () => ({ kind: 'server', message: '服务暂时不可用，请稍后重试' }),
  },
  './anonymity': { scrubForLog: (value) => value },
  './constants': { DEFAULT_CLUB_ID: 'club-default' },
  './session': {
    resolveContext: async (openid) => {
      seenOpenids.push(openid);
      return { viewer: { userId: openid, role: openid ? 'member' : 'guest' } };
    },
  },
  './db': {
    getCloud: () => ({ getWXContext: () => wxContext }),
  },
};

const routerModule = { exports: {} };
const runtime = {
  module: routerModule,
  exports: routerModule.exports,
  require(name) {
    if (!modules[name]) throw new Error(`unexpected dependency: ${name}`);
    return modules[name];
  },
  process: { env: { MINIPROGRAM_APP_ID: 'wx39773ed34aa30776' } },
  console: { log() {}, warn() {}, error() {} },
  Date,
  JSON,
  Promise,
};
vm.runInNewContext(`${source}\nmodule.exports = { createRouter };`, runtime);

const router = routerModule.exports.createRouter(
  {
    probe: async (_payload, ctx) => ({ userId: ctx.viewer.userId }),
  },
  { name: 'fresh-context-test' },
);

const environmentA = JSON.stringify({ WX_OPENID: 'openid-a', WX_APPID: 'wx39773ed34aa30776' });
const environmentB = JSON.stringify({ WX_OPENID: 'openid-b', WX_APPID: 'wx39773ed34aa30776' });

let result = await router({ action: 'probe' }, { environment: environmentA, requestId: 'a' });
assert.equal(result.code, 0);
assert.equal(result.data.userId, 'openid-a');

// A reused process must not trust invocation A's identity when the current
// Cloud context is B and the invocation envelope is stale.
wxContext = { OPENID: 'openid-b', APPID: 'wx39773ed34aa30776', SOURCE: 'wx' };
result = await router({ action: 'probe' }, { environment: environmentA, requestId: 'stale-a' });
assert.equal(result.code, 0);
assert.equal(result.data.userId, null);

result = await router({ action: 'probe' }, { environment: environmentB, requestId: 'b' });
assert.equal(result.code, 0);
assert.equal(result.data.userId, 'openid-b');

result = await router(
  { action: 'probe' },
  { environment: JSON.stringify({ WX_OPENID: 'openid-b', WX_APPID: 'wrong-appid' }), requestId: 'wrong-app' },
);
assert.equal(result.code, 0);
assert.equal(result.data.userId, null);

assert.deepEqual(seenOpenids, ['openid-a', null, 'openid-b', null]);
console.log('OK: backend router resolves fresh invocation identity and rejects stale/mismatched envelopes');
