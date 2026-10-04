import { escapeHtml } from './core.mjs';

const MAX_DEPTH = 16;
const MAX_NODES = 4000;

function safeLink(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function authorizedMediaUrl(value, origin = globalThis.location?.origin || '') {
  if (typeof value !== 'string' || !value || value.startsWith('//')) return '';
  try {
    const url = new URL(value, origin || 'http://localhost');
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== (origin || 'http://localhost')) return '';
    if (!url.pathname.startsWith('/v1/web/media/')) return '';
    return `${url.pathname}${url.search}`;
  } catch { return ''; }
}

function assetIndex(assets = []) {
  return new Map((Array.isArray(assets) ? assets : []).filter((asset) => asset && typeof asset.assetId === 'string').map((asset) => [asset.assetId, asset]));
}

function markText(text, marks) {
  let result = escapeHtml(text);
  if (!Array.isArray(marks)) return result;
  for (const mark of marks) {
    if (mark?.type === 'bold') result = `<strong>${result}</strong>`;
    else if (mark?.type === 'italic') result = `<em>${result}</em>`;
    else if (mark?.type === 'strike') result = `<s>${result}</s>`;
    else if (mark?.type === 'link') {
      const href = safeLink(mark.attrs?.href);
      if (href) result = `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${result}</a>`;
    }
  }
  return result;
}

function renderAsset(node, assets, origin) {
  const attrs = node.attrs || {};
  const asset = typeof attrs.assetId === 'string' ? assets.get(attrs.assetId) : null;
  const src = authorizedMediaUrl(asset?.url, origin);
  if (!src) return '';
  const alt = escapeHtml(typeof attrs.alt === 'string' ? attrs.alt : '');
  const caption = typeof attrs.caption === 'string' ? attrs.caption : '';
  return `<figure class="rich-document__image"><img src="${escapeHtml(src)}" alt="${alt}" loading="lazy">${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>`;
}

function renderNode(node, assets, origin, depth, budget) {
  budget.count += 1;
  if (!node || typeof node !== 'object' || budget.count > MAX_NODES || depth > MAX_DEPTH) return '';
  if (node.type === 'text') return markText(typeof node.text === 'string' ? node.text : '', node.marks);
  if (node.type === 'assetImage') return renderAsset(node, assets, origin);
  if (node.type === 'horizontalRule') return '<hr>';
  if (node.type === 'hardBreak') return '<br>';

  const children = Array.isArray(node.content) ? node.content.map((child) => renderNode(child, assets, origin, depth + 1, budget)).join('') : '';
  switch (node.type) {
    case 'doc': return children;
    case 'paragraph': return `<p>${children}</p>`;
    case 'heading': return [2, 3].includes(node.attrs?.level) ? `<h${node.attrs.level}>${children}</h${node.attrs.level}>` : '';
    case 'blockquote': return `<blockquote>${children}</blockquote>`;
    case 'bulletList': return `<ul>${children}</ul>`;
    case 'orderedList': return `<ol>${children}</ol>`;
    case 'listItem': return `<li>${children}</li>`;
    default: return '';
  }
}

export function renderRichDoc(richDoc, assets = [], origin = globalThis.location?.origin || '') {
  if (!richDoc || richDoc.type !== 'doc' || !Array.isArray(richDoc.content)) return '';
  return renderNode(richDoc, assetIndex(assets), origin, 0, { count: 0 });
}
