import { createApi } from './api.mjs';
import { itemsOf, idempotencyKey } from './core.mjs';
import { authorizedMediaUrl } from './rich-doc.mjs';
import { Editor, Node, StarterKit, Link, Placeholder } from './editor.bundle.mjs';

const api = createApi();
const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const initialDraftId = params.get('draft') || '';
const initialSourcePostId = params.get('resubmit') || '';
const state = {
  account: null,
  clubs: [],
  clubId: '',
  session: null,
  editor: null,
  ready: false,
  readOnly: false,
  sequence: 0,
  draftId: '',
  version: null,
  draftStatus: '',
  sourcePostId: '',
  sourcePostVersion: null,
  assets: [],
  coverAssetId: '',
  settings: { visibility: 'club', identityMode: 'named', commentsEnabled: true, topicId: '', boardId: '' },
  revision: 0,
  dirty: false,
  conflict: false,
  saving: false,
  submitting: false,
  timer: 0,
  toastTimer: 0,
  submitAttempt: {},
  uploadByFile: new Map(),
};

const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
const allowedNodes = new Set(['doc', 'paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'horizontalRule', 'hardBreak', 'text', 'assetImage']);
const allowedMarks = new Set(['bold', 'italic', 'strike', 'link']);

function safeLinkHref(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function cleanRichDoc(source) {
  let seen = 0;
  function cleanNode(node, depth) {
    seen += 1;
    if (!node || typeof node !== 'object' || !allowedNodes.has(node.type) || depth > 16 || seen > 4000) return null;
    if (node.type === 'text') {
      if (typeof node.text !== 'string') return null;
      const marks = (Array.isArray(node.marks) ? node.marks : []).flatMap((mark) => {
        if (!allowedMarks.has(mark?.type)) return [];
        if (mark.type === 'link') {
          const href = safeLinkHref(mark.attrs?.href);
          return href ? [{ type: 'link', attrs: { href } }] : [];
        }
        return [{ type: mark.type }];
      });
      return { type: 'text', text: node.text, ...(marks.length ? { marks } : {}) };
    }
    if (node.type === 'assetImage') {
      const assetId = typeof node.attrs?.assetId === 'string' ? node.attrs.assetId : '';
      if (!assetId) return null;
      return {
        type: 'assetImage',
        attrs: {
          assetId,
          alt: typeof node.attrs?.alt === 'string' ? node.attrs.alt.slice(0, 200) : '',
          caption: typeof node.attrs?.caption === 'string' ? node.attrs.caption.slice(0, 300) : '',
        },
      };
    }
    if (node.type === 'horizontalRule' || node.type === 'hardBreak') return { type: node.type };
    const content = (Array.isArray(node.content) ? node.content : []).map((child) => cleanNode(child, depth + 1)).filter(Boolean);
    if (node.type === 'heading' && ![2, 3].includes(node.attrs?.level)) return { type: 'paragraph', ...(content.length ? { content } : {}) };
    return { type: node.type, ...(node.type === 'heading' ? { attrs: { level: node.attrs.level } } : {}), ...(content.length ? { content } : {}) };
  }
  const doc = source?.type === 'doc' ? cleanNode(source, 0) : null;
  return doc?.type === 'doc' ? doc : emptyDoc;
}

function plainText(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak' || node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem') {
    return (node.content || []).map(plainText).join('') + (node.type === 'hardBreak' ? '\n' : '\n');
  }
  if (node.type === 'assetImage') return `${node.attrs?.alt || ''}${node.attrs?.caption ? ` ${node.attrs.caption}` : ''}\n`;
  return (node.content || []).map(plainText).join('');
}

function imageIds(node, found = new Set()) {
  if (node?.type === 'assetImage' && typeof node.attrs?.assetId === 'string') found.add(node.attrs.assetId);
  for (const child of node?.content || []) imageIds(child, found);
  return found;
}

function imageNodeCount(node) {
  return (node?.type === 'assetImage' ? 1 : 0) + (node?.content || []).reduce((total, child) => total + imageNodeCount(child), 0);
}

function readSettings() {
  const form = $('#settings-form');
  const values = new FormData(form);
  const visibility = state.sourcePostId ? state.settings.visibility : String(values.get('visibility') || 'club');
  const privateScope = visibility === 'private';
  return {
    visibility: privateScope ? 'private' : 'club',
    identityMode: state.sourcePostId ? state.settings.identityMode : (values.get('identityMode') === 'anonymous' ? 'anonymous' : 'named'),
    commentsEnabled: !privateScope && (state.sourcePostId ? state.settings.commentsEnabled : values.get('commentsEnabled') === 'on'),
    topicId: privateScope ? '' : (state.sourcePostId ? state.settings.topicId : String(values.get('topicId') || '')),
    boardId: privateScope ? '' : (state.sourcePostId ? state.settings.boardId : String(values.get('boardId') || '')),
  };
}

function setSaveStatus(message, kind = '') {
  const status = $('#save-status');
  status.textContent = message;
  status.dataset.state = kind;
}

function showToast(message) {
  const toast = $('#editor-toast');
  toast.textContent = message;
  toast.dataset.open = 'true';
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { toast.dataset.open = 'false'; }, 4500);
}

function showPageMessage(message, actionLabel = '', action = null, link = '') {
  const box = $('#page-message');
  box.replaceChildren(document.createTextNode(message));
  if (actionLabel && action) {
    const button = document.createElement('button');
    button.className = 'quiet-button';
    button.type = 'button';
    button.textContent = actionLabel;
    button.addEventListener('click', action, { once: true });
    box.append(' ', button);
  } else if (actionLabel && link) {
    const anchor = document.createElement('a');
    anchor.href = link;
    anchor.textContent = actionLabel;
    box.append(' ', anchor);
  }
  box.hidden = false;
}

function hidePageMessage() {
  const box = $('#page-message');
  box.hidden = true;
  box.replaceChildren();
}

function assetUrl(assetId) {
  const asset = state.assets.find((item) => item.assetId === assetId);
  return authorizedMediaUrl(asset?.url);
}

function imageExtension() {
  return Node.create({
    name: 'assetImage',
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes() {
      return {
        assetId: { default: null },
        alt: { default: '' },
        caption: { default: '' },
      };
    },
    parseHTML() { return []; },
    renderHTML({ node }) {
      const attrs = { 'data-asset-id': node.attrs.assetId || '' };
      const children = [['img', { alt: node.attrs.alt || '' }]];
      if (node.attrs.caption) children.push(['figcaption', {}, node.attrs.caption]);
      return ['figure', attrs, ...children];
    },
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('figure');
        dom.className = 'editor-asset-image';
        dom.dataset.assetId = node.attrs.assetId || '';
        const paint = (current) => {
          dom.replaceChildren();
          const src = assetUrl(current.attrs.assetId);
          if (src) {
            const image = document.createElement('img');
            image.dataset.editorAssetId = current.attrs.assetId;
            image.src = src;
            image.alt = current.attrs.alt || '';
            image.loading = 'lazy';
            dom.append(image);
          } else {
            const unavailable = document.createElement('div');
            unavailable.className = 'image-unavailable';
            unavailable.textContent = '图片授权暂不可读取';
            dom.append(unavailable);
          }
          if (current.attrs.caption) {
            const caption = document.createElement('figcaption');
            caption.textContent = current.attrs.caption;
            dom.append(caption);
          }
        };
        paint(node);
        return {
          dom,
          update(next) {
            if (next.type.name !== 'assetImage') return false;
            node = next;
            paint(next);
            return true;
          },
        };
      };
    },
  });
}

