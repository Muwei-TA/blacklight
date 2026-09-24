-- Comment-level reactions and deletion (2026-09-25).
--
-- Comment reactions reuse hg_reactions with a distinct key shape:
--   post reactions:     _id = {userId}:{postId}            (doc has postId, no commentId)
--   comment reactions:  _id = {userId}:comment:{commentId} (doc has postId + commentId)
-- The worker reaction digest only aggregates rows without commentId; post
-- deletion removes every reaction carrying the postId.
-- Comment deletion is a soft delete (status='deleted'); a deleted top-level
-- comment with visible replies stays in the list as a tombstone, replies keep
-- their own rows.
-- Rollback: redeploy the previous function code; these indexes are additive.

CREATE INDEX hg_comments_post_idx ON public.hg_comments ((doc->>'postId'), (doc->'createdAt'));
CREATE INDEX hg_reactions_comment_idx ON public.hg_reactions ((doc->>'commentId')) WHERE doc->>'commentId' IS NOT NULL;
