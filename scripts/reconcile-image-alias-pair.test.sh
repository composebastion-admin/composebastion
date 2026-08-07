#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
reconciler="${repository_root}/scripts/reconcile-image-alias-pair.sh"
reference_inspector="${repository_root}/scripts/inspect-registry-reference.sh"
fixture_root="$(mktemp -d)"
fake_bin="${fixture_root}/bin"
mkdir -p "${fake_bin}"

cleanup() {
  rm -rf "${fixture_root}"
}
trap cleanup EXIT

cat > "${fake_bin}/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
: "${FAKE_REGISTRY_STATE:?}"
: "${FAKE_MUTATION_LOG:?}"
if [[ "$#" -lt 4 || "$1" != buildx || "$2" != imagetools ]]; then
  exit 64
fi
operation="$3"
reference="$4"
case "${operation}" in
  inspect)
    format=""
    while [[ "$#" -gt 0 ]]; do
      if [[ "$1" = --format ]]; then format="$2"; break; fi
      shift
    done
    if [[ "${FAKE_INSPECT_ERROR_REFERENCE:-}" = "${reference}" ]]; then
      inspection_count=0
      if [[ -f "${FAKE_INSPECT_COUNTER_FILE:?}" ]]; then
        inspection_count="$(<"${FAKE_INSPECT_COUNTER_FILE}")"
      fi
      inspection_count=$((inspection_count + 1))
      printf '%d\n' "${inspection_count}" > "${FAKE_INSPECT_COUNTER_FILE}"
      if [[ -z "${FAKE_INSPECT_ERROR_AFTER_CALL:-}" \
            || "${inspection_count}" -gt "${FAKE_INSPECT_ERROR_AFTER_CALL}" ]]; then
        printf 'ERROR: registry returned 503 Service Unavailable for %s\n' "${reference}" >&2
        exit 1
      fi
    fi
    if [[ "${format}" = '{{json .Manifest}}' ]]; then
      if ! digest="$(jq -er --arg reference "${reference}" '.aliases[$reference]' "${FAKE_REGISTRY_STATE}")"; then
        printf 'ERROR: %s: not found\n' "${reference}" >&2
        exit 1
      fi
      jq -n --arg digest "${digest}" '{digest:$digest}'
    elif [[ "${format}" = '{{json .Image}}' ]]; then
      digest="${reference##*@}"
      revision="$(jq -er --arg digest "${digest}" '.revisions[$digest]' "${FAKE_REGISTRY_STATE}")" || exit 1
      jq -n --arg revision "${revision}" '{
        "linux/amd64": {config:{Labels:{"org.opencontainers.image.revision":$revision}}},
        "linux/arm64": {config:{Labels:{"org.opencontainers.image.revision":$revision}}}
      }'
    else
      exit 64
    fi
    ;;
  create)
    if [[ "${reference}" != --tag || "$#" -ne 6 ]]; then exit 64; fi
    tag="$5"
    source="$6"
    printf '%s|%s\n' "${tag}" "${source}" >> "${FAKE_MUTATION_LOG}"
    if [[ "${FAKE_FAIL_MATCH:-}" = "${tag}|${source}" ]]; then
      exit 1
    fi
    digest="${source##*@}"
    temporary="${FAKE_REGISTRY_STATE}.tmp"
    jq --arg tag "${tag}" --arg digest "${digest}" \
      '.aliases[$tag] = $digest' "${FAKE_REGISTRY_STATE}" > "${temporary}"
    mv "${temporary}" "${FAKE_REGISTRY_STATE}"
    ;;
  *)
    exit 64
    ;;
esac
FAKE_DOCKER

cat > "${fake_bin}/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail
: "${FAKE_REGISTRY_STATE:?}"
if [[ "$#" -ne 9 || "$1" != attestation || "$2" != verify \
      || "$4" != --repo || "$6" != --signer-workflow || "$8" != --source-digest ]]; then
  exit 64
