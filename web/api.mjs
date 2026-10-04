export function createApi(fetchImpl = globalThis.fetch.bind(globalThis)) {
  let csrfToken = '';
  async function request(path, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; if (csrfToken) headers['X-CSRF-Token'] = csrfToken; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    let response;
    try {
      response = await fetchImpl(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok || result.code !== 0) throw Object.assign(new Error(result.message || '请求未完成，请稍后重试'), { code: result.code, status: response.status });
      return result.data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时；可重试，发布会沿用同一个请求标识');
      if (error instanceof TypeError) throw new Error('无法连接服务器，请检查网络后重试');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  return {
    async session() { const session = await request('/v1/web/session'); csrfToken = session.csrfToken || ''; return session; },
    action(action, clubId, payload = {}) { return request('/v1/web/action', { action, ...(clubId ? { clubId } : {}), payload }); },
    async auth(operation, payload = {}) {
      const result = await request(`/v1/web/auth/${operation}`, payload);
      if (['login', 'register'].includes(operation)) csrfToken = result.csrfToken || '';
      if (['logout', 'password'].includes(operation)) csrfToken = '';
      return result;
    },
    clear() { csrfToken = ''; },
  };
}
