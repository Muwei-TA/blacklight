-- R04/R05: indexes for owned image intents, expiry cleanup and one-time
-- server-side file binding. The document store keeps the existing API shape;
-- these indexes only make quota/status scans predictable.

CREATE INDEX hg_assets_image_owner_status_created_idx
  ON public.hg_assets ((doc->>'ownerId'), (doc->>'mediaType'), (doc->>'status'), (doc->'createdAt'));

CREATE INDEX hg_assets_image_expiry_idx
  ON public.hg_assets ((doc->>'mediaType'), (doc->>'status'), (doc->>'expiresAt'));

CREATE UNIQUE INDEX hg_assets_bound_file_id_idx
  ON public.hg_assets ((doc->>'fileId'))
  WHERE COALESCE(doc->>'fileId', '') <> '';
