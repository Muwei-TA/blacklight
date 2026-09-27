/**
 * Test-only Mini Program -> real API router/handler bridge.
 *
 * The storage below is deliberately in-memory. It exercises request mapping,
 * router error mapping, session resolution, policies, presenters, and comment
 * handlers. PostgreSQL transaction behavior remains covered only by the
 * isolated tests/integration/comment-reaction-pg.test.mjs suite.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '../..');
const apiDirectory = resolve(here, '../../cloudfunctions/api');
const apiEntry = resolve(apiDirectory, 'index.js');
const dbModulePath = resolve(apiDirectory, 'shared/db.js');
const errorsModulePath = resolve(apiDirectory, 'shared/errors.js');
const imageProcessingModulePath = resolve(apiDirectory, 'shared/image-processing.js');
const reviewModulePath = resolve(apiDirectory, 'domain/foreground-review.js');
const expectedAppId = process.env.MINIPROGRAM_APP_ID || 'wx39773ed34aa30776';
const invocationStorage = new AsyncLocalStorage();
let apiRuntime;
let apiCacheBeforeLoad;
let activeHarnesses = 0;
let sharedDirectoriesCreatedByHarness = [];

const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const scalar = (value) => (value instanceof Date ? value.toISOString() : value);

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some((part) => matches(doc, part));
    if (key === '$and') return value.every((part) => matches(doc, part));
    const actual = scalar(doc[key]);
    if (value && value.$op) {
      const expected = scalar(value.value);
      if (value.$op === 'in') return expected.includes(actual);
      if (value.$op === 'exists') return Object.hasOwn(doc, key) === expected;
      if (value.$op === 'regex') {
        try { return new RegExp(expected, value.options || '').test(String(actual || '')); } catch (_) { return false; }
      }
      if (value.$op === 'neq') return actual !== expected;
      if (value.$op === 'lt') return actual < expected;
      if (value.$op === 'lte') return actual <= expected;
      if (value.$op === 'gt') return actual > expected;
      if (value.$op === 'gte') return actual >= expected;
      return false;
    }
    return actual === scalar(value);
  });
}

function sortRows(rows, order = []) {
  return rows.slice().sort((a, b) => {
    for (const [field, direction] of order) {
      const left = scalar(a[field]);
      const right = scalar(b[field]);
      if (left === right) continue;
      return (left < right ? -1 : 1) * (direction === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

/** Create a small, isolated storage adapter with ready-to-use comment fixtures. */
export function createCommentMemoryDatabase(seed = {}) {
  const store = new Map(Object.entries({
    hg_users: [
      { _id: 'user-1', wxOpenIdRef: 'openid-member-1', displayName: '成员一', status: 'active' },
      { _id: 'user-2', wxOpenIdRef: 'openid-member-2', displayName: '成员二', status: 'active' },
      { _id: 'post-author', wxOpenIdRef: 'openid-post-author', displayName: '帖子作者', status: 'active' },
    ],
    hg_memberships: [
      { _id: 'user-1:heiguang', userId: 'user-1', clubId: 'heiguang', role: 'member', status: 'active' },
      { _id: 'user-2:heiguang', userId: 'user-2', clubId: 'heiguang', role: 'member', status: 'active' },
      { _id: 'post-author:heiguang', userId: 'post-author', clubId: 'heiguang', role: 'member', status: 'active' },
    ],
    hg_club_config: [
      { _id: 'heiguang', clubId: 'heiguang', name: '黑光文学社', capabilities: { publishing: true } },
    ],
    hg_posts: [{
      _id: 'post-1', clubId: 'heiguang', ownerId: 'post-author', kind: 'fragment', title: '',
      body: '本地测试帖子', visibility: 'club', identityMode: 'named', status: 'published',
      commentsEnabled: true, version: 1, reactionCount: 0, commentCount: 3,
      createdAt: '2026-09-26T00:00:00.000Z',
    }],
    hg_comments: [
      { _id: 'c1', postId: 'post-1', ownerId: 'user-1', replyToId: '', body: 'member-1 的一级回应',
        identityMode: 'named', status: 'published', version: 1, reactionCount: 0,
        createdAt: '2026-09-26T00:00:01.000Z' },
      { _id: 'c2', postId: 'post-1', ownerId: 'user-2', replyToId: 'c1', body: 'member-2 的回复',
        identityMode: 'named', status: 'published', version: 1, reactionCount: 0,
        createdAt: '2026-09-26T00:00:02.000Z' },
      { _id: 'c3', postId: 'post-1', ownerId: 'user-2', replyToId: '', body: 'member-2 的一级回应',
        identityMode: 'named', status: 'published', version: 1, reactionCount: 0,
        createdAt: '2026-09-26T00:00:03.000Z' },
      { _id: 'c4', postId: 'post-1', ownerId: 'user-1', replyToId: '', body: 'member-1 的待审回应',
        identityMode: 'named', status: 'pending', version: 1,
        createdAt: '2026-09-26T00:00:04.000Z' },
    ],
    hg_reactions: [],
    hg_anonymous_identities: [],
    hg_bookmarks: [],
    ...seed,
  }));
  const idempotency = new Map();
  let stampSequence = 0;
  let paginationCalls = 0;
  const rows = (table) => store.get(table) || [];
  const commands = Object.fromEntries(
    ['in', 'exists', 'neq', 'lt', 'lte', 'gt', 'gte', 'inc'].map((op) => [op, (value) => ({ $op: op, value })]),
  );

  const db = {
    command: () => commands,
    serverDate: () => new Date(Date.UTC(2026, 8, 26, 12, 0, stampSequence++)).toISOString(),
    findOneById: async (table, id) => clone(rows(table).find((doc) => doc._id === id) || null),
    findByIds: async (table, ids = []) => clone(rows(table).filter((doc) => ids.includes(doc._id))),
    coll(table) {
      const query = {
        filter: {}, order: [], take: Infinity,
        where(value) { this.filter = value; return this; },
        orderBy(field, direction) { this.order.push([field, direction]); return this; },
        limit(value) { this.take = value; return this; },
        doc(id) { this.filter = { _id: id }; return this; },
        async get() {
          const found = sortRows(rows(table).filter((doc) => matches(doc, this.filter)), this.order).slice(0, this.take);
          return { data: clone(found) };
        },
        async add({ data }) {
          if (rows(table).some((doc) => doc._id === data._id)) {
            throw Object.assign(new Error('duplicate key'), { code: '23505' });
          }
          store.set(table, [...rows(table), clone(data)]);
          return { _id: data._id };
        },
        async update({ data }) {
          const selected = rows(table).filter((doc) => matches(doc, this.filter));
          selected.forEach((doc) => Object.entries(data).forEach(([key, value]) => {
            doc[key] = value && value.$op === 'inc' ? (doc[key] || 0) + value.value : value;
          }));
          return { stats: { updated: selected.length } };
        },
        async remove() {
          const before = rows(table).length;
          store.set(table, rows(table).filter((doc) => !matches(doc, this.filter)));
          return { stats: { removed: before - rows(table).length } };
        },
      };
      return query;
    },
    async paginate(table, where, { cursor, pageSize, order = 'desc' }) {
      paginationCalls += 1;
      const sorted = sortRows(rows(table).filter((doc) => matches(doc, where)), [
        ['createdAt', order], ['_id', order],
      ]);
      const after = sorted.filter((doc) => {
        if (!cursor) return true;
        const cmp = scalar(doc.createdAt).localeCompare(new Date(cursor.createdAt).toISOString())
          || doc._id.localeCompare(cursor.id);
        return order === 'asc' ? cmp > 0 : cmp < 0;
      });
      return { items: clone(after.slice(0, pageSize)), hasMore: after.length > pageSize };
    },
    async updateWithVersion(table, id, version, patch) {
      const doc = rows(table).find((entry) => entry._id === id);
      if (!doc || doc.version !== version) {
        const errors = require('../../shared/errors.js');
        throw errors.conflict('内容已被更新，请刷新后重试', { field: 'expectedVersion' });
      }
      Object.assign(doc, clone(patch), { version: version + 1, updatedAt: db.serverDate() });
      return version + 1;
    },
    async incCounter(table, id, field, delta) {
      const doc = rows(table).find((entry) => entry._id === id);
      if (doc) doc[field] = Math.max(0, (doc[field] || 0) + delta);
    },
    getDb() {
      return {
        async rpc(name, args) {
          if (name === 'hg_create_board') {
            const actorId = args.p_actor_id;
            const member = rows('hg_memberships').find((entry) => entry.userId === actorId
              && entry.clubId === 'heiguang' && entry.status === 'active');
            if (!member) throw new Error('FORBIDDEN');
            const boardInput = args.p_board;
            const normalizedTitle = boardInput.title.trim().toLocaleLowerCase();
            const duplicate = rows('hg_boards').find((entry) => entry.clubId === 'heiguang'
              && ['pending', 'active'].includes(entry.status)
              && entry.title.trim().toLocaleLowerCase() === normalizedTitle);
            if (duplicate) {
              if (duplicate.status === 'active' || duplicate.ownerId === actorId) {
                return { duplicated: true, id: duplicate._id, status: duplicate.status };
              }
              throw new Error('BOARD_NAME_CONFLICT');
            }
            const status = ['admin', 'moderator'].includes(member.role) ? 'active' : 'pending';
            const board = {
              ...clone(boardInput), clubId: 'heiguang', ownerId: actorId,
              status, version: 1,
            };
            store.set('hg_boards', [...rows('hg_boards'), board]);
            return { duplicated: false, id: board._id, status };
          }
          if (name === 'hg_decide_board') {
            const actorId = args.p_actor_id;
            const member = rows('hg_memberships').find((entry) => entry.userId === actorId
              && entry.clubId === 'heiguang' && entry.status === 'active'
              && ['admin', 'moderator'].includes(entry.role));
            if (!member) throw new Error('FORBIDDEN');
            const input = args.p_input;
            const board = rows('hg_boards').find((entry) => entry._id === input.id);
            if (!board || board.clubId !== 'heiguang') throw new Error('BOARD_NOT_FOUND');
            if (board.version !== input.expectedVersion || board.status !== 'pending') {
              throw new Error('VERSION_CONFLICT');
            }
            if (input.decision === 'reject' && !input.reason.trim()) throw new Error('REASON_REQUIRED');
            const status = input.decision === 'approve' ? 'active' : 'rejected';
            Object.assign(board, {
              status,
              rejectReason: status === 'rejected' ? input.reason : '',
              version: board.version + 1,
            });
            store.set('hg_audit_logs', [...rows('hg_audit_logs'), {
              _id: `audit:${board._id}`, actorId, action: 'board.decide', targetType: 'board',
              targetId: board._id, decision: input.decision, reason: input.reason,
            }]);
            return { ok: true, status, version: board.version };
          }
          if (name === 'hg_create_post') {
            const post = clone(args.p_post);
            if (post.boardId) {
              const board = rows('hg_boards').find((entry) => entry._id === post.boardId);
              const member = rows('hg_memberships').find((entry) => entry.userId === post.ownerId
                && entry.clubId === post.clubId && entry.status === 'active');
              if (post.visibility === 'private') throw new Error('PRIVATE_BOARD');
              if (!board || board.status !== 'active' || !member) throw new Error('BOARD_NOT_AVAILABLE');
            }
            store.set('hg_posts', [...rows('hg_posts'), post]);
            return { id: post._id, version: 1, state: post.visibility === 'private' ? 'private_saved' : 'pending' };
          }
          if (name === 'hg_resubmit_rejected_post') {
            const post = rows('hg_posts').find((entry) => entry._id === args.p_post_id);
            if (!post || post.ownerId !== args.p_actor_id || post.status !== 'rejected'
              || post.version !== args.p_expected_version) throw new Error('VERSION_CONFLICT');
            Object.assign(post, {
              title: args.p_title, body: args.p_body, status: 'pending',
              version: post.version + 1,
            });
            return { id: post._id, status: 'pending', version: post.version };
          }
          if (name === 'hg_toggle_reaction') {
            const { p_actor_id: userId, p_post_id: postId, p_comment_id: commentId, p_next: next } = args;
            const membership = rows('hg_memberships').find((m) => m.userId === userId
              && m.clubId === rows('hg_posts').find((p) => p._id === postId)?.clubId && m.status === 'active');
            const post = rows('hg_posts').find((entry) => entry._id === postId);
            const target = (commentId ? rows('hg_comments') : rows('hg_posts'))
              .find((entry) => entry._id === (commentId || postId));
            if (!post || post.status !== 'published' || !['club', 'public'].includes(post.visibility)
              || !membership || (commentId && (!target || target.status !== 'published' || target.postId !== postId))) {
              throw new Error('REACTION_TARGET_CHANGED');
            }
            const relationId = commentId ? `${userId}:comment:${commentId}` : `${userId}:${postId}`;
            const existing = rows('hg_reactions').some((relation) => relation._id === relationId);
            let changed = false;
            if (next && !existing) {
              rows('hg_reactions').push({ _id: relationId, userId, postId,
                type: 'resonance', ...(commentId ? { commentId } : {}), createdAt: db.serverDate() });
              changed = true;
            } else if (!next && existing) {
              store.set('hg_reactions', rows('hg_reactions').filter((relation) => relation._id !== relationId));
              changed = true;
            }
            const countDelta = changed ? (next ? 1 : -1) : 0;
            if (changed) target.reactionCount = Math.max(0, (target.reactionCount || 0) + countDelta);
            return { ok: true, reacted: next, count: target.reactionCount || 0 };
          }
          if (name === 'hg_create_comment') {
            const { p_key: key, p_hash: hash, p_comment: comment } = args;
            const previous = idempotency.get(key);
            if (previous) {
              if (previous.hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
              return { ...previous.result, replayed: true };
            }
            const post = rows('hg_posts').find((entry) => entry._id === comment.postId);
            const membership = rows('hg_memberships').find((m) => m.userId === comment.ownerId
              && m.clubId === post?.clubId && m.status === 'active');
            if (!post || post.status !== 'published' || post.commentsEnabled === false || !membership) {
              throw new Error('COMMENT_TARGET_CHANGED');
            }
            const created = { ...clone(comment), status: 'pending' };
            store.set('hg_comments', [...rows('hg_comments'), created]);
            const result = { id: comment._id, state: 'pending' };
            idempotency.set(key, { hash, result });
            return result;
          }
          throw new Error(`Unsupported test RPC: ${name}`);
        },
        RegExp({ regexp, options }) { return { $op: 'regex', value: regexp, options }; },
      };
    },
    get paginationCalls() { return paginationCalls; },
    dump(table) { return clone(rows(table)); },
  };
  return db;
}

const dbProxy = new Proxy({}, {
  get(_target, property) {
    if (property === 'getCloud') return () => {
      const invocation = invocationStorage.getStore();
      if (!invocation) throw new Error('No local API invocation context is active');
      return { getWXContext: () => invocation.wxContext };
    };
    return (...args) => {
      const invocation = invocationStorage.getStore();
      if (!invocation) throw new Error('No local API invocation context is active');
      const value = invocation.db[property];
      if (typeof value !== 'function') throw new TypeError(`Unsupported storage member: ${String(property)}`);
      return value.apply(invocation.db, args);
    };
  },
});

function createCacheEntry(filename, exports) {
  const entry = new Module(filename);
  entry.filename = filename;
  entry.paths = Module._nodeModulePaths(dirname(filename));
  entry.exports = exports;
  entry.loaded = true;
  return entry;
}

function loadApiWithSeams() {
  if (apiRuntime) return apiRuntime;
  if (!existsSync(resolve(apiDirectory, 'shared/router.js'))) {
    sharedDirectoriesCreatedByHarness = ['api', 'review-callback', 'worker']
      .map((name) => resolve(repositoryRoot, 'cloudfunctions', name, 'shared'))
      .filter((directory) => !existsSync(directory));
    execFileSync(process.execPath, [resolve(repositoryRoot, 'scripts/sync-shared.mjs')], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
  }
  const previousModules = new Map(Object.entries(require.cache)
    .filter(([filename]) => filename === apiDirectory || filename.startsWith(`${apiDirectory}${sep}`)));
  previousModules.forEach((_module, filename) => { delete require.cache[filename]; });
  const originalLoad = Module._load;
  const localWxSdk = {
    DYNAMIC_CURRENT_ENV: 'local-test',
    init() { return { getWXContext: () => invocationStorage.getStore()?.wxContext || {} }; },
    getWXContext: () => invocationStorage.getStore()?.wxContext || {},
  };

  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') return localWxSdk;
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved === dbModulePath) return dbProxy;
    if (resolved === reviewModulePath) return { runOwnedReview: async () => null };
    if (resolved === errorsModulePath) return require('../../shared/errors.js');
    if (resolved === imageProcessingModulePath) return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    apiRuntime = require(apiEntry);
    // router.main and createComment resolve these dependencies after awaits;
    // retain test-only cache entries so the real handlers keep using the seams.
    require.cache[dbModulePath] = createCacheEntry(dbModulePath, dbProxy);
    require.cache[reviewModulePath] = createCacheEntry(reviewModulePath, { runOwnedReview: async () => null });
    apiCacheBeforeLoad = previousModules;
    return apiRuntime;
  } finally {
    Module._load = originalLoad;
    if (!apiRuntime) {
      Object.keys(require.cache).forEach((filename) => {
        if (filename === apiDirectory || filename.startsWith(`${apiDirectory}${sep}`)) delete require.cache[filename];
      });
      previousModules.forEach((module, filename) => { require.cache[filename] = module; });
    }
  }
}

