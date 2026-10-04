#!/usr/bin/env bash
set -euo pipefail
# The shared migrator records checksums and verifies all 27 migrations.
# This file runs only on initial PostgreSQL volume creation.
password_file="$(mktemp)"
trap 'rm -f "$password_file"' EXIT
chmod 0600 "$password_file"
printf '%s' "$POSTGRES_APP_PASSWORD" > "$password_file"
NAS_APP_DATABASE_PASSWORD_FILE="$password_file" \
bash /usr/local/bin/local-apply-migrations
