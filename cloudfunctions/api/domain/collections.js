/**
 * 文集领域用例。
 *
 * 两条不可违反的规则：
 * 1. 收录需要作者单独授权（Consent），且授权与「用途 + 版本」绑定；
 * 2. 文集受众不得超过原文受众（取交集）—— 编辑不能靠收录把社内帖变公开。
 */

const { COLLECTIONS, VISIBILITY, NOTIFY_TYPE, DEFAULT_CLUB_ID } = require('../shared/constants');
const policies = require('../shared/policies');
const validators = require('../shared/validators');
const presenters = require('../shared/presenters');
const errors = require('../shared/errors');
const db = require('../shared/db');

/** GET /collections */
async function list(payload, ctx) {
  const _ = db.command();
  const where = { clubId: DEFAULT_CLUB_ID };
  if (!ctx.viewer.isMember) where.visibility = VISIBILITY.PUBLIC;
  else where.visibility = _.in([VISIBILITY.PUBLIC, VISIBILITY.CLUB]);

  const res = await db.coll(COLLECTIONS.collections).where(where).orderBy('order', 'asc').limit(30).get();
  return { items: (res.data || []).map(presenters.presentCollection) };
}

/**
 * GET /collections/{id} —— 目录。
 * 文章状态实时读取，不做正文快照，避免绕过原文权限。
 */
async function detail(payload, ctx) {
  const id = validators.requireId(payload.id, 'id');
  const collection = await db.findOneById(COLLECTIONS.collections, id);
  if (!policies.canReadCollection(ctx.viewer, collection)) throw errors.notAccessible({ collectionId: id });

  const entriesRes = await db
    .coll(COLLECTIONS.collectionEntries)
    .where({ collectionId: id })
    .orderBy('order', 'asc')
    .limit(100)
    .get()
    .catch(() => ({ data: [] }));

  const entries = entriesRes.data || [];
  const posts = await db.findByIds(
    COLLECTIONS.posts,
    entries.map((e) => e.postId),
  );
  const postById = new Map(posts.map((p) => [p._id, p]));

  const users = await db.findByIds(
    COLLECTIONS.users,
    posts.filter((p) => p.identityMode === 'named').map((p) => p.ownerId),
  );
  const userById = new Map(users.map((u) => [u._id, u]));

  // 逐条复核：作者缩小范围或撤回授权后，目录同步不再展示
  const visible = entries
    .map((entry) => {
      const post = postById.get(entry.postId);
      if (!post) return null;
      if (!policies.canListPost(ctx.viewer, post)) return null;
      if (!policies.canIncludeInCollection(collection, post)) return null;
      return {
        order: entry.order,
        postId: post._id,
        title: post.title,
        authorText:
          post.identityMode === 'named'
            ? (userById.get(post.ownerId) || {}).displayName || '社内成员'
            : '树洞身份',
        dateText: presenters.formatRelativeTime(post.createdAt, ctx.now),
      };
    })
    .filter(Boolean);

  return {
    collection: presenters.presentCollection(collection),
    entries: visible,
    canSubmit: ctx.viewer.isMember && ctx.capabilities.anthology,
  };
}

/**
 * POST /collections/{id}/submissions —— 投稿申请。
 * 只创建申请与授权记录，不自动收录：安全审核通过 ≠ 被文集选中。
 */
async function submit(payload, ctx) {
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  if (!ctx.capabilities.anthology) throw errors.forbidden({ reason: 'anthology capability disabled' });

  const collectionId = validators.requireId(payload.id, 'id');
  const postId = validators.requireId(payload.postId, 'postId');
  const consentVersion = validators.requireString(payload.consentVersion, '授权版本', { max: 20 });

  const [collection, post] = await Promise.all([
    db.findOneById(COLLECTIONS.collections, collectionId),
    db.findOneById(COLLECTIONS.posts, postId),
  ]);

  if (!policies.canReadCollection(ctx.viewer, collection)) throw errors.notAccessible({ collectionId });
  if (!policies.canReadPost(ctx.viewer, post)) throw errors.notAccessible({ postId });
  if (!policies.isOwner(ctx.viewer, post)) throw errors.forbidden({ reason: 'only author can submit' });

  // 范围取交集：公开文集不接收社内原帖
  if (!policies.canIncludeInCollection(collection, post)) {
    throw errors.invalidInput('这篇文章的可见范围小于文集范围，需要另建一篇符合受众的文章', {
      field: 'postId',
    });
  }

  // 授权与用途、版本绑定；不写"永久不可撤销"的笼统同意
  await db.coll(COLLECTIONS.consents).add({
    data: {
      _id: `${postId}:collection:${collectionId}`,
      postId,
      collectionId,
      ownerId: ctx.viewer.userId,
      version: consentVersion,
      purpose: 'collection_display',
      scope: collection.visibility,
      grantedAt: db.serverDate(),
      revokedAt: null,
    },
  }).catch(() => {});

  await db.coll(COLLECTIONS.reviewTasks).add({
    data: {
      targetType: 'collection_submission',
      targetId: postId,
      collectionId,
      status: 'queued',
      attempts: 0,
      createdAt: db.serverDate(),
    },
  });

  return { state: 'submitted' };
}

/**
 * DELETE /consents/{postId} —— 撤回授权。
 * 立即从目录移除；已缓存截图无法收回，需在 UI 中明确告知。
 */
async function revokeConsent(payload, ctx) {
  if (!ctx.viewer.isAuthenticated) throw errors.unauthenticated();
  const postId = validators.requireId(payload.postId, 'postId');

  const post = await db.findOneById(COLLECTIONS.posts, postId);
  if (!post) throw errors.notAccessible({ postId });
  if (!policies.isOwner(ctx.viewer, post)) throw errors.forbidden({ reason: 'not owner' });

  await db
    .coll(COLLECTIONS.consents)
    .where({ postId, ownerId: ctx.viewer.userId })
    .update({ data: { revokedAt: db.serverDate() } })
    .catch(() => {});

  await db
    .coll(COLLECTIONS.collectionEntries)
    .where({ postId })
    .remove()
    .catch(() => {});

  await db.writeAudit({
    actorId: ctx.viewer.userId,
    action: 'consent.revoke',
    targetType: 'post',
    targetId: postId,
  });

  await db.coll(COLLECTIONS.notifications).add({
    data: {
      recipientId: ctx.viewer.userId,
      eventType: NOTIFY_TYPE.SYSTEM_COLLECTION,
      title: '已撤回文集授权',
      summary: '这篇文章已从文集目录移除。已经保存的截图无法追回。',
      targetType: 'post',
      targetId: postId,
      icon: 'book-open',
      createdAt: db.serverDate(),
    },
  });

  return { ok: true };
}

module.exports = { list, detail, submit, revokeConsent };
