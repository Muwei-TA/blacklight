/**
 * 清理任务。
 *
 * 保留策略必须事先告知用户（写进隐私说明），不能无限囤积：
 * - 孤儿附件（有意图/已上传/已审核但 24h 未绑定内容）：删除云存储文件与记录
 * - 已删除内容的附件：先保持 revoked，文件确认删除后才标记 purged
 * - 幂等键：保留 7 天后清理
 * - 注销申请：停止展示后按保留期清理，任何一步失败都保留可重试状态
 */

const { COLLECTIONS, ASSET_STATUS } = require('../shared/constants');
const db = require('../shared/db');
const recovery = require('../recovery');

const ORPHAN_ASSET_TTL = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_TTL = 7 * 24 * 60 * 60 * 1000;
const DELETION_GRACE = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_LEASE_MS = 5 * 60 * 1000;
const RETRYABLE_CLEANUP = 'retryable';
const RUNNING_CLEANUP = 'running';

function safeErrorMessage(error) {
  const message = error && error.message ? String(error.message) : String(error || 'cleanup failed');
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function isNotFoundDeleteResult(item) {
  const text = `${item && item.errMsg ? item.errMsg : ''} ${item && item.message ? item.message : ''}`.toLowerCase();
  return /not.?found|not.?exist|不存在|不存在该文件|file.?id.*invalid/.test(text);
}

/**
 * CloudBase deleteFile returns a per-file result. Treat a missing object as
 * success because a previous invocation may have deleted it before its DB
 * update failed; every other missing/failed result remains retryable.
 */
async function deleteFiles(fileIds) {
  const unique = [...new Set((fileIds || []).filter(Boolean))];
  if (unique.length === 0) return { failed: [], deleted: [] };

  let response;
  try {
    response = await db.getStorage().deleteFile({ fileList: unique });
  } catch (err) {
    return {
      deleted: [],
      failed: unique.map((fileId) => ({ fileId, error: safeErrorMessage(err) })),
    };
  }

  const rows = Array.isArray(response && response.fileList) ? response.fileList : [];
  const byFileId = new Map(rows.map((row) => [row.fileID || row.fileId, row]));
  const deleted = [];
  const failed = [];

  for (const fileId of unique) {
    const row = byFileId.get(fileId);
    const status = row && Number(row.status);
    if (status === 0 || (row && isNotFoundDeleteResult(row))) {
      deleted.push(fileId);
    } else {
      failed.push({
        fileId,
        error: safeErrorMessage((row && (row.errMsg || row.message)) || 'deleteFile returned no success result'),
      });
    }
  }
  return { deleted, failed };
}

function cleanupDue(asset, now = Date.now()) {
  const next = recovery.toMillis(asset && asset.cleanupNextAttemptAt);
  if (next !== null && next > recovery.nowMillis(now)) return false;
  if (asset && asset.cleanupState === RUNNING_CLEANUP) {
    const claimedAt = recovery.toMillis(asset.cleanupClaimedAt);
    if (claimedAt !== null && claimedAt + CLEANUP_LEASE_MS > recovery.nowMillis(now)) return false;
  }
  return true;
}

function cleanupFailureData(asset, error, now = Date.now()) {
  const attempts = (Number(asset && asset.cleanupAttempts) || 0) + 1;
  return {
    cleanupState: RETRYABLE_CLEANUP,
    cleanupAttempts: attempts,
    cleanupLastError: safeErrorMessage(error),
    cleanupNextAttemptAt: new Date(recovery.nowMillis(now) + recovery.retryDelay(attempts)),
    cleanupClaimedAt: null,
    updatedAt: db.serverDate(),
  };
}

function assetExpectedSnapshot(asset) {
  const fields = [
    'status', 'postId', 'cleanupState', 'cleanupClaimedAt', 'cleanupNextAttemptAt',
    'createdAt', 'ownerId', 'fileId', 'cleanedFileId', 'reservedFileId',
  ];
  return Object.fromEntries(fields.map((field) => [
    field,
    Object.hasOwn(asset, field) ? asset[field] : { $missing: true },
  ]));
}

async function cleanupAssetAction(asset, action, expected, patch = {}) {
  return db.getDb().rpc('hg_cleanup_asset', {
    p_club_id: asset.clubId,
    p_asset_id: asset._id,
    p_action: action,
    p_expected: assetExpectedSnapshot(expected),
    p_patch: patch,
  });
}

async function preserveRetryableAsset(asset, error, now = Date.now()) {
  const result = await cleanupAssetAction(
    asset,
    'retry',
    asset,
    cleanupFailureData(asset, error, now),
  );
  return !!(result.stats && result.stats.updated === 1);
}

async function claimCleanupAsset(asset, now = Date.now()) {
  const claimAt = new Date(recovery.nowMillis(now)).toISOString();
  const patch = {
    cleanupState: RUNNING_CLEANUP,
    cleanupClaimedAt: claimAt,
    cleanupLastError: '',
    updatedAt: db.serverDate(),
  };
  const result = await cleanupAssetAction(asset, 'claim', asset, patch);
  return result.stats && result.stats.updated === 1 ? { ...asset, ...patch } : null;
}

function orphanStatuses() {
  return [
    ASSET_STATUS.INTENT,
    ASSET_STATUS.UPLOADED,
    ASSET_STATUS.VERIFYING,
    ASSET_STATUS.VERIFIED,
    ASSET_STATUS.REJECTED,
    ASSET_STATUS.FAILED,
  ];
}

/**
 * 未绑定内容的附件：确认文件删除成功后才删记录。
 * 文件或记录写入失败时保留资产文档，下一轮按 cleanupNextAttemptAt 重试。
 */
async function cleanupOrphanAssets(clubId) {
  if (!clubId) throw new Error('cleanup club is required');
  const _ = db.command();
  const now = Date.now();
  const cutoff = new Date(now - ORPHAN_ASSET_TTL);

  const res = await db
    .coll(COLLECTIONS.assets, clubId)
    .where({
      clubId,
      postId: '',
      createdAt: _.lt(cutoff),
      status: _.in(orphanStatuses()),
    })
    .limit(50)
    .get();

  const assets = (res.data || []).filter((asset) => cleanupDue(asset, now));
  let removed = 0;
  let retryable = 0;
  let skipped = 0;

  for (const asset of assets) {
    // Conditional claim prevents two cleanup invocations from deleting the
    // same file concurrently. A later post binding also makes the final
    // remove condition fail, preserving the record for inspection.
    const claimedAsset = await claimCleanupAsset(asset, now);
    if (!claimedAsset) {
      skipped += 1;
      continue;
    }

    const deletion = await deleteFiles([asset.fileId, asset.cleanedFileId, asset.reservedFileId]);
    if (deletion.failed.length > 0) {
      await preserveRetryableAsset(claimedAsset, new Error(deletion.failed[0].error), now);
      retryable += 1;
      continue;
    }

    const removedResult = await cleanupAssetAction(claimedAsset, 'remove_orphan', claimedAsset);
    if (removedResult.stats && removedResult.stats.removed === 1) {
      removed += 1;
    } else {
      // The file is already gone, but the record still needs a durable retry
      // marker. Do not silently report this as successful cleanup.
      await preserveRetryableAsset(claimedAsset, new Error('asset record removal failed'), now);
      retryable += 1;
    }
  }

  return { removed, retryable, skipped };
}

/**
 * 已删除内容的媒体：文件成功删除前始终保持 revoked，避免把数据库状态
 * 当成物理回收的证明。
 */
async function cleanupDeletedPostAssets(clubId) {
  if (!clubId) throw new Error('cleanup club is required');
  const now = Date.now();
  const res = await db
    .coll(COLLECTIONS.assets, clubId)
    .where({ clubId, status: 'revoked' })
    .limit(50)
    .get();

  const assets = (res.data || []).filter((asset) => cleanupDue(asset, now));
  let purged = 0;
  let retryable = 0;
  let skipped = 0;

  for (const asset of assets) {
    const claimedAsset = await claimCleanupAsset(asset, now);
    if (!claimedAsset) {
      skipped += 1;
      continue;
    }

    const deletion = await deleteFiles([asset.fileId, asset.cleanedFileId, asset.reservedFileId]);
    if (deletion.failed.length > 0) {
      await preserveRetryableAsset(claimedAsset, new Error(deletion.failed[0].error), now);
      retryable += 1;
      continue;
    }

    const updated = await cleanupAssetAction(claimedAsset, 'purge', claimedAsset, {
          fileId: '',
          cleanedFileId: '',
          reservedFileId: '',
          cloudPath: '',
          tempFileURL: '',
          status: 'purged',
          cleanupState: 'done',
          cleanupLastError: '',
          cleanupNextAttemptAt: null,
          cleanupClaimedAt: null,
          purgedAt: db.serverDate(),
          updatedAt: db.serverDate(),
    });
    if (updated.stats && updated.stats.updated === 1) {
      purged += 1;
    } else {
      await preserveRetryableAsset(claimedAsset, new Error('revoked asset state update failed'), now);
      retryable += 1;
    }
  }

  return { purged, retryable, skipped };
}

async function cleanupIdempotency(clubId) {
  if (!clubId) throw new Error('cleanup club is required');
  const _ = db.command();
  const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL);
  const res = await db
    .coll(COLLECTIONS.idempotency, clubId)
    .where({ clubId, createdAt: _.lt(cutoff) })
    .limit(100)
    .get();

  let removed = 0;
  let retryable = 0;
  for (const item of res.data || []) {
    const result = await db.coll(COLLECTIONS.idempotency, clubId).doc(item._id).remove();
    if (result.stats && result.stats.removed === 1) removed += 1;
    else retryable += 1;
  }
  return { removed, retryable };
}