function refreshImages() {
  if (!state.editor) return;
  for (const image of state.editor.view.dom.querySelectorAll('[data-editor-asset-id]')) {
    const source = assetUrl(image.dataset.editorAssetId);
    if (source) image.src = source;
  }
  renderCover();
}

function renderCounts() {
  $('#title-count').textContent = `${$('#article-title').value.length} / 60`;
  $('#summary-count').textContent = `${$('#article-summary').value.length} / 300`;
  const doc = state.editor ? state.editor.getJSON() : emptyDoc;
  const count = plainText(doc).trim().length;
  $('#body-count').textContent = `${count.toLocaleString('zh-CN')} / 20,000`;
  const ids = imageIds(doc);
  const imageCount = imageNodeCount(doc) + (state.coverAssetId && !ids.has(state.coverAssetId) ? 1 : 0);
  const valid = $('#article-title').value.trim().length > 0 && count <= 20000 && imageCount <= 9;
  $('#next-step').disabled = !state.ready || state.readOnly || !valid || state.conflict || state.submitting;
  if (imageCount > 9) $('#upload-message').textContent = '正文图片节点与独立头图合计最多 9 张，请移除多余图片。';
}

function markDirty() {
  if (!state.ready || state.readOnly) return;
  state.revision += 1;
  state.dirty = true;
  state.submitAttempt = {};
  if (!state.conflict) setSaveStatus('有未保存修改', 'dirty');
  renderCounts();
  if (!state.conflict) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { saveDraft().catch(() => {}); }, 1100);
  }
}

function savePayload() {
  const richDoc = cleanRichDoc(state.editor?.getJSON() || emptyDoc);
  return {
    ...(state.draftId ? { id: state.draftId, expectedVersion: state.version } : {}),
    ...(state.sourcePostId ? { sourcePostId: state.sourcePostId, sourcePostVersion: state.sourcePostVersion } : {}),
    title: $('#article-title').value,
    summary: $('#article-summary').value,
    richDoc,
    coverAssetId: state.coverAssetId || '',
    settings: readSettings(),
  };
}

function showConflict(error) {
  state.conflict = true;
  state.dirty = true;
  setEditLock(true);
  setSaveStatus('版本冲突', 'conflict');
  const sourceChanged = state.sourcePostId && error?.code === 'source_post_version_conflict';
  if (sourceChanged) {
    showPageMessage('原文章在此草稿创建后发生变化，旧图文不会覆盖新版本。请打开最新文章重新开始重提。', '返回原文章', null, `/#/post/${encodeURIComponent(state.sourcePostId)}`);
  } else {
    showPageMessage('服务器上的草稿已有更新。重新载入服务器版本后才能继续编辑。', '载入服务器版本', reloadCurrentDraft);
  }
}

