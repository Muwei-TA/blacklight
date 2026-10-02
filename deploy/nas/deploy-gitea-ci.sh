#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY_ROOT=/workspace
readonly COMPOSE_FILE=/workspace/deploy/nas/compose.yaml
readonly NAS_DATA_ROOT=/vol1/docker/blacklight-nas-gitea-ci
readonly NAS_BACKUP_ROOT=/vol2/backups/blacklight-nas-gitea-ci
readonly NAS_COMPOSE_PROJECT_NAME=blacklight-nas-gitea-ci
readonly NAS_NETWORK_PREFIX=blacklight-nas-gitea-ci
readonly NAS_PG_IMAGE=blacklight-nas-gitea-ci-postgres:16
readonly API_BIND_IP=192.168.50.28
readonly API_BIND_PORT=18119
readonly PUBLIC_API_BASE_URL=http://192.168.50.28:18119
readonly STACK_MARKER="$NAS_DATA_ROOT/.gitea-stack-id"
readonly DB_INITIALIZED_MARKER="$NAS_DATA_ROOT/.gitea-db-initialized"
readonly LAST_GOOD_IMAGE_FILE="$NAS_DATA_ROOT/.gitea-last-good-app-image"

fail() {
  printf 'NAS deployment refused: %s\n' "$1" >&2
  exit 1
}

require_env_value() {
  local key=$1 expected=$2 count value
  count=$(awk -F= -v key="$key" '$1 == key { count++ } END { print count + 0 }' "$NAS_DATA_ROOT/.env")
  [[ "$count" == 1 ]] || fail "expected exactly one $key entry in the managed .env file"
  value=$(awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1) }' "$NAS_DATA_ROOT/.env")
  [[ "$value" == "$expected" ]] || fail "$key in the managed .env file does not match the isolated stack"
}

require_present_env() {
  local key=$1 count value
  count=$(awk -F= -v key="$key" '$1 == key { count++ } END { print count + 0 }' "$NAS_DATA_ROOT/.env")
  [[ "$count" == 1 ]] || fail "expected exactly one $key entry in the managed .env file"
  value=$(awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1) }' "$NAS_DATA_ROOT/.env")
  [[ -n "$value" && "$value" != replace-* ]] || fail "$key must be set in the managed .env file"
}

