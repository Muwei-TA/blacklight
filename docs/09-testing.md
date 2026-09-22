# 09｜测试与验收

## 9.1 测试分层

| 层级 | 工具 | 覆盖范围 | 当前状态 |
|---|---|---|---|
| 单元测试 | `node --test`（零依赖） | 权限规则、校验、游标、DTO 隔离 | ✅ 55 个用例全绿 |
| 静态自检 | `scripts/check.mjs` | 语法、架构纪律、DTO 安全、路由完整性 | ✅ 全绿 |
| 集成测试 | 需真实云环境 | 端到端用例 | ❌ 未执行 |
| 越权渗透 | 需真实云环境 + 多账号 | `9.4` 清单 | ❌ 未执行 |

**为什么单测用 `node --test` 而非 Jest**：避免为测试引入生产之外的依赖，
且 `shared/policies.js` 被刻意设计为无 SDK 依赖的纯函数，原生测试器足够。

```bash
npm test        # 55 个用例
npm run check   # 静态自检
```

## 9.2 单元测试现状

**`tests/policies.test.mjs`（37 个）** —— 每个用例对应 `05-authorization.md` 的一条规则：

- 访客/成员/作者/管理员/moderator/被移除成员 六种视角
- 公开/社内/私密 三种范围
- published/pending/rejected/hidden/deleted 五种状态
- 范围只能缩小、管理员不能代改
- 能力开关 fail-closed（`undefined` / `{}` 都视为关闭）
- 未知 `visibility` 一律拒绝
- 匿名 DTO 的 `author.userId` 恒为 null
- 泄露检测能抓出 `ownerId` 与匿名带 userId
- 未审核媒体不返回可播放 url
- 他人看不到本人的待审状态文案

**`tests/validators.test.mjs`（18 个）** —— 限制值与游标：

- 各类字数/数量/大小/时长超限
- 仅自己内容不能关联话题、强制关闭回应
- 游标往返编解码、伪造游标被拒
- 分页大小夹紧
- 搜索词正则元字符转义

### 新增规则时的要求

**先加测试用例，再改实现。** 新增 `visibility` / `role` / `status` 枚举值时，
必须在 `tests/policies.test.mjs` 补对应的越权用例，否则 Review 不通过。

## 9.3 静态自检的五项

`scripts/check.mjs`：

1. **语法与编码**：`.js` 按 CJS、`.mjs` 按 ESM 分别 `node --check`；JSON 解析 + BOM 检测
2. **架构纪律**：policies 无 SDK 依赖、db 无权限判断、domain 不内联判权、不读 payload 身份字段
3. **DTO 安全**：presenters 不 spread 文档、不输出禁用字段
4. **路由完整性**：每个 action 都有对应的 domain 导出
5. **云函数完整性**：目录齐备、shared 引用路径正确

第 2 项是最有价值的：它把"权限判断只有一处"这条纪律变成了自动化检查，
而不是靠 Review 时人工发现。

## 9.4 越权验收清单（P0，需真实环境）

**任一项失败即停止相关能力并修复。** 需要准备三个账号：访客、普通成员、另一名成员。

### 读取边界

- [ ] 访客调 `posts/list` → 只有 `visibility = public` 的已发布内容
- [ ] 访客调 `posts/detail` 传社内帖 ID → `not_accessible`，响应体不含标题
- [ ] 访客调 `posts/detail` 传**不存在**的 ID → 返回**完全相同**的响应体
- [ ] 成员 A 调 `posts/detail` 传成员 B 的私密帖 ID → `not_accessible`
- [ ] 管理员调 `posts/detail` 传他人私密帖 ID → `not_accessible`
- [ ] 管理员调 `admin/content/decide` 传私密帖 → `forbidden`
- [ ] 三种账号用同一 cursor 调 `posts/list`，比较返回集合是允许集合的子集

### 搜索

- [ ] 成员 B 的私密帖含唯一词 `zzqqxx`，成员 A 搜该词 → 0 结果，无摘要
- [ ] 匿名帖作者真实昵称为「南枝」，搜「南枝」→ **不返回其匿名帖**
- [ ] 搜索词输入 `.*` → 不触发全表扫描（正则已转义）
- [ ] 访客搜索 → 只命中公开内容

### 匿名隔离

