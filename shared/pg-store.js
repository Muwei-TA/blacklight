/** PostgreSQL repository compatibility boundary; no NoSQL SDK calls.
 * Domain predicates are encoded as data and executed by restricted PostgreSQL RPCs.
 * RPC/table privileges are service_role only. Never expose this module as an API action.
 */
const { randomUUID } = require('node:crypto');
const { COLLECTIONS } = require('./constants');
const allowed = new Set(Object.values(COLLECTIONS));
let client;
function getClient() {
  if (!client) {
    if (!process.env.CLOUDBASE_APIKEY) throw new Error('Server database credential unavailable');
    const cloudbase = require('@cloudbase/js-sdk');
    client = cloudbase.init({ env: process.env.TCB_ENV || process.env.SCF_NAMESPACE, region: 'ap-shanghai', accessKey: process.env.CLOUDBASE_APIKEY }).rdb();
  }
  return client;
}
async function rpc(name, args) {
  const { data, error } = await getClient().rpc(name, args);
  if (error) {
    const err = new Error(error.message || 'PostgreSQL operation failed');
    err.code = error.code;
    throw err;
  }
  return data;
}

const op = (kind, value) => ({ $op: kind, value });
const command = Object.fromEntries(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'nin', 'exists', 'inc'].map((k) => [k, (value) => op(k, value)]));
command.and = (value) => ({ $and: value });
command.or = (value) => ({ $or: value });
const serverDate = () => new Date().toISOString();
class Query {
  constructor(name, query = {}, order = [], limit = 100, single = false) {
    if (!allowed.has(name)) throw new Error('Unknown repository');
    Object.assign(this, { name, query, order, take: limit, single });
  }
  where(query) { return new Query(this.name, query, this.order, this.take); }
  doc(id) { return new Query(this.name, { _id: id }, this.order, 1, true); }
  orderBy(field, direction) { return new Query(this.name, this.query, [...this.order, [field, direction]], this.take, this.single); }
  limit(limit) { return new Query(this.name, this.query, this.order, limit, this.single); }
  async execute(kind, data = {}) {
    return rpc('hg_store', { p_table: this.name, p_op: kind, p_query: this.query, p_data: data, p_order: this.order, p_limit: this.take });
  }
  async get() { const result = await this.execute('get'); return this.single ? { data: result.data[0] || null } : result; }
  count() { return this.execute('count'); }
  add({ data }) { return this.execute('add', { ...data, _id: data._id || randomUUID() }); }
  update({ data }) { return this.execute('update', data); }
  remove() { return this.execute('remove'); }
}
function collection(name) { return new Query(name); }
function RegExpFilter({ regexp, options }) { return { $op: 'regex', value: regexp, options }; }
module.exports = { collection, command, serverDate, RegExp: RegExpFilter, rpc };
