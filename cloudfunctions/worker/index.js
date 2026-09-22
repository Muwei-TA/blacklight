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

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 10;

/** 取一批待处理任务，抢占式标记为 running 避免重复执行 */
async function claimTasks(limit = BATCH_SIZE) {
  const _ = db.command();
  const res = await db
    .coll(COLLECTIONS.reviewTasks)
    .where({
      status: _.in([REVIEW_TASK_STATUS.QUEUED]),
      attempts: _.lt(MAX_ATTEMPTS),
    })
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .get()
    .catch(() => ({ data: [] }));

  const tasks = res.data || [];
  const claimed = [];

  for (const task of tasks) {
    // 乐观抢占：只有把 queued 改成 running 成功的实例才处理该任务
    const upd = await db
      .coll(COLLECTIONS.reviewTasks)
      .where({ _id: task._id, status: REVIEW_TASK_STATUS.QUEUED })
      .update({
        data: {
          status: REVIEW_TASK_STATUS.RUNNING,
          attempts: _.inc(1),
          claimedAt: db.serverDate(),
        },
      })
      .catch(() => ({ stats: { updated: 0 } }));

    if (upd.stats && upd.stats.updated === 1) claimed.push(task);
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

exports.main = async (event = {}) => {
  const mode = event.mode || 'all';
  const summary = { claimed: 0, done: 0, failed: 0, manual: 0 };

  if (mode === 'all' || mode === 'review') {
    const tasks = await claimTasks(event.limit || BATCH_SIZE);
    summary.claimed = tasks.length;

    for (const task of tasks) {
      try {
        const result = await runTask(task);
        await db
          .coll(COLLECTIONS.reviewTasks)
          .doc(task._id)
          .update({
            data: {
              status: result.status,
              note: result.note || '',
              finishedAt: db.serverDate(),
            },
          })
          .catch(() => {});

        if (result.status === REVIEW_TASK_STATUS.MANUAL) summary.manual += 1;
        else summary.done += 1;
      } catch (err) {
        summary.failed += 1;
        const exhausted = (task.attempts || 0) + 1 >= MAX_ATTEMPTS;
        // 重试耗尽后转人工处理，而不是丢弃 —— 内容仍保持不可公开
        await db
          .coll(COLLECTIONS.reviewTasks)
          .doc(task._id)
          .update({
            data: {
              status: exhausted ? REVIEW_TASK_STATUS.MANUAL : REVIEW_TASK_STATUS.QUEUED,
              lastError: err.message,
              finishedAt: exhausted ? db.serverDate() : null,
            },
          })
          .catch(() => {});

        console.error('[worker] task failed', scrubForLog({ taskId: task._id, message: err.message, exhausted }));
      }
    }
  }

  if (mode === 'all' || mode === 'digest') {
    // 共鸣聚合：避免一人连点造成通知刷屏
    await digestTasks.buildReactionDigests().catch((err) => console.error('[worker] digest', err.message));
  }

  if (mode === 'all' || mode === 'cleanup') {
    // 孤儿附件与过期幂等键清理，按已告知的保留策略执行
    await cleanupTasks.cleanupOrphanAssets().catch((err) => console.error('[worker] cleanup assets', err.message));
    await cleanupTasks.cleanupIdempotency().catch((err) => console.error('[worker] cleanup idem', err.message));
    await cleanupTasks.processAccountDeletions().catch((err) => console.error('[worker] deletion', err.message));
  }

  console.log('[worker] summary', summary);
  return { code: 0, data: summary };
};
