# 10｜初始化与部署

## 10.1 前置条件

| 项 | 说明 |
|---|---|
| 小程序 AppID | 与前端 `project.config.json` 一致 |
| CloudBase 环境 | 在微信开发者工具「云开发」开通，记下环境 ID |
| Node.js | ≥ 16（本地脚本用） |
| CloudBase CLI | `npm i -g @cloudbase/cli` |

## 10.2 首次初始化（按顺序执行）

### 第 1 步：创建集合

```bash
node scripts/db-init.mjs       # 打印完整清单
```

在控制台「数据库」创建 21 个集合，或用 CLI：

```bash
tcb db:collection:create hg_users --env-id <envId>
# ... 其余 20 个，清单见脚本输出
```

### 第 2 步：设置集合权限 ⚠️ 最关键

**全部 21 个集合设为「仅管理端可读写」。**

控制台路径：数据库 → 选择集合 → 权限设置 → 仅管理端可读写。

> 这一步做错会让 `05-authorization.md` 的全部规则失效 ——
> 前端可以直接 `wx.cloud.database()` 绕过所有判权。
> 逐个集合确认，不要凭记忆。

### 第 3 步：创建索引

按 `scripts/db-init.mjs` 输出逐集合添加。**最重要的是**：

```text
hg_posts.idx_feed = clubId(1) + status(1) + visibility(1) + createdAt(-1)
```

字段顺序必须与 `buildFeedWhere()` 的过滤条件一致，否则信息流分页退化为全表扫描。

唯一索引（防重复的关键）：

| 集合 | 索引 |
|---|---|
| `hg_users` | `wxOpenIdRef` |
| `hg_memberships` | `userId + clubId` |
| `hg_reactions` | `userId + postId` |
| `hg_bookmarks` | `userId + postId` |
| `hg_topic_follows` | `userId + topicId` |
| `hg_anonymous_identities` | `threadId + userId` |

### 第 4 步：配置云存储

- 控制台「存储」→ 权限设置 → **仅云函数可读写**（不是"所有人可读"）
- 目录结构由代码自动创建：`private/{image|video}/{userId前8位}/`

### 第 5 步：配置环境变量

控制台「云函数 → 配置 → 环境变量」，为三个函数分别设置：

```bash
# 生成密钥
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

| 函数 | 变量 |
|---|---|
| `api` | `ANON_ALIAS_SECRET`、`NODE_ENV=production` |
| `worker` | `ANON_ALIAS_SECRET`、`NODE_ENV=production` |
| `review-callback` | `REVIEW_CALLBACK_SECRET`、`NODE_ENV=production` |

> `ANON_ALIAS_SECRET` 一旦变更，历史匿名帖的 alias 会跳变。首次部署前定好并保管。

### 第 6 步：写入种子数据

`hg_club_config` 新增一条（内容见 `db-init.mjs` 输出）：

```json
{
  "_id": "heiguang",
  "name": "黑光文学社",
  "rulesVersion": "v1.0",
  "capabilities": { "publicScope": false, "video": false, "anthology": true, "export": false }
}
```

**`publicScope` 与 `video` 必须为 `false`**，直到 G0 核验完成。

### 第 7 步：部署云函数

```bash
npm run sync                                  # 同步 shared/ 到各函数目录
node scripts/deploy.mjs --env-id <envId>      # 前置检查 + 输出部署命令
tcb login
tcb fn deploy api --env-id <envId> --force
tcb fn deploy worker --env-id <envId> --force
tcb fn deploy review-callback --env-id <envId> --force
```

或用微信开发者工具：右键云函数目录 → 上传并部署（云端安装依赖）。
**注意**：上传前必须先 `npm run sync`，否则 `shared/` 目录不存在。

### 第 8 步：创建定时触发器

```bash
tcb fn trigger create worker --env-id <envId> \
  --name review-tick --config '{"cron":"0 * * * * * *"}'
