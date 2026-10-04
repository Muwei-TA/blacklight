# 黑光树洞网站：运行与迁移

实现位于 `codex/web-migration-20261004`，基于前端 `90e84df`、后端 `16ce74d`。网站源代码在后端仓库 `web/`；原小程序仓库用于业务对照，不需要复制或编译小程序代码。

## 已接通的功能

- 账号密码注册、登录、改密、退出；昵称设置、注销申请。
- 社团目录与切换、规则阅读、邀请码入社、申请取消。
- 树洞与权限内搜索、署名/匿名/仅自己/能力允许时公开发布、文章和短笔。
- 详情、共鸣、收藏、一级回应及对一级回应的回复、回应删除、举报、缩小范围、删除、退回重提和申诉。
- 话题/板块浏览、详情、创建和话题关注；文集目录、作品投稿与授权撤回。
- 个人作品状态列表、收藏、签到、站内消息、换届和管理员恢复确认。
- 原管理台的审核、成员、邀请码、设置、团队、换届、审计和平台治理，通过网站账号登录。

浏览器端仅保存选中社团标识这一项偏好；Cookie 为 HttpOnly，CSRF 令牌在内存。网站不会自动绑定同昵称的微信账号，不会把合成身份当成微信 openid。

## 本地运行

需要 Node >=20 与 PostgreSQL 16。首次安装：

```sh
npm ci
npm run sync
```

先执行数据库迁移（下一节），然后配置环境。开发配置示例用于独立测试数据库：

```sh
export NODE_ENV=development
export REVIEW_PROVIDER=manual
export DATABASE_URL='postgresql://blacklight_app:YOUR_URL_ENCODED_PASSWORD@127.0.0.1:5432/blacklight'
export PUBLIC_API_BASE_URL='http://127.0.0.1:3000'
export ANON_ALIAS_SECRET='YOUR_RANDOM_SECRET_AT_LEAST_32_BYTES'
export MEDIA_URL_SECRET='ANOTHER_RANDOM_SECRET_AT_LEAST_32_BYTES'
export NAS_MEDIA_DIR='/absolute/path/to/private-media'
npm run dev:start
```

另一个终端使用同一组配置执行 `npm run dev:worker`。成员端：`http://127.0.0.1:3000/`；管理台：`http://127.0.0.1:3000/admin/`。纯网站人工审核模式不需要小程序 AppID/AppSecret。生产配置要求 HTTPS。

## 新数据库：Docker Compose

```sh
cp deploy/web/.env.example deploy/web/.env
# 填入真实域名和随机 secret；数据库密码用随机字母数字以避免 URL 转义问题。
docker compose --env-file deploy/web/.env -f deploy/web/compose.yaml up -d --build
```

PostgreSQL 和 worker 只接内部网络；API 同时连接接入网络，默认绑定主机 `127.0.0.1:3000`。使用 Caddy/Nginx 将真实 HTTPS 域名同域反代至该端口。`deploy/web/Caddyfile.example` 是同主机 Caddy 示例；如果反代也在容器中，应加入 API 网络并将地址改成服务名。

`PUBLIC_API_BASE_URL` 必须与浏览器实际访问来源一致（scheme + host + port），不能填写后端内部地址。Cookie、CSRF、媒体链接依赖它。不要把 HTTPS 检查改成全局允许 HTTP；开发 HTTP 只允许 loopback，原 NAS 固定 LAN 模式单独保留。

数据库镜像仅包含迁移和初始化脚本，不挂载整份源码仓库；应用镜像明确设置代码读取权限，服务以普通用户运行。

同主机 Caddy 反代的来源由 `WEB_TRUSTED_PROXY_IPS` 精确匹配 Docker 网关地址，默认 `172.28.42.1`。仅对可信来源读取最右侧 `X-Forwarded-For`，其他来源忽略该请求头；账号和来源限频同时生效。如网段冲突，同步修改 `.env` 中 `WEB_NETWORK_SUBNET`、`WEB_PROXY_GATEWAY` 和 `WEB_TRUSTED_PROXY_IPS`。容器内反代需指定其固定 IP 为可信来源，不能配置通配信任。

`init-db.sh` 仅在新 PostgreSQL volume 首次创建时运行。复用现有数据卷时必须显式执行增量迁移，不能期待换镜像自动升级。

## 已有 NAS 数据库：增量升级

先备份数据库和私有媒体，再更新代码与同步 shared。新增迁移是：

`cloudbase/migrations/20261004090000_web_accounts.sql`

它新增 `hg_web_accounts`、`hg_web_sessions`、`hg_web_auth_limits`，不改写既有用户、成员资格或作品。数据库登录角色必须有 `service_role` 权限，普通客户端角色没有新表权限。

