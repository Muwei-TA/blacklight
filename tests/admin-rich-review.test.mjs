import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let review;
try {
  review = require('../admin-web/content-review.js');
} catch {
  review = {};
}
require('../admin-web/api.js');
const adminApi = globalThis.AdminApi;

test('富文文章要求全文预览，旧纯文本内容保留原审核流程', () => {
  assert.equal(typeof review.isRichReviewItem, 'function');
  assert.equal(review.isRichReviewItem({ queue: 'content', kind: 'article', format: 'richtext-v1' }), true);
  assert.equal(review.isRichReviewItem({ queue: 'content', kind: 'article', format: 'plain' }), false);
  assert.equal(review.isRichReviewItem({ queue: 'content', kind: 'fragment', format: 'richtext-v1' }), false);
});

test('富文详情请求明确携带队列版本', () => {
  assert.equal(typeof review.contentDetailPayload, 'function');
  const item = { queue: 'content', kind: 'article', format: 'richtext-v1', id: 'post-1', version: 4 };
  assert.deepEqual(review.contentDetailPayload(item), { id: 'post-1', expectedVersion: 4 });
  assert.equal(review.contentDetailPayload({ ...item, version: null }), null);
});

test('管理台允许把当前文章 ID 和 expectedVersion 发给全文详情 action', async () => {
  const requests = [];
  const api = adminApi.createAdminApi(async (path, options) => {
    requests.push({ path, options });
    return {
      ok: true,
      async json() {
        return path === '/v1/admin/session' ? { csrfToken: 'csrf-test' } : { code: 0, data: { id: 'post-1' } };
      },
    };
  });
  await api.getSession();
  await api.action('admin/content/detail', 'club-a', { id: 'post-1', expectedVersion: 4 });
  assert.equal(requests[1].path, '/v1/admin/action');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    action: 'admin/content/detail', clubId: 'club-a', payload: { id: 'post-1', expectedVersion: 4 },
  });
});

test('富文审核只接受与队列 ID 和版本一致的完整详情', () => {
  assert.equal(typeof review.isCurrentRichReviewDetail, 'function');
  const item = { queue: 'content', kind: 'article', format: 'richtext-v1', id: 'post-1', version: 4 };
  const detail = {
    id: 'post-1', version: 4, format: 'richtext-v1', title: '标题', summary: '', visibility: 'club',
    assets: [], assetIds: [], richDoc: { type: 'doc', content: [] },
  };
  assert.equal(review.isCurrentRichReviewDetail(item, detail), true);
  assert.equal(review.isCurrentRichReviewDetail(item, { ...detail, version: 3 }), false);
  assert.equal(review.isCurrentRichReviewDetail(item, { ...detail, id: 'post-2' }), false);
  assert.equal(review.isCurrentRichReviewDetail(item, { ...detail, richDoc: null }), false);
  assert.equal(review.isCurrentRichReviewDetail({ ...item, format: 'plain' }, detail), false);
});
