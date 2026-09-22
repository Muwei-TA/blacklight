# 02｜架构与工程规范

## 2.1 分层

```text
小程序端
   │ wx.cloud.callFunction({ name:'api', data:{ action, payload } })
   ▼
┌──────────────────────── api 云函数 ────────────────────────┐
│ shared/router.js      action 分发、ctx 注入、错误映射、日志脱敏 │
│         ▼                                                  │
│ domain/*.js           用例编排：校验 → 判权 → 读写 → 组装 DTO   │
│         ▼                                                  │
│ shared/policies.js    ⚠️ 权限规则唯一实现（纯函数，可单测）      │
│ shared/validators.js  入参校验                              │
│ shared/presenters.js  DTO 白名单构造（隐私最后一道闸门）        │
│         ▼                                                  │
│ shared/db.js          游标分页、幂等、版本锁、审计             │
└────────────────────────────┬───────────────────────────────┘
                             ▼
              云数据库（全部 ADMINONLY）/ 云存储（私有桶）
                             ▲
┌────────────────────────────┴───────────────────────────────┐
│ worker 云函数（定时）    审核、媒体、共鸣聚合、清理、注销执行     │
│ review-callback 云函数   内容安全异步结果：验签/去重/防旧覆盖新   │
└────────────────────────────────────────────────────────────┘
```

**关键点**：`worker` 与 `api` 共享同一份 `shared/policies.js`。
后台任务改状态时同样受版本锁与状态机约束，不绕过规则。

## 2.2 目录结构

```text
shared/                        ← 单一真源，被所有云函数共享
  constants.js                 集合名、枚举、限制值
  errors.js                    AppError 与 kind 映射
  policies.js                  ⚠️ 权限规则唯一实现
  validators.js                入参校验
  presenters.js                DTO 白名单构造
  anonymity.js                 别名派生、日志脱敏、泄露断言
  db.js                        数据访问薄封装
  session.js                   openid → viewer
  router.js                    云函数路由

cloudfunctions/
  api/
    index.js                   action → handler 映射表
    package.json
    domain/
      session.js               会话、入社、资料、主页、导出、注销
      posts.js                 ★ 纵向参考实现，新模块照此写
      topics.js
      collections.js
      notifications.js
      search.js
      assets.js
      moderation.js
    shared/                    ← npm run sync 生成，已 gitignore
  worker/
    index.js                   任务抢占与调度
    tasks/
      review.js                文本审核、内容/评论状态流转
      media.js                 文件复核、图片检查、视频提交
      digest.js                共鸣聚合
      cleanup.js               孤儿附件、幂等键、注销执行
  review-callback/
    index.js                   异步审核结果回调

scripts/
  sync-shared.mjs              shared → 各云函数
  db-init.mjs                  集合/索引/权限/种子清单
  deploy.mjs                   前置检查 + 输出部署命令
  check.mjs                    静态自检

tests/
  policies.test.mjs            权限规则（最重要）
  validators.test.mjs          校验与游标

docs/                          本工程书
cloudbaserc.json               CloudBase 部署配置
.env.example                   环境变量样例
```

## 2.3 shared 同步机制

**问题**：CloudBase 部署时只上传单个云函数目录，`require('../../shared/x')` 会失败。

**方案**：`shared/` 单一真源放根目录，部署前用 `npm run sync` 复制到
`cloudfunctions/*/shared/`，副本由 `.gitignore` 忽略。

```bash
npm run sync      # 每次改完 shared/ 都要跑；deploy.mjs 会自动先跑一次
```

云函数内的引用路径：

| 位置 | 正确写法 |
|---|---|
| `cloudfunctions/api/index.js` | `require('./shared/router')` |
| `cloudfunctions/api/domain/posts.js` | `require('../shared/policies')` |
| `cloudfunctions/worker/tasks/review.js` | `require('../shared/db')` |

`npm run check` 会拦截 `require('../../shared/...')` 这类跨目录引用。

## 2.4 硬规则（`npm run check` 自动拦截）