function showSaveError(error) {
  if (error?.status === 409) { showConflict(error); return; }
  if (error?.status === 401) {
    setSaveStatus('登录已过期', 'error');
    showPageMessage('登录状态已过期，请重新登录后继续。', '前往登录', null, '/#/login');
    return;
  }
  if (error?.status === 403) {
    setSaveStatus('当前无权保存', 'error');
    showPageMessage('当前社团的投稿资格或草稿权限已变化。已保存的服务器版本仍可在草稿箱中查看。');
    return;
  }
  setSaveStatus('保存失败', 'error');
  showPageMessage(`草稿未能保存：${error?.message || '网络请求失败'}`, '重试保存', saveDraft);
}

async function saveDraft() {
  clearTimeout(state.timer);
  if (!state.ready || state.conflict || state.readOnly) throw new Error('当前草稿需要先解决版本冲突');
  if (state.saving) return state.saving;
  const sequence = state.sequence;
  const savedRevision = state.revision;
  state.saving = (async () => {
    setSaveStatus('正在保存…', 'saving');
    try {
      const result = await api.action('drafts/save', state.clubId, savePayload());
      if (sequence !== state.sequence) return result;
      if (!result?.id || result.version === undefined) throw new Error('服务器没有确认草稿版本，请稍后重试');
      state.draftId = result.id;
      state.version = result.version;
      state.draftStatus = result.status || 'draft';
      if (Array.isArray(result.assets)) state.assets = result.assets;
      const unchanged = state.revision === savedRevision;
      if (unchanged && result.coverAssetId !== undefined) state.coverAssetId = result.coverAssetId || '';
      if (unchanged && result.settings) state.settings = { ...state.settings, ...result.settings };
      state.dirty = !unchanged;
      hidePageMessage();
      updateEditorUrl();
      renderSettings();
      refreshImages();
      setSaveStatus(state.dirty ? '有新修改待保存' : '已保存 · ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), state.dirty ? 'dirty' : 'saved');
      renderCounts();
      if (state.dirty) {
        clearTimeout(state.timer);
        state.timer = setTimeout(() => { saveDraft().catch(() => {}); }, 500);
      }
      return result;
    } catch (error) {
      if (sequence === state.sequence) showSaveError(error);
      throw error;
    } finally {
      state.saving = false;
    }
  })();
  return state.saving;
}

async function flushSaves() {
  clearTimeout(state.timer);
  for (let count = 0; count < 5; count += 1) {
    if (!state.dirty && state.draftId) return;
    await saveDraft();
    if (state.conflict) throw new Error('请先载入服务器上的最新草稿');
    if (!state.dirty && state.draftId) return;
  }
  throw new Error('仍有修改未保存，请稍后重试');
}

function updateEditorUrl() {
  const next = new URLSearchParams(location.search);
  if (state.draftId) next.set('draft', state.draftId);
  else next.delete('draft');
  if (state.sourcePostId) next.set('resubmit', state.sourcePostId);
  else next.delete('resubmit');
  const query = next.toString();
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}`);
}

function setOptions(select, items, selected = '') {
  const first = select.options[0];
  select.replaceChildren(first);
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.id || '';
    option.textContent = item.title || item.name || item.id;
    select.append(option);
  }
  select.value = selected || '';
}

function renderSettings() {
  const form = $('#settings-form');
  if (!form) return;
  form.elements.visibility.value = state.settings.visibility || 'club';
  form.elements.identityMode.value = state.settings.identityMode || 'named';
  form.elements.commentsEnabled.checked = Boolean(state.settings.commentsEnabled);
  form.elements.topicId.value = state.settings.topicId || '';
  form.elements.boardId.value = state.settings.boardId || '';
  const privateScope = state.settings.visibility === 'private';
  form.elements.topicId.disabled = privateScope || Boolean(state.sourcePostId);
  form.elements.boardId.disabled = privateScope || Boolean(state.sourcePostId);
  form.elements.commentsEnabled.disabled = privateScope || Boolean(state.sourcePostId);
  form.elements.visibility.disabled = Boolean(state.sourcePostId);
  form.elements.identityMode.disabled = Boolean(state.sourcePostId);
  $('#settings-note').textContent = state.sourcePostId
    ? '重新提交将保留原文章的可见范围、身份、回应、话题和板块。'
    : privateScope ? '仅自己可见的文章不会进入社团审核队列。' : '社内图文投稿后进入人工审核。';
}

function applyAssets(assets) {
  state.assets = Array.isArray(assets) ? assets.filter((asset) => asset && typeof asset.assetId === 'string') : [];
}

function setEditLock(locked) {
  state.readOnly = locked;
  if (state.editor) state.editor.setEditable(!locked);
  for (const id of ['article-title', 'article-summary', 'block-style']) $(`#${id}`).disabled = locked;
  document.querySelectorAll('[data-mark],[data-block],[data-action],#insert-image').forEach((button) => { button.disabled = locked; });
  $('#insert-image').disabled = locked || !state.richUploads;
  $('[data-action="image-details"]').disabled = locked || !state.editor?.isActive('assetImage');
  $('[data-action="cover-from-image"]').disabled = locked || Boolean(state.sourcePostId) || !state.editor?.isActive('assetImage');
  $('#cover-picker').disabled = locked || !state.richUploads || Boolean(state.sourcePostId);
  $('#clear-cover').disabled = locked || Boolean(state.sourcePostId);
  $('#save-draft').disabled = locked;
  $('#next-step').disabled = locked || state.conflict || !state.editor || !articleValid();
}

