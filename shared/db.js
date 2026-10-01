/**
 * 数据访问薄封装。只处理连接、游标分页、幂等与审计写入。
 * ⚠️ 不允许在本文件出现业务权限判断 —— 那是 policies.js 的职责。
 */

const { COLLECTIONS } = require('./constants');
const { conflict } = require('./errors');

let initialized = false;
let cloud;

function getCloud() {
  if (!initialized) {
    cloud = require('wx-server-sdk');
    cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
    initialized = true;
  }
  return cloud;
}

let storage;
function getStorage() {
  if (!storage) {
    storage = process.env.RUNTIME_KIND === 'nas'
      ? require('./local-storage').createLocalStorageAdapter()
      : require('./pg-storage').createPgStorageAdapter();
  }
  return storage;
}

function getDb() {
  return require('./pg-store');
}

function command() {
  return getDb().command;
}

function coll(name) {
  return getDb().collection(name);
}

function serverDate() {
  return getDb().serverDate();
}

/**
 * 游标分页查询。
 * 游标由 (createdAt, _id) 构成，保证新数据插入时不产生重复项。
 *
 * @param {string} name 集合名
 * @param {object} where 过滤条件（已含权限相关的 visibility/status 条件）
 * @param {object} options { cursor, pageSize, order }
 */
async function paginate(name, where = {}, {
  cursor = null,
  pageSize = 20,
  order = 'desc',
  includeEqualId = false,
} = {}) {
  const _ = command();
  let query = { ...where };

  if (cursor) {
    const cursorDate = new Date(cursor.createdAt);
    // 同一毫秒内用 _id 兜底排序，避免边界重复或漏读
    const afterCursor = { $or: [
      { createdAt: order === 'desc' ? _.lt(cursorDate) : _.gt(cursorDate) },
      {
        createdAt: cursorDate,
        _id: order === 'desc'
          ? (includeEqualId ? _.lte(cursor.id) : _.lt(cursor.id))
          : (includeEqualId ? _.gte(cursor.id) : _.gt(cursor.id)),
      },
    ] };
    query = { $and: [where, afterCursor] };
  }

  const res = await coll(name)
    .where(query)
    .orderBy('createdAt', order)
    .orderBy('_id', order)
    .limit(pageSize + 1)
    .get();

  const items = res.data || [];
  const hasMore = items.length > pageSize;
  return { items: hasMore ? items.slice(0, pageSize) : items, hasMore };
}

/** 批量按 _id 取文档，避免 N+1 查询 */
async function findByIds(name, ids = []) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];
  const _ = command();
  const res = await coll(name).where({ _id: _.in(unique) }).limit(unique.length).get();
  return res.data || [];
}

async function findOneById(name, id) {
  if (!id) return null;
  const res = await coll(name).doc(id).get();
  return res && res.data ? res.data : null;
}

/**
 * 乐观并发更新。expectedVersion 不匹配则抛 conflict。
 * 所有涉及状态流转的写操作都必须走这里。
 */
async function updateWithVersion(name, id, expectedVersion, data) {
  const res = await coll(name)
    .where({ _id: id, version: expectedVersion })
    .update({
      data: { ...data, version: expectedVersion + 1, updatedAt: serverDate() },
    });

  if (!res.stats || res.stats.updated === 0) {
    throw conflict('内容已被更新，请刷新后重试', { field: 'expectedVersion' });
  }
  return expectedVersion + 1;
}

/**
 * 幂等键。相同 key 只允许产生一次副作用。
 * @returns {{ isNew: boolean, result: object|null }}
 */
async function claimIdempotency(key, userId, action) {
  if (!key) return { isNew: true, result: null };

  const docId = `${userId}:${action}:${key}`;
  const existing = await findOneById(COLLECTIONS.idempotency, docId);
  if (existing) {
    return { isNew: false, result: existing.result || null };
  }

  try {
    await coll(COLLECTIONS.idempotency).add({
      data: { _id: docId, userId, action, result: null, createdAt: serverDate() },
    });
    return { isNew: true, result: null };
  } catch (err) {
    // 并发插入时后到者读已有记录，返回同一结果
    const raced = await findOneById(COLLECTIONS.idempotency, docId);
    return { isNew: false, result: (raced && raced.result) || null };
  }
}

async function completeIdempotency(key, userId, action, result) {
  if (!key) return;
  const docId = `${userId}:${action}:${key}`;
  await coll(COLLECTIONS.idempotency)
    .doc(docId)
    .update({ data: { result, completedAt: serverDate() } });
}

/**
 * 审计日志。所有管理操作、匿名映射访问、导出与注销都必须写。
 * 日志不存原始私密正文，只存 ID 与决定。
 */
async function writeAudit({ actorId, action, targetType, targetId, decision, reason, extra = {} }) {
  await coll(COLLECTIONS.auditLogs)
    .add({
      data: {
        actorId,
        action,
        targetType,
        targetId,
        decision: decision || '',
        reason: reason || '',
        extra,
        createdAt: serverDate(),
      },
    })
    .catch((err) => {
      // 审计写入失败不能静默：抛出让调用方决定是否回滚
      throw err;
    });
}

/** 原子计数器 */
async function incCounter(name, id, field, delta = 1) {
  const _ = command();
  await coll(name)
    .doc(id)
    .update({ data: { [field]: _.inc(delta) } })
    .catch(() => {});
}

module.exports = {
  getCloud,
  getStorage,
  getDb,
  command,
  coll,
  serverDate,
  paginate,
  findByIds,
  findOneById,
  updateWithVersion,
  claimIdempotency,
  completeIdempotency,
  writeAudit,
  incCounter,
};