fi
digest="${3##*@}"
subject="${3#oci://}"
expected_image="$(jq -er --arg digest "${digest}" '.images[$digest]' "${FAKE_REGISTRY_STATE}")"
expected_revision="$(jq -er --arg digest "${digest}" '.revisions[$digest]' "${FAKE_REGISTRY_STATE}")"
expected_signer="${GITHUB_SERVER_URL#https://}/${GITHUB_REPOSITORY}/.github/workflows/publish-images.yml"
[[ "${subject}" = "${expected_image}@${digest}" ]]
[[ "$5" = "${GITHUB_REPOSITORY}" ]]
[[ "$7" = "${expected_signer}" ]]
[[ "$9" = "${expected_revision}" ]]
jq -e --arg digest "${digest}" '.attested | index($digest) != null' "${FAKE_REGISTRY_STATE}" >/dev/null
FAKE_GH
cat > "${fake_bin}/skopeo" <<'FAKE_SKOPEO'
#!/usr/bin/env bash
set -euo pipefail
reference="${*: -1}"
reference="${reference#docker://}"
case "${FAKE_SKOPEO_OUTCOME:-exists}" in
  exists)
    printf '%s\n' "${FAKE_SKOPEO_DIGEST:?}"
    ;;
  missing)
    printf 'FATA[0000] reading manifest %s: manifest unknown\n' "${reference}" >&2
    exit 1
    ;;
  transient)
    printf 'FATA[0000] pinging container registry: received 503 Service Unavailable\n' >&2
    exit 1
    ;;
  *)
    exit 64
    ;;
esac
FAKE_SKOPEO
cat > "${fake_bin}/sleep" <<'FAKE_SLEEP'
#!/usr/bin/env bash
exit 0
FAKE_SLEEP
chmod +x "${fake_bin}/docker" "${fake_bin}/gh" "${fake_bin}/skopeo" "${fake_bin}/sleep"

app_image="registry.test/composebastion-app"
agent_image="registry.test/composebastion-agent"
target_revision="1111111111111111111111111111111111111111"
prior_revision="2222222222222222222222222222222222222222"
app_target="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
agent_target="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
app_prior="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
agent_prior="sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_jq() {
  local file="$1"
  local expression="$2"
  jq -e "${expression}" "${file}" >/dev/null || fail "${file}: ${expression}"
}

write_state() {
  local state="$1"
  local aliases_json="$2"
  local attested_json="$3"
  jq -n \
    --argjson aliases "${aliases_json}" \
    --argjson attested "${attested_json}" \
    --arg appTarget "${app_target}" \
    --arg agentTarget "${agent_target}" \
    --arg appPrior "${app_prior}" \
    --arg agentPrior "${agent_prior}" \
    --arg appImage "${app_image}" \
    --arg agentImage "${agent_image}" \
    --arg targetRevision "${target_revision}" \
    --arg priorRevision "${prior_revision}" \
    '{
      aliases:$aliases,
      attested:$attested,
      images:{
        ($appTarget):$appImage,
        ($agentTarget):$agentImage,
        ($appPrior):$appImage,
        ($agentPrior):$agentImage
      },
      revisions:{
        ($appTarget):$targetRevision,
        ($agentTarget):$targetRevision,
        ($appPrior):$priorRevision,
        ($agentPrior):$priorRevision
      }
    }' > "${state}"
  rm -f "${state}.inspect-count"
}

run_reconciler() {
  local state="$1"
  local log="$2"
  shift 2
  env \
    PATH="${fake_bin}:${PATH}" \
    FAKE_REGISTRY_STATE="${state}" \
    FAKE_MUTATION_LOG="${log}" \
    GITHUB_REPOSITORY="example/composebastion" \
    GITHUB_REF="${TEST_GITHUB_REF}" \
    GITHUB_SHA="${target_revision}" \
    GITHUB_SERVER_URL="https://github.com" \
    GITHUB_RUN_ID="1234" \
    GITHUB_RUN_ATTEMPT="1" \
    GH_TOKEN="fixture-token" \
    LEGACY_ALIAS_BOOTSTRAP_POLICY="${TEST_BOOTSTRAP_POLICY:-}" \
    FAKE_FAIL_MATCH="${TEST_FAIL_MATCH:-}" \
    FAKE_INSPECT_ERROR_REFERENCE="${TEST_INSPECT_ERROR_REFERENCE:-}" \
    FAKE_INSPECT_ERROR_AFTER_CALL="${TEST_INSPECT_ERROR_AFTER_CALL:-}" \
    FAKE_INSPECT_COUNTER_FILE="${state}.inspect-count" \
    /bin/bash "${reconciler}" "$@"
}