function setEditorContent(doc) {
  state.hydrating = true;
  if (state.editor) state.editor.commands.setContent(cleanRichDoc(doc || emptyDoc), false);
  state.hydrating = false;
  renderCounts();
  updateToolbar();
}

function createEditor(content = emptyDoc) {
  state.editor = new Editor({
    element: $('#editor'),
    extensions: [
      StarterKit.configure({ code: false, codeBlock: false, heading: { levels: [2, 3] } }),
      Link.configure({
        openOnClick: false,
        autolink: false,
        linkOnPaste: false,
        HTMLAttributes: { target: null, rel: 'noopener noreferrer', class: null },
        isAllowedUri: (value) => Boolean(safeLinkHref(value)),
      }),
      Placeholder.configure({ placeholder: '从第一段开始。选中文字可添加格式，图片会留在正文顺序中。' }),
      imageExtension(),
    ],
    content: cleanRichDoc(content),
    editorProps: { attributes: { class: 'tiptap-content', 'aria-label': '文章正文编辑区' } },
    onUpdate() {
      if (state.hydrating) return;
      renderCounts();
      markDirty();
    },
    onSelectionUpdate: updateToolbar,
    onTransaction: updateToolbar,
  });
  state.ready = true;
  $('#club-select').disabled = false;
  $('#open-drafts').disabled = false;
  $('#save-draft').disabled = false;
  $('#next-step').disabled = false;
  $('#article-title').disabled = false;
  $('#article-summary').disabled = false;
  $('#block-style').disabled = false;
  document.querySelectorAll('[data-mark],[data-block],[data-action],#insert-image').forEach((button) => { button.disabled = false; });
  $('#insert-image').disabled = !state.richUploads;
  $('#cover-picker').disabled = !state.richUploads;
  setEditorContent(content);
  renderCounts();
  updateToolbar();
  renderCover();
  renderSettings();
}

function updateToolbar() {
  if (!state.editor) return;
  for (const button of document.querySelectorAll('[data-mark]')) {
    button.setAttribute('aria-pressed', String(state.editor.isActive(button.dataset.mark)));
  }
  for (const button of document.querySelectorAll('[data-block]')) {
    const name = button.dataset.block;
    button.setAttribute('aria-pressed', String(name !== 'horizontalRule' && state.editor.isActive(name)));
  }
  const imageSelected = state.editor.isActive('assetImage');
  $('[data-action="image-details"]').disabled = state.readOnly || !imageSelected;
  $('[data-action="cover-from-image"]').disabled = state.readOnly || Boolean(state.sourcePostId) || !imageSelected;
  $('#block-style').value = state.editor.isActive('heading', { level: 2 }) ? 'heading2'
    : state.editor.isActive('heading', { level: 3 }) ? 'heading3'
      : state.editor.isActive('blockquote') ? 'blockquote' : 'paragraph';
}

function setPageData(draft) {
  state.draftId = draft.id || '';
  state.version = draft.version ?? null;
  state.draftStatus = draft.status || 'draft';
  state.sourcePostId = draft.sourcePostId || state.sourcePostId || '';
  state.sourcePostVersion = draft.sourcePostVersion ?? state.sourcePostVersion;
  state.coverAssetId = draft.coverAssetId || '';
  state.settings = { ...state.settings, ...(draft.settings || {}) };
  applyAssets(draft.assets);
  $('#article-title').value = draft.title || '';
  $('#article-summary').value = draft.summary || '';
  setEditorContent(draft.richDoc || emptyDoc);
  renderSettings();
  renderCover();
  refreshImages();
  state.revision = 0;
  state.dirty = false;
  state.conflict = false;
  setEditLock(false);
  updateEditorUrl();
  setSaveStatus('已保存', 'saved');
  hidePageMessage();
  renderCounts();
}

function seedFromPost(post) {
  state.sourcePostId = post.id;
  state.sourcePostVersion = post.version;
  state.coverAssetId = post.coverAssetId || '';
  state.settings = {
    visibility: post.visibility === 'private' ? 'private' : 'club',
    identityMode: post.identityMode === 'anonymous' ? 'anonymous' : 'named',
    commentsEnabled: Boolean(post.commentsEnabled),
    topicId: post.topicId || post.topic?.id || '',
    boardId: post.boardId || post.board?.id || '',
  };
  applyAssets(post.assets);
  $('#article-title').value = post.title || '';
  $('#article-summary').value = post.summary || '';
  setEditorContent(post.richDoc || emptyDoc);
  renderSettings();
  renderCover();
}

async function loadCurrentDraft() {
  if (!state.draftId) return false;
  const draft = await api.action('drafts/get', state.clubId, { id: state.draftId });
  if (draft.sourcePostId) {
    const post = await api.action('posts/detail', state.clubId, { id: draft.sourcePostId });
    if (draft.sourcePostVersion === undefined || draft.sourcePostVersion === null || draft.sourcePostVersion !== post.version) {
      state.conflict = true;
      showConflict({ code: 'source_post_version_conflict', status: 409 });
      return false;
    }
    state.sourcePostId = draft.sourcePostId;
    state.sourcePostVersion = draft.sourcePostVersion ?? post.version;
  }
  setPageData(draft);
  return true;
}

async function reloadCurrentDraft() {
  if (!state.draftId) return;
  try {
    state.conflict = false;
    const loaded = await loadCurrentDraft();
    if (loaded) showToast('已载入服务器上的最新草稿');
  } catch (error) {
    showSaveError(error);
  }
}

