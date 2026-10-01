'use strict';

/** Private filesystem implementation of the historical pgstore file-id API. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  DEFAULT_BUCKET_ID,
  ensureObjectKey,
  makePgFileId,
  parsePgFileId,
} = require('./pg-storage');

const DEFAULT_MEDIA_TTL_SECONDS = 5 * 60;

class LocalStorageError extends Error {
  constructor(message, code = 'LOCAL_STORAGE_ERROR') {
    super(message);
    this.name = 'LocalStorageError';
    this.code = code;
  }
}

function mediaRoot() {
  return path.resolve(process.env.NAS_MEDIA_DIR || '/data/private-media');
}

function getMediaSecret() {
  const secret = process.env.MEDIA_URL_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new LocalStorageError('MEDIA_URL_SECRET is unavailable', 'MISSING_MEDIA_SECRET');
  }
  return secret;
}

function baseUrl() {
  const configured = process.env.PUBLIC_API_BASE_URL;
  if (!configured) throw new LocalStorageError('PUBLIC_API_BASE_URL is unavailable', 'MISSING_PUBLIC_URL');
  const parsed = new URL(configured);
  const lanMode = process.env.RUNTIME_KIND === 'nas' && process.env.NAS_LAN_MODE === '1';
  const expectedPort = String(process.env.API_BIND_PORT || '18088');
  const allowedLanHttp = lanMode
    && parsed.protocol === 'http:'
    && parsed.hostname === '192.168.50.28'
    && parsed.port === expectedPort;
  if (parsed.protocol !== 'https:'
    && process.env.NODE_ENV !== 'development'
    && process.env.NODE_ENV !== 'test'
    && !allowedLanHttp) {
    throw new LocalStorageError('PUBLIC_API_BASE_URL must use HTTPS', 'INVALID_PUBLIC_URL');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new LocalStorageError('PUBLIC_API_BASE_URL is invalid', 'INVALID_PUBLIC_URL');
  }
  return parsed.toString().replace(/\/$/, '');
}

function mac(token) {
  return crypto.createHmac('sha256', getMediaSecret()).update(`blacklight-media-v1:${token}`).digest('base64url');
}

function encryptPayload(payload) {
  const key = crypto.createHash('sha256').update(getMediaSecret()).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url');
}

function decryptPayload(token) {
  const encoded = Buffer.from(token, 'base64url');
  if (encoded.length < 29) return null;
  const key = crypto.createHash('sha256').update(getMediaSecret()).digest();
  const iv = encoded.subarray(0, 12);
  const tag = encoded.subarray(encoded.length - 16);
  const ciphertext = encoded.subarray(12, encoded.length - 16);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch (_) {
    return null;
  }
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createLocalStorageAdapter({ root = mediaRoot(), bucketId = DEFAULT_BUCKET_ID } = {}) {
  const fixedRoot = path.resolve(root);

  async function ensureRoot() {
    await fsp.mkdir(fixedRoot, { recursive: true, mode: 0o700 });
    const stat = await fsp.lstat(fixedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalStorageError('media root is not a private directory', 'INVALID_MEDIA_ROOT');
    await fsp.chmod(fixedRoot, 0o700).catch(() => {});
    return fsp.realpath(fixedRoot);
  }

  function parseFileId(fileId) {
    return parsePgFileId(fileId, bucketId);
  }

  async function resolvePath(fileId, { createParent = false } = {}) {
    const { objectKey } = parseFileId(fileId);
    const rootPath = await ensureRoot();
    const target = path.resolve(rootPath, ...ensureObjectKey(objectKey).split('/'));
    if (!target.startsWith(`${rootPath}${path.sep}`)) throw new LocalStorageError('invalid storage object key', 'INVALID_KEY');
    const parent = path.dirname(target);
    if (createParent) {
      const relative = path.relative(rootPath, parent);
      let current = rootPath;
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try {
          await fsp.mkdir(current, { mode: 0o700 });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        const stat = await fsp.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalStorageError('media path contains a non-directory', 'INVALID_MEDIA_PATH');
        await fsp.chmod(current, 0o700).catch(() => {});
      }
    }
    const realParent = await fsp.realpath(parent).catch((error) => {
      if (error.code === 'ENOENT' && !createParent) return null;
      throw error;
    });
    if (realParent && realParent !== rootPath && !realParent.startsWith(`${rootPath}${path.sep}`)) {
      throw new LocalStorageError('media path escaped the private root', 'INVALID_MEDIA_PATH');
    }
    return target;
  }

  async function getUploadMetadata({ cloudPath }) {
    const objectKey = ensureObjectKey(cloudPath);
    return { data: { fileId: makePgFileId(bucketId, objectKey) } };
  }

  async function uploadFile({ cloudPath, fileContent }) {
    const objectKey = ensureObjectKey(cloudPath);
    const fileId = makePgFileId(bucketId, objectKey);
    const target = await resolvePath(fileId, { createParent: true });
    const bytes = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent || []);
    const temporary = `${target}.${crypto.randomUUID()}.part`;
    let handle;
    try {
      handle = await fsp.open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        // The staged file is already synced. A hard link publishes it in one
        // filesystem operation, so a crash cannot expose a partly copied JPEG.
        await fsp.link(temporary, target);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previousStat = await fsp.lstat(target);
        if (!previousStat.isFile() || previousStat.isSymbolicLink()) throw new LocalStorageError('reserved image path is not a regular file', 'INVALID_OBJECT');
        const previous = await fsp.readFile(target);
        if (!previous.equals(bytes)) throw new LocalStorageError('reserved image path already contains different bytes', 'OBJECT_COLLISION');
      }
      const targetStat = await fsp.lstat(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new LocalStorageError('stored object is not a regular file', 'INVALID_OBJECT');
      await fsp.chmod(target, 0o600);
      return { fileID: fileId, statusCode: 200 };
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fsp.unlink(temporary).catch(() => {});
    }
  }

  async function getTempFileURL({ fileList }) {
    if (!Array.isArray(fileList)) throw new LocalStorageError('fileList must be an array', 'INVALID_FILE_LIST');
    const results = await Promise.all(fileList.map(async (item) => {
      const fileId = typeof item === 'string' ? item : item && (item.fileID || item.fileId);
      try {
        const target = await resolvePath(fileId);
        await fsp.access(target, fs.constants.R_OK);
        // The API route signs only after checking asset and post permissions.
        // This URL is intentionally empty for internal worker verification.
        return { fileID: fileId, status: 0, errMsg: 'ok', tempFileURL: '' };
      } catch (error) {
        return { fileID: fileId || '', status: 1, errMsg: error.code || 'FILE_UNAVAILABLE', tempFileURL: '' };
      }
    }));
    return { fileList: results };
  }

  async function downloadFile({ fileID }) {
    const target = await resolvePath(fileID);
    const stat = await fsp.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new LocalStorageError('stored object is not a regular file', 'INVALID_OBJECT');
    return { fileContent: await fsp.readFile(target), statusCode: 200 };
  }

  async function deleteFile({ fileList }) {
    if (!Array.isArray(fileList)) throw new LocalStorageError('fileList must be an array', 'INVALID_FILE_LIST');
    const results = await Promise.all(fileList.map(async (item) => {
      const fileId = typeof item === 'string' ? item : item && (item.fileID || item.fileId);
      try {
        await fsp.unlink(await resolvePath(fileId));
        return { fileID: fileId, status: 0, errMsg: 'ok' };
      } catch (error) {
        if (error.code === 'ENOENT') return { fileID: fileId, status: 0, errMsg: 'ok' };
        return { fileID: fileId || '', status: 1, errMsg: error.code || 'DELETE_FAILED' };
      }
    }));
    return { fileList: results };
  }

  function createAssetUrl({ assetId, fileId, userId = null, permissionVersion = null, ttlSeconds = DEFAULT_MEDIA_TTL_SECONDS }) {
    const payload = {
      v: 1,
      assetId: String(assetId),
      fileId: String(fileId),
      userId: userId || null,
      permissionVersion: permissionVersion === undefined ? null : permissionVersion,
      exp: Math.floor(Date.now() / 1000) + Math.max(30, Math.min(Number(ttlSeconds) || DEFAULT_MEDIA_TTL_SECONDS, 600)),
    };
    // Encrypt the claims so the media URL does not expose the internal user ID.
    const token = encryptPayload(payload);
    const signature = mac(token);
    const url = new URL(`${baseUrl()}/v1/media/${encodeURIComponent(payload.assetId)}`);
    url.searchParams.set('t', token);
    url.searchParams.set('s', signature);
    return url.toString();
  }

  function verifyAssetUrl({ token, signature, now = Date.now() }) {
    if (typeof token !== 'string' || token.length > 2048 || typeof signature !== 'string' || signature.length > 128) return null;
    if (!safeEqual(mac(token), signature)) return null;
    const payload = decryptPayload(token);
    if (!payload || payload.v !== 1 || typeof payload.assetId !== 'string' || typeof payload.fileId !== 'string') return null;
    if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(now / 1000)) return null;
    try { parseFileId(payload.fileId); } catch (_) { return null; }
    return payload;
  }

  return {
    bucketId,
    getUploadMetadata,
    uploadFile,
    getTempFileURL,
    downloadFile,
    deleteFile,
    createAssetUrl,
    verifyAssetUrl,
    resolvePath,
    makeFileId: (objectKey) => makePgFileId(bucketId, objectKey),
    parseFileId,
  };
}

module.exports = {
  DEFAULT_MEDIA_TTL_SECONDS,
  LocalStorageError,
  createLocalStorageAdapter,
};
