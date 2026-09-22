# CloudBase 开发计划与证据

目标：依据双仓工程书与 2026-09-22 上线评估，完成可验收的小程序。

## 已核验现场
- 前端 main: 21d094f；后端 main: dab4a63；原 shudong 工作区连接官方模板且有用户改动，保持原样。
- 使用 `/Users/muwei/WeChatProjects/blacklight-development` 中两个独立仓库；每项编码任务独立 Git worktree。
- 用户要求使用 save-my-astra：本任务主 Agent 负责架构与集成，Luna/max 子 Agent `fork_turns:none`，不修改全局模型或用户 AGENTS。
- 环境：shudong-d4g4blap4a5069a28 / ap-shanghai，PostgreSQL 已开通，NoSQL 未开通；用户明确选择适配 PostgreSQL。
- 微信 AppID：wx39773ed34aa30776；环境微信关联尚待小程序调用验证。

## 工作分配
1. frontend-transport / codex/cloudbase-transport：T-17 传输与会话。
2. frontend-membership / codex/membership-pages：T-11 入社/社团，T-12b 约定。
3. backend-worker / codex/review-recovery：R-03/R-06/R-07 来源、租约与清理。
4. 主 Agent / codex/cloudbase-integration：PG 迁移/事务、跨仓契约、部署与实际验收。

## 里程碑
- [进行中] M0/M1：PG 持久化与 wx.cloud 身份，入社 → 文字发布 → 审核 → 展示。
- [待完成] M2：管理队列/举报/成员治理，评论互动、自己的内容。
- [待完成] M3：图片上传授权/校验/隐私/链接续期与清理。
- [待完成] M4：保留业务页面；公开/视频/导出保持关闭。
- [待完成] M5：真实账号、模拟器、真机与运营发布证据。

数据库仅云函数访问，客户端对表与业务 RPC 均无权限；PG JSONB 保存现有领域 DTO，唯一约束与事务提供一致性。不是将 NoSQL SDK 指向不存在的 NoSQL 实例。

本文件区分代码完成与云端/真机验收。不得将部署成功或单元测试成功写成整体验收完成。