function unloadApiRuntime() {
  if (!apiRuntime || activeHarnesses > 0) return;
  Object.keys(require.cache).forEach((filename) => {
    if (filename === apiDirectory || filename.startsWith(`${apiDirectory}${sep}`)) delete require.cache[filename];
  });
  apiCacheBeforeLoad?.forEach((module, filename) => { require.cache[filename] = module; });
  sharedDirectoriesCreatedByHarness.forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  sharedDirectoriesCreatedByHarness = [];
  apiCacheBeforeLoad = null;
  apiRuntime = null;
}

/**
 * Load the production API entry/router/handlers with only identity and storage
 * seams injected. callFunction matches wx.cloud.callFunction's `{ result }` shape.
 */
export function createLocalApiHarness({ db, openid = 'openid-member-1', appId = expectedAppId } = {}) {
  if (!db || typeof db.findOneById !== 'function' || typeof db.coll !== 'function') {
    throw new TypeError('A test storage adapter is required');
  }
  const wxContext = { OPENID: openid, APPID: appId, SOURCE: 'wx' };
  const api = loadApiWithSeams();
  activeHarnesses += 1;
  let disposed = false;
  let sequence = 0;
  const invoke = (event, context = {}) => {
    if (disposed) throw new Error('Local API harness has been disposed');
    return invocationStorage.run({ db, wxContext }, () => api.main(event, {
      ...context,
      requestId: context.requestId || `local-${++sequence}`,
      environment: JSON.stringify({ WX_OPENID: openid, WX_APPID: appId }),
    }));
  };
  return {
    invoke,
    dispose() {
      if (disposed) return;
      disposed = true;
      activeHarnesses -= 1;
      unloadApiRuntime();
    },
    async callFunction({ name, data }) {
      if (name !== 'api') throw new Error(`Local API harness only supports cloud function "api", got "${name}"`);
      return { result: await invoke(data || {}) };
    },
  };
}
