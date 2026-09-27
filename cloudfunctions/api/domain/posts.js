/**
 * 兼容聚合入口：保留现有 posts action 与跨领域调用的导出名。
 * 具体用例按信息流、内容写入、互动、评论、我的内容和举报分模块维护。
 */
const feed = require('./posts/feed');
const content = require('./posts/content');
const reactions = require('./posts/reactions');
const comments = require('./posts/comments');
const myContents = require('./posts/my-contents');
const reports = require('./posts/reports');

module.exports = {
  listFeed: feed.listFeed,
  getDetail: feed.getDetail,
  createPost: content.createPost,
  resubmitRejectedPost: content.resubmitRejectedPost,
  changeVisibility: content.changeVisibility,
  deletePost: content.deletePost,
  toggleReaction: reactions.toggleReaction,
  toggleBookmark: reactions.toggleBookmark,
  listComments: comments.listComments,
  createComment: comments.createComment,
  toggleCommentReaction: comments.toggleCommentReaction,
  deleteComment: comments.deleteComment,
  listMyContents: myContents.listMyContents,
  createReport: reports.createReport,
  buildFeedWhere: feed.buildFeedWhere,
  hydrateCards: feed.hydrateCards,
};
