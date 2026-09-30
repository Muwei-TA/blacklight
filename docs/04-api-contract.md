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

## 4.3 action 清单（66 个）

### 会话与成员资格

| action | payload | 返回 | 权限 |
|---|---|---|---|
| `session/me` | — | `{ role, memberStatus, user, capabilities, club }` | 任意 |
| `membership/apply` | `{ displayName, inviteCode, rulesVersion }` | `{ state, applicationId }` | 已登录非成员 |
| `membership/mine` | — | `{ state, reason, appliedAtText }` | 已登录 |
| `me/profile` | — | `{ user, memberSince, stats }` | 成员 |
| `me/levels` | — | `{ level, title, totalXp, currentLevelXp, nextLevelXp, progressXp, progressTargetXp, today }` | 成员，仅本人 |
| `me/check-in` | — | 上述等级快照加 `{ awardedXp }` | 成员，仅本人 |
| `me/profile/update` | `{ displayName?, avatarAssetId? }` | `{ id, displayName, avatar }` | 已登录 |
| `me/exports` | — | `{ state: 'queued' }` | 成员 + `capabilities.export` |
| `me/account/delete` | `{ confirm: '注销' }` | `{ state: 'pending' }` | 已登录 |
| `profile/get` | `{ targetUserId, cursor? }` | `{ user, memberStatusText, visibleCount, items, nextCursor }` | 任意 |

> `profile/get` 用 `targetUserId` 而非 `userId`，明确它是"被查看者"。
> 调用者身份只能来自 `ctx.viewer`，不接受 payload 传入。

**`membership/apply` 边界**：邀请码错误/过期/用尽返回**同一文案**
「邀请码无效或已过期」，减少枚举空间；限频 10 分钟 5 次。
有效邀请码为首次入社者直接返回 `state: active`，同事务写入普通成员资格、昵称、规则同意版本及已生效的申请记录。
网络重试返回同一 `applicationId`，不重复扣除邀请码次数。前端成功后刷新 `session/me`。
已有历史 `pending` 申请的首次入社者，再次提交时重新校验邀请码与最新规则同意；复用原邀请码不重复计次，更换有效新码则扣一次新码额度，保留旧码使用记录。失效邀请码不会自动放行。
曾被移除的成员继续返回 `pending`，由管理员恢复，不能用邀请码绕过移除；旧人工入社成员的新申请仍拒绝。
身份、角色与目标状态只由服务端决定，客户端 `userId/role/status` 不参与授权。

**`me/levels` / `me/check-in`**：身份只取 `ctx.viewer.userId`，两个 action 都忽略客户端传入的身份、经验值或日期。返回字段如下：

```json
{
  "level": 3,
  "title": "青枝",
  "totalXp": 135,
  "currentLevelXp": 120,
  "nextLevelXp": 280,
  "progressXp": 15,
  "progressTargetXp": 160,
  "today": {
    "earnedXp": 8,
    "maxXp": 19,
    "checkedIn": true,
    "reactions": 3,
    "maxReactions": 5,
    "comments": 1,
    "maxComments": 3
  }
}
```

`title` 仅返回等级名称，页面以 `Lv.{{level}} {{title}}` 绘制名牌。`level` 门槛为 `0/40/120/280/520/860/1320/2000` XP；L8 的 `nextLevelXp` 为 `null`，仍累计 XP。L8 的 `progressTargetXp` 固定为 `0`，`progressXp` 返回超过 2000 的累计 XP；最高级不显示升级进度条。L1–L7 的 `progressXp` 是本级已得经验，`progressTargetXp` 是本级区间长度。每日经验按服务端 `Asia/Shanghai` 自然日统计：签到 +5（每天一次）、点赞已发布帖子/回应 +1（每天至多 5 个不同目标，目标终身只奖一次）、回应审核通过 +3（每天至多 3 个不同帖子，同一评论只奖一次），合计至多 19 XP。`today.earnedXp` 表示当天已发放的正向 XP 总量，违规反向流水会减少 `totalXp`，但不减少该字段或返还每日额度。`me/check-in` 幂等；当日重复签到返回 `awardedXp: 0` 和最新快照。

点赞奖励绑定 `hg_reactions` 的真实插入，取消点赞不扣回经验；评论奖励绑定 `hg_comments` 从待审转为 `published`，自动与人工审核共用触发器。后续从 `published` 因违规转为 `hidden` / `rejected` 时追加反向流水；自行删除评论保留经验。migration 不回填既有点赞或既有已发布回应。匿名回应的作者归属和目标 ID 只进入服务端私有流水；接口仅返回本人汇总，不返回奖励来源。账号注销最终标记为 `deleted` 时清除等级汇总及流水。评论奖励若恰逢成员资格正在变更，审核事务返回可重试冲突，自动审核进入既有退避队列，人工审核刷新后重试；这样不会出现评论发布成功但 XP 写入失败的半提交。

