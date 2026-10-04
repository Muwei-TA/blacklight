import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'cloudbase', 'migrations');

export function parseArguments(args) {
  const options = { apply: false, rehearsal: false, confirmServicesStopped: false, help: false };
  const flags = { '--apply': 'apply', '--rehearsal': 'rehearsal', '--confirm-services-stopped': 'confirmServicesStopped', '--help': 'help' };
  for (const arg of args) {
    const key = flags[arg];
    if (!key) throw new Error(`unknown argument: ${arg}`);
    if (options[key]) throw new Error(`repeated argument: ${arg}`);
    options[key] = true;
  }
  return options;
}

export function assertApplyGate(options, env) {
  if (options.rehearsal && !options.apply) throw new Error('--rehearsal requires --apply');
  if (!options.apply) return;
  if (options.rehearsal) return;
  if (!options.confirmServicesStopped) throw new Error('apply requires --confirm-services-stopped');
  if (env.NAS_WRITES_QUIESCED !== '1') throw new Error('apply requires NAS_WRITES_QUIESCED=1');
}

export async function resolveDatabaseUrl(prefix, env = process.env) {
  const file = env[`${prefix}_DATABASE_URL_FILE`];
  if (file) {
    const info = await stat(file);
    if (!info.isFile() || (info.mode & 0o077)) throw new Error(`${prefix} database URL file must not be accessible by group or others`);
    const url = (await readFile(file, 'utf8')).trim();
    if (!url) throw new Error(`${prefix} database URL file is empty`);
    return url;
  }
  const url = env[`${prefix}_DATABASE_URL`];
  if (!url) throw new Error(`${prefix} database URL is missing`);
  return url;
}

function same(a, b) { return isDeepStrictEqual(a, b); }
function rowWithId(rows, id) { return rows.find((row) => row.id === id); }
function present(value) { return value !== undefined && value !== null && value !== ''; }

export function buildMergePlan({ source, target }) {
  if (!source.users.length || source.accounts.length !== source.users.length) throw new Error('website user/account count mismatch');
  const usersById = new Map(source.users.map((row) => [row.id, row]));
  const accountsByUser = new Map(source.accounts.map((row) => [row.user_id, row]));
  if (usersById.size !== source.users.length || accountsByUser.size !== source.accounts.length) throw new Error('duplicate website identity');
  for (const user of source.users) {
    if (!String(user.doc.wxOpenIdRef || '').startsWith('web:') || !accountsByUser.has(user.id)) throw new Error('website identity does not match account');
  }
  if (!source.accounts.every((row) => usersById.has(row.user_id))) throw new Error('website account references unknown user');
  if (!source.memberships.every((row) => usersById.has(row.doc.userId) && row.doc.status === 'active' && ['member', 'admin', 'moderator'].includes(row.doc.role))) throw new Error('unexpected website membership');
  const sourceClubIds = [...new Set(source.memberships.map((row) => row.doc.clubId))].sort();
  const targetClubIds = target.clubConfigs.map((row) => row.id).sort();
  if (!same(sourceClubIds, targetClubIds)) throw new Error('target club set is incomplete');
  if (!source.sessions.every((row) => accountsByUser.has(row.user_id) && row.credential_version === accountsByUser.get(row.user_id).version)) throw new Error('website session identity mismatch');

  const conflicts = [];
  const usersToInsert = [];
  const accountsToInsert = [];
  for (const user of source.users) {
    const existing = rowWithId(target.users, user.id);
    if (existing && !same(existing, user)) conflicts.push('user identity conflict');
    else if (!existing) usersToInsert.push(user);
    if (target.users.some((row) => row.id !== user.id && row.doc.wxOpenIdRef === user.doc.wxOpenIdRef)) conflicts.push('wx identity conflict');
    const account = accountsByUser.get(user.id);
    const existingAccount = target.accounts.find((row) => row.username === account.username || row.user_id === account.user_id);
    if (existingAccount && !same(existingAccount, account)) conflicts.push('web account conflict');
    else if (!existingAccount) accountsToInsert.push(account);
  }
  const sessionsToInsert = [];
  for (const row of source.sessions) {
    const existing = target.sessions.find((item) => item.token_hash === row.token_hash);
    if (existing && !same(existing, row)) conflicts.push('web session conflict');
    else if (!existing) sessionsToInsert.push(row);
  }

  const membershipsToInsert = [];
  const primaryUpdates = [];
  let primaryClubsAlreadySet = 0;
  let primaryClubsPreserved = 0;
  for (const sourceMembership of source.memberships) {
    const clubId = sourceMembership.doc.clubId;
    const club = rowWithId(target.clubConfigs, clubId);
    const termId = club?.doc.managementTermId;
    const term = rowWithId(target.managementTerms, termId);
    if (!club || !present(termId) || !term || term.doc.clubId !== clubId || term.doc.status !== 'active') throw new Error('target current management term is missing');
    const normalized = { id: sourceMembership.id, doc: { ...sourceMembership.doc } };
    if (['admin', 'moderator'].includes(normalized.doc.role)) normalized.doc.managementTermId = termId;
    else delete normalized.doc.managementTermId;
    const existing = target.memberships.find((row) => row.id === normalized.id || (row.doc.clubId === clubId && row.doc.userId === normalized.doc.userId));
    if (existing && !same(existing, normalized)) conflicts.push('membership conflict');
    else if (!existing) membershipsToInsert.push(normalized);
    if (sourceMembership.doc.role !== 'moderator' || source.clubConfigs.find((row) => row.id === clubId)?.doc.moderatorUserId !== normalized.doc.userId) continue;
    const primary = term.doc.primaryUserId;
    const moderator = club.doc.moderatorUserId;
    if (present(primary) && present(moderator) && primary === moderator && primary !== normalized.doc.userId) primaryClubsPreserved += 1;
    else if (primary === normalized.doc.userId && moderator === normalized.doc.userId) primaryClubsAlreadySet += 1;
    else if (!present(primary) && !present(moderator)) primaryUpdates.push({ clubId, managementTermId: termId, userId: normalized.doc.userId });
    else conflicts.push('target primary conflict');
  }
  if (conflicts.length) throw new Error([...new Set(conflicts)].join(', '));
  return {
    usersToInsert,
    accountsToInsert,
    sessionsToInsert,
    membershipsToInsert,
    primaryUpdates,
    rosterClubsToSync: [...new Set(membershipsToInsert.filter((row) => ['admin', 'moderator'].includes(row.doc.role)).map((row) => row.doc.clubId))],
    counts: {
      usersToInsert: usersToInsert.length,
      accountsToInsert: accountsToInsert.length,
      sessionsToInsert: sessionsToInsert.length,
      membershipsToInsert: membershipsToInsert.length,
      primaryClubsToSet: primaryUpdates.length,
      primaryClubsAlreadySet,
      primaryClubsPreserved,
    },
  };
}

