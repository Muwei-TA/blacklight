# 管理员站内待办提醒

新增迁移 `20260924090000_admin_todo_notifications.sql`，沿用 PostgreSQL 和 `hg_notifications`。微信服务通知按用户要求暂停，未添加模板或订阅发送代码。

| 来源 | 新提醒条件 |
| --- | --- |
| 内容 | 社内/公开、仍 pending、当前版本审核任务进入 manual |
| 回应 | 仍 pending、当前版本任务 manual，父帖为本社已发布且社内/公开 |
| 话题 | 本社 pending |
| 入社申请 | 本社真实 pending；自动入社 active 不提醒，移除成员重新申请仍可待人工恢复 |
| 举报 | received |
| 文集 | collection_submission queued、关联文章为社内/公开且文集能力已开放 |
| 申诉 | submitted |

数据库触发器与原业务写入同事务执行，按 `(queue, source_id, source_version)` 原子记录事件，再向当前有效的 admin/moderator 各写一条中性系统通知；用户账号也必须 active。消息只包含待办类型和管理入口，不包含原文、作者身份、申请人、邀请码或举报人。正常自动审核 queued/running 不产生管理员提醒。

同版本任务重复写、worker 重试以及父帖范围临时切换不会重复提醒；退回重提版本增长后再次进入人工审核会生成新提醒。迁移为既有可处理任务建立事件基线，不回放历史消息。没有管理员的事件不会在以后新增管理员时补发。

`target.type=admin_queue`，`target.id` 与 `target.queue` 均为现有队列名；申诉使用 `admin_appeals`，id/queue 均为 `appeals`。通知是事件记录，不代表当前待办计数，管理员点击后由目标队列重新判权和加载最新状态。

管理员角色被撤销或成员资格失效后，不再接收新消息，旧管理员消息从通知列表及未读数中过滤。管理 API 保留原有服务端权限检查。普通用户通知不受该过滤影响。

## 验证与交付边界

- 独立、无网络 PostgreSQL 16 测试容器中成功应用原有 14 项迁移及新增迁移。
- `tests/integration/admin-todo-notifications.sql` 在 `service_role` 执行通过，事务回滚，无 fixture 残留；覆盖各类触发、自动审核排除、隐私、当前版本、重提、失权、原子回滚与客户端权限。
- 8 个并发发射同一来源版本得到 1 个事件、1 条通知。
- `npm run sync`、`npm test`（124 项）、`npm run lint`、`npm run check` 通过。
- 本次未应用开发云迁移、未部署函数、未做微信真机验证。集成时先合自动入社 `20260924080000`，再合本迁移；本迁移不替换入社或审核 RPC。

迁移必须作为单个事务执行，保证基线与触发器安装同业务写入互斥。回退提醒功能可追加迁移删除八张来源表上的 `admin_todo_changed` 触发器；保留事件和已发通知数据，避免回滚造成历史丢失或重复发送。
