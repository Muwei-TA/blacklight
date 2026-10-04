'use strict';

/** Direct PostgreSQL adapter for the existing hg_* JSONB tables and RPCs. */

const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { COLLECTIONS, DEFAULT_CLUB_ID } = require('./constants');

const RPC_NAMES = new Set([
  'hg_platform_clubs',
  'hg_article_draft',
  'hg_store',
  'hg_create_post',
  'hg_resubmit_rejected_post',
  'hg_toggle_reaction',
  'hg_create_comment',
  'hg_image_intent',
  'hg_claim_image',
  'hg_confirm_image',
  'hg_apply_membership',
  'hg_apply_invitation',
  'hg_request_account_deletion',
  'hg_finish_account_deletion',
  'hg_moderate',
  'hg_comment_queue',
  'hg_usage_status',
  'hg_governance',
  'hg_governance_admin',
  'hg_create_invite',
  'hg_admin_management',
  'hg_decide_membership_application',
  'hg_management_term_reminders',
  'hg_admin_appeals_queue',
  'hg_create_board',
  'hg_decide_board',
  'hg_user_levels_check_in',
  'hg_user_levels_snapshot',
  'hg_user_clubs',
  'hg_all_club_ids',
  'hg_usage_reserve_review_call',
  'hg_finish_review',
  'hg_cleanup_asset',
  'hg_orphan_asset_candidates',
]);

const allowed = new Set(Object.values(COLLECTIONS));
let pool;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    const max = Number(process.env.PG_POOL_MAX || 10);
    pool = new Pool({
      connectionString,
      max: Number.isInteger(max) && max > 0 ? Math.min(max, 50) : 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      application_name: process.env.PG_APPLICATION_NAME || 'blacklight-nas-backend',
    });
    pool.on('error', (error) => {
      console.error('[pg] idle client error', { code: error.code || 'unknown' });
    });
  }
  return pool;
}

async function rpc(name, args = {}) {
  if (typeof name !== 'string' || !RPC_NAMES.has(name)) throw new Error('Unsupported database operation');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid database operation arguments');
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  for (const [key] of entries) {
    if (!/^p_[a-z0-9_]+$/.test(key)) throw new Error('Invalid database operation argument');
  }
  const call = entries.map(([key], index) => `${key} => $${index + 1}`).join(', ');
  const values = entries.map(([, value]) => (
    value && typeof value === 'object' ? JSON.stringify(value) : value
  ));
  const result = await getPool().query(`SELECT public.${name}(${call}) AS value`, values);
  return result.rows[0] ? result.rows[0].value : null;
}

const op = (kind, value) => ({ $op: kind, value });
const command = Object.fromEntries(
  ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'nin', 'exists', 'inc'].map((kind) => [kind, (value) => op(kind, value)]),
);
command.and = (value) => ({ $and: value });
command.or = (value) => ({ $or: value });
const serverDate = () => new Date().toISOString();

class Query {
  constructor(name, clubId = DEFAULT_CLUB_ID, query = {}, order = [], limit = 100, single = false) {
    if (!allowed.has(name)) throw new Error('Unknown repository');
    Object.assign(this, { name, clubId, query, order, take: limit, single });
  }

  where(query) { return new Query(this.name, this.clubId, query, this.order, this.take); }
  doc(id) { return new Query(this.name, this.clubId, { _id: id }, this.order, 1, true); }
  orderBy(field, direction) { return new Query(this.name, this.clubId, this.query, [...this.order, [field, direction]], this.take, this.single); }
  limit(limit) { return new Query(this.name, this.clubId, this.query, this.order, limit, this.single); }

  async execute(kind, data = {}) {
    return rpc('hg_store', {
      p_table: this.name,
      p_op: kind,
      p_query: this.query,
      p_data: data,
      p_order: this.order,
      p_limit: this.take,
      p_club_id: this.clubId,
    });
  }

  async get() {
    const result = await this.execute('get');
    return this.single ? { data: result.data[0] || null } : result;
  }

  count() { return this.execute('count'); }
  add({ data }) { return this.execute('add', { ...data, _id: data._id || randomUUID() }); }
  update({ data }) { return this.execute('update', data); }
  remove() { return this.execute('remove'); }
}

function collection(name, clubId = DEFAULT_CLUB_ID) { return new Query(name, clubId); }
function RegExpFilter({ regexp, options }) { return { $op: 'regex', value: regexp, options }; }

async function query(text, values = []) {
  return getPool().query(text, values);
}

async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function ping() {
  await getPool().query('SELECT 1');
  return true;
}

async function close() {
  if (!pool) return;
  const active = pool;
  pool = null;
  await active.end();
}

module.exports = { collection, command, serverDate, RegExp: RegExpFilter, rpc, query, withTransaction, ping, close };
