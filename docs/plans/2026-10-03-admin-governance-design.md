# 管理后台、社团权限交接与邀请码 MVP 方案

**状态：开发规划。** 本文依据当前前后端源码与最后生效的 PostgreSQL 函数整理；不代表功能已实现、部署或验收。建议以独立 Web 管理端作为主要工作台，以小程序承担扫码登录、轻审批和移动确认。换届采用双方确认的权限交接流程，不做成员选举；任期结束只提醒，不自动撤权。平台开发者只执行平台配置和紧急恢复，不因该身份获得社团内容读取权限。

本次代码快照为前端 `39251de`、后端 `8bf5a1f`。相关源码仓库分别位于 `/Users/muwei/WeChatProjects/tdesign-miniprogram-starter` 和 `/Users/muwei/WeChatProjects/blacklight-development`。

本轮审查修复已完成原子限频和成员撤权后的附件拒绝；下文现状表描述审查基线，管理后台、换届和邀请码生命周期扩展仍为后续开发规划。

## 当前能力与主要缺口

| 范围 | 当前源码行为 | 规划影响 |
|---|---|---|
| 管理入口 | 管理页面位于小程序 `pages/admin` 分包：总览、合并审核队列、成员与邀请码、申诉、平台开发者社团管理。可见 [app.json](/Users/muwei/WeChatProjects/tdesign-miniprogram-starter/app.json:65) 与 [管理总览](/Users/muwei/WeChatProjects/tdesign-miniprogram-starter/pages/admin/index.wxml:16)。当前仓库没有独立 Web 管理端。 | Web 管理端需要新增独立前端和登录会话；继续复用现有后端业务规则，不迁移 service-role 凭据到浏览器。 |
| 社团审核与成员管理 | `admin`、`moderator` 都可以访问审核队列（包含被移除成员的恢复申请）；只有 `moderator` 能读名册、创建邀请码、移除/禁言成员和改角色。应用端与 SQL 都再次检查角色，成员变更带 `expectedVersion` 和理由，并防止移除或降级最后一名 moderator。见 [权限策略](/Users/muwei/WeChatProjects/blacklight-development/shared/policies.js:197)、[治理入口](/Users/muwei/WeChatProjects/blacklight-development/cloudfunctions/api/domain/governance.js:124)、[最终治理函数](/Users/muwei/WeChatProjects/blacklight-development/cloudbase/migrations/20261002090000_multi_club_tenancy.sql:1042)。 | 保留现有 API 的服务端授权边界，在 UI 中明确 `admin` 是审核权限，`moderator` 是社团管理权限。当前成员页仅取最多 100 人，后续 Web 端应提供游标分页和状态筛选。 |
| 社团平台管理 | `platformRole=developer` 是账号级角色。最终 SQL 支持社团列表、创建、改名/简介/发现/发布/上传开关、暂停/恢复和指定负责人；写入核对版本并写平台审计。见 [平台权限迁移](/Users/muwei/WeChatProjects/blacklight-development/cloudbase/migrations/20261003090000_platform_developer.sql:5)。 | 保留平台和社团权限隔离。`platformRole` 不自动转换成 `admin` 或 `moderator`，平台 API 只返回和操作社团元数据。 |
| 当前负责人 | `hg_platform_clubs` 将指定账号设为 `moderator` 并更新 `moderatorUserId`；既有 moderator 权限保留。社团列表 DTO 不返回 `moderatorUserId`，平台页面选择社团后也清空负责人输入框。该操作是加授/指定，不是换届。见 [SQL](/Users/muwei/WeChatProjects/blacklight-development/cloudbase/migrations/20261003090000_platform_developer.sql:73) 和 [平台页面](/Users/muwei/WeChatProjects/tdesign-miniprogram-starter/pages/admin/platform/index.js:26)。 | 增加可读的当前负责人、任期和交接记录；交接提交时同时回收离任者的管理角色，不能只改负责人指针。 |
| 邀请码 | moderator 可设置使用次数与有效期；服务端用 `FOR UPDATE` 锁邀请码后检查社团、期限和用量。当前实现首次有效使用可直接成为 `member`；已移除成员提交后仍保持 `removed`，进入 `manual_restore` 待人工批准。见 [生成函数](/Users/muwei/WeChatProjects/blacklight-development/cloudbase/migrations/20261002090000_multi_club_tenancy.sql:624)、[入社函数](/Users/muwei/WeChatProjects/blacklight-development/cloudbase/migrations/20261002090000_multi_club_tenancy.sql:524)。 | 新设计仅 `direct` 模式直入；`application` 模式改为人工审批；被移除成员两种模式都必须人工恢复；邀请码不能赋予角色。 |
| 邀请码生命周期与隐私 | 目前仅有创建和使用 API，没有邀请码列表或撤销 API。生成值为 12 位十六进制文本（48 bit），既是数据库行 ID，也保存在申请的 `inviteCode` 字段；待恢复审核队列会显示该文本，而 `admin` 和 `moderator` 都能访问该队列。见 [生成 SQL](/Users/muwei/WeChatProjects/blacklight-development/cloudbase/migrations/20261002090000_multi_club_tenancy.sql:638)、[申请记录](/Users/muwei/WeChatProjects/blacklight-development/cloudbase/migrations/20261002090000_multi_club_tenancy.sql:572)、[队列 DTO](/Users/muwei/WeChatProjects/blacklight-development/cloudfunctions/api/domain/moderation.js:334)、[队列权限](/Users/muwei/WeChatProjects/blacklight-development/shared/policies.js:284)。 | 使用高熵随机码并只存哈希；新增列表、撤销、版本和理由；队列只显示邀请记录编号或类型，不能显示秘密码。 |
| 猜码限制 | `membership/apply` 先对用户计数做读取，再另行递增；并发请求可能同时读到未超限状态，递增失败也被忽略。见 [限频实现](/Users/muwei/WeChatProjects/blacklight-development/shared/session.js:124)。 | 对邀请码校验增加原子限频与失败次数监控，避免并发猜码绕过单用户上限或存储故障时失效。 |

