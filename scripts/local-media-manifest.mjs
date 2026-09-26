import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(process.env.LOCAL_MEDIA_MANIFEST_ROOT || process.env.NAS_MEDIA_DIR || '/data/private-media');

async function digestFile(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest('hex') };
}

async function walk(directory) {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const details = await lstat(absolute);
    if (details.isSymbolicLink()) throw new Error('symbolic link found in media storage');
    if (details.isDirectory()) entries.push(...await walk(absolute));
    else if (details.isFile()) {
      const relativePath = relative(root, absolute).split(sep).join('/');
      if (!relativePath.startsWith('private/image/')) throw new Error('unexpected file under media root');
      entries.push({ relativePath, ...(await digestFile(absolute)) });
    } else throw new Error('unsupported filesystem entry in media storage');
  }
  return entries;
}

try {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('media root is not a directory');
  const files = (await walk(root)).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  process.stdout.write(`${JSON.stringify({ format: 'blacklight-private-media-manifest-v1', root: '/data/private-media', files, fileCount: files.length, totalBytes: files.reduce((sum, item) => sum + item.size, 0) })}\n`);
} catch {
  process.stderr.write('media manifest failed\n');
  process.exitCode = 1;
}
