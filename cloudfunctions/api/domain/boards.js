/** 板块领域用例。板块是帖子分流对象，与话题分开存储、授权和展示。 */

const { randomUUID } = require('node:crypto');
const { COLLECTIONS, BOARD_STATUS } = require('../shared/constants');
const policies = require('../shared/policies');
const validators = require('../shared/validators');
const presenters = require('../shared/presenters');
const errors = require('../shared/errors');
const db = require('../shared/db');

function presentBoard(board, now) {
  const statusText = {
    [BOARD_STATUS.PENDING]: '等待管理员审核',
    [BOARD_STATUS.ACTIVE]: '开放中',
    [BOARD_STATUS.REJECTED]: '未通过',
  }[board.status] || '';
  return {
    id: board._id,
    title: board.title || '',
    description: board.description || '',
    status: board.status,
    statusText,
    version: board.version || 1,
    createdAtText: presenters.formatRelativeTime(board.createdAt, now),
    ...(board.status === BOARD_STATUS.REJECTED ? { rejectReason: board.rejectReason || '' } : {}),
  };
}

/** GET /boards —— 有效成员只看已通过的板块。 */
async function list(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  const cursor = validators.parseCursor(payload.cursor);
  const pageSize = validators.clampPageSize(payload.pageSize);
  const status = payload.status === undefined || payload.status === null || payload.status === ''
    ? BOARD_STATUS.ACTIVE
    : validators.requireEnum(payload.status, 'status', [BOARD_STATUS.ACTIVE]);
  const q = payload.q === undefined || payload.q === null || payload.q === ''
    ? ''
    : validators.validateSearchQuery(payload.q);
  if (!ctx.viewer.isMember) return { items: [], nextCursor: null };

  const where = { clubId, status };
  if (q) {
    where.title = db.getDb().RegExp({
      regexp: require('./search').escapeRegex(q),
      options: 'i',
    });
  }
  const { items, hasMore } = await db.paginate(
    COLLECTIONS.boards,
    where,
    { cursor, pageSize, clubId },
  );
  return {
    items: items.map((board) => presentBoard(board, ctx.now)),
    nextCursor: hasMore && items.length > 0 ? validators.buildCursor(items[items.length - 1]) : null,
  };
}

/** GET /boards/{id} —— 非 active 板块只允许提交者与管理员查看。 */
async function detail(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  const id = validators.requireId(payload.id, 'id');
  const board = await db.findOneById(COLLECTIONS.boards, id, clubId);
  if (!policies.canReadBoard(ctx.viewer, board)) {
    throw errors.notAccessible({ boardId: id });
  }

  const posts = require('./posts');
  let items = [];
  let nextCursor = null;
  if (board.status === BOARD_STATUS.ACTIVE) {
    const page = await db.paginate(
      COLLECTIONS.posts,
      posts.buildFeedWhere(ctx.viewer, { boardId: id }),
      {
        cursor: validators.parseCursor(payload.cursor),
        pageSize: validators.clampPageSize(payload.pageSize),
        clubId,
      },
    );
    items = await posts.hydrateCards(page.items, ctx);
    nextCursor = page.hasMore && page.items.length > 0
      ? validators.buildCursor(page.items[page.items.length - 1])
      : null;
  }

  return {
    board: presentBoard(board, ctx.now),
    items,
    nextCursor,
    canPost: policies.canPostToBoard(ctx.viewer, board, ctx.capabilities),
  };
}

/** POST /boards —— 管理员创建后直接 active，普通成员的申请进入 pending。 */
async function create(payload, ctx) {
  const clubId = ctx.viewer.clubId;
  if (!ctx.viewer.isMember) throw errors.membershipInvalid();
  if (!policies.canCreatePost(ctx.viewer)) throw errors.forbidden({ reason: 'member cannot create board' });
  const input = validators.validateBoardInput(payload);
  const now = db.serverDate();
  const board = {
    _id: randomUUID(),
    title: input.title,
    description: input.description,
    createdAt: now,
    updatedAt: now,
  };

  try {
    return await db.getDb().rpc('hg_create_board', {
      p_actor_id: ctx.viewer.userId,
      p_board: board,
      p_club_id: clubId,
    });
  } catch (error) {
    const marker = `${error && error.code ? error.code : ''} ${error && error.message ? error.message : ''}`;
    if (/BOARD_NAME_CONFLICT|23505/.test(marker)) {
      throw errors.conflict('已有同名板块，请更换名称后再试');
    }
    if (/FORBIDDEN/.test(marker)) throw errors.forbidden();
    if (/INVALID/.test(marker)) throw errors.invalidInput('板块信息不合法');
    throw error;
  }
}

module.exports = { list, detail, create, presentBoard };
