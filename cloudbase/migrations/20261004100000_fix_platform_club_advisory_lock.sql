-- Parenthesize JSON text extraction before concatenating the shared lock key.
-- The already-applied admin-governance migration installed the unparenthesized
-- expression, which PostgreSQL can parse as a JSON operator over "hg..." text.
DO $fix_platform_club_advisory_lock$
DECLARE
  definition text;
  needle text := $needle$hashtextextended('hg-governance:'||p_payload->>'id'||':members',0)$needle$;
  replacement text := $replacement$hashtextextended('hg-governance:'||(p_payload->>'id')||':members',0)$replacement$;
BEGIN
  definition := pg_get_functiondef('public.hg_platform_clubs(text,text,jsonb)'::regprocedure);
  IF position(needle IN definition) > 0 THEN
    EXECUTE replace(definition, needle, replacement);
  ELSIF position(replacement IN definition) = 0 THEN
    RAISE EXCEPTION 'PLATFORM_CLUB_ADVISORY_LOCK_PATCH_POINT_MISSING';
  END IF;
END
$fix_platform_club_advisory_lock$;
