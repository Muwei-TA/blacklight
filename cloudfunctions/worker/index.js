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
const usageTasks = require('./tasks/usage');
const recovery = require('./recovery');

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 10;
const LEASE_MS = recovery.DEFAULT_LEASE_MS;

function readWXContext(cloud) {
  try {
    return (cloud && typeof cloud.getWXContext === 'function' && cloud.getWXContext()) || {};
  } catch (err) {
    return { sourceError: err.message || 'getWXContext failed' };
  }
}

/**
 * Timer/console event fields are input data and are never an authentication
 * signal. The current invocation environment, supplied by the runtime, is
 * authoritative. WeChat IDE timers use TCB_SOURCE=wx_trigger/TRIGGER_SRC=tcb;
 * plain SCF timers use TRIGGER_SRC=timer. Never trust a warm process's identity.
 */
function verifyWorkerSource(cloud, event = {}, runtime = process.env, context = {}) {
  const wxContext = readWXContext(cloud);
  const source = wxContext.SOURCE || '';
  let invocationEnvironment = {};
  try { invocationEnvironment = JSON.parse(context.environment || '{}'); } catch (_) { /* fail closed */ }
  const requestSource = invocationEnvironment.TCB_SOURCE || '';
  const requestTrigger = invocationEnvironment.TRIGGER_SRC || '';
  const requestHasOpenId = !!invocationEnvironment.WX_OPENID;
  const requestAppIdMatches = !!runtime.MINIPROGRAM_APP_ID
    && invocationEnvironment.WX_APPID === runtime.MINIPROGRAM_APP_ID;
  const isWeChatTimer = requestSource === 'wx_trigger' && requestTrigger === 'tcb' && requestAppIdMatches;
  const isScfTimer = requestTrigger === 'timer' && !requestSource;
  return {
    ok: !requestHasOpenId && !wxContext.OPENID && (isWeChatTimer || isScfTimer),
    triggerSource: runtime.TRIGGER_SRC || '',
    source,
    hasOpenId: !!wxContext.OPENID,
    eventType: typeof event.Type === 'string' ? event.Type : '',
    triggerName: typeof event.TriggerName === 'string' ? event.TriggerName : '',
    sourceError: wxContext.sourceError || '',
    requestSource,
    requestTrigger,
    requestHasOpenId,
    requestAppIdMatches,
  };
}

