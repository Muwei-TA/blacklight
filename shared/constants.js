/**
 * 全局枚举与集合名。与前端 docs/04-data-model-and-api.md 的枚举保持一致。
 * 任何新增枚举值必须同时更新前端工程书，否则视为契约破坏。
 */

/** 云数据库集合名。统一前缀，避免与其他业务共用环境时冲突。 */
const COLLECTIONS = {
  users: 'hg_users',
  memberships: 'hg_memberships',
  posts: 'hg_posts',
  comments: 'hg_comments',
  reactions: 'hg_reactions',
  bookmarks: 'hg_bookmarks',
  topics: 'hg_topics',
  boards: 'hg_boards',
  topicFollows: 'hg_topic_follows',
  collections: 'hg_collections',
  collectionEntries: 'hg_collection_entries',
  consents: 'hg_consents',
  assets: 'hg_assets',
  notifications: 'hg_notifications',
  reports: 'hg_reports',
  reviewTasks: 'hg_review_tasks',
  auditLogs: 'hg_audit_logs',
  idempotency: 'hg_idempotency',
  anonymousIdentities: 'hg_anonymous_identities',
  membershipApplications: 'hg_membership_applications',
  inviteCodes: 'hg_invite_codes',
  clubConfig: 'hg_club_config',
};

/**
 * 受限集合：存放匿名映射、审计、举报人身份等。
 * 云数据库权限必须设为「仅管理端可读写」，且禁止在任何面向客户端的响应中出现其原始字段。
 */
const RESTRICTED_COLLECTIONS = [
  COLLECTIONS.anonymousIdentities,
  COLLECTIONS.auditLogs,
  COLLECTIONS.reports,
  COLLECTIONS.idempotency,
  COLLECTIONS.inviteCodes,
];

const POST_KIND = { FRAGMENT: 'fragment', ARTICLE: 'article', EVENT: 'event' };

const VISIBILITY = { PUBLIC: 'public', CLUB: 'club', PRIVATE: 'private' };

const IDENTITY_MODE = { NAMED: 'named', ANONYMOUS: 'anonymous' };

const POST_STATUS = {
  DRAFT: 'draft',
  UPLOADING: 'uploading',
  PENDING: 'pending',
  PUBLISHED: 'published',
  REJECTED: 'rejected',
  HIDDEN: 'hidden',
  DELETED: 'deleted',
  SUPERSEDED: 'superseded',
};

const TOPIC_STATUS = { PENDING: 'pending', ACTIVE: 'active', ARCHIVED: 'archived' };

const BOARD_STATUS = { PENDING: 'pending', ACTIVE: 'active', REJECTED: 'rejected' };

const ROLE = { GUEST: 'guest', MEMBER: 'member', ADMIN: 'admin', MODERATOR: 'moderator' };

const MEMBER_STATUS = {
  NONE: 'none',
  PENDING: 'pending',
  ACTIVE: 'active',
  REJECTED: 'rejected',
  REMOVED: 'removed',
};

const ASSET_STATUS = {
  INTENT: 'intent',
  UPLOADED: 'uploaded',
  VERIFYING: 'verifying',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  FAILED: 'failed',
};

const NOTIFY_TYPE = {
  COMMENT: 'comment',
  REPLY: 'reply',
  REACTION_DIGEST: 'reaction_digest',
  SYSTEM_REVIEW: 'system_review',
  SYSTEM_REPORT: 'system_report',
  SYSTEM_COLLECTION: 'system_collection',
  SYSTEM_MEMBERSHIP: 'system_membership',
  SYSTEM_NOTICE: 'system_notice',
};

const REVIEW_TASK_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  PASSED: 'passed',
  SUSPECT: 'suspect',
  FAILED: 'failed',
  MANUAL: 'manual',
};

const CONTENT_LIMITS = {
  fragmentBody: 2000,
  articleTitle: 60,
  articleBody: 20000,
  commentBody: 1000,
  topicTitle: 40,
  topicDescription: 200,
  imageCount: 9,
  imageSize: 10 * 1024 * 1024,
  videoCount: 1,
  videoSize: 30 * 1024 * 1024,
  videoDuration: 60,
  displayName: 20,
  pageSize: 20,
  maxPageSize: 50,
};

/** 首版单社团。保留 clubId 便于边界测试，但不建设多租户。 */
const DEFAULT_CLUB_ID = 'heiguang';

module.exports = {
  COLLECTIONS,
  RESTRICTED_COLLECTIONS,
  POST_KIND,
  VISIBILITY,
  IDENTITY_MODE,
  POST_STATUS,
  TOPIC_STATUS,
  BOARD_STATUS,
  ROLE,
  MEMBER_STATUS,
  ASSET_STATUS,
  NOTIFY_TYPE,
  REVIEW_TASK_STATUS,
  CONTENT_LIMITS,
  DEFAULT_CLUB_ID,
};
