#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repository_root}"

gitleaks_image="ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
gitleaks_config="${repository_root}/.github/gitleaks.toml"
expected_config_sha256="3970cce55841814bcad57f166c4cb69f23722d46d76b8dd3a3a8c8763ee41ffb"
report_directory="${repository_root}/test-results/gitleaks"
report_path="${report_directory}/gitleaks-git.json"
mkdir -p "${report_directory}"
rm -f "${report_path}"

actual_config_sha256="$(shasum -a 256 "${gitleaks_config}" | awk '{print $1}')"
if [[ "${actual_config_sha256}" != "${expected_config_sha256}" ]]; then
  printf 'The reviewed Gitleaks configuration digest changed: expected %s, got %s.\n' \
    "${expected_config_sha256}" "${actual_config_sha256}" >&2
  exit 1
fi

expected_history=(
  '74185cb37ffafc5e5e625a0a1395252cd84b086d:apps/agent/src/config.ts:generic-api-key:10'
  '65e75888b9846983ffc03693c32b1fb14de31947:apps/api/test/migrationLint.test.ts:generic-api-key:7'
  '0dff59101d14c860f582ff788b49743632bfb921:apps/api/test/migrationLint.test.ts:generic-api-key:7'
)
actual_history=()
while IFS= read -r line; do
  actual_history[${#actual_history[@]}]="${line}"
done < .gitleaksignore
if [[ "${#actual_history[@]}" -ne "${#expected_history[@]}" ]]; then
  printf 'Expected exactly %d reviewed historical Gitleaks fingerprints, found %d.\n' \
    "${#expected_history[@]}" "${#actual_history[@]}" >&2
  exit 1
fi
for index in "${!expected_history[@]}"; do
  if [[ "${actual_history[index]}" != "${expected_history[index]}" ]]; then
    printf 'Historical Gitleaks fingerprint %d differs from the reviewed value.\n' "${index}" >&2
    exit 1
  fi
done

git_common_directory="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
git_directory="$(cd "$(git rev-parse --git-dir)" && pwd -P)"
if [[ "$(git rev-parse --is-shallow-repository)" != false ]]; then
  printf 'Gitleaks release history verification requires a non-shallow repository.\n' >&2
  exit 1
fi
expected_commit_count="$(GIT_NO_REPLACE_OBJECTS=1 git rev-list --count HEAD)"
if [[ ! "${expected_commit_count}" =~ ^[1-9][0-9]*$ ]]; then
  printf 'Expected a non-empty complete Git history, got commit count %s.\n' \
    "${expected_commit_count}" >&2
  exit 1
fi

docker_arguments=(
  run
  --rm
  --pull=always
  --env GIT_NO_REPLACE_OBJECTS=1
  --volume "${repository_root}:${repository_root}:ro"
  --volume "${report_directory}:/reports"
  --workdir "${repository_root}"
)
case "${git_common_directory}/" in
  "${repository_root}/"*) ;;
  *) docker_arguments+=(--volume "${git_common_directory}:${git_common_directory}:ro") ;;
esac
case "${git_directory}/" in
  "${repository_root}/"*|"${git_common_directory}/"*) ;;
  *) docker_arguments+=(--volume "${git_directory}:${git_directory}:ro") ;;
esac

set +e
scan_output="$(
  docker "${docker_arguments[@]}" \
    "${gitleaks_image}" \
    git \
    --no-banner \
    --redact=100 \
    --verbose \
    "--log-opts=HEAD -m" \
    --config .github/gitleaks.toml \
    --ignore-gitleaks-allow \
    --gitleaks-ignore-path .gitleaksignore \
    --report-format json \
    --report-path /reports/gitleaks-git.json \
    . 2>&1
)"
scan_status=$?
set -e
printf '%s\n' "${scan_output}"
if [[ "${scan_status}" -ne 0 ]]; then
  printf 'Gitleaks history scan exited %d.\n' "${scan_status}" >&2
  exit "${scan_status}"
fi
plain_scan_output="$(printf '%s\n' "${scan_output}" | sed $'s/\033\\[[0-9;]*m//g')"
scanned_commit_count="$(
  grep -Eo '[1-9][0-9]* commits scanned\.' <<<"${plain_scan_output}" \
    | tail -n 1 \
    | awk '{print $1}' \
    || true
)"
if [[ "${scanned_commit_count}" != "${expected_commit_count}" ]]; then
  printf 'Gitleaks reported %s scanned commits, but HEAD has %s reachable commits.\n' \
    "${scanned_commit_count:-none}" "${expected_commit_count}" >&2
  exit 1
fi

test -f "${report_path}"
jq -e 'type == "array" and length == 0' "${report_path}" >/dev/null

fixture_directory="$(mktemp -d)"
cleanup() {
  rm -rf "${fixture_directory}"
}
trap cleanup EXIT
config_bypass_directory="${fixture_directory}/config-bypass"
inline_bypass_directory="${fixture_directory}/inline-bypass"
mkdir -p "${config_bypass_directory}" "${inline_bypass_directory}"
printf 'api_key = "%s%s"\n' \
  'a9F3kL7mN2pQ8rT5' \
  'vW1xY6zB4cD0eG9h' \
  > "${config_bypass_directory}/must-fail.env"
printf '%s\n' \
  'title = "Unreviewed target-local configuration that detects nothing"' \
  '[[rules]]' \
  'id = "never-match"' \
  'description = "A bypass fixture, not the reviewed policy"' \
  "regex = '''THIS_PATTERN_CANNOT_MATCH_THE_FIXTURE'''" \
  > "${config_bypass_directory}/.gitleaks.toml"
printf 'api_key = "%s%s" # %s\n' \
  'b8E4jK6nP1qR9sT2' \
  'uV3wX5yZ7aC0dF8g' \
  'gitleaks:allow' \
  > "${inline_bypass_directory}/annotated-must-fail.env"

set +e
docker run --rm \
  --volume "${config_bypass_directory}:/fixture:ro" \
  --volume "${gitleaks_config}:/policy/gitleaks.toml:ro" \
  "${gitleaks_image}" \
  dir \
  --no-banner \
  --redact=100 \
  --config /policy/gitleaks.toml \
  --ignore-gitleaks-allow \
  /fixture
config_bypass_status=$?
docker run --rm \
  --volume "${inline_bypass_directory}:/fixture:ro" \
  --volume "${gitleaks_config}:/policy/gitleaks.toml:ro" \
  "${gitleaks_image}" \
  dir \
  --no-banner \
  --redact=100 \
  --config /policy/gitleaks.toml \
  --ignore-gitleaks-allow \
  /fixture
inline_bypass_status=$?
set -e
if [[ "${config_bypass_status}" -ne 1 ]]; then
  printf 'Gitleaks target-local-config bypass test returned %d, expected finding exit 1.\n' \
    "${config_bypass_status}" >&2
  exit 1
fi
if [[ "${inline_bypass_status}" -ne 1 ]]; then
  printf 'Gitleaks inline-suppression bypass test returned %d, expected finding exit 1.\n' \
    "${inline_bypass_status}" >&2
  exit 1
fi

printf 'Gitleaks history scan passed with exactly three reviewed fingerprints, an explicit reviewed config, and inline suppression disabled.\n'
printf 'Redacted report: %s\n' "${report_path}"
