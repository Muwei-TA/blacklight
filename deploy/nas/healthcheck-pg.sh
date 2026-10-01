#!/bin/sh
set -eu

pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"

relations="$(psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq \
  -c "SELECT (to_regclass('nas_meta.schema_migrations') IS NOT NULL) AND (to_regclass('public.hg_sessions') IS NOT NULL)")"
[ "$relations" = "t" ] || exit 1

migration_count="$(psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq \
  -c "SELECT count(*) FROM nas_meta.schema_migrations")"
[ "$migration_count" = "22" ]
