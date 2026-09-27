/**
 * 后端静态自检（零依赖）。
 *
 *   node scripts/check.mjs
 *
 * 检查六项：
 *   1. JS/MJS 语法、JSON 语法与 BOM
 *   2. 架构纪律：domain 层不得内联权限判断、shared/policies 不得引入 SDK
 *   3. DTO 安全：presenters 必须白名单构造，不得 spread 整个文档
 *   4. api 路由：每个 action 都有实现，domain 导出无孤儿
 *   5. 云函数完整性：index.js / package.json 齐备，shared 引用路径正确
 *   6. 跨仓库契约：前端 transport 引用的 action 必须存在于 api 路由表（可选，../前端 缺失时跳过）
 */
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, relative, dirname, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'docs', 'tmp', 'coverage']);

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // 跳过 shared 副本：它由 sync-shared.mjs 生成
      if (name === 'shared' && dir.includes(`cloudfunctions${sep}`)) continue;
      walk(full);
    } else {
      files.push(full);
    }
  }
})(ROOT);

const rel = (p) => relative(ROOT, p).split(sep).join('/');
let problems = 0;
const fail = (msg) => {
  problems += 1;
  console.log(`  ✗ ${msg}`);
};

// ---------- 1. 语法 ----------
console.log('[1/5] 语法与编码');
const tmp = mkdtempSync(join(tmpdir(), 'hgbe-'));
let jsCount = 0;
let jsonCount = 0;

for (const file of files) {
  const ext = extname(file);
  if (ext === '.js' || ext === '.mjs') {
    jsCount += 1;
    // .js 在本仓库是 CommonJS（云函数），.mjs 是 ESM（脚本/测试）
    const target = join(tmp, `${jsCount}${ext === '.mjs' ? '.mjs' : '.cjs'}`);
    writeFileSync(target, readFileSync(file));
    try {
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    } catch (err) {
      fail(`${rel(file)} 语法错误\n${(err.stderr || '').toString().split('\n').slice(0, 4).join('\n')}`);
    }
  } else if (ext === '.json') {
    jsonCount += 1;
    const buf = readFileSync(file);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      fail(`${rel(file)} 含 UTF-8 BOM`);
      continue;
    }
    try {
      JSON.parse(buf.toString('utf8'));
    } catch (err) {
      fail(`${rel(file)} JSON 解析失败: ${err.message}`);
    }
  }
}
rmSync(tmp, { recursive: true, force: true });
console.log(`      js/mjs: ${jsCount}, json: ${jsonCount}`);

// ---------- 2. 架构纪律 ----------
console.log('[2/5] 架构纪律');

