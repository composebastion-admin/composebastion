# shellcheck shell=sh
set -u
umask 077
export PATH="${COMPOSEBASTION_DOCKER_PATH}:$PATH"
export DOCKER_HOST="unix://${COMPOSEBASTION_DOCKER_SOCKET}"
DOCKER_BIN="${COMPOSEBASTION_SELF_UPDATE_DOCKER_BIN:-docker}"
ENV_EXISTED=0
ENV_CHANGED=0
SERVICES_TOUCHED=0
PREVIOUS_APP_VERSION=
PREVIOUS_WORKER_VERSION=
PREVIOUS_APP_IMAGE_ID=
PREVIOUS_WORKER_IMAGE_ID=
PREVIOUS_APP_IMAGE_REF=
PREVIOUS_WORKER_IMAGE_REF=
CANDIDATE_APP_IMAGE_ID=
CANDIDATE_WORKER_IMAGE_ID=
UPGRADE_STATE_DIR="${WORKING_DIR}/.composebastion-self-update-${JOB_ID}.upgrade"
COMPOSE_CONFIG_PATH="${UPGRADE_STATE_DIR}/compose-config.json"
CANDIDATE_COMPOSE_PATH="${UPGRADE_STATE_DIR}/candidate.yml"
SOURCE_ENV_PROBE_TEMPLATE_PATH="${UPGRADE_STATE_DIR}/source-env-probe.yml"
SOURCE_ENV_PROBE_PATH="${UPGRADE_STATE_DIR}/source-env-probe.json"
DATABASE_STATE_PATH="${UPGRADE_STATE_DIR}/database-transition.json"

write_outcome() {
  outcome_tmp="${OUTCOME_PATH}.tmp.$$"
  if [ -e "$OUTCOME_PATH" ] || [ -L "$OUTCOME_PATH" ]; then return 1; fi
  if ! {
    printf 'schema=1\n'
    printf 'job_id=%s\n' "$JOB_ID"
    printf 'status=%s\n' "$1"
    printf 'stage=%s\n' "$2"
    printf 'rollback=%s\n' "$3"
    printf 'target_version=%s\n' "$TARGET_VERSION"
    printf 'exit_code=%s\n' "$4"
  } > "$outcome_tmp" || ! chmod 600 "$outcome_tmp" || ! mv -- "$outcome_tmp" "$OUTCOME_PATH"; then
    rm -f -- "$outcome_tmp"
    return 1
  fi
}

release_lock() {
  owner="$(sed -n '1p' "$LOCK_PATH/owner" 2>/dev/null || true)"
  if [ "$owner" = "$$" ]; then
    rm -f -- "$LOCK_PATH/owner" "$LOCK_PATH/job" "$LOCK_PATH/script"
    rmdir -- "$LOCK_PATH" 2>/dev/null || true
  fi
}

cleanup_upgrade_state() {
  cleanup_status=0
  rm -f -- "$COMPOSE_CONFIG_PATH" "$CANDIDATE_COMPOSE_PATH" "$SOURCE_ENV_PROBE_TEMPLATE_PATH" "$SOURCE_ENV_PROBE_PATH" "$DATABASE_STATE_PATH" || cleanup_status=1
  rmdir -- "$UPGRADE_STATE_DIR" 2>/dev/null || cleanup_status=1
  return "$cleanup_status"
}

container_id() {
  "$DOCKER_BIN" compose -f "$COMPOSE_FILE" ps -q "$1" 2>/dev/null | sed -n '1p'
}

