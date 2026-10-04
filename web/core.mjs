export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function safeUrl(value) {
  if (typeof value !== 'string' || !value || value.startsWith('//')) return '';
  if (value.startsWith('/') && !value.includes('\\')) return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
export function createScope() {
  let sequence = 0;
  let club = '';
  return { begin(clubId) { club = clubId; sequence += 1; return { sequence, club }; }, current(token) { return token?.sequence === sequence && token?.club === club; } };
}
export function idempotencyKey(draft, payload) {
  const fingerprint = JSON.stringify(payload);
  if (draft.fingerprint !== fingerprint) { draft.fingerprint = fingerprint; draft.key = crypto.randomUUID(); }
  return draft.key;
}
export function routeUrl(name, id = '', query = {}) {
  const params = new URLSearchParams(query);
  return `#/${name}${id ? `/${encodeURIComponent(id)}` : ''}${params.size ? `?${params}` : ''}`;
}
// Login continuations and reading return links can only select app routes.
// Never pass a supplied URL directly to location or an anchor.
const INTERNAL_ROUTES = new Set(['home', 'clubs', 'join', 'privacy', 'me', 'settings', 'confirmations', 'write', 'resubmit', 'contents', 'messages', 'appeals', 'search', 'topics', 'boards', 'collections', 'topic', 'board', 'collection', 'post', 'profile']);
const ID_ROUTES = new Set(['resubmit', 'topic', 'board', 'collection', 'post', 'profile']);
export function parseInternalRoute(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^#\/[a-z]+(?:\/[^/?#]+)?(?:\?[^#]*)?$/.test(value)) return null;
  try {
    const [path, search = ''] = value.slice(2).split('?');
    const [name, encodedId = ''] = path.split('/');
    if (!INTERNAL_ROUTES.has(name)) return null;
    const id = decodeURIComponent(encodedId);
    if (['.', '..'].includes(id) || (ID_ROUTES.has(name) && !id)) return null;
    return { name, id, query: Object.fromEntries(new URLSearchParams(search)) };
  } catch { return null; }
}
export const labels = { public: '公开可见', club: '社内可见', private: '仅自己可见', pending: '等待审核', rejected: '需要修改', hidden: '暂时隐藏', published: '已发布', active: '已加入', removed: '资格已移除', none: '尚未加入', guest: '访客', member: '社员', admin: '审核员', moderator: '社团管理员', developer: '平台开发者' };
export function itemsOf(value) { return value?.items || value?.list || []; }
export function authorName(author) { return author?.isAnonymous ? author.alias || '树洞旅人' : author?.displayName || '社内成员'; }

export function mergeCommentPages(previous, next) {
  const merged = previous.map((item) => ({ ...item, replies: mergeCommentPages(item.replies || [], []) }));
  const positions = new Map(merged.map((item, index) => [item.id, index]));
  for (const item of next) {
    const index = positions.get(item.id);
    if (index === undefined) {
      positions.set(item.id, merged.length);
      merged.push({ ...item, replies: mergeCommentPages([], item.replies || []) });
    } else merged[index] = { ...merged[index], ...item, replies: mergeCommentPages(merged[index].replies || [], item.replies || []) };
  }
  return merged;
}
export async function collectPages(fetchPage, isCurrent = () => true) {
  const result = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = '';
  do {
    if (!isCurrent()) return [];
    if (seenCursors.has(cursor) || seenCursors.size >= 1000) throw new Error('分页状态异常，请刷新后重试');
    seenCursors.add(cursor);
    const page = await fetchPage(cursor);
    if (!isCurrent()) return [];
    for (const item of itemsOf(page)) {
      if (!seenIds.has(item.id)) { seenIds.add(item.id); result.push(item); }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}
