# Admin governance execution ledger

Plan: docs/plans/2026-10-03-admin-governance-implementation.md
Baselines: backend 2d74c01; frontend aa4d2ad.

- Setup: two explicit worktrees created via Git fallback after native tool returned Not a git repository for the entry directory.
- Ruling: Web assets live in backend admin-web/ and are served same-origin under /admin/, so no separate deploy or CORS credential bridge is needed.
- Ruling: clubs without an existing primary retain every manager role and require explicit primary bootstrap from existing moderators; migration will not arbitrarily choose or demote managers.
- Task 1: complete — migration25、邀请码/换届/恢复事务及PG业务回归已提交。
- Task 2: complete — migration26、Web鉴权、API、容器资源和任务提醒已提交。
- Task 3: complete — Web工作台、小程序账号确认入口和管理页面已实现并验证。
- Task 4: complete —集成审查发现的问题均已修复；前后端check/lint/test、14项真实PG集成测试、全量26迁移、配对契约及浏览器/开发者工具验证通过。

Evidence: docs/evidence/2026-10-03-admin-governance/README.md。

验收环境是loopback隔离PostgreSQL和合成身份，业务SQL/API真实；不代表真实微信身份、相机、真机或线上部署。默认前端profile已恢复nasProduction，本次开发者工具测试替身已撤销。仅保留两个独立开发工作树，主仓和远程未变。

关键业务裁定：换届提交完整团队并一次接受；恢复默认仅保留目标负责人，完成时旧管理团队降权。旧定向码全部撤销，保留申请码移交新任期；过期预留释放。本人接受与平台复核均检查工单有效期。
