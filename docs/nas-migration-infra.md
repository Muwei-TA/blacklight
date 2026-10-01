# NAS 自托管后端基础设施

本目录为 NAS 自托管 PostgreSQL、API、worker 和私有图片文件提供 Compose 基础。CloudBase 云函数不属于 API/worker 的运行时依赖。当前 Compose 运行 Node 22、`npm start`、`npm run worker`，以及健康接口 `GET /v1/health`。`POST /v1/review/callback` 在 NAS 上明确返回 `503 feature_disabled`：当前没有可验证的微信来源签名或可信回调入口，不能让普通 HTTP 请求改变审核状态；等待该回调的旧图片任务保持不可公开。

## 网络和持久化路径

- NAS 数据根目录：`/vol1/docker/blacklight-nas-data`。
- PostgreSQL 数据：`pgdata/`；图片：`media/`；备份：`backups/`；秘密文件：`secrets/`。目录保持 `0700`，秘密文件保持 `0600`。
- PostgreSQL 容器只在内部网络监听，不配置 `ports`。媒体只通过 API 的鉴权路由返回，不配置独立端口。
- API 容器端口 3000 仅绑定 NAS LAN 地址 `192.168.50.28:18088`；PG 与媒体没有宿主机端口映射。本地数据迁移不需要 VPS、Pangolin 或公网配置；本阶段不创建或调整这些资源。
- 数据库在 `blacklight-nas-private` 内网；API 和 worker 同时加入 `blacklight-nas-egress`，以便调用微信登录与内容安全 API。没有数据库或媒体的宿主机端口映射。
- `NAS_DATA_ROOT`、`API_BIND_PORT`、`NAS_COMPOSE_PROJECT_NAME`、`NAS_NETWORK_PREFIX`、`NAS_PG_IMAGE` 和 `NAS_APP_IMAGE` 可覆盖。现有 NAS 数据根已有业务数据，不可作为快照导入目标；并行验收必须使用全新的数据根、Compose 项目名、网络前缀、镜像 tag 和 LAN 端口。默认值仍对应现有栈。

Compose 镜像基础为 `postgres:16-bookworm` 与 `node:22-bookworm-slim`。PostgreSQL 官方入口以 root 启动并调整 `/vol1/.../pgdata` 所有权；不要给 `db` 服务指定非 root `user`。API/worker 入口先把媒体卷根目录设为容器 `node` 用户且权限 `0700`，再降权运行 Node。

## 秘密文件

在 `secrets/` 创建以下文件，文件内容不进入仓库或命令行参数。PostgreSQL 初始化脚本以容器内 UID 999 运行，`app_database_password` 必须让该 UID 可读；NAS 上该文件的当前处理方式是属组 999、模式 `0640`，其父 `secrets/` 目录维持 `0700`。

| 文件 | 用途 |
|---|---|
| `postgres_admin_password` | PostgreSQL 初始化超级用户密码 |
| `app_database_password` | `blacklight_app` 登录密码 |
| `database_url` | `postgresql://blacklight_app:<同一密码>@db:5432/blacklight` |
| `wechat_app_secret` | 小程序 AppSecret |
| `media_url_secret` | 本地媒体短期签名密钥 |
| `anon_alias_secret` | 现有匿名别名 HMAC 密钥，必须从已保存的原值恢复，不能重新生成替换 |

`anon_alias_secret` 已由项目管理员安全恢复到 NAS 路径；本文及 Compose 不读取或展示其值。`MINIPROGRAM_APP_ID`、API 绑定地址和运行时使用的 `PUBLIC_API_BASE_URL` 配在数据根 `.env`，可从 `deploy/nas/.env.example` 复制。示例使用固定 LAN HTTP 地址；公网运行必须关闭 `NAS_LAN_MODE` 并配置受信任的 HTTPS 地址。不要在 `docker compose config`、命令参数或日志中放数据库 URL 和密钥值。

## PostgreSQL 初始化和验收

`Dockerfile.pg` 将当前 `cloudbase/migrations/*.sql` 拷入镜像。首次初始化时，`scripts/local-apply-migrations.sh`：

1. 创建本地 `anon`、`authenticated`、`service_role` 角色和 `blacklight_app` 登录角色；`blacklight_app` 继承 `service_role` 权限并绕过 RLS。客户端角色仍没有表或 RPC 权限。
2. 提供仅供 `hg_runtime_role()` 诊断函数使用的 `auth.role()` 兼容实现。
3. 按文件名应用当前全部 22 个 CloudBase migration，并把文件名和 SHA-256 写入受限的 `nas_meta.schema_migrations`。遇到 checksum 不一致或已有迁移数异常时停止。
4. 在迁移之后创建 NAS 本地会话表 `hg_sessions`。`token_hash` 是唯一 token 字段；不存明文会话 token。该表只授予 `service_role`。

数据库健康检查同时要求 `nas_meta.schema_migrations` 恰有 22 行及 `public.hg_sessions` 存在。因此 `pg_isready` 单独成功不会让未完成迁移的空库显示 healthy。如第一次启动迁移中断，重启数据库后可再次运行容器内 `/usr/local/bin/local-apply-migrations`；迁移 ledger 允许安全续跑。不要清空已有 `pgdata` 来掩盖 migration 错误。

