const ALLOWED_ACTIONS = new Set([
  'admin/overview', 'admin/queue', 'admin/content/detail', 'admin/content/decide', 'admin/comment/decide', 'admin/topic/decide',
  'admin/board/decide', 'admin/membership/decide', 'admin/report/decide', 'admin/collection/decide',
  'admin/appeal/decide',
  'admin/members/list', 'admin/member/remove', 'admin/member/mute', 'admin/member/role',
  'admin/invites/list', 'admin/invites/create', 'admin/invites/revoke', 'admin/club/settings', 'admin/club/update',
  'admin/management/team', 'admin/management/primary', 'admin/handovers/list', 'admin/handovers/create',
  'admin/handovers/cancel', 'admin/audit/list',
  'platform/clubs/list', 'platform/clubs/create', 'platform/clubs/update', 'platform/clubs/set-status',
  'platform/clubs/set-moderator', 'platform/recovery/list', 'platform/recovery/request', 'platform/recovery/approve',
]);

function createAdminApi(fetchImpl = globalThis.fetch) {
  let csrfToken = '';

  async function request(path, { method = 'GET', body, csrf = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (csrf) {
      if (!csrfToken) throw new Error('当前登录会话已失效，请重新登录。');
      headers['X-CSRF-Token'] = csrfToken;
    }
    const response = await fetchImpl(path, {
      method,
      credentials: 'same-origin',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let result;
    try {
      result = await response.json();
    } catch (error) {
      throw new Error('服务响应暂时无法读取。');
    }
    const isEnvelope = result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'code');
    const failedEnvelope = isEnvelope && result.code !== 0 && result.code !== 200 && result.success !== true;
    if (!response.ok || failedEnvelope) {
      const error = new Error((result && result.message) || `请求失败（${response.status}）`);
      error.code = result && result.code;
      error.status = response.status;
      throw error;
    }
    return isEnvelope ? result.data : result;
  }

  return {
    createPairing() {
      return request('/v1/admin/auth/pairings', { method: 'POST', body: {} });
    },
    pairingStatus(id, pollKey) {
      return request('/v1/admin/auth/pairings/status', { method: 'POST', body: { id, pollKey } });
    },
    async exchangePairing(id, pollKey, exchangeCode) {
      const result = await request('/v1/admin/auth/exchange', {
        method: 'POST',
        body: { id, pollKey, exchangeCode },
      });
      csrfToken = result && result.csrfToken || '';
      return result;
    },
    async getSession() {
      const result = await request('/v1/admin/session');
      csrfToken = result && result.csrfToken || '';
      return result;
    },
    action(action, clubId, payload = {}) {
      if (!ALLOWED_ACTIONS.has(action)) throw new Error('管理操作类型无效');
      return request('/v1/admin/action', {
        method: 'POST',
        csrf: true,
        body: { action, clubId: clubId || '', payload },
      });
    },
    async logout() {
      try {
        return await request('/v1/admin/auth/logout', { method: 'POST', csrf: true, body: {} });
      } finally {
        csrfToken = '';
      }
    },
    clearCsrf() {
      csrfToken = '';
    },
  };
}

globalThis.AdminApi = { createAdminApi };
