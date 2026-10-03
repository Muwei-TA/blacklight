import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

const databaseUrl = process.env.PG_TEST_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/blacklight_test' || process.env.HG_TEST_DATABASE_RESET !== 'yes') {
  throw new Error('Use an isolated blacklight_test database and HG_TEST_DATABASE_RESET=yes; never run on application data.');
}

const migrationSql = await readFile(new URL('../../cloudbase/migrations/20261003100000_admin_governance.sql', import.meta.url), 'utf8');
const managementFunctionSql = migrationSql.match(/CREATE FUNCTION public\.hg_admin_management\([\s\S]*?\nEND \$\$;/)?.[0];
const applyInvitationFunctionSql = migrationSql.match(/CREATE FUNCTION public\.hg_apply_invitation\([\s\S]*?\nEND \$\$;/)?.[0];
const serviceRolePoliciesSql = [...migrationSql.matchAll(/DROP POLICY IF EXISTS [^;]+;\s*CREATE POLICY [^;]+;/g)].map(([sql]) => sql);
if (!managementFunctionSql || !applyInvitationFunctionSql || serviceRolePoliciesSql.length !== 4) {
  throw new Error('Could not isolate governance functions and policies for transaction-local integration tests.');
}

async function withMigration(client, callback) {
  const installed = await client.query("SELECT to_regprocedure('public.hg_admin_management(text,text,jsonb,text)') IS NOT NULL AS value");
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL TIME ZONE 'Asia/Shanghai'");
    if (installed.rows[0].value) {
      await client.query(managementFunctionSql.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
      await client.query(applyInvitationFunctionSql.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
      for (const policySql of serviceRolePoliciesSql) await client.query(policySql);
    } else {
      await client.query(migrationSql);
    }
    return await callback(!installed.rows[0].value);
  } finally {
    await client.query('ROLLBACK');
  }
}

test('admin governance exposes scoped service-role PostgreSQL contracts', async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await withMigration(client, async () => {
      const result = await client.query(`
      SELECT
        to_regprocedure('public.hg_admin_management(text,text,jsonb,text)') IS NOT NULL AS management,
        to_regprocedure('public.hg_apply_invitation(text,jsonb,text)') IS NOT NULL AS invitation,
        to_regprocedure('public.hg_decide_membership_application(text,jsonb,text)') IS NOT NULL AS membership_decision,
        to_regprocedure('public.hg_moderate(text,text,jsonb,text)') IS NOT NULL AS legacy_moderate
      `);
      assert.deepEqual(result.rows[0], {
        management: true,
        invitation: true,
        membership_decision: true,
        legacy_moderate: true,
      });
      const privileges = await client.query(`
      SELECT
        has_function_privilege('service_role', 'public.hg_admin_management(text,text,jsonb,text)', 'EXECUTE') AS management,
        has_function_privilege('service_role', 'public.hg_apply_invitation(text,jsonb,text)', 'EXECUTE') AS invitation,
        has_function_privilege('service_role', 'public.hg_decide_membership_application(text,jsonb,text)', 'EXECUTE') AS membership_decision,
        has_function_privilege('anon', 'public.hg_admin_management(text,text,jsonb,text)', 'EXECUTE') AS anon_management,
        has_function_privilege('authenticated', 'public.hg_admin_management(text,text,jsonb,text)', 'EXECUTE') AS authenticated_management
      `);
      assert.deepEqual(privileges.rows[0], {
        management: true,
        invitation: true,
        membership_decision: true,
        anon_management: false,
        authenticated_management: false,
      });
      const tables = ['hg_invitation_rate_limits', 'hg_invite_codes', 'hg_management_requests', 'hg_management_terms'];
      const policies = await client.query(`
        SELECT tablename,roles::text,cmd,qual,with_check FROM pg_policies
        WHERE schemaname='public' AND policyname=ANY($1::text[]) ORDER BY tablename
      `, [tables.map((table) => `${table}_service_role_all`)]);
      assert.equal(policies.rows.length, tables.length);
      for (const policy of policies.rows) {
        assert.equal(policy.roles, '{service_role}');
        assert.equal(policy.cmd, 'ALL');
        assert.equal(policy.qual, 'true');
        assert.equal(policy.with_check, 'true');
      }

      await client.query('SET LOCAL ROLE blacklight_app');
      const probe = `admin-governance-rls-${process.pid}`;
      await client.query('INSERT INTO public.hg_management_terms(id,doc) VALUES($1,$2::jsonb)', [
        `term:${probe}`, JSON.stringify({ _id: `term:${probe}`, clubId: probe }),
      ]);
      await client.query('INSERT INTO public.hg_management_requests(id,doc) VALUES($1,$2::jsonb)', [
        `request:${probe}`, JSON.stringify({ _id: `request:${probe}`, clubId: probe }),
      ]);
      await client.query(`INSERT INTO public.hg_invitation_rate_limits(user_id,club_id,window_started_at,attempts)
        VALUES($1,$2,clock_timestamp(),1)`, [`user:${probe}`, `club:${probe}`]);
      await client.query('INSERT INTO public.hg_invite_codes(id,doc) VALUES($1,$2::jsonb)', [
        `invite:${probe}`, JSON.stringify({ _id: `invite:${probe}`, clubId: `club:${probe}` }),
      ]);
      const visible = await client.query(`
        SELECT
          (SELECT count(*) FROM public.hg_management_terms WHERE id=$1) AS terms,
          (SELECT count(*) FROM public.hg_management_requests WHERE id=$2) AS requests,
          (SELECT count(*) FROM public.hg_invitation_rate_limits WHERE user_id=$3 AND club_id=$4) AS limits,
          (SELECT count(*) FROM public.hg_invite_codes WHERE id=$5) AS invites
      `, [`term:${probe}`, `request:${probe}`, `user:${probe}`, `club:${probe}`, `invite:${probe}`]);
      assert.deepEqual(visible.rows[0], { terms: '1', requests: '1', limits: '1', invites: '1' });
    });
  } finally {
    await client.end();
  }
});

test('legacy invite keys become opaque and legacy applications retain only invite ids', async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const code = randomBytes(6).toString('hex').toUpperCase();
  const codeHash = createHash('sha256').update(code).digest('hex');
  const activeId = `admin-governance-legacy-probe-${process.pid}-active`;
  const pendingId = `admin-governance-legacy-probe-${process.pid}-pending`;
  try {
    const installed = await client.query("SELECT to_regprocedure('public.hg_admin_management(text,text,jsonb,text)') IS NOT NULL AS value");
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL TIME ZONE 'Asia/Shanghai'");
      await client.query(`INSERT INTO public.hg_invite_codes(id,doc) VALUES($1::text,jsonb_build_object(
        '_id',$1::text,'clubId','heiguang','maxUses',10,'usedCount',9,'version',1,'createdAt',clock_timestamp()::text))`, [code]);
      await client.query(`INSERT INTO public.hg_membership_applications(id,doc) VALUES
        ($1::text,jsonb_build_object('_id',$1::text,'userId',$3::text,'clubId','heiguang','inviteCode',$4::text,
          'rulesVersion','v1.0','status','active','admissionMethod','invite','version',1,'createdAt',clock_timestamp()::text)),
        ($2::text,jsonb_build_object('_id',$2::text,'userId',$5::text,'clubId','heiguang','inviteCode',$4::text,
          'rulesVersion','v1.0','status','pending','admissionMethod','manual_restore','version',1,'createdAt',clock_timestamp()::text))`,
      [activeId, pendingId, `${activeId}-user`, code, `${pendingId}-user`]);
      if (!installed.rows[0].value) await client.query(migrationSql);
      else await client.query('SELECT public.hg_backfill_legacy_invites()');

      const inviteResult = await client.query(`
      SELECT id, doc FROM public.hg_invite_codes
      WHERE id = $1 OR doc->>'codeHash' = $2
      `, [code, codeHash]);
      assert.equal(inviteResult.rows.length, 1);
      const invite = inviteResult.rows[0];
      assert.notEqual(invite.id, code);
      assert.equal(invite.doc._id, invite.id);
      assert.equal(invite.doc.codeHash, codeHash);
      assert.equal(invite.doc.mode, 'application');
      assert.equal(invite.doc.usedCount, 8);
      assert.equal(invite.doc.reservedCount, 1);
      assert.equal(Object.hasOwn(invite.doc, 'inviteCode'), false);
      assert.equal(Object.hasOwn(invite.doc, 'code'), false);

      const apps = await client.query('SELECT id,doc FROM public.hg_membership_applications WHERE id=ANY($1::text[]) ORDER BY id', [[activeId, pendingId]]);
      assert.equal(apps.rows.length, 2);
      for (const { doc } of apps.rows) {
        assert.equal(doc.inviteId, invite.id);
        assert.equal(Object.hasOwn(doc, 'inviteCode'), false);
      }
      const pending = apps.rows.find(({ id }) => id===pendingId)?.doc;
      assert.equal(pending.reservationStatus, 'reserved');
      const expiresAt = Date.parse(pending.reservationExpiresAt);
      assert.ok(Number.isFinite(expiresAt));
      assert.ok(Math.abs(expiresAt - (Date.now() + 72 * 60 * 60 * 1000)) < 5 * 60 * 1000);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    await client.end();
  }
});