- [ ] 匿名帖的 `posts/detail` 响应中 `author.userId === null`
- [ ] 同一用户在同一帖内的多条评论 alias 一致
- [ ] 同一用户在**不同帖**的 alias 不同（跨帖不可串联）
- [ ] 匿名帖不出现在作者的 `profile/get` 结果中
- [ ] `admin/queue` 的 content 队列条目不含 `ownerId`
- [ ] 函数日志中搜索 `ownerId` → 只有 `[redacted]`
- [ ] 未配置 `ANON_ALIAS_SECRET` 时匿名发布报错（验证 fail-closed）

### 成员变动

- [ ] 成员 A 可读社内帖 → 把其 `memberships.status` 改为 `removed` →
      **下一次请求**立即 `not_accessible`（验证无缓存）
- [ ] 被移除的成员仍可读自己的历史内容
- [ ] 被移除的 admin 调 `admin/queue` → `forbidden`（role 已降级）

### 范围变更

- [ ] 公开帖改社内后，成员 B 刷新收藏列表 → 显示占位，**无旧摘要/封面**
- [ ] 尝试把社内帖改为公开 → `forbidden`
- [ ] 管理员尝试改他人帖范围 → `forbidden`
- [ ] 缩小范围后该帖从文集目录消失
- [ ] 记录限时链接的实际失效时间，写入验收文档（`06` 6.5 的残留风险）

### 媒体

- [ ] 用成员 B 的 `assetId` 调成员 A 的 `posts/create` → `forbidden`
- [ ] 用未 `verified` 的 assetId 发布 → `pending_media`
- [ ] 未通过审核的图片不出现在 DTO 的 `media.images` 中
- [ ] 直接访问私有桶 URL（无授权）→ 拒绝
- [ ] `capabilities.video = false` 时调 `assets/intent` 传 video → `forbidden`

### 管理与幂等

- [ ] 普通成员调 `admin/queue` → `forbidden`
- [ ] 普通成员调 `admin/anonymous/reveal` → `forbidden`
- [ ] moderator 调 `admin/anonymous/reveal` 传 5 字理由 → `forbidden`
- [ ] moderator 成功查询后，`hg_audit_logs` 中有对应记录
- [ ] 两个管理员并发处理同一条 → 后者 `conflict`
- [ ] 同一 `idempotencyKey` 提交两次 `posts/create` → 只产生一条内容
- [ ] 用他人 userId 构造幂等键 → 不命中（`_id` 含 userId）

## 9.5 发布可靠性验收

- [ ] 空内容、文章缺标题、字数超限、图片超量、混合媒体、视频超时长 → 各自明确报错
- [ ] 提交超时后用同一幂等键重试 → 只产生一条
- [ ] 附件上传中断 → 24h 后被 `cleanup` 清理
- [ ] 审核接口异常 → 内容保持 `pending`，重试 5 次后转 `manual`，**不误放行**
- [ ] `rejected` 内容的原文仍在库中（作者可修改重提）
- [ ] 迟到的审核回调不覆盖较新版本结果

## 9.6 治理流程验收

- [ ] 举报 → 回执通知 → 管理员核查 → 隐藏 → 作者收到理由与申诉提示
- [ ] 作者与管理员都查不到举报人身份
- [ ] 文集流程：投稿 → 授权记录 → 编辑收录 → 目录更新
- [ ] 撤回授权 → 目录同步移除
- [ ] 公开文集收录社内帖 → `forbidden`
- [ ] 注销申请 → 7 天后内容停止展示、匿名映射删除、审计日志保留

## 9.7 明确未覆盖

**本次没有执行**：

- 任何真实云环境的部署与调用
- 微信内容安全接口的实际调用（`msgSecCheck` / `imgSecCheck` / `mediaCheckAsync`）
- 真机端到端联调
- 恶意越权渗透测试
- 并发压测与索引性能验证
- 视频转码链路（未实现）
- 数据库权限设置的实际生效验证

**单测全绿只证明权限规则的逻辑正确**，不证明：
- 集合权限在控制台设对了
- 存储桶确实是私有的
- 环境变量确实配置了
- 索引确实创建了

这些必须按 `10-deployment.md` 的检查单逐项人工确认。
**代码里看不到漏洞，不等于生产环境安全。**
