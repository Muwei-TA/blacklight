import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = resolve(process.env.NAS_MEDIA_DIR || '/data/private-media');
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const FILE_ID_PREFIX = 'pgstore://blacklight-private/';

function parseFileId(value) {
  if (typeof value !== 'string' || !value.startsWith(FILE_ID_PREFIX)) throw new Error('invalid file id');
  const key = value.slice(FILE_ID_PREFIX.length);
  const parts = key.split('/');
  if (!key.startsWith('private/image/')
    || parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error('invalid object key');
  }
  return key;
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function ensurePrivateDirectory(path) {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('unsafe media directory');
    if (details.mode & 0o077) await chmod(path, 0o700);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path, { mode: 0o700 });
  }
}

async function ensureObjectParent(relativePath) {
  const parts = relativePath.split('/');
  let current = ROOT;
  await ensurePrivateDirectory(current);
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    if (!current.startsWith(`${ROOT}/`)) throw new Error('media path escaped root');
    await ensurePrivateDirectory(current);
  }
  return current;
}

async function existingFileMatches(target, expectedSize, expectedHash) {
  const details = await lstat(target);
  if (details.isSymbolicLink() || !details.isFile() || details.mode & 0o077 || details.size !== expectedSize) return false;
  const content = await readFile(target);
  return digest(content) === expectedHash;
}

async function writeObject(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid media record');
  const relativePath = parseFileId(item.fileId);
  if (item.relativePath !== relativePath
    || !Number.isSafeInteger(item.size) || item.size < 1
    || !/^[0-9a-f]{64}$/.test(item.sha256)
    || typeof item.contentBase64 !== 'string'
    || item.contentBase64.length > Math.ceil(MAX_LINE_BYTES * 4 / 3)) {
    throw new Error('invalid media metadata');
  }
  const content = Buffer.from(item.contentBase64, 'base64');
  if (content.toString('base64') !== item.contentBase64
    || content.byteLength !== item.size || digest(content) !== item.sha256) {
    throw new Error('media payload checksum mismatch');
  }

  const parent = await ensureObjectParent(relativePath);
  const target = resolve(parent, relativePath.split('/').at(-1));
  try {
    if (await existingFileMatches(target, item.size, item.sha256)) return false;
    throw new Error('existing media object differs from snapshot');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporary = resolve(parent, `.nas-import-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, target);
    } catch (error) {
      if (error.code !== 'EEXIST' || !(await existingFileMatches(target, item.size, item.sha256))) throw error;
      return false;
    }
    return true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function main() {
  let files = 0;
  let bytes = 0;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line || Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('invalid media input line');
    const item = JSON.parse(line);
    const created = await writeObject(item);
    files += 1;
    bytes += item.size;
    if (!Number.isSafeInteger(bytes)) throw new Error('media input too large');
    if (created) continue;
  }
  process.stdout.write(`${JSON.stringify({ files, bytes })}\n`);
}

main().catch(() => {
  process.stderr.write('media receiver refused the snapshot payload\n');
  process.exitCode = 1;
});
