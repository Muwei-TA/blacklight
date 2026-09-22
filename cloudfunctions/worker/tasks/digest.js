/**
 * 共鸣聚合任务。
 *
 * 目的：把"3 人对你的《…》表示共鸣"合成一条通知，
 * 避免一人连点造成刷屏（docs/08 P08）。
 *
 * 注意：聚合文案不含共鸣者名单 —— 点赞名单本身也是身份线索。
 */

const { COLLECTIONS, NOTIFY_TYPE, POST_STATUS } = require('../shared/constants');
const db = require('../shared/db');

const WINDOW_MS = 6 * 60 * 60 * 1000; // 6 小时聚合窗口

async function buildReactionDigests() {
  const _ = db.command();
  const since = new Date(Date.now() - WINDOW_MS);

  const res = await db
    .coll(COLLECTIONS.reactions)
    .where({ createdAt: _.gte(since), digested: _.neq(true) })
    .limit(200)
    .get()
    .catch(() => ({ data: [] }));

  const reactions = res.data || [];
  if (reactions.length === 0) return { created: 0 };

  // 按帖子分组统计
  const byPost = new Map();
  for (const r of reactions) {
    if (!byPost.has(r.postId)) byPost.set(r.postId, []);
    byPost.get(r.postId).push(r);
  }

  const posts = await db.findByIds(COLLECTIONS.posts, [...byPost.keys()]);
  const postById = new Map(posts.map((p) => [p._id, p]));
  let created = 0;

  for (const [postId, group] of byPost.entries()) {
    const post = postById.get(postId);
    if (!post || post.status !== POST_STATUS.PUBLISHED) continue;

    // 去重到人，且排除作者本人
    const distinctUsers = new Set(group.map((r) => r.userId).filter((uid) => uid !== post.ownerId));
    if (distinctUsers.size === 0) {
      await markDigested(group);
      continue;
    }

    const label = post.title ? `《${post.title}》` : '你的碎片';
    await db.coll(COLLECTIONS.notifications).add({
      data: {
        recipientId: post.ownerId,
        eventType: NOTIFY_TYPE.REACTION_DIGEST,
        title: `${distinctUsers.size} 人对${label}表示共鸣`,
        // 不列出具体是谁
        summary: '',
        targetType: 'post',
        targetId: postId,
        icon: 'heart',
        createdAt: db.serverDate(),
      },
    });

    await markDigested(group);
    created += 1;
  }

  return { created };
}

async function markDigested(reactions) {
  await Promise.all(
    reactions.map((r) =>
      db
        .coll(COLLECTIONS.reactions)
        .doc(r._id)
        .update({ data: { digested: true } })
        .catch(() => {}),
    ),
  );
}

module.exports = { buildReactionDigests, WINDOW_MS };