test('invitation reservations, authorization, cancellation and restored-member downgrade are transactional', async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const prefix = `admin-gov-${process.pid}`;
  const clubId = `${prefix}-club`;
  const actor = `${prefix}-lead`;
  const secondModerator = `${prefix}-second-moderator`;
  const reviewer = `${prefix}-reviewer`;
  const applicant = `${prefix}-applicant`;
  const cancelApplicant = `${prefix}-cancel-applicant`;
  const rejectApplicant = `${prefix}-reject-applicant`;
  const expiredApplicant = `${prefix}-expired-applicant`;
  const expiredDecisionApplicant = `${prefix}-expired-decision-applicant`;
  const directTarget = `${prefix}-direct-target`;
  const wrongTarget = `${prefix}-wrong-target`;
  const removedTarget = `${prefix}-removed-target`;
  const pgCall = (name, values) => client.query(name, values);
  const management = async (who, action, input = {}, club = clubId) => (await pgCall(
    'SELECT public.hg_admin_management($1,$2,$3::jsonb,$4) AS value',
    [who, action, JSON.stringify(input), club],
  )).rows[0].value;
  const apply = async (who, codeHash, idempotencyKey, club = clubId) => (await pgCall(
    'SELECT public.hg_apply_invitation($1,$2::jsonb,$3) AS value',
    [who, JSON.stringify({ codeHash, displayName: '测试申请者', rulesVersion: 'v1.0', idempotencyKey }), club],
  )).rows[0].value;
  const makeCode = () => {
    const code = randomBytes(16).toString('hex').toUpperCase();
    return { code, codeHash: createHash('sha256').update(code).digest('hex') };
  };
  const expectMarker = async (promise, marker) => {
    await client.query('SAVEPOINT expected_failure');
    try {
      await assert.rejects(promise, new RegExp(marker));
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT expected_failure');
      await client.query('RELEASE SAVEPOINT expected_failure');
    }
  };

  try {
    await withMigration(client, async () => {
      for (const [userId, displayName] of [
        [actor, '现任负责人'], [secondModerator, '另一位负责人'], [reviewer, '审核管理员'],
        [applicant, '申请者'], [cancelApplicant, '撤回申请者'], [rejectApplicant, '拒绝申请者'],
        [expiredApplicant, '过期后重新申请者'], [expiredDecisionApplicant, '过期审核申请者'], [directTarget, '定向目标'],
        [wrongTarget, '错误目标'], [removedTarget, '已移除目标'],
      ]) {
        await client.query('INSERT INTO public.hg_users(id,doc) VALUES($1,$2::jsonb)', [
          userId, JSON.stringify({ _id: userId, status: 'active', displayName }),
        ]);
      }
      await client.query(`
        INSERT INTO public.hg_memberships(id,doc) VALUES
          ($1::text,jsonb_build_object('_id',$1::text,'userId',$2::text,'clubId',$3::text,'status','active','role','moderator','version',1)),
          ($4::text,jsonb_build_object('_id',$4::text,'userId',$5::text,'clubId',$3::text,'status','active','role','moderator','version',1)),
          ($6::text,jsonb_build_object('_id',$6::text,'userId',$7::text,'clubId',$3::text,'status','active','role','admin','version',1)),
          ($8::text,jsonb_build_object('_id',$8::text,'userId',$9::text,'clubId',$3::text,'status','removed','role','moderator','version',3))
      `, [
        `${actor}:${clubId}`, actor, clubId,
        `${secondModerator}:${clubId}`, secondModerator,
        `${reviewer}:${clubId}`, reviewer,
        `${removedTarget}:${clubId}`, removedTarget,
      ]);
      await client.query('INSERT INTO public.hg_club_config(id,doc) VALUES($1,$2::jsonb)', [
        clubId, JSON.stringify({ _id: clubId, name: '隔离治理测试社团', status: 'active', rulesVersion: 'v1.0', moderatorUserId: actor }),
      ]);
      await client.query(`
        INSERT INTO public.hg_users(id,doc) VALUES
          ('mvp-developer-a', jsonb_build_object('_id','mvp-developer-a','status','active','platformRole','developer'))
        ON CONFLICT(id) DO UPDATE SET doc=excluded.doc||jsonb_build_object('status','active','platformRole','developer')
      `);
      await client.query('SET LOCAL ROLE service_role');

      const team = await management(actor, 'team.get');
      assert.equal(team.term.primaryUserId, actor);
      assert.equal(team.members.length, 3);
      await expectMarker(() => management(reviewer, 'members.list'), 'FORBIDDEN');
      await expectMarker(() => management(actor, 'members.list', {}, 'mvp-club-beta'), 'FORBIDDEN');
      await expectMarker(() => pgCall(
        'SELECT public.hg_governance($1,$2,$3::jsonb,$4)',
        ['member.remove', secondModerator, JSON.stringify({ targetUserId: actor, expectedVersion: 1, reason: '尝试撤销负责人权限' }), clubId],
      ), 'PRIMARY_HANDOVER_REQUIRED');

      const code = makeCode();
      const invite = await management(actor, 'invites.create', {
        mode: 'application', maxUses: 1, ttlSeconds: 3600, codeHash: code.codeHash, reason: '为新成员提交人工审核申请',
      });
      assert.match(invite.inviteId, /^invite:/);
      assert.equal(JSON.stringify(invite).includes(code.code), false);
      assert.equal(JSON.stringify(invite).includes(code.codeHash), false);
      const inviteList = await management(actor, 'invites.list');
      assert.equal(JSON.stringify(inviteList).includes(code.code), false);
      assert.equal(JSON.stringify(inviteList).includes(code.codeHash), false);

      const application = await apply(applicant, code.codeHash, 'application-one');
      assert.equal(application.state, 'pending');
      const replay = await apply(applicant, code.codeHash, 'application-one');
      assert.deepEqual(replay, application);
      let stored = await client.query(`
        SELECT i.doc AS invite, a.doc AS application FROM public.hg_invite_codes i
        JOIN public.hg_membership_applications a ON a.id=$2 WHERE i.id=$1
      `, [invite.inviteId, application.applicationId]);
      assert.equal(stored.rows[0].invite.usedCount, 0);
      assert.equal(stored.rows[0].invite.reservedCount, 1);
      assert.equal(stored.rows[0].application.reservationStatus, 'reserved');
      assert.equal(Object.hasOwn(stored.rows[0].application, 'inviteCode'), false);
      assert.equal(Object.hasOwn(stored.rows[0].application, 'codeHash'), false);
      assert.ok(Math.abs(Date.parse(stored.rows[0].application.reservationExpiresAt) - (Date.now() + 72 * 60 * 60 * 1000)) < 5 * 60 * 1000);

      await management(actor, 'invites.revoke', { id: invite.inviteId, expectedVersion: 1, reason: '测试撤销新邀请码并保留已有申请' });
      const moderated = await pgCall('SELECT public.hg_moderate($1,$2,$3::jsonb,$4) AS value', [
        'membership.decide', reviewer,
        JSON.stringify({ id: application.applicationId, decision: 'approve', expectedVersion: 1 }), clubId,
      ]);
      assert.equal(moderated.rows[0].value.status, 'active');
      stored = await client.query(`
        SELECT i.doc AS invite, a.doc AS application, m.doc AS membership
        FROM public.hg_invite_codes i JOIN public.hg_membership_applications a ON a.id=$2
        JOIN public.hg_memberships m ON m.id=$3 WHERE i.id=$1
      `, [invite.inviteId, application.applicationId, `${applicant}:${clubId}`]);
      assert.equal(stored.rows[0].invite.usedCount, 1);
      assert.equal(stored.rows[0].invite.reservedCount, 0);
      assert.equal(stored.rows[0].application.status, 'active');
      assert.equal(stored.rows[0].membership.role, 'member');

      const oldReservationCode = makeCode();
      const oldReservationInvite = await management(actor, 'invites.create', {
        mode: 'application', maxUses: 1, ttlSeconds: 3600,
        codeHash: oldReservationCode.codeHash, reason: '创建一个即将过期的旧码申请',
      });
      const expiredApplication = await apply(expiredApplicant, oldReservationCode.codeHash, 'expired-old-application');
      await client.query(`UPDATE public.hg_membership_applications
        SET doc=doc||jsonb_build_object('reservationExpiresAt',$2::text)
        WHERE id=$1`, [expiredApplication.applicationId, new Date(Date.now() - 60_000).toISOString()]);

      const newReservationCode = makeCode();
      const newReservationInvite = await management(actor, 'invites.create', {
        mode: 'application', maxUses: 1, ttlSeconds: 3600,
        codeHash: newReservationCode.codeHash, reason: '创建一个可重新申请的新邀请码',
      });
      const reapplication = await apply(expiredApplicant, newReservationCode.codeHash, 'expired-new-application');
      assert.equal(reapplication.state, 'pending');
      assert.notEqual(reapplication.applicationId, expiredApplication.applicationId);

      const oldReservationState = await client.query(`SELECT i.doc AS invite,a.doc AS application
        FROM public.hg_invite_codes i JOIN public.hg_membership_applications a ON a.id=$2 WHERE i.id=$1`,
      [oldReservationInvite.inviteId, expiredApplication.applicationId]);
      assert.equal(oldReservationState.rows[0].invite.reservedCount, 0);
      assert.equal(oldReservationState.rows[0].application.status, 'expired');
      assert.equal(oldReservationState.rows[0].application.reservationStatus, 'released');
      const newReservationState = await client.query(`SELECT i.doc AS invite,a.doc AS application
        FROM public.hg_invite_codes i JOIN public.hg_membership_applications a ON a.id=$2 WHERE i.id=$1`,
      [newReservationInvite.inviteId, reapplication.applicationId]);
      assert.equal(newReservationState.rows[0].invite.reservedCount, 1);
      assert.equal(newReservationState.rows[0].application.status, 'pending');
      assert.equal(newReservationState.rows[0].application.reservationStatus, 'reserved');

      const rejectCode = makeCode();
      const rejectInvite = await management(actor, 'invites.create', {
        mode: 'application', maxUses: 1, ttlSeconds: 3600,
        codeHash: rejectCode.codeHash, reason: '创建一个会被审核拒绝的申请',
      });
      const rejectedApplication = await apply(rejectApplicant, rejectCode.codeHash, 'application-reject');
      const rejected = await pgCall('SELECT public.hg_decide_membership_application($1,$2::jsonb,$3) AS value', [
        reviewer,
        JSON.stringify({ id: rejectedApplication.applicationId, decision: 'reject', expectedVersion: 1, reason: '申请资料未满足社团规则要求' }),
        clubId,
      ]);
      assert.equal(rejected.rows[0].value.status, 'rejected');

      const expiredDecisionCode = makeCode();
      const expiredDecisionInvite = await management(actor, 'invites.create', {
        mode: 'application', maxUses: 1, ttlSeconds: 3600,
        codeHash: expiredDecisionCode.codeHash, reason: '创建一个过期时由审核流程释放的申请',
      });
      const expiredDecision = await apply(expiredDecisionApplicant, expiredDecisionCode.codeHash, 'application-expired');
      await client.query(`UPDATE public.hg_membership_applications
        SET doc=doc||jsonb_build_object('reservationExpiresAt',$2::text)
        WHERE id=$1`, [expiredDecision.applicationId, new Date(Date.now() - 60_000).toISOString()]);
      const expiredDecisionResult = await pgCall('SELECT public.hg_decide_membership_application($1,$2::jsonb,$3) AS value', [
        reviewer,
        JSON.stringify({ id: expiredDecision.applicationId, decision: 'approve', expectedVersion: 1 }),
        clubId,
      ]);
      assert.equal(expiredDecisionResult.rows[0].value.error, 'RESERVATION_EXPIRED');
      const releasedDecisionInvites = await client.query(
        'SELECT id,doc->>\'reservedCount\' AS reserved_count FROM public.hg_invite_codes WHERE id=ANY($1::text[])',
        [[rejectInvite.inviteId, expiredDecisionInvite.inviteId]],
      );
      assert.equal(releasedDecisionInvites.rows.length, 2);
      assert.ok(releasedDecisionInvites.rows.every((row) => row.reserved_count === '0'));
      await client.query('INSERT INTO public.hg_audit_logs(id,doc) VALUES($1,$2::jsonb)', [
        `audit:${prefix}-content`,
        JSON.stringify({ _id: `audit:${prefix}-content`, clubId, actorId: reviewer, action: 'content.post.hidden',
          targetType: 'post', targetId: 'content-sample', createdAt: new Date().toISOString() }),
      ]);
      const managementAudit = await management(actor, 'audit.list', { limit: 100 });
      for (const [action, targetId] of [
        ['membership.approve', application.applicationId],
        ['membership.reject', rejectedApplication.applicationId],
        ['membership.expired', expiredDecision.applicationId],
      ]) {
        assert.ok(managementAudit.items.some((item) => item.action === action && item.actorId === reviewer && item.targetId === targetId));
      }
      assert.equal(managementAudit.items.some((item) => item.id === `audit:${prefix}-content`), false);

      const cancelCode = makeCode();
      const cancelInvite = await management(actor, 'invites.create', {
        mode: 'application', maxUses: 1, ttlSeconds: 3600, codeHash: cancelCode.codeHash, reason: '申请本人撤回测试邀请码',
      });
      const cancellation = await apply(cancelApplicant, cancelCode.codeHash, 'application-cancel');
      const cancelled = await management(cancelApplicant, 'applications.cancel', {
        id: cancellation.applicationId, expectedVersion: 1, reason: '本人暂不加入社团',
      });
      assert.equal(cancelled.status, 'cancelled');
      stored = await client.query(`SELECT i.doc AS invite,a.doc AS application FROM public.hg_invite_codes i
        JOIN public.hg_membership_applications a ON a.id=$2 WHERE i.id=$1`, [cancelInvite.inviteId, cancellation.applicationId]);
      assert.equal(stored.rows[0].invite.reservedCount, 0);
      assert.equal(stored.rows[0].application.status, 'cancelled');
      await expectMarker(() => pgCall('SELECT public.hg_decide_membership_application($1,$2::jsonb,$3)', [
        reviewer, JSON.stringify({ id: cancellation.applicationId, decision: 'approve', expectedVersion: 1 }), clubId,
      ]), 'VERSION_CONFLICT');

      const directCode = makeCode();
      const directInvite = await management(actor, 'invites.create', {
        mode: 'direct', maxUses: 1, ttlSeconds: 3600, targetUserId: directTarget,
        codeHash: directCode.codeHash, reason: '仅邀请指定测试账号直接加入社团',
      });
      assert.equal((await apply(wrongTarget, directCode.codeHash, 'wrong-direct')).error, 'INVITE_INVALID');
      const directResult = await apply(directTarget, directCode.codeHash, 'direct-one');
      assert.equal(directResult.state, 'active');
      stored = await client.query('SELECT doc FROM public.hg_memberships WHERE id=$1', [`${directTarget}:${clubId}`]);
      assert.equal(stored.rows[0].doc.role, 'member');
      stored = await client.query('SELECT doc FROM public.hg_invite_codes WHERE id=$1', [directInvite.inviteId]);
      assert.equal(stored.rows[0].doc.usedCount, 1);

      const restoreCode = makeCode();
      const restoreInvite = await management(actor, 'invites.create', {
        mode: 'direct', maxUses: 1, ttlSeconds: 3600, targetUserId: removedTarget,
        codeHash: restoreCode.codeHash, reason: '已移除成员必须提交人工恢复申请',
      });
      const restoreResult = await apply(removedTarget, restoreCode.codeHash, 'restore-one');
      stored = await client.query(`SELECT i.doc AS invite,a.doc AS application,m.doc AS membership
        FROM public.hg_invite_codes i JOIN public.hg_membership_applications a ON a.id=$2
        JOIN public.hg_memberships m ON m.id=$3 WHERE i.id=$1`, [
        restoreInvite.inviteId, restoreResult.applicationId, `${removedTarget}:${clubId}`,
      ]);
      assert.equal(restoreResult.state, 'pending');
      assert.equal(stored.rows[0].application.admissionMethod, 'manual_restore');
      assert.equal(stored.rows[0].membership.status, 'removed');
      assert.equal(stored.rows[0].membership.role, 'moderator');
      const restored = await pgCall('SELECT public.hg_decide_membership_application($1,$2::jsonb,$3) AS value', [
        reviewer, JSON.stringify({ id: restoreResult.applicationId, decision: 'approve', expectedVersion: 1 }), clubId,
      ]);
      assert.equal(restored.rows[0].value.status, 'active');
      stored = await client.query('SELECT doc FROM public.hg_memberships WHERE id=$1', [`${removedTarget}:${clubId}`]);
      assert.equal(stored.rows[0].doc.status, 'active');
      assert.equal(stored.rows[0].doc.role, 'member');
      assert.equal(Object.hasOwn(stored.rows[0].doc, 'managementTermId'), false);
    });
  } finally {
    await client.end();
  }
});

