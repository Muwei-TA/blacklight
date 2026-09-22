# 05｜鉴权实现（最高优先级）

> 本章任一条被违反即为 P0 缺陷：停止相关能力并修复，不接受"先上线再改"。
> 规则源头是前端 `docs/05-permission-privacy.md`；本章是其服务端实现说明。

## 5.1 唯一实现：`shared/policies.js`

**所有**"能否看见 / 能否操作"的判断都在这个文件里，它是纯函数：

- 不访问数据库，不引入 `wx-server-sdk` → 因此可被单元测试完整覆盖
- 被 `api` 与 `worker` 共享 → 客户端请求与后台任务用同一份规则
- `npm run check` 会拦截在 domain 层内联写 `visibility === 'club'` 这类判断

### viewer 是唯一合法的身份来源

```js
// shared/session.js
const openid = cloud.getWXContext().OPENID;   // ← 只能来自云上下文
const ctx = await resolveContext(openid);
// ctx.viewer = policies.buildViewer({ userId, role, memberStatus, clubId })
```

**客户端传来的 `ownerId` / `role` / `isMember` / `openid` 一律忽略。**
`npm run check` 会扫描 domain 层，发现读取 `payload.ownerId` 等字段即报错。

### 成员资格撤销立即生效

```js
function buildViewer({ userId, role, memberStatus, clubId }) {
  const isActiveMember = memberStatus === MEMBER_STATUS.ACTIVE;
  return {
    // 关键：memberStatus 不是 active 时，role 强制降级为 guest
    role: isActiveMember ? role : ROLE.GUEST,
    isMember: isActiveMember,
    isAdmin: isActiveMember && (role === ADMIN || role === MODERATOR),
  };
}
```

即使某人数据库里 `role = 'admin'`，只要 `status = 'removed'`，
`isAdmin` 就是 `false`。`session.js` 每次请求实时查 `hg_memberships`，**不做长缓存**。

## 5.2 核心判断：`canReadPost`

按顺序短路，任何未覆盖情况都**拒绝**（fail-closed）：

```text
1. post 不存在                          → false
2. status ∈ {deleted, superseded}       → false（作者也不行）
   status == hidden                     → 仅 isAdmin（治理需要）
3. visibility == private                → 仅 isOwner（管理员也不行）
4. status != published                  → isOwner 或 isAdmin（待审/退回本人可预览）
5. visibility == public                 → true
6. visibility == club                   → isMember 或 isOwner
7. 未知 visibility                      → false ← 关键的 fail-closed
```

第 7 条很重要：若将来新增 `visibility` 值而忘了更新此函数，
行为是"拒绝访问"而非"允许访问"。

### `canListPost` 比 `canReadPost` 更严

```js
canListPost = status === published
           && visibility !== private   // 仅自己内容永不进聚合入口，本人也不例外
           && canReadPost(viewer, post)
```

聚合入口 = 信息流、话题、搜索、文集目录、社员主页。
私密内容进入其中任何一处，都可能通过**总数**泄露其存在。

## 5.3 列表查询：先鉴权再查询

```js
// ✅ domain/posts.js buildFeedWhere()
function buildFeedWhere(viewer, extra) {
  const base = { clubId, status: PUBLISHED, ...extra };
  base.visibility = viewer.isMember
    ? _.in([PUBLIC, CLUB])     // 成员：公开 + 社内
    : PUBLIC;                   // 访客：仅公开
  return base;                  // private 永不出现在条件里
}
```

条件下推到数据库层，因此：
- 返回的 items 里不可能有越权数据
- `nextCursor` 与 `hasMore` 不会因过滤而错乱
- 不存在"总数是 10 但只返回 7 条"这种泄露

**反面做法**（严禁）：

```js
// ❌ 查全量再内存过滤 —— 分页边界与总数都会泄露私密内容的存在
const all = await coll.where({ clubId }).get();
return all.data.filter(p => policies.canReadPost(viewer, p));
```

搜索同理，见 `domain/search.js`。

## 5.4 范围变更：只能缩小

```js
VISIBILITY_RANK = { private: 1, club: 2, public: 3 }

canChangeVisibility(viewer, post, next) {
  return isOwner(viewer, post) && RANK[next] < RANK[post.visibility];
}
```

| 变更 | 允许 |
|---|---|
| `public → club` / `club → private` / `public → private` | ✅ |
| `private → club` / `club → public` / `private → public` | ❌ |
| 管理员代作者改（任何方向） | ❌ |

需要更大受众时**新建内容**，重新确认身份、来源与授权，不继承原评论与点赞。

缩小范围时：
1. `permissionVersion` 递增 → 媒体链接与缓存失效依据
2. 删除 `hg_collection_entries` 中的相关条目 → 文集目录同步移除
3. 前端必须提示"已保存的截图无法追回"

## 5.5 匿名隔离

### 别名派生：HMAC 而非可逆编码

```js
// shared/anonymity.js
deriveAlias(threadId, userId, secret) {
  const digest = hmac('sha256', secret).update(`${threadId}:${userId}`).digest();
  return { alias: `树洞旅人 ${(digest.readUInt16BE(0) % 99) + 1}`, aliasKey: ... };
}
```

