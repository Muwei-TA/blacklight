#!/usr/bin/env node
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import config from '../server/config.js';
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--user-id', '--role', '--expected-role', '--reason', '--operator'].includes(key) || args.has(key) || !process.argv[i + 1]) throw new Error('Usage: --user-id ID --role developer|none --expected-role none|developer --reason REASON --operator OPERATOR');
  args.set(key, process.argv[i + 1]);
}
const userId = args.get('--user-id');
const role = args.get('--role');
const expected = args.get('--expected-role');
const reason = args.get('--reason')?.trim();
const operator = args.get('--operator')?.trim();
if (!userId || userId.length > 256 || !['none', 'developer'].includes(role) || !['none', 'developer'].includes(expected) || !reason || reason.length < 10 || reason.length > 500 || !operator || operator.length > 100) throw new Error('Exact user ID, role, expected role, reason and operator are required.');
config.loadSecretFiles(['DATABASE_URL']);
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL or DATABASE_URL_FILE is required; select the intended environment explicitly.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const result = await client.query('SELECT doc FROM public.hg_users WHERE id=$1 FOR UPDATE', [userId]);
  const user = result.rows[0]?.doc;
  if (!user || user.status !== 'active') throw new Error('Target account must exist and be active.');
  const before = user.platformRole || 'none';
  if (before !== expected) throw new Error('Role changed; verify target account again.');
  if (before === role) throw new Error('Account already has requested role; no change made.');
  const auditId = `audit:platform-role:${randomUUID()}`;
  const stamp = new Date().toISOString();
  await client.query("UPDATE public.hg_users SET doc=doc||jsonb_build_object('platformRole',$2::text,'updatedAt',$3::text) WHERE id=$1", [userId, role, stamp]);
  await client.query('INSERT INTO public.hg_audit_logs(id,doc) VALUES($1,$2::jsonb)', [auditId, JSON.stringify({
    _id: auditId, scope: 'platform', actorId: 'operator', operator, action: 'platform.role.set', targetType: 'user', targetId: userId,
    reason, before: { platformRole: before }, after: { platformRole: role }, createdAt: stamp,
  })]);
  await client.query('COMMIT');
  process.stdout.write(`Updated exact account ${userId}: ${before} -> ${role}; audit ${auditId}. Rollback: rerun with --role ${before} --expected-role ${role}, the same user ID and a rollback reason.\n`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { client.release(); await pool.end(); }
