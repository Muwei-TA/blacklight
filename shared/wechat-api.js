'use strict';

const https = require('node:https');
const crypto = require('node:crypto');

const API_HOST = 'api.weixin.qq.com';
const ACCESS_TOKEN_MARGIN_MS = 2 * 60 * 1000;
const MAX_RESPONSE_BYTES = 256 * 1024;

class WechatApiError extends Error {
  constructor(code = 'WECHAT_API_ERROR', errCode = '') {
    super('微信内容安全接口暂不可用');
    this.name = 'WechatApiError';
    this.code = code;
    this.errCode = errCode;
  }
}

let tokenState = null;
let tokenFlight = null;

function appConfig() {
  const appId = process.env.MINIPROGRAM_APP_ID;
  const appSecret = process.env.MINIPROGRAM_APP_SECRET;
  if (!appId || !appSecret) throw new WechatApiError('WECHAT_CONFIG_MISSING');
  return { appId, appSecret };
}

function request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let length = 0;
      res.on('data', (chunk) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          res.destroy(new WechatApiError('WECHAT_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new WechatApiError('WECHAT_HTTP_ERROR'));
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (_) { return reject(new WechatApiError('WECHAT_INVALID_RESPONSE')); }
        return resolve(data);
      });
      res.on('error', () => reject(new WechatApiError('WECHAT_RESPONSE_ERROR')));
    });
    req.on('timeout', () => req.destroy(new WechatApiError('WECHAT_TIMEOUT')));
    req.on('error', (error) => reject(error instanceof WechatApiError ? error : new WechatApiError('WECHAT_NETWORK_ERROR')));
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && tokenState && tokenState.expiresAt - ACCESS_TOKEN_MARGIN_MS > Date.now()) return tokenState.value;
  if (tokenFlight) return tokenFlight;
  tokenFlight = (async () => {
    const { appId, appSecret } = appConfig();
    const url = new URL(`https://${API_HOST}/cgi-bin/token`);
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', appId);
    url.searchParams.set('secret', appSecret);
    const result = await request(url);
    if (result.errcode || typeof result.access_token !== 'string' || !result.access_token) {
      throw new WechatApiError('WECHAT_ACCESS_TOKEN_FAILED', result.errcode || '');
    }
    const expiresIn = Math.max(300, Number(result.expires_in) || 7200);
    tokenState = { value: result.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return tokenState.value;
  })();
  try { return await tokenFlight; }
  finally { tokenFlight = null; }
}

function apiUrl(path, accessToken) {
  const url = new URL(`https://${API_HOST}${path}`);
  url.searchParams.set('access_token', accessToken);
  return url;
}

async function perform(path, options) {
  let accessToken = await getAccessToken();
  let result = await request(apiUrl(path, accessToken), options);
  if (Number(result.errcode) === 40001 || Number(result.errcode) === 42001) {
    accessToken = await getAccessToken({ forceRefresh: true });
    result = await request(apiUrl(path, accessToken), options);
  }
  if (Number(result.errcode) !== 0) {
    throw new WechatApiError('WECHAT_CONTENT_CHECK_FAILED', result.errcode || 'unknown');
  }
  return result;
}

async function msgSecCheck({ version = 2, openid, scene = 2, content }) {
  if (typeof content !== 'string' || !content || typeof openid !== 'string' || !openid) {
    throw new WechatApiError('WECHAT_CONTENT_CHECK_INVALID_INPUT');
  }
  const body = Buffer.from(JSON.stringify({ version, openid, scene, content }), 'utf8');
  const result = await perform('/wxa/msg_sec_check', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length },
    body,
  });
  return { ...result, errCode: result.errcode || 0 };
}

async function imgSecCheck({ media }) {
  const value = media && media.value;
  if (!Buffer.isBuffer(value) || value.length === 0) throw new WechatApiError('WECHAT_CONTENT_CHECK_INVALID_INPUT');
  const boundary = `----blacklight-${crypto.randomBytes(18).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`, 'utf8'),
    value,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  const result = await perform('/wxa/img_sec_check', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length },
    body,
  });
  return { ...result, errCode: result.errcode || 0 };
}

function clearAccessTokenCache() {
  tokenState = null;
  tokenFlight = null;
}

module.exports = { WechatApiError, getAccessToken, msgSecCheck, imgSecCheck, clearAccessTokenCache };
