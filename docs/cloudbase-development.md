# CloudBase 开发环境与验收记录

更新：2026-09-23（真实闭环状态）。环境 `shudong-d4g4blap4a5069a28`（上海），小程序 `wx39773ed34aa30776`。这是开发环境验证记录，不代表微信平台审核或正式发布。

## 实现与部署

- 前端以真实 `wx.cloud.callFunction` 调用 `api`，Mock 默认关闭。身份只接受当前云函数调用的微信上下文，不接受 payload 的用户标识，也不复用上一调用的身份。
- 数据库采用现有 PostgreSQL。业务对象以 JSONB 保存，迁移维护约束、索引及事务 RPC；业务表和 RPC 不授予 `anon/authenticated`。不需要新建 NoSQL 付费环境。
- 图片采用 PG 原生私有桶 `blacklight-private`，服务端解码 JPEG/PNG、删除元数据、压缩并检查将实际展示的字节。仅授权读取时签发 300 秒链接。公开、视频、文集和导出开关保持关闭。
- 已真实核验 PG 图片资产 `bd740f16-d05e-447f-8704-72bef2d5bf8d` 为 `verified`：清洗 JPEG 为 48×48、675 字节；图文内容 `d93b0b67-5893-4202-879f-de9e5773a867` 为 `published`、v2。匿名作者响应中的 `userId` 与 `displayName` 均为 `null`。
- 发帖、评论、申请入社、人工审核、自动审核完成、申诉和注销关键写入通过事务保存状态及相关计数、通知、审计、审核任务。上传意图、文件归属、清理与绑定使用行锁或租约；失败不得写成成功。
- 原始工作区 `/Users/muwei/WeChatProjects/shudong` 的用户改动保留。实际集成位于 `blacklight-development/frontend` 和 `blacklight-development/backend` 的 `codex/cloudbase-integration`，独立 Git worktree 并行实现后集成。本次使用 save-my-astra 的 Astra 主代理 + Luna 子代理路由，未修改全局配置。

## 复现配置

1. `npm ci && npm run sync && npm test && npm run lint && npm run check`。
2. `npm run db:init` 查看迁移；用 `tcb db pg migration up -e <envId> --dry-run` 预览，再 `up`，最后 `list` 核对远端记录。不可通过改写已经应用的迁移修复新问题。
3. 首次创建 PG 私有存储桶：

```sql
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('blacklight-private','blacklight-private',false,2097152,ARRAY['image/jpeg'])
ON CONFLICT DO NOTHING;
```

`storage.buckets/objects` 必须开启 RLS；本项目不添加任何客户端放行策略，服务端 API Key 对应 service_role。不可用旧 COS 的权限标签代替 PG RLS。

4. 在云端配置 `CLOUDBASE_APIKEY`、`MINIPROGRAM_APP_ID`；`api` 另需 `ANON_ALIAS_SECRET`。密钥不写前端、不进 Git。本次开发凭据有效期至 2026-10-22，长期运行前必须轮换。
5. 函数运行时 Node.js 20.19。前端执行 `node scripts/prepare-cloudfunctions.mjs ../backend` 生成被 Git 和小程序打包排除的本地部署副本；先在微信工具的 `cloudfunctions` 上同步云函数列表，再对已有函数使用“上传并部署”，不要重复“创建”。`config.json.permissions.openapi` 必须通过微信工具登记；只上传代码不能证明权限生效。
6. 首位 moderator 必须明确授权。本次用户授权调试账号“牧维”，初始化已写入独立审计；没有根据昵称自动提升其他账号的逻辑。

## 已取得的真实证据

| 验证 | 结果 |
|---|---|
| 真实微信会话、当前管理员与访客边界 | 通过；管理调用伪造 payload 身份仍为 guest |
| 普通微信调用伪造 Timer 事件 | worker 返回 forbidden |
| 模拟器填写、预览并提交文字 | 成功生成单条社内待审内容 |
| 管理台退回 → 作者申诉 → 管理员批准 | 真实页面操作通过；内容 v1 → rejected/v2 → pending/v3，申诉批准不直接公开 |
| 8 次同幂等键并发发帖 | 单条帖子、单条审核任务、单条幂等记录 |
| PG 事务集成 | 发帖、治理、邀请码、入社、评论、图片租约、审核、注销及清理绑定测试通过；所有 SQL fixture 使用事务回滚 |
| API 微信内容安全接口 | 真实微信文字安全调用返回 pass；最新 `admin/security/check` 返回 pass |
| timer 微信内容安全接口 | 当前 SCF timer 缺少有效微信 OpenAPI token，错误 -501001；重建 timer 后仍复现。失败始终保持待审，达到上限转人工 |
| PG 图片上传／签名／审核 | 资产 `bd740f16-d05e-447f-8704-72bef2d5bf8d` 已 verified，清洗 JPEG 为 675 字节、48×48；图文帖 `d93b0b67-5893-4202-879f-de9e5773a867` 已 published v2 |
| 原生 UI 回应 | 输入回应 `b8ba47e4-22b2-4a58-95ee-7d495f52685a` 已由数据库证实 published；截图见前端 `docs/evidence/published-comment.jpg`，计数为 1 |
| 私密内容隔离 | `0c0f9e22-7a04-41f8-87fe-ce89a83ec428` 真实创建为 `private_saved`；管理调用伪造 owner 读取仍为 `not_accessible` |
| PG 迁移 | 12 项迁移已应用到远端 |
| 自动化检查 | 后端 111 项测试与 lint/check、API actions 56、前端 8 项测试与 lint/check 均通过；前端当前 22 个页面 pending 为 0 |
| 开发预览 | 预览码已生成；包总 1,371,384 bytes、主包 1,166,399 bytes。`preview-20260923.jpg` 仅作开发预览，未作为正式上传或发布证据 |
| 真机、微信审核发布 | 尚未执行；不以静态检查或模拟器代替 |

CLS 当前已开通。旧 `GetFunctionLogs/GetFunctionLogDetail` 接口已下线，应使用 CLS 查询；日志不记录正文、微信 OpenID、匿名映射或凭据。无需为了日志排障额外开启按量服务。

## 自动审核与恢复边界

当前环境已证明真实微信 API 调用可进行文字安全检查，`admin/security/check` 也返回通过；单独 SCF timer 的同一调用仍为 `-501001`。前台本人审核已复用租约/RPC 并完成验证，但后台重试失败仍保持待审，达到上限后转人工，不能称为后台自动审核通过。外部调用仍无权直接提交“审核通过”结果，服务错误必须保留任务和内容。

## 当前未验收项与最小动作

- `wx.getImageInfo` 被 `downloadFile` 合法域名拦截；已请求加入 `https://shudong-d4g4blap4a5069a28.api.tcloudbasegateway.com`，等待用户确认后复验图片预览。
- 真机输入、图片展示、回应、返回栈和正式上传/发布尚未执行。开发预览码不等于上线证据。
- 公开、视频、文集、导出保持关闭；timer token/权限问题单独排障，不扩大本次验收范围。

截图和汇总证据位于前端 `docs/evidence/`，其中 `acceptance-20260923.json` 为本次状态汇总。开发阶段的合成测试内容仅用于验收，不能当作真实社团活动数据。
