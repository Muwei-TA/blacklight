-- Hot-path read indexes (2026-09-25).
--
-- These cover per-request reads that had no matching index and relied on
-- table scans (fine at current size, linear pain as data grows):
--   * feed / topic / profile hydration: my reaction and bookmark flags
--     (userId + postId IN) and the bookmark-tab pagination (userId + createdAt)
--   * message-list pagination and unread-count polling (recipientId + createdAt)
--   * my followed topics and topic-list hydration (userId [+ topicId IN])
-- All of them are equality-prefix indexes that match the where clauses built
-- by shared/policies-backed domain reads; ordering still rides the existing
-- created_idx where applicable.
-- Rollback: additive only; DROP INDEX to reclaim the write overhead.

CREATE INDEX IF NOT EXISTS hg_reactions_viewer_post_idx
  ON public.hg_reactions ((doc->>'userId'), (doc->>'postId'));
CREATE INDEX IF NOT EXISTS hg_bookmarks_viewer_idx
  ON public.hg_bookmarks ((doc->>'userId'), (doc->'createdAt'));
CREATE INDEX IF NOT EXISTS hg_notifications_recipient_idx
  ON public.hg_notifications ((doc->>'recipientId'), (doc->'createdAt'));
CREATE INDEX IF NOT EXISTS hg_topic_follows_viewer_idx
  ON public.hg_topic_follows ((doc->>'userId'));