test('recovery without an explicit team promotes only its target and demotes the previous management team', async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const prefix = `admin-gov-recovery-${process.pid}`;
  const clubId = `${prefix}-club`;
  const developer = `${prefix}-developer`;
  const secondDeveloper = `${prefix}-second-developer`;
  const primary = `${prefix}-primary`;
  const moderator = `${prefix}-moderator`;
  const administrator = `${prefix}-admin`;
  const target = `${prefix}-target`;
  const management = async (who, action, input = {}) => (await client.query(
    'SELECT public.hg_admin_management($1,$2,$3::jsonb,$4) AS value',
    [who, action, JSON.stringify(input), clubId],
  )).rows[0].value;

  try {
    await withMigration(client, async () => {
      for (const [userId, displayName, platformRole] of [
        [developer, '恢复发起开发者', 'developer'],
        [secondDeveloper, '恢复审批开发者', 'developer'],
        [primary, '原负责人', null],
        [moderator, '原社团管理员', null],
        [administrator, '原社团管理', null],
        [target, '接任成员', null],
      ]) {
        const doc = { _id: userId, status: 'active', displayName };
        if (platformRole) doc.platformRole = platformRole;
        await client.query('INSERT INTO public.hg_users(id,doc) VALUES($1,$2::jsonb)', [userId, JSON.stringify(doc)]);
      }
      await client.query(`
        INSERT INTO public.hg_memberships(id,doc) VALUES
          ($1::text,jsonb_build_object('_id',$1::text,'userId',$2::text,'clubId',$3::text,'status','active','role','moderator','version',1)),
          ($4::text,jsonb_build_object('_id',$4::text,'userId',$5::text,'clubId',$3::text,'status','active','role','moderator','version',1)),
          ($6::text,jsonb_build_object('_id',$6::text,'userId',$7::text,'clubId',$3::text,'status','active','role','admin','version',1)),
          ($8::text,jsonb_build_object('_id',$8::text,'userId',$9::text,'clubId',$3::text,'status','active','role','admin','version',1))
      `, [
        `${primary}:${clubId}`, primary, clubId,
        `${moderator}:${clubId}`, moderator,
        `${administrator}:${clubId}`, administrator,
        `${target}:${clubId}`, target,
      ]);
      await client.query('INSERT INTO public.hg_club_config(id,doc) VALUES($1,$2::jsonb)', [
        clubId, JSON.stringify({ _id: clubId, name: '恢复缺省团队测试社团', status: 'active', rulesVersion: 'v1.0', moderatorUserId: primary }),
      ]);
      await client.query('SET LOCAL ROLE service_role');

      const listBefore = await client.query("SELECT public.hg_platform_clubs($1,'list','{}'::jsonb) AS value", [developer]);
      const clubBefore = listBefore.rows[0].value.list.find((item) => item.id === clubId);
      assert.equal(clubBefore.primaryUserId, primary);
      assert.equal(clubBefore.managementTermVersion, 1);

      const recoveryReason = '原负责人失联，恢复社团管理并由目标成员接任';
      const recovery = await management(developer, 'recovery.request', {
        targetUserId: target,
        expectedVersion: 1,
        reason: recoveryReason,
      });
      assert.equal(recovery.status, 'recovery_requested');
      const notices = await client.query(`SELECT doc->>'recipientId' AS recipient_id,
          doc->>'targetType' AS target_type,doc->>'targetId' AS target_id,doc->>'summary' AS summary
        FROM public.hg_notifications WHERE doc->>'clubId'=$1 AND doc->>'eventType'='management_recovery_notice'
        ORDER BY doc->>'recipientId'`, [clubId]);
      assert.deepEqual(notices.rows.map(({ recipient_id }) => recipient_id), [administrator, moderator, primary].sort());
      assert.ok(notices.rows.every(({ recipient_id }) => recipient_id !== target));
      assert.ok(notices.rows.every(({ target_type, target_id, summary }) => target_type === 'system'
        && target_id === null && summary.includes(recoveryReason) && /冷却|复核/.test(summary)));
      const targetNotice = await client.query(`SELECT doc->>'targetType' AS target_type,doc->>'targetId' AS target_id
        FROM public.hg_notifications WHERE doc->>'clubId'=$1 AND doc->>'eventType'='management_recovery'
          AND doc->>'recipientId'=$2`, [clubId, target]);
      assert.deepEqual(targetNotice.rows, [{ target_type: 'management_recovery', target_id: recovery.id }]);
      const recoveryOverview = await management(primary, 'overview');
      assert.equal(recoveryOverview.pending.handovers, 1);
      const listed = await management(developer, 'recovery.list');
      const proposal = listed.items.find((item) => item.id === recovery.id);
      assert.deepEqual(proposal.proposedTeam, [{ targetUserId: target, displayName: '接任成员', role: 'moderator', version: 1 }]);

      const accepted = await management(target, 'recovery.accept', { id: recovery.id, expectedVersion: 1 });
      assert.equal(accepted.version, 2);
      const approved = await management(secondDeveloper, 'recovery.approve', {
        id: recovery.id,
        expectedVersion: 2,
        decision: 'approve',
        reason: '目标账号已确认，由另一名开发者复核通过',
      });
      assert.equal(approved.status, 'completed');

      const newTeam = await management(target, 'team.get');
      assert.equal(newTeam.term.primaryUserId, target);
      assert.deepEqual(newTeam.members.map(({ targetUserId, role }) => ({ targetUserId, role })), [
        { targetUserId: target, role: 'moderator' },
      ]);
      const membershipRows = await client.query(`SELECT doc->>'userId' AS user_id, doc->>'role' AS role
        FROM public.hg_memberships WHERE doc->>'clubId'=$1 AND doc->>'status'='active' ORDER BY doc->>'userId'`, [clubId]);
      assert.deepEqual(membershipRows.rows.map(({ user_id, role }) => ({ targetUserId: user_id, role })), [
        { targetUserId: administrator, role: 'member' },
        { targetUserId: moderator, role: 'member' },
        { targetUserId: primary, role: 'member' },
        { targetUserId: target, role: 'moderator' },
      ]);

      const nextRecovery = await management(developer, 'recovery.request', {
        targetUserId: primary,
        expectedVersion: 1,
        reason: '再次验证平台恢复请求分页与状态筛选',
      });
      const rejected = await management(secondDeveloper, 'recovery.approve', {
        id: nextRecovery.id,
        expectedVersion: 1,
        decision: 'reject',
        reason: '该账号的恢复申请暂不符合审核条件',
      });
      assert.equal(rejected.status, 'recovery_rejected');
      const firstPage = await management(developer, 'recovery.list', { status: 'all', limit: 1 });
      assert.equal(firstPage.items.length, 1);
      assert.equal(typeof firstPage.nextCursor, 'string');
      const secondPage = await management(developer, 'recovery.list', {
        status: 'all', limit: 1, cursor: firstPage.nextCursor,
      });
      assert.equal(secondPage.items.length, 1);
      assert.equal(secondPage.nextCursor, null);
      assert.notEqual(firstPage.items[0].id, secondPage.items[0].id);
      const completedPage = await management(developer, 'recovery.list', { status: 'completed', limit: 50 });
      const rejectedPage = await management(developer, 'recovery.list', { status: 'recovery_rejected', limit: 50 });
      assert.deepEqual(completedPage.items.map(({ id }) => id), [recovery.id]);
      assert.deepEqual(rejectedPage.items.map(({ id }) => id), [nextRecovery.id]);
    });
  } finally {
    await client.end();
  }
});