### 内容

| action | payload | 返回 | 权限 |
|---|---|---|---|
| `posts/list` | `{ cursor?, type?, topicId?, boardId?, filter?, pageSize? }` | `{ items: PostCardDTO[], nextCursor }` | 任意（按范围过滤） |
| `posts/detail` | `{ id }` | `PostDetailDTO` | `canReadPost` |
| `posts/create` | 见下 | `{ id, version, state }` | 成员 |
| `posts/visibility` | `{ id, visibility, expectedVersion }` | `{ ok, visibility, version }` | 作者，**仅缩小** |
| `posts/delete` | `{ id, expectedVersion }` | `{ ok }` | 作者 |
| `posts/reaction` | `{ id, next: bool }` | `{ ok }` | `canInteract` |
| `posts/bookmark` | `{ id, next: bool }` | `{ ok }` | `canInteract` |
| `posts/comments/list` | `{ id }` | `{ items, nextCursor }` | `canReadPost` |
| `posts/comments/create` | `{ id, body, replyToId?, identityMode, idempotencyKey }` | `{ id, state, version, comment }` | `canComment` |
| `posts/comments/reaction` | `{ id, commentId, next: bool }` | `{ ok }` | `canInteract`；仅 `published` 回应 |
| `posts/comments/delete` | `{ id, commentId, expectedVersion }` | `{ ok }` | 评论者本人（`canDeleteComment`） |
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
  "boardId": "可选，与 topicId 独立且可并存；private 时禁止",
  "commentsEnabled": true,
  "collectionId": "可选，文集投稿",
  "consentGranted": false,
  "idempotencyKey": "随草稿持久化，超时重试复用同一键"
}
```

返回 `state` 是 `private_saved`、`pending`、`published` 或 `rejected`。公开范围内容先经过微信内容安全自动检查：检查通过的碎片/活动自动发布；文章检查通过后保持 `pending`，等待管理员审核；存疑内容和安全检查连续失败的项目保持 `pending` 并转人工复核。只有检查中的项目不会提前返回 `published`。

普通回应也先经过微信内容安全检查；通过后自动发布，不等待管理员逐条处理。存疑或连续检查失败的回应保持 `pending` 并进入人工复核。安全自动检查仍适用于普通帖子与回应。

**回应（评论）DTO 与删除语义**（posts/comments/list 返回的每条评论/回复）：

```jsonc
{
  "id": "c1",
  "author": { "userId": "u_a", "displayName": "南枝", "isAnonymous": false, "alias": null, "isAuthor": false },
  "body": "回应正文",
  "createdAtText": "刚刚",
  "status": "published",
  "version": 1,
  "counters": { "reactions": 2 },
  "viewer": { "reacted": false, "canDelete": false },
  "replies": []
}
```

1. `viewer.*` 由服务端计算（`computeCommentViewerFlags`）：`canDelete` 仅对评论者本人为 `true`，与回应是否匿名无关；前端不得自行推断归属。
2. `canDelete` 覆盖 `pending` 与 `published`：作者可在审核通过前后删除自己的回应（待审项本人可见）。
3. 删除是软删除：`status: 'deleted'`。已删除的定向回复不再返回；已删除的一级回应若仍有可见回复，以墓碑 DTO 返回（`deleted: true`、固定文案「这条回应已被删除。」、无作者信息），否则整条隐藏。
4. 回应共鸣复用 `hg_reactions`，`_id = {userId}:comment:{commentId}`，文档带 `postId` + `commentId`；worker 的共鸣聚合只统计无 `commentId` 的记录，帖子删除时按 `postId` 一并回收。

**`PostCardDTO` 的板块与话题字段**：

```ts
{
  topic: { id: string, title: string } | null,
  board: { id: string, title: string } | null
}
```

两字段分别从 `topicId` 与 `boardId` 装配，可同时存在。无权读取板块时 `board` 为 `null`；不会把板块写入 `topic`。

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

### 板块

板块是独立于话题的帖子分流对象，使用 `hg_boards`，不改变 `topics/*` 行为。

| action | payload | 返回 | 权限 |
|---|---|---|---|
| `boards/list` | `{ q?, status?: 'active', cursor?, pageSize? }` | `{ items: BoardDTO[], nextCursor }` | 有效成员；访客返回空列表 |
| `boards/detail` | `{ id, cursor?, pageSize? }` | `{ board: BoardDTO, items: PostCardDTO[], nextCursor, canPost }` | active 对有效成员开放；pending/rejected 仅创建者或管理员可读 |
| `boards/create` | `{ title, description }` | `{ duplicated, id, status }` | 有效成员；管理员直接 active，其他成员进入 pending |

`BoardDTO` 字段为 `{ id, title, description, status, statusText, version, createdAtText, rejectReason? }`。拒绝理由只随创建者或管理员可读的 rejected 板块详情返回。列表只返回 active 板块；`status` 只接受 `active`，`q` 为 1–50 字标题子串且按字面匹配。可读的 pending/rejected 详情返回空 `items` 且 `canPost: false`。同名 pending 项属于其他成员时返回 `conflict`，响应不含该板块 ID 或状态。标题唯一性在 PostgreSQL 中按去空格、忽略大小写处理，避免并发重名。

管理员 `queue: 'board'` 条目字段为 `{ id, queue, title, summary, status, version, submittedAtText, statusText }`，不返回创建者身份。`admin/board/decide` 使用 `expectedVersion`；reject 必须带处理理由，状态、版本和审计记录在同一 PG 事务提交。

`posts/list` 的 `boardId` 先校验板块可读性及 active 状态，再把 boardId 放入分页查询条件；pending/rejected 板块只对创建者或管理员可见，且不返回帖子。`posts/create` 的 `boardId` 可与 `topicId` 同时提供；板块必须 active，且服务端再次验证成员资格。私密帖子不得关联板块。

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
| `search/query` | `{ q, scope: 'post'\|'topic', cursor?, pageSize? }` | `{ items, nextCursor }` |
| `search/suggestions` | — | `{ items: string[] }` |
| `search/private` | `{ q, cursor?, pageSize? }` | `{ items, nextCursor }` |

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
| `admin/queue` | `{ queue: 'all'|'content'|'comment'|'topic'|'board'|'member'|'report'|'collection'|'appeals', cursor?, pageSize? }` | `{ items, nextCursor }` |
| `admin/content/decide` | `{ id, decision, reason, expectedVersion }` | `{ ok, status }` |
| `admin/topic/decide` | `{ id, decision, reason? }` | `{ ok, status }` |
| `admin/board/decide` | `{ id, decision: 'approve'|'reject', expectedVersion, reason? }` | `{ ok, status, version }` |
| `admin/membership/decide` | `{ id, decision, reason? }` | `{ ok }` |
| `admin/report/decide` | `{ id, decision, reason }` | `{ ok }` |
| `admin/collection/decide` | `{ id, decision, reason? }` | `{ ok }` |
| `admin/anonymous/reveal` | `{ threadId, reason }` | `{ threadId, mappings }` |
| `admin/usage/status` | — | `UsageStatusDTO` | moderator/admin |

`queue: 'all'` 将全部当前可处理的人工待办按提交时间、源记录 ID 与队列名升序合并，统一返回 `{ items, nextCursor }`。客户端原样回传 `nextCursor`，不要按队列拆分或自行构造游标。项目类型包括内容安全人工复核/文章审批、回应安全人工复核、话题、板块、入社与移除成员恢复、举报、文集收录、内容申诉。普通帖子和回应的自动安全检查排队中或运行中时不进入管理员审批列表。

`UsageStatusDTO` 提供 UTC 当日社团聚合用量，不包含个人用量或身份：

```ts
{
  date: string,
  timezone: 'UTC',
  upload: {
    usedBytes: number, reservedBytes: number, dailyLimitBytes: number,
    userDailyLimitBytes: number, remainingBytes: number, warningRatio: number,
    alertState: 'ok' | 'near_limit' | 'limit_reached' | 'disabled', alertedAt: string | null
  },
  review: {
    calls: number, textCalls: number, imageCalls: number, dailyLimitCalls: number,
    remainingCalls: number, warningRatio: number,
    alertState: 'ok' | 'near_limit' | 'limit_reached' | 'disabled', alertedAt: string | null
  },
  updatedAt: string
}
```

上传 `dailyLimitBytes` 是社团总额；`userDailyLimitBytes` 是现有单人滚动 24 小时额度。审核达到上限后保留 queued 状态并延迟至下一 UTC 日；跨过预警阈值时向 active moderator/admin 写一次站内通知。

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
| `posts/comments/reaction` | `_id = {userId}:comment:{commentId}`，天然幂等 |
| `posts/comments/delete` | `expectedVersion` 版本锁，重复提交抛 `conflict` |
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
