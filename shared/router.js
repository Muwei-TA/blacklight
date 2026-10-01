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
function createRouter(handlers, { name = 'api', identityResolver = null } = {}) {
  return async function main(event = {}, context = {}) {
    const started = Date.now();
    const { action, payload = {} } = event;
    const requestId = (context && (context.requestId || context.request_id)) || `${Date.now()}`;

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
      let identity;
      if (identityResolver) {
        identity = await identityResolver(context, event) || {};
      } else {
        // Cloud function mode: openid 只能来自当前云上下文，客户端传入的一律忽略。
        const cloud = require('./db').getCloud();
        const wxContext = cloud.getWXContext();
        let requestEnvironment = {};
        try { requestEnvironment = JSON.parse(context.environment || '{}'); } catch (_) { /* diagnostic only */ }
        // SCF reuses processes; trust the current invocation envelope, never a
        // leftover process.env identity from an earlier wx invocation.
        const expectedAppId = process.env.MINIPROGRAM_APP_ID || 'wx39773ed34aa30776';
        const openid = requestEnvironment.WX_OPENID === wxContext.OPENID && requestEnvironment.WX_APPID === expectedAppId
          ? wxContext.OPENID || null : null;
        identity = {
          openid,
          diagnostic: {
            source: wxContext.SOURCE || '',
            hasOpenid: !!wxContext.OPENID,
            requestHasOpenid: !!requestEnvironment.WX_OPENID,
            appidMatches: wxContext.APPID === expectedAppId,
          },
        };
      }
      if (identity.invalid) {
        return { code: KIND.UNAUTHENTICATED, message: MESSAGE_BY_KIND[KIND.UNAUTHENTICATED], requestId };
      }
      ctx = await resolveContext(identity.openid || null, event.clubId || DEFAULT_CLUB_ID);
      ctx.identityDiagnostic = identity.diagnostic || { source: 'nas-session', hasOpenid: !!identity.openid };
      ctx.requestId = requestId;
      ctx.action = action;
      ctx.now = Date.now();
    } catch (err) {
      console.error(`[${name}] context error`, { action, requestId, code: err.code || 'context_error' });
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