container_is_composebastion() {
  identity_id="$1"
  identity_title="$("$DOCKER_BIN" inspect --format '{{ index .Config.Labels "org.opencontainers.image.title" }}' "$identity_id" 2>/dev/null || true)"
  identity_source="$("$DOCKER_BIN" inspect --format '{{ index .Config.Labels "org.opencontainers.image.source" }}' "$identity_id" 2>/dev/null || true)"
  [ "$identity_title" = ComposeBastion ] \
    && [ "$identity_source" = https://github.com/composebastion-admin/composebastion ]
}

stack_is_ready() {
  expected_app_version="$1"
  expected_worker_version="$2"
  expected_app_image="$3"
  expected_worker_image="$4"
  app_id="$(container_id app)"
  worker_id="$(container_id worker)"
  [ -n "$app_id" ] && [ -n "$worker_id" ] || return 1
  [ "$("$DOCKER_BIN" inspect --format '{{.State.Running}}' "$app_id" 2>/dev/null || true)" = true ] || return 1
  [ "$("$DOCKER_BIN" inspect --format '{{.State.Health.Status}}' "$app_id" 2>/dev/null || true)" = healthy ] || return 1
  [ "$("$DOCKER_BIN" inspect --format '{{.State.Running}}' "$worker_id" 2>/dev/null || true)" = true ] || return 1
  container_is_composebastion "$app_id" || return 1
  container_is_composebastion "$worker_id" || return 1
  actual_app_version="$("$DOCKER_BIN" inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$app_id" 2>/dev/null || true)"
  actual_worker_version="$("$DOCKER_BIN" inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$worker_id" 2>/dev/null || true)"
  [ -n "$actual_app_version" ] && [ -n "$actual_worker_version" ] || return 1
  [ "$actual_app_version" = "$actual_worker_version" ] || return 1
  if [ "$expected_app_version" != latest ]; then
    [ "${actual_app_version#v}" = "${expected_app_version#v}" ] || return 1
  fi
  if [ "$expected_worker_version" != latest ]; then
    [ "${actual_worker_version#v}" = "${expected_worker_version#v}" ] || return 1
  fi
  [ "$("$DOCKER_BIN" inspect --format '{{.Image}}' "$app_id" 2>/dev/null || true)" = "$expected_app_image" ] || return 1
  [ "$("$DOCKER_BIN" inspect --format '{{.Image}}' "$worker_id" 2>/dev/null || true)" = "$expected_worker_image" ] || return 1
  "$DOCKER_BIN" compose -f "$COMPOSE_FILE" exec -T app node -e \
    'Promise.all([fetch("http://127.0.0.1:8080/api/health").then(r=>r.ok?r.json():Promise.reject()),fetch("http://127.0.0.1:8080/api/health/ready").then(r=>r.ok?r.json():Promise.reject())]).then(([h,r])=>{if(!h.ok||!r.ok||!r.checks?.worker?.ok)process.exit(1)}).catch(()=>process.exit(1))' \
    >/dev/null 2>&1
}

wait_for_stack() {
  attempts="${COMPOSEBASTION_SELF_UPDATE_VERIFY_ATTEMPTS:-60}"
  case "$attempts" in ''|*[!0-9]*) attempts=60 ;; esac
  index=0
  while [ "$index" -lt "$attempts" ]; do
    if stack_is_ready "$1" "$2" "$3" "$4"; then return 0; fi
    index=$((index + 1))
    [ "$index" -ge "$attempts" ] || sleep "${COMPOSEBASTION_SELF_UPDATE_VERIFY_INTERVAL_SECONDS:-2}"
  done
  return 1
}

run_upgrade_preparation() {
  "$DOCKER_BIN" compose -f "$COMPOSE_FILE" -f "$CANDIDATE_COMPOSE_PATH" run --rm --no-deps --user 0:0 \
    --volume "$UPGRADE_STATE_DIR:/run/composebastion-upgrade" \
    app node /app/scripts/prepare-compose-upgrade.mjs "$1" \
    --compose-config /run/composebastion-upgrade/compose-config.json \
    --environment-probe /run/composebastion-upgrade/source-env-probe.json \
    --state-file /run/composebastion-upgrade/database-transition.json
}

update_environment() {
  replacement="COMPOSEBASTION_VERSION=${TARGET_VERSION}"
  temporary="$(mktemp .env.composebastion.XXXXXX)" || return 1
  if [ -f .env ]; then
    awk -v replacement="$replacement" 'BEGIN { done = 0 } /^COMPOSEBASTION_VERSION=/ { print replacement; done = 1; next } { print } END { if (!done) print replacement }' .env > "$temporary" || return 1
  else
    printf '%s\n' "$replacement" > "$temporary" || return 1
  fi
  chmod 600 "$temporary" && mv -- "$temporary" .env
}

