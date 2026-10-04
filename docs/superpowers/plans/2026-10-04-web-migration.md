# 网站迁移 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task in this session.

**Goal:** 复用现有业务，实现独立于小程序的响应式网站与账号密码登录。
**Architecture:** 成员网页和管理网页由现有 Node 同域提供；Cookie 身份接原 action router，复用 PostgreSQL 权限及 DTO。
**Tech Stack:** Node >=20、浏览器 ES modules、CSS、PostgreSQL、node:test。
**Spec:** docs/superpowers/specs/2026-10-04-web-migration-design.md

## Global Constraints
- 匿名 DTO 不含作者 ID；成员资格每次请求重新查；私密内容不进入聚合入口。
- 密码 10–128 字符，scrypt 随机盐；Cookie HttpOnly / SameSite=Lax，生产 Secure。
- 固定 Origin + CSRF；7 天绝对 / 24 小时闲置会话期限；注册不能提权或绑定旧用户。
- 人工审核不自动放行；未接图片检查时不允许网站上传；不持久保存正文草稿。

## Review Focus
- 快速切换社团或详情时旧请求不得覆盖当前页面。
- 匿名/正文含 HTML 必须转义；媒体 URL 仅允许 HTTP(S)。
- 重试发布不得多发；重复点击期间按钮禁用。
- 账号删除、改密、退出后会话必须失效。
- 网站管理员仍受原管理角色与实时权限限制。

### Task 1: 账号与会话
Files: server/web-auth.js, cloudbase/migrations/20261004090000_web_accounts.sql, tests/web-auth.test.mjs, tests/integration/web-migration-pg.test.mjs.
Interfaces: createWebAuth({database, origin}) → register/login/resolveSession/revokeSession/changePassword/provisionAccount，session {identity, csrfToken, sessionToken, origin, userId}。
- [x] 写散列、Origin、Cookie、限频与真实数据库账号测试，运行确认缺少实现时失败。
- [x] 实现 scrypt、原子注册和限频、Cookie 会话及增量表；用数据库 CTE 保证用户/凭据和改密/撤销原子性。
- [x] 运行单测与 PostgreSQL 集成验证。

### Task 2: HTTP 与迁移运行
Files: server/web-http.js, server/index.js, server/config.js, scripts/local-web-account.mjs, deploy/web/*, tests/web-http.test.mjs.
Interfaces: createWebHttp({auth, actionHandler}) → handle(req,res,pathname,requestId): boolean；浏览器 POST /v1/web/auth/{register,login,password,logout}, GET /v1/web/session, POST /v1/web/action。
- [x] 写 HTTP 契约与 CSRF/Origin/身份伪造测试并验证失败。
- [x] 挂同域入口、静态白名单和管理台会话桥接；手工审核模式无需微信 secret。
- [x] 增加已有账号凭据 CLI、迁移清单计数和独立 Compose。
- [x] 验证网站和原小程序测试均通过。

### Task 3: 成员网页
Files: web/index.html, web/styles.css, web/core.mjs, web/api.mjs, web/app.mjs, web/views.mjs, web/flows.mjs, admin-web/api.js, admin-web/app.js.
Interfaces: createApi → session/action/auth；视图基于服务端 DTO；导航 scope 用 sequence + clubId 丢弃旧响应。
- [x] 写浏览器 API、XSS、scope、幂等行为测试并验证失败。
- [x] 实现所有设计列明的成员流程；管理台网站登录入口保持历史二维码方式可用。
- [x] 手机和桌面浏览器真实检查，修复可访问性和溢出问题。

### Task 4: 验证与交付
Files: docs/web-migration.md, README.md, docs/evidence/2026-10-04-web/*.
- [x] 运行 npm test、npm run check、npm run lint、PostgreSQL 集成与浏览器 E2E。
- [x] 最后独立代码审查并修复重要问题。
- [x] 写运行、增量迁移、初始管理员、旧账号绑定、HTTPS/备份及尚需外部配置的说明。
- [x] 提交本地分支，不自动部署或覆盖原分支。

## 验收结果（2026-10-04）

- 全套单测 226 通过、2 个已有可选数据库用例跳过；独立网站 PostgreSQL 联调 2/2 通过。
- npm run check、npm run lint 通过，原小程序 99 个引用动作无接口漂移。
- 手机和桌面真实浏览器验收通过，无 JavaScript 错误或手机横向溢出。
- 独立代码审查发现的 4 个重要问题均有回归测试并修复，复核无新增重要问题。
- 实际 Compose 初始化和访问验证通过：27 个迁移账本、普通用户运行、反代来源、Cookie 与 worker。
- 生产数据库未改动；本地截图与容器记录见 docs/evidence/2026-10-04-web/。