all_attested="[\"${app_target}\",\"${agent_target}\",\"${app_prior}\",\"${agent_prior}\"]"
target_attested="[\"${app_target}\",\"${agent_target}\"]"
branch_aliases="{\"${app_image}:beta\":\"${app_prior}\",\"${agent_image}:beta\":\"${agent_prior}\"}"
beta_version="1.2.0-beta.1"

# The shared inspector must distinguish a confirmed missing reference from a
# transient registry failure, including in the skopeo publication path.
set +e
PATH="${fake_bin}:${PATH}" \
FAKE_SKOPEO_OUTCOME="missing" \
FAKE_SKOPEO_DIGEST="${app_target}" \
  /bin/bash "${reference_inspector}" skopeo "${fixture_root}/auth.json" "${app_image}:missing" \
  >/dev/null 2>"${fixture_root}/skopeo-missing.stderr"
inspection_status=$?
set -e
[[ "${inspection_status}" -eq 3 ]] || fail "confirmed skopeo not-found returned ${inspection_status}, expected 3"
set +e
PATH="${fake_bin}:${PATH}" \
FAKE_SKOPEO_OUTCOME="transient" \
FAKE_SKOPEO_DIGEST="${app_target}" \
  /bin/bash "${reference_inspector}" skopeo "${fixture_root}/auth.json" "${app_image}:transient" \
  >/dev/null 2>"${fixture_root}/skopeo-transient.stderr"
inspection_status=$?
set -e
[[ "${inspection_status}" -eq 2 ]] || fail "transient skopeo failure returned ${inspection_status}, expected 2"

# Clean branch success.
case_root="${fixture_root}/success"
mkdir -p "${case_root}"
write_state "${case_root}/state.json" "${branch_aliases}" "${all_attested}"
: > "${case_root}/mutations.log"
TEST_GITHUB_REF="refs/heads/beta"
TEST_BOOTSTRAP_POLICY=""
TEST_FAIL_MATCH=""
TEST_INSPECT_ERROR_REFERENCE=""
TEST_INSPECT_ERROR_AFTER_CALL=""
run_reconciler "${case_root}/state.json" "${case_root}/mutations.log" \
  "${case_root}/evidence.json" branch "${app_image}" "${agent_image}" \
  "${app_target}" "${agent_target}" beta
assert_jq "${case_root}/state.json" \
  ".aliases[\"${app_image}:beta\"] == \"${app_target}\" and .aliases[\"${agent_image}:beta\"] == \"${agent_target}\""
assert_jq "${case_root}/evidence.json" \
  ".status == \"succeeded\" and .finalInspectionComplete == true and .finalTargetPairVerified == true and .targetPair.revision == \"${target_revision}\" and .aliases[0].final.appDigest == \"${app_target}\" and .aliases[0].final.agentDigest == \"${agent_target}\""

# A beta publication creates the exact prerelease alias first, then advances
# the moving beta alias to the same attested app/agent pair.
case_root="${fixture_root}/beta-success"
mkdir -p "${case_root}"
write_state "${case_root}/state.json" "${branch_aliases}" "${all_attested}"
: > "${case_root}/mutations.log"
TEST_GITHUB_REF="refs/heads/beta"
TEST_BOOTSTRAP_POLICY=""
TEST_FAIL_MATCH=""
TEST_INSPECT_ERROR_REFERENCE=""
TEST_INSPECT_ERROR_AFTER_CALL=""
run_reconciler "${case_root}/state.json" "${case_root}/mutations.log" \
  "${case_root}/evidence.json" beta "${app_image}" "${agent_image}" \
  "${app_target}" "${agent_target}" beta "${beta_version}"
