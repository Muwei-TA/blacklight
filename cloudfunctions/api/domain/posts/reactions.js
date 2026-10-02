/** 内容共鸣与收藏关系。 */
const { COLLECTIONS } = require('../../shared/constants');
const policies = require('../../shared/policies');
const validators = require('../../shared/validators');
const errors = require('../../shared/errors');
const db = require('../../shared/db');

/** PUT/DELETE /posts/{id}/reaction —— 幂等开关 */
async function toggleReaction(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  const id = validators.requireId(payload.id, 'id');
  const next = payload.next === true;
  const post = await db.findOneById(COLLECTIONS.posts, id, clubId);
  if (!policies.canInteract(ctx.viewer, post)) throw errors.notAccessible({ postId: id });
  return persistReaction(ctx.viewer.userId, id, null, next, clubId);
}

/** 关系与计数由同一事务维护；失败不得降级为非原子写入。 */
async function persistReaction(userId, postId, commentId, next, clubId) {
  try {
    return await db.getDb().rpc('hg_toggle_reaction', {
      p_actor_id: userId, p_post_id: postId, p_comment_id: commentId, p_next: next, p_club_id: clubId,
    });
  } catch (err) {
    if (/REACTION_TARGET_CHANGED/.test(err.message)) throw errors.notAccessible({ postId });
    if (/XP_MEMBERSHIP_BUSY|55P03/.test(`${err.code || ''} ${err.message || ''}`)) {
      throw errors.conflict('成员状态正在变更，请稍后重试');
    }
    throw err;
  }
}

/** PUT/DELETE /posts/{id}/bookmark */
async function toggleBookmark(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  const id = validators.requireId(payload.id, 'id');
  const next = payload.next === true;

  const docId = `${ctx.viewer.userId}:${id}`;
  const [post, existing] = await Promise.all([
    db.findOneById(COLLECTIONS.posts, id, clubId),
    db.findOneById(COLLECTIONS.bookmarks, docId, clubId),
  ]);
  if (!policies.canInteract(ctx.viewer, post)) throw errors.notAccessible({ postId: id });

  if (next && !existing) {
    await db.coll(COLLECTIONS.bookmarks, clubId)
      .add({
        data: { _id: docId, userId: ctx.viewer.userId, clubId, postId: id, createdAt: db.serverDate() },
      })
      .catch((err) => {
        // 并发双击撞唯一 _id：视为已收藏，幂等成功
        if (!/23505|duplicate key/i.test(`${err.code || ''} ${err.message || ''}`)) throw err;
      });
  } else if (!next && existing) {
    await db.coll(COLLECTIONS.bookmarks, clubId).doc(docId).remove();
  }

  return { ok: true };
}

module.exports = { toggleReaction, persistReaction, toggleBookmark };