```

或在控制台「云函数 → worker → 触发器」添加，cron 为 `0 * * * * * *`（每分钟）。

### 第 9 步：设置首个管理员

1. 用管理员微信登录一次小程序（会自动创建 `hg_users` 记录）
2. 控制台 `hg_memberships` 新增或修改该用户的文档：
   ```json
   { "_id": "{userId}:heiguang", "userId": "...", "clubId": "heiguang",
     "role": "moderator", "status": "active" }
   ```

### 第 10 步：发布邀请码

`hg_invite_codes` 新增文档：

```json
{ "_id": "HEIGUANG26", "expiresAt": "2026-12-31T00:00:00.000Z",
  "maxUses": 60, "usedCount": 0, "revokedAt": null }
```

`_id` 必须**大写**（代码会 `toUpperCase()` 后查询）。

## 10.3 部署后冒烟验证

```text
1. 小程序调 session/me     → 返回 role/memberStatus/capabilities
2. 访客调 posts/list       → 返回空列表或仅公开内容，不报错
3. 成员发一条社内碎片      → state = 'pending'
4. 等 1 分钟（worker 触发）→ 查 hg_review_tasks 的状态
   - 若 status = manual 且 lastError 含 msgSecCheck → G0-2 未完成（预期）
   - 若 status = passed  → 内容安全接口可用，内容已 published
5. 普通成员调 admin/queue  → forbidden
6. 搜索一个私密帖的唯一词  → 0 结果
```

第 4 步是判断 G0-2 是否完成的最直接方法。

## 10.4 G0 检查单（上线前逐项确认）

| 项 | 确认方式 | 负责人 |
|---|---|---|
| 主体、AppID、服务类目（UGC/社区） | 微信公众平台后台截图 | |
| 内容安全接口开通与配额 | 冒烟验证第 4 步 status = passed | |
| 视频转码方案确定并验收 | 见 `06` 6.4 清单 | |
| 审核值守人员与升级路径 | 书面排班 | |
| 隐私保护指引已配置 | 后台「用户隐私保护指引」 | |
| 小程序备案与运营责任人 | 备案编号 | |
| 占位素材已替换或取得授权 | 素材清单 | |
| 集合权限全部 ADMINONLY | 逐集合截图 | |
| 存储桶为私有 | 控制台截图 | |
| 环境变量已配置 | 函数配置截图 | |
| 越权验收清单（`09` 9.4）全过 | 测试记录 | |

**未全部完成前**：`capabilities.publicScope` 与 `video` 保持 `false`，仅内部试点。

## 10.5 日常部署

改动 `shared/` 后必须重新部署**所有**函数（因为副本是复制进去的）：

```bash
npm test && npm run check      # 必须全绿
npm run sync
tcb fn deploy api --env-id <envId> --force
tcb fn deploy worker --env-id <envId> --force
tcb fn deploy review-callback --env-id <envId> --force
```

只改某个 domain 文件时，只需部署对应函数。

## 10.6 回滚

CloudBase 保留云函数历史版本：控制台「云函数 → 版本管理」可切换流量到旧版本。

**数据库变更无法自动回滚**。因此：

- 改字段语义前先备份
- 状态机变更要考虑存量数据（如新增状态值时，旧数据的行为）
- 索引可以安全删除重建，但重建期间查询会变慢

**紧急止血手段**（不需要部署）：把 `hg_club_config.capabilities` 全部改为 `false`。
这会立即禁止公开发布与视频上传，但不影响用户读取自己已有的内容。

## 10.7 与前端的联调切换

前端 `config.js`：

```js
export default {
  isMock: true,     // 改为 false 走真实云函数
  baseUrl: '',
};
```

前端目前用 `wx.request` + Mock 拦截。切到 CloudBase 需要改 `api/request.js`
为 `wx.cloud.callFunction` —— 这是前端任务 T-17，本仓库的 action 命名
已按前端 service 的调用习惯设计，改造时一一对应即可。

**联调顺序建议**：
1. `session/me`（最简单，验证连通性与会话解析）
2. `posts/list`（验证权限过滤与分页）
3. `posts/create` + `worker` 审核（验证完整纵向链路）
4. 其余模块
