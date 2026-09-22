import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const policies = require('../shared/policies.js');
const { ROLE, MEMBER_STATUS, POST_STATUS } = require('../shared/constants.js');
const rootConstants = require('../shared/constants.js');
const rootPolicies = policies;
const rootValidators = require('../shared/validators.js');
const rootErrors = require('../shared/errors.js');

const calls = [];
const fakeDb = {
  async findOneById(_name, id) {
    if (id === 'post-hidden') return { _id: id, ownerId: 'u_author', status: POST_STATUS.HIDDEN, version: 4 };
    return null;
  },
  getDb() {
    return {
      async rpc(name, args) {
        calls.push({ name, args });
        return { ok: true };
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
  if (request.endsWith('/shared/db')) return fakeDb;
  return originalLoad.call(this, request, parent, isMain);
};
const governance = require('../cloudfunctions/api/domain/governance.js');
Module._load = originalLoad;

const moderator = policies.buildViewer({
  userId: 'u_mod',
  role: ROLE.MODERATOR,
  memberStatus: MEMBER_STATUS.ACTIVE,
});
const admin = policies.buildViewer({
  userId: 'u_admin',
  role: ROLE.ADMIN,
  memberStatus: MEMBER_STATUS.ACTIVE,
});

function ctx(viewer) {
  return { viewer };
}

test('成员治理把可信 actorId 放在 RPC 参数，不接受调用者 userId', async () => {
  calls.length = 0;
  await governance.removeMember({ targetUserId: 'u_target', expectedVersion: 2, reason: '违反社区约定' }, ctx(moderator));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'hg_governance');
  assert.equal(calls[0].args.p_actor_id, 'u_mod');
  assert.equal(calls[0].args.p_input.targetUserId, 'u_target');
  assert.equal(calls[0].args.p_input.userId, undefined);
});

test('成员治理拒绝非 moderator 和自操作', async () => {
  await assert.rejects(
    governance.removeMember({ targetUserId: 'u_target', expectedVersion: 1, reason: '理由' }, ctx(admin)),
    (error) => error.kind === 'forbidden',
  );
  await assert.rejects(
    governance.changeMemberRole({ targetUserId: 'u_mod', expectedVersion: 1, role: ROLE.ADMIN, reason: '提权' }, ctx(moderator)),
    (error) => error.kind === 'forbidden',
  );
});

test('禁言只接受未来时间，null 表示显式解除', async () => {
  await assert.rejects(
    governance.muteMember({ targetUserId: 'u_target', expectedVersion: 1, mutedUntil: new Date(Date.now() - 1_000).toISOString(), reason: '处理' }, ctx(moderator)),
    (error) => error.kind === 'invalid_input',
  );
  calls.length = 0;
  await governance.muteMember({ targetUserId: 'u_target', expectedVersion: 1, mutedUntil: null, reason: '解除' }, ctx(moderator));
  assert.equal(calls[0].args.p_input.mutedUntil, null);
});

test('申诉读取帖子后只允许作者对 hidden 内容发起，并绑定版本', async () => {
  calls.length = 0;
  await governance.createAppeal({ postId: 'post-hidden', reason: '补充证据', contentVersion: 4 }, ctx(policies.buildViewer({
    userId: 'u_author',
    role: ROLE.MEMBER,
    memberStatus: MEMBER_STATUS.ACTIVE,
  })));
  assert.equal(calls[0].args.p_action, 'appeal.create');
  assert.equal(calls[0].args.p_input.ownerId, 'u_author');
  assert.equal(calls[0].args.p_input.contentVersion, 4);
});

test('申诉决定必须是 moderator/admin 且必须有理由', async () => {
  await assert.rejects(
    governance.decideAppeal({ appealId: 'a1', expectedVersion: 1, decision: 'approve', reason: '' }, ctx(moderator)),
    (error) => error.kind === 'invalid_input',
  );
  calls.length = 0;
  await governance.decideAppeal({ appealId: 'a1', expectedVersion: 1, decision: 'reject', reason: '证据不足' }, ctx(admin));
  assert.equal(calls[0].args.p_action, 'appeal.decide');
  assert.equal(calls[0].args.p_actor_id, 'u_admin');
});
