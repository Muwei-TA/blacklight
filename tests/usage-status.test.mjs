import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const policies = require('../shared/policies.js');
const constants = require('../shared/constants.js');
const rpcCalls = [];
const fakeDb = {
  getDb() {
    return {
      async rpc(name, args) {
        rpcCalls.push({ name, args });
        return { date: '2026-09-23', upload: { alertState: 'ok' }, review: { alertState: 'near_limit' } };
      },
    };
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('/shared/db')) return fakeDb;
  return originalLoad.call(this, request, parent, isMain);
};
let usageApi;
try {
  usageApi = require('../cloudfunctions/api/domain/usage.js');
} finally {
  Module._load = originalLoad;
}

test('usage status rejects non-moderators before reading aggregate quota data', async () => {
  rpcCalls.length = 0;
  await assert.rejects(
    usageApi.getStatus({ clubId: 'forged-club' }, { viewer: policies.GUEST_VIEWER }),
    (error) => error.kind === 'forbidden',
  );
  assert.equal(rpcCalls.length, 0);
});

test('usage status derives the club from the authenticated moderator context', async () => {
  rpcCalls.length = 0;
  const viewer = policies.buildViewer({
    userId: 'moderator-1', role: constants.ROLE.MODERATOR,
    memberStatus: constants.MEMBER_STATUS.ACTIVE, clubId: 'heiguang',
  });
  const result = await usageApi.getStatus({ clubId: 'forged-club' }, { viewer });
  assert.equal(result.review.alertState, 'near_limit');
  assert.deepEqual(rpcCalls, [{ name: 'hg_usage_status', args: { p_club_id: 'heiguang' } }]);
});
