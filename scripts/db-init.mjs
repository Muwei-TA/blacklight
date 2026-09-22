/** Print the PostgreSQL migration plan; this command never mutates a cloud environment. */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../cloudbase/migrations/', import.meta.url));
const migrations = readdirSync(dir).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
const plan = {
  backend: 'PostgreSQL', migrations,
  permissions: 'Business tables and RPCs: service_role only; storage bucket private with no client RLS policies.',
  storage: 'blacklight-private',
  setup: 'docs/cloudbase-development.md',
};
if (process.argv.includes('--json')) console.log(JSON.stringify(plan, null, 2));
else {
  console.log(`PostgreSQL migrations: ${migrations.length}`);
  migrations.forEach((file) => console.log(`  ${file}`));
  console.log('\nPreview: tcb db pg migration up -e <envId> --dry-run');
  console.log('Apply:   tcb db pg migration up -e <envId>');
  console.log('Verify:  tcb db pg migration list -e <envId>');
  console.log('\nCreate the private PG storage bucket and seed club configuration as described in docs/cloudbase-development.md.');
  console.log('The first moderator requires explicit account authorization; no hard-coded account is bootstrapped.');
}
