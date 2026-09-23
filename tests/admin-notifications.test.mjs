import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Module = require('node:module');
const policies = require('../shared/policies.js');
const presenters = require('../shared/presenters.js');
const constants = require('../shared/constants.js');
const shared = Object.fromEntries(['constants', 'policies', 'presenters', 'validators', 'errors'].map((name) => [name, require(`../shared/${name}.js`)]));
const queries = [];
const messages = ['admin_queue', 'admin_appeals', 'post'].map((targetType) => ({
  _id: targetType, targetType, targetId: targetType === 'admin_appeals' ? 'appeals' : 'content',
  recipientId: 'user-1', title: 'message', eventType: 'system_notice', readAt: null,
}));
const filter = (where) => messages.filter((n) => !where.targetType || !where.targetType.value.includes(n.targetType));
const db = {
  command: () => ({ in: (value) => ({ value }), nin: (value) => ({ value }) }),
  async paginate(_collection, where) { queries.push(where); return { items: filter(where), hasMore: false }; },
  async findByIds() { return []; },
  coll() { return { where(where) { queries.push(where); return { async count() { return { total: filter(where).length }; } }; } }; },
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request.endsWith('/shared/db')) return db;
  if (request.includes('/shared/')) return shared[request.split('/shared/')[1]];
  return originalLoad.call(this, request, parent, isMain);
};
const notifications = require('../cloudfunctions/api/domain/notifications.js');
Module._load = originalLoad;

test('admin target mapping uses the queue for both moderation and appeals', () => {
  for (const [targetType, targetId] of [['admin_queue', 'report'], ['admin_appeals', 'appeals']]) {
    assert.deepEqual(presenters.presentNotification({ targetType, targetId }, { accessible: true }).target,
      { type: targetType, id: targetId, queue: targetId, accessible: true });
  }
  assert.equal(presenters.presentNotification({ targetType: 'post', targetId: 'p' }).target.queue, undefined);
});

test('revoked admin sees neither old admin messages nor their unread count', async () => {
  for (const [role, memberStatus] of [[constants.ROLE.MEMBER, 'active'], [constants.ROLE.ADMIN, 'removed']]) {
    const viewer = policies.buildViewer({ userId: 'user-1', role, memberStatus });
    const list = await notifications.list({ tab: 'system' }, { viewer });
    assert.deepEqual(list.items.map((n) => n.id), ['post']);
    assert.equal((await notifications.unreadCount({}, { viewer })).count, 1);
    assert.deepEqual(queries.at(-1).targetType.value, ['admin_queue', 'admin_appeals']);
  }
});

test('both currently active administrator roles retain all system messages and count', async () => {
  for (const role of [constants.ROLE.ADMIN, constants.ROLE.MODERATOR]) {
    const viewer = policies.buildViewer({ userId: 'user-1', role, memberStatus: 'active' });
    assert.equal((await notifications.list({ tab: 'system' }, { viewer })).items.length, 3);
    assert.equal((await notifications.unreadCount({}, { viewer })).count, 3);
  }
});
