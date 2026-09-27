> 当前交接：[2026-09-23 开发交接](HANDOFF-2026-09-23.md)。

# 黑光文学社 · 树洞｜后端开发工程书

> 2026-09-23：本分支已适配 PostgreSQL 与 PG 私有存储，真实部署和验收记录见 [CloudBase 开发环境](cloudbase-development.md)。下方原始工程书中的 NoSQL 集合与历史交付状态是开发基线，当前数据库结构以 `cloudbase/migrations/` 为准。

本目录是「黑光文学社树洞」微信小程序**后端**的开发交接工程书，供后端编程智能体使用。

- 技术路线：**微信云开发 CloudBase**（云函数 + 云数据库 + 云存储）
- 前端仓库：`D:\Github\shudong`（原生小程序 + TDesign），其工程书在该仓库 `docs/`
- 契约来源：前端 `docs/04-data-model-and-api.md` 与 `docs/05-permission-privacy.md`
  是**共享契约**。本仓库是其服务端实现，字段与枚举不得单方面变更。

## 文档索引（建议按序阅读）

| 编号 | 文件 | 内容 | 必读 |
|---|---|---|---|
| 00 | `README.md` | 索引、协作规则、交付状态 | ✅ |
| 01 | `01-decisions.md` | 技术选型决策记录、边界、G0 阻断项 | ✅ |
| 02 | `02-architecture.md` | 分层、目录、shared 同步机制、编码规范 | ✅ |
| 03 | `03-data-model.md` | 22 个业务表的字段、索引、权限设置 | ✅ |
| 04 | `04-api-contract.md` | 64 个 action 的入参、返回、错误码 | ✅ |
| 05 | `05-authorization.md` | 鉴权实现、越权防线、匿名隔离 | ✅ **最高优先级** |
| 06 | `06-media-pipeline.md` | 上传链路、内容审核、回调、撤权窗口 | |
| 07 | `07-governance.md` | 状态机、举报申诉、审计、注销与保留 | |
| 08 | `08-operations.md` | 环境变量、日志脱敏、监控、成本护栏 | |
| 09 | `09-testing.md` | 测试策略、越权验收用例、手工验收清单 | ✅ |
| 10 | `10-deployment.md` | 初始化、部署、回滚、G0 检查单 | |
| 11 | `11-task-board.md` | 并行任务分解（ID、依赖、DoD） | ✅ |

## 当前交付状态

**已实现（可运行的骨架 + 一条完整纵向用例）**

| 模块 | 文件 | 状态 |
|---|---|---|
| 权限策略（唯一实现） | `shared/policies.js` | ✅ 纯函数 + 37 个单测 |
| 错误类型与映射 | `shared/errors.js` | ✅ |
| 入参校验 | `shared/validators.js` | ✅ + 18 个单测 |
| DTO 白名单构造 | `shared/presenters.js` | ✅ 含匿名隔离 |
| 匿名别名派生与泄露检测 | `shared/anonymity.js` | ✅ HMAC 派生 |
| 数据访问（游标/幂等/审计） | `shared/db.js` | ✅ |
| 会话与成员资格 | `shared/session.js` | ✅ 实时查询，不缓存 |
| 云函数路由 | `shared/router.js` | ✅ 统一错误 + 日志脱敏 |
| 内容用例（纵向参考） | `cloudfunctions/api/domain/posts.js` | ✅ 发布/详情/互动/范围/删除 |
| 话题 / 文集 / 通知 / 搜索 / 媒体 / 管理台 | `cloudfunctions/api/domain/*.js` | ✅ 主流程 |
| 后台任务 | `cloudfunctions/worker/tasks/*.js` | ✅ 审核/图片/聚合/清理 |
| 审核回调 | `cloudfunctions/review-callback/` | ✅ 验签/去重/防旧覆盖新 |
| 初始化与部署脚本 | `scripts/*.mjs` | ✅ |
| 用量护栏 T-B09 | `cloudbase/migrations/*_usage_quotas.sql`、`shared/usage.js`、`worker/tasks/usage.js` | ✅ 本地实现；迁移与函数待部署验收 |

**未实现 / 需要真实环境才能完成**

- **视频转码与封面生成**：`worker/tasks/media.js` 只提交异步检查，
  转码需额外云服务，尚未接入 → 因此 `capabilities.video` 默认 `false`
- **微信内容安全接口未实测**：`msgSecCheck` / `imgSecCheck` / `mediaCheckAsync`
  的调用代码已写，但**本次没有在真实环境验证过**（属 G0 核验事项）
- 订阅消息推送、数据导出的实际文件生成、申诉工单流程
- 成员移除/禁言/角色调整的管理接口（首版由运营在控制台手动操作）

## 协作规则（对后端编程智能体）

1. **先读 01/05 再写代码**。`05-authorization.md` 的规则违反即 P0，不接受"先上线再修"。
2. **权限判断只有一处**：`shared/policies.js`。禁止在 domain/repository 里另写
   `if (visibility === 'club')` —— `npm run check` 会拦截。
3. **客户端身份不可信**：只用 `ctx.viewer`，禁止读 `payload.ownerId/userId/role/openid`。
4. **DTO 白名单构造**：`presenters.js` 中不允许 spread 整个数据库文档。
5. **新增 action 必须同步更新** `04-api-contract.md` 与前端 `docs/04`，否则视为契约破坏。
6. **不新增生产依赖**：云函数只依赖 `wx-server-sdk`。需要新依赖先在任务板申请。
7. **shared/ 单一真源在根目录**。`cloudfunctions/*/shared/` 是 `npm run sync` 生成的副本，
   已被 gitignore，**不要手动编辑副本**。
8. **fail-closed 原则**：能力开关读取失败按关闭处理；审核服务异常时内容保持不可公开。
9. 修改 `shared/*` 前在任务板登记 —— 它被所有云函数共享。

## 快速开始

```bash
npm install            # 仅 devDependencies（eslint/prettier），云函数依赖由 CloudBase 安装
npm test               # 55 个单测，权限规则必须全绿
npm run check          # 静态自检：语法 + 架构纪律 + DTO 安全 + 路由完整性
node scripts/db-init.mjs   # 打印集合、索引、权限与种子数据清单
npm run sync           # 同步 shared/ 到各云函数（部署前必做）
node scripts/deploy.mjs --env-id <envId>   # 前置检查 + 输出部署命令
```

## 交付边界

- 本工程书是设计与实现规格，**不构成法务合规结论**。上线前须完成 `01` 的 G0 核验。
- 单测全绿只证明权限规则的**逻辑**正确，不证明生产环境配置正确 ——
  集合权限、存储桶权限、环境变量必须按 `10-deployment.md` 逐项人工确认。
- 本次没有连接任何真实云环境，没有创建集合，没有部署函数。