现有入社和恢复事务已经按 `clubId` 隔离，申请批准也核对申请社团及 `expectedVersion`，批准后固定建立普通 `member` 资格。[最终入社函数](/Users/muwei/WeChatProjects/blacklight-development/cloudbase/migrations/20261002090000_multi_club_tenancy.sql:535) 与[申请批准分支](/Users/muwei/WeChatProjects/blacklight-development/cloudbase/migrations/20261002090000_multi_club_tenancy.sql:1284)是本方案继续沿用的边界。新增数据库结构必须追加新迁移，不回改已应用迁移。

## 目标角色矩阵

角色授权都由服务端当前账号、目标 `clubId` 和数据库中的角色决定。浏览器、小程序请求体中的 `userId`、`role`、`platformRole` 只作输入，不作为授权事实。

| 身份 | 范围 | MVP 权限 | 明确不授予 |
|---|---|---|---|
| 访客 | 当前社团公开能力 | 浏览允许公开的内容、查看入社状态 | 审核、成员管理、邀请码管理、社团配置 |
| 申请中 / 已移除 | 单个社团 | 查看本人申请状态；已移除成员可凭新邀请码提交恢复申请 | 任何社团管理权限；邀请码不会自动恢复已移除账号 |
| `member` | 单个社团 | 普通成员能力、申请管理角色 | 审核、邀请、角色变更、换届 |
| `admin`（界面显示“审核管理员”） | 单个社团 | 内容、评论、话题、成员恢复申请、申诉等已授权审核操作 | 成员名册、邀请码、成员角色、负责人交接 |
| `moderator`（界面显示“社团负责人”） | 单个社团 | 审核权限，加成员、禁言、移除、普通角色管理、邀请码、本社团简介/章程/入社模式、发起正常交接 | 修改平台能力上限、创建/暂停其他社团、跨社团读取内容 |
| `platformRole=developer` | 平台 | 平台能力上限和初始配置；负责人失联时发起/复核紧急恢复 | 默认内容读取、匿名映射读取、代替社团审核；角色本身不赋予任何社团成员权限 |

`admin` 与 `moderator` 的现有英文角色值先保留，以免角色数据迁移扩大首期范围；在 Web 和小程序中按上述工作职责标注。平台开发者若本来就是某社团成员，其社团权限仍只由该社团 membership 决定。

## Web 管理端与小程序登录

