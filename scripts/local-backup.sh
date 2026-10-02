#!/usr/bin/env bash
set -euo pipefail
umask 077

MODE="${1:-backup}"
NAS_MEDIA_DIR="${NAS_MEDIA_DIR:-/media}"
NAS_BACKUP_DIR="${NAS_BACKUP_DIR:-/backups/blacklight-nas-data}"
NAS_RESTORE_CHECK_DIR="${NAS_RESTORE_CHECK_DIR:-/restore-check}"
EXPECTED_MIGRATIONS=24
ADMIN_PASSWORD_FILE="${NAS_POSTGRES_ADMIN_PASSWORD_FILE:-/run/secrets/postgres_admin_password}"
RESTORE_DB=""
RESTORE_STAGE=""
RESTORE_MEDIA_MANIFEST=""

if [[ "${NAS_WRITES_QUIESCED:-0}" != "1" ]]; then
  echo "refusing backup/restore check unless NAS_WRITES_QUIESCED=1" >&2
  exit 1
fi
if [[ ! -r "$ADMIN_PASSWORD_FILE" ]]; then
  echo "PostgreSQL admin password file is unreadable" >&2
  exit 1
fi
PGPASSWORD="$(cat "$ADMIN_PASSWORD_FILE")"
if [[ -z "$PGPASSWORD" ]]; then
  echo "PostgreSQL admin password file is empty" >&2
  exit 1
fi
export PGPASSWORD

cleanup() {
  if [[ -n "$RESTORE_DB" ]]; then
    dropdb --if-exists -U "$POSTGRES_USER" "$RESTORE_DB" >/dev/null 2>&1 || true
  fi
  if [[ -n "$RESTORE_STAGE" && "$RESTORE_STAGE" == "$NAS_RESTORE_CHECK_DIR"/restore-check-* ]]; then
    rm -rf -- "$RESTORE_STAGE"
  fi
  if [[ -n "$RESTORE_MEDIA_MANIFEST" && "$RESTORE_MEDIA_MANIFEST" == "$NAS_RESTORE_CHECK_DIR"/restore-check-media-* ]]; then
    rm -f -- "$RESTORE_MEDIA_MANIFEST"
  fi
}
trap cleanup EXIT

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

file_bytes() {
  wc -c < "$1" | tr -d ' '
}