test('overview counts proposed handovers and decline uses the declined status', async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const prefix = `admin-gov-decline-${process.pid}`;
  const clubId = `${prefix}-club`;
  const primary = `${prefix}-primary`;
  const target = `${prefix}-target`;
  const management = async (who, action, input = {}) => (await client.query(
    'SELECT public.hg_admin_management($1,$2,$3::jsonb,$4) AS value',
    [who, action, JSON.stringify(input), clubId],
  )).rows[0].value;

  try {
    await withMigration(client, async () => {
      for (const userId of [primary, target]) {
        await client.query('INSERT INTO public.hg_users(id,doc) VALUES($1,$2::jsonb)', [
          userId, JSON.stringify({ _id: userId, status: 'active', displayName: userId }),
        ]);
      }
      await client.query(`
        INSERT INTO public.hg_memberships(id,doc) VALUES
          ($1::text,jsonb_build_object('_id',$1::text,'userId',$2::text,'clubId',$3::text,'status','active','role','moderator','version',1)),
          ($4::text,jsonb_build_object('_id',$4::text,'userId',$5::text,'clubId',$3::text,'status','active','role','member','version',1))
      `, [`${primary}:${clubId}`, primary, clubId, `${target}:${clubId}`, target]);
      await client.query('INSERT INTO public.hg_club_config(id,doc) VALUES($1,$2::jsonb)', [
        clubId, JSON.stringify({ _id: clubId, name: '交接拒绝状态测试社团', status: 'active', rulesVersion: 'v1.0', moderatorUserId: primary }),
      ]);
      await client.query('SET LOCAL ROLE service_role');

      const handover = await management(primary, 'handovers.create', {
        targetUserId: target,
        team: [{ targetUserId: target, role: 'moderator', expectedVersion: 1 }],
        expectedVersion: 1,
        reason: '邀请成员接任社团管理负责人',
      });
      const overview = await management(primary, 'overview');
      assert.equal(overview.pending.handovers, 1);
      const declined = await management(target, 'handovers.decline', {
        id: handover.id,
        expectedVersion: 1,
        reason: '暂时无法接任社团管理',
      });
      assert.equal(declined.status, 'declined');
      const stored = await client.query('SELECT doc->>\'status\' AS status FROM public.hg_management_requests WHERE id=$1', [handover.id]);
      assert.equal(stored.rows[0].status, 'declined');

      const nextHandover = await management(primary, 'handovers.create', {
        targetUserId: target,
        team: [{ targetUserId: target, role: 'moderator', expectedVersion: 1 }],
        expectedVersion: 1,
        reason: '再建一个有效请求验证列表游标',
      });
      const firstPage = await management(primary, 'handovers.list', { status: 'all', limit: 1 });
      assert.equal(firstPage.items.length, 1);
      assert.equal(typeof firstPage.nextCursor, 'string');
      const secondPage = await management(primary, 'handovers.list', {
        status: 'all', limit: 1, cursor: firstPage.nextCursor,
      });
      assert.equal(secondPage.items.length, 1);
      assert.equal(secondPage.nextCursor, null);
      const declinedPage = await management(primary, 'handovers.list', { status: 'declined', limit: 50 });
      assert.deepEqual(declinedPage.items.map(({ id }) => id), [handover.id]);
      assert.notEqual(firstPage.items[0].id, secondPage.items[0].id);
      assert.ok([handover.id, nextHandover.id].includes(firstPage.items[0].id));
    });
  } finally {
    await client.end();
  }
});