async function seedResubmission(postId) {
  const post = await api.action('posts/detail', state.clubId, { id: postId });
  if (post.status !== 'rejected' || post.kind !== 'article' || post.richDoc?.type !== 'doc') {
    throw new Error('只有本人被退回的图文文章可以在此重新提交');
  }
  seedFromPost(post);
  state.dirty = true;
  state.revision += 1;
  const saved = await saveDraft();
  if (!saved?.id) throw new Error('无法创建重提草稿，请重试');
  setSaveStatus('退回稿已载入', 'saved');
}

function renderCover() {
  const button = $('#cover-picker');
  const content = $('#cover-content');
  if (!content) return;
  content.replaceChildren();
  const source = state.coverAssetId ? assetUrl(state.coverAssetId) : '';
  if (source) {
    const image = document.createElement('img');
    image.className = 'cover-preview';
    image.src = source;
    image.alt = '文章头图';
    image.loading = 'lazy';
    const label = document.createElement('span');
    label.className = 'cover-selected';
    label.textContent = state.richUploads ? '更换头图' : '当前头图';
    content.append(image, label);
    $('#cover-status').textContent = '已绑定到当前草稿';
    $('#clear-cover').hidden = !state.coverAssetId || Boolean(state.sourcePostId);
  } else {
    const icon = document.createElement('span');
    icon.className = 'cover-plus';
    icon.textContent = '+';
    const title = document.createElement('strong');
    title.textContent = state.coverAssetId ? '头图授权读取中' : '添加文章头图';
    const note = document.createElement('small');
    note.textContent = state.richUploads ? '上传一张 JPEG / PNG；正文图片可通过工具栏设为头图' : '当前社团尚未开放图片上传';
    content.append(icon, title, note);
    $('#cover-status').textContent = state.coverAssetId ? '已保存头图标识，暂时无法预览' : '图片由社团权限保护';
    $('#clear-cover').hidden = !state.coverAssetId || Boolean(state.sourcePostId);
  }
  button.disabled = !state.ready || !state.richUploads || Boolean(state.sourcePostId);
}

async function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

function validateImage(file) {
  if (!file) throw new Error('请选择一张图片');
  if (!['image/jpeg', 'image/png'].includes(file.type)) throw new Error('只支持 JPEG 或 PNG 图片');
  if (file.size > 2 * 1024 * 1024) throw new Error('图片不能超过 2 MiB');
  const doc = state.editor.getJSON();
  const ids = imageIds(doc);
  const count = imageNodeCount(doc) + (state.coverAssetId && !ids.has(state.coverAssetId) ? 1 : 0);
  if (count >= 9) throw new Error('正文图片节点与独立头图合计最多 9 张；可把正文图片设为头图。');
}

async function uploadImage(file) {
  validateImage(file);
  if (!state.richUploads) throw new Error('当前社团暂未开放图片上传');
  await flushSaves();
  if (!state.draftId) throw new Error('服务端草稿尚未建立，请先保存草稿');
  const key = `${file.name}:${file.size}:${file.lastModified}`;
  let upload = state.uploadByFile.get(key);
  if (!upload) {
    const intent = await api.action('assets/intent', state.clubId, {
      mediaType: 'image',
      mimeType: file.type,
      size: file.size,
      draftId: state.draftId,
      idempotencyKey: crypto.randomUUID(),
    });
    upload = { assetId: intent.assetId, uploadKey: crypto.randomUUID(), uploaded: false };
    state.uploadByFile.set(key, upload);
  }
  $('#upload-message').dataset.state = '';
  $('#upload-message').textContent = '正在上传并清洗图片…';
  if (!upload.uploaded) {
    await api.action('assets/upload', state.clubId, { assetId: upload.assetId, contentBase64: await readBase64(file), idempotencyKey: upload.uploadKey });
    upload.uploaded = true;
  }
  const confirmed = await api.action('assets/confirm', state.clubId, { assetId: upload.assetId });
  if (!['uploaded', 'verified'].includes(confirmed.status)) throw new Error('图片暂不可加入草稿，请稍后重试');
  const detail = await api.action('assets/status', state.clubId, { assetId: upload.assetId });
  if (!['uploaded', 'verified'].includes(detail.status) || !authorizedMediaUrl(detail.url)) throw new Error('图片已上传，但预览授权还未就绪；可重试并继续使用此文件');
  state.assets = [...state.assets.filter((asset) => asset.assetId !== detail.assetId), detail];
  refreshImages();
  return detail.assetId;
}

function articleValid() {
  const doc = state.editor.getJSON();
  const text = plainText(doc).trim();
  const textCount = text.length;
  const imageCount = imageNodeCount(doc) + (state.coverAssetId && !imageIds(doc).has(state.coverAssetId) ? 1 : 0);
  return $('#article-title').value.trim().length > 0 && textCount <= 20000 && imageCount <= 9
    && (text.length > 0 || imageNodeCount(doc) > 0);
}

function openSettings() {
  if (!articleValid()) {
    showToast('请填写标题，并为文章添加正文或图片；正文最多 20,000 字，图片最多 9 张。');
    return;
  }
  renderSettings();
  flushSaves().then(() => $('#settings-dialog').showModal()).catch((error) => showToast(error.message));
}

