/**
 * worker 云函数：定时触发的后台任务。
 *
 * 触发方式：CloudBase 定时触发器（见 cloudbaserc.json），每分钟一次。
 * 也可由 api 在关键写入后主动调用以缩短延迟（可选优化，非必须）。
 *
 * 设计原则：
 * 1. 每个任务都可重试，且有最终失败状态与人工处理入口 —— 不允许静默丢弃；
 * 2. 审核服务异常时内容保持不可公开，绝不"为了体验先发出去"；
 * 3. 所有任务共享 shared/policies 的权限规则，不各自复制一份判断。
 */

const { COLLECTIONS, REVIEW_TASK_STATUS } = require('./shared/constants');
const db = require('./shared/db');
const { scrubForLog } = require('./shared/anonymity');

const reviewTasks = require('./tasks/review');
const mediaTasks = require('./tasks/media');
const cleanupTasks = require('./tasks/cleanup');
const digestTasks = require('./tasks/digest');
const recovery = require('./recovery');

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 10;
const LEASE_MS = recovery.DEFAULT_LEASE_MS;
const TIMER_SOURCE = 'wx_trigger';

function readWXContext(cloud) {
  try {
    return (cloud && typeof cloud.getWXContext === 'function' && cloud.getWXContext()) || {};
  } catch (err) {
    return { sourceError: err.message || 'getWXContext failed' };
  }
}

/**
 * Timer/console event fields are input data and are never an authentication
 * signal.  SOURCE comes from wx-server-sdk's invocation context; the actual
 * cloud function invocation permission still needs to be restricted in the
 * CloudBase console and is recorded as an untested deployment boundary.
 */
function verifyWorkerSource(cloud, event = {}) {
  const wxContext = readWXContext(cloud);
  const source = wxContext.SOURCE || '';
  return {
    ok: source === TIMER_SOURCE,
    source,
    hasOpenId: !!wxContext.OPENID,
    eventType: typeof event.Type === 'string' ? event.Type : '',
    triggerName: typeof event.TriggerName === 'string' ? event.TriggerName : '',
    sourceError: wxContext.sourceError || '',
  };
}

function taskLeaseCondition(task, now, _) {
  const condition = { _id: task._id, status: task.status };
  const attempts = Number(task.attempts);
  if (Number.isFinite(attempts)) {
    condition.attempts = task.status === REVIEW_TASK_STATUS.RUNNING && attempts >= MAX_ATTEMPTS
      ? _.gte(MAX_ATTEMPTS)
      : _.lt(MAX_ATTEMPTS);
  }

  if (task.status === REVIEW_TASK_STATUS.QUEUED) {
    // Keep the due check in the conditional update as well as in the read
    // filter. This prevents a stale worker from claiming a newly deferred
    // task after another worker has written nextAttemptAt.
    if (task.nextAttemptAt === undefined || task.nextAttemptAt === null) {
      condition.nextAttemptAt = _.exists(false);
    } else {
      condition.nextAttemptAt = _.lte(new Date(now));
    }
    return condition;
  }

  // A running task can only be reclaimed when its same old lease is expired.
  // Legacy running tasks have no leaseId/leaseExpiresAt; claimedAt is used as
  // a bounded migration path so they cannot remain stuck forever.
  if (task.leaseId !== undefined && task.leaseId !== null && task.leaseId !== '') condition.leaseId = task.leaseId;
  else if (task.leaseId === null) condition.leaseId = null;
  else condition.leaseId = _.exists(false);

  if (task.leaseExpiresAt !== undefined && task.leaseExpiresAt !== null) {
    condition.leaseExpiresAt = _.lt(new Date(now));
  } else {
    condition.leaseExpiresAt = task.leaseExpiresAt === null ? null : _.exists(false);
    if (task.claimedAt) condition.claimedAt = _.lt(new Date(now - LEASE_MS));
    else condition.claimedAt = _.exists(false);
  }
  return condition;
}

function taskOwnerCondition(task) {
  return {
    _id: task._id,
    status: REVIEW_TASK_STATUS.RUNNING,
    leaseId: task.leaseId,
  };
}

