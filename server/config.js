'use strict';

const fs = require('node:fs');

const SECRET_NAMES = [
  'DATABASE_URL',
  'MINIPROGRAM_APP_SECRET',
  'MEDIA_URL_SECRET',
  'ANON_ALIAS_SECRET',
];

function loadSecretFiles(names = SECRET_NAMES) {
  for (const name of names) {
    const filePath = process.env[`${name}_FILE`];
    if (!filePath) continue;
    if (process.env[name]) throw new Error(`${name} and ${name}_FILE cannot both be set`);
    let value;
    try {
      value = fs.readFileSync(filePath, 'utf8').replace(/[\r\n]+$/, '');
    } catch (_) {
      throw new Error(`${name}_FILE cannot be read`);
    }
    if (!value) throw new Error(`${name}_FILE is empty`);
    process.env[name] = value;
  }
  process.env.RUNTIME_KIND = 'nas';
}

function validateConfig() {
  loadSecretFiles();
  for (const name of SECRET_NAMES) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  if (!process.env.MINIPROGRAM_APP_ID) throw new Error('MINIPROGRAM_APP_ID is required');
  if (!process.env.PUBLIC_API_BASE_URL) throw new Error('PUBLIC_API_BASE_URL is required');
  if (Buffer.byteLength(process.env.MEDIA_URL_SECRET) < 32) throw new Error('MEDIA_URL_SECRET must contain at least 32 bytes');
  const lanMode = process.env.NAS_LAN_MODE || '0';
  if (!['0', '1'].includes(lanMode)) throw new Error('NAS_LAN_MODE must be 0 or 1');
  const publicUrl = new URL(process.env.PUBLIC_API_BASE_URL);
  if (lanMode === '1') {
    const expectedPort = String(process.env.API_BIND_PORT || '18088');
    if (publicUrl.protocol !== 'http:' || publicUrl.hostname !== '192.168.50.28' || publicUrl.port !== expectedPort
      || (process.env.API_BIND_IP && process.env.API_BIND_IP !== '192.168.50.28')) {
      throw new Error('NAS LAN mode requires the fixed 192.168.50.28 LAN URL and matching port');
    }
  } else if (publicUrl.protocol !== 'https:') {
    throw new Error('PUBLIC_API_BASE_URL must use HTTPS outside NAS LAN mode');
  }
  return true;
}

module.exports = { SECRET_NAMES, loadSecretFiles, validateConfig };
