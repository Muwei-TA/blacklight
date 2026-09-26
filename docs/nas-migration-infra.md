# NAS 自托管后端基础设施

本目录为 NAS 自托管 PostgreSQL、API、worker 和私有图片文件提供 Compose 基础。CloudBase 云函数不属于运行时依赖。当前 Compose 约定运行 Node 22、`npm start`、`npm run worker`，以及健康接口 `GET /v1/health`。

## 网络和持久化路径

- NAS 数据根目录：`/vol1/docker/blacklight-nas-data`。
- PostgreSQL 数据：`pgdata/`；图片：`media/`；备份：`backups/`；秘密文件：`secrets/`。目录保持 `0700`，秘密文件保持 `0600`。
- PostgreSQL 容器只在内部网络监听，不配置 `ports`。媒体只通过 API 的鉴权路由返回，不配置独立端口。
- API 容器端口 3000 仅绑定 NAS 地址 `192.168.50.28:18088`。Newt 的 VPS upstream 为 `http://192.168.50.28:18088`，用户域名为 `https://api.muwei.xyz`。NAS 防火墙仅允许 Newt 来源访问 18088；不要在路由器上转发该端口。
- 数据库在 `blacklight-nas-private` 内网；API 和 worker 同时加入 `blacklight-nas-egress`，以便调用微信登录与内容安全 API。没有数据库或媒体的宿主机端口映射。

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

`anon_alias_secret` 已由项目管理员安全恢复到 NAS 路径；本文及 Compose 不读取或展示其值。`MINIPROGRAM_APP_ID`、API 绑定地址和公网 API URL 配在 `/vol1/docker/blacklight-nas-data/.env`，可从 `deploy/nas/.env.example` 复制。不要在 `docker compose config`、命令参数或日志中放数据库 URL 和密钥值。

## PostgreSQL 初始化和验收

`Dockerfile.pg` 将当前 `cloudbase/migrations/*.sql` 拷入镜像。首次初始化时，`scripts/local-apply-migrations.sh`：

1. 创建本地 `anon`、`authenticated`、`service_role` 角色和 `blacklight_app` 登录角色；`blacklight_app` 继承 `service_role` 权限并绕过 RLS。客户端角色仍没有表或 RPC 权限。
2. 提供仅供 `hg_runtime_role()` 诊断函数使用的 `auth.role()` 兼容实现。
3. 按文件名应用当前全部 19 个 CloudBase migration，并把文件名和 SHA-256 写入受限的 `nas_meta.schema_migrations`。遇到 checksum 不一致或已有迁移数异常时停止。
4. 在迁移之后创建 NAS 本地会话表 `hg_sessions`。`token_hash` 是唯一 token 字段；不存明文会话 token。该表只授予 `service_role`。

数据库健康检查同时要求 `nas_meta.schema_migrations` 恰有 19 行及 `public.hg_sessions` 存在。因此 `pg_isready` 单独成功不会让未完成迁移的空库显示 healthy。如第一次启动迁移中断，重启数据库后可再次运行容器内 `/usr/local/bin/local-apply-migrations`；迁移 ledger 允许安全续跑。不要清空已有 `pgdata` 来掩盖 migration 错误。

`blacklight-nas-data` 分支已在本机 PostgreSQL 16.15 临时实例完整回放 19 个 SQL 文件，并检查本地会话表、RLS 和 role grants。CloudBase PG 当前不可读，因此这证明 SQL 可在 PostgreSQL 16 执行，不证明源数据库版本或线上备份/导入完整性。

## 当前部署边界

数据和图片的 CloudBase 导出/导入、NAS 备份与恢复工具尚未完成。数据库初始化成功不代表迁移完成；只有在取得非空完整导出、验证全部表行数和图片校验和、完成 NAS 备份恢复演练后才能切换外网体验版。不得用空库、空快照或单纯 migration 成功作为完成证明。
