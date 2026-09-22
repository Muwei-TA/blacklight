/**
 * ⚠️ 权限规则的唯一实现。
 *
 * 规则来源：前端 docs/05-permission-privacy.md。本文件是纯函数，
 * 不访问数据库、不依赖 CloudBase SDK，因此可以被云函数、后台任务与单元测试共享。
 *
 * 硬约束：
 * 1. 任何地方判断"能否看见/能否操作"都必须调用本文件的函数，禁止在
 *    handler 或 repository 里另写一份 if (visibility === 'club')。
 * 2. 客户端传来的 ownerId / role / isMember 一律不可信，只接受
 *    由 buildViewer() 从服务端会话构造的 viewer 对象。
 * 3. 新增可见范围或角色时，必须同步更新 tests/policies.test.mjs 的越权用例。
 */

const { VISIBILITY, POST_STATUS, ROLE, MEMBER_STATUS, TOPIC_STATUS } = require('./constants');

/**
 * 构造访问者上下文。唯一合法的 viewer 来源。
 * @param {object} params
 * @param {string|null} params.userId 由 openid 解析出的内部用户 ID，未登录为 null
 * @param {string} params.role ROLE 枚举
 * @param {string} params.memberStatus MEMBER_STATUS 枚举
 * @param {string|null} params.clubId
 */
function buildViewer({
  userId = null,
  role = ROLE.GUEST,
  memberStatus = MEMBER_STATUS.NONE,
  clubId = null,
  mutedUntil = null,
} = {}) {
  const isActiveMember = memberStatus === MEMBER_STATUS.ACTIVE;
  return Object.freeze({
    userId,
    // 成员资格撤销后立即失去社内读写权，因此 role 也随 memberStatus 降级
    role: isActiveMember ? role : ROLE.GUEST,
    rawRole: role,
    memberStatus,
    clubId,
    mutedUntil,
    isAuthenticated: !!userId,
    isMember: isActiveMember,
    isAdmin: isActiveMember && (role === ROLE.ADMIN || role === ROLE.MODERATOR),
    isModerator: isActiveMember && role === ROLE.MODERATOR,
  });
}

const GUEST_VIEWER = buildViewer({});

/** 是否为内容作者。只接受服务端读出的 post.ownerId。 */
function isOwner(viewer, post) {
  return !!viewer.userId && !!post && post.ownerId === viewer.userId;
}

/**
 * 能否读取一条内容。这是整个系统最关键的判断。
 * @returns {boolean}
 */
function canReadPost(viewer, post) {
  if (!post) return false;

  // 已删除 / 已隐藏 / 已被新版本取代：一律不可读（作者也看不到旧版本正文）
  if (
    post.status === POST_STATUS.DELETED ||
    post.status === POST_STATUS.HIDDEN ||
    post.status === POST_STATUS.SUPERSEDED
  ) {
    // 例外：管理员在治理流程中需要读被隐藏内容
    return viewer.isAdmin && post.status === POST_STATUS.HIDDEN;
  }

  // 仅自己：只有本人；管理员默认也不可读
  if (post.visibility === VISIBILITY.PRIVATE) {
    return isOwner(viewer, post);
  }

  // 未发布（草稿/上传中/待审/退回）：只有本人可看状态与预览，管理员按队列另行判断
  if (post.status !== POST_STATUS.PUBLISHED) {
    return isOwner(viewer, post) || viewer.isAdmin;
  }

  if (post.visibility === VISIBILITY.PUBLIC) return true;

  if (post.visibility === VISIBILITY.CLUB) {
    // 作者退社后仍可通过"我的数据"访问自己的内容，但不再享有社内读权
    return viewer.isMember || isOwner(viewer, post);
  }

  // 未知 visibility 一律拒绝（fail-closed）
  return false;
}

