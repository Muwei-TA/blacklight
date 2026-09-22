/**
 * 生成云数据库初始化清单（集合、索引、权限、种子数据）。
 *
 * 本脚本**不直接连云环境**，而是输出一份可执行清单与 tcb 命令，
 * 原因：数据库权限设置目前需要在控制台或通过 tcb CLI 交互完成，
 * 静默改权限风险过高（一次误操作就可能把受限集合设为"所有人可读"）。
 *
 *   node scripts/db-init.mjs            # 打印清单
 *   node scripts/db-init.mjs --json     # 输出 JSON 供其他工具消费
 */
import { COLLECTIONS, RESTRICTED_COLLECTIONS } from '../shared/constants.js';

/**
 * 权限模型说明：
 * - 'ADMINONLY'   仅管理端可读写（云函数以管理身份运行，客户端完全无法直读）
 * - 'READONLY'    所有人可读，仅管理端可写
 *
 * ⚠️ 本项目**所有集合都设为 ADMINONLY**。
 * 理由：客户端直读数据库无法实现 docs/05 的可见范围规则
 *      （小程序端的数据库权限粒度到不了"社内成员且已发布且非匿名映射"）。
 *      因此所有读写必须经由 api 云函数，前端不允许 wx.cloud.database() 直连。
 */
const PERMISSION = 'ADMINONLY';

const INDEXES = {
  [COLLECTIONS.users]: [
    { name: 'idx_openid', keys: [{ name: 'wxOpenIdRef', direction: '1' }], unique: true },
    { name: 'idx_status', keys: [{ name: 'status', direction: '1' }] },
  ],
  [COLLECTIONS.memberships]: [
    { name: 'idx_user_club', keys: [{ name: 'userId', direction: '1' }, { name: 'clubId', direction: '1' }], unique: true },
    { name: 'idx_club_status', keys: [{ name: 'clubId', direction: '1' }, { name: 'status', direction: '1' }] },
  ],
  [COLLECTIONS.posts]: [
    // 信息流主索引：过滤条件 + 游标排序字段必须在同一个复合索引里
    {
      name: 'idx_feed',
      keys: [
        { name: 'clubId', direction: '1' },
        { name: 'status', direction: '1' },
        { name: 'visibility', direction: '1' },
        { name: 'createdAt', direction: '-1' },
      ],
    },
    { name: 'idx_owner', keys: [{ name: 'ownerId', direction: '1' }, { name: 'createdAt', direction: '-1' }] },
    { name: 'idx_topic', keys: [{ name: 'topicId', direction: '1' }, { name: 'createdAt', direction: '-1' }] },
    { name: 'idx_status_created', keys: [{ name: 'status', direction: '1' }, { name: 'createdAt', direction: '1' }] },
  ],
  [COLLECTIONS.comments]: [
    { name: 'idx_post', keys: [{ name: 'postId', direction: '1' }, { name: 'createdAt', direction: '1' }] },
    { name: 'idx_status', keys: [{ name: 'status', direction: '1' }, { name: 'createdAt', direction: '1' }] },
  ],
  [COLLECTIONS.reactions]: [
    { name: 'idx_user_post', keys: [{ name: 'userId', direction: '1' }, { name: 'postId', direction: '1' }], unique: true },
    { name: 'idx_digest', keys: [{ name: 'digested', direction: '1' }, { name: 'createdAt', direction: '1' }] },
  ],
  [COLLECTIONS.bookmarks]: [
    { name: 'idx_user_post', keys: [{ name: 'userId', direction: '1' }, { name: 'postId', direction: '1' }], unique: true },
    { name: 'idx_user_created', keys: [{ name: 'userId', direction: '1' }, { name: 'createdAt', direction: '-1' }] },
  ],
  [COLLECTIONS.topics]: [
    { name: 'idx_club_status', keys: [{ name: 'clubId', direction: '1' }, { name: 'status', direction: '1' }, { name: 'createdAt', direction: '-1' }] },
    { name: 'idx_title', keys: [{ name: 'clubId', direction: '1' }, { name: 'title', direction: '1' }] },
  ],
  [COLLECTIONS.topicFollows]: [
    { name: 'idx_user_topic', keys: [{ name: 'userId', direction: '1' }, { name: 'topicId', direction: '1' }], unique: true },
  ],
  [COLLECTIONS.collections]: [
    { name: 'idx_club_order', keys: [{ name: 'clubId', direction: '1' }, { name: 'order', direction: '1' }] },
  ],
  [COLLECTIONS.collectionEntries]: [
    { name: 'idx_collection_order', keys: [{ name: 'collectionId', direction: '1' }, { name: 'order', direction: '1' }] },
    { name: 'idx_post', keys: [{ name: 'postId', direction: '1' }] },
  ],
  [COLLECTIONS.consents]: [
    { name: 'idx_post_owner', keys: [{ name: 'postId', direction: '1' }, { name: 'ownerId', direction: '1' }] },
  ],
  [COLLECTIONS.assets]: [
    { name: 'idx_owner_status', keys: [{ name: 'ownerId', direction: '1' }, { name: 'status', direction: '1' }] },
    { name: 'idx_post', keys: [{ name: 'postId', direction: '1' }] },
    { name: 'idx_trace', keys: [{ name: 'traceId', direction: '1' }] },
    { name: 'idx_orphan', keys: [{ name: 'postId', direction: '1' }, { name: 'createdAt', direction: '1' }] },
  ],
  [COLLECTIONS.notifications]: [
    { name: 'idx_recipient', keys: [{ name: 'recipientId', direction: '1' }, { name: 'createdAt', direction: '-1' }] },
    { name: 'idx_unread', keys: [{ name: 'recipientId', direction: '1' }, { name: 'readAt', direction: '1' }] },
  ],
  [COLLECTIONS.reports]: [
    { name: 'idx_status', keys: [{ name: 'status', direction: '1' }, { name: 'createdAt', direction: '1' }] },
    { name: 'idx_target', keys: [{ name: 'targetType', direction: '1' }, { name: 'targetId', direction: '1' }] },
  ],
  [COLLECTIONS.reviewTasks]: [
    { name: 'idx_queue', keys: [{ name: 'status', direction: '1' }, { name: 'attempts', direction: '1' }, { name: 'createdAt', direction: '1' }] },
    { name: 'idx_target', keys: [{ name: 'targetType', direction: '1' }, { name: 'targetId', direction: '1' }] },
  ],
  [COLLECTIONS.auditLogs]: [
    { name: 'idx_actor', keys: [{ name: 'actorId', direction: '1' }, { name: 'createdAt', direction: '-1' }] },
    { name: 'idx_target', keys: [{ name: 'targetType', direction: '1' }, { name: 'targetId', direction: '1' }] },
  ],
  [COLLECTIONS.idempotency]: [
    { name: 'idx_created', keys: [{ name: 'createdAt', direction: '1' }] },
  ],
  [COLLECTIONS.anonymousIdentities]: [
    { name: 'idx_thread_user', keys: [{ name: 'threadId', direction: '1' }, { name: 'userId', direction: '1' }], unique: true },
    { name: 'idx_thread_author', keys: [{ name: 'threadId', direction: '1' }, { name: 'isThreadAuthor', direction: '1' }] },
  ],
  [COLLECTIONS.membershipApplications]: [
    { name: 'idx_club_status', keys: [{ name: 'clubId', direction: '1' }, { name: 'status', direction: '1' }, { name: 'createdAt', direction: '1' }] },
    { name: 'idx_user', keys: [{ name: 'userId', direction: '1' }, { name: 'createdAt', direction: '-1' }] },
  ],
  [COLLECTIONS.inviteCodes]: [],
  [COLLECTIONS.clubConfig]: [],
};

