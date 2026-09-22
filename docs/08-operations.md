# 08｜运维

## 8.1 环境变量

在 CloudBase 控制台「云函数 → 配置 → 环境变量」设置，**不写入代码仓库**。

| 变量 | 用于 | 缺失时的行为 |
|---|---|---|
| `ANON_ALIAS_SECRET` | 匿名别名 HMAC 派生 | **匿名发布直接抛错**（fail-closed，不用默认值） |
| `REVIEW_CALLBACK_SECRET` | 审核回调验签（HTTP 场景） | 回调一律拒绝 |
| `NODE_ENV=production` | 关闭 DTO 泄露自检开销 | 开发自检照常运行（略慢，但更安全） |

生成密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`ANON_ALIAS_SECRET` **一旦变更，所有历史匿名帖的 alias 会改变**
（同一用户在同一帖内的别名会跳变）。因此：

- 首次部署前确定并妥善保管
- 如必须轮换，需先把现有 alias 从 `hg_anonymous_identities` 读出并保留，
  不能仅靠重新派生

## 8.2 日志规范

### 脱敏

```js
const { scrubForLog } = require('./shared/anonymity');
console.warn('[api] something', scrubForLog({ postId, ownerId, body }));
// → { postId: 'p1', ownerId: '[redacted]', body: '[len:123]' }
```

`FORBIDDEN_KEYS` 覆盖 `ownerId`、`openid`、`unionid`、`wxOpenIdRef`、
`aliasKey`、`anonymousUserId`、`reporterId`、`realDisplayName`。
`body` / `draft` / `paragraphs` 只记长度。

### 禁止写入日志

- 正文、标题、草稿内容
- 搜索原始关键词（可记长度与是否有结果）
- openid / unionid
- 匿名 alias ↔ userId 的对应关系
- 举报人身份

### 结构

每条日志带 `requestId`（云函数上下文提供）与 `action`，便于串联同一请求。

| 级别 | 用途 |
|---|---|
| `log` | 成功请求（action、role、耗时） |
| `warn` | 业务错误（AppError）、被拒的回调、未知 action |
| `error` | 未预期异常（含堆栈）、context 解析失败 |

## 8.3 监控指标

CloudBase 控制台可看的：调用次数、错误率、耗时、并发。

需要额外关注的业务指标（可用定时任务写入一个统计集合，或手动查询）：

| 指标 | 查询方式 | 异常信号 |
|---|---|---|
| 审核积压 | `hg_review_tasks` 中 `status = queued` 计数 | 持续增长 → 审核接口异常或配额耗尽 |
| 人工队列 | `status = manual` 计数 | 增长 → 需要运营介入 |
| 举报待处理 | `hg_reports` 中 `status = received` | 积压 → 值守不足 |
| 发布失败率 | api 日志中 `posts/create` 的错误占比 | 升高 → 附件链路或校验问题 |
| 孤儿附件量 | `hg_assets` 中 `postId = ''` 且超 24h | 增长 → 前端上传中断频繁 |
| 存储占用 | 控制台存储用量 | 接近配额 → 检查清理任务 |

## 8.4 告警与成本护栏

**已实现**

| 措施 | 位置 |
|---|---|
| 孤儿附件 24h 清理 | `worker/tasks/cleanup.js` |
| 幂等键 7 天清理 | 同上 |
| 单文件大小限制（服务端复核） | `worker/tasks/media.js` |
| 频次限制（入社申请等） | `shared/session.js checkRateLimit` |

**未实现（任务 T-B09）**

| 措施 | 说明 |
|---|---|
| 日上传量阈值 | 超限暂停上传，但**不暂停用户读取自己的文字** |
| 云用量告警 | 控制台配置预算告警 |
| 审核调用配额监控 | 接近配额时收紧发布 |

成本结构参考（前端工程书 `docs/15` 15.2 的用量模型）：

```text
月云成本 ≈ 数据库/函数基础用量
        + 存储占用 × 单价
        + 实际下行流量 × 单价      ← 有视频时这项可能超过存储
        + 文本/图片检查调用量 × 单价
        + 视频审核分钟 + 转码分钟 × 单价
```

**本次没有读取任何真实账单或套餐报价，不填写未经核实的月成本数字。**

## 8.5 冷启动

云函数冷启动会增加首次请求耗时。本项目的控制手段：

- 生产依赖只有 `wx-server-sdk`（不引入 ORM/框架）
- `shared/db.js` 的 `cloud.init()` 用模块级 `initialized` 标记，避免重复初始化
- `memorySize`：api 256MB / worker 512MB（见 `cloudbaserc.json`）

若冷启动成为问题，可在控制台配置预置并发 —— 但这会产生固定成本，
首版 30–60 人试点不建议开启。

## 8.6 定时任务

```json
{ "name": "review-tick", "type": "timer", "config": "0 * * * * * *" }
```

每分钟触发 `worker`，单次处理 `BATCH_SIZE = 10` 个任务。

**抢占机制**：worker 用乐观更新把任务从 `queued` 改为 `running`，
只有更新成功的实例才处理该任务 —— 因此多实例并发触发也不会重复执行。

调整频率与批量的依据：
- 审核积压增长 → 提高 `BATCH_SIZE` 或缩短间隔
- 函数超时（60s）→ 降低 `BATCH_SIZE`

手动触发某类任务：

```js
// 控制台「云函数 → 测试」传入
{ "mode": "cleanup" }     // 只跑清理
{ "mode": "digest" }      // 只跑共鸣聚合
{ "mode": "review", "limit": 30 }
```

## 8.7 数据库备份

CloudBase 控制台可配置自动备份。建议：

- 首版每日一次，保留 7 天
- 重大变更（如批量迁移历史内容）前手动备份一次
- **备份文件同样含敏感数据**，下载后按内部规范保管，不放公共目录

## 8.8 排障入口

| 现象 | 排查顺序 |
|---|---|
| 所有请求返回 `server` | 查 api 函数日志的 `context error` → 通常是集合不存在或权限没设对 |
| 匿名发布报错 | 检查 `ANON_ALIAS_SECRET` 是否配置 |
| 内容一直 pending | 查 `hg_review_tasks` 的 `lastError` → 通常是内容安全接口未开通 |
| 视频 `intent` 返回 forbidden | 正常行为：`capabilities.video = false` |
| 列表查询慢 | 检查 `idx_feed` 索引是否创建，字段顺序是否与 `buildFeedWhere` 一致 |
| 回调不生效 | 检查 `REVIEW_CALLBACK_SECRET` 与推送配置；查 review-callback 日志 |
| 前端拿不到 `capabilities` | 检查 `hg_club_config` 是否有 `_id: 'heiguang'` 文档 |

## 8.9 运营手动操作清单

以下暂无接口，需在控制台操作（属已知缺口，见任务板）：

| 操作 | 位置 | 风险 |
|---|---|---|
| 设置首个管理员 | `hg_memberships` 改 `role` | 无审计日志 |
| 移除成员 / 禁言 | 同上改 `status` | 无审计日志 |
| 发布邀请码 | `hg_invite_codes` 新增文档 | 需设 `expiresAt` / `maxUses` |
| 开启能力开关 | `hg_club_config.capabilities` | **G0 未完成前不得开启 publicScope/video** |
| 创建文集 | `hg_collections` 新增文档 | 注意 `visibility` |
| 维护搜索推荐词 | `hg_club_config.searchSuggestions` | 不得从私密内容抽取 |
| 更新社区约定版本 | `hg_club_config.rulesVersion` | 需配套通知 |
