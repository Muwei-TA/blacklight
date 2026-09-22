/**
 * 权限规则单元测试 —— 这是本仓库最重要的测试。
 *
 * 运行：node --test tests/
 *
 * 每个用例都对应 docs/05-permission-privacy.md 的一条规则。
 * 新增可见范围、角色或状态时，必须先在这里加用例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const policies = require('../shared/policies.js');
const { VISIBILITY, POST_STATUS, ROLE, MEMBER_STATUS, TOPIC_STATUS } = require('../shared/constants.js');
const { assertNoIdentityLeak } = require('../shared/anonymity.js');
const presenters = require('../shared/presenters.js');

const guest = policies.buildViewer({});
const member = policies.buildViewer({
  userId: 'u_member',
  role: ROLE.MEMBER,
  memberStatus: MEMBER_STATUS.ACTIVE,
});
const other = policies.buildViewer({
  userId: 'u_other',
  role: ROLE.MEMBER,
  memberStatus: MEMBER_STATUS.ACTIVE,
});
const admin = policies.buildViewer({
  userId: 'u_admin',
  role: ROLE.ADMIN,
  memberStatus: MEMBER_STATUS.ACTIVE,
});
const moderator = policies.buildViewer({
  userId: 'u_mod',
  role: ROLE.MODERATOR,
  memberStatus: MEMBER_STATUS.ACTIVE,
});
const removed = policies.buildViewer({
  userId: 'u_removed',
  role: ROLE.MEMBER,
  memberStatus: MEMBER_STATUS.REMOVED,
});

function makePost(overrides = {}) {
  return {
    _id: 'p1',
    ownerId: 'u_member',
    kind: 'fragment',
    title: '',
    body: '正文',
    visibility: VISIBILITY.CLUB,
    identityMode: 'named',
    status: POST_STATUS.PUBLISHED,
    version: 1,
    commentsEnabled: true,
    assetIds: [],
    reactionCount: 0,
    commentCount: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

test('访客不能读社内内容', () => {
  assert.equal(policies.canReadPost(guest, makePost()), false);
});

test('访客可以读已发布的公开内容', () => {
  assert.equal(policies.canReadPost(guest, makePost({ visibility: VISIBILITY.PUBLIC })), true);
});

test('成员可以读社内内容', () => {
  assert.equal(policies.canReadPost(member, makePost()), true);
});

test('被移除的成员立即失去社内读权', () => {
  // 关键：memberStatus 不是 active 时，buildViewer 会把 role 降级为 guest
  assert.equal(removed.isMember, false);
  assert.equal(removed.role, ROLE.GUEST);
  assert.equal(policies.canReadPost(removed, makePost({ ownerId: 'u_someone' })), false);
});

test('被移除的成员仍可访问自己的历史内容', () => {
  const own = makePost({ ownerId: 'u_removed' });
  assert.equal(policies.canReadPost(removed, own), true);
});

test('他人不能读仅自己的内容', () => {
  const priv = makePost({ visibility: VISIBILITY.PRIVATE });
  assert.equal(policies.canReadPost(other, priv), false);
  assert.equal(policies.canReadPost(guest, priv), false);
});

test('管理员也不能读他人的仅自己内容', () => {
  const priv = makePost({ visibility: VISIBILITY.PRIVATE });
  assert.equal(policies.canReadPost(admin, priv), false);
  assert.equal(policies.canReadPost(moderator, priv), false);
  assert.equal(policies.canReadPrivateNoteOfOthers(), false);
});

test('本人可以读自己的仅自己内容', () => {
  assert.equal(policies.canReadPost(member, makePost({ visibility: VISIBILITY.PRIVATE })), true);
});

test('仅自己内容永不进入任何聚合入口，本人也不例外', () => {
  const priv = makePost({ visibility: VISIBILITY.PRIVATE });
  assert.equal(policies.canListPost(member, priv), false);
});

test('待审内容不进聚合入口', () => {
  assert.equal(policies.canListPost(member, makePost({ status: POST_STATUS.PENDING })), false);
});

test('待审内容仅本人可预览', () => {
  const pending = makePost({ status: POST_STATUS.PENDING });
  assert.equal(policies.canReadPost(member, pending), true);
  assert.equal(policies.canReadPost(other, pending), false);
});

test('已删除内容任何人都不可读', () => {
  const deleted = makePost({ status: POST_STATUS.DELETED });
  assert.equal(policies.canReadPost(member, deleted), false);
  assert.equal(policies.canReadPost(admin, deleted), false);
});

test('已隐藏内容仅管理员在治理流程中可读', () => {
  const hidden = makePost({ status: POST_STATUS.HIDDEN });
  assert.equal(policies.canReadPost(member, hidden), false);
  assert.equal(policies.canReadPost(admin, hidden), true);
});

test('访客不能互动', () => {
  assert.equal(policies.canInteract(guest, makePost({ visibility: VISIBILITY.PUBLIC })), false);
});

test('关闭回应后不能评论', () => {
  assert.equal(policies.canComment(other, makePost({ commentsEnabled: false })), false);
});

test('仅自己内容不能互动', () => {
  assert.equal(policies.canInteract(member, makePost({ visibility: VISIBILITY.PRIVATE })), false);
});

test('可见范围只能缩小，不能扩大', () => {
  const clubPost = makePost();
  assert.equal(policies.canChangeVisibility(member, clubPost, VISIBILITY.PRIVATE), true);
  assert.equal(policies.canChangeVisibility(member, clubPost, VISIBILITY.PUBLIC), false);

  const privPost = makePost({ visibility: VISIBILITY.PRIVATE });
  assert.equal(policies.canChangeVisibility(member, privPost, VISIBILITY.CLUB), false);
  assert.equal(policies.canChangeVisibility(member, privPost, VISIBILITY.PUBLIC), false);
});

test('管理员不能代作者改可见范围', () => {
  assert.equal(policies.canChangeVisibility(admin, makePost(), VISIBILITY.PRIVATE), false);
});

test('只有作者能删除内容', () => {
  assert.equal(policies.canDeletePost(member, makePost()), true);
  assert.equal(policies.canDeletePost(other, makePost()), false);
  assert.equal(policies.canDeletePost(admin, makePost()), false);
});

test('不能举报自己的内容', () => {
  assert.equal(policies.canReportPost(member, makePost()), false);
  assert.equal(policies.canReportPost(other, makePost()), true);
});

test('公开范围受能力开关控制，关闭时不可用', () => {
  assert.equal(policies.canUsePublicVisibility(member, { publicScope: false }), false);
  assert.equal(policies.canUsePublicVisibility(member, { publicScope: true }), true);
  // capabilities 缺失时 fail-closed
  assert.equal(policies.canUsePublicVisibility(member, undefined), false);
  assert.equal(policies.canUsePublicVisibility(member, {}), false);
});

test('视频能力关闭时不可上传视频', () => {
  assert.equal(policies.canUploadVideo(member, { video: false }), false);
  assert.equal(policies.canUploadVideo(member, {}), false);
  assert.equal(policies.canUploadVideo(guest, { video: true }), false);
});

test('发布与上传熔断能力缺失时 fail-closed', () => {
  assert.equal(policies.canUsePublishing(member, { publishing: true }), true);
  assert.equal(policies.canUsePublishing(member, { publishing: false }), false);
  assert.equal(policies.canUsePublishing(member, undefined), false);
  assert.equal(policies.canUseUploads(member, { uploads: true }), true);
  assert.equal(policies.canUseUploads(member, { uploads: false }), false);
  assert.equal(policies.canUseUploads(guest, { uploads: true }), false);
});

test('禁言期间不能发帖和评论，过期后恢复', () => {
  const now = Date.now();
  const muted = policies.buildViewer({
    userId: 'u_member',
    role: ROLE.MEMBER,
    memberStatus: MEMBER_STATUS.ACTIVE,
    mutedUntil: new Date(now + 60_000).toISOString(),
  });
  assert.equal(policies.isMuted(muted, now), true);
  assert.equal(policies.canCreatePost(muted), false);
  assert.equal(policies.canComment(muted, makePost({ ownerId: 'u_other' })), false);
  assert.equal(policies.isMuted(muted, now + 61_000), false);
  assert.equal(policies.canCreatePost({ ...muted, mutedUntil: new Date(now - 1_000).toISOString() }), true);
});

test('成员管理只允许 moderator 且不能操作自己', () => {
  assert.equal(policies.canManageMembers(moderator), true);
  assert.equal(policies.canManageMembers(admin), false);
  assert.equal(policies.canManageTargetMember(moderator, 'u_member'), true);
  assert.equal(policies.canManageTargetMember(moderator, 'u_mod'), false);
});

test('申诉只允许作者对 hidden/rejected 内容发起', () => {
  assert.equal(policies.canSubmitAppeal(member, makePost({ status: POST_STATUS.HIDDEN })), true);
  assert.equal(policies.canSubmitAppeal(member, makePost({ status: POST_STATUS.REJECTED })), true);
  assert.equal(policies.canSubmitAppeal(other, makePost({ status: POST_STATUS.HIDDEN })), false);
  assert.equal(policies.canSubmitAppeal(member, makePost({ status: POST_STATUS.PUBLISHED })), false);
  assert.equal(policies.canDecideAppeal(admin), true);
});

test('待审话题只有提交者与管理员可见', () => {
  const pendingTopic = { _id: 't1', ownerId: 'u_member', status: TOPIC_STATUS.PENDING };
  assert.equal(policies.canReadTopic(member, pendingTopic), true);
  assert.equal(policies.canReadTopic(other, pendingTopic), false);
  assert.equal(policies.canReadTopic(admin, pendingTopic), true);
});

test('归档话题可读但不可投稿', () => {
  const archived = { _id: 't2', status: TOPIC_STATUS.ARCHIVED };
  assert.equal(policies.canReadTopic(member, archived), true);
  assert.equal(policies.canPostToTopic(member, archived), false);
});

test('访客看不到社内话题', () => {
  assert.equal(policies.canReadTopic(guest, { _id: 't3', status: TOPIC_STATUS.ACTIVE }), false);
});

test('公开文集不能收录社内原帖', () => {
  const publicCollection = { visibility: VISIBILITY.PUBLIC };
  const clubPost = makePost({ visibility: VISIBILITY.CLUB });
  assert.equal(policies.canIncludeInCollection(publicCollection, clubPost), false);

  const clubCollection = { visibility: VISIBILITY.CLUB };
  assert.equal(policies.canIncludeInCollection(clubCollection, clubPost), true);
  // 公开帖可进社内文集（受众取交集，不扩大）
  assert.equal(policies.canIncludeInCollection(clubCollection, makePost({ visibility: VISIBILITY.PUBLIC })), true);
});

test('仅自己内容不能被收录', () => {
  assert.equal(
    policies.canIncludeInCollection({ visibility: VISIBILITY.CLUB }, makePost({ visibility: VISIBILITY.PRIVATE })),
    false,
  );
});

test('普通成员不能访问管理队列', () => {
  assert.equal(policies.canAccessModeration(member), false);
  assert.equal(policies.canAccessModeration(admin), true);
  assert.equal(policies.canAccessModeration(guest), false);
});

test('匿名映射需要 moderator + 充分理由', () => {
  assert.equal(policies.canRevealAnonymousMapping(admin, { reason: '合规调查编号 2026-001' }), false);
  assert.equal(policies.canRevealAnonymousMapping(moderator, { reason: '太短' }), false);
  assert.equal(policies.canRevealAnonymousMapping(moderator, { reason: '合规调查编号 2026-001' }), true);
});

test('未知 visibility 一律拒绝（fail-closed）', () => {
  assert.equal(policies.canReadPost(member, makePost({ visibility: 'friends_only' })), false);
});

test('匿名内容的 DTO 中 author.userId 必须为 null', () => {
  const post = makePost({ identityMode: 'anonymous', ownerId: 'u_secret' });
  const dto = presenters.presentPostCard(post, {
    viewer: member,
    authorUser: { _id: 'u_secret', displayName: '真实昵称' },
    alias: '树洞旅人 07',
    assets: [],
    now: Date.now(),
  });

  assert.equal(dto.author.userId, null);
  assert.equal(dto.author.displayName, null);
  assert.equal(dto.author.alias, '树洞旅人 07');
  // 整个 DTO 不得含 ownerId 等禁用字段
  assert.doesNotThrow(() => assertNoIdentityLeak(dto, 'dto'));
});

test('泄露检测能抓出 ownerId 漏出', () => {
  assert.throws(() => assertNoIdentityLeak({ id: 'p1', ownerId: 'u_secret' }), /identity leak/);
});

test('泄露检测能抓出匿名作者带 userId 的情况', () => {
  assert.throws(
    () => assertNoIdentityLeak({ author: { isAnonymous: true, userId: 'u_secret' } }),
    /author\.userId/,
  );
});

test('未通过审核的视频不返回可播放 url', () => {
  const media = presenters.presentMedia({ assetIds: ['a1'] }, [
    { _id: 'a1', mediaType: 'video', status: 'verifying', tempFileURL: 'https://leak', coverURL: 'c', duration: 4 },
  ]);
  assert.equal(media.video.ready, false);
  assert.equal(media.video.url, '');
});

test('未通过审核的图片不出现在 images 中', () => {
  const media = presenters.presentMedia({ assetIds: ['a1', 'a2'] }, [
    { _id: 'a1', mediaType: 'image', status: 'verified', tempFileURL: 'ok' },
    { _id: 'a2', mediaType: 'image', status: 'verifying', tempFileURL: 'leak' },
  ]);
  assert.deepEqual(media.images, ['ok']);
  assert.equal(media.count, 1);
});

test('他人看不到本人的待审状态文案', () => {
  const pending = makePost({ status: POST_STATUS.PENDING });
  const forOwner = presenters.presentPostCard(pending, { viewer: member, assets: [], now: Date.now() });
  const forOther = presenters.presentPostCard(pending, { viewer: other, assets: [], now: Date.now() });
  assert.equal(forOwner.statusText, '已收到，等待审核');
  assert.equal(forOther.statusText, null);
});

test('viewer 标记由服务端计算，作者与他人不同', () => {
  const post = makePost();
  const ownerFlags = policies.computePostViewerFlags(member, post);
  const otherFlags = policies.computePostViewerFlags(other, post);

  assert.equal(ownerFlags.isOwner, true);
  assert.equal(ownerFlags.canDelete, true);
  assert.equal(ownerFlags.canReport, false);

  assert.equal(otherFlags.isOwner, false);
  assert.equal(otherFlags.canDelete, false);
  assert.equal(otherFlags.canReport, true);
});

test('hidden private notes remain inaccessible to admins', () => {
  const post = makePost({ visibility: VISIBILITY.PRIVATE, status: POST_STATUS.HIDDEN });
  assert.equal(policies.canReadPost(admin, post), false);
  assert.equal(policies.canReadPost(moderator, post), false);
});
