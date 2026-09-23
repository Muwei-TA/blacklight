# 退回内容编辑重提开发记录

`codex/resubmit-rejected` 分支新增 `posts/resubmit`。仅原作者且仍具备发布资格的成员可操作 `rejected` 原帖；只更改标题和正文，原附件、身份、话题、可见范围保留。`expectedVersion` 防止覆盖并发改动，账号与操作范围内的幂等键防止超时重试创建重复审核任务。

迁移 `20260923120000_resubmit_rejected_post.sql` 以一个事务更新原帖版本/状态、保留附件绑定、写入新版本审核任务和审计标记。旧审核任务保留。`tests/integration/resubmit-rejected.sql` 用单条 `DO` 的子事务回滚，不保留 fixture。

本地：121 项 Node 测试、lint、结构检查通过。首次云端迁移因 PL/pgSQL `CASE` 表达式缺少括号失败，远端仍为 13 项；本地隔离 PostgreSQL 复现并修正后，第 14 项迁移应用成功，`api` 仅更新代码。远端回滚事务测试通过，回读确认五类 fixture 记录均为 0。

微信开发者工具模拟器使用明确标记的临时退回稿，真实页面读取退回理由并输入修改文字，然后通过页面 `submitConfirmed` 方法触发真实云函数。数据库回读 v2 `rejected` → v3 待审 → v4 `published`，新审核任务 `passed`。随后通过正常接口删除临时稿，回读 v5 `deleted` 且不出现在信息流。详见 `docs/evidence/resubmit-20260923.json`。

这一轮没有通过页面的原生确认弹窗点击，也没有多账号、iOS/Android 真机或平台审核证据；不能标记正式上线验收完成。
