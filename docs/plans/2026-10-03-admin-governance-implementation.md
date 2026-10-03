# 社团管理建设 Implementation Plan

> For agentic workers: use subagent-driven-development task boundaries below; user has authorized execution in worktrees. Track implementation, verification and review in progress.md; continue without routine approval gates.

**Goal:** Deliver a working local MVP for independent Web administration, invitation lifecycle, management team handover and Mini Program confirmations.
**Architecture:** Reuse NAS Node HTTP + PostgreSQL and existing action router. Serve vanilla Web assets at `/admin/` from backend `admin-web/` on the same origin. Browser auth uses short sessions in HttpOnly cookies, QR pairing approved through trusted NAS bearer identity in the Mini Program. All writes recheck roles, club scope and versions inside transactions.
**Tech Stack:** Existing Node.js/CommonJS, PostgreSQL 16, vanilla browser JS/CSS/HTML, existing WeChat/TDesign app. A small QR encoder dependency is allowed if needed; no new framework or general RBAC engine.
**Spec:** [design](2026-10-03-admin-governance-design.md).

## Global constraints

- Main repositories remain untouched. Backend worktree: `/Users/muwei/WeChatProjects/.codex-worktrees/blacklight-admin-governance-20261003`; Mini Program worktree: `/Users/muwei/WeChatProjects/.codex-worktrees/shudong-admin-governance-20261003`. Both branches: `codex/admin-governance-20261003`.
- Baselines backend `2d74c01`, frontend `aa4d2ad`; do not remove previous fixes or unrelated worktrees. No remote push, real data migration, stage/production deployment, account grants, invite consumption or public release in this task.
- Existing roles remain: admin = reviewer, moderator = club management, platform developer = platform metadata/recovery only. Private/anonymous content policy remains unchanged.
- Append migrations 25 `20261003100000_admin_governance.sql` and 26 `20261003110000_admin_web_auth.sql`; do not edit applied migrations. Migration helper/health/tests must expect 26.
- All UI text Chinese. Actor always server-derived; payload targetUserId is a target, not identity. DTO whitelist; no raw invite/hash, auth tokens, private content or signed URLs in logs/audits.
- Normal handover accept completes all membership, term, leader, invite and audit changes in one transaction. No durable half-completed accepted status.
- QR approval confirms browser origin and intended management scope. Web sessions expire after 30-minute idle / 8-hour absolute max; pairing 2 minutes. Cookies Secure in production, HttpOnly, SameSite; CSRF + exact Origin for cookie-authenticated writes.
- Development validation uses isolated blacklight_test DB and synthetic account code exchange only. Report browser, simulator, local HTTP/PG and real-device/production separately.

## Shared interfaces

Canonical new business RPC:
`hg_admin_management(p_actor_id text, p_action text, p_input jsonb, p_club_id text) -> jsonb`.
Actions: `overview`, `members.list`, `invites.list/create/revoke`, `settings.get/update`, `team.get/primary`, `handovers.list/create/accept/cancel/decline`, `audit.list`, `recovery.list/request/accept/approve`.
New invitation apply RPC:
`hg_apply_invitation(p_actor_id text, p_input jsonb, p_club_id text) -> {state, applicationId}` where input has `codeHash`, displayName, rulesVersion, idempotencyKey. New managed membership decision RPC may wrap existing moderation for other content without weakening it.
Lists use `{items,nextCursor}`; requests use `{cursor,limit,status}`. Writes use `{expectedVersion,reason}`. Team DTO `{term:{id,version,primaryUserId,startAt,endAt},members:[{targetUserId,displayName,role,status,version}],pendingHandover}`.
Invitation create input `{mode:'application'|'direct',maxUses,ttlSeconds,targetUserId?,reason}`. API generates 128-bit code and hash; SQL stores hash + opaque id only. Create returns code once alongside `{inviteId,mode,status,maxUses,usedCount,reservedCount,expiresAt,version}`. Direct must bind an existing active account and is single use. Removed accounts always pending manual_restore; application mode always pending manual_join. Pending reservation expires after 72h; release on reject/cancel/expiry; invite revocation/expiry does not invalidate an unexpired submitted reservation snapshot.
Handover create input `{targetUserId,team:[{targetUserId,role,expectedVersion}],expectedVersion,reason,termEndAt?,retainInviteIds:[]}`; accept input `{id,expectedVersion}`. Preserve all member content. Revoke previous-term direct codes, retain only explicitly selected application codes. Existing clubs without primary keep all roles; moderator explicitly selects primary from current moderators via team/primary CAS.