assert_jq "${case_root}/state.json" \
  ". as \$state | [\"beta\",\"${beta_version}\"] | all(.[]; . as \$alias | (\$state.aliases[\"${app_image}:\" + \$alias] == \"${app_target}\") and (\$state.aliases[\"${agent_image}:\" + \$alias] == \"${agent_target}\"))"
assert_jq "${case_root}/evidence.json" \
  ".status == \"succeeded\" and .mode == \"beta\" and (.aliases | length) == 2 and (.aliases[] | select(.alias == \"${beta_version}\") | .prior.kind) == \"new-immutable\""
[[ "$(wc -l < "${case_root}/mutations.log" | tr -d ' ')" -eq 4 ]] \
  || fail "beta success did not reconcile exactly four component aliases"

# An existing prerelease alias is immutable and blocks beta before mutation if
# it points at any other valid attested pair.
case_root="${fixture_root}/beta-immutable-collision"
mkdir -p "${case_root}"
beta_collision_aliases="{
  \"${app_image}:beta\":\"${app_prior}\",
  \"${agent_image}:beta\":\"${agent_prior}\",
  \"${app_image}:${beta_version}\":\"${app_prior}\",
  \"${agent_image}:${beta_version}\":\"${agent_prior}\"
}"
write_state "${case_root}/state.json" "${beta_collision_aliases}" "${all_attested}"
: > "${case_root}/mutations.log"
if run_reconciler "${case_root}/state.json" "${case_root}/mutations.log" \
  "${case_root}/evidence.json" beta "${app_image}" "${agent_image}" \
  "${app_target}" "${agent_target}" beta "${beta_version}"; then
  fail "immutable beta version collision unexpectedly succeeded"
fi
[[ ! -s "${case_root}/mutations.log" ]] \
  || fail "immutable beta version collision mutated an alias"
assert_jq "${case_root}/evidence.json" \
  '.status == "preflight-failed" and (.failure | contains("Immutable version alias"))'

# A partial new prerelease pair is retained for safe retry and must never move
# the beta alias to a candidate whose exact version pair is incomplete.
case_root="${fixture_root}/beta-partial-version"
mkdir -p "${case_root}"
write_state "${case_root}/state.json" "${branch_aliases}" "${all_attested}"
: > "${case_root}/mutations.log"
TEST_FAIL_MATCH="${agent_image}:${beta_version}|${agent_image}@${agent_target}"
if run_reconciler "${case_root}/state.json" "${case_root}/mutations.log" \
  "${case_root}/evidence.json" beta "${app_image}" "${agent_image}" \
  "${app_target}" "${agent_target}" beta "${beta_version}"; then
  fail "partial beta version unexpectedly succeeded"
fi
assert_jq "${case_root}/state.json" \
  ".aliases[\"${app_image}:${beta_version}\"] == \"${app_target}\" and (.aliases[\"${agent_image}:${beta_version}\"] // null) == null and .aliases[\"${app_image}:beta\"] == \"${app_prior}\" and .aliases[\"${agent_image}:beta\"] == \"${agent_prior}\""
assert_jq "${case_root}/evidence.json" \
  '.status == "partial-blocked" and .rollbackStatus == "partial-blocked"'
if grep -Eq ':beta\|' "${case_root}/mutations.log"; then
  fail "partial beta version attempted to move the beta alias"
fi
TEST_FAIL_MATCH=""

