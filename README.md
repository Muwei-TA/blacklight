# 黑光文学社 · 树洞｜后端

微信小程序「黑光文学社树洞」的后端，基于 **微信云开发 CloudBase**（云函数 + 云数据库 + 云存储）。

- 前端仓库：`D:\Github\shudong`（原生小程序 + TDesign）
- 产品主张：留一盏灯，给每一种表达。
- 当前状态：**可运行的骨架 + 一条完整纵向用例**，未连接真实云环境，未部署

## 这个后端最重要的一件事

**可见范围与匿名身份的隔离。** 其他都可以妥协，这个不行。

```text
shared/policies.js   ← 权限规则的唯一实现（纯函数，37 个单测）
```

所有"能否看见 / 能否操作"的判断都在这一个文件里。`npm run check`
会自动拦截在别处内联写 `visibility === 'club'` 这类判断。

三条不可违反的规则：

1. **客户端身份不可信**：openid 只能来自 `cloud.getWXContext()`，
   不接受 `payload` 传入的 `ownerId` / `role` / `isMember`。
2. **匿名内容的 `author.userId` 恒为 null**：客户端拼不出主页链接；
   别名由 `HMAC(threadId + userId)` 派生，线程内稳定、跨帖不可串联。
3. **列表查询先鉴权再查询**：权限条件下推到数据库 `where`，
   不是查出来再内存过滤 —— 否则总数与分页边界会泄露私密内容的存在。

## 开发工程书

完整交接文档在 [`docs/`](./docs/README.md)。开始写代码前至少读这四篇：

| 文档 | 为什么必读 |
|---|---|
| [`docs/01-decisions.md`](./docs/01-decisions.md) | 为什么选 CloudBase、能力开关、G0 上线阻断项 |
| [`docs/05-authorization.md`](./docs/05-authorization.md) | 鉴权实现与越权防线，违反即 P0 |
| [`docs/09-testing.md`](./docs/09-testing.md) | 越权验收清单，以及明确未覆盖的部分 |
| [`docs/11-task-board.md`](./docs/11-task-board.md) | 可领取的任务、DoD、共享文件登记 |

## 快速开始

```bash
npm install         # 仅 devDependencies；云函数依赖由 CloudBase 安装
npm test            # 55 个单测，权限规则必须全绿
npm run check       # 静态自检：语法 + 架构纪律 + DTO 安全 + 路由完整性
```

初始化与部署见 [`docs/10-deployment.md`](./docs/10-deployment.md)：

```bash
node scripts/db-init.mjs                    # 打印集合/索引/权限/种子清单
npm run sync                                # 同步 shared/ 到各云函数（部署前必做）
node scripts/deploy.mjs --env-id <envId>    # 前置检查 + 输出部署命令
```

## 目录结构

```text
shared/                  单一真源：权限、校验、DTO、匿名、数据访问、会话、路由
cloudfunctions/
  api/                   小程序请求入口（44 个 action）
    domain/posts.js      ★ 纵向参考实现，新模块照此写
  worker/                定时任务：审核、媒体、共鸣聚合、清理、注销
  review-callback/       内容安全异步结果回调（验签/去重/防旧覆盖新）
scripts/                 同步、初始化、部署、自检
tests/                   权限与校验单测
docs/                    开发工程书
```

`cloudfunctions/*/shared/` 是 `npm run sync` 生成的副本（已 gitignore），
**不要手动编辑副本** —— 真源在根目录 `shared/`。

## 已实现 / 未实现

**已实现**：会话与成员资格、内容发布与审核状态机、可见范围过滤、匿名隔离、
话题、文集与授权、通知、权限内搜索、图片上传与检查、管理台五队列、
审计日志、幂等与版本锁、清理与注销任务。

**未实现（需真实环境或额外服务）**：

| 能力 | 现状 |
|---|---|
| 视频转码与封面生成 | 未接入 → `capabilities.video` 默认 `false` |
| 视频时长服务端复核 | 仅信客户端声明（任务 T-B07） |
| 图片 EXIF 剥离 | 未实现，是隐私缺口（任务 T-B07） |
| 内容安全接口实测 | **代码已写但从未真实调用过**（G0-2 / 任务 T-B17） |
| 申诉工单、成员管理接口 | 无接口，运营在控制台操作（T-B10 / T-B11） |
| 数据导出文件生成 | 只创建任务与通知（T-B14） |

## 边界声明

- 本工程书是设计与实现规格，**不构成法务合规结论**。上线前须完成
  [`docs/01`](./docs/01-decisions.md) 的 G0 核验。
- **单测全绿只证明权限规则的逻辑正确**，不证明集合权限、存储桶权限、
  环境变量、索引在生产环境配置正确 —— 这些必须按 `docs/10` 逐项人工确认。
- 本次没有连接任何真实云环境，没有创建集合，没有部署函数，
  没有调用过一次内容安全接口。
- `capabilities.publicScope` 与 `video` 在 G0 完成前必须保持 `false`。

## 开源协议

MIT
