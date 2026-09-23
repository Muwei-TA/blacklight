# 03｜数据模型

> 集合名与枚举的唯一来源是 `shared/constants.js`。本文档是其说明，两者不一致时以代码为准。
> 索引与权限的可执行清单：`node scripts/db-init.mjs`

## 3.1 权限总则

**所有 21 个集合的云数据库权限都设为「仅管理端可读写」（ADMINONLY）。**

理由见 `01-decisions.md` 1.1：CloudBase 的数据库权限粒度做不到
"社内成员 且 已发布 且 非匿名映射"这种条件。因此：

- 小程序端**禁止** `wx.cloud.database()` 直连
- 所有读写经 `api` 云函数，由 `shared/policies.js` 判权
- 即使前端代码被反编译，也拿不到直读数据库的能力

### 受限集合（额外注意）

`RESTRICTED_COLLECTIONS` 中的集合存放最敏感数据，**严禁出现在任何客户端响应中**：

| 集合 | 敏感内容 | 泄露后果 |
|---|---|---|
| `hg_anonymous_identities` | alias ↔ userId 映射 | 匿名失效，可反查作者 |
| `hg_audit_logs` | 管理操作记录 | 暴露治理细节与处理人 |
| `hg_reports` | 举报人身份 | 举报人遭报复 |
| `hg_invite_codes` | 邀请码与配额 | 邀请制被绕过 |
| `hg_idempotency` | 幂等键与结果 | 可推测他人操作 |

## 3.2 集合清单

### 身份与成员

**`hg_users`**

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 内部用户 ID，对外可见 |
| `wxOpenIdRef` | string | openid。**不进入任何 DTO** |
| `displayName` | string | 自选昵称，≤20 字 |
| `avatar` | string | 头像 URL（来自已验证附件） |
| `status` | string | `active` / `deletion_requested` / `deleted` |
| `rate` | object | 频次限制窗口 `{ [action]: { startedAt, count } }` |

索引：`wxOpenIdRef`（唯一）、`status`

**`hg_memberships`**

| 字段 | 说明 |
|---|---|
| `_id` | `{userId}:{clubId}` |
| `userId` / `clubId` | 复合唯一 |
| `role` | `member` / `admin` / `moderator` |
| `status` | `active` / `removed`。**撤销即时影响鉴权** |
| `joinedAt` / `rulesVersion` | 加入时间与同意的规则版本 |

> `shared/session.js` 每次请求实时查询本集合，不做长缓存 ——
> 退社/被移除必须立即生效（`05` 5.5）。

**`hg_membership_applications`**：入社申请。`status`、`decisionReason`、`decidedBy`。

**`hg_invite_codes`**（受限）：`_id` 为邀请码大写，含 `expiresAt`、`maxUses`、`usedCount`、`revokedAt`。

### 内容

**`hg_posts`** —— 核心集合

| 字段 | 类型 | 说明 |
|---|---|---|
| `clubId` | string | 保留字段，首版固定 `heiguang` |
| `ownerId` | string | 由会话决定。匿名内容的 DTO **不返回**此字段 |
| `kind` | string | `fragment` / `article` / `event` |
| `category` / `categoryText` | string | 筛选用 |
| `title` / `body` | string | 正文纯文本，保留换行 |
| `assetIds` | array | 已验证附件 ID |
| `hasVideo` | bool | 视频筛选用（避免对 assets 做 join） |
| `visibility` | string | `public` / `club` / `private` |
| `identityMode` | string | `named` / `anonymous` |
| `commentsEnabled` | bool | `private` 时强制 false |
| `topicId` | string | 最多一个主话题 |
| `status` | string | 状态机见 `07` |
| `version` | number | 乐观锁 |
| `permissionVersion` | number | 范围变更/隐藏时递增，用于媒体与缓存失效 |
| `reactionCount` / `commentCount` | number | 原子计数 |
| `rejectReason` / `hiddenReason` | string | 处理理由 |

索引（关键）：

```text
idx_feed: clubId + status + visibility + createdAt(-1)
```

这个复合索引的字段顺序与 `buildFeedWhere()` 的过滤条件一致。
**游标排序字段必须在同一个索引里**，否则分页会退化为全表扫描。

其余：`ownerId + createdAt`、`topicId + createdAt`、`status + createdAt`

**`hg_comments`**：`postId`、`ownerId`、`replyToId`、`body`、`identityMode`、`status`、`version`。
一级评论 + 定向回复，不做嵌套树。

**`hg_reactions` / `hg_bookmarks`**：`_id` 为 `{userId}:{postId}`，天然幂等防重。
`reactions` 额外有 `digested` 字段供共鸣聚合使用。

**`hg_assets`**

| 字段 | 说明 |
|---|---|
| `ownerId` | 只能绑定本人附件 |
| `clubId` | 服务端从会话绑定的社团 |
| `mediaType` | `image` / `video` |
| `declaredSize` / `declaredDuration` | 客户端声明值，**不可信** |
| `actualSize` | 服务端复核的真实值 |
| `quotaBytes` / `quotaChargedAt` | 上传意图预留容量与持久计量标记；文件 purge 后仍保留已实际消耗额度 |
| `cloudPath` / `fileId` | 私有桶路径。文件名不含身份线索 |
| `status` | `intent` → `uploaded` → `verifying` → `verified` / `rejected` |
| `tempFileURL` | **仅 verified 时有值**，否则为空串 |
| `traceId` | 异步审核追踪 ID |
| `postId` / `postVersion` | 绑定关系，防止任意 fileId 挂接 |