function openImageDetails() {
  const selected = state.editor?.state.selection.node;
  if (!selected || selected.type.name !== 'assetImage') { showToast('先选中一张正文图片。'); return; }
  const form = $('#image-details-form');
  form.elements.alt.value = selected.attrs.alt || '';
  form.elements.caption.value = selected.attrs.caption || '';
  $('#image-details-dialog').showModal();
}

function openLinkDialog() {
  if (state.editor.state.selection.empty) { showToast('先选中要添加链接的文字。'); return; }
  const current = state.editor.getAttributes('link').href || '';
  const form = $('#link-form');
  form.elements.href.value = current;
  $('#link-error').hidden = true;
  $('#link-dialog').showModal();
  form.elements.href.focus();
}

function applyBlockStyle(value) {
  const chain = state.editor.chain().focus();
  if (value === 'heading2') chain.setHeading({ level: 2 }).run();
  else if (value === 'heading3') chain.setHeading({ level: 3 }).run();
  else if (value === 'blockquote') chain.setBlockquote().run();
  else chain.setParagraph().run();
}

async function openDraftList() {
  const list = $('#draft-list');
  list.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'dialog-note';
  loading.textContent = '正在读取草稿…';
  list.append(loading);
  if (!$('#drafts-dialog').open) $('#drafts-dialog').showModal();
  try {
    const result = await api.action('drafts/list', state.clubId);
    const drafts = itemsOf(result);
    list.replaceChildren();
    if (!drafts.length) {
      const empty = document.createElement('p');
      empty.className = 'dialog-note';
      empty.textContent = '当前社团还没有保存的文章草稿。';
      list.append(empty);
      return;
    }
    for (const draft of drafts) {
      const row = document.createElement('div');
      row.className = 'draft-row';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'draft-open';
      const title = document.createElement('strong');
      title.textContent = draft.title || '未命名文章';
      const meta = document.createElement('small');
      meta.textContent = `版本 ${draft.version ?? '—'} · ${draft.updatedAt ? new Date(draft.updatedAt).toLocaleString('zh-CN') : '未记录时间'}${draft.sourcePostId ? ' · 退回稿重提' : ''}`;
      open.append(title, meta);
      open.addEventListener('click', () => loadDraftFromList(draft));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'draft-delete';
      remove.textContent = '删除';
      remove.addEventListener('click', () => deleteDraft(draft));
      row.append(open, remove);
      list.append(row);
    }
  } catch (error) {
    list.replaceChildren();
    const failure = document.createElement('p');
    failure.className = 'editor-error';
    failure.textContent = `草稿列表读取失败：${error.message}`;
    list.append(failure);
  }
}

async function loadDraftFromList(draft) {
  try {
    if (state.dirty) await flushSaves();
    const query = new URLSearchParams(location.search);
    query.set('draft', draft.id);
    if (draft.sourcePostId) query.set('resubmit', draft.sourcePostId);
    else query.delete('resubmit');
    history.replaceState(history.state, '', `${location.pathname}?${query.toString()}`);
    state.sourcePostId = draft.sourcePostId || '';
    state.sourcePostVersion = draft.sourcePostVersion ?? null;
    state.draftId = draft.id;
    const loaded = await loadCurrentDraft();
    if (loaded) $('#drafts-dialog').close();
  } catch (error) {
    showSaveError(error);
  }
}

async function deleteDraft(draft) {
  if (!confirm(`删除“${draft.title || '未命名文章'}”这篇服务端草稿？此操作无法撤销。`)) return;
  try {
    await api.action('drafts/delete', state.clubId, { id: draft.id, expectedVersion: draft.version });
    if (state.draftId === draft.id) {
      state.draftId = '';
      state.version = null;
      state.sourcePostId = '';
      state.sourcePostVersion = null;
      state.coverAssetId = '';
      state.assets = [];
      state.settings = { visibility: 'club', identityMode: 'named', commentsEnabled: true, topicId: '', boardId: '' };
      $('#article-title').value = '';
      $('#article-summary').value = '';
      setEditorContent(emptyDoc);
      state.dirty = false;
      setEditLock(false);
      updateEditorUrl();
      renderSettings();
      renderCover();
      setSaveStatus('尚未保存', '');
    }
    await openDraftList();
    showToast('服务端草稿已删除');
  } catch (error) {
    if (error.status === 409) showConflict(error);
    else showToast(error.message);
  }
}