/** 种子数据：能力开关默认全关（G0 未完成前不得开启公开与视频） */
const SEED = {
  [COLLECTIONS.clubConfig]: [
    {
      _id: 'heiguang',
      name: '黑光文学社',
      slogan: '留一盏灯，给每一种表达。',
      intro: '我们读一点、写一点，也允许什么都没写完。这里的内容默认只在社内可见。',
      rulesVersion: 'v1.0',
      capabilities: {
        publicScope: false,
        video: false,
        anthology: true,
        export: false,
      },
      searchSuggestions: ['晚霞', '未完成的灵感', '给三年前的自己', '最近读到的一句话'],
    },
  ],
};

const collections = Object.values(COLLECTIONS);
const payload = { permission: PERMISSION, collections, restricted: RESTRICTED_COLLECTIONS, indexes: INDEXES, seed: SEED };

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

console.log('# 云数据库初始化清单\n');
console.log(`集合总数：${collections.length}`);
console.log(`权限模型：全部 ${PERMISSION}（客户端不可直读，所有访问经 api 云函数）\n`);

console.log('## 1. 创建集合');
collections.forEach((name) => {
  const flag = RESTRICTED_COLLECTIONS.includes(name) ? '  ← 受限集合，严禁出现在任何客户端响应' : '';
  console.log(`tcb db:collection:create ${name}${flag}`);
});

console.log('\n## 2. 创建索引（在控制台「数据库 → 索引管理」逐集合添加）');
Object.entries(INDEXES).forEach(([name, list]) => {
  if (list.length === 0) return;
  console.log(`\n### ${name}`);
  list.forEach((idx) => {
    const keys = idx.keys.map((k) => `${k.name}:${k.direction}`).join(', ');
    console.log(`  - ${idx.name}  [${keys}]${idx.unique ? '  UNIQUE' : ''}`);
  });
});

console.log('\n## 3. 写入种子数据');
Object.entries(SEED).forEach(([name, docs]) => {
  console.log(`\n### ${name}`);
  docs.forEach((doc) => console.log(JSON.stringify(doc)));
});

console.log('\n## 4. 手动确认项（不由脚本执行）');
console.log('  [ ] 所有集合权限设为「仅管理端可读写」');
console.log('  [ ] 云存储桶设为私有，仅云函数可读写');
console.log('  [ ] 环境变量 ANON_ALIAS_SECRET 已配置（缺失时匿名功能会 fail-closed 报错）');
console.log('  [ ] 环境变量 REVIEW_CALLBACK_SECRET 已配置（HTTP 触发场景）');
console.log('  [ ] 首个管理员的 memberships.role 手动设为 admin/moderator');
console.log('  [ ] 邀请码写入 hg_invite_codes，含 expiresAt / maxUses');
