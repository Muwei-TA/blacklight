'use strict';

const fs = require('node:fs');

const SECRET_NAMES = [
  'DATABASE_URL',
  'MINIPROGRAM_APP_SECRET',
  'MEDIA_URL_SECRET',
  'ANON_ALIAS_SECRET',
];

function loadSecretFiles() {
  for (const name of SECRET_NAMES) {
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
  return true;
}

module.exports = { SECRET_NAMES, loadSecretFiles, validateConfig };
