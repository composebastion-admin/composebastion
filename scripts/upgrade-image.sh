#!/bin/sh

set -u
umask 077

DOCKER_BIN="${COMPOSEBASTION_IMAGE_UPGRADE_DOCKER_BIN:-docker}"
VERIFY_ATTEMPTS="${COMPOSEBASTION_IMAGE_UPGRADE_VERIFY_ATTEMPTS:-60}"
VERIFY_INTERVAL_SECONDS="${COMPOSEBASTION_IMAGE_UPGRADE_VERIFY_INTERVAL_SECONDS:-2}"
LEGACY_DATABASE_URL='postgres://composebastion:composebastion@postgres:5432/composebastion'

usage() {
  printf '%s\n' 'Usage: scripts/upgrade-image.sh --version VERSION [--env-file PATH] --compose CURRENT_FILE TARGET_FILE [--compose CURRENT_OVERLAY TARGET_OVERLAY ...]' >&2
  exit 64
}

case "$DOCKER_BIN" in docker|/*) ;; *) printf '%s\n' 'Docker command must be docker or an absolute path.' >&2; exit 64 ;; esac
case "$VERIFY_ATTEMPTS:$VERIFY_INTERVAL_SECONDS" in *[!0-9:]*|:*|*:) printf '%s\n' 'Verification controls must be non-negative integers.' >&2; exit 64 ;; esac
[ "$VERIFY_ATTEMPTS" -ge 1 ] || VERIFY_ATTEMPTS=1

TARGET_VERSION=
ENV_FILE=.env
PAIR_LIST=
PAIR_COUNT=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || usage
      TARGET_VERSION="$2"
      shift 2
      ;;
    --env-file)
      [ "$#" -ge 2 ] || usage
      ENV_FILE="$2"
      shift 2
      ;;
    --compose)
      [ "$#" -ge 3 ] || usage
      case "$2:$3" in *[!A-Za-z0-9_./:-]*|*:*:*) printf '%s\n' 'Compose paths may contain only letters, numbers, dot, slash, underscore, and dash.' >&2; exit 64 ;; esac
      PAIR_COUNT=$((PAIR_COUNT + 1))
      PAIR_LIST="${PAIR_LIST}${PAIR_LIST:+
}$2:$3"
      shift 3
      ;;
    *) usage ;;
  esac
done

if [ -z "$TARGET_VERSION" ] || [ "$PAIR_COUNT" -lt 1 ]; then usage; fi
case "$TARGET_VERSION" in *[!A-Za-z0-9._-]*|'') printf '%s\n' 'Version contains unsupported characters.' >&2; exit 64 ;; esac
WORKING_DIRECTORY="$(pwd -P)" || exit 1
ENV_PARENT="$(cd "$(dirname "$ENV_FILE")" 2>/dev/null && pwd -P)" \
  || { printf 'Environment file parent is unavailable: %s\n' "$ENV_FILE" >&2; exit 64; }
ENV_FILE="$ENV_PARENT/$(basename "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
  printf 'Environment file must be a regular, non-symlink file: %s\n' "$ENV_FILE" >&2
  exit 64
fi

CURRENT_COMPOSE_ARGS=
TARGET_COMPOSE_ARGS=
VALIDATED_PAIR_LIST=
VALIDATED_FILES=
VALIDATED_IDENTITIES=
file_identity() {
  if stat -Lc '%d:%i' -- "$1" 2>/dev/null; then return 0; fi
  stat -f '%d:%i' "$1" 2>/dev/null
}
OLD_IFS=$IFS
IFS='
'
for pair in $PAIR_LIST; do
  current_file=${pair%%:*}
  target_file=${pair#*:}
  current_name=$(basename "$current_file")
  target_name=$(basename "$target_file")
  for candidate_file in "$current_file" "$target_file"; do
    case "$candidate_file" in -*) printf 'Compose file names must not begin with a dash: %s\n' "$candidate_file" >&2; exit 64 ;; esac
    candidate_argument_parent="$(dirname "$candidate_file")"
    case "$candidate_argument_parent" in .|"$WORKING_DIRECTORY") ;; *) printf 'Compose file must be a direct child of the working directory: %s\n' "$candidate_file" >&2; exit 64 ;; esac
    if [ ! -f "$candidate_file" ] || [ -L "$candidate_file" ]; then
      printf 'Compose file must be a regular, non-symlink file: %s\n' "$candidate_file" >&2
      exit 64
    fi
    candidate_parent="$(cd "$(dirname "$candidate_file")" && pwd -P)" || exit 64
    [ "$candidate_parent" = "$WORKING_DIRECTORY" ] || { printf 'Compose file must be a direct child of the working directory: %s\n' "$candidate_file" >&2; exit 64; }
    candidate_name=$(basename "$candidate_file")
    for existing_file in $VALIDATED_FILES; do
      if [ "$candidate_name" = "$existing_file" ]; then
        printf 'Compose files must be unique and must not alias another current or target file: %s\n' "$candidate_file" >&2
        exit 64
      fi
    done
    candidate_identity="$(file_identity "$candidate_file")" || exit 64
    for existing_identity in $VALIDATED_IDENTITIES; do
      if [ "$candidate_identity" = "$existing_identity" ]; then
        printf 'Compose files must be unique and must not alias another current or target file: %s\n' "$candidate_file" >&2
        exit 64
      fi
    done
    VALIDATED_FILES="${VALIDATED_FILES}${VALIDATED_FILES:+
}$candidate_name"
    VALIDATED_IDENTITIES="${VALIDATED_IDENTITIES}${VALIDATED_IDENTITIES:+
}$candidate_identity"
  done
  CURRENT_COMPOSE_ARGS="$CURRENT_COMPOSE_ARGS -f $current_name"
  TARGET_COMPOSE_ARGS="$TARGET_COMPOSE_ARGS -f $target_name"
  VALIDATED_PAIR_LIST="${VALIDATED_PAIR_LIST}${VALIDATED_PAIR_LIST:+
}$current_name:$target_name"
done
IFS=$OLD_IFS
PAIR_LIST=$VALIDATED_PAIR_LIST

compose_current() {
  # Compose paths are character-restricted above, so intentional splitting is safe.
  # shellcheck disable=SC2086
  "$DOCKER_BIN" compose --env-file "$ENV_FILE" $CURRENT_COMPOSE_ARGS "$@"
}

compose_current_overlay() {
  overlay=$1
  shift
  # shellcheck disable=SC2086
  "$DOCKER_BIN" compose --env-file "$ENV_FILE" $CURRENT_COMPOSE_ARGS -f "$overlay" "$@"
}

compose_target() {
  # shellcheck disable=SC2086
  "$DOCKER_BIN" compose --env-file "$ENV_FILE" $TARGET_COMPOSE_ARGS "$@"
}

compose_target_overlay() {
  overlay=$1
  shift
  # shellcheck disable=SC2086
  "$DOCKER_BIN" compose --env-file "$ENV_FILE" $TARGET_COMPOSE_ARGS -f "$overlay" "$@"
}

compose_target_two_overlays() {
  first_overlay=$1
  second_overlay=$2
  shift 2
  # shellcheck disable=SC2086
  "$DOCKER_BIN" compose --env-file "$ENV_FILE" $TARGET_COMPOSE_ARGS -f "$first_overlay" -f "$second_overlay" "$@"
}

JOB_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
STATE_DIRECTORY="$WORKING_DIRECTORY/.composebastion-image-upgrade-$JOB_ID.recovery"
OUTCOME_PATH="$WORKING_DIRECTORY/.composebastion-image-upgrade-$JOB_ID.outcome"
ENV_BACKUP_PATH="$STATE_DIRECTORY/env.backup"
PROBE_TEMPLATE_PATH="$STATE_DIRECTORY/source-env-probe.yml"
PROBE_PATH="$STATE_DIRECTORY/source-env-probe.json"
CONFIG_PATH="$STATE_DIRECTORY/target-compose-config.json"
CURRENT_CONFIG_PATH="$STATE_DIRECTORY/current-compose-config.json"
CONFIG_YAML_PATH="$STATE_DIRECTORY/target-compose-config.yml"
CANDIDATE_PATH="$STATE_DIRECTORY/candidate.yml"
RESTORE_PATH="$STATE_DIRECTORY/restore-legacy.yml"
ROLLBACK_PATH="$STATE_DIRECTORY/rollback.yml"
COMPOSE_BACKUP_DIRECTORY="$STATE_DIRECTORY/compose"
ENV_CHANGED=0
SERVICES_TOUCHED=0
PROMOTION_STARTED=0
ROLLBACK_ACTIVE=0
CREDENTIAL_ROLLBACK_ELIGIBLE=0
DATABASE_PREPARATION_ATTEMPTED=0
PREVIOUS_APP_IMAGE_ID=
PREVIOUS_WORKER_IMAGE_ID=
PREVIOUS_APP_VERSION=
PREVIOUS_WORKER_VERSION=
CANDIDATE_APP_IMAGE_ID=
CANDIDATE_WORKER_IMAGE_ID=

write_outcome() {
  outcome_status=$1
  outcome_stage=$2
  outcome_rollback=$3
  outcome_code=$4
  outcome_tmp="$OUTCOME_PATH.tmp.$$"
  if [ -e "$OUTCOME_PATH" ] || [ -L "$OUTCOME_PATH" ]; then return 1; fi
  if ! {
    printf 'schema=1\n'
    printf 'job_id=%s\n' "$JOB_ID"
    printf 'status=%s\n' "$outcome_status"
    printf 'stage=%s\n' "$outcome_stage"
    printf 'rollback=%s\n' "$outcome_rollback"
    printf 'target_version=%s\n' "$TARGET_VERSION"
    printf 'exit_code=%s\n' "$outcome_code"
  } > "$outcome_tmp" || ! chmod 600 "$outcome_tmp" || ! mv "$outcome_tmp" "$OUTCOME_PATH"; then
    rm -f "$outcome_tmp"
    return 1
  fi
}

container_id() {
  compose_current ps -q "$1" 2>/dev/null | sed -n '1p'
}

inspect_value() {
  "$DOCKER_BIN" inspect --format "$2" "$1" 2>/dev/null || true
}

stack_is_ready() {
  expected_version=$1
  expected_app_image=$2
  expected_worker_image=$3
  app_id="$(container_id app)"
  worker_id="$(container_id worker)"
  [ -n "$app_id" ] && [ -n "$worker_id" ] || return 1
  [ "$(inspect_value "$app_id" '{{.State.Running}}')" = true ] || return 1
  [ "$(inspect_value "$app_id" '{{.State.Health.Status}}')" = healthy ] || return 1
  [ "$(inspect_value "$worker_id" '{{.State.Running}}')" = true ] || return 1
  app_image="$(inspect_value "$app_id" '{{.Image}}')"
  worker_image="$(inspect_value "$worker_id" '{{.Image}}')"
  [ "$app_image" = "$expected_app_image" ] && [ "$worker_image" = "$expected_worker_image" ] || return 1
  app_version="$(inspect_value "$app_id" '{{ index .Config.Labels "org.opencontainers.image.version" }}')"
  worker_version="$(inspect_value "$worker_id" '{{ index .Config.Labels "org.opencontainers.image.version" }}')"
  app_title="$(inspect_value "$app_id" '{{ index .Config.Labels "org.opencontainers.image.title" }}')"
  worker_title="$(inspect_value "$worker_id" '{{ index .Config.Labels "org.opencontainers.image.title" }}')"
  app_source="$(inspect_value "$app_id" '{{ index .Config.Labels "org.opencontainers.image.source" }}')"
  worker_source="$(inspect_value "$worker_id" '{{ index .Config.Labels "org.opencontainers.image.source" }}')"
  [ "$app_title" = ComposeBastion ] && [ "$worker_title" = ComposeBastion ] || return 1
  [ "$app_source" = 'https://github.com/composebastion-admin/composebastion' ] && [ "$worker_source" = "$app_source" ] || return 1
  [ "${app_version#v}" = "${expected_version#v}" ] && [ "$worker_version" = "$app_version" ] || return 1
  compose_current exec -T app node -e 'const expected=process.argv[1].replace(/^v/, "");Promise.all([fetch("http://127.0.0.1:8080/api/health").then(r=>r.ok?r.json():Promise.reject()),fetch("http://127.0.0.1:8080/api/health/ready").then(r=>r.ok?r.json():Promise.reject())]).then(([health,ready])=>{if(!health.ok||!ready.ok||!ready.checks?.worker?.ok||String(health.version||"").replace(/^v/, "")!==expected)process.exit(1)}).catch(()=>process.exit(1))' "$expected_version" >/dev/null 2>&1
}

wait_for_stack() {
  wait_index=0
  while [ "$wait_index" -lt "$VERIFY_ATTEMPTS" ]; do
    if stack_is_ready "$1" "$2" "$3"; then return 0; fi
    wait_index=$((wait_index + 1))
    [ "$wait_index" -ge "$VERIFY_ATTEMPTS" ] || sleep "$VERIFY_INTERVAL_SECONDS"
  done
  return 1
}

restore_compose_files() {
  restore_index=0
  OLD_IFS=$IFS
  IFS='
'
  for pair in $PAIR_LIST; do
    restore_index=$((restore_index + 1))
    current_file=${pair%%:*}
    cp -p "$COMPOSE_BACKUP_DIRECTORY/$restore_index.yml" "$current_file" || { IFS=$OLD_IFS; return 1; }
  done
  IFS=$OLD_IFS
}

rollback_update() {
  failed_stage=$1
  failed_code=$2
  [ "$ROLLBACK_ACTIVE" -eq 0 ] || exit "$failed_code"
  ROLLBACK_ACTIVE=1
  trap - HUP INT TERM
  rollback_status=failed
  credential_restored=1
  environment_restored=1
  compose_restored=1
  images_restored=1
  if [ "$SERVICES_TOUCHED" -eq 1 ]; then
    compose_target_overlay "$CANDIDATE_PATH" stop app worker >/dev/null 2>&1 || true
    if [ "$DATABASE_PREPARATION_ATTEMPTED" -eq 1 ] && [ "$CREDENTIAL_ROLLBACK_ELIGIBLE" -eq 1 ] \
      && ! compose_target_two_overlays "$CANDIDATE_PATH" "$RESTORE_PATH" run --rm --no-deps --user 0:0 database-init \
      node /app/scripts/prepare-database-upgrade.mjs restore-legacy \
      --state-file /var/lib/composebastion/upgrade-state/database-transition.json >/dev/null 2>&1; then
      credential_restored=0
    fi
  fi
  if [ "$ENV_CHANGED" -eq 1 ]; then
    cp -p "$ENV_BACKUP_PATH" "$ENV_FILE" 2>/dev/null || environment_restored=0
  fi
  if [ "$PROMOTION_STARTED" -eq 1 ]; then
    restore_compose_files || compose_restored=0
  fi
  if [ "$SERVICES_TOUCHED" -eq 1 ]; then
    if ! compose_current_overlay "$ROLLBACK_PATH" up -d --pull never --no-deps --force-recreate app worker >/dev/null 2>&1 \
      || ! wait_for_stack "$PREVIOUS_APP_VERSION" "$PREVIOUS_APP_IMAGE_ID" "$PREVIOUS_WORKER_IMAGE_ID"; then
      images_restored=0
    fi
  fi
  if [ "$credential_restored" -eq 1 ] && [ "$environment_restored" -eq 1 ] \
    && [ "$compose_restored" -eq 1 ] && [ "$images_restored" -eq 1 ]; then
    rollback_status=succeeded
  fi
  outcome_published=0
  if write_outcome failed "$failed_stage" "$rollback_status" "$failed_code"; then outcome_published=1; fi
  if [ "$rollback_status" = succeeded ] && [ "$outcome_published" -eq 1 ]; then
    rm -rf -- "$STATE_DIRECTORY"
    printf 'Image upgrade failed at %s; automatic rollback succeeded. Outcome: %s\n' "$failed_stage" "$OUTCOME_PATH" >&2
  elif [ "$outcome_published" -eq 0 ]; then
    printf 'Image upgrade failed at %s and its authoritative outcome could not be published. Keep recovery state: %s\n' "$failed_stage" "$STATE_DIRECTORY" >&2
  else
    printf 'Image upgrade failed at %s and rollback is incomplete. Keep recovery state: %s\n' "$failed_stage" "$STATE_DIRECTORY" >&2
  fi
  exit "$failed_code"
}

fail_update() {
  rollback_update "$1" "$2"
}

trap 'rollback_update interrupted 130' HUP INT TERM

mkdir -m 700 "$STATE_DIRECTORY" "$COMPOSE_BACKUP_DIRECTORY" || { printf '%s\n' 'Could not create protected recovery state.' >&2; exit 1; }
if ! cp -p "$ENV_FILE" "$ENV_BACKUP_PATH" || ! chmod 600 "$ENV_BACKUP_PATH"; then
  fail_update environment_backup 1
fi
if ! compose_current config --format json > "$CURRENT_CONFIG_PATH" || ! chmod 600 "$CURRENT_CONFIG_PATH"; then fail_update current_config 1; fi
if node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.exit(c?.services?.app?.environment?.DATABASE_URL===process.argv[2]?0:1)' "$CURRENT_CONFIG_PATH" "$LEGACY_DATABASE_URL" \
  || awk -F= -v legacy="$LEGACY_DATABASE_URL" '$1=="DATABASE_URL" { value=substr($0,index($0,"=")+1) } END { exit value==legacy?0:1 }' "$ENV_FILE"; then
  CREDENTIAL_ROLLBACK_ELIGIBLE=1
fi

backup_index=0
OLD_IFS=$IFS
IFS='
'
for pair in $PAIR_LIST; do
  backup_index=$((backup_index + 1))
  current_file=${pair%%:*}
  cp -p "$current_file" "$COMPOSE_BACKUP_DIRECTORY/$backup_index.yml" || { IFS=$OLD_IFS; fail_update compose_backup 1; }
  chmod 600 "$COMPOSE_BACKUP_DIRECTORY/$backup_index.yml" || { IFS=$OLD_IFS; fail_update compose_backup 1; }
done
IFS=$OLD_IFS

current_app_id="$(container_id app)"
current_worker_id="$(container_id worker)"
if [ -z "$current_app_id" ] || [ -z "$current_worker_id" ]; then fail_update prior_image_identity 1; fi
PREVIOUS_APP_IMAGE_ID="$(inspect_value "$current_app_id" '{{.Image}}')"
PREVIOUS_WORKER_IMAGE_ID="$(inspect_value "$current_worker_id" '{{.Image}}')"
PREVIOUS_APP_VERSION="$(inspect_value "$current_app_id" '{{ index .Config.Labels "org.opencontainers.image.version" }}')"
PREVIOUS_WORKER_VERSION="$(inspect_value "$current_worker_id" '{{ index .Config.Labels "org.opencontainers.image.version" }}')"
case "$PREVIOUS_APP_IMAGE_ID:$PREVIOUS_WORKER_IMAGE_ID" in sha256:*:sha256:*) ;; *) fail_update prior_image_identity 1 ;; esac
if [ -z "$PREVIOUS_APP_VERSION" ] || [ "$PREVIOUS_APP_VERSION" != "$PREVIOUS_WORKER_VERSION" ]; then fail_update prior_image_identity 1; fi

{
  printf 'services:\n'
  printf '  app:\n    image: %s\n    pull_policy: never\n' "$PREVIOUS_APP_IMAGE_ID"
  printf '  worker:\n    image: %s\n    pull_policy: never\n' "$PREVIOUS_WORKER_IMAGE_ID"
} > "$ROLLBACK_PATH" || fail_update rollback_state 1

env_tmp="$(mktemp "$ENV_FILE.composebastion-image-upgrade.XXXXXX")" || fail_update environment_update 1
if ! awk -v replacement="COMPOSEBASTION_VERSION=$TARGET_VERSION" 'BEGIN { done=0 } /^COMPOSEBASTION_VERSION=/ { print replacement; done=1; next } { print } END { if (!done) print replacement }' "$ENV_FILE" > "$env_tmp" \
  || ! chmod 600 "$env_tmp" || ! mv "$env_tmp" "$ENV_FILE"; then
  rm -f "$env_tmp"
  fail_update environment_update 1
fi
ENV_CHANGED=1

{
  printf 'services:\n'
  printf "  composebastion-upgrade-probe:\n    image: scratch\n    environment:\n      COMPOSEBASTION_UPGRADE_SOURCE_DATABASE_URL: \${DATABASE_URL-}\n"
} > "$PROBE_TEMPLATE_PATH" || fail_update target_config 1
chmod 600 "$PROBE_TEMPLATE_PATH" || fail_update target_config 1
if ! env -u DATABASE_URL "$DOCKER_BIN" compose --env-file "$ENV_FILE" -f "$PROBE_TEMPLATE_PATH" config --format json > "$PROBE_PATH" \
  || ! chmod 600 "$PROBE_PATH"; then fail_update target_config 1; fi

if ! compose_target config --format json > "$CONFIG_PATH" || ! chmod 600 "$CONFIG_PATH"; then fail_update target_config 1; fi
compose_target pull app worker storage-init database-init || fail_update pull 1
if ! compose_target config > "$CONFIG_YAML_PATH" || ! chmod 600 "$CONFIG_YAML_PATH"; then fail_update target_config 1; fi

service_image_from_config() {
  awk -v service="$1" '$0 == "  " service ":" { active=1; next } active && /^  [^ ]/ { exit } active && /^    image: / { sub(/^    image: /, ""); print; exit }' "$CONFIG_YAML_PATH"
}
candidate_app_ref="$(service_image_from_config app)"
candidate_worker_ref="$(service_image_from_config worker)"
if [ -z "$candidate_app_ref" ] || [ -z "$candidate_worker_ref" ]; then fail_update candidate_image_identity 1; fi
CANDIDATE_APP_IMAGE_ID="$("$DOCKER_BIN" image inspect --format '{{.Id}}' "$candidate_app_ref" 2>/dev/null || true)"
CANDIDATE_WORKER_IMAGE_ID="$("$DOCKER_BIN" image inspect --format '{{.Id}}' "$candidate_worker_ref" 2>/dev/null || true)"
case "$CANDIDATE_APP_IMAGE_ID:$CANDIDATE_WORKER_IMAGE_ID" in sha256:*:sha256:*) ;; *) fail_update candidate_image_identity 1 ;; esac
[ "$CANDIDATE_APP_IMAGE_ID" = "$CANDIDATE_WORKER_IMAGE_ID" ] || fail_update candidate_image_identity 1

{
  printf 'services:\n'
  for service in app worker storage-init database-init; do
    printf '  %s:\n    image: %s\n    pull_policy: never\n' "$service" "$CANDIDATE_APP_IMAGE_ID"
  done
} > "$CANDIDATE_PATH" || fail_update candidate_image_identity 1
{
  printf 'services:\n'
  printf '  database-init:\n    environment:\n      DATABASE_URL: %s\n' "$LEGACY_DATABASE_URL"
} > "$RESTORE_PATH" || fail_update rollback_state 1

SERVICES_TOUCHED=1
compose_current stop app worker || fail_update stop 1
compose_target_overlay "$CANDIDATE_PATH" run --rm --no-deps storage-init || fail_update storage_preparation 1
DATABASE_PREPARATION_ATTEMPTED=1
preparation_output="$(compose_target_overlay "$CANDIDATE_PATH" run --rm --no-deps \
  --user 0:0 \
  --volume "$STATE_DIRECTORY:/run/composebastion-upgrade" \
  database-init node /app/scripts/prepare-database-upgrade.mjs reconcile \
  --state-file /var/lib/composebastion/upgrade-state/database-transition.json \
  --environment-probe /run/composebastion-upgrade/source-env-probe.json)" || fail_update database_preparation 1
printf '%s\n' "$preparation_output"
credential_transition="$(printf '%s\n' "$preparation_output" | sed -n 's/^COMPOSEBASTION_DATABASE_CREDENTIAL_TRANSITION=//p')"
environment_action="$(printf '%s\n' "$preparation_output" | sed -n 's/^COMPOSEBASTION_DATABASE_ENVIRONMENT_ACTION=//p')"
case "$credential_transition" in changed|unchanged) ;; *) fail_update preparation_result 1 ;; esac
case "$environment_action" in
  canonicalize)
    database_env_tmp="$(mktemp "$ENV_FILE.composebastion-database.XXXXXX")" || fail_update environment_canonicalization 1
    if ! { cat "$ENV_FILE"; printf '\n# ComposeBastion managed legacy database transition\nDATABASE_URL=\n'; } > "$database_env_tmp" \
      || ! chmod 600 "$database_env_tmp" || ! mv "$database_env_tmp" "$ENV_FILE"; then
      rm -f "$database_env_tmp"
      fail_update environment_canonicalization 1
    fi
    ;;
  preserve) ;;
  *) fail_update preparation_result 1 ;;
esac

compose_target_overlay "$CANDIDATE_PATH" up -d --pull never --no-deps --force-recreate app worker || fail_update startup 1
wait_for_stack "$TARGET_VERSION" "$CANDIDATE_APP_IMAGE_ID" "$CANDIDATE_WORKER_IMAGE_ID" || fail_update verification 1

PROMOTION_STARTED=1
promotion_index=0
OLD_IFS=$IFS
IFS='
'
for pair in $PAIR_LIST; do
  promotion_index=$((promotion_index + 1))
  current_file=${pair%%:*}
  target_file=${pair#*:}
  promotion_tmp="$current_file.composebastion-promote.$$"
  if ! cp -p "$target_file" "$promotion_tmp" || ! mv "$promotion_tmp" "$current_file"; then
    rm -f "$promotion_tmp"
    IFS=$OLD_IFS
    fail_update compose_promotion 1
  fi
done
IFS=$OLD_IFS

write_outcome passed complete not_required 0 || fail_update outcome_publication 1
trap - HUP INT TERM
if ! rm -rf -- "$STATE_DIRECTORY"; then
  printf 'Image upgrade succeeded, but protected recovery cleanup was incomplete: %s\n' "$STATE_DIRECTORY" >&2
fi
printf 'Image upgrade to %s completed. Job %s; outcome: %s\n' "$TARGET_VERSION" "$JOB_ID" "$OUTCOME_PATH"
