/**
 * 统一错误类型。kind 枚举与前端 docs/04-data-model-and-api.md 4.6 一一对应。
 *
 * 最重要的一条：notAccessible 用于「无权」和「不存在」两种情况，
 * 且必须返回完全相同的响应体，防止通过错误文案差异探测某条私密内容是否存在。
 */

const KIND = {
  UNAUTHENTICATED: 'unauthenticated',
  MEMBERSHIP_INVALID: 'membership_invalid',
  FORBIDDEN: 'forbidden',
  NOT_ACCESSIBLE: 'not_accessible',
  INVALID_INPUT: 'invalid_input',
  CONFLICT: 'conflict',
  PENDING_MEDIA: 'pending_media',
  RATE_LIMITED: 'rate_limited',
  SERVER: 'server',
};

const HTTP_BY_KIND = {
  [KIND.UNAUTHENTICATED]: 401,
  [KIND.MEMBERSHIP_INVALID]: 403,
  [KIND.FORBIDDEN]: 403,
  [KIND.NOT_ACCESSIBLE]: 404,
  [KIND.INVALID_INPUT]: 422,
  [KIND.CONFLICT]: 409,
  [KIND.PENDING_MEDIA]: 409,
  [KIND.RATE_LIMITED]: 429,
  [KIND.SERVER]: 500,
};

const MESSAGE_BY_KIND = {
  [KIND.UNAUTHENTICATED]: '需要先完成授权',
  [KIND.MEMBERSHIP_INVALID]: '社内内容需要有效的成员资格',
  [KIND.FORBIDDEN]: '当前没有执行该操作的权限',
  [KIND.NOT_ACCESSIBLE]: '这条内容当前不可访问',
  [KIND.INVALID_INPUT]: '填写内容不符合要求',
  [KIND.CONFLICT]: '内容已被更新，请刷新后重试',
  [KIND.PENDING_MEDIA]: '附件仍在处理中，完成后才能提交',
  [KIND.RATE_LIMITED]: '操作过于频繁，请稍后再试',
  [KIND.SERVER]: '服务暂时不可用，请稍后重试',
};

class AppError extends Error {
  /**
   * @param {string} kind KIND 枚举之一
   * @param {object} options
   * @param {string} [options.message] 对外文案；notAccessible 会被强制覆盖
   * @param {object} [options.detail] 对外可见的补充信息（如字段名），不得含隐私
   * @param {object} [options.logDetail] 仅写日志、不返回给客户端的诊断信息
   */
  constructor(kind, { message, detail = null, logDetail = null } = {}) {
    super(message || MESSAGE_BY_KIND[kind] || MESSAGE_BY_KIND[KIND.SERVER]);
    this.name = 'AppError';
    this.kind = kind;
    this.httpStatus = HTTP_BY_KIND[kind] || 500;
    this.detail = detail;
    this.logDetail = logDetail;
  }
}

/** 无权与不存在共用同一形态，调用方不得传入差异化文案 */
const notAccessible = (logDetail) =>
  new AppError(KIND.NOT_ACCESSIBLE, { message: MESSAGE_BY_KIND[KIND.NOT_ACCESSIBLE], logDetail });

const unauthenticated = (logDetail) => new AppError(KIND.UNAUTHENTICATED, { logDetail });
const membershipInvalid = (logDetail) => new AppError(KIND.MEMBERSHIP_INVALID, { logDetail });
const forbidden = (logDetail) => new AppError(KIND.FORBIDDEN, { logDetail });
const invalidInput = (message, detail) => new AppError(KIND.INVALID_INPUT, { message, detail });
const conflict = (message, detail) => new AppError(KIND.CONFLICT, { message, detail });
const pendingMedia = (detail) => new AppError(KIND.PENDING_MEDIA, { detail });
const rateLimited = (detail) => new AppError(KIND.RATE_LIMITED, { detail });
const serverError = (logDetail) => new AppError(KIND.SERVER, { logDetail });

module.exports = {
  KIND,
  HTTP_BY_KIND,
  MESSAGE_BY_KIND,
  AppError,
  notAccessible,
  unauthenticated,
  membershipInvalid,
  forbidden,
  invalidInput,
  conflict,
  pendingMedia,
  rateLimited,
  serverError,
};
