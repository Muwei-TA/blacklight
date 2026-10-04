'use strict';
const { randomUUID } = require('node:crypto');
const db = require('../shared/db');
const errors = require('../shared/errors');
const validators = require('../shared/validators');
const policies = require('../shared/policies');
const anonymity = require('../shared/anonymity');
const { normalizeRichDocument } = require('../shared/rich-document');
const { COLLECTIONS, VISIBILITY } = require('../shared/constants');
function version(value) {
  if (!Number.isInteger(value) || value < 1) throw errors.invalidInput('缺少版本号');
  return value;
}
function assertMember(ctx) { if (ctx.channel !== 'web') throw errors.forbidden({ reason: 'website session required' }); if (!ctx.viewer.isMember) throw errors.membershipInvalid(); }
async function rpc(operation, input, ctx) {
  assertMember(ctx);
  try {
    return await db.getDb().rpc('hg_article_draft', { p_operation: operation, p_actor: ctx.viewer.userId, p_club_id: ctx.viewer.clubId, p_input: input });
  } catch (error) {
    if (/NOT_FOUND/.test(error.message)) throw errors.notAccessible();
    if (/CONFLICT/.test(error.message)) throw errors.conflict('草稿或图片已更新，请重新加载');
    if (/FORBIDDEN/.test(error.message)) throw errors.forbidden();
    if (/INVALID|NOT_AVAILABLE/.test(error.message)) throw errors.invalidInput('标题、正文或发布设置不完整');
    throw error;
  }
}
function mediaUrl(asset, target, type = 'post') {
  return `/v1/web/media/${encodeURIComponent(asset._id)}?${new URLSearchParams({ clubId: asset.clubId, [type === 'draft' ? 'draftId' : 'postId']: target._id, version: String(target.version) })}`;
}
async function presentDraft(d, ctx) {
  const assets = await db.findByIds(COLLECTIONS.assets, d.assetIds || [], ctx.viewer.clubId);
  return {
    id: d._id, version: d.version, status: d.status, format: 'richtext-v1',
    title: d.title || '', summary: d.summary || '', richDoc: d.richDoc, body: d.body || '',
    assetIds: d.assetIds || [], coverAssetId: d.coverAssetId || '', settings: d.settings,
    sourcePostId: d.sourcePostId || '', sourcePostVersion: d.sourcePostVersion || null, updatedAt: d.updatedAt,
    assets: assets.map((a) => ({ assetId: a._id, status: a.status, width: a.width || 0, height: a.height || 0, url: mediaUrl(a, d, 'draft') })),
  };
}
async function get(payload, ctx) { return presentDraft(await rpc('get', { id: validators.requireId(payload.id, 'id') }, ctx), ctx); }
async function list(payload, ctx) {
  const docs = await rpc('list', {}, ctx);
  return { items: await Promise.all(docs.map((d) => presentDraft(d, ctx))), nextCursor: null };
}
function normalizeInput(payload) {
  const settings = payload.settings || {};
  if (Object.keys(settings).some((key) => !['visibility','identityMode','commentsEnabled','topicId','boardId'].includes(key))) throw errors.invalidInput('发布设置不合法');
  if (settings.commentsEnabled !== undefined && typeof settings.commentsEnabled !== 'boolean') throw errors.invalidInput('回应设置不合法');
  if (settings.visibility === VISIBILITY.PRIVATE && (settings.topicId || settings.boardId)) throw errors.invalidInput('仅自己可见的文章不能关联话题或板块');
  const coverAssetId = validators.optionalId(payload.coverAssetId, 'coverAssetId');
  return {
    ...normalizeRichDocument(payload.richDoc, coverAssetId), coverAssetId,
    title: validators.requireString(payload.title, '标题', { max: 60, allowEmpty: true }),
    summary: validators.requireString(payload.summary, '摘要', { max: 300, allowEmpty: true }),
    settings: {
      visibility: validators.requireEnum(settings.visibility || 'club', 'visibility', ['club','private']),
      identityMode: validators.requireEnum(settings.identityMode || 'named', 'identityMode', ['named','anonymous']),
      commentsEnabled: settings.commentsEnabled !== false,
      topicId: validators.optionalId(settings.topicId, 'topicId'),
      boardId: validators.optionalId(settings.boardId, 'boardId'),
    },
  };
}
async function save(payload, ctx) {
  const input = normalizeInput(payload);
  if (payload.id) { input.id = validators.requireId(payload.id, 'id'); input.expectedVersion = version(payload.expectedVersion); }
  if (payload.sourcePostId) {
    input.sourcePostId = validators.requireId(payload.sourcePostId, 'sourcePostId');
    input.sourcePostVersion = version(payload.sourcePostVersion);
  }
  return presentDraft(await rpc('save', input, ctx), ctx);
}
async function remove(payload, ctx) { return rpc('delete', { id: validators.requireId(payload.id, 'id'), expectedVersion: version(payload.expectedVersion) }, ctx); }
async function submit(payload, ctx) {
  if (!policies.canUsePublishing(ctx.viewer, ctx.capabilities)) throw errors.forbidden();
  const id = validators.requireId(payload.id, 'id');
  const d = await rpc('get', { id }, ctx);
  const postId = randomUUID();
  let alias = null;
  if (d.settings.identityMode === 'anonymous') {
    const derived = anonymity.deriveAlias(postId, ctx.viewer.userId, process.env.ANON_ALIAS_SECRET);
    alias = { _id: randomUUID(), clubId: ctx.viewer.clubId, threadId: postId, userId: ctx.viewer.userId, ...derived, isThreadAuthor: true, createdAt: db.serverDate() };
  }
  return rpc('submit', { id, expectedVersion: version(payload.expectedVersion), idempotencyKey: validators.requireString(payload.idempotencyKey, '请求标识', { min: 8, max: 120 }), postId, alias }, ctx);
}
async function resubmit(payload, ctx) {
  if (!policies.canUsePublishing(ctx.viewer, ctx.capabilities)) throw errors.forbidden();
  const id = validators.requireId(payload.draftId, 'draftId');
  const d = await rpc('get', { id }, ctx);
  return rpc('resubmit', { id, expectedVersion: d.version, postId: validators.requireId(payload.id, 'id'), postVersion: version(payload.expectedVersion), idempotencyKey: validators.requireString(payload.idempotencyKey, '请求标识', { min: 8, max: 120 }) }, ctx);
}
module.exports = { get, list, save, remove, submit, resubmit, rpc, mediaUrl, normalizeInput };