async function conditionalTaskUpdate(task, data) {
  const result = await db
    .coll(COLLECTIONS.reviewTasks)
    .where(taskOwnerCondition(task))
    .update({ data });
  return !!(result.stats && result.stats.updated === 1);
}

async function recoverExhaustedTask(task, now, _) {
  const condition = taskLeaseCondition(task, now, _);
  const result = await db
    .coll(COLLECTIONS.reviewTasks)
    .where(condition)
    .update({
      data: {
        status: REVIEW_TASK_STATUS.MANUAL,
        note: 'retry limit reached; manual review required',
        waitingReason: '',
        nextAttemptAt: null,
        finishedAt: new Date(now),
        leaseId: '',
        claimedAt: null,
        leaseExpiresAt: null,
      },
    });
  return !!(result.stats && result.stats.updated === 1);
}

/** 取一批待处理任务，抢占式标记为 running 避免重复执行 */
async function claimTasks(limit = BATCH_SIZE, {
  now = Date.now(),
  invocationId = 'worker',
  stats = {},
} = {}) {
  const _ = db.command();
  const res = await db
    .coll(COLLECTIONS.reviewTasks)
    .where({ status: _.in([REVIEW_TASK_STATUS.QUEUED, REVIEW_TASK_STATUS.RUNNING]) })
    .orderBy('createdAt', 'asc')
    // Read a little more than the requested batch because deferred queued
    // tasks and live running leases may be ahead of work that is actually due.
    .limit(Math.max(limit * 4, limit))
    .get();

  const tasks = (res.data || []).filter((task) => {
    const attempts = Number(task.attempts) || 0;
    if (task.status === REVIEW_TASK_STATUS.QUEUED) return attempts < MAX_ATTEMPTS && recovery.isTaskDue(task, now);
    return recovery.isLeaseExpired(task, now, LEASE_MS);
  });
  const claimed = [];

  for (const task of tasks) {
    if ((Number(task.attempts) || 0) >= MAX_ATTEMPTS) {
      // This covers a task left running by a timed-out legacy worker after it
      // had already used all failure attempts. It must become visible to the
      // manual queue instead of remaining permanently running.
      if (await recoverExhaustedTask(task, now, _)) stats.recovered = (stats.recovered || 0) + 1;
      continue;
    }

    const leaseId = recovery.createLeaseId(invocationId);
    // 乐观抢占：只有把 queued 改成 running 成功的实例才处理该任务。
    // 过期 running 任务也必须匹配同一旧 lease，避免两个实例重复生效。
    const upd = await db
      .coll(COLLECTIONS.reviewTasks)
      .where(taskLeaseCondition(task, recovery.nowMillis(now), _))
      .update({
        data: {
          status: REVIEW_TASK_STATUS.RUNNING,
          ...recovery.buildLeaseFields({ leaseId, now, leaseMs: LEASE_MS }),
        },
      });

    if (upd.stats && upd.stats.updated === 1) {
      claimed.push({ ...task, status: REVIEW_TASK_STATUS.RUNNING, leaseId });
    }
  }

  return claimed;
}

async function runTask(task) {
  switch (task.targetType) {
    case 'post':
      return reviewTasks.reviewPost(task);
    case 'comment':
      return reviewTasks.reviewComment(task);
    case 'asset':
      return mediaTasks.processAsset(task);
    case 'collection_submission':
      // 文集收录由人工编辑决定，worker 只确认原文仍合法可用
      return reviewTasks.precheckCollectionSubmission(task);
    default:
      return { status: REVIEW_TASK_STATUS.MANUAL, note: `unknown targetType: ${task.targetType}` };
  }
}

