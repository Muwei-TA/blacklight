# 04｜接口契约

> 调用方式：`wx.cloud.callFunction({ name: 'api', data: { action, payload } })`
> 本文档与前端 `docs/04-data-model-and-api.md` 是**同一份契约的两侧**，任何变更必须双边同步。

## 4.1 响应包装

```jsonc
// 成功
{ "code": 0, "message": "ok", "data": { }, "requestId": "..." }

// 失败
{ "code": "not_accessible", "message": "这条内容当前不可访问", "requestId": "..." }
{ "code": "invalid_input", "message": "标题最多 60 字", "detail": { "field": "title" }, "requestId": "..." }
```

`code` 为 `0` 表示成功，否则是 `AppError.kind` 字符串。前端 `api/request.js`
据此映射到 UI 行为。

## 4.2 错误码

| `code` | HTTP 语义 | 前端行为 |
|---|---|---|
| `unauthenticated` | 401 | 清账号缓存 → 访客态 |
| `membership_invalid` | 403 | 提示需要成员资格 → 引导 P12 |
| `forbidden` | 403 | 提示无权，不解释内部原因 |
| `not_accessible` | 404 | 统一「内容当前不可访问」，**不显示标题** |
| `invalid_input` | 422 | 按 `detail.field` 定位提示 |
| `conflict` | 409 | 版本冲突 → 提供刷新 |
| `pending_media` | 409 | 附件仍在处理，禁止提交 |
| `rate_limited` | 429 | 稍后再试 |
| `server` | 5xx | 统一故障提示 + 重试 |

**关键规则**：`not_accessible` 用于"无权"和"不存在"两种情况，
返回体完全相同，防止通过错误文案差异探测私密内容是否存在。

## 4.3 action 清单（44 个）

### 会话与成员资格

| action | payload | 返回 | 权限 |
|---|---|---|---|
| `session/me` | — | `{ role, memberStatus, user, capabilities, club }` | 任意 |
| `membership/apply` | `{ displayName, inviteCode, rulesVersion }` | `{ state, applicationId }` | 已登录非成员 |
| `membership/mine` | — | `{ state, reason, appliedAtText }` | 已登录 |
| `me/profile` | — | `{ user, memberSince, stats }` | 成员 |
| `me/profile/update` | `{ displayName?, avatarAssetId? }` | `{ id, displayName, avatar }` | 已登录 |
| `me/exports` | — | `{ state: 'queued' }` | 成员 + `capabilities.export` |
| `me/account/delete` | `{ confirm: '注销' }` | `{ state: 'pending' }` | 已登录 |
| `profile/get` | `{ targetUserId, cursor? }` | `{ user, memberStatusText, visibleCount, items }` | 任意 |

> `profile/get` 用 `targetUserId` 而非 `userId`，明确它是"被查看者"。
> 调用者身份只能来自 `ctx.viewer`，不接受 payload 传入。

**`membership/apply` 边界**：邀请码错误/过期/用尽返回**同一文案**
「邀请码无效或已过期」，减少枚举空间；限频 10 分钟 5 次。

### 内容

| action | payload | 返回 | 权限 |
|---|---|---|---|
| `posts/list` | `{ cursor?, type?, topicId?, filter?, pageSize? }` | `{ items: PostCardDTO[], nextCursor }` | 任意（按范围过滤） |
| `posts/detail` | `{ id }` | `PostDetailDTO` | `canReadPost` |
| `posts/create` | 见下 | `{ id, version, state }` | 成员 |
| `posts/visibility` | `{ id, visibility, expectedVersion }` | `{ ok, visibility, version }` | 作者，**仅缩小** |
| `posts/delete` | `{ id, expectedVersion }` | `{ ok }` | 作者 |
| `posts/reaction` | `{ id, next: bool }` | `{ ok }` | `canInteract` |
| `posts/bookmark` | `{ id, next: bool }` | `{ ok }` | `canInteract` |
| `posts/comments/list` | `{ id }` | `{ items, nextCursor }` | `canReadPost` |
| `posts/comments/create` | `{ id, body, replyToId?, identityMode, idempotencyKey }` | `{ id, state: 'pending' }` | `canComment` |
| `me/contents` | `{ tab, cursor? }` | `{ items, nextCursor }` | 已登录 |
| `reports/create` | `{ targetType, targetId, reason, evidence? }` | `{ receiptId, state }` | 已登录 |

**`posts/create` payload**

```jsonc
{
  "kind": "fragment | article | event",
  "title": "文章必填，≤60 字",
  "body": "碎片 ≤2000，文章 ≤20000",
  "assetIds": ["已 verified 的附件"],
  "visibility": "public | club | private",
  "identityMode": "named | anonymous",
  "topicId": "可选，private 时禁止",
  "commentsEnabled": true,
  "collectionId": "可选，文集投稿",
  "consentGranted": false,
  "idempotencyKey": "随草稿持久化，超时重试复用同一键"
}
```

返回 `state`：`private_saved`（仅自己，直接保存）或 `pending`（进入审核）。
**绝不返回表示"已公开"的状态** —— 那要等审核通过。

**`me/contents` 的 tab**：`published` / `pending` / `private` / `bookmark`。
`bookmark` 会逐条复核权限，失效项返回
`{ id, unavailable: true, placeholder: '这条内容当前不可访问' }` —— **不返回摘要**。

### 话题

| action | payload | 返回 |
|---|---|---|
| `topics/list` | `{ category?, cursor? }` | `{ items, nextCursor }` |
| `topics/detail` | `{ id, cursor? }` | `{ topic, canPost, items, nextCursor }` |
| `topics/create` | `{ title, description, category }` | `{ duplicated, id, status }` |
| `topics/follow` | `{ id, next }` | `{ ok }` |
| `me/topics` | `{ cursor? }` | `{ items, nextCursor }` |

