import { createApi } from './api.mjs';
import { createScope, itemsOf, routeUrl, mergeCommentPages, collectPages, shouldClearSelectedClubPreference } from './core.mjs';
import { shell } from './views.mjs';
import { createFlows } from './flows.mjs';

const api = createApi();
const root = document.querySelector('#app');
const scope = createScope();
const state = { account: null, session: null, clubs: { list: [] }, clubId: '', route: { name: 'clubs', id: '', query: {} }, page: null, loading: true, error: '', unread: 0 };
let activeToken;
let paginationBusy = false;
let dirty = false;
let toastTimer;
function parseRoute() {
  try {
    const [pathname, search = ''] = (location.hash.slice(1) || '/clubs').split('?');
    const parts = pathname.split('/').filter(Boolean);
    return { name: parts[0] || 'clubs', id: decodeURIComponent(parts[1] || ''), query: Object.fromEntries(new URLSearchParams(search)) };
  } catch { return { name: 'missing', id: '', query: {} }; }
}
function render() {
  root.innerHTML = shell(state);
  document.title = state.session?.club?.name ? `${state.session.club.name} · 社团树洞` : '社团树洞';
  if (['write', 'resubmit'].includes(state.route.name) && !state.loading && !state.error) {
    const form = root.querySelector('form');
    if (state.route.name === 'resubmit' && form?.elements.body) form.elements.body.value = state.page?.post?.body || '';
    if (form?.elements.topicId) form.elements.topicId.value = state.route.query.topicId || '';
    if (form?.elements.boardId) form.elements.boardId.value = state.route.query.boardId || '';
  }
}
function toast(message) {
  clearTimeout(toastTimer);
  document.querySelector('#toast').textContent = message;
  toastTimer = setTimeout(() => { document.querySelector('#toast').textContent = ''; }, 6000);
}
function navigate(name, id = '', query = {}) {
  const hash = routeUrl(name, id, query);
  dirty = false;
  if (location.hash === hash) loadRoute();
  else location.hash = hash;
}
function captureReply(clubId = state.clubId, postId = state.route.id) {
  const form = root.querySelector('form[data-form="comment"]');
  if (!form || form.dataset.club !== clubId || form.dataset.postId !== postId) return null;
  return { body: form.elements.body.value, replyToId: form.elements.replyToId.value, anonymous: form.elements.anonymous.checked, target: form.querySelector('#reply-target').textContent };
}
function restoreReply(draft) {
  const form = root.querySelector('form[data-form="comment"]');
  if (!draft || !form) return;
  form.elements.body.value = draft.body;
  form.elements.replyToId.value = draft.replyToId;
  form.elements.anonymous.checked = draft.anonymous;
  form.querySelector('#reply-target').textContent = draft.target;
  form.querySelector('#reply-context').hidden = !draft.replyToId;
}
async function refreshAccount() {
  const token = activeToken;
  const requestedClub = state.clubId;
  const account = await api.session();
  const clubs = account.authenticated ? await api.action('clubs/mine', '') : { list: [] };
  const selectedClub = requestedClub || itemsOf(clubs).find((club) => club.status === 'active')?.id || '';
  let session = null;
  if (selectedClub) {
    try {
      session = await api.action('session/me', selectedClub);
    } catch (error) {
      if (shouldClearSelectedClubPreference(error, requestedClub, state.clubId)
        && (!token || scope.current(token))) {
        try { localStorage.removeItem('blacklight.selectedClub'); } catch { /* storage may be disabled */ }
        state.account = account;
        state.clubs = clubs;
        state.clubId = '';
        state.session = null;
        state.page = null;
        state.unread = 0;
        return { invalidSelectedClub: true };
      }
      throw error;
    }
  }
  if (token && !scope.current(token)) return { invalidSelectedClub: false };
  if (state.clubId !== requestedClub) return { invalidSelectedClub: false };
  state.account = account;
  state.clubs = clubs;
  state.clubId = selectedClub;
  state.session = session;
  return { invalidSelectedClub: false };
}
async function readPage(route, clubId, session, cursor = '', isCurrent = () => true) {
  const action = (name, payload = {}) => api.action(name, clubId, { ...payload, ...(cursor ? { cursor } : {}) });
  switch (route.name) {
    case 'home': return action('posts/list', route.id === 'awaiting_reply' ? { filter: 'awaiting_reply' } : {});
    case 'topics': return action('topics/list');
    case 'boards': return action('boards/list');
    case 'collections': return action('collections/list');
    case 'topic': return action('topics/detail', { id: route.id });
    case 'board': return action('boards/detail', { id: route.id });
    case 'post': {
      const post = await action('posts/detail', { id: route.id });
      const comments = post.status === 'published' && post.commentsEnabled ? await action('posts/comments/list', { id: route.id }) : { items: [] };
      return { post, comments };
    }
    case 'collection': {
      const page = await action('collections/detail', { id: route.id });
      if (page.canSubmit) page.ownPosts = await collectPages((nextCursor) => api.action('me/contents', clubId, { tab: 'published', pageSize: 50, cursor: nextCursor }), isCurrent);
      return page;
    }
    case 'clubs': {
      const [directory, mine] = await Promise.all([api.action('clubs/list', ''), state.account?.authenticated ? api.action('clubs/mine', '') : Promise.resolve({ list: [] })]);
      return { directory, mine };
    }
    case 'join': {
      const [club, application] = await Promise.all([action('clubs/detail', { id: clubId }), state.account?.authenticated ? action('membership/mine') : Promise.resolve(null)]);
      return { club, application };
    }
    case 'write': {
      if (session?.memberStatus !== 'active' || !session.capabilities?.publishing) return {};
      const [topics, boards] = await Promise.all([action('topics/list', { pageSize: 100 }), action('boards/list', { pageSize: 100 })]);
      return { topics: itemsOf(topics), boards: itemsOf(boards) };
    }
    case 'resubmit': return { post: await action('posts/detail', { id: route.id }) };
    case 'contents': return action('me/contents', { tab: route.id || 'published' });
    case 'messages': return action('notifications/list', { tab: route.id || 'reply' });
    case 'search': return route.query.q ? action('search/query', { q: route.query.q, scope: 'post' }) : {};
    case 'me': return state.account?.authenticated && session?.memberStatus === 'active' ? { levels: await action('me/levels') } : {};
    case 'profile': return action('profile/get', { targetUserId: route.id });
    case 'appeals': return action('appeals/mine');
    case 'confirmations': {
      const [handovers, recoveries] = await Promise.all([api.action('account/handovers/list', '', { limit: 100 }), api.action('account/recovery/list', '', { limit: 100 })]);
      return { handovers, recoveries };
    }
    default: return {};
  }
}
async function loadRoute() {
  const route = parseRoute();
  const replyDraft = route.name === 'post' ? captureReply(state.clubId, route.id) : null;
  dirty = false;
  state.route = route;
  const token = scope.begin(state.clubId);
  activeToken = token;
  paginationBusy = false;
  state.loading = true;
  state.error = '';
  state.page = null;
  render();
  const accountPages = ['login', 'register', 'privacy', 'clubs', 'me', 'settings', 'confirmations'];
  const privatePages = ['write', 'resubmit', 'contents', 'settings', 'messages', 'appeals', 'confirmations'];
  if (!state.account?.authenticated && privatePages.includes(route.name)) { navigate('login', '', { next: routeUrl(route.name, route.id, route.query) }); return; }
  if (!state.clubId && !accountPages.includes(route.name)) { state.loading = false; render(); return; }
  try {
    let session = state.session;
    if (state.clubId && !accountPages.includes(route.name)) session = await api.action('session/me', state.clubId);
    const page = await readPage(route, token.club, session, '', () => scope.current(token));
    if (!scope.current(token)) return;
    state.session = session;
    state.page = page;
    state.loading = false;
    render();
    restoreReply(replyDraft);
    root.querySelector('#content')?.focus({ preventScroll: true });
    if (state.account?.authenticated && token.club) {
      api.action('notifications/unread-count', token.club).then((value) => { if (scope.current(token)) { state.unread = value.count || 0; const link = root.querySelector('[aria-label="站内消息"]'); if (link && state.unread && !link.querySelector('i')) link.insertAdjacentHTML('beforeend', '<i class="unread-dot"></i>'); } }).catch(() => {});
    }
  } catch (error) {
    if (!scope.current(token)) return;
    if (error.status === 401) { state.account = null; state.session = null; api.clear(); navigate('login', '', { next: routeUrl(route.name, route.id, route.query) }); toast('登录状态已过期，请重新登录'); return; }
    state.error = error.message;
    state.loading = false;
    render();
  }
}
async function selectClub(clubId) {
  scope.begin(clubId);
  state.clubId = clubId;
  state.session = null;
  state.page = null;
  state.unread = 0;
  // Only a public club preference is persisted. Never store auth or content.
  try { localStorage.setItem('blacklight.selectedClub', clubId); } catch { /* storage may be disabled */ }
  navigate('home');
}
async function loadMore(comments = false) {
  if (paginationBusy) return;
  const token = activeToken;
  const cursor = comments ? state.page?.comments?.nextCursor : state.page?.nextCursor;
  if (!cursor) return;
  paginationBusy = true;
  try {
    const next = comments ? await api.action('posts/comments/list', token.club, { id: state.route.id, cursor }) : await readPage(state.route, token.club, state.session, cursor);
    if (!scope.current(token)) return;
    const previous = comments ? state.page.comments : state.page;
    const seen = new Set(itemsOf(previous).map((item) => item.id));
    const merged = { ...previous, items: comments ? mergeCommentPages(itemsOf(previous), itemsOf(next)) : [...itemsOf(previous), ...itemsOf(next).filter((item) => !seen.has(item.id))], nextCursor: next.nextCursor };
    const replyDraft = comments ? captureReply() : null;
    if (comments) state.page.comments = merged; else state.page = merged;
    render();
    restoreReply(replyDraft);
  } catch (error) { if (scope.current(token)) toast(error.message); }
  finally { if (scope.current(token)) paginationBusy = false; }
}
const flows = createFlows({ state, api, navigate, refreshAccount, loadRoute, selectClub, loadMore, toast, isCurrent: (token) => scope.current(token), currentToken: () => activeToken, setClean: () => { dirty = false; } });
root.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  flows.submit(form);
});
root.addEventListener('click', (event) => {
  const anchor = event.target.closest('a[href]');
  const leavesPage = anchor && anchor.target !== '_blank' && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0 && anchor.getAttribute('href') !== location.hash;
  if (leavesPage && dirty) {
    if (!confirm('正文草稿仅保留在当前页面。确定离开并丢弃这段草稿？')) { event.preventDefault(); return; }
    dirty = false;
  }
  const button = event.target.closest('[data-action]');
  if (button) flows.click(button);
});
root.addEventListener('change', (event) => {
  if (event.target.closest('form[data-form="write"],form[data-form="resubmit"]')) dirty = true;
  if (event.target.matches('[data-club-select]')) {
    if (dirty && !confirm('切换社团会丢弃当前草稿。确定继续？')) { event.target.value = state.clubId; return; }
    selectClub(event.target.value);
  }
  if (event.target.name === 'visibility') {
    const form = event.target.form;
    const privateScope = event.target.value === 'private';
    for (const name of ['topicId', 'boardId']) { form.elements[name].disabled = privateScope; if (privateScope) form.elements[name].value = ''; }
    form.elements.commentsEnabled.disabled = privateScope;
  }
  if (event.target.name === 'kind') {
    const form = event.target.form;
    form.elements.title.required = event.target.value === 'article';
    form.elements.body.maxLength = event.target.value === 'article' ? 20000 : 2000;
  }
});
root.addEventListener('input', (event) => { if (event.target.closest('form[data-form="write"],form[data-form="resubmit"]')) dirty = true; });
window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('hashchange', () => {
  const current = routeUrl(state.route.name, state.route.id, state.route.query);
  if (dirty && location.hash !== current) {
    if (!confirm('正文草稿仅保留在当前页面。确定离开并丢弃这段草稿？')) {
      // Preserve the live form; do not reload it or persist its private contents.
      history.replaceState(history.state, '', current);
      return;
    }
    dirty = false;
  }
  window.scrollTo(0, 0);
  loadRoute();
});
async function boot() {
  try { state.clubId = localStorage.getItem('blacklight.selectedClub') || ''; } catch { /* optional preference */ }
  try {
    const refreshed = await refreshAccount();
    if (refreshed?.invalidSelectedClub) { navigate('clubs'); return; }
  }
  catch (error) { state.error = error.message; state.loading = false; state.route = parseRoute(); render(); return; }
  if (!location.hash && state.clubId) navigate('home');
  else await loadRoute();
}
boot();