function taskLeaseCondition(task, now, _) {
  const condition = { _id: task._id, clubId: task.clubId, status: task.status };
  const attempts = Number(task.attempts);
  if (Number.isFinite(attempts)) {
    condition.attempts = attempts >= MAX_ATTEMPTS
      ? _.gte(MAX_ATTEMPTS)
      : _.lt(MAX_ATTEMPTS);
  }

  if (task.status === REVIEW_TASK_STATUS.QUEUED) {
    // Keep the due check in the conditional update as well as in the read
    // filter. This prevents a stale worker from claiming a newly deferred
    // task after another worker has written nextAttemptAt.
    if (task.nextAttemptAt === undefined) {
      condition.nextAttemptAt = _.exists(false);
    } else if (task.nextAttemptAt === null) {
      condition.nextAttemptAt = null;
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
    clubId: task.clubId,
    status: task.status || REVIEW_TASK_STATUS.RUNNING,
    leaseId: task.leaseId,
  };
}

async function conditionalTaskUpdate(task, data) {
  const result = await db
    .coll(COLLECTIONS.reviewTasks, task.clubId)
    .where(taskOwnerCondition(task))
    .update({ data });
  return !!(result.stats && result.stats.updated === 1);
}

async function recoverExhaustedTask(task, now, _) {
  const condition = taskLeaseCondition(task, now, _);
  const result = await db
    .coll(COLLECTIONS.reviewTasks, task.clubId)
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
  clubId,
} = {}) {
  if (!clubId) throw new Error('worker claim club is required');
  const _ = db.command();
  const res = await db
    .coll(COLLECTIONS.reviewTasks, clubId)
    .where({ clubId, $or: [
      { status: REVIEW_TASK_STATUS.QUEUED, $or: [
        { nextAttemptAt: _.exists(false) }, { nextAttemptAt: null }, { nextAttemptAt: _.lte(new Date(now)) },
      ] },
      { status: REVIEW_TASK_STATUS.RUNNING, $or: [
        { leaseExpiresAt: _.lte(new Date(now)) },
        { leaseExpiresAt: null, claimedAt: _.lte(new Date(now - LEASE_MS)) },
        { leaseExpiresAt: _.exists(false), claimedAt: _.lte(new Date(now - LEASE_MS)) },
        { leaseExpiresAt: null, claimedAt: null },
      ] },
    ] })
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .get();

  const tasks = (res.data || []).filter((task) => {
    if (task.status === REVIEW_TASK_STATUS.QUEUED) return recovery.isTaskDue(task, now);
    return recovery.isLeaseExpired(task, now, LEASE_MS);
  });
  const claimed = [];

  for (const task of tasks) {
    if ((Number(task.attempts) || 0) >= MAX_ATTEMPTS) {
      // This covers a task left running by a timed-out legacy worker after it
      // had already used all failure attempts. It must become visible to the
      // manual queue instead of remaining permanently running.
      if (await recoverExhaustedTask({ ...task, clubId }, now, _)) stats.recovered = (stats.recovered || 0) + 1;
      continue;
    }

    const leaseId = recovery.createLeaseId(invocationId);
    // 乐观抢占：只有把 queued 改成 running 成功的实例才处理该任务。
    // 过期 running 任务也必须匹配同一旧 lease，避免两个实例重复生效。
    const scopedTask = { ...task, clubId };
    const upd = await db
      .coll(COLLECTIONS.reviewTasks, clubId)
      .where(taskLeaseCondition(scopedTask, recovery.nowMillis(now), _))
      .update({
        data: {
          status: REVIEW_TASK_STATUS.RUNNING,
          ...recovery.buildLeaseFields({ leaseId, now, leaseMs: LEASE_MS }),
        },
      });

    if (upd.stats && upd.stats.updated === 1) {
      claimed.push({ ...scopedTask, status: REVIEW_TASK_STATUS.RUNNING, leaseId });
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

async function listAllClubs() {
  const result = await db.getDb().rpc('hg_all_club_ids', {});
  const items = Array.isArray(result) ? result : result && result.items;
  if (!Array.isArray(items)) throw new Error('club list RPC returned invalid result');
  return items.filter((item) => item && typeof item.clubId === 'string' && item.clubId);
}

async function updateClubWorkerState(clubId, data) {
  await db.coll(COLLECTIONS.clubConfig, clubId).doc(clubId).update({ data });
}

async function processClaimedTasks(tasks, summary, clubSummary) {
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
        clubSummary.stale += 1;
        console.warn('[worker] task lease lost before result write', scrubForLog({ taskId: task._id }));
      } else if (recovery.isWaitingResult(result)) {
        summary.waiting += 1;
        clubSummary.waiting += 1;
      } else if (result.status === REVIEW_TASK_STATUS.MANUAL) {
        summary.manual += 1;
        clubSummary.manual += 1;
      } else {
        summary.done += 1;
        clubSummary.done += 1;
      }
    } catch (err) {
      summary.failed += 1;
      clubSummary.failed += 1;
      const failure = recovery.buildFailureUpdate(task, err);
      try {
        const updated = await conditionalTaskUpdate(task, failure.update);
        if (!updated) {
          summary.stale += 1;
          clubSummary.stale += 1;
        } else if (failure.exhausted) {
          summary.manual += 1;
          clubSummary.manual += 1;
        }
      } catch (updateErr) {
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

exports.main = async (event = {}, context = {}) => {
  let cloud;
  let source;
  if (process.env.RUNTIME_KIND === 'nas' && context.localRuntime === true) {
    source = { ok: true, source: 'nas-local', hasOpenId: false };
  } else {
    try {
      cloud = db.getCloud();
    } catch (err) {
      console.error('[worker] cloud init failed', { code: err.code || 'cloud_init_error' });
      return { code: 'server', data: { claimed: 0, done: 0, failed: 1, manual: 0 } };
    }
    source = verifyWorkerSource(cloud, event, process.env, context);
  }

  if (!source.ok) {
    // Type/TriggerName are logged for diagnosis only. They are ordinary event
    // fields and must never be used as proof that this was a timer invocation.
    console.warn('[worker] rejected invocation source', {
      source: source.source,
      hasOpenId: source.hasOpenId,
      eventType: source.eventType,
      triggerName: source.triggerName,
      sourceError: source.sourceError,
      triggerSource: source.triggerSource,
      requestSource: source.requestSource,
      requestTrigger: source.requestTrigger,
      requestHasOpenId: source.requestHasOpenId,
      requestAppIdMatches: source.requestAppIdMatches,
      cloudPermissionVerified: false,
    });
    return { code: 'forbidden' };
  }
  console.log('[worker] invocation source accepted', {
    configuredAppId: !!process.env.MINIPROGRAM_APP_ID,
    configuredAppIdLength: (process.env.MINIPROGRAM_APP_ID || '').length,
    source: source.source,
    triggerSource: source.triggerSource,
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
    clubs: {},
    source: source.source,
  };

  let clubs;
  try {
    clubs = await listAllClubs();
  } catch (err) {
    console.error('[worker] club list failed', { code: err.code || 'club_list_error' });
    return { code: 'server', data: { ...summary, failed: 1 } };
  }
  const clubIds = clubs.map((club) => club.clubId);
  for (const clubId of clubIds) {
    summary.clubs[clubId] = {
      claimed: 0, done: 0, failed: 0, manual: 0, waiting: 0, stale: 0, recovered: 0,
      digest: null, cleanup: null, usage: null,
    };
  }

  if (mode === 'all' || mode === 'review') {
    const invocationId = context.requestId || context.request_id || 'worker';
    const activeClubs = await Promise.all(clubs
      .filter((club) => club.status === 'active' || (club.clubId === 'heiguang' && !club.status))
      .map(async (club) => ({ ...club, config: await db.findOneById(COLLECTIONS.clubConfig, club.clubId, club.clubId) })));
    activeClubs.sort((left, right) => {
      const leftRun = new Date(left.config && left.config.workerTaskLastRunAt || 0).getTime() || 0;
      const rightRun = new Date(right.config && right.config.workerTaskLastRunAt || 0).getTime() || 0;
      return leftRun - rightRun;
    });
    const baseLimit = activeClubs.length ? Math.floor(limit / activeClubs.length) : 0;
    const remainder = activeClubs.length ? limit % activeClubs.length : 0;
    for (const [index, club] of activeClubs.entries()) {
      const clubId = club.clubId;
      const clubLimit = baseLimit + (index < remainder ? 1 : 0);
      if (!clubLimit) continue;
      const claimStats = {};
      const tasks = await claimTasks(clubLimit, { invocationId, stats: claimStats, clubId });
      const clubSummary = summary.clubs[clubId];
      summary.claimed += tasks.length;
      clubSummary.claimed += tasks.length;
      summary.recovered += claimStats.recovered || 0;
      clubSummary.recovered += claimStats.recovered || 0;
      await updateClubWorkerState(clubId, { workerTaskLastRunAt: db.serverDate() });
      await processClaimedTasks(tasks, summary, clubSummary);
    }
  }

  if (mode === 'all' || mode === 'digest') {
    for (const club of clubs.filter((item) => item.status === 'active' || (item.clubId === 'heiguang' && !item.status))) {
      try { summary.clubs[club.clubId].digest = await digestTasks.buildReactionDigests(club.clubId); }
      catch (err) { console.error('[worker] digest', { clubId: club.clubId, message: err.message }); }
    }
  }

  if (mode === 'all' || mode === 'cleanup') {
    for (const clubId of clubIds) {
      const result = {};
      try { result.orphans = await cleanupTasks.cleanupOrphanAssets(clubId); }
      catch (err) { console.error('[worker] cleanup assets', { clubId, message: err.message }); }
      try { result.deleted = await cleanupTasks.cleanupDeletedPostAssets(clubId); }
      catch (err) { console.error('[worker] cleanup deleted assets', { clubId, message: err.message }); }
      try { result.idempotency = await cleanupTasks.cleanupIdempotency(clubId); }
      catch (err) { console.error('[worker] cleanup idem', { clubId, message: err.message }); }
      summary.clubs[clubId].cleanup = result;
    }
    try { await cleanupTasks.processAccountDeletions(clubIds); }
    catch (err) { console.error('[worker] deletion', { message: err.message }); }
  }

  if (mode === 'all' || mode === 'usage') {
    for (const clubId of clubIds) {
      try { summary.clubs[clubId].usage = await usageTasks.refreshUsageSummary(clubId); }
      catch (err) {
        console.warn('[worker] usage summary failed', { clubId, message: err.message });
      }
    }
  }

  const completedAt = db.serverDate();
  for (const clubId of clubIds) {
    await updateClubWorkerState(clubId, { workerLastRunAt: completedAt, workerSummary: summary.clubs[clubId] });
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
