'use strict';

/**
 * PG storage compatibility adapter for the legacy CloudBase storage shape.
 *
 * The legacy `cloud://...` file ID and `wx-server-sdk` storage APIs are not
 * used here. PG storage is addressed as bucket + object key through
 * `app.storage.from(bucket)` from @cloudbase/js-sdk 3.10.0.
 *
 * SDK contract used by this adapter (verified in the installed SDK):
 *   bucket.upload(path, fileBody, options) -> { data: { id, path, fullPath }, error }
 *   bucket.createSignedUrl(path, seconds) -> { data: { fullSignedURL }, error }
 *   await bucket.download(path) -> { data: Blob, error }
 *   bucket.remove([path]) -> { data: FullObject[], error }
 * See @cloudbase/js-sdk/core.d.ts StorageFileApi and storage/dist/types.d.ts.
 */

const DEFAULT_BUCKET_ID = 'blacklight-private';
const PG_FILE_ID_PREFIX = 'pgstore://';
const SIGNED_URL_TTL_SECONDS = 5 * 60;

class PgStorageAdapterError extends Error {
  constructor(message, { code = 'PG_STORAGE_ERROR', status = 1, cause } = {}) {
    super(message);
    this.name = 'PgStorageAdapterError';
    this.code = code;
    this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

function ensureBucketId(bucketId) {
  if (typeof bucketId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(bucketId)) {
    throw new PgStorageAdapterError('invalid private storage bucket', { code: 'INVALID_BUCKET' });
  }
  return bucketId;
}

/**
 * Object keys are deliberately narrower than the SDK. The image pipeline
 * generates ASCII paths and accepting a smaller language avoids URL/path
 * ambiguity, traversal, bucket switching and arbitrary URL fetches.
 */
function ensureObjectKey(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new PgStorageAdapterError('invalid storage object key', { code: 'INVALID_KEY' });
  }
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (
    value.startsWith('/')
    || value.includes('\\')
    || value.includes('//')
    || value.includes('?')
    || value.includes('#')
    || value.includes('%')
    || value.includes(':')
    || hasControlCharacter
    || !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    throw new PgStorageAdapterError('invalid storage object key', { code: 'INVALID_KEY' });
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new PgStorageAdapterError('invalid storage object key', { code: 'INVALID_KEY' });
  }
  return value;
}

function makePgFileId(bucketId, objectKey) {
  return `${PG_FILE_ID_PREFIX}${ensureBucketId(bucketId)}/${ensureObjectKey(objectKey)}`;
}

function parsePgFileId(fileId, expectedBucketId = DEFAULT_BUCKET_ID) {
  const bucketId = ensureBucketId(expectedBucketId);
  if (typeof fileId !== 'string' || !fileId.startsWith(`${PG_FILE_ID_PREFIX}${bucketId}/`)) {
    throw new PgStorageAdapterError('unsupported PG storage file id', { code: 'INVALID_FILE_ID' });
  }
  const objectKey = fileId.slice(`${PG_FILE_ID_PREFIX}${bucketId}/`.length);
  return { bucketId, objectKey: ensureObjectKey(objectKey), fileId };
}

function errorMessage(error, fallback = 'PG storage request failed') {
  if (!error) return fallback;
  return String(error.message || error.msg || error.error || error.code || error);
}

function errorStatus(error) {
  const value = error && (error.statusCode || error.status || error.code);
  return Number.isFinite(Number(value)) && Number(value) !== 0 ? Number(value) : 1;
}

function throwSdkError(operation, result) {
  if (!result || !Object.prototype.hasOwnProperty.call(result, 'data')) throw new PgStorageAdapterError(`${operation} returned no result`);
  if (!result.error) return result;
  const error = result.error;
  throw new PgStorageAdapterError(`${operation} failed: ${errorMessage(error)}`, {
    code: error.code || 'PG_STORAGE_ERROR',
    status: errorStatus(error),
    cause: error,
  });
}

async function toUploadBody(fileContent) {
  // SDK 3.10.0 routes Blob/File through multipart FormData. Its
  // fileOptions.contentType then becomes a multipart field, while the
  // request's content type may be inferred as text/plain by the gateway.
  // Buffer/byte bodies use the SDK's binary branch, which writes the actual
  // `content-type: image/jpeg` HTTP header.
  if (Buffer.isBuffer(fileContent)) return fileContent;
  if (fileContent instanceof Uint8Array) {
    return Buffer.from(fileContent.buffer, fileContent.byteOffset, fileContent.byteLength);
  }
  if (fileContent instanceof ArrayBuffer) return Buffer.from(new Uint8Array(fileContent));
  if (typeof Blob !== 'undefined' && fileContent instanceof Blob) {
    return Buffer.from(await fileContent.arrayBuffer());
  }
  throw new PgStorageAdapterError('fileContent must be a Buffer, Blob, or byte array', {
    code: 'INVALID_FILE_CONTENT',
  });
}

async function blobToBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (value && typeof value.arrayBuffer === 'function') {
    return Buffer.from(await value.arrayBuffer());
  }
  throw new PgStorageAdapterError('PG storage download returned unsupported content', {
    code: 'INVALID_DOWNLOAD_CONTENT',
  });
}

function readFileId(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item.fileID === 'string') return item.fileID;
  if (item && typeof item.fileId === 'string') return item.fileId;
  throw new PgStorageAdapterError('fileList item must contain a fileID', { code: 'INVALID_FILE_ID' });
}

