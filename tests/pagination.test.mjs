import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('cursor pagination retains an existing visibility OR and timestamp tie-breaker', async () => {
  let filter;
  const rows = [
    { _id: 'a', createdAt: '2026-09-23T01:00:00.000Z', visibility: 'private' },
    { _id: 'b', createdAt: '2026-09-23T01:00:00.000Z', visibility: 'club' },
    { _id: 'c', createdAt: '2026-09-23T01:00:00.000Z', visibility: 'public' },
  ];
  const match = (row, query) => Object.entries(query).every(([key, value]) => {
    if (key === '$and') return value.every((part) => match(row, part));
    if (key === '$or') return value.some((part) => match(row, part));
    const current = row[key];
    if (value && value.$op) {
      const expected = value.value instanceof Date ? value.value.toISOString() : value.value;
      return value.$op === 'lt' ? current < expected : current > expected;
    }
    return current === (value instanceof Date ? value.toISOString() : value);
  });
  const command = { lt: (value) => ({ $op: 'lt', value }), gt: (value) => ({ $op: 'gt', value }) };
  const query = {
    where(value) { filter = value; return this; },
    orderBy() { return this; },
    limit() { return this; },
    async get() { return { data: rows.filter((row) => match(row, filter)) }; },
  };
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('../shared/db.js', import.meta.url), 'utf8'), {
    module, exports: module.exports, Date,
    require: (id) => {
      if (id === './pg-store') return { command, collection: () => query };
      if (id === './constants') return { COLLECTIONS: {} };
      return {};
    },
  });
  const where = { $or: [{ visibility: 'club' }, { visibility: 'public' }] };
  const result = await module.exports.paginate('hg_posts', where, {
    cursor: { createdAt: Date.parse(rows[0].createdAt), id: 'c' }, pageSize: 1,
  });
  assert.deepEqual(Array.from(result.items, (row) => row._id), ['b']);
  assert.equal(result.hasMore, false);
  assert.equal(where.$or.length, 2);
});
