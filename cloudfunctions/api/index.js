/**
 * api 云函数：所有面向小程序的读写请求入口。
 *
 * 调用约定（小程序端）：
 *   wx.cloud.callFunction({ name: 'api', data: { action, payload: { ...data, idempotencyKey? } } })
 *
 * action 命名与前端 docs/04-data-model-and-api.md 的接口一一对应。
 * 新增 action 必须同时更新前端工程书，否则视为契约破坏。
 */

const { createRouter } = require('./shared/router');

const session = require('./domain/session');
const posts = require('./domain/posts');
const topics = require('./domain/topics');
const collections = require('./domain/collections');
const notifications = require('./domain/notifications');
const search = require('./domain/search');
const assets = require('./domain/assets');
const moderation = require('./domain/moderation');
const governance = require('./domain/governance');
const operations = require('./domain/operations');
const usage = require('./domain/usage');

const handlers = {
  // ── 会话与成员资格 ──
  'session/me': session.me,
  'membership/apply': session.apply,
  'membership/mine': session.myApplication,
  'me/profile': session.myProfile,
  'me/profile/update': session.updateProfile,
  'me/exports': session.requestExport,
  'me/account/delete': session.requestAccountDeletion,
  'profile/get': session.publicProfile,

  // ── 内容 ──
  'posts/list': posts.listFeed,
  'posts/detail': posts.getDetail,
  'posts/create': posts.createPost,
  'posts/visibility': posts.changeVisibility,
  'posts/delete': posts.deletePost,
  'posts/reaction': posts.toggleReaction,
  'posts/bookmark': posts.toggleBookmark,
  'posts/comments/list': posts.listComments,
  'posts/comments/create': posts.createComment,
  'me/contents': posts.listMyContents,
  'reports/create': posts.createReport,

  // ── 话题 ──
  'topics/list': topics.list,
  'topics/detail': topics.detail,
  'topics/create': topics.create,
  'topics/follow': topics.toggleFollow,
  'me/topics': topics.myFollows,

  // ── 文集 ──
  'collections/list': collections.list,
  'collections/detail': collections.detail,
  'collections/submit': collections.submit,
  'consents/revoke': collections.revokeConsent,

  // ── 消息 ──
  'notifications/list': notifications.list,
  'notifications/read-all': notifications.markAllRead,
  'notifications/unread-count': notifications.unreadCount,

  // ── 搜索 ──
  'search/query': search.search,
  'search/suggestions': search.suggestions,
  'search/private': search.searchPrivate,

  // ── 媒体 ──
  'assets/intent': assets.createIntent,
  'assets/upload': assets.uploadImage,
  'assets/confirm': assets.confirmUpload,
  'assets/status': assets.getStatus,

  // ── 管理台（服务端按角色鉴权，与前端是否隐藏入口无关）──
  'admin/queue': moderation.listQueue,
  'admin/content/decide': moderation.decideContent,
  'admin/comment/decide': moderation.decideComment,
  'admin/topic/decide': moderation.decideTopic,
  'admin/membership/decide': moderation.decideMembership,
  'admin/report/decide': moderation.decideReport,
  'admin/collection/decide': moderation.decideCollection,
  'admin/anonymous/reveal': moderation.revealAnonymous,
  'admin/security/check': operations.securityCheck,
  'admin/usage/status': usage.getStatus,
  'admin/members/list': governance.listMembers,
  'admin/invites/create': governance.createInvite,
  'admin/member/remove': governance.removeMember,
  'admin/member/mute': governance.muteMember,
  'admin/member/role': governance.changeMemberRole,
  'appeals/create': governance.createAppeal,
  'appeals/mine': governance.listMyAppeals,
  'admin/appeals/list': governance.listAppeals,
  'admin/appeal/decide': governance.decideAppeal,
};

exports.main = createRouter(handlers, { name: 'api' });
exports.handlers = handlers;
