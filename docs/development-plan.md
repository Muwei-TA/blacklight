# CloudBase 开发计划与证据

> 状态说明（2026-09-23）：本页保留 2026-09-22 的计划与分工快照；当前真实验收状态以 [CloudBase 开发环境与验收记录](cloudbase-development.md) 和前端 [CloudBase 真实验收记录](../../frontend/docs/cloudbase-acceptance.md) 为准。计划中的“完成”不等于真机或上线验收完成。

目标：依据双仓工程书与 2026-09-22 上线评估，完成可验收的小程序。

## 当前状态（2026-09-23）

- 真实微信文字安全 API 与最新 `admin/security/check` 均返回通过；单独 SCF timer 仍返回 `-501001`，后台重试失败保持待审并在达到上限后转人工。
- 已核验文字内容 `df912774-fe9c-4e31-b74d-412d02db3ff1` 为 `published`、v2；原生 UI 输入的回应 `b8ba47e4-22b2-4a58-95ee-7d495f52685a` 已由数据库证实为 `published`。
- PG 图片资产 `bd740f16-d05e-447f-8704-72bef2d5bf8d` 已为 `verified`，清洗结果为 48×48、675 字节 JPEG；图文内容 `d93b0b67-5893-4202-879f-de9e5773a867` 已为 `published`、v2；匿名作者响应中的 `userId` 与 `displayName` 均为 `null`。
- `wx.getImageInfo` 仍被合法域名拦截；已请求将 `https://shudong-d4g4blap4a5069a28.api.tcloudbasegateway.com` 加入 `downloadFile` 合法域名，等待用户回执。
- PG 12 项迁移已应用到远端。后端 111 项测试及 lint/check、前端 8 项测试及 lint/check 均已通过；当前 22 个页面 pending 为 0。
- 真机、微信审核与上线尚未执行；公开、视频、文集、导出能力继续关闭。

## 已核验现场
- 前端 main: 21d094f；后端 main: dab4a63；原 shudong 工作区连接官方模板且有用户改动，保持原样。
- 使用 `/Users/muwei/WeChatProjects/blacklight-development` 中两个独立仓库；每项编码任务独立 Git worktree。
- 用户要求使用 save-my-astra：本任务主 Agent 负责架构与集成，Luna/max 子 Agent `fork_turns:none`，不修改全局模型或用户 AGENTS。
- 环境：shudong-d4g4blap4a5069a28 / ap-shanghai，PostgreSQL 已开通，NoSQL 未开通；用户明确选择适配 PostgreSQL。
- 微信 AppID：wx39773ed34aa30776；真实 `wx.cloud` 调用已核验，图片预览仍受合法域名白名单限制。

## 工作分配（历史快照）
1. frontend-transport / codex/cloudbase-transport：T-17 传输与会话。
2. frontend-membership / codex/membership-pages：T-11 入社/社团，T-12b 约定。
3. backend-worker / codex/review-recovery：R-03/R-06/R-07 来源、租约与清理。
4. 主 Agent / codex/cloudbase-integration：PG 迁移/事务、跨仓契约、部署与实际验收。

## 里程碑（按当前证据更新）
- [部分完成] M0/M1：PG 持久化、wx.cloud 身份、文字安全、文字发布与回应已取得真实证据；timer token 问题仍限制后台自动审核闭环。
- [部分完成] M2：原生 UI 回应已落库并发布；管理队列、举报、成员治理的完整运营验收仍待补齐。
- [部分完成] M3：PG 图片资产已清洗、审核并绑定已发布图文；图片预览域名白名单与链接/清理的完整客户端验收仍待完成。
- [保持关闭] M4：公开、视频、文集、导出保持关闭。
- [未验收] M5：真机、真实账号扩展、微信审核与上线发布证据。

数据库仅云函数访问，客户端对表与业务 RPC 均无权限；PG JSONB 保存现有领域 DTO，唯一约束与事务提供一致性。不是将 NoSQL SDK 指向不存在的 NoSQL 实例。

本文件区分代码完成与云端/真机验收。不得将部署成功或单元测试成功写成整体验收完成。

## 实际验证进展
- PostgreSQL 12 项迁移已应用到远端；业务表与 RPC 仍由服务端访问，客户端不获得表权限。
- 真实微信文字安全 API 调用通过；`df912774-fe9c-4e31-b74d-412d02db3ff1` 已为 `published`、v2。
- 原生 UI 输入回应 `b8ba47e4-22b2-4a58-95ee-7d495f52685a` 已由数据库证实为 `published`。
- 真实页面回应截图已保存为前端 `docs/evidence/published-comment.jpg`，回应计数为 1。
- 私密内容 `0c0f9e22-7a04-41f8-87fe-ce89a83ec428` 真实微信创建结果为 `private_saved`；管理调用伪造 owner 读取仍返回 `not_accessible`。
- PG 图片资产 `bd740f16-d05e-447f-8704-72bef2d5bf8d` 已 `verified`，清洗 JPEG 为 48×48、675 字节；图文内容 `d93b0b67-5893-4202-879f-de9e5773a867` 已 `published`、v2，匿名作者 `userId/displayName` 均为 `null`。
- 前台本人审核已复用租约/RPC 并完成验证；timer 仍为 `-501001`，后台重试失败保持待审，达到上限转人工，不能记为后台自动审核通过。
- `wx.getImageInfo` 被 `downloadFile` 合法域名拦截；待用户确认加入 `https://shudong-d4g4blap4a5069a28.api.tcloudbasegateway.com` 后再复验图片预览。
- 后端 111 项测试与 lint/check、API actions 56、前端 8 项测试与 lint/check 均通过；22 个页面 pending 为 0。
- 开发预览码已生成，包总大小 1,371,384 bytes、主包 1,166,399 bytes；`preview-20260923.jpg` 仅作开发预览，未作为正式上传或发布证据。

## 最小后续动作

1. 等待并确认图片下载域名白名单更新，然后复验 `wx.getImageInfo` 与图片展示。
2. 另行处理 timer 的微信 OpenAPI token/权限问题；在此之前保留待审/人工队列边界。
3. 在真实设备完成输入、图片展示、回应与返回栈验收后，再评估上线；当前不开放公开、视频、文集、导出。