test('overview reports the current active manager count after role changes', async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const prefix = `admin-gov-overview-${process.pid}`;
  const clubId = `${prefix}-club`;
  const primary = `${prefix}-primary`;
  const member = `${prefix}-member`;
  const management = async (who, action, input = {}) => (await client.query(
    'SELECT public.hg_admin_management($1,$2,$3::jsonb,$4) AS value',
    [who, action, JSON.stringify(input), clubId],
  )).rows[0].value;

  try {
    await withMigration(client, async () => {
      for (const userId of [primary, member]) {
        await client.query('INSERT INTO public.hg_users(id,doc) VALUES($1,$2::jsonb)', [
          userId, JSON.stringify({ _id: userId, status: 'active', displayName: userId }),
        ]);
      }
      await client.query(`
        INSERT INTO public.hg_memberships(id,doc) VALUES
          ($1::text,jsonb_build_object('_id',$1::text,'userId',$2::text,'clubId',$3::text,'status','active','role','moderator','version',1)),
          ($4::text,jsonb_build_object('_id',$4::text,'userId',$5::text,'clubId',$3::text,'status','active','role','member','version',1))
      `, [`${primary}:${clubId}`, primary, clubId, `${member}:${clubId}`, member]);
      await client.query('INSERT INTO public.hg_club_config(id,doc) VALUES($1,$2::jsonb)', [
        clubId, JSON.stringify({ _id: clubId, name: '管理人数统计测试社团', status: 'active', rulesVersion: 'v1.0', moderatorUserId: primary }),
      ]);
      await client.query('SET LOCAL ROLE service_role');

      await client.query('SELECT public.hg_governance($1,$2,$3::jsonb,$4)', [
        'member.role', primary,
        JSON.stringify({ targetUserId: member, role: 'admin', expectedVersion: 1, reason: '晋升成员以核对本届管理人数' }),
        clubId,
      ]);
      let overview = await management(primary, 'overview');
      assert.equal(overview.activeMembers, 2);
      assert.equal(overview.term.memberCount, 2);

      await client.query('SELECT public.hg_governance($1,$2,$3::jsonb,$4)', [
        'member.role', primary,
        JSON.stringify({ targetUserId: member, role: 'member', expectedVersion: 2, reason: '撤销管理角色以核对本届管理人数' }),
        clubId,
      ]);
      overview = await management(primary, 'overview');
      assert.equal(overview.activeMembers, 2);
      assert.equal(overview.term.memberCount, 1);
    });
  } finally {
    await client.end();
  }
});