build_media_manifest() {
  local root="$1" output="$2" file relative digest bytes
  : > "$output"
  if find "$root" -type l -print -quit | grep -q .; then
    echo "symbolic links are not allowed in private media storage" >&2
    return 1
  fi
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    relative="${file#"$root"/}"
    case "$relative" in
      private/image/*) ;;
      *) echo "unexpected path under private media root" >&2; return 1 ;;
    esac
    if [[ "$relative" == *$'\t'* || "$relative" == *$'\n'* ]]; then
      echo "unsafe filename in private media storage" >&2
      return 1
    fi
    digest="$(hash_file "$file")"
    bytes="$(file_bytes "$file")"
    printf '%s\t%s\t%s\n' "$digest" "$bytes" "$relative" >> "$output"
  done < <(find "$root" -type f -print | LC_ALL=C sort)
}

check_media_references() {
  local index="$1" refs="$2"
  psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq \
    -c "SELECT DISTINCT substring(file_id FROM length('pgstore://blacklight-private/') + 1) FROM public.hg_assets a CROSS JOIN LATERAL (VALUES (a.doc->>'fileId'),(a.doc->>'cleanedFileId'),(a.doc->>'reservedFileId')) AS ids(file_id) WHERE NULLIF(file_id,'') IS NOT NULL AND file_id LIKE 'pgstore://blacklight-private/private/image/%' ORDER BY 1" > "$refs"
  local unsupported
  unsupported="$(psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq \
    -c "SELECT count(*) FROM public.hg_assets a CROSS JOIN LATERAL (VALUES (a.doc->>'fileId'),(a.doc->>'cleanedFileId'),(a.doc->>'reservedFileId')) AS ids(file_id) WHERE NULLIF(file_id,'') IS NOT NULL AND file_id NOT LIKE 'pgstore://blacklight-private/private/image/%'")"
  if [[ "$unsupported" != "0" ]]; then
    echo "asset references an unsupported media id" >&2
    return 1
  fi
  if ! awk -F '\t' 'FILENAME == ARGV[1] { present[$3]=1; next } !($0 in present) { missing=1 } END { exit missing }' "$index" "$refs"; then
    echo "database references media missing from the private volume" >&2
    return 1
  fi
}

schema_preflight() {
  local session_table
  session_table="$(psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq \
    -c "SELECT to_regclass('public.hg_sessions') IS NOT NULL")"
  if [[ "$session_table" != "t" ]]; then
    echo "database schema is not at the expected 24-migration NAS state" >&2
    return 1
  fi
  verify_migration_ledger "$POSTGRES_DB"
}

verify_migration_ledger() {
  local database="$1" migration name expected recorded count
  shopt -s nullglob
  local migrations=("${LOCAL_MIGRATIONS_DIR:-/opt/blacklight/cloudbase-migrations}"/*.sql)
  if (( ${#migrations[@]} != EXPECTED_MIGRATIONS )); then
    echo "backup image does not contain the expected CloudBase migrations" >&2
    return 1
  fi
  count="$(psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$database" -Atq \
    -c 'SELECT count(*) FROM nas_meta.schema_migrations')"
  if [[ "$count" != "$EXPECTED_MIGRATIONS" ]]; then
    echo "database migration ledger is incomplete" >&2
    return 1
  fi
  for migration in "${migrations[@]}"; do
    name="$(basename "$migration")"
    expected="$(hash_file "$migration")"
    recorded="$(psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$database" -Atq \
      -c "SELECT sha256 FROM nas_meta.schema_migrations WHERE migration_name = '$name'")"
    if [[ "$recorded" != "$expected" ]]; then
      echo "database migration checksum mismatch" >&2
      return 1
    fi
  done
}

capture_table_counts() {
  local file="$1" table count
  : > "$file"
  while IFS= read -r table; do
    [[ "$table" =~ ^hg_[a-z0-9_]+$ ]] || { echo "unexpected PostgreSQL table name" >&2; return 1; }
    count="$(psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq \
      -c "SELECT count(*) FROM public.\"$table\"")"
    printf '%s\t%s\n' "$table" "$count" >> "$file"
  done < <(psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq \
    -c "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename ~ '^hg_[a-z0-9_]+$' ORDER BY tablename")
}

verify_counts_in_database() {
  local database="$1" counts_file="$2" table expected actual migrations
  while IFS=$'\t' read -r table expected; do
    [[ "$table" =~ ^hg_[a-z0-9_]+$ && "$expected" =~ ^[0-9]+$ ]] || { echo "invalid table count manifest" >&2; return 1; }
    actual="$(psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$database" -Atq \
      -c "SELECT count(*) FROM public.\"$table\"")"
    [[ "$actual" == "$expected" ]] || { echo "restore table row count mismatch" >&2; return 1; }
  done < "$counts_file"
  migrations="$(psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$database" -Atq \
    -c 'SELECT count(*) FROM nas_meta.schema_migrations')"
  [[ "$migrations" == "$EXPECTED_MIGRATIONS" ]] || { echo "restore migration ledger mismatch" >&2; return 1; }
  verify_migration_ledger "$database"
  local user_rows
  user_rows="$(psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$database" -Atq \
    -c 'SELECT count(*) FROM public.hg_users')"
  [[ "$user_rows" =~ ^[1-9][0-9]*$ ]] || { echo "refusing to accept an empty user database backup" >&2; return 1; }
}

manifest_value() {
  local manifest="$1" key="$2"
  sed -n "s/^${key}=//p" "$manifest"
}

verify_backup() {
  local backup="$1" allow_preparing="${2:-no}" status expected_db_hash expected_media_hash expected_media_manifest_hash expected_table_hash
  [[ -d "$backup" && -r "$backup/manifest.txt" ]] || { echo "backup manifest missing" >&2; return 1; }
  grep -qx 'format=blacklight-nas-backup-v1' "$backup/manifest.txt"
  status="$(manifest_value "$backup/manifest.txt" status)"
  if [[ "$status" != "complete" && ! ( "$allow_preparing" == "preparing" && "$status" == "preparing" ) ]]; then
    echo "backup manifest is not complete" >&2
    return 1
  fi
  expected_db_hash="$(manifest_value "$backup/manifest.txt" database_sha256)"
  expected_media_hash="$(manifest_value "$backup/manifest.txt" media_archive_sha256)"
  expected_media_manifest_hash="$(manifest_value "$backup/manifest.txt" media_manifest_sha256)"
  expected_table_hash="$(manifest_value "$backup/manifest.txt" table_counts_sha256)"
  [[ "$expected_db_hash" =~ ^[0-9a-f]{64}$ && "$expected_media_hash" =~ ^[0-9a-f]{64}$ \
    && "$expected_media_manifest_hash" =~ ^[0-9a-f]{64}$ && "$expected_table_hash" =~ ^[0-9a-f]{64}$ ]] || {
    echo "backup checksum manifest invalid" >&2
    return 1
  }
  [[ "$(hash_file "$backup/database.dump")" == "$expected_db_hash" ]] || { echo "database dump checksum mismatch" >&2; return 1; }
  [[ "$(hash_file "$backup/media.tar.gz")" == "$expected_media_hash" ]] || { echo "media archive checksum mismatch" >&2; return 1; }
  [[ "$(hash_file "$backup/media-manifest.tsv")" == "$expected_media_manifest_hash" ]] || { echo "media manifest checksum mismatch" >&2; return 1; }
  [[ "$(hash_file "$backup/table-counts.tsv")" == "$expected_table_hash" ]] || { echo "table count manifest checksum mismatch" >&2; return 1; }
  pg_restore --list "$backup/database.dump" >/dev/null

  local restore_id staging media_check entry normalized
  restore_id="$(date -u +%Y%m%dT%H%M%SZ)_$RANDOM"
  RESTORE_DB="nas_restore_check_$restore_id"
  staging="$NAS_RESTORE_CHECK_DIR/restore-check-$restore_id"
  RESTORE_STAGE="$staging"
  RESTORE_MEDIA_MANIFEST="$NAS_RESTORE_CHECK_DIR/restore-check-media-$restore_id.tsv"
  case "$staging" in "$NAS_RESTORE_CHECK_DIR"/restore-check-*) ;; *) echo "unsafe restore-check path" >&2; return 1 ;; esac
  mkdir -m 700 "$staging"
  createdb -U "$POSTGRES_USER" "$RESTORE_DB"
  pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$RESTORE_DB" "$backup/database.dump"
  verify_counts_in_database "$RESTORE_DB" "$backup/table-counts.tsv"

  while IFS= read -r entry; do
    normalized="${entry#./}"
    case "$entry" in /*|../*|*/../*|*/..|..) echo "unsafe path in media archive" >&2; return 1 ;; esac
    [[ "$normalized" != *$'\t'* && "$normalized" != *$'\n'* ]] || { echo "unsafe path in media archive" >&2; return 1; }
  done < <(tar -tzf "$backup/media.tar.gz")
  tar -xzf "$backup/media.tar.gz" --no-same-owner --no-same-permissions -C "$staging"
  if find "$staging" -type l -print -quit | grep -q .; then
    echo "restore media contains symbolic links" >&2
    return 1
  fi
  build_media_manifest "$staging" "$RESTORE_MEDIA_MANIFEST"
  if ! cmp -s "$RESTORE_MEDIA_MANIFEST" "$backup/media-manifest.tsv"; then
    echo "restored media inventory/checksum mismatch" >&2
    return 1
  fi
  dropdb -U "$POSTGRES_USER" "$RESTORE_DB"
  RESTORE_DB=""
  rm -rf -- "$RESTORE_STAGE"
  RESTORE_STAGE=""
  rm -f -- "$RESTORE_MEDIA_MANIFEST"
  RESTORE_MEDIA_MANIFEST=""
  echo "restore rehearsal passed: database and private media verified; temporary database and staging copy removed"
}

