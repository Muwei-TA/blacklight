const WORKSPACES = [
  { id: 'overview', label: '概览与审核', eyebrow: '01' },
  { id: 'members', label: '成员', eyebrow: '02' },
  { id: 'invites', label: '邀请码', eyebrow: '03' },
  { id: 'settings', label: '社团设置', eyebrow: '04' },
  { id: 'team', label: '管理团队与换届', eyebrow: '05' },
  { id: 'audit', label: '操作审计', eyebrow: '06' },
  { id: 'platform', label: '平台管理', eyebrow: '07' },
];

const MODERATOR_WORKSPACES = new Set(['members', 'invites', 'settings', 'team', 'audit']);

const REVIEW_ACTIONS_BY_QUEUE = {
  content: [
    { key: 'approve', label: '通过', requiresReason: false, maxReasonLength: 200 },
    { key: 'reject', label: '退回修改', requiresReason: true, maxReasonLength: 200 },
    { key: 'hide', label: '暂时隐藏', requiresReason: true, maxReasonLength: 200 },
  ],
  comment: [
    { key: 'approve', label: '通过回应', requiresReason: false, maxReasonLength: 200 },
    { key: 'reject', label: '退回回应', requiresReason: true, maxReasonLength: 200 },
    { key: 'hide', label: '隐藏回应', requiresReason: true, maxReasonLength: 200 },
  ],
  topic: [
    { key: 'approve', label: '通过话题', requiresReason: false, maxReasonLength: 200 },
    { key: 'archive', label: '归档', requiresReason: true, maxReasonLength: 200 },
    { key: 'reject', label: '退回话题', requiresReason: true, maxReasonLength: 200 },
  ],
  board: [
    { key: 'approve', label: '通过板块', requiresReason: false, maxReasonLength: 200 },
    { key: 'reject', label: '退回板块', requiresReason: true, maxReasonLength: 200 },
  ],
  member: [
    { key: 'approve', label: '批准加入 / 恢复资格', requiresReason: false, maxReasonLength: 200 },
    { key: 'reject', label: '拒绝申请', requiresReason: true, maxReasonLength: 200 },
  ],
  report: [
    { key: 'keep', label: '保留内容', requiresReason: true, maxReasonLength: 200 },
    { key: 'hide', label: '暂时隐藏', requiresReason: true, maxReasonLength: 200 },
    { key: 'escalate', label: '升级处理', requiresReason: true, maxReasonLength: 200 },
  ],
  collection: [
    { key: 'include', label: '收录', requiresReason: false, maxReasonLength: 200 },
    { key: 'skip', label: '暂不收录', requiresReason: true, maxReasonLength: 200 },
  ],
  appeals: [
    { key: 'approve', label: '批准并重新待审', requiresReason: true, maxReasonLength: 500 },
    { key: 'reject', label: '驳回申诉', requiresReason: true, maxReasonLength: 500 },
  ],
};

const REVIEWABLE_STATUSES = {
  content: new Set(['pending']),
  comment: new Set(['pending']),
  topic: new Set(['pending']),
  board: new Set(['pending']),
  member: new Set(['pending']),
  report: new Set(['received']),
  collection: new Set(['queued']),
  appeals: new Set(['submitted']),
};

function reviewActionsFor(item = {}) {
  const queue = item.queue || item.type;
  const actions = REVIEW_ACTIONS_BY_QUEUE[queue];
  const allowedStatuses = REVIEWABLE_STATUSES[queue];
  if (!actions || !allowedStatuses) return [];
  if (item.status && !allowedStatuses.has(item.status)) return [];
  if (queue === 'content' && item.kind && !['article', 'fragment'].includes(item.kind)) return [];
  return actions.map((action) => ({ ...action }));
}