[[ "${DEPLOY_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || fail 'deployment commit must be a full Git SHA'
[[ -d "$NAS_DATA_ROOT" && ! -L "$NAS_DATA_ROOT" ]] || fail 'the dedicated NAS data root must be pre-provisioned as a real directory'
[[ "$(realpath "$NAS_DATA_ROOT")" == "$NAS_DATA_ROOT" ]] || fail 'the dedicated NAS data root resolves through a symlink'
[[ -f "$NAS_DATA_ROOT/.env" && ! -L "$NAS_DATA_ROOT/.env" ]] || fail 'the dedicated .env file is missing or is a symlink'
[[ -d "$NAS_DATA_ROOT/secrets" && ! -L "$NAS_DATA_ROOT/secrets" ]] || fail 'the dedicated secrets directory is missing or is a symlink'

for secret_name in postgres_admin_password app_database_password database_url wechat_app_secret media_url_secret anon_alias_secret; do
  secret_path="$NAS_DATA_ROOT/secrets/$secret_name"
  [[ -f "$secret_path" && ! -L "$secret_path" && -s "$secret_path" ]] || fail "pre-provisioned secret file is missing or invalid: secrets/$secret_name"
done

require_env_value NAS_DATA_ROOT "$NAS_DATA_ROOT"
require_env_value NAS_BACKUP_ROOT "$NAS_BACKUP_ROOT"
require_env_value NAS_COMPOSE_PROJECT_NAME "$NAS_COMPOSE_PROJECT_NAME"
require_env_value NAS_NETWORK_PREFIX "$NAS_NETWORK_PREFIX"
require_env_value NAS_PG_IMAGE "$NAS_PG_IMAGE"
require_env_value NAS_LAN_MODE 1
require_env_value API_BIND_IP "$API_BIND_IP"
require_env_value API_BIND_PORT "$API_BIND_PORT"
require_env_value PUBLIC_API_BASE_URL "$PUBLIC_API_BASE_URL"
require_present_env MINIPROGRAM_APP_ID
require_env_value POSTGRES_DB blacklight
require_env_value POSTGRES_ADMIN_USER blacklight_admin

export NAS_DATA_ROOT NAS_BACKUP_ROOT NAS_COMPOSE_PROJECT_NAME NAS_NETWORK_PREFIX
export NAS_PG_IMAGE API_BIND_IP API_BIND_PORT
export NAS_LAN_MODE=1
export NAS_APP_IMAGE="blacklight-nas-gitea-ci-api:$DEPLOY_COMMIT"

compose() {
  docker compose \
    --project-name "$NAS_COMPOSE_PROJECT_NAME" \
    --project-directory "$REPOSITORY_ROOT" \
    --env-file "$NAS_DATA_ROOT/.env" \
    --file "$COMPOSE_FILE" \
    "$@"
}

[[ -x /usr/bin/flock ]] || fail 'flock is required to serialize deployments'
exec 9>"$NAS_DATA_ROOT/.gitea-deploy.lock"
flock -n 9 || fail 'another deployment is already running'

compose config --quiet || fail 'Compose configuration or a required secret file is invalid'

for container_id in $(docker ps -q --filter "publish=$API_BIND_PORT"); do
  owner_project=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$container_id")
  [[ "$owner_project" == "$NAS_COMPOSE_PROJECT_NAME" ]] || fail "LAN port $API_BIND_PORT is occupied by another container"
done

if [[ -f "$STACK_MARKER" ]]; then
  [[ ! -L "$STACK_MARKER" ]] || fail 'stack marker must not be a symlink'
  marker_value=$(cat "$STACK_MARKER")
  [[ "$marker_value" == "$NAS_COMPOSE_PROJECT_NAME" ]] || fail 'stack marker belongs to another Compose project'
  if [[ -f "$DB_INITIALIZED_MARKER" ]]; then
    [[ ! -L "$DB_INITIALIZED_MARKER" ]] || fail 'database marker must not be a symlink'
    db_marker_value=$(cat "$DB_INITIALIZED_MARKER")
    [[ "$db_marker_value" == "$NAS_COMPOSE_PROJECT_NAME" ]] || fail 'database marker belongs to another Compose project'
    pgdata="$NAS_DATA_ROOT/pgdata"
    [[ -d "$pgdata" && -n "$(find "$pgdata" -mindepth 1 -maxdepth 1 -print -quit)" ]] || fail 'initialized PostgreSQL data is missing; refusing to initialize a new database'
  elif [[ -f "$LAST_GOOD_IMAGE_FILE" ]] || [[ -n "$(compose ps --all --quiet api)" ]]; then
    fail 'database initialization marker is missing from an existing stack'
  fi
else
  [[ ! -e "$LAST_GOOD_IMAGE_FILE" ]] || fail 'last-good image record exists without a stack marker'
  pgdata="$NAS_DATA_ROOT/pgdata"
  if [[ -d "$pgdata" ]] && [[ -n "$(find "$pgdata" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    fail 'unmarked PostgreSQL data already exists; refusing to adopt or replace it'
  fi
  [[ -z "$(compose ps --all --quiet)" ]] || fail 'unmarked Compose containers already exist for this project'
  printf '%s\n' "$NAS_COMPOSE_PROJECT_NAME" > "$STACK_MARKER"
  chmod 0600 "$STACK_MARKER"
fi

db_container=$(compose ps --all --quiet db)
if [[ -z "$db_container" ]]; then
  docker build --tag "$NAS_PG_IMAGE" --file /workspace/deploy/nas/Dockerfile.pg "$REPOSITORY_ROOT"
fi

docker build --tag "$NAS_APP_IMAGE" --file /workspace/deploy/nas/Dockerfile.app "$REPOSITORY_ROOT"
compose up --detach --no-recreate --no-build db || fail 'could not start the managed PostgreSQL container'

wait_for_db() {
  local attempt status id
  for attempt in $(seq 1 60); do
    id=$(compose ps --all --quiet db)
    if [[ -n "$id" ]]; then
      status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$id" 2>/dev/null || true)
      [[ "$status" == healthy ]] && return 0
    fi
    sleep 2
  done
  return 1
}

wait_for_app() {
  local attempt api worker api_health worker_state
  for attempt in $(seq 1 60); do
    api=$(compose ps --all --quiet api)
    worker=$(compose ps --all --quiet worker)
    if [[ -n "$api" && -n "$worker" ]]; then
      api_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$api" 2>/dev/null || true)
      worker_state=$(docker inspect --format '{{.State.Status}}' "$worker" 2>/dev/null || true)
      if [[ "$api_health" == healthy && "$worker_state" == running ]]; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

wait_for_db || fail 'PostgreSQL did not become healthy; database data was preserved'
compose stop api worker
export NAS_WRITES_QUIESCED=1
# This dedicated CI stack contains synthetic fixtures, never a migrated business snapshot.
docker exec "$(compose ps --all --quiet db)" psql -X -v ON_ERROR_STOP=1 -U blacklight_admin -d blacklight -c \
  "INSERT INTO public.hg_users(id,doc) SELECT 'synthetic-ci-backup-fixture', jsonb_build_object('_id','synthetic-ci-backup-fixture','status','active','displayName','Synthetic CI fixture') WHERE NOT EXISTS(SELECT 1 FROM public.hg_users)"
if ! compose --profile maintenance run --rm --no-deps backup; then
  compose start api worker || true
  fail 'pre-migration backup/restore verification failed; existing schema was preserved'
fi
db_container=$(compose ps --all --quiet db)
docker cp "$REPOSITORY_ROOT/cloudbase/migrations/." "$db_container:/opt/blacklight/cloudbase-migrations/"
docker cp "$REPOSITORY_ROOT/scripts/local-apply-migrations.sh" "$db_container:/usr/local/bin/local-apply-migrations"
docker cp "$REPOSITORY_ROOT/deploy/nas/healthcheck-pg.sh" "$db_container:/usr/local/bin/healthcheck-pg"
docker cp "$REPOSITORY_ROOT/scripts/local-backup.sh" "$db_container:/usr/local/bin/local-backup"
docker exec "$db_container" bash /usr/local/bin/local-apply-migrations
wait_for_db || fail 'migrated PostgreSQL did not become healthy; use the pre-migration backup'
docker build --tag "$NAS_PG_IMAGE" --file /workspace/deploy/nas/Dockerfile.pg "$REPOSITORY_ROOT"
if [[ ! -f "$DB_INITIALIZED_MARKER" ]]; then
  printf '%s\n' "$NAS_COMPOSE_PROJECT_NAME" > "$DB_INITIALIZED_MARKER"
  chmod 0600 "$DB_INITIALIZED_MARKER"
fi

previous_image=''
if [[ -f "$LAST_GOOD_IMAGE_FILE" ]]; then
  [[ ! -L "$LAST_GOOD_IMAGE_FILE" ]] || fail 'last-good image record must not be a symlink'
  IFS= read -r previous_image < "$LAST_GOOD_IMAGE_FILE"
  [[ "$previous_image" =~ ^blacklight-nas-gitea-ci-api:[0-9a-f]{40}$ ]] || fail 'last-good image record is invalid'
  docker image inspect "$previous_image" >/dev/null 2>&1 || fail 'recorded rollback image is missing from the NAS Docker engine'
else
  existing_api=$(compose ps --all --quiet api)
  if [[ -n "$existing_api" ]]; then
    previous_image=$(docker inspect --format '{{.Config.Image}}' "$existing_api")
    [[ "$previous_image" =~ ^blacklight-nas-gitea-ci-api:[0-9a-f]{40}$ ]] || fail 'existing API image is outside the managed release format'
    docker image inspect "$previous_image" >/dev/null 2>&1 || fail 'existing API rollback image is missing from the NAS Docker engine'
  fi
fi

if ! compose up --detach --no-deps --no-build api worker; then
  deploy_succeeded=0
elif wait_for_app; then
  deploy_succeeded=1
else
  deploy_succeeded=0
fi

if [[ "$deploy_succeeded" != 1 ]]; then
  if [[ -n "$previous_image" ]]; then
    export NAS_APP_IMAGE="$previous_image"
    if compose up --detach --no-deps --no-build api worker && wait_for_app; then
      printf 'Deployment health check failed; restored previous image %s\n' "${previous_image##*:}" >&2
    else
      printf 'Deployment and automatic rollback failed; the PostgreSQL data volume was left in place.\n' >&2
    fi
  else
    compose stop api worker >/dev/null 2>&1 || true
    printf 'Initial API deployment failed health checks; PostgreSQL data was left in place.\n' >&2
  fi
  exit 1
fi

printf '%s\n' "$NAS_APP_IMAGE" > "$LAST_GOOD_IMAGE_FILE.tmp"
chmod 0600 "$LAST_GOOD_IMAGE_FILE.tmp"
mv "$LAST_GOOD_IMAGE_FILE.tmp" "$LAST_GOOD_IMAGE_FILE"
printf 'NAS isolated stack is healthy at commit %s\n' "$DEPLOY_COMMIT"