# Clean stable release success creates both immutable aliases, creates the
# minor alias, advances latest, and verifies all four final pairs.
case_root="${fixture_root}/stable-success"
mkdir -p "${case_root}"
stable_success_aliases="{
  \"${app_image}:latest\":\"${app_prior}\",
  \"${agent_image}:latest\":\"${agent_prior}\"
}"
write_state "${case_root}/state.json" "${stable_success_aliases}" "${all_attested}"
: > "${case_root}/mutations.log"
TEST_GITHUB_REF="refs/tags/v1.2.0"
TEST_BOOTSTRAP_POLICY=""
TEST_FAIL_MATCH=""
TEST_INSPECT_ERROR_REFERENCE=""
TEST_INSPECT_ERROR_AFTER_CALL=""
run_reconciler "${case_root}/state.json" "${case_root}/mutations.log" \
  "${case_root}/evidence.json" stable "${app_image}" "${agent_image}" \
  "${app_target}" "${agent_target}" 1.2.0 v1.2.0 1.2 latest
assert_jq "${case_root}/state.json" \
  ". as \$state | [\"1.2.0\",\"v1.2.0\",\"1.2\",\"latest\"] | all(.[]; . as \$alias | (\$state.aliases[\"${app_image}:\" + \$alias] == \"${app_target}\") and (\$state.aliases[\"${agent_image}:\" + \$alias] == \"${agent_target}\"))"
assert_jq "${case_root}/evidence.json" \
  ".status == \"succeeded\" and .rollbackStatus == \"not-required\" and .mode == \"stable\" and .finalInspectionComplete == true and .finalTargetPairVerified == true and (.aliases | length) == 4 and all(.aliases[]; .final.appDigest == \"${app_target}\" and .final.agentDigest == \"${agent_target}\")"
[[ "$(wc -l < "${case_root}/mutations.log" | tr -d ' ')" -eq 8 ]] \
  || fail "clean stable success did not reconcile exactly eight component aliases"

# A released immutable SemVer pair at a different valid attested digest must
# fail preflight before any moving or immutable alias is mutated.
case_root="${fixture_root}/immutable-exact-collision"
mkdir -p "${case_root}"
immutable_collision_aliases="{
  \"${app_image}:1.2.0\":\"${app_prior}\",
  \"${agent_image}:1.2.0\":\"${agent_prior}\"
}"
write_state "${case_root}/state.json" "${immutable_collision_aliases}" "${all_attested}"
: > "${case_root}/mutations.log"
TEST_GITHUB_REF="refs/tags/v1.2.0"
if run_reconciler "${case_root}/state.json" "${case_root}/mutations.log" \
  "${case_root}/evidence.json" stable "${app_image}" "${agent_image}" \
  "${app_target}" "${agent_target}" 1.2.0 v1.2.0 1.2 latest; then
  fail "immutable exact-tag collision unexpectedly succeeded"
fi
[[ ! -s "${case_root}/mutations.log" ]] \
  || fail "immutable exact-tag collision mutated an alias"
assert_jq "${case_root}/state.json" \
  ".aliases[\"${app_image}:1.2.0\"] == \"${app_prior}\" and .aliases[\"${agent_image}:1.2.0\"] == \"${agent_prior}\" and (.aliases[\"${app_image}:v1.2.0\"] // null) == null and (.aliases[\"${agent_image}:v1.2.0\"] // null) == null and (.aliases[\"${app_image}:1.2\"] // null) == null and (.aliases[\"${agent_image}:1.2\"] // null) == null and (.aliases[\"${app_image}:latest\"] // null) == null and (.aliases[\"${agent_image}:latest\"] // null) == null"
assert_jq "${case_root}/evidence.json" \
  '.status == "preflight-failed" and .finalInspectionComplete == false and .finalTargetPairVerified == false and (.failure | contains("Immutable version alias"))'

# A transient failure that begins only during final evidence inspection must
# never leave a green status after the pair appeared to settle.
case_root="${fixture_root}/final-evidence-inspection-failure"
mkdir -p "${case_root}"
write_state "${case_root}/state.json" "${branch_aliases}" "${all_attested}"
: > "${case_root}/mutations.log"
TEST_GITHUB_REF="refs/heads/beta"
TEST_BOOTSTRAP_POLICY=""
TEST_FAIL_MATCH=""
TEST_INSPECT_ERROR_REFERENCE="${app_image}:beta"
TEST_INSPECT_ERROR_AFTER_CALL="3"
if run_reconciler "${case_root}/state.json" "${case_root}/mutations.log" \
  "${case_root}/evidence.json" branch "${app_image}" "${agent_image}" \
  "${app_target}" "${agent_target}" beta; then
  fail "final evidence inspection failure unexpectedly succeeded"