async function expectedMigrations() {
  const names = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  if (names.length !== 29) throw new Error('source checkout must contain exactly 29 migrations');
  return Promise.all(names.map(async (migration_name) => ({
    migration_name,
    sha256: createHash('sha256').update(await readFile(join(migrationsDir, migration_name))).digest('hex'),
  })));
}

async function verifyLedger(client, expected, label) {
  const { rows } = await client.query('SELECT migration_name, sha256 FROM nas_meta.schema_migrations ORDER BY migration_name');
  if (!same(rows, expected)) throw new Error(`${label} migration ledger is not exact 29`);
}

async function snapshot(client, userId, source, selectedClubIds = []) {
  const users = source
    ? (await client.query("SELECT id,doc FROM public.hg_users WHERE doc->>'wxOpenIdRef' LIKE 'web:%' ORDER BY id")).rows
    : (await client.query('SELECT id,doc FROM public.hg_users ORDER BY id')).rows;
  const accounts = source
    ? (await client.query('SELECT username,user_id,password_hash,version,created_at,updated_at FROM public.hg_web_accounts ORDER BY username')).rows
    : (await client.query('SELECT username,user_id,password_hash,version,created_at,updated_at FROM public.hg_web_accounts ORDER BY username')).rows;
  const sessions = source
    ? (await client.query('SELECT token_hash,user_id,credential_version,origin,expires_at,last_seen_at,created_at,revoked_at FROM public.hg_web_sessions WHERE user_id=ANY($1::text[]) AND expires_at>NOW() AND revoked_at IS NULL ORDER BY token_hash', [userId])).rows
    : (await client.query('SELECT token_hash,user_id,credential_version,origin,expires_at,last_seen_at,created_at,revoked_at FROM public.hg_web_sessions ORDER BY token_hash')).rows;
  const memberships = source
    ? (await client.query("SELECT id,doc FROM public.hg_memberships WHERE doc->>'userId'=ANY($1::text[]) ORDER BY id", [userId])).rows
    : (await client.query('SELECT id,doc FROM public.hg_memberships ORDER BY id')).rows;
  const clubIds = source ? [...new Set(memberships.map((row) => row.doc.clubId))] : selectedClubIds;
  const clubConfigs = (await client.query('SELECT id,doc FROM public.hg_club_config WHERE id=ANY($1::text[]) ORDER BY id', [clubIds])).rows;
  const termIds = clubConfigs.map((row) => row.doc.managementTermId).filter(Boolean);
  const managementTerms = (await client.query('SELECT id,doc FROM public.hg_management_terms WHERE id=ANY($1::text[]) ORDER BY id', [termIds])).rows;
  return { users, accounts, sessions, memberships, clubConfigs, managementTerms };
}