独立 Web 是成员名册、邀请码、社团设置、负责人团队和交接的主要操作台。固定七个入口：概览/待处理审核、成员、邀请码、社团设置、本届管理团队与换届、操作审计、平台管理（仅 developer）。小程序保留日常内容审核，并提供扫码登录、恢复申请处理、负责人交接接受/拒绝等轻审批。浏览器不能把 `wx.login` 当作登录实现，也不直接保存 `service_role`、API Key 或可长期复用的云函数凭据。

`社团设置`允许 moderator 修改本社团简介、章程和入社模式，并通过新规则版本约束之后提交的申请；不允许修改 `publishing`、`uploads` 等平台能力开关或突破 developer 配置的上限。`操作审计`仅返回当前社团脱敏的角色、邀请、配置和交接事件；平台审计另由 developer 查看。

1. 浏览器向 Web 后端申请登录事务。服务端生成随机 `transactionId` 与浏览器私有轮询凭据，事务只保留约 2 分钟；数据库只存凭据哈希和过期时间。
2. 页面展示二维码及 Web 来源、申请的社团范围和权限类型。二维码只带事务标识，不包含浏览器轮询凭据或 Web 会话凭据。
3. 小程序扫码后，批准请求携带现有 NAS Bearer session。NAS `server/auth.resolveBearerIdentity` 从 Authorization Bearer 读取 token、以哈希查询 `hg_sessions` 并检查撤销/过期，再由 `ctx.viewer` 提供批准者身份；二维码参数和请求体中的 `userId` 不参与授权。批准前服务端读取最新 `platformRole` 或指定社团的 active membership。小程序明确展示“哪个账号正在授权哪个 Web 会话”，用户确认后服务端以一次性 CAS 将事务设为已批准。
4. 浏览器只用未暴露给二维码的轮询凭据读取批准结果，再以单次兑换码建立短时 Web 会话。Web 会话可用 `Secure`、`HttpOnly`、`SameSite` Cookie，不放入 `localStorage`；NAS 新增的 Web 会话解析必须与小程序现有 Bearer resolver 使用同一服务端身份和角色核验规则。
5. 每次受保护请求按服务端会话恢复账号和社团范围，并重查当前角色与 membership/version。换届、移除、社团暂停或开发者授权撤销后，旧 Web 会话失效；跨社团切换需要再次通过服务端授权。

MVP 的 Web 会话建议 30 分钟无操作失效、8 小时绝对失效；高影响写请求带 CSRF 防护、当前权限核验、`expectedVersion` 和理由。扫码事务限频，显示的域名必须与 Web 来源一致；拒绝、过期、重复扫码或重复兑换均失败关闭。

## 负责人任期、交接与失联恢复

换届是现任管理团队把权限交给新一届团队的业务流程，不是由系统统计投票或自动选举。`termEndAt` 只触发 Web 首页提醒和小程序通知，日期到达不会降低角色，也不会让社团无人管理。权限继续使用现有固定角色 `admin`、`moderator`、`member`；不引入可配置权限树或泛用 RBAC。

社团记录当前 `managementTermId`，每个管理团队成员记录该 term ID；本届管理团队由同一社团、active membership 且角色为 `admin` 或 `moderator` 的记录组成。历史届次保留成员、角色与起止时间快照。新一届团队清单必须显式列出继任者、团队角色和续任成员，并至少有一名 active `moderator`。MVP 建议每社团一次只允许一个未完成交接：

| 状态 | 转移 | 服务端条件和效果 |
|---|---|---|
| `proposed` | `completed` | `accept` 请求由继任负责人发起。单一 DB 事务内验证双方身份、社团、本届 `managementTermId`、上一届团队名单/成员版本和提案版本；记录继任者接受事件，立即完成换权和审计后提交。提案默认 7 天过期。 |
| `proposed` | `rejected` / `cancelled` / `expired` | 继任者拒绝、发起人取消、或超时；记录 actor、时间、原因及版本，不改变任何角色。 |
| `proposed` | `stale` | 接受事务发现发起人/目标角色或社团版本已改变；回滚全部换权，记录冲突并要求刷新后重提。 |
| `recovery_requested` | `completed` / `recovery_rejected` / `expired` | 仅平台开发者可为负责人失联建立恢复工单；目标接受与开发者复核齐备时，最终批准事务直接完成上一届回收和新团队授予，不保留“已接受、尚未换权”的持久中间状态。 |

