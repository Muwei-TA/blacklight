/**
 * 部署编排：同步 shared → 校验环境变量 → 打印 tcb 部署命令。
 *
 * 本脚本**不自动执行部署**，只做前置检查并输出命令。
 * 原因：部署会影响线上环境，自动执行不利于评审与回滚；
 * 且 tcb login 需要交互，不适合无人值守。
 *
 *   node scripts/deploy.mjs --env-id <envId>
 *   node scripts/deploy.mjs --env-id <envId> --fn api
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS_DIR = join(ROOT, 'cloudfunctions');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

const envId = arg('--env-id') || process.env.TCB_ENV_ID;
const only = arg('--fn');

if (!envId) {
  console.error('缺少环境 ID：node scripts/deploy.mjs --env-id <envId>');
  console.error('或设置环境变量 TCB_ENV_ID');
  process.exit(1);
}

// 1. 同步 shared
console.log('[1/4] 同步 shared/ 到各云函数…');
execFileSync(process.execPath, [join(ROOT, 'scripts', 'sync-shared.mjs')], { stdio: 'inherit' });

// 2. 检查函数目录完整性
console.log('\n[2/4] 检查云函数目录…');
const functions = readdirSync(FUNCTIONS_DIR)
  .filter((n) => statSync(join(FUNCTIONS_DIR, n)).isDirectory())
  .filter((n) => !only || n === only);

let problems = 0;
for (const fn of functions) {
  const dir = join(FUNCTIONS_DIR, fn);
  for (const required of ['index.js', 'package.json', 'shared/constants.js']) {
    if (!existsSync(join(dir, required))) {
      console.error(`  ✗ ${fn}/${required} 缺失`);
      problems += 1;
    }
  }
  if (problems === 0) console.log(`  ✓ ${fn}`);
}
if (problems > 0) process.exit(1);

// 3. 提醒环境变量
console.log('\n[3/4] 请确认云函数环境变量已在控制台配置：');
console.log('  ANON_ALIAS_SECRET       匿名别名派生密钥（缺失时匿名发布会直接报错，属预期的 fail-closed）');
console.log('  REVIEW_CALLBACK_SECRET  审核回调共享密钥（HTTP 触发场景必需）');
console.log('  NODE_ENV=production     关闭开发期的 DTO 泄露自检开销');

// 4. 输出部署命令
console.log('\n[4/4] 执行以下命令完成部署：\n');
console.log('  tcb login   # 首次需要');
for (const fn of functions) {
  console.log(`  tcb fn deploy ${fn} --env-id ${envId} --force`);
}

console.log('\n定时触发器（worker 每分钟执行一次）：');
console.log(`  tcb fn trigger create worker --env-id ${envId} --name review-tick --config '{"cron":"0 * * * * * *"}'`);

console.log('\n部署后验收（见 docs/09-testing.md）：');
console.log('  1. 访客调用 posts/list → 只返回公开内容');
console.log('  2. 成员调用 posts/detail 读他人私密帖 → not_accessible');
console.log('  3. 搜索私密帖唯一词 → 0 结果');
console.log('  4. 普通成员调用 admin/queue → forbidden');