function createSdkApp({ cloudbase, env } = {}) {
  const sdk = cloudbase || require('@cloudbase/js-sdk');
  const envId = env || process.env.TCB_ENV || process.env.SCF_NAMESPACE;
  const serverAccessKey = process.env.CLOUDBASE_APIKEY;
  if (!envId) throw new PgStorageAdapterError('PG storage environment is not configured', { code: 'MISSING_ENV' });
  if (!serverAccessKey) {
    throw new PgStorageAdapterError('PG storage server API key is not configured', { code: 'MISSING_SERVER_KEY' });
  }
  // The key is read only from server configuration and is never returned or
  // placed in a URL. Tests inject an already-created app instead.
  return sdk.init({ env: envId, accessKey: serverAccessKey });
}

function createPgStorageAdapter({ app, cloudbase, env, bucketId = DEFAULT_BUCKET_ID } = {}) {
  const fixedBucketId = ensureBucketId(bucketId);
  const pgApp = app || createSdkApp({ cloudbase, env });
  if (!pgApp || !pgApp.storage || typeof pgApp.storage.from !== 'function') {
    throw new PgStorageAdapterError('CloudBase JS SDK PG storage capability is unavailable', {
      code: 'STORAGE_UNAVAILABLE',
    });
  }
  const bucket = pgApp.storage.from(fixedBucketId);
  if (!bucket || typeof bucket.upload !== 'function' || typeof bucket.createSignedUrl !== 'function') {
    throw new PgStorageAdapterError('CloudBase JS SDK PG bucket API is unavailable', {
      code: 'STORAGE_UNAVAILABLE',
    });
  }

  async function getUploadMetadata({ cloudPath }) {
    const objectKey = ensureObjectKey(cloudPath);
    // PG SDK upload does not need a legacy upload ticket. This local metadata
    // is only a stable, parseable ID for the asset reservation record.
    return { data: { fileId: makePgFileId(fixedBucketId, objectKey) } };
  }

  async function uploadFile({ cloudPath, fileContent }) {
    const objectKey = ensureObjectKey(cloudPath);
    const result = await bucket.upload(objectKey, await toUploadBody(fileContent), {
      contentType: 'image/jpeg',
      upsert: true,
    });
    throwSdkError('upload', result);
    if (!result.data || result.data.path !== objectKey) throw new PgStorageAdapterError('upload returned no matching object');
    return { fileID: makePgFileId(fixedBucketId, objectKey), statusCode: 200 };
  }

  async function getTempFileURL({ fileList }) {
    if (!Array.isArray(fileList)) throw new PgStorageAdapterError('fileList must be an array', { code: 'INVALID_FILE_LIST' });
    const results = await Promise.all(fileList.map(async (item) => {
      let fileId;
      try {
        fileId = readFileId(item);
        const { objectKey } = parsePgFileId(fileId, fixedBucketId);
        const result = await bucket.createSignedUrl(objectKey, SIGNED_URL_TTL_SECONDS);
        if (result && result.error) {
          return {
            fileID: fileId,
            status: errorStatus(result.error),
            errMsg: errorMessage(result.error),
            message: errorMessage(result.error),
            tempFileURL: '',
          };
        }
        const url = result && result.data && result.data.fullSignedURL;
        if (!url || typeof url !== 'string') {
          throw new PgStorageAdapterError('signed URL missing from PG storage response', { code: 'INVALID_SIGNED_URL' });
        }
        return { fileID: fileId, status: 0, errMsg: 'ok', tempFileURL: url, download_url: url };
      } catch (error) {
        const message = errorMessage(error);
        return {
          fileID: fileId || String(item),
          status: errorStatus(error),
          errMsg: message,
          message,
          tempFileURL: '',
        };
      }
    }));
    return { fileList: results };
  }

  async function downloadFile({ fileID }) {
    const { objectKey } = parsePgFileId(fileID, fixedBucketId);
    const result = await bucket.download(objectKey);
    throwSdkError('download', result);
    return { fileContent: await blobToBuffer(result.data), statusCode: 200 };
  }

  async function deleteFile({ fileList }) {
    if (!Array.isArray(fileList)) throw new PgStorageAdapterError('fileList must be an array', { code: 'INVALID_FILE_LIST' });
    const results = await Promise.all(fileList.map(async (item) => {
      let fileId;
      try {
        fileId = readFileId(item);
        const { objectKey } = parsePgFileId(fileId, fixedBucketId);
        const result = await bucket.remove([objectKey]);
        if (!result || !Array.isArray(result.data) && !result.error) throw new PgStorageAdapterError('delete returned no result');
        if (result && result.error) {
          const message = errorMessage(result.error);
          return { fileID: fileId, status: errorStatus(result.error), errMsg: message, message };
        }
        return { fileID: fileId, status: 0, errMsg: 'ok' };
      } catch (error) {
        const message = errorMessage(error);
        return { fileID: fileId || String(item), status: errorStatus(error), errMsg: message, message };
      }
    }));
    return { fileList: results };
  }

  return {
    bucketId: fixedBucketId,
    getUploadMetadata,
    uploadFile,
    getTempFileURL,
    downloadFile,
    deleteFile,
    makeFileId: (objectKey) => makePgFileId(fixedBucketId, objectKey),
    parseFileId: (fileId) => parsePgFileId(fileId, fixedBucketId),
  };
}

module.exports = {
  DEFAULT_BUCKET_ID,
  PG_FILE_ID_PREFIX,
  SIGNED_URL_TTL_SECONDS,
  PgStorageAdapterError,
  ensureObjectKey,
  makePgFileId,
  parsePgFileId,
  createPgStorageAdapter,
};