| 规则 | 拦截方式 |
|---|---|
| `shared/policies.js` 不得引入 `wx-server-sdk` | 正则检测 require |
| `shared/policies.js` 不得访问数据库 | 正则检测 `.collection(` / `coll(` |
| `shared/db.js` 不得出现业务权限判断 | 正则检测 `isMember` / `visibility ===` |
| `domain/*.js` 不得内联比较 `visibility` / `memberStatus` 字面量 | 逐行正则 |
| `domain/*.js` 不得读 `payload.ownerId/userId/role/isMember/openid` | 逐行正则 |
| `presenters.js` 不得 spread 整个数据库文档 | 正则检测 `...post` 等 |
| 每个 action 都有对应的 domain 导出 | 解析路由表与 module.exports |
| 云函数目录齐备、shared 引用路径正确 | 文件存在性 + 正则 |
| `.json` 不得含 UTF-8 BOM | 字节检测 |

## 2.5 用例编写规范（照 `domain/posts.js` 写）

固定顺序，不得跳步：

```js
async function someUseCase(payload, ctx) {
  // 1) 校验入参
  const input = validators.validateXxx(payload);

  // 2) 判权限 —— 必须调用 policies，不内联写分支
  if (!policies.canDoSomething(ctx.viewer, target)) throw errors.forbidden();

  // 3) 读写数据 —— 状态流转用 updateWithVersion
  await db.updateWithVersion(COLL, id, expectedVersion, { ... });

  // 4) 组装 DTO —— 用 presenters 白名单构造
  return presenters.presentXxx(doc, { viewer: ctx.viewer, ... });
}
```

### 读取列表的关键：先鉴权再查询

```js
// ✅ 正确：权限条件进 where，数据库层就过滤掉
const where = buildFeedWhere(ctx.viewer, extra);   // 含 visibility / status 条件
const { items } = await db.paginate(COLLECTIONS.posts, where, { cursor, pageSize });

// ❌ 错误：查出来再内存过滤 —— 总数与分页边界会泄露私密内容的存在
const all = await coll.where({ clubId }).get();
const visible = all.data.filter(p => policies.canReadPost(viewer, p));
```

详情页可以"读出来再判权"（`canReadPost`），因为单条不涉及总数泄露。
**列表与搜索必须条件下推**。

### 避免 N+1

`domain/posts.js` 的 `hydrateCards()` 是参考实现：一次性批量取
users / assets / topics / 我的互动标记 / 匿名别名，再在内存里拼装。

## 2.6 错误处理

领域层抛 `AppError`（`shared/errors.js`），路由层统一映射为响应。

```js
throw errors.notAccessible({ postId: id });   // 无权与不存在共用同一形态
throw errors.invalidInput('标题最多 60 字', { field: 'title' });
throw errors.conflict('内容已被更新，请刷新后重试');
```

**绝不允许**：`throw new Error('post not found')` —— 会被路由层当作未预期异常，
返回 500 且文案不可控。

## 2.7 日志规范

- 用 `anonymity.scrubForLog()` 处理任何含业务数据的日志对象。
- **禁止写入日志**：正文、草稿、搜索原词、openid、匿名映射、举报人身份。
- 正文只记长度：`{ body: '[len:123]' }`。
- 每条日志带 `requestId` 与 `action`，便于串联。
- 业务错误记 `warn`，未预期异常记 `error` 并保留堆栈。

## 2.8 命名与风格

- 文件：kebab-case；变量：camelCase；常量：UPPER_SNAKE。
- 集合名统一 `hg_` 前缀（见 `constants.js`），避免与同环境其他业务冲突。
- action 命名 `模块/动作`，与前端 service 函数一一对应。
- 注释写**为什么**，尤其是权限与隐私约束；不写"这里查询数据库"这类废话。
- `.js`（云函数）用 CommonJS，`.mjs`（脚本/测试）用 ESM —— 不要混用。

## 2.9 前端契约同步

以下变更**必须同时改前端仓库**，否则联调必然失败：

| 变更 | 需同步的前端文件 |
|---|---|
| 新增/改名 action | `services/*.js`、`docs/04-data-model-and-api.md` |
| DTO 字段增删 | 对应组件与 `docs/04` 的 DTO 示例 |
| 枚举值变更 | `docs/01` 术语表、`docs/04` 枚举段 |
| 错误 kind 新增 | `api/request.js` 的 `KIND_BY_HTTP`、`docs/04` 4.6 |
| 能力开关新增 | `services/session.js` 的默认值（必须默认关闭） |