现有 NAS 的 `scripts/local-apply-migrations.sh` 现验证 27 个迁移；`scripts/local-migration-lib.mjs` 的 inventory 为 36 个源表。建议使用现有部署的迁移命令和校验账本，在数据库容器中设置 `LOCAL_MIGRATIONS_DIR`、`LOCAL_COMPAT_DIR`、`NAS_APP_DATABASE_PASSWORD_FILE`、`POSTGRES_USER`、`POSTGRES_DB` 后执行脚本。它会跳过已有且 checksum 一致的迁移，并在事务中执行新迁移和登记账本。

只用 `psql -f` 执行新 SQL 不会自动更新 NAS 的 `nas_meta.schema_migrations`，NAS 健康检查仍会失败。不要编辑旧迁移绕过 checksum。网站 Compose 的初始化也复用同一迁移脚本与账本。

## 第一个管理员

1. 在网站注册自己的账号。
2. 登录后进入「我的」，复制用户标识（不使用昵称代替 ID）。
3. 运维人员在后端环境运行既有平台角色工具，指定准确 ID：

```sh
node scripts/local-platform-role.mjs --user-id USER_ID --role developer --expected-role none --reason '为网站初始化指定平台管理账号' --operator OPERATOR_NAME
```

4. 重新读取页面，在「我的」进入管理台，创建社团并指定负责人，或将账号加入已有社团的管理团队。现有平台管理界面和权限规则不变。创建后通过管理员开通发布等能力，默认关闭的能力不会自动开启。

账号注册接口忽略用户提交的角色，不能公开自授管理员。示例浏览器测试账号只存在于隔离测试数据库，不能用于生产初始化。

## 旧小程序账号绑定 / 密码遗忘

由运维核实真实用户身份后，用原用户 ID 配置网站账号；原来的作品、成员资格和匿名映射均保留。

```sh
# 准备仅当前运维用户可读的密码文件，避免密码出现在命令参数或 shell 历史。
export WEB_ACCOUNT_PASSWORD_FILE='/secure/path/to/temporary-password'
node scripts/local-web-account.mjs --user-id EXISTING_USER_ID --username reader_name
```

工具要求已经存在、仍为 active 且有内部身份引用的用户。一个用户只允许一个网站账号；重置必须使用原账号名称，不会抢占另一用户的账号。执行后撤销全部网站会话。密码文件不提交仓库，完成后由运维清理，并请用户改密。网站首版没有自助邮箱/短信找回功能。

## 审核和图片

`REVIEW_PROVIDER=manual` 时，文本立即进入原人工审核队列，待审内容不进入普通成员信息流。具有权限的审核员登录 `/admin/` 批准作品和回应。新网站身份不调用要求微信 openid 的文本检查，即便配置了微信服务也转人工。自动化服务故障不会自动放行。

人工模式网站关闭图片/视频上传入口和资产 API。已审核历史图片仍经原签名授权链路读取。如继续使用现有微信图片检查，配置 `REVIEW_PROVIDER=wechat`、有效的微信凭据和社团 uploads 能力，网页已有 JPEG/PNG 上传、清洗与检查流程；这条真实第三方审核链路未在本次调用验收。完全脱离微信的图片自动审核、人工图片审核和视频处理需要后续接入。不要在仅有人工文本审核时打开 uploads。

公开可见和导出能力仍由后端开关控制；现有“导出”尚未生成可下载文件，因此网站没有显示虚假的下载入口。上线前运营者应补齐隐私说明中的真实联系渠道，确认部署地区对应的网站备案要求。

## 备份与会话清理

同时备份 PostgreSQL 与私有媒体。包含网站凭据的数据库备份属于私密运维资料，不得放在公开下载目录。原 NAS 备份脚本的迁移数量也已更新为 27。网站 Compose 可停 API 和 worker 后，在 DB 容器运行 `pg_dump`，并保存 private-media volume；恢复到独立数据库后验证迁移账本和媒体清单。不要删除现有数据卷来“重跑初始化”。worker 每日清理过期/撤销的网站会话与旧限频桶。

## 自动验证

```sh
npm test
npm run check
npm run lint
# 显式使用可丢弃的、已迁移的测试数据库；该用例清理测试表中的限频记录。
PG_WEB_TEST_URL='postgresql://...' node --test tests/integration/web-migration-pg.test.mjs
```

浏览器用例在 `tests/browser/web-smoke.mjs`，要求显式 loopback URL 和 Playwright 路径。可用 `tests/support/seed-web-browser.cjs` 在可丢弃数据库生成测试夹具，之后运行网站服务；脚本拒绝公共网站地址。

```sh
PG_WEB_TEST_URL='postgresql://...' node tests/support/seed-web-browser.cjs
WEB_BROWSER_BASE=http://127.0.0.1:3000 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser/web-smoke.mjs
```

结果和截图在 `docs/evidence/2026-10-04-web/`。这些是本地开发验收证据，不代表已有生产数据库迁移或公网部署。
