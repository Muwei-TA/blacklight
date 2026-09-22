/**
 * 匿名身份生成。
 *
 * 规则（docs/05 5.3）：
 * 1. 同一帖子线程内，同一参与者的 alias 稳定；
 * 2. 跨帖子不可串联 —— 因此 alias 必须由 (threadId, userId) 共同派生；
 * 3. 真实映射存受限集合，不出现在任何面向客户端的响应里；
 * 4. alias 本身不能反解出 userId，所以用 HMAC 而非可逆编码。
 *
 * 注意：alias 只是展示名。它不提供密码学意义上的匿名保证，
 * 也无法消除通过文风、经历、地名被认出的风险。
 */

const crypto = require('crypto');

const ALIAS_PREFIX = '树洞旅人';

/**
 * 派生线程内稳定别名。
 * @param {string} threadId 帖子 ID
 * @param {string} userId 内部用户 ID
 * @param {string} secret 环境变量注入的密钥，绝不硬编码
 * @returns {{ alias: string, aliasKey: string }}
 */
function deriveAlias(threadId, userId, secret) {
  if (!secret) {
    // fail-closed：没有密钥就不允许生成匿名身份，避免退化成可预测值
    throw new Error('ANON_ALIAS_SECRET is required for anonymous identity');
  }
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${threadId}:${userId}`);
  const digest = hmac.digest();
  // 取两字节映射到 01-99，够用且不暗示参与人数
  const number = (digest.readUInt16BE(0) % 99) + 1;
  const padded = number < 10 ? `0${number}` : `${number}`;
  return {
    alias: `${ALIAS_PREFIX} ${padded}`,
    // aliasKey 用于同线程内去重：不同用户偶然撞号时追加后缀
    aliasKey: digest.toString('hex').slice(0, 16),
  };
}

/**
 * 处理同线程内的号码冲突。
 * 传入已占用的 aliasKey → alias 映射，返回不冲突的 alias。
 */
function resolveAliasCollision(alias, aliasKey, occupied = new Map()) {
  const existingKey = occupied.get(alias);
  if (!existingKey || existingKey === aliasKey) return alias;
  // 撞号时追加字母后缀，仍不暴露任何身份信息
  const suffixes = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < suffixes.length; i += 1) {
    const candidate = `${alias}${suffixes[i]}`;
    const key = occupied.get(candidate);
    if (!key || key === aliasKey) return candidate;
  }
  return `${alias}·${aliasKey.slice(0, 4)}`;
}

/**
 * 清洗对象：移除所有可能泄露匿名映射的字段。
 * 在写日志、写埋点、返回响应前调用。
 */
const FORBIDDEN_KEYS = new Set([
  'ownerId',
  'openid',
  'unionid',
  'wxOpenIdRef',
  'aliasKey',
  'anonymousUserId',
  'reporterId',
  'reporterOpenid',
  'realDisplayName',
]);

function scrubForLog(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => scrubForLog(item, depth + 1));
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      out[key] = '[redacted]';
      continue;
    }
    // 正文与草稿不写日志
    if (key === 'body' || key === 'draft' || key === 'paragraphs') {
      out[key] = `[len:${typeof val === 'string' ? val.length : 'n/a'}]`;
      continue;
    }
    out[key] = scrubForLog(val, depth + 1);
  }
  return out;
}

/**
 * 断言 DTO 中不含匿名映射。用于测试与开发期自检。
 * @throws {Error} 发现泄露字段时抛出
 */
function assertNoIdentityLeak(dto, path = 'dto') {
  if (dto === null || dto === undefined) return;
  if (Array.isArray(dto)) {
    dto.forEach((item, i) => assertNoIdentityLeak(item, `${path}[${i}]`));
    return;
  }
  if (typeof dto !== 'object') return;

  for (const [key, val] of Object.entries(dto)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`identity leak: ${path}.${key} 不允许出现在客户端响应中`);
    }
    // 匿名作者必须 userId=null
    if (key === 'author' && val && val.isAnonymous === true && val.userId !== null) {
      throw new Error(`identity leak: ${path}.author.userId 在匿名内容中必须为 null`);
    }
    assertNoIdentityLeak(val, `${path}.${key}`);
  }
}

module.exports = {
  ALIAS_PREFIX,
  deriveAlias,
  resolveAliasCollision,
  scrubForLog,
  assertNoIdentityLeak,
  FORBIDDEN_KEYS,
};
