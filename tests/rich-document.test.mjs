import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let normalize;
try { ({ normalizeRichDocument: normalize } = require('../shared/rich-document')); } catch (_) { /* first run */ }
const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
test('rich document projects text and unique assets in document order', () => {
  assert.equal(typeof normalize, 'function');
  const doc = { type: 'doc', content: [paragraph('Hello'), { type: 'assetImage', attrs: { assetId: 'asset-1', alt: '说明', caption: '题注' } }, paragraph('World')] };
  const result = normalize(doc, 'asset-1');
  assert.equal(result.body, 'Hello\n\n说明\n题注\n\nWorld');
  assert.deepEqual(result.assetIds, ['asset-1']);
  assert.deepEqual(result.richDoc, doc);
});
test('rich document rejects executable or arbitrary data and invalid tree shape', () => {
  assert.equal(typeof normalize, 'function');
  for (const doc of [
    { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://x' } }] },
    { type: 'doc', content: [{ type: 'paragraph', attrs: { style: 'x' } }] },
    { type: 'doc', content: [{ type: 'text', text: 'bad' }] },
    { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] },
    { type: 'doc', content: [paragraph('x'.repeat(20001))] },
  ]) assert.throws(() => normalize(doc), /./);
});

test('quarantined media isolates author drafts, current review and published audience', () => {
  const policies = require('../shared/policies');
  const viewer=(userId,role='member',memberStatus='active',clubId='c')=>policies.buildViewer({userId,role,memberStatus,clubId});
  const asset={_id:'a',clubId:'c',ownerId:'author',draftId:'draft',status:'uploaded',fileId:'private/file',postId:'post',postVersion:1};
  const draft={_id:'draft',clubId:'c',ownerId:'author',status:'draft',version:1};
  assert.equal(policies.canReadRichAsset(viewer('author'),asset,draft,{draft:true,version:1}),true);
  assert.equal(policies.canReadRichAsset(viewer('admin','moderator'),asset,draft,{draft:true,version:1}),false);
  assert.equal(policies.canReadRichAsset(viewer('author'),asset,draft,{draft:true,version:2}),false);
  const post={...draft,_id:'post',assetIds:['a'],status:'pending',visibility:'club'};
  assert.equal(policies.canReadRichAsset(viewer('admin','moderator'),asset,post,{version:1,reviewReady:true}),true);
  assert.equal(policies.canReadRichAsset(viewer('admin','moderator'),asset,post,{version:1}),false);
  assert.equal(policies.canReadRichAsset(viewer('reader'),asset,post,{version:1,reviewReady:true}),false);
  assert.equal(policies.canReadRichAsset(viewer('admin','moderator'),asset,{...post,visibility:'private'},{version:1,reviewReady:true}),false);
  const published={...post,status:'published'};
  assert.equal(policies.canReadRichAsset(viewer('reader'),asset,published,{version:1}),false);
  assert.equal(policies.canReadRichAsset(viewer('reader'),{...asset,status:'verified'},published,{version:1}),true);
  assert.equal(policies.canReadRichAsset(viewer('reader','member','active','other'),{...asset,status:'verified'},published,{version:1}),false);
  assert.equal(policies.canReadRichAsset(viewer(null,'guest','none'),{...asset,status:'verified'},{...published,visibility:'public'},{version:1}),true);
});

test('rich drafts reject non-website channels even for active members', async () => {
  const drafts = require('../cloudfunctions/api/domain/drafts');
  await assert.rejects(drafts.rpc('list', {}, { viewer: { userId: 'member', clubId: 'c', isMember: true }, channel: 'client' }), (error) => error.kind === 'forbidden');
});

test('repeated image nodes count toward the nine-image limit while bindings stay unique', () => {
  const repeated = (count) => ({ type: 'doc', content: Array.from({ length: count }, () => ({ type: 'assetImage', attrs: { assetId: 'same-image', alt: '', caption: '' } })) });
  const nine = normalize(repeated(9));
  assert.equal(nine.richDoc.content.length, 9);
  assert.deepEqual(nine.assetIds, ['same-image']);
  assert.throws(() => normalize(repeated(10)), (error) => error.kind === 'invalid_input');
  assert.throws(() => normalize(repeated(100)), (error) => error.kind === 'invalid_input');
  assert.deepEqual(normalize(repeated(9), 'same-image').assetIds, ['same-image']);
  assert.deepEqual(normalize(repeated(8), 'separate-cover').assetIds, ['same-image', 'separate-cover']);
  assert.throws(() => normalize(repeated(9), 'separate-cover'), (error) => error.kind === 'invalid_input');
});
