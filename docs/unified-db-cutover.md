# 小程序与网站共库切换（2026-10-05）

## 已上线拓扑

- api.muwei.xyz → NAS blacklight-nas-stage-api-1（192.168.50.28:18118）。
- shudong.muwei.xyz → NAS blacklight-unified-web-web-api-1（192.168.50.28:18120）。
- 两个 API 连接同一 stage PostgreSQL，读写 /vol1/docker/blacklight-nas-stage/media。只运行 blacklight-nas-stage-worker-1，其 REVIEW_PROVIDER=wechat；网站 API 为 manual。
- 旧网站 API/worker 停止，旧网站 DB/命名卷保留回滚。CloudBase 旧 worker 的每分钟 timer 仍刷新旧库零用量；过去 47 小时没有旧 CloudBase API 调用的指标证据，已上传小程序版本未核实。

stage 数据库从 24 个迁移升到 29 个，保留原有 15 帖、8 评论、8 资产及 6 个有效媒体文件。网站的 2 个账号、9 个有效会话、2 条 moderator 成员关系已事务性并入；源网站库无帖子/媒体。两个社团沿用 stage 的能力、用量、成员与管理任期；发现开关按网站原配置设为 true。黑箱动画社原主负责人保留，黑光社原为空，设为网站 developer 账号。

## 源码和配置

应用源码基线：4ceaacb211e490e1b70b4d1c64243d9806e395f0。PG 镜像 blacklight-unified-postgres:4ceaacb211e490e1b70b4d1c64243d9806e395f0，API/worker 镜像 blacklight-unified-api:4ceaacb211e490e1b70b4d1c64243d9806e395f0。共库合并工具和清单位于 scripts/unified-web-account-merge.mjs、deploy/unified/。

NAS 的当前可维护源码为 /vol1/docker/blacklight-nas-stage/src；此前的源码留在同级 src-pre-unified-20261005，环境文件留有 .env.pre-unified-20261005。stage 的 .env 已固定新版镜像标签和 REVIEW_PROVIDER=wechat。新网站 sidecar 也可从当前源码的 deploy/unified/compose.yaml 管理。原网站源代码与容器未覆盖。

网站 sidecar Compose 只含 API。unified.env 仅保存非秘密元数据；数据库、媒体签名、匿名别名密钥以 stage 原有 secret file 挂载。网站沿用 blacklight-web_edge 和 Pangolin 现有路由，无需 Caddy 或改 DNS。

## 备份与回滚

停写前恢复演练通过：

- stage 24 项：/vol2/backups/blacklight-nas-stage/20261004T160056Z_17025（数据库与媒体，6 文件）。
- 网站 29 项：/vol2/backups/blacklight-web/20261004T160023Z（数据库与媒体）。

合库后再次停写并恢复演练通过：/vol2/backups/blacklight-nas-stage/20261004T160456Z_12738（29 项，数据库与媒体，6 文件）。旧网站 PG 卷、旧镜像和 stage 迁移前源码保留。勿执行 down -v、volume prune 或覆盖备份。

网站单独故障：停止新网站 sidecar。若共享库已有新写入，不可直接恢复旧网站独立库，因为它缺少这些写入。stage API/worker 故障：先停两个公网 API 与 worker；共享库有新写入后也不可直接回灌 24 项备份。优先修复新版镜像；确需恢复时，以同一时间点数据库与媒体为单位，先在隔离库验证。

## 验收边界

已完成：29 项账本；账号合并在隔离库演练并在正式库幂等回读；隔离 API 用现有成员身份读到黑光 4 篇、黑箱 2 篇及一张 200/JPEG 图片；隔离网站会话读到相同帖子；公网两个健康接口、网页首页、编辑页、Chrome 社团目录两社团可见；两个公网 clubs/list 返回相同 ID。npm run check、npm run lint、npm test 均通过（260 项，258 通过，2 跳过）。

未声称：已上传小程序包或真机测试、用户真实密码登录、正式库的新帖子跨端发布闭环。旧 CloudBase worker timer 未停用，保留旧库回退可能性；后续停用需先核实已上传小程序版本与旧版客户端流量。
