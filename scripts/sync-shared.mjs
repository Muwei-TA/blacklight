/**
 * 把根目录 shared/ 同步到每个云函数目录下。
 *
 * 为什么需要：CloudBase 部署云函数时只上传该函数目录，
 * 无法引用目录外的 ../../shared。所以 shared/ 保持单一真源（根目录），
 * 部署前用本脚本复制进去，并由 .gitignore 忽略副本。
 *
 *   node scripts/sync-shared.mjs
 */
import { readdirSync, statSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = join(ROOT, 'shared');
const FUNCTIONS_DIR = join(ROOT, 'cloudfunctions');

if (!existsSync(SHARED)) {
  console.error('shared/ 不存在');
  process.exit(1);
}

const functions = readdirSync(FUNCTIONS_DIR).filter((name) =>
  statSync(join(FUNCTIONS_DIR, name)).isDirectory(),
);

let copied = 0;
for (const fn of functions) {
  const target = join(FUNCTIONS_DIR, fn, 'shared');
  // 先清空，避免留下已删除的旧文件
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  for (const file of readdirSync(SHARED)) {
    const src = join(SHARED, file);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(target, file));
    copied += 1;
  }
  console.log(`synced shared/ -> cloudfunctions/${fn}/shared/`);
}

console.log(`\n完成：${functions.length} 个云函数，共复制 ${copied} 个文件`);
console.log('提醒：cloudfunctions/*/shared/ 已在 .gitignore 中忽略，请勿手动编辑副本。');
