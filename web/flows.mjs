import { escapeHtml as h, idempotencyKey, parseInternalRoute } from './core.mjs';

function modal(title, fields, confirmText = '确认', description = '') {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = `<form method="dialog" class="modal-form"><h2>${h(title)}</h2>${description ? `<p class="muted">${h(description)}</p>` : ''}${fields}<div class="modal-actions"><button class="button" type="button" data-cancel>取消</button><button class="button primary" type="submit">${h(confirmText)}</button></div></form>`;
    document.body.append(dialog);
    let result = null;
    dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
    dialog.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); result = Object.fromEntries(new FormData(event.target)); dialog.close(); });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
    dialog.showModal();
  });
}
const reasonField = (max = 200, min = 1) => `<label class="field"><span>说明理由</span><textarea name="reason" required minlength="${min}" maxlength="${max}" rows="4"></textarea></label>`;
function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}
export function createFlows({ state, api, navigate, refreshAccount, loadRoute, selectClub, loadMore, toast, isCurrent, currentToken, setClean }) {
  const drafts = new WeakMap();
  const draftFor = (form) => { if (!drafts.has(form)) drafts.set(form, {}); return drafts.get(form); };
  async function uploadFiles(form, clubId, draft) {
    const files = Array.from(form.elements.images?.files || []);
    if (files.length > 9) throw new Error('最多选择 9 张图片');
    if (files.some((file) => file.size > 2 * 1024 * 1024 || !['image/jpeg', 'image/png'].includes(file.type))) throw new Error('只支持不超过 2 MiB 的 JPEG / PNG 图片');
    const assets = draft.assets || (draft.assets = new Map());
    const ids = [];
    for (const file of files) {
      const key = `${file.name}:${file.size}:${file.lastModified}`;
      let upload = assets.get(key);
      if (!upload) {
        const intentKey = crypto.randomUUID();
        const intent = await api.action('assets/intent', clubId, { mediaType: 'image', mimeType: file.type, size: file.size, idempotencyKey: intentKey });
        upload = { id: intent.assetId, key: crypto.randomUUID() };
        assets.set(key, upload);
      }
      const status = form.querySelector('#upload-status');
      if (status) status.textContent = `正在处理图片 ${ids.length + 1} / ${files.length}…`;
      if (!upload.sent) { await api.action('assets/upload', clubId, { assetId: upload.id, contentBase64: await readBase64(file), idempotencyKey: upload.key }); upload.sent = true; }
      const confirmed = await api.action('assets/confirm', clubId, { assetId: upload.id });
      if (confirmed.status !== 'verified') {
        const check = await api.action('assets/status', clubId, { assetId: upload.id });
        if (check.status !== 'verified') throw new Error(check.failureReason || '图片仍在检查中，请稍后重试；已上传的图片会继续复用');
      }
      ids.push(upload.id);
    }
    return ids;
  }
  async function submit(form) {
    if (form.dataset.busy === 'true') return;
    const token = currentToken();
    const clubId = state.clubId;
    const name = form.dataset.form;
    const values = Object.fromEntries(new FormData(form));
    const errorNode = form.querySelector('.form-error');
    const buttons = Array.from(form.querySelectorAll('button'));
    form.dataset.busy = 'true';
    buttons.forEach((button) => { button.disabled = true; });
    if (errorNode) errorNode.hidden = true;
    const action = (key, payload = {}) => api.action(key, clubId, payload);
    try {
      if (['register', 'password'].includes(name) && values.password !== values.confirmPassword) throw new Error('两次输入的密码不一致');
      if (['login', 'register'].includes(name)) {
        const continuation = parseInternalRoute(state.route.query?.next);
        await api.auth(name, values);
        form.reset();
        const refreshed = await refreshAccount();
        if (isCurrent(token)) {
          if (refreshed?.invalidSelectedClub) navigate('clubs');
          else if (continuation) navigate(continuation.name, continuation.id, continuation.query);
          else navigate(state.clubId ? 'home' : 'clubs');
          toast(name === 'register' ? '账号已创建，欢迎来到灯下' : '欢迎回到灯下');
        }
        return;
      }
      if (name === 'search') { navigate('search', '', { q: values.q.trim() }); return; }
      if (name === 'club-id') { await selectClub(values.clubId.trim()); navigate('join'); return; }
      if (name === 'join') {
        const input = { displayName: values.displayName, inviteCode: values.inviteCode, rulesVersion: state.page.club.rulesVersion };
        const result = await action('membership/apply', { ...input, idempotencyKey: idempotencyKey(draftFor(form), input) });
        if (result.error) throw new Error('邀请码无效或已过期，请向管理员确认');
        const refreshed = await refreshAccount();
        if (refreshed?.invalidSelectedClub) { navigate('clubs'); return; }
        if (isCurrent(token)) { navigate(result.state === 'active' || state.session?.memberStatus === 'active' ? 'home' : 'join'); toast('加入请求已提交，请查看成员状态'); }
        return;
      }
      if (name === 'write') {
        const draft = draftFor(form);
        const assetIds = await uploadFiles(form, clubId, draft);
        const input = { kind: values.kind, title: values.title, body: values.body, visibility: values.visibility, identityMode: values.identityMode, topicId: values.visibility === 'private' ? '' : values.topicId, boardId: values.visibility === 'private' ? '' : values.boardId, commentsEnabled: values.commentsEnabled === 'on' && values.visibility !== 'private', assetIds };
        const result = await action('posts/create', { ...input, idempotencyKey: idempotencyKey(draft, input) });
        if (isCurrent(token)) { setClean(); navigate('post', result.id || result.postId); toast(result.state === 'private_saved' ? '已保存，仅自己可见' : result.state === 'published' ? '这段表达已发布' : '已收到，等待审核后展示'); }
        return;
      }
      if (name === 'resubmit') {
        const post = state.page.post;
        const input = { id: post.id, title: values.title, body: values.body, expectedVersion: post.version };
        await action('posts/resubmit', { ...input, idempotencyKey: idempotencyKey(draftFor(form), input) });
        if (isCurrent(token)) { setClean(); navigate('post', post.id); toast('修改已收到，等待重新审核'); }
        return;
      }
      if (name === 'comment') {
        const input = { id: state.page.post.id, body: values.body, replyToId: values.replyToId || '', identityMode: values.anonymous === 'on' ? 'anonymous' : 'named' };
        const result = await action('posts/comments/create', { ...input, idempotencyKey: idempotencyKey(draftFor(form), input) });
        if (isCurrent(token)) { form.reset(); await loadRoute(); toast(result.state === 'published' ? '回应已送出' : '回应已收到，等待审核'); }
        return;
      }
      if (name === 'collection-submit') { await action('collections/submit', { id: state.route.id, postId: values.postId, consentVersion: 'v1.0' }); toast('投稿和授权已提交，等待编辑收录'); return; }
      if (name === 'profile') { await action('me/profile/update', { displayName: values.displayName }); const refreshed = await refreshAccount(); if (refreshed?.invalidSelectedClub) { navigate('clubs'); return; } if (isCurrent(token)) { await loadRoute(); toast('昵称已更新'); } return; }
      if (name === 'password') { await api.auth('password', values); form.reset(); api.clear(); state.account = null; state.session = null; state.clubs = { list: [] }; navigate('login'); toast('密码已更新，请使用新密码登录'); return; }
    } catch (error) {
      if (!isCurrent(token)) return;
      if (errorNode) { errorNode.textContent = error.message; errorNode.hidden = false; } else toast(error.message);
    } finally { form.dataset.busy = 'false'; buttons.forEach((button) => { button.disabled = false; }); }
  }
  async function click(button) {
    if (button.disabled) return;
    const token = currentToken();
    const clubId = state.clubId;
    const post = state.page?.post;
    const action = (key, payload = {}) => api.action(key, clubId, payload);
    const command = button.dataset.action;
    if (command === 'retry') { if (!state.account) { const refreshed = await refreshAccount().catch((error) => { toast(error.message); return null; }); if (refreshed?.invalidSelectedClub) { navigate('clubs'); return; } } await loadRoute(); return; }
    if (command === 'select-club') { await selectClub(button.dataset.id); return; }
    if (command === 'more' || command === 'more-comments') { await loadMore(command === 'more-comments'); return; }
    if (command === 'reply-to') {
      const form = document.querySelector('form[data-form="comment"]');
      form.elements.replyToId.value = button.dataset.id;
      form.querySelector('#reply-target').textContent = `正在回应 ${button.dataset.name}`;
      form.querySelector('#reply-context').hidden = false;
      form.elements.body.focus();
      return;
    }
    if (command === 'cancel-reply') {
      const form = document.querySelector('form[data-form="comment"]');
      form.elements.replyToId.value = '';
      form.querySelector('#reply-target').textContent = '';
      form.querySelector('#reply-context').hidden = true;
      form.elements.body.focus();
      return;
    }
    button.disabled = true;
    try {
      if (command === 'reaction' || command === 'bookmark') {
        await action(`posts/${command}`, { id: post.id, next: !post.viewer[command === 'reaction' ? 'reacted' : 'bookmarked'] });
      } else if (command === 'comment-reaction') {
        await action('posts/comments/reaction', { id: post.id, commentId: button.dataset.id, next: button.dataset.next === 'true' });
      } else if (command === 'follow') {
        await action('topics/follow', { id: button.dataset.id, next: button.dataset.next === 'true' });
      } else if (command === 'post-delete' || command === 'comment-delete') {
        if (!await modal('删除这段表达？', '', '确认删除', '删除后将不可访问，已保存的截图无法追回。')) return;
        await action(command === 'post-delete' ? 'posts/delete' : 'posts/comments/delete', command === 'post-delete' ? { id: post.id, expectedVersion: post.version } : { id: post.id, commentId: button.dataset.id, expectedVersion: Number(button.dataset.version) });
        if (command === 'post-delete' && isCurrent(token)) { navigate('contents', 'published'); toast('作品已删除'); return; }
      } else if (command === 'visibility') {
        const options = (post.visibility === 'public' ? '<option value="club">社内可见</option>' : '') + '<option value="private">仅自己可见</option>';
        const result = await modal('缩小作品可见范围', `<label class="field"><span>新的可见范围</span><select name="visibility">${options}</select></label>`, '确认缩小', '范围只能缩小。相关文集条目同步移除，已保存截图无法追回。');
        if (!result || !isCurrent(token)) return;
        await action('posts/visibility', { id: post.id, visibility: result.visibility, expectedVersion: post.version });
      } else if (command === 'report' || command === 'appeal') {
        const result = await modal(command === 'report' ? '举报这段内容' : '申诉处理结果', reasonField(command === 'report' ? 200 : 500), '提交', command === 'report' ? '回执代表已受理，不代表认定违规。' : '管理员会核实处理情况。');
        if (!result || !isCurrent(token)) return;
        await action(command === 'report' ? 'reports/create' : 'appeals/create', command === 'report' ? { targetType: 'post', targetId: post.id, reason: result.reason, evidence: '' } : { postId: post.id, contentVersion: post.version, reason: result.reason });
        toast('已提交，请留意后续处理结果');
      } else if (command === 'new-directory') {
        const topics = button.dataset.kind === 'topics';
        const result = await modal(topics ? '发起一个话题' : '申请一个板块', `<label class="field"><span>名称</span><input name="title" required maxlength="${topics ? 30 : 40}"></label><label class="field"><span>说明</span><textarea name="description" maxlength="200" rows="3"></textarea></label>${topics ? '<label class="field"><span>分类</span><select name="category"><option value="life">生活</option><option value="reading">阅读</option><option value="inspiration">灵感</option><option value="confide">倾诉</option><option value="event">活动</option><option value="play">共玩</option></select></label>' : ''}`, '提交');
        if (!result || !isCurrent(token)) return;
        const created = await action(topics ? 'topics/create' : 'boards/create', result);
        if (created.id) { navigate(topics ? 'topic' : 'board', created.id); toast(created.duplicated ? '找到同名话题' : '已提交，审核状态请看详情'); return; }
      } else if (command === 'revoke-consent') {
        if (!await modal('撤回文集授权？', '', '确认撤回', '文集会移除相关条目，已保存的截图无法追回。')) return;
        await action('consents/revoke', { postId: post.id });
      } else if (command === 'read-all') { await action('notifications/read-all'); state.unread = 0; }
      else if (command === 'check-in') { const result = await action('me/check-in'); toast(result.alreadyCheckedIn || result.alreadyClaimed ? '今天已经签到过了' : '签到完成，欢迎今天也在灯下'); }
      else if (command === 'cancel-application') { await action('membership/cancel', { applicationId: button.dataset.id, expectedVersion: Number(button.dataset.version) }); const refreshed = await refreshAccount(); if (refreshed?.invalidSelectedClub) { navigate('clubs'); return; } }
      else if (command === 'confirm-governance') {
        const recovery = button.dataset.kind === 'recovery';
        const decision = button.dataset.decision;
        const result = await modal(decision === 'accept' ? '接受这项管理安排？' : '拒绝这项安排？', decision === 'decline' ? reasonField(500, 10) : '', '确认', '请核对团队和期限，决定生效后管理权限可能变化。');
        if (!result || !isCurrent(token)) return;
        await api.action(recovery ? `account/recovery/${decision}` : `admin/handovers/${decision}`, button.dataset.club, { ...(recovery ? { recoveryId: button.dataset.id } : { id: button.dataset.id }), expectedVersion: Number(button.dataset.version), ...result });
        const refreshed = await refreshAccount();
        if (refreshed?.invalidSelectedClub) { navigate('clubs'); return; }
      } else if (command === 'logout') {
        await api.auth('logout');
        state.account = null; state.session = null; state.clubs = { list: [] }; api.clear();
        navigate('login'); toast('已退出登录'); return;
      } else if (command === 'delete-account') {
        const result = await modal('申请注销账号', '<label class="field"><span>输入「注销」以确认</span><input name="confirm" required pattern="注销" autocomplete="off"></label>', '提交注销申请', '账号将停止使用，进入 7 天清理流程。最后一位管理员需先完成交接。');
        if (!result || !isCurrent(token)) return;
        await api.action('me/account/delete', '', result);
        api.clear(); state.account = null; state.session = null; state.clubs = { list: [] };
        navigate('login'); toast('注销申请已收到，账号停止使用'); return;
      }
      if (isCurrent(token)) await loadRoute();
    } catch (error) { if (isCurrent(token)) toast(error.message); }
    finally { button.disabled = false; }
  }
  return { submit, click };
}