canonicalize_managed_database_environment() {
  [ -f .env ] || return 1
  temporary="$(mktemp .env.composebastion-database.XXXXXX)" || return 1
  {
    cat .env
    printf '\n# ComposeBastion managed legacy database transition\n'
    printf 'DATABASE_URL=\n'
  } > "$temporary" || { rm -f -- "$temporary"; return 1; }
  chmod 600 "$temporary" && mv -- "$temporary" .env
}

fail_update() {
  failed_stage="$1"
  failed_code="$2"
  trap - HUP INT TERM
  rollback_status=failed
  credential_restored=1
  if [ "$SERVICES_TOUCHED" -eq 1 ]; then
    "$DOCKER_BIN" compose -f "$COMPOSE_FILE" stop app worker >/dev/null 2>&1 || true
  fi
  if [ -f "$DATABASE_STATE_PATH" ]; then
    if ! run_upgrade_preparation restore-legacy >/dev/null 2>&1; then credential_restored=0; fi
  fi
  environment_restored=1
  if [ "$ENV_CHANGED" -eq 1 ]; then
    if [ "$ENV_EXISTED" -eq 1 ]; then
      cp -p -- "$ENV_BACKUP_PATH" .env 2>/dev/null || environment_restored=0
    else
      rm -f -- .env || environment_restored=0
    fi
  fi
  rollback_ready=0
  case "$PREVIOUS_APP_IMAGE_ID:$PREVIOUS_WORKER_IMAGE_ID" in sha256:*:sha256:*) rollback_ready=1 ;; esac
  if [ "$rollback_ready" -eq 1 ]; then
    case "$PREVIOUS_APP_IMAGE_REF" in sha256:*|*@sha256:*) ;; *) "$DOCKER_BIN" image tag "$PREVIOUS_APP_IMAGE_ID" "$PREVIOUS_APP_IMAGE_REF" >/dev/null 2>&1 || true ;; esac
    case "$PREVIOUS_WORKER_IMAGE_REF" in sha256:*|*@sha256:*) ;; *) "$DOCKER_BIN" image tag "$PREVIOUS_WORKER_IMAGE_ID" "$PREVIOUS_WORKER_IMAGE_REF" >/dev/null 2>&1 || true ;; esac
  fi
  if [ "$SERVICES_TOUCHED" -eq 0 ] && [ "$environment_restored" -eq 1 ] && [ "$credential_restored" -eq 1 ]; then
    rollback_status=succeeded
  elif [ "$rollback_ready" -eq 1 ] \
      && "$DOCKER_BIN" compose -f "$COMPOSE_FILE" -f "$ROLLBACK_COMPOSE_PATH" up -d --pull never --no-deps --force-recreate app worker >/dev/null 2>&1 \
      && wait_for_stack "$PREVIOUS_APP_VERSION" "$PREVIOUS_WORKER_VERSION" "$PREVIOUS_APP_IMAGE_ID" "$PREVIOUS_WORKER_IMAGE_ID" \
      && [ "$environment_restored" -eq 1 ] && [ "$credential_restored" -eq 1 ]; then
    rollback_status=succeeded
  fi
  rm -f -- "$GATE_PATH"
  outcome_published=0
  if write_outcome failed "$failed_stage" "$rollback_status" "$failed_code"; then outcome_published=1; fi
  if [ "$rollback_status" = succeeded ] && [ "$outcome_published" -eq 1 ]; then
    rm -f -- "$ENV_BACKUP_PATH" "$ROLLBACK_COMPOSE_PATH" || true
    cleanup_upgrade_state || true
  elif [ "$outcome_published" -eq 0 ]; then
    printf '%s\n' "Self-update could not publish its authoritative failure outcome; protected recovery state was retained at $UPGRADE_STATE_DIR." >&2
  fi
  release_lock
  exit "$failed_code"
}

