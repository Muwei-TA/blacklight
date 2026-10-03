import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createTermReminderRunner } = require('../server/worker.js');
const DAY_MS = 24 * 60 * 60 * 1000;

test('NAS worker calls the idempotent term reminder RPC once per day and retries database failures', async () => {
  assert.equal(typeof createTermReminderRunner, 'function');
  let now = Date.parse('2026-10-03T00:00:00.000Z');
  const calls = [];
  let failNext = false;
  const runner = createTermReminderRunner({
    async rpc(name, args) {
      calls.push({ name, args });
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error('temporary'), { code: '08006' });
      }
      return { sent30Day: 1, sent7Day: 0 };
    },
  }, { now: () => now, intervalMs: DAY_MS });

  assert.deepEqual(await runner(), { sent30Day: 1, sent7Day: 0 });
  assert.deepEqual(await runner(), { skipped: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { name: 'hg_management_term_reminders', args: {} });

  now += DAY_MS - 1;
  assert.deepEqual(await runner(), { skipped: true });
  now += 1;
  failNext = true;
  await assert.rejects(runner(), (error) => error.code === '08006');
  assert.deepEqual(await runner(), { sent30Day: 1, sent7Day: 0 });
  assert.equal(calls.length, 3);
});
