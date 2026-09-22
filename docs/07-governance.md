# 07｜内容治理

## 7.1 内容状态机

```text
draft（客户端本地，不入库）
  │ posts/create
  ▼
uploading ─────────┐（有附件且未全部 verified）
  │                │
  ▼                ▼
pending ──────► 审核任务
  │  ├─ 文本/图片检查通过 ──────────► published
  │  ├─ 存疑 ───────► manual（人工）─► published 或 rejected
  │  └─ 检查失败/超时 ─► 保持 pending，重试 5 次后 manual
  │
published
  ├─ 举报核查 ──► hidden ──► 申诉复核 ──► published 或维持
  ├─ 作者缩小范围（visibility 变更，status 不变）
  └─ 作者删除 ──► deleted

rejected ──► 作者修改后重新提交 ──► pending（旧版本 superseded）

private ──► 直接 published（不走审核；仅本人可见）
```

**关键点**

1. `private` 内容不进审核流程 —— 它不对外展示。但存储与必要的安全处理另行最小化设计。
2. `rejected` **保留原记录**，作者取消编辑不会丢内容（前端 P10 可查看理由并重新编辑）。
3. 审核失败不删除内容，只是保持不可公开。
4. 评论、话题名、昵称、头像、附件与修改后的新版本同样纳入相应流程。

## 7.2 状态流转的并发保护

所有状态变更走 `db.updateWithVersion`：

```js
await coll.where({ _id: id, version: expectedVersion }).update({
  data: { ...data, version: expectedVersion + 1 }
});
if (res.stats.updated === 0) throw conflict('内容已被更新，请刷新后重试');
```

因此：
- 两个管理员同时处理同一条内容 → 后者抛 `conflict`
- 重复提交同一决定 → 幂等（第二次抛 `conflict`，不产生二次副作用）
- worker 与管理员并发 → 同样由版本锁保护

**防旧覆盖新**：`worker/tasks/review.js` 会检查
`task.postVersion !== post.version` → 作废旧任务，不覆盖新版本的审核结果。

## 7.3 举报与申诉

```text
用户举报（reports/create）
  → 回执通知（文案：举报不等于认定违规）
  → hg_reports.status = received
  → 管理员在 report 队列核查
  → decision: keep（维持）/ hide（隐藏）/ escalate（升级）
  → 写审计日志
  → 告知被举报内容的作者（含理由 + 申诉提示）
  → 举报人身份全程不暴露
```

**规则**

| 规则 | 实现 |
|---|---|
| 被举报次数 ≠ 违规事实 | 无自动隐藏逻辑，必须人工决定 |
| 风险极高时可先隐藏等待核查 | `decision: 'hide'` 属临时措施，与最终认定区分 |
| 处理理由不含举报人身份 | `decideReport` 只写 `reason`，不写 `reporterId` |
| 恶意重复举报 | `checkRateLimit` 限频，但**不关闭正常举报通道** |
| 证据范围最小化 | 管理员只看被举报内容本身，不能顺便打开作者的私密手记 |

**未实现**：申诉提交接口。当前通知文案提示"可以申诉"，
但用户只能通过联系运营者线下反馈。属任务 T-B10。

## 7.4 审计日志

所有以下操作**必须**写 `hg_audit_logs`：

| 操作 | action 值 |
|---|---|
| 内容审核决定 | `content.approve` / `content.reject` / `content.hide` |
| 话题决定 | `topic.approve` / `topic.archive` / `topic.reject` |
| 入社决定 | `membership.approve` / `membership.reject` |
| 举报处理 | `report.keep` / `report.hide` / `report.escalate` |
| 文集收录 | `collection.include` / `collection.skip` |
| **匿名映射查询** | `anonymous.reveal` ← 最敏感 |
| 撤回文集授权 | `consent.revoke` |
| 导出申请 | `export.request` |
| 注销申请与执行 | `account.deletion_request` / `account.deletion_executed` |

```js
// shared/db.js writeAudit() 故意向上抛异常
.catch((err) => { throw err; });
```

