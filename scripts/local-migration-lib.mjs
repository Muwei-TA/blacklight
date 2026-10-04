import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXPECTED_MIGRATION_COUNT = 27;
export const EXPECTED_BUSINESS_TABLE_COUNT = 36;
export const EXPECTED_LATEST_MIGRATION = '20261004090000_web_accounts.sql';
const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+\.sql$/;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function readMigrationSet() {
  const directory = resolve(REPOSITORY_ROOT, 'cloudbase/migrations');
  const names = (await readdir(directory)).filter((name) => MIGRATION_NAME.test(name)).sort();
  if (names.length !== EXPECTED_MIGRATION_COUNT) {
    throw new Error(`expected ${EXPECTED_MIGRATION_COUNT} migration files, found ${names.length}`);
  }
  if (names.at(-1) !== EXPECTED_LATEST_MIGRATION) {
    throw new Error(`expected latest migration ${EXPECTED_LATEST_MIGRATION}`);
  }

  const migrations = [];
  const tableMap = new Map();
  for (const name of names) {
    const source = await readFile(resolve(directory, name), 'utf8');
    migrations.push({ name, sha256: sha256(source) });
    const sql = source.replace(/--[^\n]*/g, '');
    const createTable = /\bCREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+public\.([a-z][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*;/gi;
    for (const match of sql.matchAll(createTable)) {
      const table = match[1];
      const body = match[2];
      let primaryKey = body.match(/\bPRIMARY\s+KEY\s*\(([^)]*)\)/i)?.[1]
        ?.split(',').map((column) => column.trim().replace(/^"|"$/g, ''));
      if (!primaryKey) {
        const inlineKey = body.match(/^\s*([a-z][a-z0-9_]*)\s+[^,\n]*\bPRIMARY\s+KEY\b/im);
        if (inlineKey) primaryKey = [inlineKey[1]];
      }
      if (!primaryKey || primaryKey.length === 0) {
        throw new Error(`could not determine primary key for ${table} in ${name}`);
      }
      const existing = tableMap.get(table);
      if (existing && JSON.stringify(existing.primaryKey) !== JSON.stringify(primaryKey)) {
        throw new Error(`conflicting primary key definitions for ${table}`);
      }
      tableMap.set(table, { name: table, primaryKey });
    }
    const alterPrimaryKey = /\bALTER\s+TABLE\s+(?:public\.)?([a-z][a-z0-9_]*)\s+ADD\s+PRIMARY\s+KEY\s*\(([^)]*)\)\s*;/gi;
    for (const match of sql.matchAll(alterPrimaryKey)) {
      const table = match[1];
      const primaryKey = match[2].split(',').map((column) => column.trim().replace(/^"|"$/g, ''));
      if (!tableMap.has(table) || primaryKey.length === 0) {
        throw new Error(`could not apply primary key change for ${table} in ${name}`);
      }
      tableMap.set(table, { name: table, primaryKey });
    }
  }

  const tables = [...tableMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (tables.length !== EXPECTED_BUSINESS_TABLE_COUNT || tables.some((table) => table.name === 'hg_sessions')) {
    throw new Error('migration table inventory is incomplete or includes NAS-only tables');
  }
  return {
    migrations,
    latestVersion: names.at(-1).slice(0, 14),
    tables,
    fingerprint: sha256(JSON.stringify(migrations)),
  };
}

export function safeSqlIdentifier(value) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('invalid SQL identifier');
  return `"${value}"`;
}

export function parseJsonLine(line, label) {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`invalid JSON row in ${label}`);
  }
}