截至 2026-10-02 的只读核对，CloudBase PG 最新 migration 为 `20260927160000_user_levels`，共有 22 个 migration 和 27 张业务表。NAS 现有数据库包含数据，快照导入只能指向新的 stage 数据根。此只读状态不代表已导出或导入真实快照。

## 从 CloudBase 导出完整快照

`scripts/local-export-cloudbase.mjs` 通过 CloudBase PG JS SDK 导出全部 27 张业务表和 `blacklight-private` Bucket 下 `private/image/` 的所有对象。它会拒绝少于或多于预期的 22 个 migration、最新版本不符或表清单不是 27 张；逐表读取并复核行数，记录 JSONL SHA-256 和 migration 指纹。图片保持 `pgstore://blacklight-private/<objectKey>` ID，导出 `fileId → relativePath/SHA-256/size` 索引。每个数据库引用都必须在完整 Bucket 列表中找到。脚本不依赖 CloudBase `pg_dump`。

在可信开发机的后端仓库执行。先再次确认 CloudBase PG 可读，并暂停 CloudBase API、worker、定时任务和任何会写库或改图片的入口，直到导出完成；使用 CloudBase 服务端 API Key（`service_role`）权限，将密钥放在权限为 `0600` 的单独文件中。不要把密钥粘进 shell 命令、`.env` 或聊天。

```sh
cd /path/to/blacklight-nas-data
npm ci --prefix cloudfunctions/api
umask 077
TCB_ENV_ID='<CloudBase 环境 ID>' \
CLOUDBASE_APIKEY_FILE='/secure/path/cloudbase-service-api-key' \
  node scripts/local-export-cloudbase.mjs \
  --writes-quiesced \
  --out '/secure/path/blacklight-cloudbase-snapshot-YYYYMMDD-HHMMSS'
```

输出目录必须是新目录且仅当前用户可读。`manifest.json` 只有在 27 张表、非空 `hg_users`/`hg_club_config`、全部图片对象和复核计数都成功后才标记 `complete`。任何错误都会标记 `incomplete` 并写入不含凭证或远端错误正文的失败代码；这种快照不可导入。不要手动把状态改成 `complete`。

复制到 NAS 前可在本地只做快照校验，不会访问 Docker 或数据库：

```sh
node scripts/local-import-snapshot.mjs --writes-paused --verify-only \
  --snapshot '/secure/path/blacklight-cloudbase-snapshot-YYYYMMDD-HHMMSS'
```

仓库导出程序尚未对真实 CloudBase 环境执行。导出开始前仍要再次确认数据库可读、API/worker 写入已暂停，导出完成后核对实际行数与对象数；本地清单通过不代表真实快照完成。

## 导入到 NAS

先将完整快照复制到新的 stage 数据根，例如 `/vol1/docker/blacklight-nas-stage/imports/<snapshot-id>`，保持目录 `0700`、文件 `0600`。导入器核对目标端 22 个 migration 文件名与 SHA、28 张预期 public 表的完整清单、`hg_sessions` 为空，并拒绝任何已有业务行或非默认配置。现有 NAS 目标库不是导入目标；目标库必须从全新数据根初始化。

并行验收使用独立配置，例如：

```dotenv
NAS_DATA_ROOT=/vol1/docker/blacklight-nas-stage
NAS_BACKUP_ROOT=/vol2/backups/blacklight-nas-stage
NAS_COMPOSE_PROJECT_NAME=blacklight-nas-stage
NAS_NETWORK_PREFIX=blacklight-nas-stage
NAS_PG_IMAGE=blacklight-nas-stage-postgres:16
NAS_APP_IMAGE=blacklight-nas-stage-api:20261002-002b333
NAS_LAN_MODE=1
API_BIND_IP=192.168.50.28
API_BIND_PORT=18118
PUBLIC_API_BASE_URL=http://192.168.50.28:18118
```

将配置保存到 stage 数据根的 `.env`，另在该根下准备独立 `secrets/`。上述 `18118` 是本次在 NAS 上确认空闲并实际使用的端口；`18089` 已被其他容器占用，复用示例前仍须检查端口。新栈使用自己的 Compose 项目名、网络前缀和镜像 tag，旧栈保持运行并作为回退点。LAN HTTP 只用于隔离的内网验收；代码会拒绝其它明文地址或端口不匹配的 URL。

```sh
docker compose --project-name blacklight-nas-stage \
  --project-directory "$PWD" \
  --env-file /vol1/docker/blacklight-nas-stage/.env \
  -f deploy/nas/compose.yaml build db api worker
docker compose --project-name blacklight-nas-stage \
  --project-directory "$PWD" \
  --env-file /vol1/docker/blacklight-nas-stage/.env \
  -f deploy/nas/compose.yaml up -d db api worker
```