`accepted` 只作为换届接受审计事件，不是持久业务状态；MVP 不设置后台任务去完成一个已接受但尚未换权的提案。

交接完成要回收的是上一届所有未续任 `admin`/`moderator` 管理授权，而不是删除或转移他们的帖子、评论、媒体、收藏等用户数据。新旧团队名单、每个管理角色和 `managementTermId` 必须在同一事务更新；不允许只改负责人指针而留下上一届管理权限。任何并发角色变更、移除或另一个提案都必须由届次、社团版本和 membership 版本阻止旧操作覆盖新状态。整个流程保持至少一名 active moderator；提交后响应丢失时用事务 ID 和已记录结果幂等重试。

交接清单也包含上一届仍有效的邀请码。邀请码记录 `issuedManagementTermId`；未使用的上一届 `direct` 码默认在交接事务中撤销，公开招新的 `application` 码由新团队在交接清单中显式选择保留，未选择则撤销。已提交且预留仍有效的申请继续由新团队审批，不重复扣额度。这样离任者保留的旧码不会继续产生未经新团队接手的直入资格。

失联恢复是 break-glass 路径，不给开发者常态管理权。默认规则建议：只有经平台核验的开发者可创建恢复工单；若另有开发者可复核，要求第二人批准；否则使用至少 24 小时冷却期并向原负责人及社团发通知，保留完整审计。目标需主动接受，且优先要求已是该社团 active member；如确需恢复外部账号，先通过正常入社流程取得普通成员资格。目标接受和平台复核可先记为审计事件；最后一项必需确认到达时，在同一事务完成换届。若仍有可用社团负责人，应优先走正常交接，不走开发者恢复。

## 邀请码状态与数据规则

邀请码只表示“申请或加入普通成员”的资格，永远不能携带 `admin`、`moderator`、开发者角色或绕过移除处罚。`invite.mode` 由服务端记录并决定流程；客户端不能选择 direct 模式、目标账号或角色。角色升级走已授权管理接口，需具体目标、membership 版本、理由和审计。

| `invite.mode` | 用途与领取规则 | 首次入社结果 |
|---|---|---|
| `application` | 默认的公开招新码，可限制次数与有效期；领取人提交规则版本和昵称，进入人工审批队列。 | 申请获批后建立普通 `member` membership。 |
| `direct` | 负责人定向单次推荐；创建时绑定一个已存在的 `targetUserId`，`maxUses=1`，只有该账号能领取。 | 被绑定的新账号验证通过后直接成为普通 `member`。 |

无既有账号可绑定时使用 `application`；不提供未绑定的 direct 邀请，以免可转发的一次性码变成任何人都可抢先领取的通道。两种模式均绑定同一 `clubId`、规则版本和邀请码版本。已移除账号不论邀请码模式如何，永远进入 `manual_restore`，不能自动重新加入或恢复任何旧管理角色。

| 邀请状态 | 进入条件 | 允许动作 |
|---|---|---|
| `active` | 创建成功、未过期、未撤销且仍有可用额度 | 根据 `mode` 进入公开人工申请或绑定账号直入；removed 账号一律申请恢复。 |
| `exhausted`（派生） | 当前 `usedCount + reservedCount` 达到 `maxUses` | 暂时拒绝新兑换；若预留申请被拒绝、取消或到期释放，且邀请码仍未过期/撤销，则重新变为可用。`usedCount` 已消费次数不回退。 |
| `expired` | 服务端时间超过 `expiresAt` | 拒绝新兑换；不依赖客户端时间。 |
| `revoked` | moderator 按版本撤销并填写理由 | 拒绝后续兑换；终态，不提供恢复按钮。只有 `revoked` 和 `expired` 是不可恢复状态。 |

生成 128 bit 或更高熵的随机码，用易输入编码；只在创建响应中显示一次。数据库存稳定 `inviteId`、`clubId`、`codeHash`、状态、最大次数、已用/预留次数、过期时间、版本、创建者和撤销审计，不存原码。高熵随机码可用 SHA-256 哈希查找；若采用服务端 pepper/HMAC，还要规划密钥轮换。原码不进入 API 日志、审计、申请记录、审核卡片或错误文案。