backup() {
  schema_preflight
  [[ -d "$NAS_MEDIA_DIR" && -d "$NAS_BACKUP_DIR" && -d "$NAS_RESTORE_CHECK_DIR" ]] || {
    echo "media, backup, or restore-check mount is missing" >&2
    return 1
  }
  chmod 0700 "$NAS_BACKUP_DIR" "$NAS_RESTORE_CHECK_DIR"
  local backup_id backup_dir media_manifest table_counts refs media_files media_bytes db_bytes db_hash media_hash media_manifest_hash user_rows
  backup_id="$(date -u +%Y%m%dT%H%M%SZ)_$RANDOM"
  backup_dir="$NAS_BACKUP_DIR/$backup_id"
  mkdir -m 700 "$backup_dir"
  media_manifest="$backup_dir/media-manifest.tsv"
  table_counts="$backup_dir/table-counts.tsv"
  refs="$backup_dir/.media-references"
  build_media_manifest "$NAS_MEDIA_DIR" "$media_manifest"
  check_media_references "$media_manifest" "$refs"
  rm -f -- "$refs"
  capture_table_counts "$table_counts"
  user_rows="$(awk -F '\t' '$1 == "hg_users" {print $2}' "$table_counts")"
  if [[ ! "$user_rows" =~ ^[1-9][0-9]*$ ]]; then
    echo "refusing a complete data backup of an empty staging database; hg_users has no rows" >&2
    return 1
  fi
  media_files="$(wc -l < "$media_manifest" | tr -d ' ')"
  media_bytes="$(awk -F '\t' '{ total += $2 } END { printf "%.0f", total }' "$media_manifest")"
  db_bytes="$(psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq -c 'SELECT pg_database_size(current_database())')"
  local available_kb
  available_kb="$(df -Pk "$NAS_BACKUP_DIR" | awk 'NR==2 {print $4}')"
  if [[ ! "$available_kb" =~ ^[0-9]+$ || ! "$db_bytes" =~ ^[0-9]+$ ]] \
    || (( available_kb * 1024 < media_bytes + db_bytes + 1073741824 )); then
    echo "insufficient free space on the /vol2 backup volume" >&2
    return 1
  fi

  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --file="$backup_dir/database.dump.part"
  mv "$backup_dir/database.dump.part" "$backup_dir/database.dump"
  tar -czf "$backup_dir/media.tar.gz.part" -C "$NAS_MEDIA_DIR" .
  mv "$backup_dir/media.tar.gz.part" "$backup_dir/media.tar.gz"
  db_hash="$(hash_file "$backup_dir/database.dump")"
  media_hash="$(hash_file "$backup_dir/media.tar.gz")"
  media_manifest_hash="$(hash_file "$media_manifest")"
  cat > "$backup_dir/manifest.txt.tmp" <<EOF
format=blacklight-nas-backup-v1
status=preparing
created_at=$backup_id
database_dump=database.dump
database_sha256=$db_hash
media_archive=media.tar.gz
media_archive_sha256=$media_hash
media_manifest=media-manifest.tsv
media_manifest_sha256=$media_manifest_hash
media_files=$media_files
media_bytes=$media_bytes
table_counts=table-counts.tsv
table_counts_sha256=$(hash_file "$table_counts")
migrations=$EXPECTED_MIGRATIONS
EOF
  mv "$backup_dir/manifest.txt.tmp" "$backup_dir/manifest.txt"
  verify_backup "$backup_dir" preparing
  sed 's/^status=preparing$/status=complete/' "$backup_dir/manifest.txt" > "$backup_dir/manifest.txt.check"
  mv "$backup_dir/manifest.txt.check" "$backup_dir/manifest.txt"
  chmod 0600 "$backup_dir"/*
  echo "backup complete on /vol2: $backup_id; media files=$media_files, bytes=$media_bytes"
}

case "$MODE" in
  backup) backup ;;
  verify)
    [[ -n "${2:-}" && "$2" == "$NAS_BACKUP_DIR"/* ]] || { echo "usage: local-backup verify <backup-directory-under-/vol2>" >&2; exit 1; }
    verify_backup "$2"
    ;;
  *) echo "usage: local-backup [backup|verify <backup-directory>]" >&2; exit 2 ;;
esac
