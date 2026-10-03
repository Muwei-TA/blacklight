/* global window, document, navigator */
(function bootAdminWeb() {
  const {
    canSeeWorkspace,
    visibleWorkspaces,
    createClubRequestScope,
    createOneTimeCodePresenter,
    createPairingView,
    reviewActionsFor,
    escapeHTML,
    collectPagedItems,
    activeTeamCandidates,
    retainableInvites,
    logoutFailureView,
    clearExpiredSessionState,
  } = globalThis.AdminCore;
  const api = globalThis.AdminApi.createAdminApi();
  const root = document.getElementById('app');
  const scope = createClubRequestScope('');
  const state = {
    session: null,
    clubId: '',
    platformClubId: '',
    view: 'overview',
    dataByView: {},
    loadingView: false,
    viewError: '',
    banner: '',
    bannerKind: 'notice',
    filters: { memberStatus: 'all', inviteStatus: 'all', auditType: 'all' },
    pagination: {},
    pairing: null,
    pairingStatus: 'idle',
    pairingError: '',
    oneTimeCode: '',
    oneTimeInvite: null,
  };
  let pairingGeneration = 0;
  let pairingTimer = null;
  let codePresenter = createOneTimeCodePresenter();

  const PAGE_COPY = {
    overview: ['社团治理概览', '查看当前社团待处理的入社与恢复事项，并沿用现有统一审核队列。'],
    members: ['成员名册', '按成员状态查找记录，逐项处理成员资格并记录理由。'],
    invites: ['邀请码生命周期', '创建公开申请码或绑定账号的定向邀请，查看次数、预留和撤销状态。'],
    settings: ['社团规则设置', '编辑社团简介、章程和是否接收新的邀请码兑换。'],
    team: ['管理团队与换届', '查看本届管理团队，发起完整的新届提案并跟踪双方确认。'],
    audit: ['社团操作审计', '查看当前社团脱敏的成员、邀请、规则和交接事件。'],
    platform: ['平台管理', '维护社团元数据与平台恢复工单；此处不读取社团内容。'],
  };
  const REVIEW_ACTIONS = {
    content: 'admin/content/decide',
    comment: 'admin/comment/decide',
    topic: 'admin/topic/decide',
    board: 'admin/board/decide',
    member: 'admin/membership/decide',
    report: 'admin/report/decide',
    collection: 'admin/collection/decide',
    appeals: 'admin/appeal/decide',
  };
  const MEMBER_FILTERS = [
    ['all', '全部'], ['active', '正常'], ['removed', '已移除'], ['pending', '待处理'],
  ];
  const INVITE_FILTERS = [
    ['all', '全部'], ['active', '可用'], ['exhausted', '已用完'], ['expired', '已过期'], ['revoked', '已撤销'],
  ];

  function h(value) { return escapeHTML(value); }

  function dateText(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function countText(value) {
    return Number.isFinite(Number(value)) ? String(Number(value)) : '—';
  }

  function termReminder(endAt, now = Date.now()) {
    if (!endAt) return '';
    const end = new Date(endAt).getTime();
    if (!Number.isFinite(end)) return '';
    const days = Math.ceil((end - now) / 86400000);
    if (days > 30) return '';
    if (days > 7) return `本届任期剩余 ${days} 天，请安排换届准备。`;
    if (days >= 0) return `本届任期剩余 ${days} 天，请尽快确认交接安排。`;
    return `本届任期已结束 ${Math.abs(days)} 天；权限不会自动撤销，请尽快处理换届。`;
  }

  function clubRole() {
    const clubs = state.session && Array.isArray(state.session.clubs) ? state.session.clubs : [];
    return clubs.find((club) => (club.id || club.clubId) === state.clubId) || null;
  }

  function roleText(role) {
    if (role === 'moderator') return '社团负责人';
    if (role === 'admin') return '审核管理员';
    if (role === 'developer') return '平台开发者';
    return '普通成员';
  }

  function currentRoleText() {
    const membership = clubRole();
    if (state.view === 'platform' && state.session && state.session.platformRole === 'developer') return '平台开发者';
    return membership ? roleText(membership.role) : '未选择社团';
  }

  function itemsOf(result, key = 'items') {
    if (!result) return [];
    if (Array.isArray(result[key])) return result[key];
    if (Array.isArray(result.list)) return result.list;
    return [];
  }

  function selectedPlatformClub() {
    const clubs = itemsOf(state.dataByView.platform && state.dataByView.platform.clubs, 'list');
    return clubs.find((club) => club.id === state.platformClubId) || null;
  }

  function clearOneTimeCode() {
    codePresenter.clear();
    state.oneTimeCode = '';
    state.oneTimeInvite = null;
  }

  function setBanner(message, kind = 'notice') {
    state.banner = message || '';
    state.bannerKind = kind;
  }

  function renderLogin() {
    const pair = state.pairing;
    const qr = pair ? `<div class="qr-layout">
      <div class="qr-box"><img alt="扫码登录二维码" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(pair.qrSvg)}" /></div>
      <div>
        <span class="pill pill--clay">请求有效至 ${h(dateText(pair.expiresAt))}</span>
        <h2 style="margin-top:16px">用小程序确认登录</h2>
        <p>使用小程序扫码并确认登录；仅显示当前账号有权管理的社团。换届或权限变化后需重新登录。请核对确认页中的访问地址。</p>
        <div class="field"><label>登录来源</label><div class="mono">${h(pair.origin)}</div></div>
        <div class="button-row"><button class="button button--danger" data-action="pairing-cancel">取消本次登录</button><button class="button" data-action="pairing-retry">重新生成二维码</button></div>
      </div>
    </div>` : `<div class="stack">
      <p>通过小程序确认账号后，服务端会按当前社团身份与平台身份提供可用工作区。</p>
      ${state.pairingError ? `<div class="field-error" role="alert">${h(state.pairingError)}</div>` : ''}
      <button class="button button--primary" data-action="pairing-start" ${['creating', 'exchanging'].includes(state.pairingStatus) ? 'disabled' : ''}>${state.pairingStatus === 'creating' ? '正在准备二维码…' : state.pairingStatus === 'exchanging' ? '正在建立安全会话…' : '创建登录二维码'}</button>
      <div class="notice">请核对小程序确认页中的访问地址；不要批准与你当前访问地址不一致的请求。</div>
    </div>`;
    root.innerHTML = `<main class="main" style="margin-left:0;min-height:100vh">
      <section class="login-stage">
        <aside class="login-aside"><div class="brand-mark">HEIGUANG · GOVERNANCE</div><div><h1>把治理工作<br />交还给团队</h1><p>社团设置、成员资格和届次交接，在清晰的角色范围内完成。</p></div><div class="brand-sub">黑光文学社 · 管理工作台</div></aside>
        <div class="login-main"><div class="eyebrow">小程序确认登录</div><h2>社团治理工作台</h2><p>使用小程序扫码并确认登录；仅显示当前账号有权管理的社团。换届或权限变化后需重新登录。请核对确认页中的访问地址。</p>${qr}<div class="footer-note">如果访问地址或账号与你预期不符，请在小程序中拒绝。</div></div>
      </section>
    </main>`;
  }

  function renderClubControl() {
    const clubs = state.session && Array.isArray(state.session.clubs) ? state.session.clubs : [];
    if (!clubs.length) return `<div class="scope-control"><label>当前范围</label><div class="pill pill--green">${h(currentRoleText())}</div></div>`;
    return `<div class="scope-control"><label for="club-select">当前社团与权限</label><select id="club-select" data-club-select>
      ${clubs.map((club) => `<option value="${h(club.id || club.clubId)}" ${(club.id || club.clubId) === state.clubId ? 'selected' : ''}>${h(club.name || club.id || club.clubId)} · ${h(roleText(club.role))}</option>`).join('')}
    </select></div>`;
  }

  function renderShell() {
    const views = visibleWorkspaces(state.session, state.clubId);
    const copy = PAGE_COPY[state.view] || PAGE_COPY.overview;
    const data = state.dataByView[state.view] || {};
    const person = state.session && state.session.user || {};
    let body;
    try {
      body = renderWorkspace(data);
    } catch (error) {
      state.dataByView[state.view] = {};
      state.loadingView = false;
      state.viewError = '当前工作区暂时无法显示，请重新读取。';
      body = `<section class="panel"><div class="empty">${h(state.viewError)}</div></section>`;
    }
    const banner = state.banner ? `<div class="alert ${state.bannerKind === 'error' ? 'alert--error' : ''}" role="status">${h(state.banner)}</div>` : '';
    const viewError = state.viewError ? `<div class="alert alert--error" role="alert">${h(state.viewError)}</div>` : '';
    const loading = state.loadingView ? `<div class="loading">正在读取当前范围的数据…</div>` : '';
    root.innerHTML = `<div class="shell">
      <aside class="rail">
        <div class="brand"><div class="brand-mark">HEIGUANG · GOVERNANCE</div><div class="brand-name">黑光 · 社团治理</div><div class="brand-sub">按角色处理每一项工作</div></div>
        <nav class="nav" aria-label="管理工作区">${views.map((view) => `<button data-view="${h(view.id)}" aria-current="${state.view === view.id ? 'page' : 'false'}"><span class="nav-index">${h(view.eyebrow)}</span><span>${h(view.label)}</span></button>`).join('')}</nav>
        <div class="rail-bottom"><div class="rail-user">${h(person.displayName || person.id || '已登录账号')}</div><div class="rail-role">${h(currentRoleText())}</div><button class="logout" data-action="logout">退出管理台</button></div>
      </aside>
      <main class="main">
        ${banner}${viewError}
        <header class="topline"><div class="topline-copy"><div class="eyebrow">${h(state.view.toUpperCase())} / BLACKLIGHT</div><h1>${h(copy[0])}</h1><p class="lede">${h(copy[1])}</p></div>${renderClubControl()}</header>
        ${loading}<section class="content">${body}</section>
      </main>
    </div>`;
  }

  function renderWorkspace(data) {
    switch (state.view) {
      case 'overview': return renderOverview(data);
      case 'members': return renderMembers(data);
      case 'invites': return renderInvites(data);
      case 'settings': return renderSettings(data);
      case 'team': return renderTeam(data);
      case 'audit': return renderAudit(data);
      case 'platform': return renderPlatform(data);
      default: return `<div class="panel"><div class="empty">当前账号没有可用的管理工作区。</div></div>`;
    }
  }

  function stat(label, value, note = '') {
    const display = typeof value === 'string' ? value : countText(value);
    return `<div class="stat"><div class="stat-label">${h(label)}</div><div class="stat-value">${h(display)}</div>${note ? `<div class="secondary-text">${h(note)}</div>` : ''}</div>`;
  }

  function renderOverview(data) {
    const overview = data.overview || {};
    const pending = overview.pending || {};
    const term = overview.term || {};
    const queue = data.queue || {};
    const records = itemsOf(queue).map(renderQueueItem).join('') || `<div class="empty">当前没有待处理审核。</div>`;
    return `<div class="stack">
      <div class="stat-grid">
        ${stat('社团成员', overview.activeMembers, '仅成员数量，不包含私密内容指标')}
        ${stat('待处理入社', pending.memberships)}
        ${stat('人工加入 / 恢复', Number(pending.manualJoin || 0) + Number(pending.manualRestore || 0))}
        ${stat('待处理换届', pending.handovers)}
      </div>
      <div class="columns">
        <section class="panel"><div class="panel-head"><div><h2>统一审核队列</h2><p class="panel-note">复用现有审核权限、版本核对和处理动作。</p></div><span class="pill">${h(countText(queue.items && queue.items.length))} 条</span></div>
          <div class="queue-list">${records}</div>
          ${queue.nextCursor ? `<div class="button-row"><button class="button" data-action="queue-more">加载更多待审核</button></div>` : ''}
        </section>
        <aside class="stack">
          <section class="panel panel--green"><div class="eyebrow">CURRENT TERM</div><h2 class="subheading" style="margin-top:8px">本届管理团队</h2><div class="primary-text">${h(term.primaryUserId || '尚未指定负责人')}</div><div class="secondary-text">成员 ${h(countText(term.memberCount))} 人 · 任期至 ${h(dateText(term.endAt))}</div>${termReminder(term.endAt) ? `<div class="notice" style="margin-top:15px" role="status">${h(termReminder(term.endAt))}</div>` : ''}</section>
          <section class="panel panel--quiet"><div class="eyebrow">权限边界</div><p style="margin:10px 0 0">${h(currentRoleText())}。Web 每次写入仍由服务端核对账号、社团、角色和数据版本。</p>${clubRole() && clubRole().role === 'moderator' ? `<div class="button-row"><button class="button button--small" data-view="team">查看本届与换届</button><button class="button button--small" data-view="audit">查看操作审计</button></div>` : ''}</section>
        </aside>
      </div>
    </div>`;
  }

  function queueLabel(queue) {
    const labels = { content: '内容', comment: '回应', topic: '话题', board: '板块', member: '入社', report: '举报', collection: '文集', appeals: '申诉' };
    return labels[queue] || queue || '待处理事项';
  }

  function renderQueueItem(item) {
    const queue = item.queue || item.type;
    const text = item.summary || item.excerpt || item.content || item.body || item.reason || '';
    const actions = reviewActionsFor(item);
    const label = queue === 'content' && item.kind === 'article' ? '文章' : queue === 'content' ? '帖子复核' : queueLabel(queue);
    return `<article class="queue-item">
      <div class="queue-top"><span class="pill pill--clay">${h(label)}</span><span class="queue-meta">${h(dateText(item.submittedAt))}</span></div>
      <div class="queue-title">${h(item.title || item.displayName || item.subject || item.reason || '待处理事项')}</div>
      ${text ? `<div class="queue-body">${h(text)}</div>` : ''}
      <div class="queue-meta">${item.displayName ? `提交者 ${h(item.displayName)} · ` : ''}版本 ${h(item.version === undefined ? '—' : item.version)}</div>
      ${actions.length ? `<div class="button-row">${actions.map((action) => `<button class="button button--small ${/reject|remove|archive/i.test(action.key || '') ? 'button--danger' : ''}" data-review-key="${h(action.key)}" data-queue="${h(queue)}" data-id="${h(item.id)}">${h(action.label || action.key)}</button>`).join('')}</div>` : `<div class="secondary-text">没有可执行的处理动作。</div>`}
    </article>`;
  }

  function filterButtons(items, selected, kind) {
    return `<div class="filters">${items.map(([value, label]) => `<button class="filter" data-filter="${h(kind)}" data-value="${h(value)}" aria-pressed="${selected === value}">${h(label)}</button>`).join('')}</div>`;
  }

  function renderMembers(data) {
    const members = itemsOf(data.members || {});
    const rows = members.map((member) => {
      const canManageRole = member.status === 'active' && (member.role === 'member' || member.role === 'moderator');
      const roleAction = member.role === 'moderator' ? 'member' : 'moderator';
      return `<tr><td><div class="primary-text">${h(member.displayName || '未设置昵称')}</div><div class="secondary-text mono">${h(member.targetUserId)}</div></td>
        <td><span class="pill ${member.role === 'moderator' ? 'pill--green' : ''}">${h(roleText(member.role))}</span></td>
        <td><span class="pill ${member.status === 'active' ? 'pill--green' : member.status === 'removed' ? 'pill--red' : 'pill--clay'}">${h(member.status)}</span>${member.mutedUntil ? `<div class="secondary-text">禁言至 ${h(dateText(member.mutedUntil))}</div>` : ''}</td>
        <td><span class="mono">${h(member.version === undefined ? '—' : member.version)}</span></td>
        <td><div class="button-row" style="margin-top:0">${canManageRole ? `<button class="button button--small" data-member-action="role" data-role="${roleAction}" data-user-id="${h(member.targetUserId)}">${member.role === 'moderator' ? '撤销负责人' : '设为负责人'}</button>` : ''}${member.status === 'active' ? `<button class="button button--small" data-member-action="mute" data-user-id="${h(member.targetUserId)}">${member.mutedUntil ? '解除禁言' : '禁言'}</button><button class="button button--small button--danger" data-member-action="remove" data-user-id="${h(member.targetUserId)}">移除</button>` : ''}</div></td>
      </tr>`;
    }).join('');
    return `<div class="stack"><section class="panel">
      <div class="toolbar"><div><h2 style="margin:0;font-family:var(--serif);font-weight:500">成员名册</h2><div class="panel-note">${h(countText(members.length))} 条当前页记录 · 目标和变更版本由服务端复核</div></div>${filterButtons(MEMBER_FILTERS, state.filters.memberStatus, 'memberStatus')}</div>
      ${members.length ? `<div class="table-wrap"><table><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>版本</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">当前筛选没有成员记录。</div>`}
      ${data.members && data.members.nextCursor ? `<div class="button-row"><button class="button" data-action="members-more">加载下一页</button></div>` : ''}
    </section><div class="notice">审核管理员可以处理统一审核队列；只有本社团负责人可以查看名册、调整成员资格和管理邀请。</div></div>`;
  }

  function renderInvites(data) {
    const invitations = itemsOf(data.invites || {});
    const code = state.oneTimeCode ? `<div class="secret"><div><div class="secondary-text">刚创建的原码 · 只在本次页面内显示</div><div class="secret-code">${h(state.oneTimeCode)}</div><div class="secondary-text">${h(state.oneTimeInvite && state.oneTimeInvite.mode === 'direct' ? '绑定账号的定向直邀' : '公开申请码')} · 有效至 ${h(dateText(state.oneTimeInvite && state.oneTimeInvite.expiresAt))}</div></div><div class="button-row"><button class="button button--small" data-action="invite-copy">复制</button><button class="button button--small" data-action="invite-code-hide">隐藏原码</button></div></div>` : '';
    const rows = invitations.map((invite) => `<tr><td><div class="primary-text">${invite.mode === 'direct' ? '定向直邀' : '公开申请'}</div><div class="secondary-text mono">记录 ${h(invite.inviteId)}</div>${invite.targetUserId ? `<div class="secondary-text">绑定 ${h(invite.targetUserId)}</div>` : ''}</td>
      <td><span class="pill ${invite.status === 'active' ? 'pill--green' : invite.status === 'revoked' ? 'pill--red' : 'pill--clay'}">${h(invite.status)}</span></td>
      <td>${h(countText(invite.usedCount))} / ${h(countText(invite.maxUses))}<div class="secondary-text">预留 ${h(countText(invite.reservedCount))}</div></td>
      <td>${h(dateText(invite.expiresAt))}</td>
      <td>${invite.status === 'active' ? `<button class="button button--small button--danger" data-invite-revoke="${h(invite.inviteId)}">撤销</button>` : '—'}</td></tr>`).join('');
    return `<div class="columns"><section class="panel">
      <div class="panel-head"><div><h2>创建邀请码</h2><p class="panel-note">每个兑换仍需邀请码。公开码进入人工审核；定向码只绑定一个已有账号。</p></div></div>
      ${code}
      <form data-form="invite-create">
        <div class="field"><label for="invite-mode">邀请码用途</label><select id="invite-mode" name="mode" data-invite-mode><option value="application">公开申请</option><option value="direct">定向直邀</option></select></div>
        <div class="field-row"><div class="field application-field"><label for="invite-max">最多兑换次数</label><input id="invite-max" name="maxUses" type="number" min="1" max="1000" value="10" required /></div><div class="field"><label for="invite-ttl">有效天数</label><input id="invite-ttl" name="ttlDays" type="number" min="1" max="90" value="7" required /></div></div>
        <div class="field direct-field" hidden><label for="invite-target">绑定的目标账号 ID</label><input id="invite-target" name="targetUserId" maxlength="128" placeholder="只能由这个已有账号领取" /></div>
        <div class="field"><label for="invite-reason">创建理由</label><textarea id="invite-reason" name="reason" maxlength="500" minlength="10" required placeholder="至少 10 字，说明邀请用途与对象"></textarea></div>
        <div class="button-row"><button class="button button--primary" type="submit">创建邀请码</button></div>
      </form>
    </section><section class="panel">
      <div class="toolbar"><div><h2 style="margin:0;font-family:var(--serif);font-weight:500">邀请码记录</h2><p class="panel-note">列表只返回记录元数据，原码不会再次出现。</p></div>${filterButtons(INVITE_FILTERS, state.filters.inviteStatus, 'inviteStatus')}</div>
      ${invitations.length ? `<div class="table-wrap"><table><thead><tr><th>用途</th><th>状态</th><th>次数</th><th>有效期</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">此筛选下没有邀请码记录。</div>`}
      ${data.invites && data.invites.nextCursor ? `<div class="button-row"><button class="button" data-action="invites-more">加载下一页</button></div>` : ''}
    </section></div>`;
  }

  function renderSettings(data) {
    const settings = data.settings || {};
    const mode = settings.admissionMode === 'closed' ? 'closed' : 'invite_required';
    return `<div class="columns"><section class="panel">
      <div class="panel-head"><div><h2>本社团设置</h2><p class="panel-note">修改章程或入社状态会更新规则版本；修改简介不会改变入社规则版本。</p></div><span class="pill">规则版本 ${h(settings.rulesVersion || '—')}</span></div>
      <form data-form="settings-save">
        <div class="field"><label for="club-description">社团简介</label><textarea id="club-description" name="description" maxlength="300">${h(settings.description || '')}</textarea></div>
        <div class="field"><label for="club-charter">章程与社内约定</label><textarea id="club-charter" name="charter" maxlength="5000" style="min-height:220px">${h(settings.charter || '')}</textarea></div>
        <div class="field"><label for="admission-mode">新入社申请</label><select id="admission-mode" name="admissionMode"><option value="invite_required" ${mode === 'invite_required' ? 'selected' : ''}>接收新的邀请码兑换</option><option value="closed" ${mode === 'closed' ? 'selected' : ''}>暂停新的邀请码兑换</option></select><small>公开申请码和定向直邀都仍需使用邀请码；暂停只阻止新兑换，已提交且在预留期内的申请仍按原版本处理。</small></div>
        <div class="field"><label for="settings-reason">修改理由</label><textarea id="settings-reason" name="reason" maxlength="500" minlength="10" required placeholder="至少 10 字，说明本次规则调整"></textarea></div>
        <div class="button-row"><button class="button button--primary" type="submit">保存社团设置</button></div>
      </form>
    </section><aside class="stack"><div class="notice">这里只能修改简介、章程和入社状态。平台发布、上传及发现能力由平台配置决定，本页不会改动这些上限。</div><div class="panel panel--quiet"><div class="eyebrow">VERSION CHECK</div><p style="margin:9px 0 0">提交时会携带读取到的设置版本。若其他负责人已更新，服务端会拒绝旧版本并要求刷新。</p></div></aside></div>`;
  }

  function optionRows(members, selected = '') {
    return members.map((member) => `<option value="${h(member.targetUserId)}" ${member.targetUserId === selected ? 'selected' : ''}>${h(member.displayName || member.targetUserId)} · ${h(roleText(member.role))}</option>`).join('');
  }

  function auditActionText(item = {}) {
    const labels = {
      'member.role': '调整成员角色',
      'member.remove': '移除成员',
      'member.mute': '调整成员发言状态',
      'membership.active': '批准入社申请',
      'membership.approved': '批准入社申请',
      'membership.rejected': '拒绝入社申请',
      'membership.cancelled': '撤回入社申请',
      'membership.expired': '入社申请过期',
      'management.primary.cleared.account_deletion': '账号删除后清除负责人',
      'management.primary.bootstrap': '初始化本届负责人',
      'management.handover.proposed': '提交换届提案',
      'management.handover.cancelled': '取消换届提案',
      'management.handover.declined': '拒绝换届安排',
      'management.handover.stale': '换届提案已失效',
      'management.handover.completed': '完成换届',
      'management.recovery.stale': '恢复工单已失效',
      'management.recovery.completed': '完成负责人恢复',
      'platform.recovery.requested': '发起负责人恢复工单',
      'platform.recovery.accepted': '复核负责人恢复工单',
      'platform.recovery.rejected': '拒绝负责人恢复工单',
      'platform.recovery.expired': '负责人恢复工单过期',
      'invite.create': '创建邀请码',
      'invite.revoke': '撤销邀请码',
      'settings.update': '更新社团规则',
    };
    return labels[item.action] || item.summary || item.action || '管理操作';
  }

  function auditTargetText(item = {}) {
    const targetTypes = {
      membership_application: '入社申请',
      membership: '成员资格',
      invite: '邀请码',
      invitation: '邀请码',
      management_request: '管理请求',
      management_recovery: '恢复工单',
      management_term: '届次',
      club: '社团',
    };
    const type = targetTypes[item.targetType] || item.targetType || '管理对象';
    return `${type}${item.targetId ? ` · ${item.targetId}` : ''}`;
  }

  function renderTeam(data) {
    const team = data.team || {};
    const term = team.term || {};
    const candidatesComplete = data.candidatePagesComplete === true;
    const invitesComplete = data.invitePagesComplete === true;
    const canCreateHandover = candidatesComplete && invitesComplete;
    const active = canCreateHandover ? itemsOf(data.members || {}).filter((member) => member.status === 'active') : [];
    const currentTeam = Array.isArray(team.members) ? team.members : [];
    const handovers = itemsOf(data.handovers || {});
    const invites = canCreateHandover ? retainableInvites(itemsOf(data.invites || {})) : [];
    const teamRows = currentTeam.map((member) => `<tr><td>${h(member.displayName || member.targetUserId)}<div class="secondary-text mono">${h(member.targetUserId)}</div></td><td>${h(roleText(member.role))}</td><td><span class="pill pill--green">${h(member.status)}</span></td></tr>`).join('');
    const activeModerators = currentTeam.filter((member) => member.status === 'active' && member.role === 'moderator');
    const primaryForm = term.primaryUserId
      ? `<div class="notice">本届负责人已指定。更换负责人请发起正常换届；负责人失联时走平台恢复流程。</div>`
      : `<form data-form="team-primary"><div class="field"><label>从现任 moderator 中初始化负责人</label><select name="targetUserId" required><option value="">选择负责人</option>${optionRows(activeModerators)}</select></div><div class="field"><label>理由</label><input name="reason" minlength="10" maxlength="500" required placeholder="至少 10 字" /></div><button class="button button--primary" type="submit">初始化本届负责人</button></form>`;
    const roleControls = active.map((member) => {
      return `<div class="field-row"><label class="primary-text" style="align-self:center">${h(member.displayName || member.targetUserId)}<small class="mono">${h(member.targetUserId)}</small></label><select name="role:${h(member.targetUserId)}"><option value="">不续任</option><option value="moderator">社团负责人</option><option value="admin">审核管理员</option></select></div>`;
    }).join('');
    const inviteChecks = invites.map((invite) => `<label class="field-check"><input type="checkbox" name="retainInviteIds" value="${h(invite.inviteId)}" /><span>保留公开申请码 ${h(invite.inviteId)} · ${h(countText(invite.reservedCount))} 条待处理预留</span></label>`).join('') || `<p class="panel-note">没有仍有效的公开申请码需要选择。</p>`;
    const currentUserId = state.session && state.session.user && state.session.user.id;
    const handoverRows = handovers.map((item) => {
      const isCreator = item.creatorId === currentUserId;
      const controls = item.status === 'proposed' && isCreator ? `<div class="button-row"><button class="button button--small button--danger" data-handover-cancel="${h(item.id)}">取消提案</button></div>` : '';
      return `<article class="record-item"><div class="record-top"><div><span class="pill pill--clay">${h(item.status)}</span><div class="primary-text" style="margin-top:8px">提案 ${h(item.id)}</div></div><div class="record-meta">有效至 ${h(dateText(item.expiresAt))}</div></div><div class="secondary-text">${h(item.reason || '')}</div>${controls}</article>`;
    }).join('') || `<div class="empty">暂无换届记录。</div>`;
    return `<div class="stack">
      <div class="stat-grid">${stat('本届负责人', term.primaryUserId ? '已指定' : '未指定', term.primaryUserId || '可初始化负责人')}${stat('管理团队', currentTeam.length, '仅显示当前届 active 管理成员')}${stat('任期起始', term.startAt ? dateText(term.startAt) : '—')}${stat('任期结束', term.endAt ? dateText(term.endAt) : '未设置')}</div>
      <div class="columns equal"><section class="panel"><div class="panel-head"><div><h2>当前管理团队</h2><p class="panel-note">成员内容保留在原账号下，不会随届次迁移。</p></div></div>${currentTeam.length ? `<div class="table-wrap"><table><thead><tr><th>成员</th><th>团队角色</th><th>状态</th></tr></thead><tbody>${teamRows}</tbody></table></div>` : `<div class="empty">当前届次暂无团队快照。</div>`}<h3 class="subheading">负责人</h3>${primaryForm}</section>
        <section class="panel"><div class="panel-head"><div><h2>发起新一届</h2><p class="panel-note">至少包含一名负责人。继任者由小程序本人确认后，数据库在同一事务完成换权。</p></div></div>
          ${!canCreateHandover ? `<div class="notice">成员或邀请分页没有完整载入，换届提交已停用。请重新读取完整列表后再操作。<div class="button-row"><button class="button" data-action="team-reload">重新读取团队</button></div></div>` : active.length ? `<form data-form="handover-create"><div class="field"><label>新一届负责人</label><select name="primaryUserId" required><option value="">选择 active 成员</option>${optionRows(active)}</select></div><div class="field"><label>拟任团队与角色</label>${roleControls}<small>负责人必须列入团队并担任“社团负责人”；新一届团队最多 50 人。</small></div><div class="field"><label>任期结束时间（可选）</label><input type="datetime-local" name="termEndAt" /></div><div class="field"><label>交接理由</label><textarea name="reason" minlength="10" maxlength="500" required placeholder="说明交接安排，至少 10 字"></textarea></div><div class="field"><label>上一届公开申请码是否保留</label>${inviteChecks}<small>未勾选的旧届公开码会在换届事务中撤销；direct 码会按规则撤销。</small></div><button class="button button--primary" type="submit">提交换届提案</button></form>` : `<div class="empty">没有可选择的 active 成员。</div>`}
        </section></div>
      <section class="panel"><div class="panel-head"><div><h2>换届记录</h2><p class="panel-note">当前负责人可取消仍在等待确认的提案。</p></div></div><div class="record-list">${handoverRows}</div></section>
    </div>`;
  }

  function renderAudit(data) {
    const records = itemsOf(data.audit || {});
    const rows = records.map((item) => `<tr><td><span class="pill">${h(auditActionText(item))}</span></td><td><div class="primary-text">${h(auditTargetText(item))}</div><div class="secondary-text">${h(item.reason || '')}</div></td><td>${h(item.actorDisplayName || item.actorLabel || item.actorId || '管理成员')}</td><td>${h(dateText(item.createdAt))}</td></tr>`).join('');
    return `<section class="panel"><div class="panel-head"><div><h2>社团操作审计</h2><p class="panel-note">只显示脱敏的成员、邀请、规则与届次事件，不包含邀请码原码、哈希或私密内容。</p></div></div>
      ${records.length ? `<div class="table-wrap"><table><thead><tr><th>操作</th><th>对象与理由</th><th>操作者账号</th><th>时间</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">当前没有审计记录。</div>`}
      ${data.audit && data.audit.nextCursor ? `<div class="button-row"><button class="button" data-action="audit-more">加载下一页</button></div>` : ''}
    </section>`;
  }

  function renderPlatform(data) {
    const clubs = itemsOf(data.clubs || {}, 'list');
    const club = selectedPlatformClub();
    const recoveries = itemsOf(data.recoveries || {});
    const hasPrimaryState = !!club && Object.prototype.hasOwnProperty.call(club, 'primaryUserId');
    const primaryId = hasPrimaryState && club.primaryUserId ? club.primaryUserId : '';
    const recoveryRows = recoveries.map((item) => `<article class="record-item"><div class="record-top"><span class="pill ${item.status === 'recovery_requested' ? 'pill--clay' : 'pill--green'}">${h(item.status)}</span><span class="record-meta">${h(dateText(item.expiresAt))}</span></div><div class="primary-text" style="margin-top:8px">${h(item.clubName || club && club.name || '社团')} · ${h(item.targetDisplayName || item.targetUserId || '目标成员')}</div><div class="secondary-text">${h(item.reason || '')}</div>${item.status === 'recovery_requested' ? `<div class="button-row"><button class="button button--small button--primary" data-recovery-approve="${h(item.id)}" data-version="${h(item.version)}">复核恢复申请</button></div>` : ''}</article>`).join('');
    const createClub = `<section class="panel"><div class="panel-head"><div><h2>创建社团</h2><p class="panel-note">只能配置平台元数据与能力上限，不读取或处理社团内容。</p></div></div><form data-form="platform-create"><div class="field-row"><div class="field"><label>社团 ID</label><input name="id" maxlength="64" pattern="[a-z0-9_-]+" required /></div><div class="field"><label>名称</label><input name="name" maxlength="60" required /></div></div><div class="field"><label>简介</label><textarea name="description" maxlength="300"></textarea></div><div class="field"><label>初始负责人账号 ID</label><input name="moderatorUserId" maxlength="128" required /></div><div class="field-row"><label class="field-check"><input type="checkbox" name="discoverable" /><span>允许在目录发现</span></label><label class="field-check"><input type="checkbox" name="publishing" /><span>允许发布</span></label><label class="field-check"><input type="checkbox" name="uploads" /><span>允许上传</span></label></div><div class="field"><label>创建理由</label><textarea name="reason" minlength="10" maxlength="500" required></textarea></div><button class="button button--primary" type="submit">创建社团与初始负责人</button></form></section>`;
    const editClub = club ? `<section class="panel"><div class="panel-head"><div><h2>${h(club.name || club.id)} · 元数据</h2><p class="panel-note mono">${h(club.id)} · 版本 ${h(club.version)}</p></div><span class="pill ${club.status === 'active' ? 'pill--green' : 'pill--red'}">${h(club.status)}</span></div>
      <form data-form="platform-update"><div class="field"><label>名称</label><input name="name" maxlength="60" required value="${h(club.name || '')}" /></div><div class="field"><label>简介</label><textarea name="description" maxlength="300">${h(club.description || '')}</textarea></div><div class="field-row"><label class="field-check"><input type="checkbox" name="discoverable" ${club.discoverable ? 'checked' : ''} /><span>允许在目录发现</span></label><label class="field-check"><input type="checkbox" name="publishing" ${club.publishing ? 'checked' : ''} /><span>允许发布</span></label><label class="field-check"><input type="checkbox" name="uploads" ${club.uploads ? 'checked' : ''} /><span>允许上传</span></label></div><div class="field"><label>修改理由</label><textarea name="reason" minlength="10" maxlength="500" required placeholder="至少 10 字"></textarea></div><button class="button button--primary" type="submit">保存社团元数据</button></form>
      ${!hasPrimaryState ? `<div class="notice" style="margin-top:16px">当前负责人状态暂不可读取，暂不提供初始化操作。请刷新后重试。</div>` : primaryId ? `<div class="notice" style="margin-top:16px">当前负责人 ${h(primaryId)}。更换负责人必须使用社团换届；负责人失联时发起恢复工单，平台账号不能直接替代社团团队交接。</div>` : `<form data-form="platform-initial-primary"><div class="field"><label>初始化负责人账号 ID</label><input name="moderatorUserId" maxlength="128" required /></div><div class="field"><label>理由</label><input name="reason" minlength="10" maxlength="500" required /></div><button class="button" type="submit">初始化负责人</button></form>`}
      <div class="button-row"><button class="button ${club.status === 'active' ? 'button--danger' : 'button--primary'}" data-platform-status>${club.status === 'active' ? '暂停社团' : '恢复社团'}</button></div>
    </section>` : `<section class="panel"><div class="empty">先选择一个社团，或创建第一个社团。</div></section>`;
    return `<div class="stack"><div class="columns equal"><section class="panel"><div class="panel-head"><div><h2>平台范围</h2><p class="panel-note">开发者权限只作用于元数据和恢复工作流。</p></div></div><div class="field"><label for="platform-club">选择社团</label><select id="platform-club" data-platform-club><option value="">选择社团</option>${clubs.map((item) => `<option value="${h(item.id)}" ${item.id === state.platformClubId ? 'selected' : ''}>${h(item.name || item.id)} · ${h(item.status)}</option>`).join('')}</select></div><div class="secondary-text">平台开发者身份不会授予社团审核、成员管理或私密内容读取权限。</div></section>${editClub}</div>
      <div class="columns equal">${createClub}<section class="panel"><div class="panel-head"><div><h2>负责人失联恢复</h2><p class="panel-note">目标本人接受后，再按双人复核或冷却期规则处理。</p></div></div>
        <form data-form="recovery-request"><div class="field"><label>目标账号 ID</label><input name="targetUserId" maxlength="128" required /></div><div class="field"><label>恢复理由</label><textarea name="reason" minlength="10" maxlength="500" required placeholder="说明失联情况与所需权限"></textarea></div><div class="notice">恢复完成后仅目标账号保留管理权限，现有其他管理员降为普通成员。</div>${club && club.managementTermVersion !== undefined && club.managementTermVersion !== null ? '' : '<p class="field-error">当前任期版本暂不可读取，刷新后再发起恢复工单。</p>'}<button class="button button--primary" type="submit" ${club && club.managementTermVersion !== undefined && club.managementTermVersion !== null ? '' : 'disabled'}>发起平台恢复工单</button></form>
        <h3 class="subheading">恢复工单</h3><div class="record-list">${recoveryRows || '<div class="empty">此社团暂无恢复工单。</div>'}</div>
      </section></div></div>`;
  }

  async function loadView(view = state.view, { append = false } = {}) {
    if (!state.session || !canSeeWorkspace(view, state.session, state.clubId)) return;
    const viewClubId = view === 'platform' ? '' : state.clubId;
    const token = scope.begin();
    const cursor = append && state.pagination[view] ? state.pagination[view].nextCursor : '';
    if (view === 'team') state.dataByView.team = null;
    state.loadingView = true;
    state.viewError = '';
    renderShell();
    try {
      let result;
      if (view === 'overview') {
        const [overview, queue] = await Promise.all([
          api.action('admin/overview', viewClubId, {}),
          api.action('admin/queue', viewClubId, { queue: 'all', limit: 20, ...(append ? { cursor } : {}) }),
        ]);
        result = { overview, queue: append ? { ...queue, items: itemsOf(state.dataByView.overview && state.dataByView.overview.queue).concat(itemsOf(queue)) } : queue };
        state.pagination.overview = { nextCursor: queue.nextCursor || '' };
      } else if (view === 'members') {
        const members = await api.action('admin/members/list', viewClubId, { limit: 50, status: state.filters.memberStatus === 'all' ? '' : state.filters.memberStatus, ...(append ? { cursor } : {}) });
        result = { members: append ? { ...members, items: itemsOf(state.dataByView.members && state.dataByView.members.members).concat(itemsOf(members)) } : members };
        state.pagination.members = { nextCursor: members.nextCursor || '' };
      } else if (view === 'invites') {
        const invites = await api.action('admin/invites/list', viewClubId, { limit: 30, status: state.filters.inviteStatus === 'all' ? '' : state.filters.inviteStatus, ...(append ? { cursor } : {}) });
        result = { invites: append ? { ...invites, items: itemsOf(state.dataByView.invites && state.dataByView.invites.invites).concat(itemsOf(invites)) } : invites };
        state.pagination.invites = { nextCursor: invites.nextCursor || '' };
      } else if (view === 'settings') {
        result = { settings: await api.action('admin/club/settings', viewClubId, {}) };
      } else if (view === 'team') {
        const isTeamRequestCurrent = () => scope.isCurrent(token) && state.view === view && state.clubId === viewClubId;
        const [team, memberPages, invitePages, handovers] = await Promise.all([
          api.action('admin/management/team', viewClubId, {}),
          collectPagedItems(
            ({ limit, cursor: pageCursor }) => api.action('admin/members/list', viewClubId, {
              limit, status: 'active', ...(pageCursor ? { cursor: pageCursor } : {}),
            }),
            { limit: 100, maxPages: 50, isCurrent: isTeamRequestCurrent },
          ),
          collectPagedItems(
            ({ limit, cursor: pageCursor }) => api.action('admin/invites/list', viewClubId, {
              limit, status: 'active', ...(pageCursor ? { cursor: pageCursor } : {}),
            }),
            { limit: 100, maxPages: 50, isCurrent: isTeamRequestCurrent },
          ),
          api.action('admin/handovers/list', viewClubId, { limit: 50 }),
        ]);
        if (!isTeamRequestCurrent()) return;
        result = {
          team,
          members: { items: activeTeamCandidates(memberPages.items, team.members || []) },
          invites: { items: retainableInvites(invitePages.items) },
          handovers,
          candidatePagesComplete: memberPages.complete,
          invitePagesComplete: invitePages.complete,
        };
      } else if (view === 'audit') {
        const audit = await api.action('admin/audit/list', viewClubId, { limit: 50, ...(append ? { cursor } : {}) });
        result = { audit: append ? { ...audit, items: itemsOf(state.dataByView.audit && state.dataByView.audit.audit).concat(itemsOf(audit)) } : audit };
        state.pagination.audit = { nextCursor: audit.nextCursor || '' };
      } else if (view === 'platform') {
        const clubsResult = await api.action('platform/clubs/list', '', {});
        const clubs = itemsOf(clubsResult, 'list');
        if (!state.platformClubId && clubs.length) state.platformClubId = clubs[0].id;
        const recoveries = state.platformClubId
          ? await api.action('platform/recovery/list', state.platformClubId, { limit: 50 })
          : { items: [] };
        result = { clubs: { list: clubs }, recoveries };
      }
      if (!scope.isCurrent(token) || state.view !== view) return;
      state.dataByView[view] = result || {};
      state.loadingView = false;
      state.viewError = '';
      renderShell();
    } catch (error) {
      if (!scope.isCurrent(token) || state.view !== view) return;
      state.loadingView = false;
      state.viewError = error.message || '当前数据暂时无法读取。';
      if (error.status === 401) await expireSession();
      else renderShell();
    }
  }

  function setClub(clubId) {
    const clubs = state.session && Array.isArray(state.session.clubs) ? state.session.clubs : [];
    const allowed = clubs.find((club) => (club.id || club.clubId) === clubId);
    if (!allowed) return;
    clearOneTimeCode();
    state.clubId = clubId;
    scope.setClub(clubId);
    state.dataByView = {};
    state.pagination = {};
    const views = visibleWorkspaces(state.session, state.clubId);
    state.view = views.length ? views[0].id : 'platform';
    setBanner(`已切换到 ${allowed.name || clubId} · ${roleText(allowed.role)}。`, 'notice');
    renderShell();
    loadView();
  }

  function setView(view) {
    if (view === state.view || !canSeeWorkspace(view, state.session, state.clubId)) return;
    clearOneTimeCode();
    state.view = view;
    state.viewError = '';
    state.pagination[view] = { nextCursor: '' };
    renderShell();
    loadView(view);
  }

  function setSession(session) {
    if (!session || !session.user || !session.user.id) throw new Error('服务端没有返回已验证的账号。');
    state.session = session;
    const clubs = Array.isArray(session.clubs) ? session.clubs : [];
    state.clubId = clubs.length ? clubs[0].id || clubs[0].clubId : '';
    scope.setClub(state.clubId);
    const views = visibleWorkspaces(session, state.clubId);
    state.view = views.length ? views[0].id : session.platformRole === 'developer' ? 'platform' : 'overview';
    state.dataByView = {};
    state.pagination = {};
    state.viewError = '';
    state.banner = '';
    renderShell();
    loadView();
  }

  async function boot() {
    try {
      const session = await api.getSession();
      setSession(session);
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) state.pairingError = error.message;
      renderLogin();
    }
  }

  function stopPairing() {
    pairingGeneration += 1;
    if (pairingTimer) clearTimeout(pairingTimer);
    pairingTimer = null;
    state.pairing = null;
    state.pairingStatus = 'idle';
  }

  async function createPairing() {
    stopPairing();
    const generation = pairingGeneration;
    state.pairingError = '';
    state.pairingStatus = 'creating';
    renderLogin();
    try {
      const data = await api.createPairing();
      if (generation !== pairingGeneration) return;
      const pairing = createPairingView(data, window.location.origin);
      state.pairing = pairing;
      state.pairingStatus = 'pending';
      renderLogin();
      schedulePairingPoll(generation);
    } catch (error) {
      state.pairingStatus = 'idle';
      state.pairingError = error.message || '登录二维码暂时无法创建。';
      renderLogin();
    }
  }

  function schedulePairingPoll(generation) {
    if (generation !== pairingGeneration || !state.pairing) return;
    pairingTimer = setTimeout(() => pollPairing(generation), 1400);
  }

  async function pollPairing(generation) {
    const pairing = state.pairing;
    if (generation !== pairingGeneration || !pairing) return;
    if (new Date(pairing.expiresAt).getTime() <= Date.now()) {
      state.pairingStatus = 'expired';
      state.pairingError = '登录二维码已过期，请重新生成。';
      state.pairing = null;
      renderLogin();
      return;
    }
    try {
      const result = await api.pairingStatus(pairing.id, pairing.pollKey);
      if (generation !== pairingGeneration || !state.pairing) return;
      if (result.status === 'approved') {
        if (!result.exchangeCode) throw new Error('登录确认缺少一次性兑换凭据。');
        const pairingData = state.pairing;
        stopPairing();
        state.pairingStatus = 'exchanging';
        renderLogin();
        try {
          await api.exchangePairing(pairingData.id, pairingData.pollKey, result.exchangeCode);
          const session = await api.getSession();
          setSession(session);
        } catch (error) {
          state.pairingStatus = 'idle';
          state.pairingError = error.message || '登录会话暂时无法建立。';
          renderLogin();
        }
        return;
      }
      if (result.status === 'rejected' || result.status === 'expired') {
        stopPairing();
        state.pairingStatus = result.status;
        state.pairingError = result.status === 'rejected' ? '小程序账号已拒绝这次登录。' : '登录二维码已过期。';
        renderLogin();
        return;
      }
      if (result.status !== 'pending') throw new Error('登录请求状态无效。');
      schedulePairingPoll(generation);
    } catch (error) {
      if (generation !== pairingGeneration) return;
      stopPairing();
      state.pairingStatus = 'idle';
      state.pairingError = error.message || '登录状态暂时无法读取。';
      renderLogin();
    }
  }

  async function expireSession() {
    stopPairing();
    clearOneTimeCode();
    clearExpiredSessionState(state);
    scope.setClub('');
    scope.begin();
    api.clearCsrf();
    state.pairingError = '管理会话已过期，请重新扫码登录。';
    renderLogin();
  }

  async function logout() {
    try {
      await api.logout();
      state.banner = '';
      state.pairingError = '';
      state.session = null;
      state.clubId = '';
      state.dataByView = {};
      clearOneTimeCode();
      renderLogin();
    } catch (error) {
      const failure = logoutFailureView(error);
      if (failure.kind === 'expired') {
        await expireSession();
        return;
      }
      state.viewError = failure.message;
      renderShell();
    }
  }

  function showActionDialog({ title, message, confirmText = '确认提交', reason = null }) {
    const focusBeforeOpen = document.activeElement;
    const previousBodyOverflow = document.body.style.overflow;
    const reasonField = reason ? `<div class="field action-modal__reason">
      <label for="action-modal-reason">${h(reason.label || '处理理由')}</label>
      <textarea id="action-modal-reason" name="reason" maxlength="${h(reason.maximum)}" placeholder="${h(reason.placeholder || '填写处理理由')}"></textarea>
      <small>${reason.minimum > 1 ? `至少 ${h(reason.minimum)} 字 · ` : ''}最多 ${h(reason.maximum)} 字；提交后会记录处理理由。</small>
    </div>` : '';
    const modal = document.createElement('div');
    modal.className = 'action-modal';
    modal.innerHTML = `<div class="action-modal__backdrop" data-modal-cancel></div>
      <section class="action-modal__panel" role="dialog" aria-modal="true" aria-labelledby="action-modal-title" tabindex="-1">
        <form class="action-modal__form" data-modal-form>
          <h2 id="action-modal-title">${h(title || '确认操作')}</h2>
          ${message ? `<p class="action-modal__message">${h(message)}</p>` : ''}
          ${reasonField}
          <div class="action-modal__error" data-modal-error role="alert" aria-live="polite"></div>
          <div class="button-row action-modal__buttons">
            <button class="button" type="button" data-modal-cancel>取消</button>
            <button class="button button--primary" type="submit">${h(confirmText)}</button>
          </div>
        </form>
      </section>`;

    return new Promise((resolve) => {
      let settled = false;
      const form = modal.querySelector('[data-modal-form]');
      const panel = modal.querySelector('[role="dialog"]');
      const textarea = modal.querySelector('textarea[name="reason"]');
      const errorNode = modal.querySelector('[data-modal-error]');
      let onKeydown;
      const finish = (confirmed, value = '') => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeydown, true);
        modal.remove();
        document.body.style.overflow = previousBodyOverflow;
        if (focusBeforeOpen && typeof focusBeforeOpen.focus === 'function') focusBeforeOpen.focus();
        resolve({ confirmed, reason: value });
      };
      const cancel = (event) => {
        if (event) event.preventDefault();
        finish(false);
      };
      const submit = (event) => {
        event.preventDefault();
        const value = textarea ? textarea.value.trim() : '';
        const minimum = reason && reason.required ? (reason.minimum || 1) : 0;
        const maximum = reason && reason.maximum ? reason.maximum : 0;
        if (value.length < minimum) {
          errorNode.textContent = `请填写至少 ${minimum} 字的处理理由。`;
          if (textarea) textarea.focus();
          return;
        }
        if (maximum && value.length > maximum) {
          errorNode.textContent = `处理理由最多 ${maximum} 字。`;
          if (textarea) textarea.focus();
          return;
        }
        finish(true, value);
      };
      onKeydown = (event) => {
        if (event.key === 'Escape') {
          cancel(event);
          return;
        }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(modal.querySelectorAll('button:not(:disabled), textarea'));
        if (!focusable.length) {
          event.preventDefault();
          panel.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };
      form.addEventListener('submit', submit);
      modal.querySelectorAll('[data-modal-cancel]').forEach((button) => button.addEventListener('click', cancel));
      if (textarea) textarea.addEventListener('input', () => { errorNode.textContent = ''; });
      document.addEventListener('keydown', onKeydown, true);
      document.body.style.overflow = 'hidden';
      document.body.appendChild(modal);
      if (textarea) textarea.focus();
      else panel.focus();
    });
  }

  async function write(action, clubId, payload, successText, reloadView = state.view) {
    const targetView = reloadView;
    const token = scope.begin();
    const targetClub = clubId;
    try {
      await api.action(action, targetClub, payload);
      if (!scope.isCurrent(token) || state.view !== targetView) return;
      setBanner(successText, 'notice');
      state.pagination[targetView] = { nextCursor: '' };
      await loadView(targetView);
    } catch (error) {
      if (!scope.isCurrent(token)) return;
      if (error.status === 401) {
        await expireSession();
        return;
      }
      setBanner(error.message || '操作未完成。', 'error');
      renderShell();
      if (error.status === 409) loadView(targetView);
    }
  }

  async function submitReview(button) {
    const queue = button.dataset.queue;
    const id = button.dataset.id;
    const data = state.dataByView.overview || {};
    const queueItems = itemsOf(data.queue || {});
    const item = queueItems.find((entry) => entry.id === id && (entry.queue || entry.type) === queue);
    if (!item) return;
    const action = reviewActionsFor(item).find((entry) => entry.key === button.dataset.reviewKey);
    const route = REVIEW_ACTIONS[queue];
    if (!action || !route || item.version === undefined || item.version === null) return;
    const decision = action.key;
    const targetId = queue === 'appeals' ? item.appealId || item.id : item.id;
    const targetText = [item.title || item.displayName || item.subject || '待处理事项', item.summary, `版本 ${item.version}`]
      .filter(Boolean).join('\n');
    const result = await showActionDialog({
      title: action.label || '审核决定',
      message: targetText,
      confirmText: '提交决定',
      ...(action.requiresReason ? { reason: {
        label: '处理理由',
        placeholder: '填写处理理由',
        required: true,
        minimum: 1,
        maximum: action.maxReasonLength || 200,
      } } : {}),
    });
    if (!result.confirmed) return;
    const reason = result.reason;
    const payload = queue === 'appeals'
      ? { appealId: targetId, decision, expectedVersion: item.version, reason }
      : { id: targetId, decision, expectedVersion: item.version, reason };
    await write(route, state.clubId, payload, '审核决定已提交。', 'overview');
  }

  async function submitMemberAction(button) {
    const userId = button.dataset.userId;
    const member = itemsOf(state.dataByView.members && state.dataByView.members.members || {}).find((item) => item.targetUserId === userId);
    if (!member || member.version === undefined || member.version === null) return;
    const kind = button.dataset.memberAction;
    const operation = kind === 'remove' ? '移除' : kind === 'mute' ? '禁言状态变更' : '角色变更';
    const result = await showActionDialog({
      title: `确认${operation}`,
      message: `目标成员：${member.displayName || '未设置昵称'}\n账号：${userId}\n成员状态：${member.status} · 版本 ${member.version}`,
      confirmText: `确认${operation}`,
      reason: { label: '操作理由', placeholder: '说明本次成员管理决定', required: true, minimum: 10, maximum: 500 },
    });
    if (!result.confirmed) return;
    const reason = result.reason;
    if (kind === 'role') {
      await write('admin/member/role', state.clubId, { targetUserId: userId, role: button.dataset.role, expectedVersion: member.version, reason }, '成员角色已更新。');
    } else if (kind === 'remove') {
      await write('admin/member/remove', state.clubId, { targetUserId: userId, expectedVersion: member.version, reason }, '成员已移除。');
    } else {
      const mutedUntil = member.mutedUntil ? null : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await write('admin/member/mute', state.clubId, { targetUserId: userId, mutedUntil, expectedVersion: member.version, reason }, mutedUntil ? '已禁言 24 小时。' : '已解除禁言。');
    }
  }

  async function submitInviteRevoke(button) {
    const invite = itemsOf(state.dataByView.invites && state.dataByView.invites.invites || {}).find((item) => item.inviteId === button.dataset.inviteRevoke);
    if (!invite || invite.version === undefined || invite.version === null) return;
    const result = await showActionDialog({
      title: '撤销邀请码',
      message: `邀请码：${invite.inviteId} · 版本 ${invite.version}\n撤销后会阻止新的兑换。已提交且仍在预留期内的申请继续处理。`,
      confirmText: '确认撤销',
      reason: { label: '撤销理由', placeholder: '说明撤销原因', required: true, minimum: 10, maximum: 500 },
    });
    if (!result.confirmed) return;
    const reason = result.reason;
    await write('admin/invites/revoke', state.clubId, { inviteId: invite.inviteId, expectedVersion: invite.version, reason }, '邀请码已撤销。');
  }

  function formData(form) { return new FormData(form); }
  function stringValue(data, key) { return String(data.get(key) || '').trim(); }

  async function handleForm(form) {
    const data = formData(form);
    const formName = form.dataset.form;
    const reason = stringValue(data, 'reason');
    if (reason.length < 10) {
      setBanner('请填写至少 10 字的操作理由。', 'error');
      renderShell();
      return;
    }
    if (reason.length > 500) {
      setBanner('操作理由最多 500 字。', 'error');
      renderShell();
      return;
    }

    if (formName === 'invite-create') {
      const mode = stringValue(data, 'mode');
      const maxUses = mode === 'direct' ? 1 : Number(data.get('maxUses'));
      const ttlDays = Number(data.get('ttlDays'));
      const targetUserId = stringValue(data, 'targetUserId');
      if (!['application', 'direct'].includes(mode) || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000
        || !Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 90 || (mode === 'direct' && !targetUserId)) {
        setBanner('邀请码类型、次数、有效期或绑定账号不符合要求。', 'error');
        renderShell();
        return;
      }
      try {
        const result = await api.action('admin/invites/create', state.clubId, {
          mode, maxUses, ttlSeconds: ttlDays * 86400, ...(mode === 'direct' ? { targetUserId } : {}), reason,
        });
        codePresenter = createOneTimeCodePresenter();
        state.oneTimeCode = codePresenter.reveal(result && result.code);
        state.oneTimeInvite = result && result.inviteId ? { inviteId: result.inviteId, mode, expiresAt: result.expiresAt } : null;
        if (!state.oneTimeCode || !state.oneTimeInvite) {
          setBanner('邀请码创建结果未返回一次性原码。请查看列表并撤销无法安全交付的记录，再创建新码。', 'error');
        } else setBanner('邀请码已创建。原码只在当前页面显示一次，请立即复制并交付给目标。', 'notice');
        state.pagination.invites = { nextCursor: '' };
        await loadView('invites');
      } catch (error) {
        setBanner(error.message || '邀请码创建未完成。', 'error');
        renderShell();
      }
      return;
    }

    if (formName === 'settings-save') {
      const current = state.dataByView.settings && state.dataByView.settings.settings || {};
      await write('admin/club/update', state.clubId, {
        description: stringValue(data, 'description'),
        charter: stringValue(data, 'charter'),
        admissionMode: stringValue(data, 'admissionMode'),
        expectedVersion: current.version,
        reason,
      }, '社团规则已更新。');
      return;
    }

    if (formName === 'team-primary') {
      const team = state.dataByView.team && state.dataByView.team.team || {};
      if (team.term && team.term.primaryUserId) {
        setBanner('本届负责人已指定。更换负责人请走换届或失联恢复流程。', 'error');
        renderShell();
        return;
      }
      const targetUserId = stringValue(data, 'targetUserId');
      const selected = (team.members || []).find((member) => member.targetUserId === targetUserId && member.status === 'active' && member.role === 'moderator');
      if (!selected || selected.version === undefined || selected.version === null || !team.term || team.term.version === undefined || team.term.version === null) {
        setBanner('负责人或任期版本已变化，请刷新后重试。', 'error');
        renderShell();
        return;
      }
      await write('admin/management/primary', state.clubId, { targetUserId, expectedVersion: team.term.version, expectedMembershipVersion: selected.version, reason }, '已初始化本届负责人。', 'team');
      return;
    }

    if (formName === 'handover-create') {
      const current = state.dataByView.team || {};
      if (state.view !== 'team' || state.loadingView || current.candidatePagesComplete !== true || current.invitePagesComplete !== true) {
        setBanner('成员与公开申请码的完整列表尚未确认，暂不能提交换届提案。', 'error');
        renderShell();
        return;
      }
      const term = current.team && current.team.term || {};
      const members = itemsOf(current.members || {}).filter((member) => member.status === 'active');
      const primaryUserId = stringValue(data, 'primaryUserId');
      const team = members.map((member) => ({
        member,
        role: String(data.get(`role:${member.targetUserId}`) || ''),
      })).filter((entry) => entry.role === 'moderator' || entry.role === 'admin')
        .map((entry) => ({ targetUserId: entry.member.targetUserId, role: entry.role, expectedVersion: entry.member.version }));
      if (team.length > 50) {
        setBanner('新一届管理团队最多 50 人，请减少拟任成员后再提交。', 'error');
        renderShell();
        return;
      }
      if (!primaryUserId || !team.some((member) => member.targetUserId === primaryUserId && member.role === 'moderator')) {
        setBanner('新一届负责人必须在拟任团队中，并担任社团负责人。', 'error');
        renderShell();
        return;
      }
      if (!team.some((member) => member.role === 'moderator')) {
        setBanner('新一届至少需要一名社团负责人。', 'error');
        renderShell();
        return;
      }
      const endValue = stringValue(data, 'termEndAt');
      const retainInviteIds = data.getAll('retainInviteIds').map((value) => String(value));
      await write('admin/handovers/create', state.clubId, {
        targetUserId: primaryUserId,
        team,
        expectedVersion: term.version,
        reason,
        ...(endValue ? { termEndAt: new Date(endValue).toISOString() } : {}),
        retainInviteIds,
      }, '换届提案已提交，等待继任者本人确认。', 'team');
      return;
    }

    if (formName === 'platform-create') {
      const id = stringValue(data, 'id');
      const name = stringValue(data, 'name');
      const moderatorUserId = stringValue(data, 'moderatorUserId');
      if (!/^[a-z0-9_-]{2,64}$/.test(id) || !name || !moderatorUserId) {
        setBanner('社团 ID、名称或初始负责人无效。', 'error');
        renderShell();
        return;
      }
      await write('platform/clubs/create', '', {
        id,
        moderatorUserId,
        expectedVersion: 0,
        config: {
          name,
          description: stringValue(data, 'description'),
          discoverable: data.get('discoverable') === 'on',
          publishing: data.get('publishing') === 'on',
          uploads: data.get('uploads') === 'on',
        },
        reason,
      }, '社团与初始负责人已创建。', 'platform');
      return;
    }

    if (formName === 'platform-update') {
      const club = selectedPlatformClub();
      if (!club) return;
      await write('platform/clubs/update', '', {
        id: club.id,
        expectedVersion: club.version,
        config: {
          name: stringValue(data, 'name'),
          description: stringValue(data, 'description'),
          discoverable: data.get('discoverable') === 'on',
          publishing: data.get('publishing') === 'on',
          uploads: data.get('uploads') === 'on',
        },
        reason,
      }, '社团元数据已更新。', 'platform');
      return;
    }

    if (formName === 'platform-initial-primary') {
      const club = selectedPlatformClub();
      if (!club) return;
      const hasPrimaryState = Object.prototype.hasOwnProperty.call(club, 'primaryUserId');
      const primary = hasPrimaryState ? club.primaryUserId : undefined;
      if (!hasPrimaryState) {
        setBanner('当前负责人状态暂不可读取，请刷新后重试。', 'error');
        renderShell();
        return;
      }
      if (primary) {
        setBanner('当前负责人已存在。更换负责人请走换届或失联恢复流程。', 'error');
        renderShell();
        return;
      }
      await write('platform/clubs/set-moderator', '', { id: club.id, moderatorUserId: stringValue(data, 'moderatorUserId'), expectedVersion: club.version, reason }, '已初始化社团负责人。', 'platform');
      return;
    }

    if (formName === 'recovery-request') {
      const club = selectedPlatformClub();
      if (!club) return;
      if (club.managementTermVersion === undefined || club.managementTermVersion === null) {
        setBanner('当前任期版本暂不可读取，请刷新后重试。', 'error');
        renderShell();
        return;
      }
      await write('platform/recovery/request', club.id, { clubId: club.id, targetUserId: stringValue(data, 'targetUserId'), expectedVersion: club.managementTermVersion, reason }, '平台恢复工单已创建，并通知目标账号。', 'platform');
    }
  }

  async function handleClick(event) {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) {
      setView(viewButton.dataset.view);
      return;
    }
    const reviewButton = event.target.closest('[data-review-key]');
    if (reviewButton) {
      await submitReview(reviewButton);
      return;
    }
    const memberButton = event.target.closest('[data-member-action]');
    if (memberButton) {
      await submitMemberAction(memberButton);
      return;
    }
    const revokeButton = event.target.closest('[data-invite-revoke]');
    if (revokeButton) {
      await submitInviteRevoke(revokeButton);
      return;
    }
    const cancelHandoverButton = event.target.closest('[data-handover-cancel]');
    if (cancelHandoverButton) {
      const item = itemsOf(state.dataByView.team && state.dataByView.team.handovers || {}).find((entry) => entry.id === cancelHandoverButton.dataset.handoverCancel);
      if (!item || item.version === undefined) return;
      const result = await showActionDialog({
        title: '取消换届提案',
        message: `提案：${item.id} · 版本 ${item.version}\n取消后不会改变当前团队权限。`,
        confirmText: '确认取消',
        reason: { label: '取消理由', placeholder: '说明取消这份提案的原因', required: true, minimum: 10, maximum: 500 },
      });
      if (!result.confirmed) return;
      const reason = result.reason;
      await write('admin/handovers/cancel', state.clubId, { id: item.id, expectedVersion: item.version, reason }, '换届提案已取消。', 'team');
      return;
    }
    const approveRecoveryButton = event.target.closest('[data-recovery-approve]');
    if (approveRecoveryButton) {
      const item = itemsOf(state.dataByView.platform && state.dataByView.platform.recoveries || {}).find((entry) => entry.id === approveRecoveryButton.dataset.recoveryApprove);
      if (!item) return;
      const result = await showActionDialog({
        title: '复核负责人恢复申请',
        message: `${item.clubName || '社团'} · 目标账号 ${item.targetDisplayName || item.targetUserId || '成员'}\n恢复完成后仅目标账号保留管理权限，现有其他管理员降为普通成员。此申请可能还需冷却期或第二位开发者复核。`,
        confirmText: '提交复核',
        reason: { label: '复核理由', placeholder: '填写平台复核理由', required: true, minimum: 10, maximum: 500 },
      });
      if (!result.confirmed) return;
      const reason = result.reason;
      const clubId = item.clubId || state.platformClubId;
      await write('platform/recovery/approve', clubId, { id: item.id, expectedVersion: item.version, decision: 'approve', reason }, '恢复复核已提交。', 'platform');
      return;
    }
    const platformStatusButton = event.target.closest('[data-platform-status]');
    if (platformStatusButton) {
      const club = selectedPlatformClub();
      if (!club || club.version === undefined) return;
      const status = club.status === 'active' ? 'paused' : 'active';
      const operation = status === 'paused' ? '暂停社团' : '恢复社团';
      const result = await showActionDialog({
        title: operation,
        message: `${club.name || club.id} · 版本 ${club.version}\n${status === 'paused' ? '暂停会停止社团访问与读写。' : '恢复后重新开放社团访问。'}`,
        confirmText: `确认${operation}`,
        reason: { label: '操作理由', placeholder: `说明${operation}的原因`, required: true, minimum: 10, maximum: 500 },
      });
      if (!result.confirmed) return;
      const reason = result.reason;
      await write('platform/clubs/set-status', '', { id: club.id, status, expectedVersion: club.version, reason }, status === 'paused' ? '社团已暂停。' : '社团已恢复。', 'platform');
      return;
    }

    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) return;
    switch (actionButton.dataset.action) {
      case 'pairing-start': await createPairing(); break;
      case 'pairing-retry': await createPairing(); break;
      case 'pairing-cancel': stopPairing(); state.pairingError = ''; renderLogin(); break;
      case 'logout': await logout(); break;
      case 'refresh': await loadView(); break;
      case 'queue-more': await loadView('overview', { append: true }); break;
      case 'members-more': await loadView('members', { append: true }); break;
      case 'invites-more': await loadView('invites', { append: true }); break;
      case 'audit-more': await loadView('audit', { append: true }); break;
      case 'team-reload': await loadView('team'); break;
      case 'invite-code-hide': clearOneTimeCode(); renderShell(); break;
      case 'invite-copy':
        if (state.oneTimeCode && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(state.oneTimeCode);
          setBanner('邀请码已复制到剪贴板。', 'notice');
          renderShell();
        } else setBanner('浏览器不支持安全复制，请在原码仍显示时手动复制。', 'error');
        break;
      default: break;
    }
  }

  function handleChange(event) {
    const element = event.target;
    if (element.matches('[data-club-select]')) {
      setClub(element.value);
      return;
    }
    if (element.matches('[data-filter]')) {
      state.filters[element.dataset.filter] = element.dataset.value;
      state.pagination[state.view] = { nextCursor: '' };
      loadView(state.view);
      return;
    }
    if (element.matches('[data-platform-club]')) {
      state.platformClubId = element.value;
      state.dataByView.platform = null;
      state.pagination.platform = { nextCursor: '' };
      loadView('platform');
      return;
    }
    if (element.name === 'primaryUserId' && element.form && element.form.dataset.form === 'handover-create') {
      const form = element.form;
      const previousId = form.dataset.autoPrimary || '';
      if (previousId) {
        const previousRole = Array.from(form.querySelectorAll('select[name^="role:"]'))
          .find((select) => select.name === `role:${previousId}`);
        if (previousRole && previousRole.dataset.autoPrimary === 'true') previousRole.value = '';
        if (previousRole) delete previousRole.dataset.autoPrimary;
      }
      const nextRole = Array.from(form.querySelectorAll('select[name^="role:"]'))
        .find((select) => select.name === `role:${element.value}`);
      if (nextRole && element.value) {
        nextRole.value = 'moderator';
        nextRole.dataset.autoPrimary = 'true';
        form.dataset.autoPrimary = element.value;
      } else delete form.dataset.autoPrimary;
      return;
    }
    if (element.name && element.name.startsWith('role:')) {
      delete element.dataset.autoPrimary;
      return;
    }
    if (element.matches('[data-invite-mode]')) {
      const direct = element.value === 'direct';
      root.querySelectorAll('.direct-field').forEach((field) => { field.hidden = !direct; });
      root.querySelectorAll('.application-field').forEach((field) => { field.hidden = direct; });
      const maxUses = root.querySelector('[name="maxUses"]');
      if (maxUses) {
        maxUses.required = !direct;
        maxUses.disabled = direct;
      }
    }
  }

  root.addEventListener('click', handleClick);
  root.addEventListener('change', handleChange);
  root.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-form]');
    if (!form) return;
    event.preventDefault();
    handleForm(form);
  });

  boot();
}());