### 话题与文集

**`hg_topics`**：`status` 为 `pending` / `active` / `archived`，`postCount` 参与计数。
**`hg_topic_follows`**：`_id` 为 `{userId}:{topicId}`。
**`hg_collections`**：`visibility`、`order`、`entryCount`、`intro`。
**`hg_collection_entries`**：`collectionId`、`postId`、`consentId`、`order`。
**不存正文快照** —— 目录每次实时读取原文状态，避免绕过权限。

**`hg_consents`**

| 字段 | 说明 |
|---|---|
| `_id` | `{postId}:collection:{collectionId}` |
| `purpose` | `collection_display`。授权与**具体用途**绑定 |
| `scope` | 授权时的文集范围 |
| `version` | 授权文本版本 |
| `grantedAt` / `revokedAt` | 撤回后 `revokedAt` 非空 |

> 不写"永久、不可撤销、全球任意使用"的笼统同意。公开宣传、印刷出版需另行授权。

### 治理与运行

**`hg_notifications`**：`recipientId`、`eventType`、`title`、`summary`、
`targetType`、`targetId`、`readAt`。文案中性，不含正文与匿名映射。

**`hg_reports`**（受限）：`reporterId` 仅存于此，**任何响应都不返回**（含管理台）。

**`hg_review_tasks`**：`targetType`、`targetId`、`status`、`attempts`、`needsMedia`、`lastError`。
`attempts >= 5` 转 `manual` 人工处理，不丢弃。

**`hg_audit_logs`**（受限）：`actorId`、`action`、`targetType`、`targetId`、
`decision`、`reason`。**不存原始私密正文**。

**`hg_anonymous_identities`**（受限）

| 字段 | 说明 |
|---|---|
| `threadId` | 帖子 ID。别名按 (threadId, userId) 派生，故跨帖不可串联 |
| `userId` | 真实用户，**只在此集合出现** |
| `alias` | 展示名，如「树洞旅人 07」 |
| `aliasKey` | HMAC 摘要前缀，撞号消歧用，**不出现在响应中** |
| `isThreadAuthor` | 是否为帖子作者（评论区标记「作者」用） |

索引：`threadId + userId`（唯一）、`threadId + isThreadAuthor`

**`hg_idempotency`**（受限）：`_id` 为 `{userId}:{action}:{key}`，存 `result` 供重放。

**`hg_club_config`**：单文档 `_id: 'heiguang'`，含 `capabilities`、`searchSuggestions` 与 `usageLimits`。
用量阈值字段为 `userUploadDailyBytes`、`clubUploadDailyBytes`、`reviewDailyCalls`、`warningRatio`；由 PostgreSQL 迁移为开发环境填入默认值，管理员可按运营额度调整。

**PostgreSQL `hg_daily_usage`**：按 `club_id + usage_date (UTC)` 保存社团已上传/预留字节、文本/图片审核调用计数、阈值和告警状态。RLS 开启且仅 `service_role` 可读写；API 只通过 moderator/admin 专用的 `admin/usage/status` 返回聚合 DTO，不含个人身份或单人用量。

## 3.3 游标分页

游标 = `base64({ createdAt, id })`，由 `validators.buildCursor()` 生成。

```js
// shared/db.js paginate() 的核心条件
$or: [
  { createdAt: _.lt(cursorDate) },
  { createdAt: cursorDate, _id: _.lt(cursor.id) },   // 同毫秒用 _id 兜底
]
```

用 `_id` 兜底是为了避免同一毫秒内多条数据造成**边界重复或漏读**。
`parseCursor()` 会校验形状，伪造游标抛 `invalid_input`。

多取一条（`limit(pageSize + 1)`）判断 `hasMore`，避免额外 count 查询。

## 3.4 计数字段的一致性

`reactionCount` / `commentCount` / `postCount` / `entryCount` 用原子 `inc` 维护。

**已知取舍**：这些计数在极端并发或任务失败时可能与实际记录数产生偏差。
首版接受这一偏差（对用户体验影响小），但：

- 计数**不参与权限判断**，只用于展示
- `awaiting_reply` 筛选依赖 `commentCount === 0`，若计数偏高会导致漏掉待回应内容 ——
  这是可接受的"少显示"，而非"多泄露"
- 后续如需精确，加一个定时对账任务（任务板 T-B12）

## 3.5 云存储

```text
private/{mediaType}/{userId前8位}/{assetId}.{ext}
```

- 桶权限：**私有**，仅云函数可读写
- 文件名用 `assetId`，**不用原始文件名** —— 避免文件名本身泄露信息
- 访问通过 `getTempFileURL` 生成限时链接，且只在 `status === 'verified'` 时生成
- **限时链接只缩短泄露窗口，不等于即时撤权**，详见 `06-media-pipeline.md` 6.5
