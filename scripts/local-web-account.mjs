#!/usr/bin/env node
// Offline provisioning only. Password comes from a mounted file, never argv.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadSecretFiles } = require('../server/config.js');
const { createWebAuth } = require('../server/web-auth.js');
const pg = require('../shared/pg-store.js');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--help') {
    process.stdout.write('Usage: WEB_ACCOUNT_PASSWORD_FILE=/path/to/password DATABASE_URL=... node scripts/local-web-account.mjs --user-id ID --username ACCOUNT\nExisting verified users only. Sets/resets password, preserves user ID and memberships, revokes website sessions.\n');
    process.exit(0);
  }
  if (!['--user-id', '--username'].includes(process.argv[i]) || args.has(process.argv[i]) || !process.argv[i + 1]) throw new Error('Invalid arguments; see --help');
  args.set(process.argv[i], process.argv[++i]);
}
loadSecretFiles(['DATABASE_URL']);
if (!args.get('--user-id') || !args.get('--username') || !process.env.WEB_ACCOUNT_PASSWORD_FILE) throw new Error('User ID, username and WEB_ACCOUNT_PASSWORD_FILE are required');
try {
  const password = (await readFile(process.env.WEB_ACCOUNT_PASSWORD_FILE, 'utf8')).replace(/[\r\n]+$/, '');
  await createWebAuth().provisionAccount({ userId: args.get('--user-id'), username: args.get('--username'), password });
  process.stdout.write('Website credentials configured; prior website sessions revoked.\n');
} catch (error) {
  process.stderr.write(`${error.code === '23505' ? 'Website account already assigned to another user' : error.status ? error.message : 'Account provisioning failed; verify database configuration'}\n`);
  process.exitCode = 1;
} finally { await pg.close(); }
