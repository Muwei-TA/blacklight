# 审核任务恢复与回调安全

本文件记录 R-03、R-06、R-07 的实现边界。它描述的是代码保证的状态机，不能替代 CloudBase 控制台权限设置或真实云环境验收。

## Worker 来源与调用权限

`cloudfunctions/worker/index.js` 在执行任何任务前读取 `wx-server-sdk` 的 `cloud.getWXContext().SOURCE`，只有 `wx_trigger` 通过。定时事件中的 `Type`、`TriggerName`、`Message` 和自定义字段只用于诊断日志，不能作为认证凭证。日志会记录来源、是否存在用户上下文、事件类型和触发器名称，但不记录业务正文或身份信息。

这段代码无法从函数内部证明 CloudBase 控制台的调用权限配置。部署时必须把 worker 的直接客户端调用关闭，并只保留定时器或受控服务端调用；当前仓库没有连接真实环境验证 SOURCE 的实际值、触发器权限是否生效，仍需在开发环境完成一次正向定时触发和一次小程序直接调用拒绝验收。手动控制台测试若产生 `wx_devtools` 来源，不应为了通过测试而放宽生产 allowlist。

`review-callback` 同样读取 `getWXContext().SOURCE`，同时要求部署侧 `REVIEW_CALLBACK_SECRET` 与请求头/受控网关字段中的 secret 做常量时间比较。`MsgType` 永远不会被当作来源证明。当前 HTTP/消息推送通道的实际 SOURCE 值、签名或解密格式尚未实测，secret 适配层也不能被描述为已经完成微信官方验签。

## R-06：任务租约、等待和失败退避

任务文档沿用 `status`、`attempts`、`lastError` 等字段，并新增以下运行字段：

| 字段 | 作用 |
| --- | --- |
| `leaseId` | 本次 worker 实例持有的随机租约标识 |
| `claimedAt` / `leaseExpiresAt` | 租约开始与过期时间；默认租约为 90 秒，覆盖 60 秒函数超时 |
| `nextAttemptAt` | 失败退避或依赖等待的最早重试时间 |
| `waitingReason` | 依赖尚未完成的可诊断原因 |

抢占条件同时检查状态和旧租约：`queued` 任务只在 `nextAttemptAt` 到期后领取，过期的 `running` 任务才可被恢复。旧版本没有租约字段的 `running` 任务用 `claimedAt` 兼容恢复；没有任何时间戳的任务按可恢复处理。抢占成功只写租约，不增加 `attempts`。

任务执行返回 `queued` 表示等待附件、异步回调或人工编辑，不是失败：状态回到 `queued`，写入短等待时间，失败次数保持不变。实际抛错才增加 `attempts`；退避从 30 秒开始按 2 倍增长，上限 15 分钟，达到 5 次转 `manual`。结果写回必须带当前 `leaseId` 的条件更新，租约丢失时旧实例只能记录冲突，不能覆盖新实例的结果。

异常状态写入失败不会被吞掉。任务会继续保持 `running`，由过期租约恢复；日志只保留任务 ID、错误短消息和 attempts。内容审核在整个恢复过程中保持不可公开。

## R-03：回调的 trace/version 绑定

视频异步提交成功后，worker 为资产写入 `traceId` 和递增的 `reviewVersion`，并保留绑定的 `postVersion`。回调必须以 trace 定位当前资产；如果通道提供 `assetId` 或版本字段，还必须与资产记录完全一致。事件时间只用于丢弃明显早于当前提交的迟到回调，不能替代 trace/version 绑定。

通过、人工复核和拒绝的更新都要求同时满足：资产仍是 `verifying`、trace 相同、postVersion 相同、reviewVersion 相同。两个相互矛盾的回调只有第一个条件更新成功；后一个收到 `conflict`，不能把拒绝结果改成可展示，也不能把旧任务的通过结果写入新版本。终态回调重复投递直接幂等确认。通过结果只有在成功取得新的私有临时链接后才会写入 `verified`。

## R-07：物理清理与注销重试

孤儿查询覆盖 `intent`、`uploaded`、`verifying`、`verified`、`rejected`、`failed` 六类未绑定资产。删除云文件返回逐文件结果；任何非成功结果都会保留资产记录，写入 `cleanupState=retryable`、`cleanupAttempts`、`cleanupLastError` 和 `cleanupNextAttemptAt`。数据库记录删除失败也同样保留可重试记录。对象已经不存在视为幂等成功，避免“文件先删、记录后写失败”造成永久卡住。

已删除内容的资产保持 `revoked`，worker 主调度已接入 `cleanupDeletedPostAssets()`；只有物理删除结果确认后才清空 `fileId`/临时链接并改为 `purged`。注销执行先把内容删除、附件置为 `revoked`、成员资格撤销、匿名映射删除并写审计，再把用户改为 `deleted`。任何步骤异常都停留在 `deletion_processing`，下一轮继续，不能写入虚假的完成状态。

清理仍然受上传绑定竞态影响：最终数据库更新带 `postId`、状态和清理租约条件；若记录已被其他流程改变，当前实例不会删除该记录，并留下可检查的跳过结果。真实上传、审核回调、删除失败和注销重试需要在隔离 CloudBase 环境补充验收。

## 本地验证

```bash
npm test
npm run check
node --check cloudfunctions/worker/index.js
node --check cloudfunctions/review-callback/index.js
```

本地测试不能伪造 CloudBase 的 SOURCE 或函数调用权限，因此只验证状态机纯函数、伪造 `MsgType` 被拒、trace/version 不匹配不更新、删除失败保留重试记录等行为；部署前仍需保存真实触发、权限拒绝和回调通道证据。
