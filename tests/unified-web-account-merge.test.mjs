import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertApplyGate,
  buildMergePlan,
  parseArguments,
  resolveDatabaseUrl,
} from '../scripts/unified-web-account-merge.mjs';

const userId = 'web-user-1';
const clubId = 'club-a';
const sessionHash = 'a'.repeat(64);

function fixture({ targetPrimary = '', targetModerator = '', sourceMemberships } = {}) {
  const userDoc = {
    _id: userId,
    wxOpenIdRef: 'web:account-1',
    status: 'active',
    displayName: 'Website User',
  };
  const membership = {
    _id: 'membership-a',
    userId,
    clubId,
    role: 'moderator',
    status: 'active',
    managementTermId: 'website-term-old',
    version: 1,
  };
  const source = {
    users: [{ id: userId, doc: userDoc }],
    accounts: [{
      username: 'writer_1',
      user_id: userId,
      password_hash: `scrypt:${'1'.repeat(32)}:${'2'.repeat(128)}`,
      version: 1,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
    }],
    sessions: [{
      token_hash: sessionHash,
      user_id: userId,
      credential_version: 1,
      origin: 'https://website.example',
      expires_at: '2026-10-05T00:00:00.000Z',
      last_seen_at: '2026-10-04T00:00:00.000Z',
      created_at: '2026-10-03T00:00:00.000Z',
      revoked_at: null,
    }],
    memberships: sourceMemberships ?? [{ id: 'membership-a', doc: membership }],
    clubConfigs: [{ id: clubId, doc: { _id: clubId, moderatorUserId: userId } }],
  };
  const target = {
    users: [],
    accounts: [],
    sessions: [],
    memberships: [],
    clubConfigs: [{
      id: clubId,
      doc: {
        _id: clubId,
        managementTermId: 'stage-term-current',
        moderatorUserId: targetModerator,
        capabilities: { anthology: true },
        usage: { limit: 100 },
        displayName: 'Stage club',
      },
    }],
    managementTerms: [{
      id: 'stage-term-current',
      doc: {
        _id: 'stage-term-current',
        clubId,
        status: 'active',
        primaryUserId: targetPrimary,
        version: 3,
      },
    }],
  };
  return { source, target };
}

test('defaults to dry-run and rejects unknown or repeated arguments', () => {
  assert.deepEqual(parseArguments([]), {
    apply: false,
    rehearsal: false,
    confirmServicesStopped: false,
    help: false,
  });
  assert.throws(() => parseArguments(['--wat']), /unknown argument/i);
  assert.throws(() => parseArguments(['--apply', '--apply']), /repeated argument/i);
});

test('apply requires NAS quiescence and explicit confirmation that both services are stopped', () => {
  const apply = parseArguments(['--apply']);
  assert.throws(() => assertApplyGate(apply, {}), /--confirm-services-stopped/i);
  assert.throws(
    () => assertApplyGate(parseArguments(['--apply', '--confirm-services-stopped']), {}),
    /NAS_WRITES_QUIESCED=1/,
  );
  assert.doesNotThrow(() => assertApplyGate(
    parseArguments(['--apply', '--confirm-services-stopped']),
    { NAS_WRITES_QUIESCED: '1' },
  ));
  assert.doesNotThrow(() => assertApplyGate(parseArguments([]), {}));
  assert.throws(() => assertApplyGate(parseArguments(['--rehearsal']), {}), /requires --apply/i);
  assert.doesNotThrow(() => assertApplyGate(parseArguments(['--apply', '--rehearsal']), {}));
});

test('plans only user, web account, sessions, and memberships against the target current term', () => {
  const plan = buildMergePlan(fixture());

  assert.deepEqual(plan.counts, {
    usersToInsert: 1,
    accountsToInsert: 1,
    sessionsToInsert: 1,
    membershipsToInsert: 1,
    primaryClubsToSet: 1,
    primaryClubsAlreadySet: 0,
    primaryClubsPreserved: 0,
  });
  assert.equal(plan.membershipsToInsert[0].doc.managementTermId, 'stage-term-current');
  assert.deepEqual(plan.primaryUpdates, [{
    clubId,
    managementTermId: 'stage-term-current',
    userId,
  }]);
  assert.equal(Object.hasOwn(plan, 'dailyUsage'), false);
  assert.equal(Object.hasOwn(plan, 'clubConfigsToInsert'), false);
  assert.equal(Object.hasOwn(plan, 'managementTermsToInsert'), false);
});

