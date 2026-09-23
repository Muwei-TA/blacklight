/**
 * 展示层转换：数据库文档 → 客户端 DTO。
 *
 * ⚠️ 这是防止隐私泄露的最后一道闸门。硬约束：
 * 1. 匿名内容的响应中 author.userId 必须为 null，且不得出现 ownerId。
 * 2. 任何 DTO 都不得携带 anonymousIdentity、reporterId、审计字段。
 * 3. 不允许"先把整个文档 spread 出去再删几个字段"——必须白名单显式构造。
 */

const { IDENTITY_MODE, POST_STATUS, VISIBILITY } = require('./constants');
const { computePostViewerFlags } = require('./policies');

function toMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 相对时间文案。历史内容按真实日期呈现，不制造"当前活跃"的错觉。 */
function formatRelativeTime(value, now = Date.now()) {
  const ts = toMillis(value);
  if (!ts) return '';
  const diff = now - ts;
  const date = new Date(ts);
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;

  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return `今天 ${time}`;
  if (date.toDateString() === new Date(now - DAY).toDateString()) return `昨天 ${time}`;
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function excerpt(text = '', max = 140) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * 构造作者展示对象。
 * 匿名时只返回 alias，userId 强制为 null —— 客户端因此无法拼出主页链接。
 */
function presentAuthor({ post, authorUser, alias }) {
  if (post.identityMode === IDENTITY_MODE.ANONYMOUS) {
    return {
      userId: null,
      displayName: null,
      avatar: '',
      isAnonymous: true,
      alias: alias || '树洞旅人',
    };
  }
  return {
    userId: post.ownerId,
    displayName: (authorUser && authorUser.displayName) || '社内成员',
    avatar: (authorUser && authorUser.avatar) || '',
    isAnonymous: false,
    alias: null,
  };
}

/** 仅本人可见的状态文案；其他人拿不到这条内容，因此不会看到 */
function presentStatusText(post, viewer) {
  if (!viewer.userId || post.ownerId !== viewer.userId) return null;
  if (post.status === POST_STATUS.PENDING) return '已收到，等待审核';
  if (post.status === POST_STATUS.REJECTED) {
    return post.rejectReason ? `需要修改：${post.rejectReason}` : '需要修改';
  }
  if (post.status === POST_STATUS.UPLOADING) return '附件处理中';
  return null;
}

/**
 * 媒体展示。私有桶文件必须通过带鉴权的临时链接暴露，
 * 且 ready=false 时不返回可播放 url，防止绕过审核直接取流。
 */
function presentMedia(post, assets = []) {
  const byId = new Map(assets.map((a) => [a._id, a]));
  const bound = (post.assetIds || []).map((id) => byId.get(id)).filter(Boolean);

  const images = bound.filter((a) => a.mediaType === 'image');
  const video = bound.find((a) => a.mediaType === 'video');

  if (video) {
    const ready = video.status === 'verified';
    return {
      type: 'video',
      images: [],
      count: 0,
      video: {
        // 未通过审核不给 url，只给封面
        url: ready ? video.tempFileURL || '' : '',
        cover: video.coverURL || '',
        duration: video.duration || 0,
        ready,
      },
    };
  }

  if (images.length > 0) {
    const readyImages = images.filter((a) => a.status === 'verified');
    return {
      type: 'image',
      images: readyImages.map((a) => a.tempFileURL || '').filter(Boolean),
      count: readyImages.length,
      video: null,
    };
  }

  return { type: null, images: [], count: 0, video: null };
}

/**
 * 列表卡片 DTO。字段与前端 docs/04 的 PostCardDTO 严格对应。
 */
function presentPostCard(post, context = {}) {
  const { viewer, authorUser, alias, assets, topic, reacted, bookmarked, now } = context;
  return {
    id: post._id,
    version: post.version || 1,
    kind: post.kind,
    category: post.category || '',
    categoryText: post.categoryText || '',
    title: post.title || '',
    excerpt: excerpt(post.body, post.kind === 'article' ? 80 : 140),
    createdAtText: formatRelativeTime(post.createdAt, now),
    visibility: post.visibility,
    identityMode: post.identityMode,
    author: presentAuthor({ post, authorUser, alias }),
    topic: topic ? { id: topic._id, title: topic.title } : null,
    media: presentMedia(post, assets),
    event: post.event || null,
    counters: {
      reactions: post.reactionCount || 0,
      comments: post.commentCount || 0,
    },
    viewer: computePostViewerFlags(viewer, post, { reacted, bookmarked }),
    status: post.status,
    statusText: presentStatusText(post, viewer),
  };
}

/** 详情 DTO：在卡片基础上补正文、段落、版本 */
function presentPostDetail(post, context = {}) {
  const card = presentPostCard(post, context);
  return {
    ...card,
    body: post.body || '',
    // 段落由服务端切分，前端只渲染，首版不支持任意 HTML
    paragraphs: String(post.body || '')
      .split(/\n{2,}/)
      .filter((p) => p.length > 0),
    commentsEnabled: post.commentsEnabled !== false,
    version: post.version || 1,
    consent: { collectionGranted: !!context.collectionGranted },
  };
}

/** 评论 DTO。匿名评论同样不返回 userId。 */
function presentComment(comment, context = {}) {
  const { authorUser, alias, isAuthor = false, now, replies = [] } = context;
  const anonymous = comment.identityMode === IDENTITY_MODE.ANONYMOUS;
  return {
    id: comment._id,
    author: {
      userId: anonymous ? null : comment.ownerId,
      displayName: anonymous ? null : (authorUser && authorUser.displayName) || '社内成员',
      isAnonymous: anonymous,
      alias: anonymous ? alias || '树洞旅人' : null,
      isAuthor,
    },
    body: comment.body,
    createdAtText: formatRelativeTime(comment.createdAt, now),
    status: comment.status,
    replies,
  };
}

function presentTopic(topic, context = {}) {
  const { viewer, statsText = '', followed = false } = context;
  return {
    id: topic._id,
    title: topic.title,
    description: topic.description || '',
    category: topic.category || '',
    categoryText: topic.categoryText || '',
    icon: topic.icon || 'chat-bubble-1',
    // 访客不返回社内参与情况
    statsText: viewer && viewer.isMember ? statsText : '',
    followed,
    status: topic.status,
  };
}

function presentCollection(collection) {
  return {
    id: collection._id,
    title: collection.title,
    subtitle: collection.subtitle || '',
    no: collection.no || '',
    visibility: collection.visibility,
    tone: collection.tone || 'green',
    count: collection.entryCount || 0,
    intro: collection.intro || '',
  };
}

/**
 * 通知 DTO。文案中性化：目标不可访问时不泄露原标题与摘要。
 */
function presentNotification(notification, { accessible, now } = {}) {
  return {
    id: notification._id,
    type: notification.eventType,
    icon: notification.icon || 'notification',
    title: accessible ? notification.title : '相关内容已不可访问',
    summary: accessible ? notification.summary || '' : '',
    createdAtText: formatRelativeTime(notification.createdAt, now),
    read: !!notification.readAt,
    target: {
      type: notification.targetType,
      id: notification.targetId,
      ...(['admin_queue', 'admin_appeals'].includes(notification.targetType) ? { queue: notification.targetId } : {}),
      accessible: !!accessible,
    },
  };
}

function presentUser(user) {
  if (!user) return null;
  return {
    id: user._id,
    displayName: user.displayName || '',
    avatar: user.avatar || '',
  };
}

/** 会话 DTO。capabilities 由服务端下发，客户端只读。 */
function presentSession({ viewer, user, capabilities, club }) {
  return {
    role: viewer.role,
    memberStatus: viewer.memberStatus,
    user: presentUser(user),
    capabilities: {
      publishing: !!(capabilities && capabilities.publishing),
      uploads: !!(capabilities && capabilities.uploads),
      publicScope: !!(capabilities && capabilities.publicScope),
      video: !!(capabilities && capabilities.video),
      anthology: !!(capabilities && capabilities.anthology),
      export: !!(capabilities && capabilities.export),
    },
    club: club
      ? {
          name: club.name,
          slogan: club.slogan || '',
          intro: club.intro || '',
          rulesVersion: club.rulesVersion || 'v1.0',
        }
      : null,
  };
}

module.exports = {
  toMillis,
  formatRelativeTime,
  excerpt,
  presentAuthor,
  presentMedia,
  presentPostCard,
  presentPostDetail,
  presentComment,
  presentTopic,
  presentCollection,
  presentNotification,
  presentUser,
  presentSession,
  VISIBILITY,
};
