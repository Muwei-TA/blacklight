import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const constants = require('../shared/constants.js');
const policies = require('../shared/policies.js');
const calls = [];
let rpcResult;
let rpcError = null;

const fakeDb = {
  getDb() {
    return {
      async rpc(name, args) {
        calls.push({ name, args });
        if (rpcError) throw rpcError;
        return rpcResult;
      },
    };
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('/shared/db')) return fakeDb;
  return originalLoad.call(this, request, parent, isMain);
};
const levels = require('../cloudfunctions/api/domain/levels.js');
Module._load = originalLoad;

const member = policies.buildViewer({
  userId: 'member-1',
  clubId: constants.DEFAULT_CLUB_ID,
  role: constants.ROLE.MEMBER,
  memberStatus: constants.MEMBER_STATUS.ACTIVE,
});
const nonMember = policies.buildViewer({
  userId: 'guest-1',
  clubId: constants.DEFAULT_CLUB_ID,
  role: constants.ROLE.GUEST,
  memberStatus: constants.MEMBER_STATUS.NONE,
});
const snapshot = {
  level: 3,
  title: '青枝',
  totalXp: 135,
  currentLevelXp: 120,
  nextLevelXp: 280,
  progressXp: 15,
  progressTargetXp: 160,
  today: {
    earnedXp: 8,
    maxXp: 19,
    checkedIn: true,
    reactions: 3,
    maxReactions: 5,
    comments: 1,
    maxComments: 3,
  },
};

test('等级读取只使用服务端会话身份，不接收 payload 身份', async () => {
  calls.length = 0;
  rpcError = null;
  rpcResult = snapshot;
  const result = await levels.getMyLevels({ userId: 'forged-user', totalXp: 999999 }, { viewer: member });
  assert.deepEqual(result, snapshot);
  assert.deepEqual(calls, [{ name: 'hg_user_levels_snapshot', args: { p_actor_id: 'member-1', p_club_id: 'heiguang' } }]);
});

test('签到只提交服务端会话身份并返回快照与实际奖励', async () => {
  calls.length = 0;
  rpcError = null;
  rpcResult = { ...snapshot, awardedXp: 0 };
  const result = await levels.checkIn({ userId: 'forged-user', date: '2099-01-01', xp: 500 }, { viewer: member });
  assert.equal(result.awardedXp, 0);
  assert.deepEqual(calls, [{ name: 'hg_user_levels_check_in', args: { p_actor_id: 'member-1', p_club_id: 'heiguang' } }]);
});

test('访客与非成员不能读取等级或签到', async () => {
  calls.length = 0;
  await assert.rejects(levels.getMyLevels({}, { viewer: policies.GUEST_VIEWER }), (error) => error.kind === 'unauthenticated');
  await assert.rejects(levels.checkIn({}, { viewer: nonMember }), (error) => error.kind === 'membership_invalid');
  assert.equal(calls.length, 0);
});

test('成员资格在 RPC 执行期间失效时返回统一成员错误', async () => {
  rpcError = Object.assign(new Error('MEMBERSHIP_REQUIRED'), { code: 'P0001' });
  await assert.rejects(levels.checkIn({}, { viewer: member }), (error) => error.kind === 'membership_invalid');
  rpcError = null;
});