test('preserves an existing target primary, including another moderator', () => {
  const alreadySet = buildMergePlan(fixture({ targetPrimary: userId, targetModerator: userId }));
  assert.equal(alreadySet.primaryUpdates.length, 0);
  assert.equal(alreadySet.counts.primaryClubsAlreadySet, 1);

  const another = buildMergePlan(fixture({ targetPrimary: 'stage-user-1', targetModerator: 'stage-user-1' }));
  assert.equal(another.primaryUpdates.length, 0);
  assert.equal(another.counts.primaryClubsPreserved, 1);
  assert.equal(another.membershipsToInsert.length, 1);
  assert.throws(() => buildMergePlan(fixture({ targetPrimary: 'stage-user-1', targetModerator: 'stage-user-2' })), /target primary conflict/i);
});

test('fails closed for missing target clubs or current management terms', () => {
  const missingClub = fixture();
  missingClub.target.clubConfigs = [];
  assert.throws(() => buildMergePlan(missingClub), /target club set is incomplete/i);

  const missingTerm = fixture();
  missingTerm.target.managementTerms = [];
  assert.throws(() => buildMergePlan(missingTerm), /target current management term is missing/i);
});

test('treats only exact existing rows as idempotent and rejects incompatible identities', () => {
  const initial = fixture();
  const firstPlan = buildMergePlan(initial);
  initial.target.users = [{ id: userId, doc: { ...initial.source.users[0].doc } }];
  initial.target.accounts = [{ ...initial.source.accounts[0] }];
  initial.target.sessions = [{ ...initial.source.sessions[0] }];
  initial.target.memberships = firstPlan.membershipsToInsert.map((row) => ({
    id: row.id,
    doc: { ...row.doc },
  }));
  initial.target.clubConfigs[0].doc.moderatorUserId = userId;
  initial.target.managementTerms[0].doc.primaryUserId = userId;

  const rerun = buildMergePlan(initial);
  assert.deepEqual(rerun.counts, {
    usersToInsert: 0,
    accountsToInsert: 0,
    sessionsToInsert: 0,
    membershipsToInsert: 0,
    primaryClubsToSet: 0,
    primaryClubsAlreadySet: 1,
    primaryClubsPreserved: 0,
  });

  const collision = fixture();
  collision.target.users = [{ id: userId, doc: { ...collision.source.users[0].doc, status: 'disabled' } }];
  assert.throws(() => buildMergePlan(collision), /user identity conflict/i);
});

test('includes a newly registered website account without club membership', () => {
  const data = fixture();
  const secondId = 'web-user-2';
  data.source.users.push({ id: secondId, doc: { _id: secondId, wxOpenIdRef: 'web:account-2', status: 'active' } });
  data.source.accounts.push({ ...data.source.accounts[0], username: 'reader_2', user_id: secondId });
  const plan = buildMergePlan(data);
  assert.equal(plan.counts.usersToInsert, 2);
  assert.equal(plan.counts.accountsToInsert, 2);
  assert.equal(plan.counts.membershipsToInsert, 1);
});

test('prefers protected URL files and rejects files accessible to group or other users', async (t) => {
  const { mkdtemp, chmod, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'unified-merge-test-'));
  const file = join(directory, 'source-url');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(file, 'postgresql://source/db\n', { mode: 0o600 });

  assert.equal(await resolveDatabaseUrl('SOURCE', {
    SOURCE_DATABASE_URL_FILE: file,
    SOURCE_DATABASE_URL: 'postgresql://ignored/db',
  }), 'postgresql://source/db');

  await chmod(file, 0o640);
  await assert.rejects(resolveDatabaseUrl('SOURCE', {
    SOURCE_DATABASE_URL_FILE: file,
    SOURCE_DATABASE_URL: 'postgresql://ignored/db',
  }), /must not be accessible by group or others/i);
});