/** 能否出现在信息流 / 话题 / 搜索 / 文集目录等聚合入口 */
function canListPost(viewer, post) {
  if (!post) return false;
  if (post.status !== POST_STATUS.PUBLISHED) return false;
  // 仅自己内容永不进入任何聚合入口，即使是本人查看信息流
  if (post.visibility === VISIBILITY.PRIVATE) return false;
  return canReadPost(viewer, post);
}

/** 能否互动（共鸣 / 收藏 / 评论）。需要成员资格且内容允许。 */
function canInteract(viewer, post) {
  if (!canReadPost(viewer, post)) return false;
  if (post.status !== POST_STATUS.PUBLISHED) return false;
  if (post.visibility === VISIBILITY.PRIVATE) return false;
  // 访客只能读公开内容，不能互动
  return viewer.isMember;
}

function canComment(viewer, post) {
  if (!canInteract(viewer, post)) return false;
  if (isMuted(viewer)) return false;
  return post.commentsEnabled !== false;
}

/** 可见范围等级：数字越大受众越广 */
const VISIBILITY_RANK = {
  [VISIBILITY.PRIVATE]: 1,
  [VISIBILITY.CLUB]: 2,
  [VISIBILITY.PUBLIC]: 3,
};

/**
 * 能否把内容改为目标范围。首版只允许缩小，禁止扩大。
 * 管理员也不能代作者扩大范围。
 */
function canChangeVisibility(viewer, post, nextVisibility) {
  if (!post) return false;
  if (!isOwner(viewer, post)) return false;
  const current = VISIBILITY_RANK[post.visibility];
  const next = VISIBILITY_RANK[nextVisibility];
  if (!current || !next) return false;
  return next < current;
}

/** 作者可删自己的内容；管理员走隐藏流程，不使用删除 */
function canDeletePost(viewer, post) {
  if (!post) return false;
  if (post.status === POST_STATUS.DELETED) return false;
  return isOwner(viewer, post);
}

/** 举报：不能举报自己的内容，也不能举报仅自己的内容 */
function canReportPost(viewer, post) {
  if (!canReadPost(viewer, post)) return false;
  if (post.visibility === VISIBILITY.PRIVATE) return false;
  if (isOwner(viewer, post)) return false;
  return viewer.isAuthenticated;
}

/** 能否发布内容：必须是有效成员 */
function canCreatePost(viewer) {
  return viewer.isMember && !isMuted(viewer);
}

/** 禁言由 session 注入 viewer.mutedUntil；过期后自动恢复，不依赖客户端状态。 */
function isMuted(viewer, now = Date.now()) {
  if (!viewer || !viewer.mutedUntil) return false;
  const until = new Date(viewer.mutedUntil).getTime();
  return Number.isFinite(until) && until > now;
}

/** 发布与上传熔断的唯一策略谓词；能力缺失时 fail-closed。 */
function canUsePublishing(viewer, capabilities) {
  return !!(viewer && viewer.isMember && !isMuted(viewer) && capabilities && capabilities.publishing === true);
}

function canUseUploads(viewer, capabilities) {
  return !!(viewer && viewer.isMember && !isMuted(viewer) && capabilities && capabilities.uploads === true);
}

/** 成员管理比普通治理队列更窄：必须是 active moderator，且不能操作自己。 */
function canManageMembers(viewer) {
  return !!(viewer && viewer.isModerator);
}

function canManageTargetMember(viewer, targetUserId) {
  return canManageMembers(viewer) && typeof targetUserId === 'string' && targetUserId.length > 0 && targetUserId !== viewer.userId;
}

/** 申诉只允许作者对自己被隐藏/退回的内容发起。 */
function canSubmitAppeal(viewer, post) {
  if (!viewer || !post || !viewer.userId || post.ownerId !== viewer.userId) return false;
  return post.status === POST_STATUS.HIDDEN || post.status === POST_STATUS.REJECTED;
}

function canDecideAppeal(viewer) {
  return canAccessModeration(viewer);
}

