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
let post = {
  _id: 'post-1', ownerId: 'user-1', clubId: 'heiguang', kind: 'article', title: 'old', body: 'old',
  assetIds: [], visibility: 'club', identityMode: 'named', topicId: '', status: 'rejected', version: 2,
};
const calls = [];
const fakeDb = {
  async findOneById() { return post; },
  getDb() {
    return {
      async rpc(name, args) {
        calls.push({ name, args });
        post = { ...post, status: 'pending', version: 3, title: args.p_title, body: args.p_body };
        return { id: post._id, state: 'pending', version: 3 };
      },
    };
  },
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  const stubs = {
    '../shared/constants': constants,
    '../shared/policies': policies,
    '../shared/validators': validators,
    '../shared/presenters': presenters,
    '../shared/errors': errors,
    '../shared/db': fakeDb,
    '../shared/anonymity': {},
    './foreground-review': { runOwnedReview: async () => null },
  };
  const stubKey = request.startsWith('../../shared/')
    ? request.replace('../../shared/', '../shared/')
    : request === '../foreground-review' ? './foreground-review' : request;
  return Object.hasOwn(stubs, stubKey) ? stubs[stubKey] : originalLoad.call(this, request, parent, isMain);
};
const posts = require('../cloudfunctions/api/domain/posts.js');
const viewer = policies.buildViewer({ userId: 'user-1', role: constants.ROLE.MEMBER, memberStatus: constants.MEMBER_STATUS.ACTIVE });
const ctx = { viewer, capabilities: { publishing: true, publicScope: false } };

test('wrong owner cannot resubmit or reach PG RPC', async () => {
  await assert.rejects(posts.resubmitRejectedPost({ id: 'post-1', expectedVersion: 2, title: 'new', body: 'new', idempotencyKey: 'retry' }, {
    ...ctx,
    viewer: policies.buildViewer({ userId: 'other', role: constants.ROLE.MEMBER, memberStatus: constants.MEMBER_STATUS.ACTIVE }),
  }), (err) => err.kind === 'not_accessible');
  assert.equal(calls.length, 0);
});

test('resubmit passes trusted actor/version, and replay can reach PG idempotency after status advances', async () => {
  const payload = { id: 'post-1', expectedVersion: 2, title: 'revised', body: 'new text', idempotencyKey: 'retry' };
  const first = await posts.resubmitRejectedPost(payload, ctx);
  const second = await posts.resubmitRejectedPost(payload, ctx);
  assert.equal(first.state, 'pending');
  assert.equal(second.state, 'pending');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'hg_resubmit_rejected_post');
  assert.equal(calls[0].args.p_actor_id, 'user-1');
  assert.equal(calls[0].args.p_expected_version, 2);
  assert.equal(calls[0].args.p_title, 'revised');
  assert.equal(calls[0].args.p_body, 'new text');
});