`topics/create` 遇同名返回 `{ duplicated: true, id }`，**不创建重复项**，
前端据此引导"去参与"。新话题一律 `pending` + 社内。

### 文集

| action | payload | 返回 |
|---|---|---|
| `collections/list` | — | `{ items }` |
| `collections/detail` | `{ id }` | `{ collection, entries, canSubmit }` |
| `collections/submit` | `{ id, postId, consentVersion }` | `{ state: 'submitted' }` |
| `consents/revoke` | `{ postId }` | `{ ok }` |

`collections/submit` 会校验 `canIncludeInCollection`：
**公开文集不接收社内原帖**，违反时返回 `invalid_input` 并说明需另建新文章。

### 消息

| action | payload | 返回 |
|---|---|---|
| `notifications/list` | `{ tab: 'reply'\|'system', cursor? }` | `{ items, nextCursor }` |
| `notifications/read-all` | — | `{ ok }` |
| `notifications/unread-count` | — | `{ count }` |

每条通知渲染前复核 `target` 可访问性，失效时 `title` 替换为
「相关内容已不可访问」且 `summary` 清空。

### 搜索

| action | payload | 返回 |
|---|---|---|
| `search/query` | `{ q, scope: 'post'\|'topic', pageSize? }` | `{ items, nextCursor }` |
| `search/suggestions` | — | `{ items: string[] }` |
| `search/private` | `{ q }` | `{ items }` |

**搜索约束**（`domain/search.js`）：
- 权限条件先进 `where`，不是查出来再过滤
- 只匹配 `title` / `body`，**不匹配作者昵称** —— 否则搜真实昵称能反查匿名帖
- `private` 内容永不进 `search/query`，只在 `search/private` 中查本人的
- 关键词正则元字符已转义，防注入与全表扫描

### 媒体

| action | payload | 返回 |
|---|---|---|
| `assets/intent` | `{ mediaType, size, duration?, mimeType }` | `{ assetId, cloudPath, expiresInSeconds }` |
| `assets/confirm` | `{ assetId, fileId }` | `{ assetId, status: 'uploaded' }` |
| `assets/status` | `{ assetId }` | `{ status, url, cover, failureReason }` |

`assets/status` 只在 `verified` 时返回 `url`，否则为空串。详见 `06`。

### 管理台

| action | payload | 返回 |
|---|---|---|
| `admin/queue` | `{ queue, cursor? }` | `{ items, nextCursor }` |
| `admin/content/decide` | `{ id, decision, reason, expectedVersion }` | `{ ok, status }` |
| `admin/topic/decide` | `{ id, decision, reason? }` | `{ ok, status }` |
| `admin/membership/decide` | `{ id, decision, reason? }` | `{ ok }` |
| `admin/report/decide` | `{ id, decision, reason }` | `{ ok }` |
| `admin/collection/decide` | `{ id, decision, reason? }` | `{ ok }` |
| `admin/anonymous/reveal` | `{ threadId, reason }` | `{ threadId, mappings }` |

**管理台硬约束**：

1. 每个 handler 第一行调 `policies.canAccessModeration`，
   非授权角色返回 `forbidden` —— 前端隐藏入口不构成保护。
2. `reject` / `hide` / `report.decide` 的 `reason` **必填**。
3. `admin/content/decide` 的任何分支都**不修改 `visibility`**。
4. 私密内容进入该接口直接 `forbidden`，防止管理台成为读私密的侧门。
5. `admin/queue` 返回的内容条目**不含 `ownerId`**，只给 `isAnonymous` 标记。
6. 举报队列**不返回 `reporterId`**。
7. `admin/anonymous/reveal` 需 `moderator` 角色 + 理由 ≥10 字，
   且**先写审计日志再返回数据**（审计写失败则不返回）。

## 4.4 幂等

| action | 幂等实现 |
|---|---|
| `posts/create` | `Idempotency-Key` → `hg_idempotency`，重放返回首次结果 |
| `posts/comments/create` | 同上 |
| `posts/reaction` / `posts/bookmark` | `_id = {userId}:{postId}`，天然幂等 |
| `admin/*/decide` | `expectedVersion` 版本锁，重复提交抛 `conflict` |

**按钮防连点只改善体验，真正防重复依靠服务端幂等键。**

## 4.5 发布时序（前后端配合）

```text
前端                                   后端
─────────────────────────────────────────────────────────────
1. 本地存草稿（含 idempotencyKey）
2. assets/intent            →   创建 asset 记录，返回 cloudPath
3. wx.cloud.uploadFile      →   直传私有桶
4. assets/confirm           →   status=uploaded，排入审核队列
5. 轮询 assets/status       →   worker 处理：复核文件 → 内容检查 → verified
6. posts/create             →   校验附件归属与状态 → 写 Post(pending) → 建审核任务
7. 清草稿 → 跳结果页             worker 审核通过 → status=published → 通知作者
```

任一步失败都不留"列表有帖子但附件还属于临时用户"的中间态：
`posts/create` 会校验所有 `assetIds` 必须是本人且 `verified`，否则抛 `pending_media` / `forbidden`。

## 4.6 未实现的接口（前端需知）

| 能力 | 现状 |
|---|---|
| 视频发布 | `capabilities.video = false`。转码未接入，`assets/intent` 会 `forbidden` |
| 数据导出文件生成 | `me/exports` 只创建任务与通知，不产出文件 |
| 申诉工单 | 通知文案已提示可申诉，但无提交接口 |
| 成员移除/禁言/角色调整 | 无接口，运营在控制台手动改 `hg_memberships` |
| 订阅消息推送 | 未接入，只有站内通知 |
