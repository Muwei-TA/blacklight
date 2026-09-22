/**
 * Internal post-create review runner.
 *
 * Copy this module under cloudfunctions/api/domain/ when synchronising the
 * worker tasks into api/tasks and api/recovery. It is deliberately not an
 * action handler: callers must pass the server-created context object.
 */
const { COLLECTIONS, POST_STATUS, ASSET_STATUS, REVIEW_TASK_STATUS } = require('../shared/constants');
const errors = require('../shared/errors');
const db = require('../shared/db');
const review = require('../tasks/review');
const media = require('../tasks/media');
const recovery = require('../recovery');

const MAX_ATTEMPTS = 5;
const LEASE_MS = recovery.DEFAULT_LEASE_MS || 90 * 1000;

const TARGETS = {
  post: { collection: COLLECTIONS.posts, status: POST_STATUS.PENDING },
  comment: { collection: COLLECTIONS.comments, status: POST_STATUS.PENDING },
  asset: { collection: COLLECTIONS.assets, status: ASSET_STATUS.UPLOADED },
};

function requireViewer(ctx) {
  const viewer = ctx && ctx.viewer;
  if (!viewer || viewer.isAuthenticated !== true || typeof viewer.userId !== 'string' || !viewer.userId) {
    throw errors.unauthenticated();
  }
  return viewer;
}

function getTargetSpec(targetType) {
  const spec = TARGETS[targetType];
  if (!spec) throw errors.invalidInput('审核目标类型不合法', { field: 'targetType' });
  return spec;
}

function dueClause(now, _) {
  return { $or: [
    { nextAttemptAt: _.exists(false) },
    { nextAttemptAt: null },
    { nextAttemptAt: _.lte(new Date(now)) },
  ] };
}

function attemptClause(_) {
  return { $or: [
    { attempts: _.exists(false) },
    { attempts: _.lt(MAX_ATTEMPTS) },
  ] };
}

function versionClause(targetType, target) {
  if (targetType === 'asset') {
    const postVersion = Number(target.postVersion);
    return Number.isInteger(postVersion) && postVersion > 0 ? { postVersion } : {};
  }
  const postVersion = Number(target.version);
  if (!Number.isInteger(postVersion) || postVersion < 1) {
    throw errors.invalidInput('审核目标版本不合法', { field: 'version' });
  }
  return { postVersion };
}

async function readTarget(targetType, targetId, spec, viewer) {
  const target = await db.findOneById(spec.collection, targetId);
  if (!target) throw errors.notAccessible();
  if (target.ownerId !== viewer.userId) throw errors.forbidden({ reason: 'review target owner mismatch' });
  return target;
}

async function findQueuedTask(targetType, targetId, target, now, _) {
  const query = {
    targetType,
    targetId,
    status: REVIEW_TASK_STATUS.QUEUED,
    ...versionClause(targetType, target),
    $and: [dueClause(now, _), attemptClause(_)],
  };
  const result = await db.coll(COLLECTIONS.reviewTasks).where(query).orderBy('createdAt', 'asc').limit(1).get();
  return result.data && result.data[0] ? result.data[0] : null;
}

async function claimTask(task, targetType, target, now, _) {
  const leaseId = recovery.createLeaseId(`foreground-${targetType}`);
  const claimed = await db.coll(COLLECTIONS.reviewTasks).where({
    _id: task._id,
    status: REVIEW_TASK_STATUS.QUEUED,
    ...versionClause(targetType, target),
    $and: [dueClause(now, _), attemptClause(_)],
  }).update({
    data: {
      status: REVIEW_TASK_STATUS.RUNNING,
      ...recovery.buildLeaseFields({ leaseId, now, leaseMs: LEASE_MS }),
    },
  });
  if (!claimed.stats || claimed.stats.updated !== 1) return null;
  return { ...task, status: REVIEW_TASK_STATUS.RUNNING, leaseId };
}

async function updateClaimedTask(task, data) {
  const result = await db.coll(COLLECTIONS.reviewTasks).where({
    _id: task._id,
    status: REVIEW_TASK_STATUS.RUNNING,
    leaseId: task.leaseId,
  }).update({ data });
  return !!(result.stats && result.stats.updated === 1);
}

function invokeTask(targetType, task) {
  if (targetType === 'post') return review.reviewPost(task);
  if (targetType === 'comment') return review.reviewComment(task);
  return media.processAsset(task);
}

function stateFor(targetType, target, result) {
  if (result && result.targetStatus) return result.targetStatus;
  if (targetType === 'asset' && result && result.status === REVIEW_TASK_STATUS.PASSED) return ASSET_STATUS.VERIFIED;
  if (targetType === 'asset' && result && result.status === REVIEW_TASK_STATUS.FAILED) return ASSET_STATUS.REJECTED;
  return target.status;
}

function resultPayload(targetType, targetId, target, task, result, reviewState) {
  return {
    state: stateFor(targetType, target, result),
    targetType,
    targetId,
    reviewTaskId: task ? task._id : '',
    reviewState,
    version: result && Number.isInteger(result.version) ? result.version : target.version,
  };
}

/** Run one review task on behalf of the owner who just created the target. */
async function runOwnedReview(targetType, targetId, ctx) {
  const viewer = requireViewer(ctx);
  const spec = getTargetSpec(targetType);
  const target = await readTarget(targetType, targetId, spec, viewer);
  if (target.status !== spec.status) return resultPayload(targetType, targetId, target, null, null, 'not_applicable');

  const now = Date.now();
  const _ = db.command();
  const queued = await findQueuedTask(targetType, targetId, target, now, _);
  if (!queued) return resultPayload(targetType, targetId, target, null, null, REVIEW_TASK_STATUS.QUEUED);

  const task = await claimTask(queued, targetType, target, now, _);
  if (!task) return resultPayload(targetType, targetId, target, queued, null, 'claim_lost');

  try {
    const result = await invokeTask(targetType, task);
    if (!result || typeof result.status !== 'string') throw new Error('review task returned invalid status');

    // post/comment terminal updates are committed by hg_finish_review. Other
    // outcomes, including every asset result, still need the lease condition.
    if (result.status === REVIEW_TASK_STATUS.QUEUED) {
      await updateClaimedTask(task, recovery.buildWaitingUpdate(result));
    } else if (task.status === REVIEW_TASK_STATUS.RUNNING) {
      await updateClaimedTask(task, recovery.buildTerminalUpdate(result));
    }
    return resultPayload(targetType, targetId, target, task, result, result.status);
  } catch (err) {
    const failure = recovery.buildFailureUpdate(task, err, Date.now(), { maxAttempts: MAX_ATTEMPTS });
    let written = false;
    try { written = await updateClaimedTask(task, failure.update); } catch (_) { written = false; }
    return resultPayload(
      targetType,
      targetId,
      target,
      task,
      null,
      written ? failure.update.status : REVIEW_TASK_STATUS.RUNNING,
    );
  }
}

module.exports = { runOwnedReview, _internals: { MAX_ATTEMPTS, LEASE_MS, dueClause, attemptClause, versionClause } };