test('my handover inbox paginates pending requests across clubs', async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const prefix = `admin-gov-handover-mine-${process.pid}`;
  const firstClub = `${prefix}-club-1`;
  const secondClub = `${prefix}-club-2`;
  const firstPrimary = `${prefix}-primary-1`;
  const secondPrimary = `${prefix}-primary-2`;
  const target = `${prefix}-target`;
  const management = async (who, action, input = {}, club = null) => (await client.query(
    'SELECT public.hg_admin_management($1,$2,$3::jsonb,$4) AS value',
    [who, action, JSON.stringify(input), club],
  )).rows[0].value;

  try {
    await withMigration(client, async () => {
      for (const userId of [firstPrimary, secondPrimary, target]) {
        await client.query('INSERT INTO public.hg_users(id,doc) VALUES($1,$2::jsonb)', [
          userId, JSON.stringify({ _id: userId, status: 'active', displayName: userId }),
        ]);
      }
      await client.query(`
        INSERT INTO public.hg_memberships(id,doc) VALUES
          ($1::text,jsonb_build_object('_id',$1::text,'userId',$2::text,'clubId',$3::text,'status','active','role','moderator','version',1)),
          ($4::text,jsonb_build_object('_id',$4::text,'userId',$5::text,'clubId',$3::text,'status','active','role','member','version',1)),
          ($6::text,jsonb_build_object('_id',$6::text,'userId',$7::text,'clubId',$8::text,'status','active','role','moderator','version',1)),
          ($9::text,jsonb_build_object('_id',$9::text,'userId',$5::text,'clubId',$8::text,'status','active','role','member','version',1))
      `, [
        `${firstPrimary}:${firstClub}`, firstPrimary, firstClub, `${target}:${firstClub}`, target,
        `${secondPrimary}:${secondClub}`, secondPrimary, secondClub, `${target}:${secondClub}`,
      ]);
      await client.query('INSERT INTO public.hg_club_config(id,doc) VALUES($1,$2::jsonb),($3::text,$4::jsonb)', [
        firstClub,
        JSON.stringify({ _id: firstClub, name: '账号交接收件箱甲', status: 'active', rulesVersion: 'v1.0', moderatorUserId: firstPrimary }),
        secondClub,
        JSON.stringify({ _id: secondClub, name: '账号交接收件箱乙', status: 'active', rulesVersion: 'v1.0', moderatorUserId: secondPrimary }),
      ]);
      await client.query('SET LOCAL ROLE service_role');

      const first = await management(firstPrimary, 'handovers.create', {
        targetUserId: target,
        team: [{ targetUserId: target, role: 'moderator', expectedVersion: 1 }],
        expectedVersion: 1,
        reason: '邀请成员接任第一社团负责人',
      }, firstClub);
      const second = await management(secondPrimary, 'handovers.create', {
        targetUserId: target,
        team: [{ targetUserId: target, role: 'moderator', expectedVersion: 1 }],
        expectedVersion: 1,
        reason: '邀请成员接任第二社团负责人',
      }, secondClub);
      const pageOne = await management(target, 'handovers.mine', { limit: 1 }, null);
      assert.equal(pageOne.items.length, 1);
      assert.equal(typeof pageOne.nextCursor, 'string');
      const pageTwo = await management(target, 'handovers.mine', { limit: 1, cursor: pageOne.nextCursor }, null);
      assert.equal(pageTwo.items.length, 1);
      assert.equal(pageTwo.nextCursor, null);
      assert.notEqual(pageOne.items[0].id, pageTwo.items[0].id);
      assert.ok([first.id, second.id].includes(pageOne.items[0].id));
    });
  } finally {
    await client.end();
  }
});