async function submitArticle(event) {
  event.preventDefault();
  if (state.submitting) return;
  const error = $('#settings-error');
  error.hidden = true;
  if (!articleValid()) { error.textContent = '请填写标题和正文；正文最多 20,000 字，图片最多 9 张。'; error.hidden = false; return; }
  const submittedSettings = readSettings();
  if (!state.sourcePostId && JSON.stringify(submittedSettings) !== JSON.stringify(state.settings)) {
    state.settings = submittedSettings;
    markDirty();
  }
  state.submitting = true;
  $('#submit-article').disabled = true;
  try {
    await flushSaves();
    const input = state.sourcePostId
      ? { id: state.sourcePostId, expectedVersion: state.sourcePostVersion, draftId: state.draftId }
      : { id: state.draftId, expectedVersion: state.version };
    const key = idempotencyKey(state.submitAttempt, input);
    const result = state.sourcePostId
      ? await api.action('posts/resubmit-rich', state.clubId, { ...input, idempotencyKey: key })
      : await api.action('drafts/submit', state.clubId, { ...input, idempotencyKey: key });
    const postId = result.id || result.postId;
    if (!postId) throw new Error('服务器没有返回文章编号，草稿仍保留在草稿箱。');
    const stateText = result.state === 'private_saved' ? '已保存，仅自己可见。' : '文章已提交，等待社团人工审核。';
    $('#settings-dialog').close();
    showPageMessage(stateText, '查看文章', null, `/#/post/${encodeURIComponent(postId)}`);
    setSaveStatus(result.state === 'private_saved' ? '仅自己可见' : '已提交审核', 'saved');
    $('#submit-status').textContent = stateText;
    $('#next-step').disabled = true;
    state.draftStatus = 'submitted';
    setEditLock(true);
  } catch (submitError) {
    if (submitError.status === 409) showConflict(submitError);
    error.textContent = submitError.message || '提交失败，服务端草稿仍保留。';
    error.hidden = false;
  } finally {
    state.submitting = false;
    $('#submit-article').disabled = false;
    renderCounts();
  }
}

function handleSettingsChange(event) {
  if (state.sourcePostId) { renderSettings(); return; }
  if (event.target.name === 'visibility') {
    const privateScope = event.target.value === 'private';
    if (privateScope) {
      $('#settings-form').elements.topicId.value = '';
      $('#settings-form').elements.boardId.value = '';
      $('#settings-form').elements.commentsEnabled.checked = false;
    }
    state.settings = readSettings();
    renderSettings();
    markDirty();
  } else {
    state.settings = readSettings();
    markDirty();
  }
}

async function switchClub(nextClubId) {
  if (!nextClubId || nextClubId === state.clubId) return;
  if (!confirm('切换社团前会先保存当前修改。继续切换吗？')) { $('#club-select').value = state.clubId; return; }
  try {
    await flushSaves();
    localStorage.setItem('blacklight.selectedClub', nextClubId);
    location.assign('/web/editor.html');
  } catch (error) {
    $('#club-select').value = state.clubId;
    showToast(error.message || '当前草稿未保存，暂不能切换社团。');
  }
}

function closeDialogs() {
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
}

function bindEvents() {
  $('#article-title').addEventListener('input', () => { renderCounts(); markDirty(); });
  $('#article-summary').addEventListener('input', () => { renderCounts(); markDirty(); });
  $('#settings-form').addEventListener('change', handleSettingsChange);
  $('#settings-form').addEventListener('submit', submitArticle);
  $('#save-draft').addEventListener('click', () => saveDraft().then(() => showToast('草稿已保存到服务器')).catch(() => {}));
  $('#next-step').addEventListener('click', openSettings);
  $('#open-drafts').addEventListener('click', openDraftList);
  $('#club-select').addEventListener('change', (event) => switchClub(event.target.value));
  $('#cover-picker').addEventListener('click', () => { if (state.richUploads && !state.sourcePostId) $('#cover-image-file').click(); });
  $('#clear-cover').addEventListener('click', (event) => {
    event.stopPropagation();
    if (!state.coverAssetId || state.sourcePostId) return;
    state.coverAssetId = '';
    renderCover();
    markDirty();
  });
  $('#cover-image-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const assetId = await uploadImage(file);
      state.coverAssetId = assetId;
      renderCover();
      markDirty();
      await flushSaves();
      $('#upload-message').dataset.state = '';
      $('#upload-message').textContent = '头图已保存到草稿，投稿前仅你可以预览。';
    } catch (error) {
      $('#upload-message').dataset.state = 'error';
      $('#upload-message').textContent = error.message;
    }
  });
  $('#insert-image').addEventListener('click', () => { if (state.richUploads) $('#inline-image-file').click(); });
  $('#inline-image-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const assetId = await uploadImage(file);
      state.editor.chain().focus().insertContent({ type: 'assetImage', attrs: { assetId, alt: file.name.slice(0, 200), caption: '' } }).run();
      await flushSaves();
      $('#upload-message').dataset.state = '';
      $('#upload-message').textContent = '图片已加入正文并保存到草稿；选中图片可编辑替代文本和说明。图片尚未经过投稿审核。';
    } catch (error) {
      $('#upload-message').dataset.state = 'error';
      $('#upload-message').textContent = error.message;
    }
  });
  $('#block-style').addEventListener('change', (event) => applyBlockStyle(event.target.value));
  document.querySelectorAll('[data-mark]').forEach((button) => button.addEventListener('mousedown', (event) => event.preventDefault()));
  document.querySelectorAll('[data-mark]').forEach((button) => button.addEventListener('click', () => {
    const chain = state.editor.chain().focus();
    if (state.editor.isActive(button.dataset.mark)) chain.unsetMark(button.dataset.mark).run();
    else chain.toggleMark(button.dataset.mark).run();
  }));
  document.querySelectorAll('[data-block]').forEach((button) => button.addEventListener('mousedown', (event) => event.preventDefault()));
  document.querySelectorAll('[data-block]').forEach((button) => button.addEventListener('click', () => {
    const chain = state.editor.chain().focus();
    const block = button.dataset.block;
    if (block === 'bulletList') chain.toggleBulletList().run();
    else if (block === 'orderedList') chain.toggleOrderedList().run();
    else chain.setHorizontalRule().run();
  }));
  $('[data-action="link"]').addEventListener('mousedown', (event) => event.preventDefault());
  $('[data-action="link"]').addEventListener('click', openLinkDialog);
  $('[data-action="image-details"]').addEventListener('mousedown', (event) => event.preventDefault());
  $('[data-action="image-details"]').addEventListener('click', openImageDetails);
  $('[data-action="cover-from-image"]').addEventListener('mousedown', (event) => event.preventDefault());
  $('[data-action="cover-from-image"]').addEventListener('click', () => {
    const selected = state.editor?.state.selection.node;
    if (!selected || selected.type.name !== 'assetImage' || state.sourcePostId) return;
    state.coverAssetId = selected.attrs.assetId;
    renderCover();
    markDirty();
  });
  $('[data-action="undo"]').addEventListener('click', () => state.editor.chain().focus().undo().run());
  $('[data-action="redo"]').addEventListener('click', () => state.editor.chain().focus().redo().run());
  $('#image-details-form').addEventListener('submit', (event) => {
    event.preventDefault();
    state.editor.chain().focus().updateAttributes('assetImage', { alt: event.target.elements.alt.value, caption: event.target.elements.caption.value }).run();
    $('#image-details-dialog').close();
  });
  $('#link-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const href = safeLinkHref(event.target.elements.href.value.trim());
    if (!href) { $('#link-error').textContent = '请输入有效的 http:// 或 https:// 链接。'; $('#link-error').hidden = false; return; }
    state.editor.chain().focus().setLink({ href }).run();
    $('#link-dialog').close();
  });
  document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', closeDialogs));
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  }
  window.addEventListener('beforeunload', (event) => {
    if (state.dirty || state.saving) { event.preventDefault(); event.returnValue = ''; }
  });
}