async function insertPlan(client, plan) {
  for (const user of plan.usersToInsert) await client.query('INSERT INTO public.hg_users(id,doc) VALUES($1,$2)', [user.id, user.doc]);
  for (const a of plan.accountsToInsert) {
    await client.query('INSERT INTO public.hg_web_accounts(username,user_id,password_hash,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)', [a.username, a.user_id, a.password_hash, a.version, a.created_at, a.updated_at]);
  }
  for (const s of plan.sessionsToInsert) await client.query('INSERT INTO public.hg_web_sessions(token_hash,user_id,credential_version,origin,expires_at,last_seen_at,created_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [s.token_hash, s.user_id, s.credential_version, s.origin, s.expires_at, s.last_seen_at, s.created_at, s.revoked_at]);
  for (const m of plan.membershipsToInsert) await client.query('INSERT INTO public.hg_memberships(id,doc) VALUES($1,$2)', [m.id, m.doc]);
  for (const p of plan.primaryUpdates) {
    const updated = await client.query("UPDATE public.hg_club_config SET doc=doc||jsonb_build_object('moderatorUserId',$1::text) WHERE id=$2 AND doc->>'managementTermId'=$3 AND COALESCE(doc->>'moderatorUserId','')='' RETURNING id", [p.userId, p.clubId, p.managementTermId]);
    if (updated.rowCount !== 1) throw new Error('target primary update conflict');
  }
  for (const clubId of plan.rosterClubsToSync) {
    const term = await client.query("SELECT doc->>'managementTermId' AS term_id FROM public.hg_club_config WHERE id=$1", [clubId]);
    if (term.rowCount !== 1 || !term.rows[0].term_id) throw new Error('target current management term is missing');
    const roster = await client.query(`SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'targetUserId',doc->>'userId','role',doc->>'role',
      'version',COALESCE(NULLIF(doc->>'version','')::int,1)) ORDER BY doc->>'userId'),'[]'::jsonb) AS members
      FROM public.hg_memberships WHERE doc->>'clubId'=$1 AND doc->>'status'='active'
        AND doc->>'role' IN ('admin','moderator')`, [clubId]);
    await client.query(`UPDATE public.hg_management_terms SET doc=doc||jsonb_build_object(
      'members',$1::jsonb,'version',COALESCE(NULLIF(doc->>'version','')::int,1)+1)
      WHERE id=$2 AND doc->>'clubId'=$3 AND COALESCE(doc->'members','[]'::jsonb) IS DISTINCT FROM $1::jsonb`,
    [JSON.stringify(roster.rows[0].members), term.rows[0].term_id, clubId]);
  }
}

export async function run(options, env = process.env) {
  assertApplyGate(options, env);
  const [sourceUrl, targetUrl, expected] = await Promise.all([
    resolveDatabaseUrl('SOURCE', env), resolveDatabaseUrl('TARGET', env), expectedMigrations(),
  ]);
  if (sourceUrl === targetUrl) throw new Error('source and target database URLs are identical');
  const source = new pg.Client({ connectionString: sourceUrl, application_name: 'unified-merge-source' });
  const target = new pg.Client({ connectionString: targetUrl, application_name: 'unified-merge-target' });
  await source.connect();
  try {
    await target.connect();
    try {
      if (options.rehearsal) {
        const database = await target.query('SELECT current_database() AS name');
        if (!database.rows[0]?.name.startsWith('unified_rehearsal_')) throw new Error('rehearsal target must be an isolated unified_rehearsal_ database');
      }
      await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await target.query(options.apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        if (options.apply) await target.query("SELECT pg_advisory_xact_lock(hashtextextended('blacklight:unified-web-merge',0))");
        await verifyLedger(source, expected, 'source');
        await verifyLedger(target, expected, 'target');
        const websiteUserIds = (await source.query("SELECT id FROM public.hg_users WHERE doc->>'wxOpenIdRef' LIKE 'web:%' ORDER BY id")).rows.map((row) => row.id);
        const sourceData = await snapshot(source, websiteUserIds, true);
        const clubIds = [...new Set(sourceData.memberships.map((row) => row.doc.clubId))];
        const targetData = await snapshot(target, null, false, clubIds);
        const plan = buildMergePlan({ source: sourceData, target: targetData });
        if (options.apply) {
          await insertPlan(target, plan);
          const after = await snapshot(target, null, false, clubIds);
          const check = buildMergePlan({ source: sourceData, target: after });
          if (Object.entries(check.counts).some(([key, value]) => !['primaryClubsAlreadySet', 'primaryClubsPreserved'].includes(key) && value !== 0)) throw new Error('post-merge verification failed');
          await target.query('COMMIT');
        } else await target.query('ROLLBACK');
        await source.query('ROLLBACK');
        return { mode: options.rehearsal ? 'rehearsal-applied' : options.apply ? 'applied' : 'dry-run', counts: plan.counts, clubs: sourceData.memberships.map((row) => row.doc.clubId).sort() };
      } catch (error) {
        await target.query('ROLLBACK').catch(() => {});
        await source.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } finally { await target.end(); }
  } finally { await source.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/unified-web-account-merge.mjs [--apply --confirm-services-stopped] [--apply --rehearsal] (dry-run by default)');
    else console.log(JSON.stringify(await run(options)));
  } catch (error) {
    console.error(`unified merge failed: ${error.message}`);
    process.exitCode = 1;
  }
}