test('my recovery inbox paginates open requests across clubs', async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const prefix = `admin-gov-recovery-mine-${process.pid}`;
  const firstClub = `${prefix}-club-1`;
  const secondClub = `${prefix}-club-2`;
  const developer = `${prefix}-developer`;
  const firstPrimary = `${prefix}-primary-1`;
  const secondPrimary = `${prefix}-primary-2`;
  const target = `${prefix}-target`;
  const management = async (who, action, input = {}, club = null) => (await client.query(
    'SELECT public.hg_admin_management($1,$2,$3::jsonb,$4) AS value',
    [who, action, JSON.stringify(input), club],
  )).rows[0].value;

  try {
    await withMigration(client, async () => {
      for (const [userId, platformRole] of [
        [developer, 'developer'], [firstPrimary, null], [secondPrimary, null], [target, null],
      ]) {
        const doc = { _id: userId, status: 'active', displayName: userId };
        if (platformRole) doc.platformRole = platformRole;
        await client.query('INSERT INTO public.hg_users(id,doc) VALUES($1,$2::jsonb)', [userId, JSON.stringify(doc)]);
      }
      await client.query(`
        INSERT INTO public.hg_memberships(id,doc) VALUES
          ($1::text,jsonb_build_object('_id',$1::text,'userId',$2::text,'clubId',$3::text,'status','active','role','moderator','version',1)),
          ($4::text,jsonb_build_object('_id',$4::text,'userId',$5::text,'clubId',$3::text,'status','active','role','member','version',1)),
          ($6::text,jsonb_build_object('_id',$6::text,'userId',$7::text,'clubId',$8::text,'status','active','role','moderator','version',1)),
          ($9::text,jsonb_build_object('_id',$9::text,'userId',$5::text,'clubId',$8::text,'status','active','role','member','version',1))
      `, [
        `${firstPrimary}:${firstClub}`, firstPrimary, firstClub, `${target}:${firstClub}`, target,
        `${secondPrimary}:${secondClub}`, secondPrimary, secondClub, `${target}:${secondClub}`,
      ]);
      await client.query('INSERT INTO public.hg_club_config(id,doc) VALUES($1,$2::jsonb),($3::text,$4::jsonb)', [
        firstClub,
        JSON.stringify({ _id: firstClub, name: '账号恢复收件箱甲', status: 'active', rulesVersion: 'v1.0', moderatorUserId: firstPrimary }),
        secondClub,
        JSON.stringify({ _id: secondClub, name: '账号恢复收件箱乙', status: 'active', rulesVersion: 'v1.0', moderatorUserId: secondPrimary }),
      ]);
      await client.query('SET LOCAL ROLE service_role');

      const first = await management(developer, 'recovery.request', {
        targetUserId: target, expectedVersion: 1, reason: '验证第一个社团的恢复收件箱分页',
      }, firstClub);
      const second = await management(developer, 'recovery.request', {
        targetUserId: target, expectedVersion: 1, reason: '验证第二个社团的恢复收件箱分页',
      }, secondClub);
      const pageOne = await management(target, 'recovery.mine', { limit: 1 }, null);
      assert.equal(pageOne.items.length, 1);
      assert.equal(typeof pageOne.nextCursor, 'string');
      const pageTwo = await management(target, 'recovery.mine', { limit: 1, cursor: pageOne.nextCursor }, null);
      assert.equal(pageTwo.items.length, 1);
      assert.equal(pageTwo.nextCursor, null);
      assert.notEqual(pageOne.items[0].id, pageTwo.items[0].id);
      assert.ok([first.id, second.id].includes(pageOne.items[0].id));
    });
  } finally {
    await client.end();
  }
});