申请保存 `inviteId`、兑换时的 `inviteVersion`、`clubId`、`rulesVersion` 和应用版本，不保留 `inviteCode`。创建请求在目标社团事务内锁定邀请码，核对社团、当前状态、额度与规则版本后，再原子写申请和计数。审批核验的是申请记录中的兑换版本快照以及 `clubId`/申请版本，不要求当前邀请码仍处于原版本；后续撤销或过期不会因 `inviteVersion` 改变而自动拒绝仍在 72 小时预留期内的申请。

- `application` 新账号：申请创建后预留一次额度，不建 active membership；批准时从 reserved 转为 used 并建立 `role=member` membership。
- `direct` 绑定的新账号：领取成功立即消费一次额度，原子建立 `status=active, role=member` membership。
- 已移除账号：无论 mode 都建立 pending restore 并预留额度，membership 保持 `removed`。审批仍按 `expectedApplicationVersion` 和 `clubId` 检查，批准只恢复 `member`，不恢复旧管理角色。
- 预留默认有效 72 小时，申请记录 `reservationExpiresAt`。期限内批准则 reserved 转为 used；拒绝、取消或到期则释放额度并将申请置为终态。由定时清理或下一次锁定该邀请码的兑换事务幂等释放过期预留；过期申请不能继续批准，用户须用新邀请码重新申请。邀请码后来被撤销或自然过期时，只阻止新领取；已经建立且预留未过期的申请仍可决定，批准按申请保存的 `inviteVersion` 快照核验，不与当前邀请码版本比较。
- `GET` 邀请列表只返回邀请 ID、有效状态、期限、次数、版本和创建/撤销时间。撤销使用邀请 ID、`expectedVersion` 和理由；并发兑换与撤销以同一邀请行锁排序，已提交的兑换保持有效。

邀请码主键迁移分阶段完成，不直接一次性重写 `id`。第一阶段追加 `opaqueInviteId`、`codeHash` 及唯一查找索引/映射；新码使用 opaque ID，旧码暂留原 codeId。第二阶段兑换函数先按规范化码的 hash 查 mapping，未命中时才双读旧 codeId；申请记录和审核 DTO 同时切换为 `inviteId`，新增应用不再写原码。回填所有有效旧码的 hash/opaque ID/应用关联后，观测一段时间确保旧键 fallback 不再命中。第三阶段在隔离 PG 核对关系和计数后再迁移旧行 ID/`doc._id` 为 opaque ID，并移除原文列/字段及 fallback。每阶段可验证、可回滚；旧有效码在切换期保持可兑换。存储函数必须对照旧记录处理 mode：建议未绑定旧邀请码回填为 `application`，直入用途另发绑定账号的 `direct` 码。

主要尝试额度按账号、社团和窗口原子计数，覆盖所有兑换尝试，包括成功领取和幂等重试；建议延续当前 5 次/10 分钟作为初值，并用幂等键保证重复请求不重复建申请/扣额度。可另设较宽松的失败猜码预算。限频写入必须先在独立已提交事务或限频服务中落账，再调用有可能抛业务异常的兑换事务，不能让失败次数随申请回滚；限频组件失效时失败关闭。对外统一返回“邀请码无效或已过期”，避免枚举有效、过期、用尽与撤销状态。

## API 与数据库改动范围

先复用现有 `admin/*` 与 `platform/clubs/*` 路由习惯，所有请求中的 actor 从服务端会话取得，社团范围由 Web 会话确定。平台开发者接口和社团 moderator 接口必须分开：平台接口只改社团元数据/负责关系；社团接口只管自身社团成员、邀请和审核。

