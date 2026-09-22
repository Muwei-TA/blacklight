/**
 * 云函数统一路由。
 *
 * 职责边界：
 * - 解析 action、注入 ctx（viewer/user/club/capabilities）
 * - 统一错误映射（AppError → 响应码）
 * - 统一日志脱敏（正文、openid、匿名映射不落日志）
 * 不做任何业务判断。
 */

const { AppError, KIND, MESSAGE_BY_KIND, serverError } = require('./errors');
const { scrubForLog } = require('./anonymity');
const { resolveContext } = require('./session');
const { DEFAULT_CLUB_ID } = require('./constants');

/**
 * @param {object} handlers { 'module/action': async (payload, ctx) => data }
 * @param {object} options { requireAuthByDefault }
 */
function createRouter(handlers, { name = 'api' } = {}) {
  return async function main(event = {}, context = {}) {
    const started = Date.now();
    const { action, payload = {} } = event;
    const requestId = (context && context.requestId) || `${Date.now()}`;

    if (!action || typeof action !== 'string') {
      return { code: KIND.INVALID_INPUT, message: '缺少 action', requestId };
    }

    const handler = handlers[action];
    if (!handler) {
      // 未知 action 不回显可用列表，避免暴露内部接口面
      console.warn(`[${name}] unknown action`, { action, requestId });
      return { code: KIND.INVALID_INPUT, message: '请求不合法', requestId };
    }

    let ctx;
    try {
      // openid 只能来自云上下文，客户端传入的一律忽略
      const cloud = require('wx-server-sdk');
      const wxContext = cloud.getWXContext();
      const openid = wxContext.OPENID || null;
      ctx = await resolveContext(openid, event.clubId || DEFAULT_CLUB_ID);
      ctx.requestId = requestId;
      ctx.action = action;
      ctx.now = Date.now();
    } catch (err) {
      console.error(`[${name}] context error`, { action, requestId, message: err.message });
      return { code: KIND.SERVER, message: MESSAGE_BY_KIND[KIND.SERVER], requestId };
    }

    try {
      const data = await handler(payload, ctx);
      console.log(`[${name}] ok`, {
        action,
        requestId,
        role: ctx.viewer.role,
        ms: Date.now() - started,
      });
      return { code: 0, message: 'ok', data: data === undefined ? null : data, requestId };
    } catch (err) {
      if (err instanceof AppError) {
        // 业务错误：记脱敏日志，返回统一形态
        console.warn(`[${name}] ${err.kind}`, {
          action,
          requestId,
          role: ctx.viewer.role,
          detail: scrubForLog(err.logDetail || err.detail),
        });
        return {
          code: err.kind,
          message: err.message,
          detail: err.detail || undefined,
          requestId,
        };
      }

      // 未预期异常：只记堆栈到服务端，对外统一文案
      console.error(`[${name}] unhandled`, {
        action,
        requestId,
        message: err.message,
        stack: err.stack,
      });
      const fallback = serverError();
      return { code: fallback.kind, message: fallback.message, requestId };
    }
  };
}

module.exports = { createRouter };
