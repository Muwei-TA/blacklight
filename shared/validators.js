/**
 * 入参校验。所有客户端输入必须先过这里，再进入领域逻辑。
 * 服务端校验是唯一有效的校验：前端的限制只改善体验。
 */

const { CONTENT_LIMITS, POST_KIND, VISIBILITY, IDENTITY_MODE } = require('./constants');
const { invalidInput } = require('./errors');

function requireString(value, field, { max, min = 1, allowEmpty = false } = {}) {
  if (value === undefined || value === null) {
    if (allowEmpty) return '';
    throw invalidInput(`${field} 不能为空`, { field });
  }
  if (typeof value !== 'string') throw invalidInput(`${field} 格式不正确`, { field });
  const text = value.trim();
  if (!allowEmpty && text.length < min) throw invalidInput(`${field} 不能为空`, { field });
  if (max && value.length > max) throw invalidInput(`${field} 最多 ${max} 字`, { field, max });
  return text;
}

function requireEnum(value, field, allowed) {
  const values = Array.isArray(allowed) ? allowed : Object.values(allowed);
  if (!values.includes(value)) throw invalidInput(`${field} 取值不合法`, { field });
  return value;
}

function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 64) throw invalidInput(`${field} 格式不正确`, { field });
  return value;
}

function requireId(value, field) {
  const id = optionalId(value, field);
  if (!id) throw invalidInput(`${field} 不能为空`, { field });
  return id;
}

/** 分页游标：服务端生成的不透明串，这里只校验形状 */
function parseCursor(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 200) throw invalidInput('游标不合法', { field: 'cursor' });
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    if (!decoded || !Number.isFinite(decoded.createdAt) || !Number.isFinite(new Date(decoded.createdAt).getTime())
      || typeof decoded.id !== 'string' || !decoded.id || decoded.id.length > 64) {
      throw new Error('bad cursor shape');
    }
    return decoded;
  } catch (err) {
    throw invalidInput('游标不合法', { field: 'cursor' });
  }
}

function buildCursor(item) {
  if (!item) return null;
  const createdAt = typeof item.createdAt === 'number' ? item.createdAt : new Date(item.createdAt).getTime();
  if (!Number.isFinite(createdAt)) throw new Error('Cannot build cursor from invalid creation time');
  return Buffer.from(JSON.stringify({ createdAt, id: item._id }), 'utf8').toString('base64');
}

function clampPageSize(value) {
  // 缺省、0、非数字都回落到默认页大小；负数与超大值夹紧到合法区间
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw === 0) return CONTENT_LIMITS.pageSize;
  return Math.min(Math.max(1, Math.floor(Math.abs(raw))), CONTENT_LIMITS.maxPageSize);
}

/**
 * 校验发布内容。
 * 注意：不做"公开是否允许"的判断，那属于 policies.canUsePublicVisibility。
 */
function validatePostInput(payload = {}) {
  const kind = requireEnum(payload.kind, 'kind', POST_KIND);
  const visibility = requireEnum(payload.visibility, 'visibility', VISIBILITY);
  const identityMode = requireEnum(payload.identityMode || IDENTITY_MODE.NAMED, 'identityMode', IDENTITY_MODE);

  const body = requireString(payload.body, '正文', {
    max: kind === POST_KIND.ARTICLE ? CONTENT_LIMITS.articleBody : CONTENT_LIMITS.fragmentBody,
    allowEmpty: true,
  });

  let title = '';
  if (kind === POST_KIND.ARTICLE) {
    title = requireString(payload.title, '标题', { max: CONTENT_LIMITS.articleTitle });
  } else {
    title = requireString(payload.title, '标题', { max: CONTENT_LIMITS.articleTitle, allowEmpty: true });
  }

  const assetIds = Array.isArray(payload.assetIds) ? payload.assetIds.filter(Boolean) : [];
  if (assetIds.length > CONTENT_LIMITS.imageCount) {
    throw invalidInput(`一条内容最多 ${CONTENT_LIMITS.imageCount} 个附件`, { field: 'assetIds' });
  }

  // 纯文本、纯媒体都允许，但不能两者皆空
  if (!body && assetIds.length === 0) {
    throw invalidInput('写一点内容，或者选一张图片', { field: 'body' });
  }

  const topicId = optionalId(payload.topicId, 'topicId');
  const boardId = optionalId(payload.boardId, 'boardId');
  // 仅自己内容不得关联公共话题
  if (visibility === VISIBILITY.PRIVATE && topicId) {
    throw invalidInput('只有自己可见的内容不能关联话题', { field: 'topicId' });
  }
  if (visibility === VISIBILITY.PRIVATE && boardId) {
    throw invalidInput('只有自己可见的内容不能关联板块', { field: 'boardId' });
  }

  return {
    kind,
    title,
    body,
    assetIds,
    visibility,
    identityMode,
    topicId,
    boardId,
    commentsEnabled: visibility === VISIBILITY.PRIVATE ? false : payload.commentsEnabled !== false,
    collectionId: optionalId(payload.collectionId, 'collectionId'),
    consentGranted: payload.consentGranted === true,
  };
}