fi
assert_jq "${case_root}/state.json" \
  ".aliases[\"${app_image}:beta\"] == \"${app_target}\" and .aliases[\"${agent_image}:beta\"] == \"${agent_target}\""
assert_jq "${case_root}/evidence.json" \
  '.status == "final-verification-failed" and .rollbackStatus == "not-attempted-final-verification-failed" and .finalInspectionComplete == false and .finalTargetPairVerified == false and .aliases[0].finalInspection.app == "inspection-error" and .aliases[0].final.appDigest == null'
[[ "$(wc -l < "${case_root}/mutations.log" | tr -d ' ')" -eq 2 ]] \
  || fail "final evidence inspection failure attempted unexpected follow-up mutation"
TEST_INSPECT_ERROR_REFERENCE=""
TEST_INSPECT_ERROR_AFTER_CALL=""

# Target attestation failure must not mutate either alias.
case_root="${fixture_root}/target-attestation-failure"
mkdir -p "${case_root}"
write_state "${case_root}/state.json" "${branch_aliases}" "[\"${app_prior}\",\"${agent_prior}\"]"
: > "${case_root}/mutations.log"
if run_reconciler "${case_root}/state.json" "${case_root}/mutations.log" \
  "${case_root}/evidence.json" branch "${app_image}" "${agent_image}" \
  "${app_target}" "${agent_target}" beta; then
  fail "target attestation failure unexpectedly succeeded"
fi
[[ ! -s "${case_root}/mutations.log" ]] || fail "target attestation failure mutated an alias"
assert_jq "${case_root}/state.json" \
  ".aliases[\"${app_image}:beta\"] == \"${app_prior}\" and .aliases[\"${agent_image}:beta\"] == \"${agent_prior}\""

# A transient alias-inspection failure must not be classified as absence or
# mutate either member of the pair.
case_root="${fixture_root}/transient-inspection-failure"
mkdir -p "${case_root}"
write_state "${case_root}/state.json" "${branch_aliases}" "${all_attested}"
: > "${case_root}/mutations.log"
TEST_GITHUB_REF="refs/heads/beta"
TEST_BOOTSTRAP_POLICY=""
TEST_FAIL_MATCH=""
TEST_INSPECT_ERROR_REFERENCE="${app_image}:beta"
if run_reconciler "${case_root}/state.json" "${case_root}/mutations.log" \
  "${case_root}/evidence.json" branch "${app_image}" "${agent_image}" \
  "${app_target}" "${agent_target}" beta; then
  fail "transient registry inspection unexpectedly succeeded"
fi
[[ ! -s "${case_root}/mutations.log" ]] || fail "transient registry inspection mutated an alias"
assert_jq "${case_root}/state.json" \
  ".aliases[\"${app_image}:beta\"] == \"${app_prior}\" and .aliases[\"${agent_image}:beta\"] == \"${agent_prior}\""
assert_jq "${case_root}/evidence.json" \
  '.status == "preflight-failed" and (.failure | contains("failed without confirming"))'
TEST_INSPECT_ERROR_REFERENCE=""

# Exact, expiring legacy policy can bootstrap one known unattested pair.
case_root="${fixture_root}/legacy-bootstrap"
mkdir -p "${case_root}"
write_state "${case_root}/state.json" "${branch_aliases}" "${target_attested}"
: > "${case_root}/mutations.log"
jq -n \
  --arg appImage "${app_image}" \
  --arg agentImage "${agent_image}" \
  --arg appDigest "${app_prior}" \
  --arg agentDigest "${agent_prior}" \
  --arg revision "${prior_revision}" \
  '{schemaVersion:1,entries:[{
    status:"pending",expiresOn:"2099-12-31",targetRef:"refs/heads/beta",
    alias:"beta",revision:$revision,appImage:$appImage,appDigest:$appDigest,
    agentImage:$agentImage,agentDigest:$agentDigest
  }]}' > "${case_root}/policy.json"