| 接口组 | 建议动作 | 授权边界 |
|---|---|---|
| Web QR 登录 | `POST /auth/qr`、`GET /auth/qr/:id`、小程序 `POST /auth/qr/:id/approve`、`POST /auth/exchange`、`POST /auth/logout` | QR 创建者凭私有轮询凭据换会话；批准者身份来自 NAS Bearer session resolver，且具有对应范围角色；事务和兑换码均一次性。 |
| 概览/审核 | `GET /admin/overview`、复用现有待处理审核队列 | `admin`、`moderator`；DTO 仅含当前社团的可操作项目。 |
| 社团成员 | 复用名册/角色/禁言/移除接口，新增游标、状态筛选 | `moderator`，目标 membership 必须属于会话社团；所有写操作必须带版本和理由。 |
| 邀请 | 新增 `GET /admin/invites`、`POST /admin/invites`、`POST /admin/invites/:inviteId/revoke`；创建体包含 `mode`，direct 必须带目标账号 | 仅当前社团 `moderator`；DTO 不返回哈希或原码。 |
| 社团设置 | 新增 `GET /admin/club/settings`、`PATCH /admin/club/settings` | 仅本社团 `moderator`；SQL allowlist 只含简介、章程、入社模式，并在规则变化时递增 `rulesVersion`，不包含平台能力开关。 |
| 本届团队与换届 | `GET /admin/management-team`、`GET/POST /admin/handovers`、`POST /admin/handovers/:id/accept`、`POST /admin/handovers/:id/cancel` | 当前届负责人发起，继任负责人本人 accept；accept 一个事务内核对双方、届次、角色和版本并完成换届，不保留 accepted 半状态。 |
| 操作审计 | `GET /admin/audit?cursor=` | moderator 查看本社团的脱敏成员/邀请/设置/换届操作；platform audit 与内容审计保持独立。 |
| 恢复处理 | `POST /platform/clubs/:id/recovery`、`POST /platform/recovery/:id/approve` | 仅 developer + 双人复核或冷却期；绝不因此放宽内容接口权限。小程序只提供目标接受和轻审批。 |
| 平台管理 | 复用 `/platform/clubs/*`，增加独立平台审计视图 | 仅 developer；控制创建、暂停和能力上限，不访问社团内容。 |

建议追加迁移包含：邀请码 `mode`、目标账号、`issuedManagementTermId`、opaque ID/hash/version/revocation 字段及唯一索引；申请的 `inviteId`、预留版本和到期时间；分阶段 hash mapping；`hg_management_terms` 届次记录与管理团队快照；`club_config.managementTermId` 和本届管理 membership 上的 `managementTermId`；handover/recovery 状态记录；本社团基本设置字段及版本；对未完成交接和邀请兑换的并发约束。首迁移为现有社团按当时 active `admin`/`moderator` 建立首届记录，不自动挑选或降级团队成员。权限仍通过 `SECURITY INVOKER` RPC + 明确 `REVOKE PUBLIC/anon/authenticated`、仅授予 `service_role`，业务函数内部重新核验 actor、`clubId`、角色、目标状态和版本。

## 开发阶段与验收边界

1. **权限和数据契约**：锁定上方角色矩阵、团队名单/续任语义、任期提醒周期、两种 invite mode、预留期限、撤销对未决申请的影响和恢复审批规则；将结果写入 API 契约与状态转换表。
2. **数据库迁移与 RPC**：在隔离 PostgreSQL 分阶段追加 opaqueInviteId/hash mapping、双读、回填、清除明文；实现 mode 分支、预留释放、列表/撤销、团队换届和恢复事务。先用数据库集成用例覆盖并发和跨社团隔离。
3. **后端认证**：新增 QR pairing、单次 exchange 和短时 Web session；扫码批准复用 NAS `resolveBearerIdentity` 与 `hg_sessions`，服务端角色重查、会话撤权、CSRF、审计与限频；不以 CloudBase 微信上下文作为 NAS 身份来源。
4. **Web 管理端与小程序轻审批**：实现七个入口：概览/待处理审核、成员、邀请码、社团设置、本届管理团队与换届、操作审计、developer 专属平台管理。小程序保留审核队列、扫码批准和少量明确审批，不做完整桌面名册编辑。
5. **隔离集成验收**：用访客、member、admin、moderator、platform developer 与被移除账号验证 API 与 UI；然后在 NAS stage 用两个以上真实测试账号完成扫码、交接、恢复和邀请码闭环。模拟器、stage、正式云端、体验版、真机和正式发布分层记录；本规划不授权上传体验版、生产迁移或正式发布。

验收至少覆盖以下场景：