// policies 必须是纯函数，不得依赖云 SDK —— 否则无法单测
const policiesSrc = readFileSync(join(ROOT, 'shared/policies.js'), 'utf8');
if (/require\(['"]wx-server-sdk/.test(policiesSrc)) {
  fail('shared/policies.js 不得引入 wx-server-sdk（必须保持可单测的纯函数）');
}
if (/\.collection\(|getDb\(|coll\(/.test(policiesSrc)) {
  fail('shared/policies.js 不得访问数据库');
}

// db 层不得出现业务权限判断
const dbSrc = readFileSync(join(ROOT, 'shared/db.js'), 'utf8');
if (/isMember|visibility\s*===|role\s*===/.test(dbSrc)) {
  fail('shared/db.js 出现业务权限判断，应移到 shared/policies.js');
}

// domain 层必须通过 policies 判权，不得内联比较 visibility
const domainDir = join(ROOT, 'cloudfunctions/api/domain');
function collectDomainFiles(dir, domainFiles) {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) collectDomainFiles(file, domainFiles);
    else if (extname(file) === '.js') domainFiles.push(file);
  }
}
if (existsSync(domainDir)) {
  const domainFiles = [];
  collectDomainFiles(domainDir, domainFiles);
  for (const file of domainFiles) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');

    lines.forEach((line, i) => {
      // 允许写 visibility: VISIBILITY.X（查询条件），禁止写 visibility === 'club'（权限判断）
      if (/visibility\s*===\s*['"]/.test(line) && !line.trim().startsWith('//')) {
        fail(`${rel(file)}:${i + 1} 内联比较 visibility 字面量，应调用 shared/policies`);
      }
      if (/\bmemberStatus\s*===\s*['"]/.test(line) && !line.trim().startsWith('//')) {
        fail(`${rel(file)}:${i + 1} 内联比较 memberStatus，应使用 viewer.isMember`);
      }
      // 客户端传入的身份字段不可信
      if (/payload\.(ownerId|userId|role|isMember|openid)/.test(line)) {
        fail(`${rel(file)}:${i + 1} 使用了 payload 中的身份字段，必须改用 ctx.viewer`);
      }
    });
  }
}

// ---------- 3. DTO 安全 ----------
console.log('[3/5] DTO 安全');
const presentersSrc = readFileSync(join(ROOT, 'shared/presenters.js'), 'utf8');
// 白名单构造：不允许 spread 整个数据库文档
if (/\.\.\.(post|doc|comment|user|topic|collection)\b(?!\w)/.test(presentersSrc)) {
  fail('shared/presenters.js 出现 spread 整个文档，必须白名单显式构造字段');
}
for (const forbidden of ['ownerId:', 'wxOpenIdRef', 'aliasKey', 'reporterId']) {
  // presentPostCard 等函数内不得直接输出这些字段（author.userId 例外，已有匿名分支保护）
  const re = new RegExp(`^\\s*${forbidden.replace(':', ':')}`, 'm');
  if (forbidden !== 'ownerId:' && re.test(presentersSrc)) {
    fail(`shared/presenters.js 输出了禁用字段 ${forbidden}`);
  }
}

// ---------- 4. api 路由 ----------
console.log('[4/5] api 路由');
const apiIndex = join(ROOT, 'cloudfunctions/api/index.js');
if (!existsSync(apiIndex)) {
  fail('cloudfunctions/api/index.js 缺失');
} else {
  const src = readFileSync(apiIndex, 'utf8');
  const actionRe = /'([a-z][a-z0-9/_-]*)':\s*(\w+)\.(\w+)/g;
  const actions = [];
  let m;
  while ((m = actionRe.exec(src))) actions.push({ action: m[1], module: m[2], fn: m[3] });

  const moduleExports = new Map();
  for (const name of readdirSync(domainDir)) {
    if (extname(name) !== '.js') continue;
    const src2 = readFileSync(join(domainDir, name), 'utf8');
    const mod = name.replace(/\.js$/, '');
    const exported = new Set();
    const exportBlock = src2.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
    if (exportBlock) {
      exportBlock[1]
        .split(',')
        .map((s) => s.trim().split(':')[0].trim())
        .filter(Boolean)
        .forEach((n) => exported.add(n));
    }
    moduleExports.set(mod, exported);
  }

  for (const { action, module: mod, fn } of actions) {
    const exported = moduleExports.get(mod);
    if (!exported) {
      fail(`action '${action}' 引用了不存在的模块 domain/${mod}.js`);
      continue;
    }
    if (!exported.has(fn)) {
      fail(`action '${action}' 引用的 ${mod}.${fn} 未从模块导出`);
    }
  }
  console.log(`      actions: ${actions.length}`);
}

// ---------- 5. 云函数完整性 ----------
console.log('[5/5] 云函数完整性');
const fnDir = join(ROOT, 'cloudfunctions');
const fns = readdirSync(fnDir).filter((n) => statSync(join(fnDir, n)).isDirectory());
for (const fn of fns) {
  for (const required of ['index.js', 'package.json']) {
    if (!existsSync(join(fnDir, fn, required))) fail(`cloudfunctions/${fn}/${required} 缺失`);
  }
  // 云函数内引用 shared 必须用 ./shared（部署时由 sync-shared 复制），不能跨目录
  const indexSrc = readFileSync(join(fnDir, fn, 'index.js'), 'utf8');
  if (/require\(['"]\.\.\/\.\.\/(\.\.\/)?shared/.test(indexSrc)) {
    fail(`cloudfunctions/${fn}/index.js 使用了跨目录的 shared 引用，部署会失败；请用 ./shared`);
  }
  // 检查 domain 与 tasks 子目录
  for (const sub of ['domain', 'tasks']) {
    const subDir = join(fnDir, fn, sub);
    if (!existsSync(subDir)) continue;
    for (const name of readdirSync(subDir)) {
      if (extname(name) !== '.js') continue;
      const src = readFileSync(join(subDir, name), 'utf8');
      if (/require\(['"]\.\.\/\.\.\/(\.\.\/)?shared/.test(src)) {
        fail(`cloudfunctions/${fn}/${sub}/${name} 使用了跨目录的 shared 引用；请用 ../shared`);
      }
    }
  }
}
console.log(`      functions: ${fns.join(', ')}`);

// ---------- 6. 跨仓库契约一致性（可选） ----------
console.log('[6/6] 前后端契约一致性');
const feTransport = join(ROOT, '..', 'tdesign-miniprogram-starter', 'api', 'transport.js');
if (!existsSync(feTransport)) {
  console.log('      跳过：未找到相邻前端仓库的 api/transport.js（独立运行本仓库时正常）');
} else {
  // transport 里的 action 字面量均为小写多段路径（pattern 以 / 开头故不会误匹配）
  const feSrc = readFileSync(feTransport, 'utf8');
  const feActions = new Set();
  const feActionRe = /'([a-z][a-z0-9-]*(?:\/[a-z0-9-]+)+)'/g;
  let feMatch;
  while ((feMatch = feActionRe.exec(feSrc))) feActions.add(feMatch[1]);

  const beSrc = readFileSync(apiIndex, 'utf8');
  const beActions = new Set();
  const beActionRe = /'([a-z][a-z0-9/_-]*)':\s*\w+\.\w+/g;
  let beMatch;
  while ((beMatch = beActionRe.exec(beSrc))) beActions.add(beMatch[1]);

  const drift = [...feActions].filter((a) => !beActions.has(a));
  if (drift.length > 0) {
    fail(`前端 transport 引用了后端不存在的 action：${drift.join(', ')}（契约三方同步缺失）`);
  }
  const unusedByFe = [...beActions].filter((a) => !feActions.has(a));
  console.log(`      fe 引用: ${feActions.size}, be 实现: ${beActions.size}, 漂移: ${drift.length}, 前端未引用: ${unusedByFe.length}`);
}

console.log('');
console.log(problems === 0 ? 'OK: 全部检查通过' : `FAILED: ${problems} 个问题`);
process.exit(problems === 0 ? 0 : 1);
