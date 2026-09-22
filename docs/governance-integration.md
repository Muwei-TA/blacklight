# 成员治理、申诉与运营熔断集成契约

本分支新增 `cloudfunctions/api/domain/governance.js` 和独立迁移
`cloudbase/migrations/20260922170000_governance.sql`。主 Agent 集成时把下列
action 挂到 `api/index.js`；本分支按要求没有改路由表、常量、session 或 presenters。

## Action 契约

| action | payload | 成功结果 | 约束 |
| --- | --- | --- | --- |
| `admin/member/remove` | `{ targetUserId, expectedVersion, reason }` | `{ ok, targetUserId, version, status }` | active moderator；不能操作自己；不能移除最后一个 active moderator |
| `admin/member/mute` | `{ targetUserId, expectedVersion, mutedUntil, reason }` | `{ ok, targetUserId, version, mutedUntil }` | `mutedUntil` 为未来 ISO 时间；传 `null` 明确解除禁言 |
| `admin/member/role` | `{ targetUserId, expectedVersion, role, reason }` | `{ ok, targetUserId, version, role }` | role 为 `member/moderator/admin`；不能自提权；降级/移除最后 moderator 被拒 |
| `appeals/create` | `{ postId, contentVersion?, reason }` | `{ ok, appealId, state: "submitted", version: 1 }` | 只能作者对 `hidden`/`rejected` 内容发起；同内容同版本一条 |
| `appeals/mine` | `{ limit? }` | `{ ok, items: AppealDTO[] }` | 仅返回当前作者自己的申诉字段；不返回帖子正文、标题或举报人 |
| `admin/appeals/list` | `{ limit? }` | `{ ok, items: AppealDTO[] }` | moderator/admin；队列只返回理由、状态、申诉/帖子 ID 与版本 |
| `admin/appeal/decide` | `{ appealId, expectedVersion, decision, reason }` | `{ ok, appealId, status, postStatus, reviewTaskId?, version }` | moderator/admin；决定理由必填；批准进入带新版本的再次审核；并发版本冲突拒绝 |

`AppealDTO` 只包含 `appealId`、`postId`、`contentVersion`、`status`、`reason`、
`decision`、`decisionReason`、`version`、`createdAt` 和 `updatedAt`。领域层和
RPC 层都使用字段白名单，避免私密原文或作者身份从管理队列泄露。

客户端传来的 `targetUserId` 只是被操作对象。审计和 RPC 的 `p_actor_id` 始终来自 `ctx.viewer.userId`；不接受 payload 的 `userId` 作为调用者身份。

## 原子性与隐私

成员变更、申诉状态、目标帖子状态、`hg_audit_logs` 和作者通知由
`hg_governance` 在同一 PostgreSQL 事务中完成。RPC 内部重新读取并校验 active
membership、角色、目标版本及最后 moderator 约束，因此不能通过绕过云函数直接调用
来伪造 moderator 身份。部署迁移后只授予 `service_role` 执行权限，`anon` 与
`authenticated` 无表和 RPC 权限。

通知只发送给被操作成员或申诉作者，内容只包含处理理由与结果，不含举报人、举报记录或匿名映射。申诉记录保留 `postId`、作者、内容版本、理由、状态、决定人和决定理由，便于运营追踪。

申诉批准会把 `hidden`/`rejected` 内容改为新版本的 `pending`，并在同一事务中创建
带 `postVersion` 的 `hg_review_tasks` 记录。只有新的自动安全审核通过后，worker 才能
把内容变为 `published`；申诉决定本身不会绕过审核。

## 熔断能力

`shared/policies.js` 增加 `canUsePublishing(viewer, capabilities)` 与
`canUseUploads(viewer, capabilities)`，两者在成员资格、禁言和对应能力字段任一缺失时均拒绝。`canCreatePost` 与 `canComment` 会检查
`viewer.mutedUntil`；session 注入该字段后，移除成员和禁言会在下一次请求实时生效。

现有 `posts`/`assets` 域已经读取 `capabilities.publishing` 与
`capabilities.uploads`，主 Agent 集成时应将局部判断统一改为上述策略谓词，并保持
默认值 `publishing: true`、`uploads: false` 的 fail-closed 行为。开启上传前仍需完成
真实媒体校验与存储验收。

## 部署前检查

```bash
npm test
npm run check
npm run lint
```

主 Agent 还需：

1. 部署 `20260922170000_governance.sql`，回读 `hg_appeals` 表、唯一索引、RPC 权限与函数定义。
2. 将 action 映射到 `api/index.js`，并在前端契约登记。
3. session 把 `membership.mutedUntil` 注入 `buildViewer`，验证发帖和评论在禁言期间均返回 `forbidden`。
4. 用两个 moderator 并发移除同一成员、并发提交同一申诉，确认只有一个成功且审计/通知不重复；成员变更在统一 advisory lock 下读取 actor。
5. 验证移除成员下一次请求立即失去成员权限，并验证最后一个 moderator 不能被移除或降级。

本分支没有部署迁移、调用真实 RPC 或连接真实微信身份；这些是集成验收证据，不由本地单测替代。