trap 'fail_update interrupted 130' HUP INT TERM
case "$DOCKER_BIN" in docker|/*) ;; *) if ! write_outcome failed docker_binary not_required 64; then printf '%s\n' 'Self-update could not publish the docker_binary outcome.' >&2; fi; release_lock; exit 64 ;; esac
cd "$WORKING_DIR" || { if ! write_outcome failed working_directory not_required 1; then printf '%s\n' 'Self-update could not publish the working_directory outcome.' >&2; fi; release_lock; exit 1; }

gate_wait=0
while [ ! -f "$GATE_PATH" ] && [ "$gate_wait" -lt "${COMPOSEBASTION_SELF_UPDATE_GATE_ATTEMPTS:-60}" ]; do
  gate_wait=$((gate_wait + 1))
  sleep 1
done
if [ ! -f "$GATE_PATH" ]; then
  if ! write_outcome failed handoff_confirmation not_required 75; then printf '%s\n' 'Self-update could not publish the handoff_confirmation outcome.' >&2; fi
  release_lock
  exit 75
fi
rm -f -- "$GATE_PATH"

current_app_id="$(container_id app)"
current_worker_id="$(container_id worker)"
PREVIOUS_APP_VERSION="$("$DOCKER_BIN" inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$current_app_id" 2>/dev/null || true)"
PREVIOUS_WORKER_VERSION="$("$DOCKER_BIN" inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$current_worker_id" 2>/dev/null || true)"
PREVIOUS_APP_IMAGE_ID="$("$DOCKER_BIN" inspect --format '{{.Image}}' "$current_app_id" 2>/dev/null || true)"
PREVIOUS_WORKER_IMAGE_ID="$("$DOCKER_BIN" inspect --format '{{.Image}}' "$current_worker_id" 2>/dev/null || true)"
PREVIOUS_APP_IMAGE_REF="$("$DOCKER_BIN" inspect --format '{{.Config.Image}}' "$current_app_id" 2>/dev/null || true)"
PREVIOUS_WORKER_IMAGE_REF="$("$DOCKER_BIN" inspect --format '{{.Config.Image}}' "$current_worker_id" 2>/dev/null || true)"
case "$PREVIOUS_APP_IMAGE_ID:$PREVIOUS_WORKER_IMAGE_ID" in sha256:*:sha256:*) ;; *) fail_update prior_image_identity 1 ;; esac
[ -n "$PREVIOUS_APP_VERSION" ] && [ -n "$PREVIOUS_WORKER_VERSION" ] || fail_update prior_image_identity 1

{
  printf 'services:\n'
  printf '  app:\n    image: %s\n    pull_policy: never\n' "$PREVIOUS_APP_IMAGE_ID"
  printf '  worker:\n    image: %s\n    pull_policy: never\n' "$PREVIOUS_WORKER_IMAGE_ID"
} > "$ROLLBACK_COMPOSE_PATH" || fail_update rollback_state 1

if [ -f .env ]; then
  if ! cp -p -- .env "$ENV_BACKUP_PATH" || ! chmod 600 "$ENV_BACKUP_PATH"; then
    fail_update env_backup 1
  fi
  ENV_EXISTED=1
else
  : > "$ENV_BACKUP_PATH"
fi
ENV_CHANGED=1
update_environment || fail_update env_update 1
"$DOCKER_BIN" compose -f "$COMPOSE_FILE" pull app worker || fail_update pull 1
mkdir -m 700 -- "$UPGRADE_STATE_DIR" || fail_update upgrade_state 1
{
  printf 'services:\n'
  printf "  composebastion-upgrade-probe:\n    image: scratch\n    environment:\n      COMPOSEBASTION_UPGRADE_SOURCE_DATABASE_URL: \${DATABASE_URL-}\n"
} > "$SOURCE_ENV_PROBE_TEMPLATE_PATH" || fail_update compose_config 1
chmod 600 "$SOURCE_ENV_PROBE_TEMPLATE_PATH" || fail_update compose_config 1
env -u DATABASE_URL "$DOCKER_BIN" compose --env-file .env -f "$SOURCE_ENV_PROBE_TEMPLATE_PATH" config --format json > "$SOURCE_ENV_PROBE_PATH" || fail_update compose_config 1
chmod 600 "$SOURCE_ENV_PROBE_PATH" || fail_update compose_config 1
"$DOCKER_BIN" compose -f "$COMPOSE_FILE" config --format json > "$COMPOSE_CONFIG_PATH" || fail_update compose_config 1
chmod 600 "$COMPOSE_CONFIG_PATH" || fail_update compose_config 1
config_yaml="${UPGRADE_STATE_DIR}/compose-config.yml"
"$DOCKER_BIN" compose -f "$COMPOSE_FILE" config > "$config_yaml" || fail_update compose_config 1
candidate_app_ref="$(awk '$0 == "  app:" { active=1; next } active && /^  [^ ]/ { exit } active && /^    image: / { sub(/^    image: /, ""); print; exit }' "$config_yaml")"
candidate_worker_ref="$(awk '$0 == "  worker:" { active=1; next } active && /^  [^ ]/ { exit } active && /^    image: / { sub(/^    image: /, ""); print; exit }' "$config_yaml")"
rm -f -- "$config_yaml"
[ -n "$candidate_app_ref" ] && [ -n "$candidate_worker_ref" ] || fail_update candidate_image_identity 1
CANDIDATE_APP_IMAGE_ID="$("$DOCKER_BIN" image inspect --format '{{.Id}}' "$candidate_app_ref" 2>/dev/null || true)"
CANDIDATE_WORKER_IMAGE_ID="$("$DOCKER_BIN" image inspect --format '{{.Id}}' "$candidate_worker_ref" 2>/dev/null || true)"
case "$CANDIDATE_APP_IMAGE_ID:$CANDIDATE_WORKER_IMAGE_ID" in sha256:*:sha256:*) ;; *) fail_update candidate_image_identity 1 ;; esac
{
  printf 'services:\n'
  printf "  app:\n    image: %s\n    pull_policy: never\n    environment:\n      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}\n" "$CANDIDATE_APP_IMAGE_ID"
  printf "  worker:\n    image: %s\n    pull_policy: never\n    environment:\n      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}\n" "$CANDIDATE_WORKER_IMAGE_ID"
} > "$CANDIDATE_COMPOSE_PATH" || fail_update candidate_image_identity 1

SERVICES_TOUCHED=1
"$DOCKER_BIN" compose -f "$COMPOSE_FILE" stop app worker || fail_update stop 1
preparation_output="$(run_upgrade_preparation reconcile)" || fail_update prepare 1
printf '%s\n' "$preparation_output"
credential_transition="$(printf '%s\n' "$preparation_output" | sed -n 's/^COMPOSEBASTION_DATABASE_CREDENTIAL_TRANSITION=//p')"
environment_action="$(printf '%s\n' "$preparation_output" | sed -n 's/^COMPOSEBASTION_DATABASE_ENVIRONMENT_ACTION=//p')"
case "$credential_transition" in changed|unchanged) ;; *) fail_update prepare_result 1 ;; esac
case "$environment_action" in
  canonicalize) canonicalize_managed_database_environment || fail_update env_canonicalization 1 ;;
  preserve) ;;
  *) fail_update prepare_result 1 ;;
esac
"$DOCKER_BIN" compose -f "$COMPOSE_FILE" -f "$CANDIDATE_COMPOSE_PATH" up -d --pull never --no-deps --force-recreate app worker || fail_update up 1
wait_for_stack "$TARGET_VERSION" "$TARGET_VERSION" "$CANDIDATE_APP_IMAGE_ID" "$CANDIDATE_WORKER_IMAGE_ID" || fail_update verification 1

write_outcome passed complete not_required 0 || fail_update outcome_publication 1
trap - HUP INT TERM
success_cleanup_failed=0
rm -f -- "$ENV_BACKUP_PATH" "$ROLLBACK_COMPOSE_PATH" || success_cleanup_failed=1
cleanup_upgrade_state || success_cleanup_failed=1
if [ "$success_cleanup_failed" -eq 1 ]; then
  printf '%s\n' "Self-update succeeded, but protected recovery cleanup was incomplete at $UPGRADE_STATE_DIR." >&2
fi
release_lock
exit 0