TEST_BOOTSTRAP_POLICY="${case_root}/policy.json"
run_reconciler "${case_root}/state.json" "${case_root}/mutations.log" \
  "${case_root}/evidence.json" branch "${app_image}" "${agent_image}" \
  "${app_target}" "${agent_target}" beta
assert_jq "${case_root}/evidence.json" \
  '.status == "succeeded" and .aliases[0].prior.kind == "legacy-unattested"'
TEST_BOOTSTRAP_POLICY=""

# Wrong, expired, or ambiguous legacy policy must fail before mutation.
assert_legacy_policy_rejected() {
  local name="$1"
  local policy="$2"
  local negative_root="${fixture_root}/${name}"
  mkdir -p "${negative_root}"
  write_state "${negative_root}/state.json" "${branch_aliases}" "${target_attested}"
  : > "${negative_root}/mutations.log"
  TEST_GITHUB_REF="refs/heads/beta"
  TEST_BOOTSTRAP_POLICY="${policy}"
  TEST_FAIL_MATCH=""
  if run_reconciler "${negative_root}/state.json" "${negative_root}/mutations.log" \
    "${negative_root}/evidence.json" branch "${app_image}" "${agent_image}" \
    "${app_target}" "${agent_target}" beta; then
    fail "${name} legacy policy unexpectedly succeeded"
  fi
  [[ ! -s "${negative_root}/mutations.log" ]] || fail "${name} legacy policy mutated an alias"
  assert_jq "${negative_root}/state.json" \
    ".aliases[\"${app_image}:beta\"] == \"${app_prior}\" and .aliases[\"${agent_image}:beta\"] == \"${agent_prior}\""
}

jq '.entries[0].appDigest = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"' \
  "${case_root}/policy.json" > "${fixture_root}/wrong-digest-policy.json"
assert_legacy_policy_rejected "legacy-wrong-digest" "${fixture_root}/wrong-digest-policy.json"
jq '.entries[0].targetRef = "refs/heads/main"' \
  "${case_root}/policy.json" > "${fixture_root}/wrong-ref-policy.json"
assert_legacy_policy_rejected "legacy-wrong-ref" "${fixture_root}/wrong-ref-policy.json"
jq '.entries[0].expiresOn = "2000-01-01"' \
  "${case_root}/policy.json" > "${fixture_root}/expired-policy.json"
assert_legacy_policy_rejected "legacy-expired" "${fixture_root}/expired-policy.json"
jq '.entries += [.entries[0]]' \
  "${case_root}/policy.json" > "${fixture_root}/duplicate-policy.json"
assert_legacy_policy_rejected "legacy-duplicate" "${fixture_root}/duplicate-policy.json"
TEST_BOOTSTRAP_POLICY=""

# A permanent mid-pair failure restores and verifies both genuine prior digests.
case_root="${fixture_root}/verified-rollback"
mkdir -p "${case_root}"
write_state "${case_root}/state.json" "${branch_aliases}" "${all_attested}"
: > "${case_root}/mutations.log"
TEST_FAIL_MATCH="${agent_image}:beta|${agent_image}@${agent_target}"
if run_reconciler "${case_root}/state.json" "${case_root}/mutations.log" \
  "${case_root}/evidence.json" branch "${app_image}" "${agent_image}" \
  "${app_target}" "${agent_target}" beta; then
  fail "mid-pair failure unexpectedly succeeded"
fi
assert_jq "${case_root}/state.json" \
  ".aliases[\"${app_image}:beta\"] == \"${app_prior}\" and .aliases[\"${agent_image}:beta\"] == \"${agent_prior}\""
assert_jq "${case_root}/evidence.json" \
  ".status == \"failed-rolled-back\" and .rollbackStatus == \"verified\" and .aliases[0].final.appDigest == \"${app_prior}\" and .aliases[0].final.agentDigest == \"${agent_prior}\""
