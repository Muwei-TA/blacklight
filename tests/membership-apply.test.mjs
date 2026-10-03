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
let rpcResult = null;
let myApplicationRows = [];
let myApplicationQuery = null;

const fakeDb = {
  coll(name, clubId) {
    const query = { name, clubId };
    const collection = {
      where(filter) { query.filter = filter; return collection; },
      orderBy(field, direction) { query.order = [field, direction]; return collection; },
      limit(value) { query.limit = value; return collection; },
      async get() { myApplicationQuery = query; return { data: myApplicationRows }; },
    };
    return collection;
  },
  getDb() {
    return {
      async rpc(name, args) {
        calls.push({ name, args });
        if (rpcError) throw rpcError;
        return rpcResult || { state: 'active', applicationId: 'application:1' };
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
  clubId: constants.DEFAULT_CLUB_ID,
  role: constants.ROLE.GUEST,
  memberStatus: constants.MEMBER_STATUS.NONE,
});
const member = policies.buildViewer({
  userId: 'u_member',
  clubId: constants.DEFAULT_CLUB_ID,
  role: constants.ROLE.MEMBER,
  memberStatus: constants.MEMBER_STATUS.ACTIVE,
});
const ctx = (viewer) => ({ viewer, now: Date.now() });

test('入社申请先散列一次性邀请码，只把哈希和 session actor 交给新 RPC', async () => {
  calls.length = 0;
  rpcError = null;
  const result = await session.apply({
    displayName: '申请人',
    inviteCode: ' ab12cd34 ',
    rulesVersion: ' v1.0 ',
    userId: 'forged-caller',
    role: 'moderator',
    status: 'active',
  }, ctx(applicant));

  assert.deepEqual(result, { state: 'active', applicationId: 'application:1' });
  assert.equal(calls[0].name, 'hg_apply_invitation');
  assert.equal(calls[0].args.p_actor_id, 'u_applicant');
  assert.equal(calls[0].args.p_input.inviteCode, undefined);
  assert.deepEqual({ ...calls[0].args.p_input, idempotencyKey: 'ignored' }, {
    displayName: '申请人',
    codeHash: '668c072603bbc3a89b6e2a67f878e29dbe33c020984d4928eda299e7cebe0adb',
    rulesVersion: 'v1.0',
    idempotencyKey: 'ignored',
  });
  assert.equal(calls[0].args.p_input.userId, undefined);
});

test('已完成邀请码入社的重试由 RPC 幂等返回，不在 API 提前拒绝', async () => {
  calls.length = 0;
  rpcError = null;
  const result = await session.apply({ displayName: '成员', inviteCode: 'AB12CD34', rulesVersion: 'v1.0' }, ctx(member));
  assert.deepEqual(result, { state: 'active', applicationId: 'application:1' });
  assert.equal(calls[0].name, 'hg_apply_invitation');
  assert.equal(calls[0].args.p_actor_id, 'u_member');
});

test('旧成员的 ALREADY_MEMBER 与被撤权用户的 FORBIDDEN 保持业务错误', async () => {
  for (const [marker, kind] of [['ALREADY_MEMBER', 'invalid_input'], ['FORBIDDEN', 'forbidden']]) {
    rpcError = Object.assign(new Error(marker), { code: 'P0001' });
    await assert.rejects(
      session.apply({ displayName: '成员', inviteCode: 'AB12CD34', rulesVersion: 'v1.0' }, ctx(member)),
      (error) => error.kind === kind,
    );
  }
  rpcError = null;
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

test('RPC返回的业务错误对象不会作为成功申请透传', async () => {
  rpcError = null;
  rpcResult = { state: 'rejected', error: 'INVITE_INVALID', applicationId: null };
  await assert.rejects(
    session.apply({ displayName: '申请人', inviteCode: 'AB12CD34', rulesVersion: 'v1.0' }, ctx(applicant)),
    (error) => error.kind === 'invalid_input' && error.detail.field === 'inviteCode',
  );

  rpcResult = { state: 'rejected', error: 'INVITE_RATE_LIMITED', applicationId: null };
  await assert.rejects(
    session.apply({ displayName: '申请人', inviteCode: 'AB12CD34', rulesVersion: 'v1.0' }, ctx(applicant)),
    (error) => error.kind === 'rate_limited',
  );
  rpcResult = null;
});

test('pending application returns only cancellation identifiers, version and reservation expiry', async () => {
  myApplicationRows = [{
    _id: 'application:pending-1', userId: applicant.userId, clubId: constants.DEFAULT_CLUB_ID,
    status: 'pending', version: '3', reservationExpiresAt: '2026-10-06T00:00:00.000Z',
    createdAt: new Date().toISOString(), inviteCode: 'must-not-return', codeHash: 'must-not-return',
  }];
  myApplicationQuery = null;

  const result = await session.myApplication({}, ctx(applicant));

  assert.deepEqual({
    applicationId: result.applicationId,
    version: result.version,
    reservationExpiresAt: result.reservationExpiresAt,
    state: result.state,
    reason: result.reason,
  }, {
    applicationId: 'application:pending-1',
    version: 3,
    reservationExpiresAt: '2026-10-06T00:00:00.000Z',
    state: 'pending',
    reason: '',
  });
  assert.deepEqual(myApplicationQuery, {
    name: constants.COLLECTIONS.membershipApplications,
    clubId: constants.DEFAULT_CLUB_ID,
    filter: { userId: applicant.userId, clubId: constants.DEFAULT_CLUB_ID },
    order: ['createdAt', 'desc'],
    limit: 1,
  });
  assert.equal(JSON.stringify(result).includes('must-not-return'), false);
});

test('pending application uses a positive integer version and falls back to version one for legacy values', async () => {
  myApplicationRows = [{
    _id: 'application:legacy-1', status: 'pending', version: 0,
    reservationExpiresAt: null, createdAt: new Date().toISOString(),
  }];
  const result = await session.myApplication({}, ctx(applicant));
  assert.equal(result.applicationId, 'application:legacy-1');
  assert.equal(result.version, 1);
  assert.equal(Number.isSafeInteger(result.version) && result.version > 0, true);
  assert.equal(result.reservationExpiresAt, null);
});