function validateCommentInput(payload = {}) {
  return {
    body: requireString(payload.body, '回应内容', { max: CONTENT_LIMITS.commentBody }),
    replyToId: optionalId(payload.replyToId, 'replyToId'),
    identityMode: requireEnum(payload.identityMode || IDENTITY_MODE.NAMED, 'identityMode', IDENTITY_MODE),
  };
}

function validateTopicInput(payload = {}) {
  return {
    title: requireString(payload.title, '话题名称', { max: CONTENT_LIMITS.topicTitle }),
    description: requireString(payload.description, '引导语', {
      max: CONTENT_LIMITS.topicDescription,
      allowEmpty: true,
    }),
    category: requireString(payload.category, '分类', { max: 20 }),
  };
}

function validateBoardInput(payload = {}) {
  return {
    title: requireString(payload.title, '板块名称', { max: CONTENT_LIMITS.topicTitle }),
    description: requireString(payload.description, '板块说明', {
      max: CONTENT_LIMITS.topicDescription,
      allowEmpty: true,
    }),
  };
}

/** 上传意图校验：类型、大小、时长。实际文件仍须在 uploaded 后二次校验。 */
function validateUploadIntent(payload = {}) {
  const mediaType = requireEnum(payload.mediaType, 'mediaType', ['image', 'video']);
  const size = Number(payload.size);
  if (!Number.isFinite(size) || size <= 0) throw invalidInput('文件大小不合法', { field: 'size' });

  if (mediaType === 'image') {
    if (size > CONTENT_LIMITS.imageSize) throw invalidInput('单张图片不能超过 10MB', { field: 'size' });
  } else {
    if (size > CONTENT_LIMITS.videoSize) throw invalidInput('视频源文件不能超过 30MB', { field: 'size' });
    const duration = Number(payload.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw invalidInput('视频时长不合法', { field: 'duration' });
    if (duration > CONTENT_LIMITS.videoDuration) {
      throw invalidInput('视频时长请控制在 60 秒内', { field: 'duration' });
    }
  }

  return {
    mediaType,
    size,
    duration: mediaType === 'video' ? Number(payload.duration) : 0,
    mimeType: requireString(payload.mimeType, 'mimeType', { max: 100 }),
  };
}

function validateDisplayName(value) {
  return requireString(value, '昵称', { max: CONTENT_LIMITS.displayName });
}

/** 搜索关键词：限制长度，且不做长期明文留存（见 docs 运维章） */
function validateSearchQuery(value) {
  const q = requireString(value, '搜索词', { max: 50 });
  if (q.length < 1) throw invalidInput('请输入搜索词', { field: 'q' });
  return q;
}

module.exports = {
  requireString,
  requireEnum,
  requireId,
  optionalId,
  parseCursor,
  buildCursor,
  clampPageSize,
  validatePostInput,
  validateCommentInput,
  validateTopicInput,
  validateBoardInput,
  validateUploadIntent,
  validateDisplayName,
  validateSearchQuery,
};
