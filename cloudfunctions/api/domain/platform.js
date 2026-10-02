const db = require('../shared/db');
const errors = require('../shared/errors');
const validators = require('../shared/validators');

async function execute(action, payload, ctx) {
  if (!ctx.viewer.isDeveloper) throw errors.forbidden();
  if (action !== 'list') {
    validators.requireId(payload.id, 'id');
    validators.requireString(payload.reason, '操作理由', { min: 10, max: 500 });
  }
  try {
    return await db.getDb().rpc('hg_platform_clubs', {
      p_actor_id: ctx.viewer.userId, p_action: action, p_payload: payload,
    });
  } catch (error) {
    const marker = String(error.message || '');
    if (/FORBIDDEN/.test(marker)) throw errors.forbidden();
    if (/VERSION_CONFLICT/.test(marker)) throw errors.invalidInput('社团配置已更新，请刷新后重试');
    if (/INVALID_INPUT|TARGET_USER_INVALID|TARGET_MEMBERSHIP_INACTIVE|CLUB_EXISTS|CLUB_NOT_FOUND/.test(marker)) {
      throw errors.invalidInput('社团信息或负责人账号不符合要求');
    }
    throw error;
  }
}
module.exports = {
  list: (payload, ctx) => execute('list', payload, ctx),
  create: (payload, ctx) => execute('create', payload, ctx),
  update: (payload, ctx) => execute('update', payload, ctx),
  setStatus: (payload, ctx) => execute('set-status', payload, ctx),
  setModerator: (payload, ctx) => execute('set-moderator', payload, ctx),
};