exports.main = async (event = {}, context = {}) => {
  let cloud;
  try {
    cloud = db.getCloud();
  } catch (err) {
    console.error('[worker] cloud init failed', err.message);
    return { code: 'server', data: { claimed: 0, done: 0, failed: 1, manual: 0 } };
  }

  const source = verifyWorkerSource(cloud, event);
  if (!source.ok) {
    // Type/TriggerName are logged for diagnosis only. They are ordinary event
    // fields and must never be used as proof that this was a timer invocation.
    console.warn('[worker] rejected invocation source', {
      source: source.source,
      hasOpenId: source.hasOpenId,
      eventType: source.eventType,
      triggerName: source.triggerName,
      sourceError: source.sourceError,
      cloudPermissionVerified: false,
    });
    return { code: 'forbidden' };
  }
  console.log('[worker] invocation source accepted', {
    source: source.source,
    eventType: source.eventType,
    triggerName: source.triggerName,
    cloudPermissionVerified: false,
  });

  const mode = event.mode || 'all';
  const requestedLimit = Number(event.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 50)
    : BATCH_SIZE;
  const summary = {
    claimed: 0,
    done: 0,
    failed: 0,
    manual: 0,
    waiting: 0,
    stale: 0,
    recovered: 0,
    source: source.source,
  };

  if (mode === 'all' || mode === 'review') {
    const claimStats = {};
    const invocationId = context.requestId || context.request_id || 'worker';
    const tasks = await claimTasks(limit, { invocationId, stats: claimStats });
    summary.claimed = tasks.length;
    summary.recovered = claimStats.recovered || 0;

    for (const task of tasks) {
      try {
        const result = await runTask(task);
        if (!result || typeof result.status !== 'string') throw new Error('task returned invalid status');

        const update = recovery.isWaitingResult(result)
          ? recovery.buildWaitingUpdate(result)
          : recovery.buildTerminalUpdate(result);
        const updated = await conditionalTaskUpdate(task, update);
        if (!updated) {
          summary.stale += 1;
          console.warn('[worker] task lease lost before result write', scrubForLog({ taskId: task._id }));
        } else if (recovery.isWaitingResult(result)) {
          // Waiting for an asset/callback/editor is not a failed execution and
          // therefore does not increase attempts.
          summary.waiting += 1;
        } else if (result.status === REVIEW_TASK_STATUS.MANUAL) summary.manual += 1;
        else summary.done += 1;
      } catch (err) {
        summary.failed += 1;
        const failure = recovery.buildFailureUpdate(task, err);
        try {
          const updated = await conditionalTaskUpdate(task, failure.update);
          if (!updated) {
            summary.stale += 1;
          } else if (failure.exhausted) {
            summary.manual += 1;
          }
        } catch (updateErr) {
          // The lease remains owned by this invocation if the failure write
          // itself failed. Keeping the task running lets lease recovery retry
          // it; never claim a failed state was persisted.
          console.error('[worker] task failure state write failed', scrubForLog({
            taskId: task._id,
            message: updateErr.message,
          }));
        }

        console.error('[worker] task failed', scrubForLog({
          taskId: task._id,
          message: err.message,
          attempts: failure.attempts,
          exhausted: failure.exhausted,
        }));
      }
    }
  }

  if (mode === 'all' || mode === 'digest') {
    // 共鸣聚合：避免一人连点造成通知刷屏
    await digestTasks.buildReactionDigests().catch((err) => console.error('[worker] digest', err.message));
  }

  if (mode === 'all' || mode === 'cleanup') {
    // 孤儿附件、已删除内容媒体与过期幂等键清理，按已告知的保留策略执行
    await cleanupTasks.cleanupOrphanAssets().catch((err) => console.error('[worker] cleanup assets', err.message));
    await cleanupTasks.cleanupDeletedPostAssets().catch((err) => console.error('[worker] cleanup deleted assets', err.message));
    await cleanupTasks.cleanupIdempotency().catch((err) => console.error('[worker] cleanup idem', err.message));
    await cleanupTasks.processAccountDeletions().catch((err) => console.error('[worker] deletion', err.message));
  }

  console.log('[worker] summary', summary);
  return { code: 0, data: summary };
};

module.exports._internals = {
  MAX_ATTEMPTS,
  BATCH_SIZE,
  LEASE_MS,
  taskLeaseCondition,
  taskOwnerCondition,
  verifyWorkerSource,
  recovery,
};