async function collectPagedItems(fetchPage, { limit = 100, maxPages = 50, isCurrent = () => true } = {}) {
  const items = [];
  const seenCursors = new Set();
  let cursor = '';
  for (let page = 0; page < maxPages; page += 1) {
    if (!isCurrent()) return { items, complete: false, reason: 'stale' };
    const result = await fetchPage({ limit, ...(cursor ? { cursor } : {}) });
    if (!isCurrent()) return { items, complete: false, reason: 'stale' };
    if (!result) return { items, complete: false, reason: 'invalid_page' };
    const { items: pageItems, nextCursor } = result;
    if (!Array.isArray(pageItems)) return { items, complete: false, reason: 'invalid_page' };
    items.push(...pageItems);
    if (nextCursor === undefined || nextCursor === null || nextCursor === '') return { items, complete: true, reason: '' };
    if (typeof nextCursor !== 'string') return { items, complete: false, reason: 'invalid_cursor' };
    if (seenCursors.has(nextCursor)) return { items, complete: false, reason: 'cursor_cycle' };
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return { items, complete: false, reason: 'page_limit' };
}

function activeTeamCandidates(memberItems = [], currentTeam = []) {
  const byUserId = new Map();
  [...memberItems, ...currentTeam].forEach((member) => {
    if (!member || member.status !== 'active' || typeof member.targetUserId !== 'string' || !member.targetUserId) return;
    byUserId.set(member.targetUserId, { ...byUserId.get(member.targetUserId), ...member });
  });
  return [...byUserId.values()].sort((left, right) => (
    String(left.displayName || left.targetUserId).localeCompare(String(right.displayName || right.targetUserId))
  ));
}

function retainableInvites(invites = []) {
  return invites.filter((invite) => invite && invite.status === 'active' && invite.mode === 'application');
}

function logoutFailureView(error = {}) {
  if (error.status === 401) {
    return { kind: 'expired', view: 'login', message: '管理会话已过期，请重新扫码登录。' };
  }
  return { kind: 'error', view: 'shell', message: error.message || '退出登录未完成。' };
}

function clearExpiredSessionState(state) {
  Object.assign(state, {
    session: null,
    clubId: '',
    platformClubId: '',
    view: 'overview',
    dataByView: {},
    pagination: {},
    loadingView: false,
    viewError: '',
    banner: '',
    bannerKind: 'notice',
    oneTimeCode: '',
    oneTimeInvite: null,
  });
}

function currentClub(session, clubId) {
  if (!session || !Array.isArray(session.clubs)) return null;
  return session.clubs.find((club) => (club.id || club.clubId) === clubId && (!club.status || club.status === 'active')) || null;
}

function canSeeWorkspace(view, session, clubId) {
  if (view === 'platform') return !!session && session.platformRole === 'developer';
  const membership = currentClub(session, clubId);
  if (!membership) return false;
  if (view === 'overview') return membership.role === 'admin' || membership.role === 'moderator';
  if (MODERATOR_WORKSPACES.has(view)) return membership.role === 'moderator';
  return false;
}

function visibleWorkspaces(session, clubId) {
  return WORKSPACES.filter((item) => canSeeWorkspace(item.id, session, clubId));
}

function createClubRequestScope(initialClubId = '') {
  let clubId = initialClubId;
  let generation = 0;
  let sequence = 0;

  return {
    setClub(nextClubId) {
      if (nextClubId !== clubId) {
        clubId = nextClubId;
        generation += 1;
        sequence += 1;
      }
      return { clubId, generation };
    },
    begin() {
      sequence += 1;
      return { clubId, generation, sequence };
    },
    isCurrent(token) {
      return !!token && token.clubId === clubId && token.generation === generation && token.sequence === sequence;
    },
    currentClubId() {
      return clubId;
    },
  };
}

function createOneTimeCodePresenter() {
  let shown = false;
  let current = '';
  return {
    reveal(code) {
      if (shown || typeof code !== 'string' || !code) return '';
      shown = true;
      current = code;
      return current;
    },
    value() {
      return current;
    },
    clear() {
      current = '';
    },
  };
}

function createPairingView(data, origin) {
  if (!data || typeof data.id !== 'string' || typeof data.pollKey !== 'string' || !data.pollKey
    || data.qrText !== `blacklight-admin:${data.id}` || typeof data.qrSvg !== 'string'
    || typeof data.expiresAt !== 'string' || !data.expiresAt) {
    throw new Error('登录二维码响应不完整');
  }
  const sourceOrigin = new URL(origin).origin;
  if (!sourceOrigin) throw new Error('Web 来源无效');
  return {
    id: data.id,
    qrText: data.qrText,
    qrSvg: data.qrSvg,
    expiresAt: data.expiresAt,
    pollKey: data.pollKey,
    origin: sourceOrigin,
  };
}

function escapeHTML(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

globalThis.AdminCore = {
  WORKSPACES,
  canSeeWorkspace,
  visibleWorkspaces,
  reviewActionsFor,
  collectPagedItems,
  activeTeamCandidates,
  retainableInvites,
  logoutFailureView,
  clearExpiredSessionState,
  createClubRequestScope,
  createOneTimeCodePresenter,
  createPairingView,
  escapeHTML,
};
