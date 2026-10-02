#!/usr/bin/env node
import pg from 'pg';

const { Pool } = pg;
const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === '--help') {
    process.stdout.write('Usage: DATABASE_URL=... node scripts/local-create-club.mjs --club-id ID --name NAME --moderator-user-id USER_ID [--description TEXT]\n');
    process.exit(0);
  }
  if (!['--club-id', '--name', '--moderator-user-id', '--description'].includes(key)
      || options.has(key) || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    throw new Error('Invalid arguments; use --help for usage.');
  }
  options.set(key, process.argv[++index]);
}

const clubId = options.get('--club-id');
const name = options.get('--name')?.trim();
const moderatorUserId = options.get('--moderator-user-id');
const description = options.get('--description')?.trim() || '';
if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(clubId || '')
    || !name || [...name].length > 60
    || !moderatorUserId || moderatorUserId.length > 256
    || [...description].length > 300) {
  throw new Error('Club ID, name, moderator user ID, or description is invalid.');
}
if (clubId === 'heiguang') throw new Error('The existing heiguang club cannot be replaced.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, application_name: 'blacklight-create-club' });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('hg-create-club:' || $1, 0))", [clubId]);
  const existingClub = await client.query('SELECT 1 FROM public.hg_club_config WHERE id = $1', [clubId]);
  if (existingClub.rowCount) throw new Error('Club ID already exists.');
  const user = await client.query("SELECT doc FROM public.hg_users WHERE id = $1 FOR UPDATE", [moderatorUserId]);
  if (!user.rowCount || user.rows[0].doc?.status !== 'active') throw new Error('Moderator user must already exist and be active.');
  const membershipId = `${moderatorUserId}:${clubId}`;
  const membership = await client.query('SELECT 1 FROM public.hg_memberships WHERE id = $1', [membershipId]);
  if (membership.rowCount) throw new Error('Admin membership already exists.');
  const now = new Date().toISOString();
  await client.query(
    `INSERT INTO public.hg_club_config(id, doc) VALUES ($1, $2::jsonb)`,
    [clubId, JSON.stringify({
      _id: clubId,
      name,
      description,
      status: 'active',
      discoverable: false,
      capabilities: { publishing: false, uploads: false, publicScope: false, video: false, anthology: false, export: false },
      usageLimits: { userUploadDailyBytes: 20971520, clubUploadDailyBytes: 209715200, reviewDailyCalls: 1000, warningRatio: 0.8 },
      createdBy: moderatorUserId,
      rulesVersion: 'v1.0',
      createdAt: now,
      updatedAt: now,
    })],
  );
  await client.query(
    `INSERT INTO public.hg_memberships(id, doc) VALUES ($1, $2::jsonb)`,
    [membershipId, JSON.stringify({
      _id: membershipId,
      userId: moderatorUserId,
      clubId,
      status: 'active',
      role: 'moderator',
      version: 1,
      joinedAt: now,
      updatedAt: now,
    })],
  );
  await client.query('COMMIT');
  process.stdout.write(`Created ${clubId} with its first moderator.\n`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