```sh
NAS_DATA_ROOT=/vol1/docker/blacklight-nas-stage
NAS_COMPOSE_PROJECT_NAME=blacklight-nas-stage
docker compose --project-name "$NAS_COMPOSE_PROJECT_NAME" --project-directory "$PWD" \
  --env-file "$NAS_DATA_ROOT/.env" \
  -f deploy/nas/compose.yaml stop api worker
NAS_DATA_ROOT="$NAS_DATA_ROOT" NAS_COMPOSE_PROJECT_NAME="$NAS_COMPOSE_PROJECT_NAME" \
  node scripts/local-import-snapshot.mjs \
  --writes-paused \
  --replace-local-club-seed \
  --snapshot "$NAS_DATA_ROOT/imports/<snapshot-id>"
```

导入器在写库前完整校验 manifest、migration 指纹、27 张表的 JSONL 行数/SHA、Asset 引用集合、所有媒体文件 SHA 和文件权限。媒体先按原 `objectKey` 幂等写入本地私有卷；数据库行通过单个事务导入，保留原 ID、RPC、RLS 和角色权限。成功后在 stage 数据根目录留下 `import-receipt-*.json`。若中途失败，数据库事务回滚；已写入的媒体文件可用同一快照再次导入，接收器会校验后跳过相同文件并拒绝内容不同的同名文件。

导入工具默认只允许当前 Docker context 为本机 `default`，避免在普通工作站上误操作 NAS 上下文。建议在 NAS 仓库与本地 Docker Engine 上运行；不要为了绕过该保护在工作站上设置远端 context。

## 本地备份和恢复演练

备份写入 `/vol2/backups/blacklight-nas-data`，与 PG 和媒体所在的 `/vol1` 分卷。`NAS_BACKUP_ROOT` 可在 NAS `.env` 覆盖。/vol2 当前空间有限；备份前工具会按媒体大小、数据库大小和 1 GiB 余量检查空间。该副本仍在同一台 NAS 上，不能代替离机/异地备份。

备份前暂停 API 和 worker 写入。维护容器使用本地 PG `pg_dump`，会拒绝不完整 migration ledger、图片引用缺失或 `hg_users` 为空的库。它生成 custom-format `database.dump`、私有媒体 `media.tar.gz`、文件 SHA/大小清单、逐表行数和校验 manifest；写入前及完成后各做一次恢复检查。恢复检查会在同一个 PG 实例创建临时数据库，并将媒体解压到专用临时目录，核对 migration checksums、行数、图片文件清单和 SHA，然后只删除本次创建的临时对象。

```sh
NAS_DATA_ROOT=/vol1/docker/blacklight-nas-data
# 先暂停正在运行的写入服务，再创建并校验备份：
docker compose --project-directory "$PWD" --env-file "$NAS_DATA_ROOT/.env" \
  -f deploy/nas/compose.yaml stop api worker
docker compose --project-directory "$PWD" --env-file "$NAS_DATA_ROOT/.env" \
  -f deploy/nas/compose.yaml --profile maintenance run --rm \
  -e NAS_WRITES_QUIESCED=1 backup backup
```

脚本输出备份 ID 后，再做一次独立恢复检查：

```sh
docker compose --project-directory "$PWD" --env-file "$NAS_DATA_ROOT/.env" \
  -f deploy/nas/compose.yaml --profile maintenance run --rm \
  -e NAS_WRITES_QUIESCED=1 backup \
  verify "/backups/blacklight-nas-data/<backup-id>"
```

两次都看到 `restore rehearsal passed` 后，才重新启动 API/worker，并将完成的 `/vol2` 备份复制到离机存储。恢复演练不覆盖生产库；它在原 PG 实例上临时建库，因此要预留 `/vol1` 空间容纳一份临时数据库和媒体。删除、替换当前正式库的灾难恢复仍须另行审核具体备份 ID 与恢复目标；本脚本目前只做恢复演练，不自动替换正式库。

```sh
docker compose --project-directory "$PWD" --env-file "$NAS_DATA_ROOT/.env" \
  -f deploy/nas/compose.yaml up -d api worker
```

## 切换门槛与当前验收边界

- 旧 NAS 分支的 19-migration 回放结果只适用于当时的 schema。当前 22 个 migration 需要在新隔离工作树/新数据根重新验证。
- 本机临时 PostgreSQL 16 的备份/恢复演练已用合成数据跑通：`hg_users` 一行、图片引用一条、私有媒体文件 28 字节；生成的 `pg_dump` 和媒体 tar 均恢复并校验通过。该测试证明本地备份工具链有效，不代表真实用户数据已迁入 NAS。
- 本轮没有执行 CloudBase 导出或 NAS 导入，真实快照、receipt、NAS 备份及恢复演练仍待实际迁移时完成。
- 现有 NAS 数据库包含业务行；当前实施保留该栈并要求全新 stage 数据根，快照导入器还会校验全部 28 张 public 表并拒绝已有行。
- 本地数据迁移阶段的完成门槛是：取得非空完整 CloudBase 快照、成功导入并核对 receipt 的行数/图片数、完成 NAS 备份及独立恢复演练。回调来源验签与对外入口仍未闭合；在完成真实验签前 `/v1/review/callback` 保持禁用，等待回调的旧图片不自动公开。
