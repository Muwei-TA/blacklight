const cloud = require('wx-server-sdk');
const errors = require('../shared/errors');
async function securityCheck(payload, ctx) {
  if (!ctx.viewer.isModerator) throw errors.forbidden();
  const started = Date.now();
  try {
    const result = await cloud.openapi({ appid: cloud.getWXContext().APPID }).security.msgSecCheck({ version: 2, openid: ctx.user.wxOpenIdRef, scene: 2, content: '黑光文学社开发环境内容安全连通性测试。' });
    return { identity: ctx.identityDiagnostic, success: true, suggest: result.result?.suggest || '', code: result.errCode || 0, elapsedMs: Date.now()-started };
  } catch (err) {
    return { identity: ctx.identityDiagnostic, success: false, code: err.errCode || '', elapsedMs: Date.now()-started };
  }
}
module.exports = { securityCheck };
