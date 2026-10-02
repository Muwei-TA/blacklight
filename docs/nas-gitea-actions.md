# Gitea Actions and isolated NAS deployment

`.gitea/workflows/backend.yml` runs `check`, `lint`, unit tests, and the existing PostgreSQL integration suites on pull requests to `main`. A successful push to `main` then builds a commit-tagged API/worker image and updates only the `blacklight-nas-gitea-ci` Compose project. It does not run on pull requests.

The deployment uses `/vol1/docker/blacklight-nas-gitea-ci`, `/vol2/backups/blacklight-nas-gitea-ci`, the `blacklight-nas-gitea-ci-*` network and image names, and LAN port `18119`. Port 18119 was confirmed free during the 2026-10-02 NAS audit; the script also refuses to start if another Docker container owns it. Stage uses port 18118 and the existing NAS stack uses port 18088.

## One-time NAS preparation

An administrator must provision the dedicated root before enabling automatic deployment:

1. Create `/vol1/docker/blacklight-nas-gitea-ci` and `/vol2/backups/blacklight-nas-gitea-ci` with restricted directory permissions.
2. Copy `deploy/nas/gitea-ci.env.example` to the dedicated root as `.env`; set `MINIPROGRAM_APP_ID` to the approved app identifier. Keep every listed stack/project/root/port value unchanged.
3. Create these six non-empty files under the dedicated `secrets/` directory: `postgres_admin_password`, `app_database_password`, `database_url`, `wechat_app_secret`, `media_url_secret`, and `anon_alias_secret`. Use dedicated values approved for this stack. Do not point this stack at another data root's secret files. Keep the directory private; use mode `0600` for secrets except `app_database_password`, which must be group-readable by PostgreSQL's container UID 999 as `0640` with group 999.
4. Enable Actions for the private repository. The current NAS runner advertises `ubuntu-latest` and uses the `docker.gitea.com/runner-images:ubuntu-latest` job image. The deploy helper needs Docker CLI, Compose v2, and access to the runner's Docker socket. The workflow checks the CLI and Compose before it proceeds.

The workflow streams the checked-out repository tar into a short-lived helper with `docker cp`; it does not assume the job workspace is a host path. The helper mounts the dedicated data and backup roots at their original absolute paths plus the Docker socket. Compose interpolation is fixed by the deployment script and checked against the NAS `.env`; missing or mismatched settings and missing secrets stop deployment before service containers are changed.

## Protect `main`

Create a Gitea branch protection rule for `main`:

- Require pull requests. Require at least one approval when another reviewer is available.
- Require the status context `Backend CI / checks` (select the context from the Gitea status-check list after the first pull-request run).
- Block force pushes and deletion. Do not grant a direct-push bypass to routine users.
- Keep repository Actions enabled; Gitea may leave Actions disabled on a newly created repository.

The merge to `main` runs the deploy job after all checks pass. Main protection is a repository setting and must be applied in Gitea; committing this workflow does not create that server-side rule.

## Runner trust boundary

The current NAS runner container has the NAS Docker socket. Depending on its `container.docker_host` configuration, job containers may also receive that socket. Any job that can access it can control NAS Docker and inspect runner-container metadata. Treat PR authors and workflow changes as trusted NAS operators, keep the repository private and owner-controlled, and verify the runner socket exposure before accepting outside contributions. This workflow keeps credentials out of Actions secrets and logs; it relies on the pre-provisioned NAS files.

## Deploy and rollback behavior

The deployment script serializes runs with a lock, validates the dedicated root marker and configuration, builds the PostgreSQL image only when the isolated database container does not yet exist, and builds a new API/worker image tagged with the full commit SHA. It never runs `compose down`, removes containers, resets Git state, deletes files, or removes Docker volumes. The PostgreSQL bind-mounted `pgdata` remains attached across updates.

After the database health check, Compose updates only `api` and `worker`. The script waits for API's Compose health check and a running worker process. If the new release fails health checks, it restores the recorded prior image and checks health again. On the initial deployment, it stops only the failed API/worker services and leaves PostgreSQL data in place. No automatic schema migration is performed by this workflow; database schema changes still need the project's reviewed migration procedure before application code depends on them.

The Actions result confirms container health on the NAS runner's Docker engine. It does not verify WeChat login, production traffic, external routing, or user-facing behavior.
