# 黑光树洞续作交接 — 2026-09-23 10:17

> 仓库路径更正（2026-09-23）：当前前端主仓库为 `/Users/muwei/WeChatProjects/tdesign-miniprogram-starter`，后端主仓库为 `/Users/muwei/WeChatProjects/blacklight-development`。下文旧路径记录的是当时工作区；旧开发检出保留在 `/Users/muwei/WeChatProjects-archive-20260923/` 下。

## 结论与工作区

本轮修复交接中的图片读取与后台审核阻塞，补齐 T-B09 开发环境护栏、列表错误态、点击图片续签和真实 PG 分页。两仓继续在 `codex/cloudbase-integration`；本轮已本地提交，尚未推送或合并 main，没有上传体验版或正式发布。完整小程序上线验收仍未完成。

实际工作区：`/Users/muwei/WeChatProjects/blacklight-development/frontend` 与 `backend`。原 `shudong` 模板的 app.js/project.config.json 改动保持原状；CloudBase MCP 在该任务目录维护迁移镜像，后端仓库是迁移与源码交付位置。

按用户指定 Save My Astra 路由使用 `gpt-6-luna` 子代理，隔离 worktree 开发后由主代理审查集成；未修改 Codex 全局配置。各工作树和专题分支保留。

## 本轮实现及现场证据

1. **图片域名与 OPA**：用户已添加 downloadFile 合法域名，重开项目生效。原 OPA 全拒客户端存储也挡住签名读取，现只为私有桶签名下载 GET/HEAD 放行至 PG 校验层；桶仍 private、RLS 开启、无客户端放行策略。缺签/伪造 401、原始对象 403、合法图片可读可预览；334 秒旧链接 401、重新授权后可读。策略及回滚副本在后端 `cloudbase/policies/`。
2. **图片预览续签**：首页、详情、话题、成员页点击时重新走 posts/detail；管理附件重新走 assets/status。失权/失败不回退旧链接。模拟器以无效缓存 URL 注入测试验证重新取链并成功预览。本地选图预览不变。
3. **后台审核**：必须在微信开发者工具对已有 worker/config.json 右键「上传触发器」。真实微信 timer 本次上下文是 TCB_SOURCE=wx_trigger、TRIGGER_SRC=tcb、匹配 AppID，无 OPENID；代码只认可可信本次上下文，不信 event 或热实例残留。普通 SCF timer 的 -501001 已解决，SCF trigger 列表为空不等于微信调度失效，禁止再创建第二个普通 timer。两轮真实测试帖子 pending→published/v2、task passed、attempts=0；客户端伪造 timer 为 forbidden。
4. **T-B09**：第 13 项迁移 `20260923000000_usage_quotas` 已实际应用并回读；api/worker 已经微信工具重新部署。开发默认个人滚动24小时20MiB、社团UTC日200MiB、审核每日1000次、80%预警，可由 hg_club_config.usageLimits 调整。这是应用护栏而非腾讯云计费预算。审核每分片/每图片调用原子预占，限额后 queued 至次日、不计普通失败；管理员站内告警去重。旧三参数上传RPC兼容。
5. **配额实测**：8并发审核仅3个获准（上限3）；8并发2MiB上传意图仅2个获准（上限4MiB）。回滚 SQL 覆盖非法配置、权限、通知去重、上传租约与清理计量。真实文字+图片检查共计2次，图片 verified/628B；随后真实timer完成待审内容，总计量3次。管理页已实际渲染，伪造管理员请求被拒。
6. **分页**：修正PG ISO时间转游标失败，分页条件保留原OR过滤；真实两页各1条且不重复。
7. **错误态**：话题、消息、搜索保留旧列表并显示错误/重试；模拟器网络失败注入保留5条消息，重试入口可点击；原始wx调用在finally恢复。

证据：两端 `docs/evidence/`，后端 `signed-image-20260923.json`、`wechat-timer-20260923.json`、`pagination-20260923.json`、`usage-quotas-20260923.json`；前端另有 `frontend-runtime-20260923.json`、`image-preview-20260923.jpg`、`usage-admin-20260923.jpg`、`list-error-20260923.jpg`。不保存令牌或签名URL。

## 验证

- 后端：118 项测试、sync/lint/check通过，57 actions。
- 前端：11 个测试文件、lint/check通过，22页面。
- 新迁移：plan可执行、Task `task-c0952bdd` Succeed、远端历史13项。
- 配额SQL：`tests/integration/usage-quotas.sql` 子事务回滚通过，fixture不残留。独立并发测试仅清理本轮创建的未上传fixture和其计量/幂等记录。
- 新真实图片 `f13b653e-d2c7-471f-a6f6-a2326734a476` 为合成测试图，verified但未绑帖，按已有孤儿清理机制处理；不要把它当真实用户内容。
- 新timer样本 `timer-probe-20260923-0949`、`timer-quota-probe-20260923` 为明确标注的开发验收内容，证据保留。

## 仍未完成，不得标成已上线

- 退回内容的编辑/重提链路尚缺前后端版本与幂等契约；头像上传当前明确关闭。
- 多真实账号（访客、A/B、被移除成员）、iOS/Android真机、审核风险/人工复核实际样本及云端中断/部分删除失败恢复验收未齐。
- G0主体/类目/备案、运营值守、实际备份恢复、腾讯云费用预算告警、长期凭据轮换仍待完成。开发API Key到期日据前次交接为2026-10-22，本轮未读取凭据或复查到期值。
- T-B08没有即时撤权代理，最长保留300秒链接窗口且已下载文件不可收回；T-B12对账、T-B14导出、T-B15订阅消息尚未实现。公开/视频/文集/导出仍关闭。

下一位先读两端任务审计文档；本轮已解决的域名/token故障不要再重复排查。新增数据库改动必须追加迁移，不改13项已应用历史。回滚函数代码不回滚数据库或已写业务数据。
