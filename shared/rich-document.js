'use strict';
const errors = require('./errors');
const validators = require('./validators');
const BLOCKS = ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'horizontalRule', 'assetImage'];
function fail() { throw errors.invalidInput('富文本格式不合法或超出限制', { field: 'richDoc' }); }
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail();
}
function shortText(value, limit) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || [...value].length > limit) fail();
  return value;
}
function normalizeRichDocument(input, coverAssetId = '') {
  if (Buffer.byteLength(JSON.stringify(input) || '') > 256 * 1024) fail();
  let count = 0;
  let imageCount = 0;
  const assets = [];
  function visit(node, allowed, depth = 0) {
    if (++count > 5000 || depth > 12) fail();
    object(node, ['type', 'content', 'attrs', 'text', 'marks']);
    if (!allowed.includes(node.type)) fail();
    const out = { type: node.type };
    if (node.type === 'text') {
      if (node.content !== undefined || node.attrs !== undefined || typeof node.text !== 'string' || !node.text) fail();
      out.text = node.text;
      if (node.marks !== undefined) {
        if (!Array.isArray(node.marks) || node.marks.length > 4) fail();
        const seen = new Set();
        out.marks = node.marks.map((mark) => {
          object(mark, ['type', 'attrs']);
          if (!['bold', 'italic', 'strike', 'link'].includes(mark.type) || seen.has(mark.type)) fail();
          seen.add(mark.type);
          if (mark.type !== 'link') { if (mark.attrs !== undefined) fail(); return { type: mark.type }; }
          object(mark.attrs, ['href']);
          const href = shortText(mark.attrs.href, 2048);
          if (!/^https?:\/\//i.test(href) || [...href].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) fail();
          let url;
          try { url = new URL(href); } catch (_) { fail(); }
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail();
          return { type: 'link', attrs: { href } };
        });
      }
      return { node: out, text: node.text };
    }
    if (node.text !== undefined || node.marks !== undefined) fail();
    if (node.type === 'assetImage') {
      if (++imageCount > 9) fail();
      object(node.attrs, ['assetId', 'alt', 'caption']);
      const assetId = validators.requireId(node.attrs.assetId, 'assetId');
      out.attrs = { assetId, alt: shortText(node.attrs.alt, 300), caption: shortText(node.attrs.caption, 500) };
      if (!assets.includes(assetId)) assets.push(assetId);
      if (node.content !== undefined) fail();
      return { node: out, text: [out.attrs.alt, out.attrs.caption].filter(Boolean).join('\n') };
    }
    if (node.type === 'heading') {
      object(node.attrs, ['level']);
      if (![2, 3].includes(node.attrs.level)) fail();
      out.attrs = { level: node.attrs.level };
    } else if (node.type === 'orderedList' && node.attrs !== undefined) {
      object(node.attrs, ['start']);
      if (!Number.isInteger(node.attrs.start) || node.attrs.start < 1 || node.attrs.start > 10000) fail();
      out.attrs = { start: node.attrs.start };
    } else if (node.attrs !== undefined) fail();
    if (['hardBreak', 'horizontalRule'].includes(node.type)) {
      if (node.content !== undefined) fail();
      return { node: out, text: '\n' };
    }
    const children = node.content || [];
    if (!Array.isArray(children)) fail();
    const inline = ['paragraph', 'heading'].includes(node.type);
    const childTypes = inline ? ['text', 'hardBreak'] : ['bulletList', 'orderedList'].includes(node.type) ? ['listItem'] : BLOCKS;
    if (node.type === 'listItem' && children[0]?.type !== 'paragraph') fail();
    const results = children.map((child) => visit(child, childTypes, depth + 1));
    if (node.content !== undefined) out.content = results.map((result) => result.node);
    return { node: out, text: results.map((result) => result.text).join(inline ? '' : '\n\n') };
  }
  const result = visit(input, ['doc']);
  const body = result.text.trim();
  if ([...body].length > 20000) fail();
  if (coverAssetId) {
    validators.requireId(coverAssetId, 'coverAssetId');
    if (!assets.includes(coverAssetId)) {
      imageCount += 1;
      assets.push(coverAssetId);
    }
  }
  if (imageCount > 9) fail();
  return { richDoc: result.node, body, assetIds: assets, format: 'richtext-v1' };
}
module.exports = { normalizeRichDocument };