**审计写入失败会让整个请求失败**，而不是静默跳过。
`admin/anonymous/reveal` 更进一步：先写审计再返回数据，
不存在"查了但没留痕"的可能。

审计日志**不存原始私密正文**，只存 ID、决定与理由。

## 7.5 版权与授权

| 规则 | 实现 |
|---|---|
| 上传不自动转移权利 | `hg_consents` 记录的是**展示授权**，不是版权转让 |
| 授权与用途绑定 | `purpose: 'collection_display'`，不写"任意使用" |
| 授权与版本绑定 | `version` 字段记录用户同意的授权文本版本 |
| 可撤回 | `consents/revoke` → `revokedAt` + 目录移除 |
| 公开宣传/印刷/商业使用 | **需另行授权**，当前无对应 purpose |
| 范围取交集 | `canIncludeInCollection` 强制校验 |

**历史内容迁移原则**（运营事项，非代码）：
迁结构不默认迁隐私。先整理话题目录，再邀请原作者重新发布。
无法确认作者与授权的旧内容保留在原档案，不批量导入。
**匿名原文不通过编辑痕迹反查作者以便迁移。**

## 7.6 成员变动

| 事件 | 后端行为 |
|---|---|
| 退社 / 被移除 | `hg_memberships.status = removed` → 下次请求 `viewer.isMember = false` → 社内读写立即失效 |
| 作者退社后的历史内容 | 仍 `canReadPost`（`isOwner` 分支），可通过"我的数据"管理与删除 |
| 社团解散 / 换届 | 需权限回收与责任交接。**禁止一键公开社内帖** |
| 管理员离任 | 手动改 `role`，并在审计日志中留痕 |

**未实现**：成员移除/禁言/角色调整的管理接口。
首版由运营在 CloudBase 控制台直接改 `hg_memberships` 文档。
风险：控制台操作不产生审计日志。属任务 T-B11。

## 7.7 注销与数据保留

```text
me/account/delete（需输入"注销"二次确认）
  → users.status = deletion_requested
  → 写审计日志
  → 返回 { state: 'pending' } ← 绝不返回虚假的"已完成"
  → 7 天宽限期
  → worker cleanup.processAccountDeletions()：
      1. 全部内容 status = deleted（停止展示）
      2. 成员资格 removed
      3. 清理可识别资料（openid/昵称/头像），保留文档维持外键完整
      4. 删除匿名映射 ← 注销后不应再能反查其匿名历史
      5. 写审计日志 account.deletion_executed
```

**保留策略**（必须先写入隐私说明才能执行）：

| 数据 | 处理 |
|---|---|
| 内容与媒体 | 停止展示；媒体文件物理删除 |
| 个人资料 | 清空，`displayName` 改为「已注销成员」 |
| 匿名映射 | 删除 |
| 审计日志 | **保留**（依法必要），但与身份解除关联 |
| 他人的评论 | 保留（属他人表达），但不显示已注销者的昵称 |

**撤回文集授权不需要注销账号** —— 这是独立入口（`consents/revoke`）。

## 7.8 规则版本

`hg_club_config.rulesVersion` 记录当前社区约定版本。
入社申请时记录用户同意的版本（`hg_membership_applications.rulesVersion`）。

规则更新时：
1. 递增 `rulesVersion`
2. 通过 `system_notice` 通知全体成员，含变更摘要
3. 重大变更按实际要求重新告知

**不得混淆三层规则**：社团约定 / 平台要求 / 法律义务。前端 P16 需分层展示。

## 7.9 运营值守

后端能做的：
- 审核任务堆积可查（`hg_review_tasks` 中 `status = queued/manual` 的数量）
- 举报待处理可查（`hg_reports` 中 `status = received`）

后端**不能替代**的（运营事项）：
- 内容审核、举报升级、账号异常、权限/隐私事件的责任人与备用联系人
- 夜间/假期的处理时限

**无人值守时应收紧发布**：可临时把 `capabilities` 全部关闭，
或提高审核门槛，但**不能静默丢弃已有的紧急举报**。
前端不得展示"马上处理""全天候守护"这类承诺。