Action API bindings (through `/v1/action` and browser `/v1/admin/action`):
`admin/overview`, `admin/members/list`, existing member remove/mute/role;
`admin/invites/list`, existing `admin/invites/create`, `admin/invites/revoke`;
`admin/club/settings`, `admin/club/update`, `admin/management/team`, `admin/management/primary`;
`admin/handovers/list/create/accept/cancel/decline`, `admin/audit/list`;
`platform/recovery/list/request/approve`, `account/recovery/list/info/accept/decline`, `account/handovers/list`, `membership/cancel`;
`account/web-login/info/approve/reject` (account-wide route context; must not require current club).
Existing moderation and platform actions remain available by current server permission. Web endpoint filters action whitelist and resolves identity through cookie to the normal router; never converts a client role to authority.

Browser auth HTTP contract:
`POST /v1/admin/auth/pairings` -> `{id,qrText,qrSvg?,expiresAt,pollKey}`;
`POST /v1/admin/auth/pairings/status` body `{id,pollKey}` -> `{status,exchangeCode?}`;
`POST /v1/admin/auth/exchange` body `{id,pollKey,exchangeCode}` -> cookie + `{csrfToken}`;
`GET /v1/admin/session` -> `{user:{id,displayName},platformRole,clubs:[...],csrfToken}`;
`POST /v1/admin/action` body `{action,clubId,payload}`, header X-CSRF-Token;
`POST /v1/admin/auth/logout` revokes cookie session.
Mini QR: `blacklight-admin:<id>`; info/approve/reject payload `{id}`. Info DTO only `{id,status,origin,expiresAt}`; pairing poll key never included in QR/mini info. Member-only successor accepts handover/recovery via normal Mini bearer actions, not through an unauthorized Web session.

## Review focus

- Cross-club ids, stale membership/role/term versions and old browser sessions must fail closed.
- Parallel last-slot redemptions, duplicate approvals and revocation/expiry races must preserve quotas and single membership creation.
- Handover racing member role edits or paused clubs must preserve one valid team and never delete content.
- Pairing theft/replay, Origin mismatch, missing CSRF, expired/revoked cookies and role downgrade must not grant management access.
- UI async results must stay within selected club; plain invitation codes must never reach ordinary list/queue/audit responses.

## Tasks

- [ ] Task 1 — DB business: migration 25, safe legacy invite backfill and RPCs for invitation/reservations, settings, pagination/audit, teams, handover and controlled platform recovery. Own only migration 25, tests/integration/admin-governance*, scripts/local-apply-migrations.sh, deploy/nas/healthcheck-pg.sh, local-runtime migration-count assertion. Add real PG transactional/concurrent/role tests, red then green. Recovery requires target acceptance; second developer approval or at least24h cooldown, same operator cannot shortcut two-person requirement.
- [ ] Task 2 — Backend runtime/auth: migration26 Web auth tables, server/admin-web-auth.js and static/auth HTTP routes, management domain handlers, router account-wide exceptions, RPC allowlist, invitation hashing+current membership decision adapter, sanitized queue DTOs, Docker packaging/CI PG wiring. Own server/*, shared/*, cloudfunctions/api/*, migration26, package*, deploy/nas/Dockerfile.app, .gitea workflow, new backend tests excluding Task1 files. Tests for auth replay/role revocation/CSRF/Origin, DTO secrets and handler contract; reuse Task1 SQL. Must coordinate DTO changes with Task3.
- [ ] Task 3 — Interfaces: backend admin-web/ assets with login/QR, overview/review, member management, invite list/create/revoke, club settings, team/handover, audit, platform/recovery. Mini worktree service endpoints/transports + `pages/admin/web-login` and `pages/admin/management` successor confirm/reject screens; update member invite form and join messaging for application/direct. Own backend admin-web/** only and all frontend changes. Tests for role visibility, club-switch stale responses, one-time code handling and confirmation states. Frontend check/lint/test required.
- [ ] Task 4 — Integration and verification: controller establishes disposable PG26 and real API fixtures; verifies all role/club/term/invite/auth flows through HTTP, browser and WeChat IDE. Reviews code and fixes discovered integration gaps through owning agents. Retain evidence, update docs/contracts/progress, scoped commits in worktrees; leave main/remote unchanged.

## Checks

Backend `npm run sync`, `npm run check`, `npm run lint`, `npm test`; explicit PG suites after all26 migrations. Frontend `npm run check`, `npm run lint`, `npm test` with BLACKLIGHT_BACKEND_WORKTREE set to this worktree. Actual Web browser and WeChat developer tools interactions on synthetic identities, no upload/release. Keep code and evidence even if external WeChat real-device auth is unavailable; describe the precise boundary.

Controller integration additions: account-wide target-only handover/recovery inbox enables ordinary members and paused-club targets to review/confirm without a selected club. Applicant cancellation releases unexpired reservations atomically. Settings admissionMode invite_required/closed only gates new invitation redemption, never advertises code-free join.
