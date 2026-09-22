import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const constants = require('../shared/constants.js');
const policies = require('../shared/policies.js');
const validators = require('../shared/validators.js');
const errors = require('../shared/errors.js');
const presenters = require('../shared/presenters.js');
const calls = [];
let rpcError = null;

const fakeDb = {
  getDb() {
    return {
      async rpc(name, args) {
        calls.push({ name, args });
        if (rpcError) throw rpcError;
        return { state: 'pending', applicationId: 'application:1' };
      },
    };
  },
};

const fakeSession = { checkRateLimit: async () => true };
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('/shared/constants')) return constants;
  if (request.endsWith('/shared/policies')) return policies;
  if (request.endsWith('/shared/validators')) return validators;
  if (request.endsWith('/shared/errors')) return errors;
  if (request.endsWith('/shared/presenters')) return presenters;
  if (request.endsWith('/shared/db')) return fakeDb;
  if (request.endsWith('/shared/session')) return fakeSession;
  return originalLoad.call(this, request, parent, isMain);
};
const session = require('../cloudfunctions/api/domain/session.js');
Module._load = originalLoad;

const applicant = policies.buildViewer({
  userId: 'u_applicant',
  role: constants.ROLE.GUEST,
  memberStatus: constants.MEMBER_STATUS.NONE,
});
const member = policies.buildViewer({
  userId: 'u_member',
  role: constants.ROLE.MEMBER,
  memberStatus: constants.MEMBER_STATUS.ACTIVE,
});
const ctx = (viewer) => ({ viewer });

test('入社申请只把 session actor 交给 hg_apply_membership', async () => {
  calls.length = 0;
  rpcError = null;
  const result = await session.apply({
    displayName: '申请人',
    inviteCode: ' ab12cd34 ',
    rulesVersion: ' v1.0 ',
    userId: 'forged-caller',
  }, ctx(applicant));

  assert.deepEqual(result, { state: 'pending', applicationId: 'application:1' });
  assert.equal(calls[0].name, 'hg_apply_membership');
  assert.equal(calls[0].args.p_actor_id, 'u_applicant');
  assert.deepEqual(calls[0].args.p_input, {
    displayName: '申请人',
    inviteCode: 'AB12CD34',
    rulesVersion: 'v1.0',
  });
  assert.equal(calls[0].args.p_input.userId, undefined);
});

test('已是成员的申请在 RPC 前拒绝', async () => {
  calls.length = 0;
  await assert.rejects(
    session.apply({ displayName: '成员', inviteCode: 'AB12CD34', rulesVersion: 'v1.0' }, ctx(member)),
    (error) => error.kind === 'invalid_input',
  );
  assert.equal(calls.length, 0);
});

test('邀请码和规则版本错误保持业务错误形态', async () => {
  rpcError = Object.assign(new Error('INVITE_INVALID'), { code: 'P0001' });
  await assert.rejects(
    session.apply({ displayName: '申请人', inviteCode: 'BAD', rulesVersion: 'v1.0' }, ctx(applicant)),
    (error) => error.kind === 'invalid_input' && error.detail.field === 'inviteCode',
  );

  rpcError = Object.assign(new Error('RULES_VERSION_INVALID'), { code: 'P0001' });
  await assert.rejects(
    session.apply({ displayName: '申请人', inviteCode: 'AB12CD34', rulesVersion: 'v0.9' }, ctx(applicant)),
    (error) => error.kind === 'invalid_input' && error.detail.field === 'rulesVersion',
  );
  rpcError = null;
});