/**
 * 处理注销申请。
 * 先停止展示全部内容，宽限期后再清理个人资料；依法必要保留的记录
 * （如审计日志）不删除，但与身份解除关联。每一步都必须成功，失败
 * 时用户保持 deletion_processing，下一轮继续执行，不能写成已完成。
 */
async function processAccountDeletions(clubIds) {
  if (!Array.isArray(clubIds)) throw new Error('account deletion club list is required');
  const _ = db.command();
  const now = Date.now();
  const cutoff = new Date(now - DELETION_GRACE);
  const due = { $or: [{ deletionNextAttemptAt: null }, { deletionNextAttemptAt: _.lte(new Date(now)) }] };
  const lease = { $or: [{ deletionLeaseUntil: null }, { deletionLeaseUntil: _.lte(new Date(now)) }] };
  const res = await db.coll(COLLECTIONS.users).where({
    status: _.in(['deletion_requested', 'deletion_processing']), deletionRequestedAt: _.lt(cutoff),
    $and: [due, lease],
  }).limit(10).get();
  let processed = 0;
  let retryable = 0;
  for (const user of res.data || []) {
    const leaseId = recovery.createLeaseId('account-deletion');
    const claimed = await db.coll(COLLECTIONS.users).where({ _id: user._id, status: user.status, ...lease }).update({
      data: { status: 'deletion_processing', deletionLeaseId: leaseId, deletionLeaseUntil: new Date(now+CLEANUP_LEASE_MS), deletionStartedAt: db.serverDate() },
    });
    if (!claimed.stats || claimed.stats.updated !== 1) continue;
    try {
      for (const clubId of clubIds) {
        // hg_request_account_deletion already atomically hides posts, revokes
        // owned assets and removes memberships across every club. Keep this
        // loop read/cleanup-only so a paused, unrelated club with zero matches
        // cannot block the global account completion.
        await cleanupDeletedPostAssets(clubId);
        const files = await db.coll(COLLECTIONS.assets, clubId).where({ clubId, ownerId: user._id, status: _.neq('purged') }).count();
        if (files.total) throw new Error('waiting for file deletion confirmation');
      }
      await db.getDb().rpc('hg_finish_account_deletion', { p_user: user._id, p_lease: leaseId });
      processed += 1;
    } catch (err) {
      retryable += 1;
      await db.coll(COLLECTIONS.users).where({ _id: user._id, deletionLeaseId: leaseId }).update({
        data: { deletionLastError: safeErrorMessage(err), deletionNextAttemptAt: new Date(now+60*1000), deletionLeaseUntil: null, deletionLeaseId: '' },
      });
      console.error('[cleanup] account deletion requires retry', { message: safeErrorMessage(err) });
    }
  }
  return { processed, retryable };
}

module.exports = {
  cleanupOrphanAssets,
  cleanupDeletedPostAssets,
  cleanupIdempotency,
  processAccountDeletions,
  deleteFiles,
  cleanupDue,
  ORPHAN_ASSET_TTL,
  IDEMPOTENCY_TTL,
  DELETION_GRACE,
};
