const cloud = require('wx-server-sdk');
const usage = require('../shared/usage');
const { DEFAULT_CLUB_ID } = require('../shared/constants');
const errors = require('../shared/errors');
async function securityCheck(payload, ctx) {
  if (!ctx.viewer.isModerator) throw errors.forbidden();
  const started = Date.now();
  try {
    await usage.reserveReviewCall('text', ctx.viewer.clubId || DEFAULT_CLUB_ID);
    const result = await cloud.openapi({ appid: cloud.getWXContext().APPID }).security.msgSecCheck({ version: 2, openid: ctx.user.wxOpenIdRef, scene: 2, content: '黑光文学社开发环境内容安全连通性测试。' });
    return { identity: ctx.identityDiagnostic, success: true, suggest: result.result?.suggest || '', code: result.errCode || 0, elapsedMs: Date.now()-started };
  } catch (err) {
    return { identity: ctx.identityDiagnostic, success: false, code: err.code || err.errCode || '', elapsedMs: Date.now()-started };
  }
}
module.exports = { securityCheck };
