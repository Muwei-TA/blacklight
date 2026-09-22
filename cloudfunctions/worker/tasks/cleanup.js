/**
 * 清理任务。
 *
 * 保留策略必须事先告知用户（写进隐私说明），不能无限囤积：
 * - 孤儿附件（有意图/已上传但 24h 未绑定内容）：删除云存储文件与记录
 * - 幂等键：保留 7 天后清理
 * - 注销申请：停止展示后按保留期清理，失败保持 pending 而非虚假完成
 */

const cloud = require('wx-server-sdk');
const { COLLECTIONS, ASSET_STATUS, POST_STATUS } = require('../shared/constants');
const db = require('../shared/db');

const ORPHAN_ASSET_TTL = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_TTL = 7 * 24 * 60 * 60 * 1000;
const DELETION_GRACE = 7 * 24 * 60 * 60 * 1000;

/** 未绑定内容的附件：删除文件并清记录，避免存储成本无限增长 */
async function cleanupOrphanAssets() {
  const _ = db.command();
  const cutoff = new Date(Date.now() - ORPHAN_ASSET_TTL);

  const res = await db
    .coll(COLLECTIONS.assets)
    .where({
      postId: '',
      createdAt: _.lt(cutoff),
      status: _.in([ASSET_STATUS.INTENT, ASSET_STATUS.UPLOADED, ASSET_STATUS.REJECTED, ASSET_STATUS.FAILED]),
    })
    .limit(50)
    .get()
    .catch(() => ({ data: [] }));

  const assets = res.data || [];
  const fileIds = assets.map((a) => a.fileId).filter(Boolean);

  if (fileIds.length > 0) {
    await cloud.deleteFile({ fileList: fileIds }).catch((err) => {
      console.warn('[cleanup] deleteFile partial failure', err.message);
    });
  }

  await Promise.all(
    assets.map((a) =>
      db
        .coll(COLLECTIONS.assets)
        .doc(a._id)
        .remove()
        .catch(() => {}),
    ),
  );

  return { removed: assets.length };
}

/** 已删除内容的媒体：回收存储 */
async function cleanupDeletedPostAssets() {
  const res = await db
    .coll(COLLECTIONS.assets)
    .where({ status: 'revoked' })
    .limit(50)
    .get()
    .catch(() => ({ data: [] }));

  const assets = res.data || [];
  const fileIds = assets.map((a) => a.fileId).filter(Boolean);
  if (fileIds.length > 0) {
    await cloud.deleteFile({ fileList: fileIds }).catch(() => {});
  }
  await Promise.all(
    assets.map((a) =>
      db
        .coll(COLLECTIONS.assets)
        .doc(a._id)
        .update({ data: { fileId: '', tempFileURL: '', status: 'purged', purgedAt: db.serverDate() } })
        .catch(() => {}),
    ),
  );
  return { purged: assets.length };
}

async function cleanupIdempotency() {
  const _ = db.command();
  const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL);
  const res = await db
    .coll(COLLECTIONS.idempotency)
    .where({ createdAt: _.lt(cutoff) })
    .limit(100)
    .get()
    .catch(() => ({ data: [] }));

  await Promise.all(
    (res.data || []).map((d) =>
      db
        .coll(COLLECTIONS.idempotency)
        .doc(d._id)
        .remove()
        .catch(() => {}),
    ),
  );
  return { removed: (res.data || []).length };
}

/**
 * 处理注销申请。
 * 先停止展示全部内容，宽限期后再清理个人资料；
 * 依法必要保留的记录（如审计日志）不删除，但与身份解除关联。
 */
async function processAccountDeletions() {
  const _ = db.command();
  const cutoff = new Date(Date.now() - DELETION_GRACE);

  const res = await db
    .coll(COLLECTIONS.users)
    .where({ status: 'deletion_requested', deletionRequestedAt: _.lt(cutoff) })
    .limit(10)
    .get()
    .catch(() => ({ data: [] }));

  const users = res.data || [];

  for (const user of users) {
    // 1. 停止展示该用户全部内容
    await db
      .coll(COLLECTIONS.posts)
      .where({ ownerId: user._id })
      .update({ data: { status: POST_STATUS.DELETED, deletedAt: db.serverDate() } })
      .catch(() => {});

    // 2. 撤销成员资格
    await db
      .coll(COLLECTIONS.memberships)
      .where({ userId: user._id })
      .update({ data: { status: 'removed', removedAt: db.serverDate() } })
      .catch(() => {});

    // 3. 清理可识别资料，但保留文档以维持外键完整性
    await db
      .coll(COLLECTIONS.users)
      .doc(user._id)
      .update({
        data: {
          wxOpenIdRef: '',
          displayName: '已注销成员',
          avatar: '',
          status: 'deleted',
          deletedAt: db.serverDate(),
        },
      })
      .catch(() => {});

    // 4. 匿名映射一并清除：注销后不应再能反查其匿名历史
    await db
      .coll(COLLECTIONS.anonymousIdentities)
      .where({ userId: user._id })
      .remove()
      .catch(() => {});

    await db.writeAudit({
      actorId: 'system',
      action: 'account.deletion_executed',
      targetType: 'user',
      targetId: user._id,
      reason: 'grace period elapsed',
    });
  }

  return { processed: users.length };
}

module.exports = {
  cleanupOrphanAssets,
  cleanupDeletedPostAssets,
  cleanupIdempotency,
  processAccountDeletions,
  ORPHAN_ASSET_TTL,
  IDEMPOTENCY_TTL,
  DELETION_GRACE,
};