- 由 `(threadId, userId)` 共同派生 → **线程内稳定，跨帖不可串联**
- HMAC 不可逆 → 拿到 alias 无法反推 userId
- `secret` 来自环境变量 `ANON_ALIAS_SECRET`，**缺失时直接抛错**
  （fail-closed：宁可匿名发布失败，也不用可预测的默认值）

### DTO 层的强制隔离

```js
// shared/presenters.js presentAuthor()
if (post.identityMode === ANONYMOUS) {
  return { userId: null, displayName: null, isAnonymous: true, alias };
}
```

匿名内容的 `author.userId` **恒为 null** → 客户端拼不出主页链接。

### 禁止出现的位置

| 位置 | 防护措施 |
|---|---|
| Post/Comment 响应 | `presenters.js` 白名单构造，不 spread 文档 |
| 图片文件名 / 存储路径 | 用 `assetId` 命名，不用原始文件名 |
| 日志 / 埋点 | `anonymity.scrubForLog()` 把禁用字段替换为 `[redacted]` |
| 搜索结果 | `search.js` 只匹配 title/body，**不匹配作者昵称** |
| 社员主页 | `profile/get` 的 where 条件含 `identityMode: 'named'` |
| 管理台队列 | 只返回 `isAnonymous` 布尔标记，不返回 `ownerId` |
| 通知文案 | 中性文案，不含正文与身份 |

### 自动检测

```js
// 开发环境每次返回 DTO 前自检
if (process.env.NODE_ENV !== 'production') assertNoIdentityLeak(dto);
```

`assertNoIdentityLeak` 会递归扫描，发现 `ownerId` / `wxOpenIdRef` / `aliasKey` /
`reporterId`，或匿名作者带非 null `userId`，立即抛错。
生产环境跳过以省开销，但单测中有对应用例（`tests/policies.test.mjs`）。

### 受控揭示

```js
canRevealAnonymousMapping(viewer, { reason }) {
  return viewer.isModerator && reason.trim().length >= 10;
}
```

`admin/anonymous/reveal` 还会**先写审计日志再返回数据** ——
审计写失败则整个请求失败，不存在"查了但没留痕"的可能。

### 诚实的局限

本设计**无法消除**通过具体经历、地名、班级、画面、文风、线下交流猜到作者的风险。
前端文案必须体现这一点，**禁止**出现"绝对匿名""无法追踪""绝不会被认出"。

## 5.6 私密内容：管理员也不可读

```js
canReadPost:  visibility === private → 仅 isOwner
canReadPrivateNoteOfOthers() → 恒为 false
```

额外防线：
- `canListPost` 排除 private → 不进任何聚合入口
- `admin/content/decide` 遇 private 直接 `forbidden` → 管理台不是侧门
- `admin/queue` 的 content 队列 where 条件含 `visibility: _.in([public, club])`
- 搜索的 `where` 从不包含 private

## 5.7 越权防线对照表

| 入口 | 不允许出现的漏洞 | 本仓库的防护 |
|---|---|---|
| 信息流/话题/主页 | 私密或匿名历史被夹带在列表、总数中 | `buildFeedWhere` 条件下推 + `canListPost` 二次复核 |
| 搜索 | 正文隐藏但摘要泄露 | 权限条件进 where；不匹配作者昵称；正则转义 |
| 收藏 | 原文收回后仍显示旧摘要 | `me/contents?tab=bookmark` 逐条复核，失效返回占位无摘要 |
| 通知 | 旧通知残留敏感内容 | 渲染前 `canReadPost` 复核，失效替换中性文案 |
| 媒体 | 拿到 URL 绕过帖子权限 | 私有桶 + 仅 verified 生成限时链接 + `permissionVersion` |
| 管理/导出 | 运营"一键看所有私密" | private 进管理接口即 forbidden；导出仅本人 |
| 幂等键 | 重放他人请求 | `_id` 含 `userId`，跨用户不可命中 |
| 附件挂接 | 用他人 fileId 组装内容 | `posts/create` 校验 `asset.ownerId === viewer.userId` |
| 评论跨帖 | `replyToId` 指向其他帖子 | 校验 `parent.postId === id` |
| 文集扩范围 | 收录把社内帖变公开 | `canIncludeInCollection` 取交集 |

## 5.8 Code Review 必过清单

- [ ] 新增 domain 函数第一步就调 `policies.*`，不内联判权
- [ ] 列表查询的权限条件在 `where` 里，不在内存过滤
- [ ] 不读 `payload` 中的任何身份字段
- [ ] DTO 用 `presenters.*` 构造，不 spread 数据库文档
- [ ] 状态流转用 `db.updateWithVersion`，带 `expectedVersion`
- [ ] 无权与不存在都用 `errors.notAccessible()`，文案不区分
- [ ] 日志用 `scrubForLog()`，不含正文/openid/映射
- [ ] 新增 `visibility` / `role` / `status` 枚举时，先在 `tests/policies.test.mjs` 加用例
- [ ] 管理接口不修改 `visibility`
- [ ] `npm test` 与 `npm run check` 全绿
