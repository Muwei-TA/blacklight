#!/usr/bin/env bash
set -euo pipefail

MIGRATIONS_DIR="${LOCAL_MIGRATIONS_DIR:-/opt/blacklight/cloudbase-migrations}"
COMPAT_DIR="${LOCAL_COMPAT_DIR:-/opt/blacklight/compat}"
EXPECTED_MIGRATIONS=22

if [[ ! -r "${NAS_APP_DATABASE_PASSWORD_FILE:-}" ]]; then
  echo "local PG bootstrap requires NAS_APP_DATABASE_PASSWORD_FILE" >&2
  exit 1
fi
NAS_APP_DATABASE_PASSWORD="$(cat "$NAS_APP_DATABASE_PASSWORD_FILE")"
if [[ -z "$NAS_APP_DATABASE_PASSWORD" ]]; then
  echo "local PG bootstrap app password file is empty" >&2
  exit 1
fi
export NAS_APP_DATABASE_PASSWORD

shopt -s nullglob
migrations=("$MIGRATIONS_DIR"/*.sql)
if (( ${#migrations[@]} != EXPECTED_MIGRATIONS )); then
  echo "expected $EXPECTED_MIGRATIONS CloudBase migration files; found ${#migrations[@]}" >&2
  exit 1
fi

psql_local=(psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB")
"${psql_local[@]}" -f "$COMPAT_DIR/000_cloudbase_roles.sql" >/dev/null

for migration in "${migrations[@]}"; do
  name="$(basename "$migration")"
  sha256="$(sha256sum "$migration" | awk '{print $1}')"
  recorded="$("${psql_local[@]}" -Atq -c "SELECT sha256 FROM nas_meta.schema_migrations WHERE migration_name = '$name'")"
  if [[ -n "$recorded" ]]; then
    if [[ "$recorded" != "$sha256" ]]; then
      echo "migration checksum mismatch: $name" >&2
      exit 1
    fi
    continue
  fi

  {
    cat "$migration"
    printf "\nINSERT INTO nas_meta.schema_migrations(migration_name, sha256) VALUES ('%s', '%s');\n" "$name" "$sha256"
  } | "${psql_local[@]}" --single-transaction >/dev/null
  printf 'applied %s\n' "$name"
done

"${psql_local[@]}" -f "$COMPAT_DIR/020_hg_sessions.sql" >/dev/null
applied_count="$("${psql_local[@]}" -Atq -c 'SELECT count(*) FROM nas_meta.schema_migrations')"
if [[ "$applied_count" != "$EXPECTED_MIGRATIONS" ]]; then
  echo "migration ledger incomplete: expected $EXPECTED_MIGRATIONS, found $applied_count" >&2
  exit 1
fi
printf 'ready: %s migrations recorded; hg_sessions present\n' "$applied_count"
