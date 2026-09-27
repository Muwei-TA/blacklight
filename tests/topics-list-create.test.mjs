import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const constants = require('../shared/constants.js');
const policies = require('../shared/policies.js');
const validators = require('../shared/validators.js');
const presenters = require('../shared/presenters.js');
const errors = require('../shared/errors.js');

let topicRows = [];
let followRows = [];
let failTopicRead = false;
let raceInsertWithOtherPending = false;
const paginateCalls = [];
const addedTopics = [];

function matches(document, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some((part) => matches(document, part));
    if (key === '$and') return expected.every((part) => matches(document, part));
    const actual = document[key];
    if (expected && expected.$op === 'in') return expected.value.includes(actual);
    if (expected && expected.$op === 'regex') return new RegExp(expected.value, expected.options).test(actual || '');
    return actual === expected;
  });
}

function rowsFor(name) {
  if (name === constants.COLLECTIONS.topics) return topicRows;
  if (name === constants.COLLECTIONS.topicFollows) return followRows;
  return [];
}

const fakeDb = {
  command: () => ({ in: (value) => ({ $op: 'in', value }) }),
  getDb: () => ({
    RegExp: ({ regexp, options }) => ({ $op: 'regex', value: regexp, options }),
  }),
  coll(name) {
    return {
      where(query) {
        return {
          limit(count) {
            return {
              async get() {
                if (name === constants.COLLECTIONS.topics && failTopicRead) throw new Error('simulated topic read failure');
                return { data: rowsFor(name).filter((row) => matches(row, query)).slice(0, count) };
              },
            };
          },
        };
      },
      async add({ data }) {
        addedTopics.push(data);
        if (raceInsertWithOtherPending) {
          topicRows.push({ ...data, ownerId: 'other-member' });
          throw Object.assign(new Error('duplicate key'), { code: '23505' });
        }
        if (topicRows.some((row) => row._id === data._id)) {
          throw Object.assign(new Error('duplicate key'), { code: '23505' });
        }
        topicRows.push(data);
        return { _id: data._id };
      },
    };
  },
  async paginate(name, where, options) {
    paginateCalls.push({ name, where, options });
    const rows = rowsFor(name)
      .filter((row) => matches(row, where))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b._id.localeCompare(a._id));
    return { items: rows.slice(0, options.pageSize), hasMore: rows.length > options.pageSize };
  },
  async findOneById(name, id) {
    return rowsFor(name).find((row) => row._id === id) || null;
  },
  serverDate: () => '2026-09-27T00:00:00.000Z',
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('/shared/constants')) return constants;
  if (request.endsWith('/shared/policies')) return policies;
  if (request.endsWith('/shared/validators')) return validators;
  if (request.endsWith('/shared/presenters')) return presenters;
  if (request.endsWith('/shared/errors')) return errors;
  if (request.endsWith('/shared/db')) return fakeDb;
  if (request.endsWith('./search')) return { escapeRegex: (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
  return originalLoad.call(this, request, parent, isMain);
};
const topics = require('../cloudfunctions/api/domain/topics.js');
Module._load = originalLoad;

const member = policies.buildViewer({
  userId: 'member-1',
  role: constants.ROLE.MEMBER,
  memberStatus: constants.MEMBER_STATUS.ACTIVE,
});
const anotherMember = policies.buildViewer({
  userId: 'member-2',
  role: constants.ROLE.MEMBER,
  memberStatus: constants.MEMBER_STATUS.ACTIVE,
});
const guest = policies.GUEST_VIEWER;
const ctx = (viewer) => ({ viewer, now: Date.parse('2026-09-27T00:00:00.000Z') });

function reset() {
  topicRows = [];
  followRows = [];
  failTopicRead = false;
  raceInsertWithOtherPending = false;
  paginateCalls.length = 0;
  addedTopics.length = 0;
}

test('active-only title search filters before pagination and treats regex characters literally', async () => {
  reset();
  topicRows = [
    { _id: 'archived-new', title: 'a.*主题', status: 'archived', clubId: 'heiguang', createdAt: '2026-09-26T00:00:00Z' },
    { _id: 'pending-own', title: 'a.*主题', status: 'pending', ownerId: member.userId, clubId: 'heiguang', createdAt: '2026-09-25T00:00:00Z' },
    { _id: 'active-old', title: 'A.*主题', status: 'active', clubId: 'heiguang', createdAt: '2026-09-20T00:00:00Z' },
  ];

  const result = await topics.list({ status: 'active', q: 'a.*', pageSize: 1 }, ctx(member));

  assert.deepEqual(result.items.map((item) => item.id), ['active-old']);
  assert.equal(paginateCalls.length, 1);
  assert.equal(paginateCalls[0].where.status, 'active');
  assert.deepEqual(paginateCalls[0].where.title, { $op: 'regex', value: 'a\\.\\*', options: 'i' });
  assert.equal(paginateCalls[0].options.pageSize, 1);
});

test('active-only is the only explicit list status and q is limited to 50 characters', async () => {
  reset();
  await assert.rejects(topics.list({ status: 'pending' }, ctx(member)), (error) => error.kind === 'invalid_input');
  await assert.rejects(topics.list({ q: 'x'.repeat(51) }, ctx(member)), (error) => error.kind === 'invalid_input');
  assert.equal(paginateCalls.length, 0);
});

test('guest topic search returns an empty page without querying topic data', async () => {
  reset();
  const result = await topics.list({ status: 'active', q: 'private title' }, ctx(guest));
  assert.deepEqual(result, { items: [], nextCursor: null });
  assert.equal(paginateCalls.length, 0);
});

test('active and archived title matches return readable duplicate DTOs', async () => {
  reset();
  topicRows = [{ _id: 'active-id', title: '同名', status: 'active', clubId: 'heiguang' }];
  assert.deepEqual(await topics.create({ title: ' 同名 ', description: '', category: 'life' }, ctx(member)), {
    duplicated: true,
    id: 'active-id',
    status: 'active',
  });
  assert.equal(addedTopics.length, 0);

  reset();
  topicRows = [{ _id: 'archived-id', title: '同名', status: 'archived', clubId: 'heiguang' }];
  assert.deepEqual(await topics.create({ title: '同名', description: '', category: 'life' }, ctx(member)), {
    duplicated: true,
    id: 'archived-id',
    status: 'archived',
  });
  assert.equal(addedTopics.length, 0);
});

test('another member pending same-title conflict does not expose its id or status', async () => {
  reset();
  topicRows = [{ _id: 'pending-secret-id', title: '同名', status: 'pending', ownerId: 'member-1', clubId: 'heiguang' }];

  await assert.rejects(
    topics.create({ title: '同名', description: '', category: 'life' }, ctx(anotherMember)),
    (error) => error.kind === 'conflict' && !error.message.includes('pending-secret-id') && !error.message.includes('pending'),
  );
  assert.equal(addedTopics.length, 0);
});

test('a topic lookup failure stops creation instead of being treated as no duplicate', async () => {
  reset();
  failTopicRead = true;
  await assert.rejects(topics.create({ title: '同名', description: '', category: 'life' }, ctx(member)), /simulated topic read failure/);
  assert.equal(addedTopics.length, 0);
});

test('same-code concurrent insert collision is resolved from the winning row', async () => {
  reset();
  raceInsertWithOtherPending = true;

  await assert.rejects(
    topics.create({ title: '并发同名', description: '', category: 'life' }, ctx(member)),
    (error) => error.kind === 'conflict' && !error.message.includes('other-member'),
  );
  assert.equal(addedTopics.length, 1);
  assert.match(addedTopics[0]._id, /^[0-9a-f]{64}$/);
});
