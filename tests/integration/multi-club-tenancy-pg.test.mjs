import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const databaseUrl = process.env.PG_TEST_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/blacklight_test' || process.env.HG_TEST_DATABASE_RESET !== 'yes') {
  throw new Error('Use an isolated blacklight_test database and HG_TEST_DATABASE_RESET=yes; never run on application data.');
}

test('two-club PostgreSQL tenant boundaries, idempotency, and XP partitions', async () => {
  const script = fileURLToPath(new URL('./multi-club-tenancy.sql', import.meta.url));
  const { stdout } = await exec('psql', [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '--file', script], {
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.match(stdout, /PASS: tenant store, actor\/role isolation, linked-object checks, idempotency, club directory, XP partitions/);
});