test('concurrent application submissions cannot overbook an invite reservation', async () => {
  const setup = new pg.Client({ connectionString: databaseUrl });
  const contenderA = new pg.Client({ connectionString: databaseUrl });
  const contenderB = new pg.Client({ connectionString: databaseUrl });
  const cleanup = new pg.Client({ connectionString: databaseUrl });
  const prefix = `admin-gov-concurrent-${process.pid}-${randomBytes(3).toString('hex')}`;
  const clubId = `${prefix}-club`;
  const owner = `${prefix}-owner`;
  const applicantA = `${prefix}-a`;
  const applicantB = `${prefix}-b`;
  const inviteId = `invite:${prefix}`;
  const codeHash = createHash('sha256').update(randomBytes(16)).digest('hex');
  let setupTransaction = false;
  const inputFor = (user) => JSON.stringify({
    codeHash,
    displayName: user === applicantA ? '并发申请者甲' : '并发申请者乙',
    rulesVersion: 'v1.0',
    idempotencyKey: `concurrent-${user}`,
  });

  await Promise.all([setup.connect(), contenderA.connect(), contenderB.connect(), cleanup.connect()]);
  try {
    await setup.query('BEGIN');
    setupTransaction = true;
    for (const userId of [owner, applicantA, applicantB]) {
      await setup.query('INSERT INTO public.hg_users(id,doc) VALUES($1,$2::jsonb)', [
        userId, JSON.stringify({ _id: userId, status: 'active', displayName: userId }),
      ]);
    }
    await setup.query('INSERT INTO public.hg_memberships(id,doc) VALUES($1,$2::jsonb)', [
      `${owner}:${clubId}`, JSON.stringify({ _id: `${owner}:${clubId}`, userId: owner, clubId, status: 'active', role: 'moderator', version: 1 }),
    ]);
    await setup.query('INSERT INTO public.hg_club_config(id,doc) VALUES($1,$2::jsonb)', [
      clubId, JSON.stringify({ _id: clubId, name: '并发配额测试社团', status: 'active', rulesVersion: 'v1.0', moderatorUserId: owner }),
    ]);
    const club = await setup.query('SELECT doc FROM public.hg_club_config WHERE id=$1', [clubId]);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await setup.query('INSERT INTO public.hg_invite_codes(id,doc) VALUES($1,$2::jsonb)', [
      inviteId,
      JSON.stringify({
        _id: inviteId,
        clubId,
        codeHash,
        mode: 'application',
        targetUserId: null,
        rulesVersion: 'v1.0',
        issuedManagementTermId: club.rows[0].doc.managementTermId,
        maxUses: 1,
        usedCount: 0,
        reservedCount: 0,
        expiresAt,
        version: 1,
        createdBy: owner,
        createdAt: new Date().toISOString(),
      }),
    ]);
    await setup.query('COMMIT');
    setupTransaction = false;
    await Promise.all([contenderA.query('SET ROLE service_role'), contenderB.query('SET ROLE service_role')]);

    const [resultA, resultB] = await Promise.all([
      contenderA.query('SELECT public.hg_apply_invitation($1,$2::jsonb,$3) AS value', [applicantA, inputFor(applicantA), clubId]),
      contenderB.query('SELECT public.hg_apply_invitation($1,$2::jsonb,$3) AS value', [applicantB, inputFor(applicantB), clubId]),
    ]);
    const outcomes = [resultA.rows[0].value, resultB.rows[0].value];
    assert.equal(outcomes.filter(({ state }) => state === 'pending').length, 1);
    assert.equal(outcomes.filter(({ error }) => error === 'INVITE_INVALID').length, 1);
    const stored = await cleanup.query(`SELECT i.doc AS invite,
      count(a.id) FILTER(WHERE a.doc->>'status'='pending' AND a.doc->>'reservationStatus'='reserved') AS reservations
      FROM public.hg_invite_codes i LEFT JOIN public.hg_membership_applications a ON a.doc->>'inviteId'=i.id
      WHERE i.id=$1 GROUP BY i.id`, [inviteId]);
    assert.equal(stored.rows[0].invite.reservedCount, 1);
    assert.equal(Number(stored.rows[0].reservations), 1);
  } finally {
    if (setupTransaction) {
      try { await setup.query('ROLLBACK'); } catch { /* preserve the test result */ }
    }
    let cleanupTransaction = false;
    try {
      await cleanup.query('BEGIN');
      cleanupTransaction = true;
      await cleanup.query("DELETE FROM public.hg_membership_applications WHERE doc->>'clubId'=$1", [clubId]);
      await cleanup.query('DELETE FROM public.hg_invitation_rate_limits WHERE club_id=$1', [clubId]);
      await cleanup.query('DELETE FROM public.hg_invite_codes WHERE id=$1', [inviteId]);
      await cleanup.query("DELETE FROM public.hg_management_terms WHERE doc->>'clubId'=$1", [clubId]);
      await cleanup.query("DELETE FROM public.hg_memberships WHERE doc->>'clubId'=$1", [clubId]);
      await cleanup.query('DELETE FROM public.hg_club_config WHERE id=$1', [clubId]);
      await cleanup.query('DELETE FROM public.hg_users WHERE id=ANY($1::text[])', [[owner, applicantA, applicantB]]);
      await cleanup.query('COMMIT');
      cleanupTransaction = false;
    } finally {
      if (cleanupTransaction) {
        try { await cleanup.query('ROLLBACK'); } catch { /* preserve the original test or cleanup error */ }
      }
      await Promise.allSettled([setup.end(), contenderA.end(), contenderB.end(), cleanup.end()]);
    }
  }
});
