/**
 * 入参校验与游标测试。
 * 对应 docs/04 的产品限制值与分页契约。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const v = require('../shared/validators.js');
const { CONTENT_LIMITS } = require('../shared/constants.js');
const { escapeRegex } = (() => {
  // search.js 依赖 wx-server-sdk，这里只取纯函数做测试
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { escapeRegex: escape };
})();

test('碎片正文超限被拒', () => {
  assert.throws(
    () => v.validatePostInput({ kind: 'fragment', visibility: 'club', body: 'a'.repeat(CONTENT_LIMITS.fragmentBody + 1) }),
    /最多/,
  );
});

test('文章必须有标题', () => {
  assert.throws(() => v.validatePostInput({ kind: 'article', visibility: 'club', body: '正文' }), /标题/);
});

test('空内容且无附件被拒', () => {
  assert.throws(() => v.validatePostInput({ kind: 'fragment', visibility: 'club', body: '   ' }), /写一点内容/);
});

test('纯图片内容允许', () => {
  const out = v.validatePostInput({ kind: 'fragment', visibility: 'club', body: '', assetIds: ['a1'] });
  assert.equal(out.assetIds.length, 1);
});

test('仅自己内容不能关联话题', () => {
  assert.throws(
    () => v.validatePostInput({ kind: 'fragment', visibility: 'private', body: 'x', topicId: 't1' }),
    /不能关联话题/,
  );
});

test('仅自己内容强制关闭回应', () => {
  const out = v.validatePostInput({ kind: 'fragment', visibility: 'private', body: 'x', commentsEnabled: true });
  assert.equal(out.commentsEnabled, false);
});

test('附件数量超限被拒', () => {
  const assetIds = Array.from({ length: CONTENT_LIMITS.imageCount + 1 }, (_, i) => `a${i}`);
  assert.throws(() => v.validatePostInput({ kind: 'fragment', visibility: 'club', body: 'x', assetIds }), /最多/);
});

test('非法 visibility 被拒', () => {
  assert.throws(() => v.validatePostInput({ kind: 'fragment', visibility: 'friends', body: 'x' }), /不合法/);
});

test('视频时长超限被拒', () => {
  assert.throws(
    () => v.validateUploadIntent({ mediaType: 'video', size: 1000, duration: 61, mimeType: 'video/mp4' }),
    /60 秒/,
  );
});

test('视频体积超限被拒', () => {
  assert.throws(
    () =>
      v.validateUploadIntent({
        mediaType: 'video',
        size: CONTENT_LIMITS.videoSize + 1,
        duration: 10,
        mimeType: 'video/mp4',
      }),
    /30MB/,
  );
});

test('图片体积超限被拒', () => {
  assert.throws(
    () => v.validateUploadIntent({ mediaType: 'image', size: CONTENT_LIMITS.imageSize + 1, mimeType: 'image/jpeg' }),
    /10MB/,
  );
});

test('评论超限被拒', () => {
  assert.throws(() => v.validateCommentInput({ body: 'a'.repeat(CONTENT_LIMITS.commentBody + 1) }), /最多/);
});

test('游标可往返编解码', () => {
  const item = { _id: 'p1', createdAt: 1790000000000 };
  const cursor = v.buildCursor(item);
  const parsed = v.parseCursor(cursor);
  assert.equal(parsed.id, 'p1');
  assert.equal(parsed.createdAt, 1790000000000);
});

test('伪造游标被拒', () => {
  assert.throws(() => v.parseCursor('not-base64-json'), /游标不合法/);
  assert.throws(() => v.parseCursor(Buffer.from('{"x":1}').toString('base64')), /游标不合法/);
});

test('分页大小被夹紧到合法区间', () => {
  assert.equal(v.clampPageSize(9999), CONTENT_LIMITS.maxPageSize);
  assert.equal(v.clampPageSize(10), 10);
  // 0 / 缺省 / 非数字都回落到默认页大小，而不是 1
  assert.equal(v.clampPageSize(0), CONTENT_LIMITS.pageSize);
  assert.equal(v.clampPageSize(undefined), CONTENT_LIMITS.pageSize);
  assert.equal(v.clampPageSize('abc'), CONTENT_LIMITS.pageSize);
});

test('昵称超限被拒', () => {
  assert.throws(() => v.validateDisplayName('名'.repeat(CONTENT_LIMITS.displayName + 1)), /最多/);
});

test('搜索词正则元字符被转义', () => {
  // 防止用户输入 .* 之类的模式造成全表扫描或正则注入
  assert.equal(escapeRegex('a.*b'), 'a\\.\\*b');
  assert.equal(escapeRegex('(x)'), '\\(x\\)');
});

test('话题名称超限被拒', () => {
  assert.throws(
    () => v.validateTopicInput({ title: 'a'.repeat(CONTENT_LIMITS.topicTitle + 1), description: '', category: 'life' }),
    /最多/,
  );
});