TEST_FAIL_MATCH=""

# A partial new exact tag stays on the exact target and blocks minor/latest.
case_root="${fixture_root}/partial-new-immutable"
mkdir -p "${case_root}"
stable_aliases="{\"${app_image}:latest\":\"${app_prior}\",\"${agent_image}:latest\":\"${agent_prior}\"}"
write_state "${case_root}/state.json" "${stable_aliases}" "${all_attested}"
: > "${case_root}/mutations.log"
TEST_GITHUB_REF="refs/tags/v1.2.0"
TEST_FAIL_MATCH="${agent_image}:1.2.0|${agent_image}@${agent_target}"
if run_reconciler "${case_root}/state.json" "${case_root}/mutations.log" \
  "${case_root}/evidence.json" stable "${app_image}" "${agent_image}" \
  "${app_target}" "${agent_target}" 1.2.0 v1.2.0 1.2 latest; then
  fail "partial new immutable alias unexpectedly succeeded"
fi
assert_jq "${case_root}/state.json" \
  ".aliases[\"${app_image}:1.2.0\"] == \"${app_target}\" and (.aliases[\"${agent_image}:1.2.0\"] // null) == null and (.aliases[\"${app_image}:1.2\"] // null) == null and (.aliases[\"${agent_image}:1.2\"] // null) == null and .aliases[\"${app_image}:latest\"] == \"${app_prior}\" and .aliases[\"${agent_image}:latest\"] == \"${agent_prior}\""
assert_jq "${case_root}/evidence.json" \
  ".status == \"partial-blocked\" and .rollbackStatus == \"partial-blocked\" and .aliases[0].final.appDigest == \"${app_target}\" and .aliases[0].final.agentDigest == null"
if grep -Eq ':1\.2\||:latest\|' "${case_root}/mutations.log"; then
  fail "partial exact alias attempted to move minor/latest"
fi

# A newly completed minor pair is retained if later latest mutation rolls back.
case_root="${fixture_root}/retained-new-minor"
mkdir -p "${case_root}"
retained_aliases="{
  \"${app_image}:1.2.0\":\"${app_target}\",
  \"${agent_image}:1.2.0\":\"${agent_target}\",
  \"${app_image}:v1.2.0\":\"${app_target}\",
  \"${agent_image}:v1.2.0\":\"${agent_target}\",
  \"${app_image}:latest\":\"${app_prior}\",
  \"${agent_image}:latest\":\"${agent_prior}\"
}"
write_state "${case_root}/state.json" "${retained_aliases}" "${all_attested}"
: > "${case_root}/mutations.log"
TEST_GITHUB_REF="refs/tags/v1.2.0"
TEST_FAIL_MATCH="${agent_image}:latest|${agent_image}@${agent_target}"
if run_reconciler "${case_root}/state.json" "${case_root}/mutations.log" \
  "${case_root}/evidence.json" stable "${app_image}" "${agent_image}" \
  "${app_target}" "${agent_target}" 1.2.0 v1.2.0 1.2 latest; then
  fail "latest failure after new minor unexpectedly succeeded"
fi
assert_jq "${case_root}/state.json" \
  ".aliases[\"${app_image}:1.2\"] == \"${app_target}\" and .aliases[\"${agent_image}:1.2\"] == \"${agent_target}\" and .aliases[\"${app_image}:latest\"] == \"${app_prior}\" and .aliases[\"${agent_image}:latest\"] == \"${agent_prior}\""
assert_jq "${case_root}/evidence.json" \
  ".status == \"failed-retained-new-pair\" and .rollbackStatus == \"verified-with-retained-new-pair\" and (.aliases[] | select(.alias == \"1.2\") | .final.appDigest) == \"${app_target}\" and (.aliases[] | select(.alias == \"1.2\") | .final.agentDigest) == \"${agent_target}\""

printf 'Alias-pair reconciliation behavioral tests passed.\n'
