import test from 'node:test';
import assert from 'node:assert/strict';
import * as views from '../web/views.mjs';

test('rich article rendering escapes text and places authorized images in document order', () => {
  assert.equal(typeof views.renderRichDoc, 'function');
  const html = views.renderRichDoc({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '开场 <安全>' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '查看来源', marks: [{ type: 'link', attrs: { href: 'https://example.com/?a=1&b=2' } }] }] },
      { type: 'assetImage', attrs: { assetId: 'asset-1', alt: '河边', caption: '傍晚' } },
      { type: 'paragraph', content: [{ type: 'text', text: '图片之后' }] },
    ],
  }, [{ assetId: 'asset-1', url: '/v1/web/media/asset-1?draft=draft-1' }], 'https://club.example');

  assert.match(html, /<h2>开场 &lt;安全&gt;<\/h2>/);
  assert.match(html, /<a href="https:\/\/example\.com\/\?a=1&amp;b=2" rel="noopener noreferrer">查看来源<\/a>/);
  assert.match(html, /<img src="\/v1\/web\/media\/asset-1\?draft=draft-1" alt="河边" loading="lazy">/);
  assert.ok(html.indexOf('傍晚') < html.indexOf('图片之后'));
  assert.equal((html.match(/<img\b/g) || []).length, 1);
});

test('rich article rendering ignores forged image sources and unsafe link protocols', () => {
  const html = views.renderRichDoc({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '不跳转', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] },
      { type: 'assetImage', attrs: { assetId: 'asset-1', src: 'https://attacker.example/image.jpg', alt: '伪造' } },
    ],
  }, [{ assetId: 'asset-1', url: 'https://attacker.example/image.jpg' }], 'https://club.example');

  assert.match(html, /不跳转/);
  assert.doesNotMatch(html, /javascript:|attacker\.example|<img\b/);
});

test('article reader renders rich image order once and does not append the legacy media projection', () => {
  const html = views.shell({
    account: null,
    clubs: { list: [] },
    clubId: 'club-a',
    session: { club: { name: '文社' }, memberStatus: 'active', role: 'member', capabilities: {} },
    route: { name: 'post', id: 'post-1', query: {} },
    page: {
      post: {
        id: 'post-1', kind: 'article', status: 'published', visibility: 'club', title: '顺序测试', summary: '摘要', body: '第一段\n第二段',
        richDoc: { type: 'doc', content: [
          { type: 'paragraph', content: [{ type: 'text', text: '第一段' }] },
          { type: 'assetImage', attrs: { assetId: 'asset-1', alt: '正文图片', caption: '夹在正文中间' } },
          { type: 'paragraph', content: [{ type: 'text', text: '第二段' }] },
        ] },
        assets: [{ assetId: 'asset-1', status: 'verified', url: '/v1/web/media/asset-1' }],
        media: { images: ['/v1/web/media/asset-1'] },
        author: { displayName: '作者' }, createdAtText: '刚刚', viewer: {}, counters: {}, commentsEnabled: false,
      },
      comments: { items: [] },
    },
    loading: false, error: '', unread: 0,
  });

  assert.ok(html.indexOf('第一段') < html.indexOf('正文图片'));
  assert.ok(html.indexOf('正文图片') < html.indexOf('第二段'));
  assert.equal((html.match(/<img\b/g) || []).length, 1);
});

test('short-note entry stays on the legacy write action and offers the rich article editor separately', () => {
  const html = views.shell({
    account: null,
    clubs: { list: [] },
    clubId: 'club-a',
    session: { club: { name: '文社' }, memberStatus: 'active', role: 'member', capabilities: { publishing: true, uploads: false } },
    route: { name: 'write', id: '', query: {} },
    page: { topics: [], boards: [] },
    loading: false, error: '', unread: 0,
  });

  assert.match(html, /name="body"[^>]+maxlength="2000"/);
  assert.match(html, /href="\/web\/editor\.html">写文章<\/a>/);
  assert.doesNotMatch(html, /name="kind"/);
});