/**
 * 能否选择 public 范围。受服务端能力开关控制，G0 核验完成前一律 false。
 * @param {object} viewer
 * @param {object} capabilities 由 club_config 读出
 */
function canUsePublicVisibility(viewer, capabilities) {
  if (!viewer.isMember) return false;
  return !!(capabilities && capabilities.publicScope === true);
}

/** 能否上传视频：能力开关 + 成员资格 */
function canUploadVideo(viewer, capabilities) {
  if (!viewer.isMember) return false;
  return !!(capabilities && capabilities.video === true);
}

/** 话题可见性：待审话题只有提交者与管理员可见；归档话题可读不可投稿 */
function canReadTopic(viewer, topic) {
  if (!topic) return false;
  if (topic.status === TOPIC_STATUS.PENDING) {
    return (!!viewer.userId && topic.ownerId === viewer.userId) || viewer.isAdmin;
  }
  // 首版话题均为社内话题
  return viewer.isMember;
}

function canPostToTopic(viewer, topic) {
  if (!canReadTopic(viewer, topic)) return false;
  return topic.status === TOPIC_STATUS.ACTIVE && viewer.isMember;
}

/** 文集：社内文集仅成员可见；公开文集所有人可见 */
function canReadCollection(viewer, collection) {
  if (!collection) return false;
  if (collection.visibility === VISIBILITY.PUBLIC) return true;
  return viewer.isMember;
}

/**
 * 文集收录的范围校验：取交集。
 * 公开文集不接收社内原帖；编辑不得因收录而扩大原文范围。
 */
function canIncludeInCollection(collection, post) {
  if (!collection || !post) return false;
  if (post.status !== POST_STATUS.PUBLISHED) return false;
  if (post.visibility === VISIBILITY.PRIVATE) return false;
  // 文集受众不得超过原文受众
  return VISIBILITY_RANK[collection.visibility] <= VISIBILITY_RANK[post.visibility];
}

/** 管理队列访问权 */
function canAccessModeration(viewer) {
  return viewer.isAdmin;
}

/**
 * 匿名映射访问权。
 * 普通管理员默认不可读；必须是 moderator 且带明确理由，且调用方负责写审计日志。
 */
function canRevealAnonymousMapping(viewer, { reason } = {}) {
  if (!viewer.isModerator) return false;
  return typeof reason === 'string' && reason.trim().length >= 10;
}

/** 私密手记：任何角色都不能通过常规接口读他人私密内容 */
function canReadPrivateNoteOfOthers() {
  return false;
}

/**
 * 计算某条内容对当前 viewer 的 viewer.* 字段。
 * 前端只按这些字段渲染，不自行推断。
 */
function computePostViewerFlags(viewer, post, { reacted = false, bookmarked = false } = {}) {
  const owner = isOwner(viewer, post);
  return {
    reacted,
    bookmarked,
    canComment: canComment(viewer, post),
    isOwner: owner,
    canManage: owner,
    canShrinkVisibility: owner && VISIBILITY_RANK[post.visibility] > VISIBILITY_RANK[VISIBILITY.PRIVATE],
    canDelete: canDeletePost(viewer, post),
    canReport: canReportPost(viewer, post),
  };
}

module.exports = {
  buildViewer,
  GUEST_VIEWER,
  isOwner,
  canReadPost,
  canListPost,
  canInteract,
  canComment,
  canChangeVisibility,
  canDeletePost,
  canReportPost,
  canCreatePost,
  isMuted,
  canUsePublishing,
  canUseUploads,
  canManageMembers,
  canManageTargetMember,
  canSubmitAppeal,
  canDecideAppeal,
  canUsePublicVisibility,
  canUploadVideo,
  canReadTopic,
  canPostToTopic,
  canReadCollection,
  canIncludeInCollection,
  canAccessModeration,
  canRevealAnonymousMapping,
  canReadPrivateNoteOfOthers,
  computePostViewerFlags,
  VISIBILITY_RANK,
};