- 普通用户或 `admin` 不能进入名册、邀请、设置或交接；跨社团 ID、伪造 `userId`/role 和暂停社团请求均失败。`admin` 仍可处理已有审核队列中的成员恢复申请。
- QR 被非管理员扫码、事务过期、浏览器凭据泄露到 QR、一次码重复兑换、成员角色撤销后的旧会话访问都被拒绝；合法扫码由正确账号确认后，只取得该账号当时拥有的权限。
- 同时发起两次交接、旧负责人先被移除、目标成员被禁用、提案版本过期等竞争只能有一个确定结果；换届成功后旧人仍是 member 且内容存在，但管理写入和 Web 会话已失效。
- 任期到期只出现提醒，账号没有被自动降级；换届 accept 和最后一项恢复批准各自在一个事务中完成受检授权、团队更新、接受记录与审计，不留下半完成状态。平台开发者无内容读取能力，紧急恢复必须有目标接受、理由和平台审计。
- 并发兑换尝试受账号+社团主额度限制，含成功和幂等重试；实际入社数不超过邀请码额度。`application` 新账号进入人工队列，绑定目标的 `direct` 新账号单次直入；removed 在两种 mode 下都只能 pending restore，申请绑定同一 `clubId`、invite 版本和预留期限。
- 预留批准后转为 used，拒绝/取消/到期释放；释放后 `exhausted` 可重新 active，但 revoked/expired 不可恢复。失败计数在业务异常回滚后仍保留，邀请码不能提升角色。
- 日志、审计和恢复审核 DTO 均不包含原码或 `codeHash`；失效码返回统一错误，不泄露是否曾经有效。

## 推荐默认值与待产品确认项

这些选择作为开发默认值即可，不需要先暂停规划；如产品后续选择不同，再调整状态规则与权限表。

- **后台形态**：独立 Web 是主要管理端；小程序通过扫码授予短期一次性会话，并保留移动轻审批。
- **角色语义**：`admin` 是审核管理员；`moderator` 是有成员治理和换届权限的社团负责人；平台 developer 是独立平台权限。
- **任期**：建议默认一年，30 天和 7 天提醒，到期只提示换届；不自动收回权限。
- **交接**：指定负责人提出、继任者确认后原子完成；离任者降为普通 member；不投票、不迁移内容。
- **失联恢复**：仅平台开发者处理；目标需接受；第二位开发者复核，缺少第二人时至少等待 24 小时并通知原负责人；开发者不因此获得内容访问。
- **邀请码**：默认 `application` 公开招新、建议 100 次/7 天且需人工审批；`direct` 单次并绑定一个已存在账号后直入；两种都只授予 member，removed 永远走人工恢复。pending 预留默认 72 小时；撤销不回滚已提交且预留未过期的申请。账号+社团主限额默认覆盖所有兑换尝试，每 10 分钟 5 次。

## 源码依据

- 前端管理分包与工作台：[app.json](/Users/muwei/WeChatProjects/tdesign-miniprogram-starter/app.json:65)、[管理总览](/Users/muwei/WeChatProjects/tdesign-miniprogram-starter/pages/admin/index.wxml:2)、[成员页](/Users/muwei/WeChatProjects/tdesign-miniprogram-starter/pages/admin/members/index.js:13)、[平台页](/Users/muwei/WeChatProjects/tdesign-miniprogram-starter/pages/admin/platform/index.js:5)。
- NAS Bearer session resolver：[auth.js](/Users/muwei/WeChatProjects/blacklight-development/server/auth.js:81)、[NAS API 注入 resolver](/Users/muwei/WeChatProjects/blacklight-development/server/index.js:72)、[前端 Bearer 请求](/Users/muwei/WeChatProjects/tdesign-miniprogram-starter/api/request.js:296)。
- 后端路由与 actor 注入：[api/index.js](/Users/muwei/WeChatProjects/blacklight-development/cloudfunctions/api/index.js:102)、[router.js](/Users/muwei/WeChatProjects/blacklight-development/shared/router.js:39)。
- 角色策略和成员接口：[policies.js](/Users/muwei/WeChatProjects/blacklight-development/shared/policies.js:197)、[governance.js](/Users/muwei/WeChatProjects/blacklight-development/cloudfunctions/api/domain/governance.js:124)、[platform.js](/Users/muwei/WeChatProjects/blacklight-development/cloudfunctions/api/domain/platform.js:5)。
- 最后生效的数据库逻辑：[多社团治理与邀请码 migration](/Users/muwei/WeChatProjects/blacklight-development/cloudbase/migrations/20261002090000_multi_club_tenancy.sql:524)、[平台 developer migration](/Users/muwei/WeChatProjects/blacklight-development/cloudbase/migrations/20261003090000_platform_developer.sql:1)。
