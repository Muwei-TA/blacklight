# 网站迁移验收 · 2026-10-04

源分支：前端 `codex/admin-governance-20261003` (`90e84df`)、后端同名分支 (`16ce74d`)。交付分支 `codex/web-migration-20261004`，原小程序代码作为业务与接口对照。

| 验证 | 结果 |
| --- | --- |
| `npm test` | 228 用例：226 通过、2 个已有可选 PostgreSQL 限频测试跳过，0 失败 |
| `npm run check` | 语法、架构、DTO、路由、云函数通过；前端引用 99 / 后端实现 100，漂移 0 |
| `npm run lint` | 通过 |
| `tests/integration/web-migration-pg.test.mjs` | 独立 PostgreSQL：2/2 通过，覆盖真实账号/入社/匿名/私密/审核/管理台/改密和并发 |
| `tests/web-review-regressions.test.mjs` | 5/5 通过，已包含在全套单测 |
| `tests/browser/web-smoke.mjs` | 桌面、手机 7 组验收通过，无 JS 错误和横向溢出，见 browser-results.json |
| Docker 应用与 PG 镜像 | 均构建成功，应用由 UID 1000 运行 |
| 全新 Compose 数据库和服务 | 27 个 checksum 迁移、普通用户静态读取、网站和管理台访问、注册与 Cookie、实际代理来源限频、worker 启动通过，见 container-results.json |

独立审查发现的代理限频共用、评论分页丢回复、二级回复入口和恢复确认状态四个问题均已修复，复核没有新增重要问题。文集作品选择遍历所有游标页，说明字数对齐后端。容器实测发现并修复了限制性文件权限与内部网络阻止端口发布；数据库不再挂载完整源码仓库，API 使用单独接入网络，数据库与 worker 保留内部网络。

截图使用隔离数据库的虚构内容：desktop-home.png、mobile-home.png、desktop-admin.png。测试账号、密码和运行环境均非生产。生产数据库迁移、公网域名/HTTPS 部署和真实第三方图片审核未在本次执行。人工审核模式不开放新增图片或视频；旧账号需运维核实身份后绑定。完整运行与增量迁移说明见 ../../web-migration.md。