function showFatal(message, login = false) {
  setEditLock(true);
  $('#save-draft').disabled = true;
  $('#next-step').disabled = true;
  $('#open-drafts').disabled = true;
  $('#club-name').textContent = '暂不可编辑';
  setSaveStatus('暂不可编辑', 'error');
  showPageMessage(message, login ? '前往登录' : '', null, login ? '/#/login' : '');
}

async function init() {
  bindEvents();
  try {
    state.account = await api.session();
    if (!state.account.authenticated) { showFatal('请先登录，并加入具有文章投稿权限的社团。', true); return; }
    const clubs = await api.action('clubs/mine', '');
    state.clubs = itemsOf(clubs).filter((club) => club.status === 'active');
    if (!state.clubs.length) { showFatal('账号当前没有已加入的社团。登录后加入社团即可创建图文文章。'); return; }
    let selected = '';
    try { selected = localStorage.getItem('blacklight.selectedClub') || ''; } catch { /* optional preference */ }
    state.clubId = state.clubs.some((club) => club.id === selected) ? selected : state.clubs[0].id;
    const selector = $('#club-select');
    selector.replaceChildren();
    for (const club of state.clubs) {
      const option = document.createElement('option');
      option.value = club.id;
      option.textContent = club.name || club.id;
      selector.append(option);
    }
    selector.value = state.clubId;
    selector.hidden = state.clubs.length < 2;
    const session = await api.action('session/me', state.clubId);
    state.session = session;
    state.richUploads = Boolean(session.capabilities?.richUploads);
    if (session.memberStatus !== 'active' || !session.capabilities?.publishing) { showFatal('当前社团没有开放文章投稿权限。已保存的草稿仍保留在服务器。'); return; }
    $('#club-name').textContent = session.club?.name || state.clubs.find((club) => club.id === state.clubId)?.name || '文章编辑';
    const [topics, boards] = await Promise.all([
      api.action('topics/list', state.clubId, { pageSize: 100 }).catch(() => ({ items: [] })),
      api.action('boards/list', state.clubId, { pageSize: 100 }).catch(() => ({ items: [] })),
    ]);
    setOptions($('#settings-form').elements.topicId, itemsOf(topics).filter((item) => item.status === 'active'));
    setOptions($('#settings-form').elements.boardId, itemsOf(boards).filter((item) => item.status === 'active'));
    const sourcePostId = initialSourcePostId;
    if (initialDraftId) {
      state.draftId = initialDraftId;
      if (sourcePostId) state.sourcePostId = sourcePostId;
      createEditor(emptyDoc);
      const loaded = await loadCurrentDraft();
      if (!loaded && !state.conflict) showPageMessage('草稿暂时无法读取，请检查社团选择或权限后重试。');
    } else if (sourcePostId) {
      createEditor(emptyDoc);
      await seedResubmission(sourcePostId);
    } else {
      state.settings.topicId = params.get('topicId') || '';
      state.settings.boardId = params.get('boardId') || '';
      createEditor(emptyDoc);
      setSaveStatus('尚未保存', '');
    }
    renderSettings();
    renderCover();
    renderCounts();
    if (!state.richUploads) {
      $('#upload-message').textContent = '当前社团尚未开放图片上传。你仍可编辑文字，并修改已有图文草稿。';
    }
  } catch (error) {
    if (error.status === 401) { showFatal('登录状态已过期，请重新登录后继续。', true); return; }
    if (error.status === 409) showConflict(error);
    else showFatal(`文章编辑器暂时无法读取当前社团：${error.message || '请求失败'}`);
  }
}

init();
