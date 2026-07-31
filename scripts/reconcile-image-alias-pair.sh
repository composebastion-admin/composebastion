#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
reference_inspector="${repository_root}/scripts/inspect-registry-reference.sh"

if [[ "$#" -lt 7 ]]; then
  printf 'Usage: %s EVIDENCE MODE APP_IMAGE AGENT_IMAGE APP_DIGEST AGENT_DIGEST ALIAS...\n' "$0" >&2
  exit 64
fi

evidence_path="$1"
mode="$2"
app_image="$3"
agent_image="$4"
app_target="$5"
agent_target="$6"
shift 6
aliases=("$@")

case "${mode}" in
  branch|stable) ;;
  *)
    printf 'Mode must be branch or stable, got %s.\n' "${mode}" >&2
    exit 64
    ;;
esac
for digest in "${app_target}" "${agent_target}"; do
  if [[ ! "${digest}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    printf 'Invalid target digest: %s\n' "${digest}" >&2
    exit 64
  fi
done
for alias in "${aliases[@]}"; do
  if [[ ! "${alias}" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]]; then
    printf 'Invalid OCI alias: %s\n' "${alias}" >&2
    exit 64
  fi
done
if [[ "${mode}" = branch && "${#aliases[@]}" -ne 1 ]]; then
  printf 'Branch reconciliation requires exactly one moving alias.\n' >&2
  exit 64
fi
if [[ "${mode}" = stable && "${#aliases[@]}" -ne 4 ]]; then
  printf 'Stable reconciliation requires VERSION, vVERSION, minor, and latest aliases.\n' >&2
  exit 64
fi

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_REF:?GITHUB_REF is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${GITHUB_SERVER_URL:?GITHUB_SERVER_URL is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

mkdir -p "$(dirname "${evidence_path}")"
records_path="${evidence_path}.records"
final_records_path="${evidence_path}.final-records"
rm -f "${evidence_path}" "${records_path}"
touch "${records_path}"

status="preflight-failed"
rollback_status="not-required"
failure_message=""
target_revision=""
evidence_inspection_complete=false
evidence_target_pair_verified=false
prior_app=()
prior_agent=()
prior_kind=()

write_evidence() {
  local temporary="${evidence_path}.tmp"
  local record alias app_final agent_final app_inspection agent_inspection evidence_alias_count
  evidence_inspection_complete=true
  evidence_target_pair_verified=true
  evidence_alias_count=0
  rm -f "${final_records_path}"
  touch "${final_records_path}"
  while IFS= read -r record; do
    evidence_alias_count=$((evidence_alias_count + 1))
    alias="$(jq -er .alias <<<"${record}")"
    app_inspection="resolved-or-confirmed-missing"
    agent_inspection="resolved-or-confirmed-missing"
    if ! app_final="$(resolve_digest "${app_image}" "${alias}")"; then
      app_final=""
      app_inspection="inspection-error"
      evidence_inspection_complete=false
      evidence_target_pair_verified=false
    fi
    if ! agent_final="$(resolve_digest "${agent_image}" "${alias}")"; then
      agent_final=""
      agent_inspection="inspection-error"
      evidence_inspection_complete=false
      evidence_target_pair_verified=false
    fi
    if [[ "${app_final}" != "${app_target}" || "${agent_final}" != "${agent_target}" ]]; then
      evidence_target_pair_verified=false
    fi
    jq \
      --arg appFinal "${app_final}" \
      --arg agentFinal "${agent_final}" \
      --arg appInspection "${app_inspection}" \
      --arg agentInspection "${agent_inspection}" \
      '. + {
        final: {
          appDigest: (if $appFinal == "" then null else $appFinal end),
          agentDigest: (if $agentFinal == "" then null else $agentFinal end)
        },
        finalInspection: {
          app: $appInspection,
          agent: $agentInspection
        }
      }' <<<"${record}" >> "${final_records_path}"
  done < "${records_path}"
  if [[ "${evidence_alias_count}" -ne "${#aliases[@]}" ]]; then
    evidence_inspection_complete=false
    evidence_target_pair_verified=false
  fi
  jq -s \
    --arg status "${status}" \
    --arg rollbackStatus "${rollback_status}" \
    --arg failure "${failure_message}" \
    --arg mode "${mode}" \
    --arg repository "${GITHUB_REPOSITORY}" \
    --arg workflowSha "${GITHUB_SHA}" \
    --arg runId "${GITHUB_RUN_ID}" \
    --arg runAttempt "${GITHUB_RUN_ATTEMPT}" \
    --arg targetRevision "${target_revision}" \
    --arg appImage "${app_image}" \
    --arg agentImage "${agent_image}" \
    --arg appTarget "${app_target}" \
    --arg agentTarget "${agent_target}" \
    --argjson finalInspectionComplete "${evidence_inspection_complete}" \
    --argjson finalTargetPairVerified "${evidence_target_pair_verified}" \
    '{
      schemaVersion: 1,
      status: $status,
      rollbackStatus: $rollbackStatus,
      failure: (if $failure == "" then null else $failure end),
      mode: $mode,
      repository: $repository,
      workflow: {
        commit: $workflowSha,
        runId: $runId,
        runAttempt: $runAttempt
      },
      targetPair: {
        revision: (if $targetRevision == "" then null else $targetRevision end),
        app: { image: $appImage, digest: $appTarget },
        agent: { image: $agentImage, digest: $agentTarget }
      },
      finalInspectionComplete: $finalInspectionComplete,
      finalTargetPairVerified: $finalTargetPairVerified,
      crossRepositoryAtomicity: false,
      aliases: .
    }' \
    "${final_records_path}" > "${temporary}"
  mv "${temporary}" "${evidence_path}"
}

rewrite_evidence_outcome() {
  local temporary="${evidence_path}.tmp"
  jq \
    --arg status "${status}" \
    --arg rollbackStatus "${rollback_status}" \
    --arg failure "${failure_message}" \
    '.status = $status
     | .rollbackStatus = $rollbackStatus
     | .failure = (if $failure == "" then null else $failure end)' \
    "${evidence_path}" > "${temporary}"
  mv "${temporary}" "${evidence_path}"
}

cleanup() {
  local exit_status=$?
  if [[ ! -f "${evidence_path}" ]]; then
    failure_message="${failure_message:-Alias reconciliation exited before producing complete evidence.}"
    write_evidence || true
  fi
  rm -f "${records_path}" "${final_records_path}" "${evidence_path}.tmp"
  return "${exit_status}"
}
trap cleanup EXIT

resolve_digest() {
  local image="$1"
  local alias="$2"
  local digest inspection_status
  if digest="$(bash "${reference_inspector}" buildx "${image}:${alias}")"; then
    printf '%s\n' "${digest}"
    return 0
  else
    inspection_status=$?
  fi
  if [[ "${inspection_status}" -eq 3 ]]; then
    return 0
  fi
  return "${inspection_status}"
}

resolve_revision() {
  local image="$1"
  local digest="$2"
  docker buildx imagetools inspect "${image}@${digest}" \
    --format '{{json .Image}}' \
    | jq -er '
        [
          .["linux/amd64"].config.Labels["org.opencontainers.image.revision"],
          .["linux/arm64"].config.Labels["org.opencontainers.image.revision"]
        ]
        | if length == 2
             and all(.[]; type == "string" and test("^[a-f0-9]{40}$"))
             and (unique | length) == 1
          then .[0]
          else error("platform revision labels do not identify one full commit")
          end
      '
}

resolve_pair_revision() {
  local app_digest="$1"
  local agent_digest="$2"
  local app_revision agent_revision
  app_revision="$(resolve_revision "${app_image}" "${app_digest}")" || return 1
  agent_revision="$(resolve_revision "${agent_image}" "${agent_digest}")" || return 1
  if [[ "${app_revision}" != "${agent_revision}" ]]; then
    printf 'App and agent pair revisions differ: %s vs %s.\n' \
      "${app_revision}" "${agent_revision}" >&2
    return 1
  fi
  printf '%s\n' "${app_revision}"
}

verify_attested_pair() {
  local app_digest="$1"
  local agent_digest="$2"
  local expected_revision="${3:-}"
  local app_revision signer_workflow
  app_revision="$(resolve_pair_revision "${app_digest}" "${agent_digest}")" || return 1
  if [[ -n "${expected_revision}" && "${app_revision}" != "${expected_revision}" ]]; then
    printf 'Pair revision %s does not match expected revision %s.\n' \
      "${app_revision}" "${expected_revision}" >&2
    return 1
  fi
  signer_workflow="${GITHUB_SERVER_URL#https://}/${GITHUB_REPOSITORY}/.github/workflows/publish-images.yml"
  gh attestation verify "oci://${app_image}@${app_digest}" \
    --repo "${GITHUB_REPOSITORY}" \
    --signer-workflow "${signer_workflow}" \
    --source-digest "${app_revision}" >/dev/null || return 1
  gh attestation verify "oci://${agent_image}@${agent_digest}" \
    --repo "${GITHUB_REPOSITORY}" \
    --signer-workflow "${signer_workflow}" \
    --source-digest "${app_revision}" >/dev/null || return 1
  printf '%s\n' "${app_revision}"
}

allow_legacy_pair() {
  local alias="$1"
  local app_digest="$2"
  local agent_digest="$3"
  local revision="$4"
  local policy_path="${LEGACY_ALIAS_BOOTSTRAP_POLICY:-}"
  local today
  if [[ -z "${policy_path}" || ! -f "${policy_path}" ]]; then
    return 1
  fi
  today="$(date -u +%Y-%m-%d)"
  jq -e \
    --arg today "${today}" \
    --arg targetRef "${GITHUB_REF}" \
    --arg alias "${alias}" \
    --arg revision "${revision}" \
    --arg appImage "${app_image}" \
    --arg appDigest "${app_digest}" \
    --arg agentImage "${agent_image}" \
    --arg agentDigest "${agent_digest}" \
    '.schemaVersion == 1
     and ([.entries[]
       | select(
           .status == "pending"
           and .expiresOn >= $today
           and .targetRef == $targetRef
           and .alias == $alias
           and .revision == $revision
           and .appImage == $appImage
           and .appDigest == $appDigest
           and .agentImage == $agentImage
           and .agentDigest == $agentDigest
         )] | length) == 1' \
    "${policy_path}" >/dev/null
}

if ! target_revision="$(verify_attested_pair "${app_target}" "${agent_target}" "${GITHUB_SHA}")"; then
  failure_message="The target app/agent indexes do not have valid provenance for ${GITHUB_SHA}."
  printf '%s\n' "${failure_message}" >&2
  exit 1
fi

for index in "${!aliases[@]}"; do
  alias="${aliases[index]}"
  if ! app_before="$(resolve_digest "${app_image}" "${alias}")"; then
    failure_message="Registry inspection for ${app_image}:${alias} failed without confirming that the alias is absent; no mutation was attempted."
    printf '%s\n' "${failure_message}" >&2
    exit 1
  fi
  if ! agent_before="$(resolve_digest "${agent_image}" "${alias}")"; then
    failure_message="Registry inspection for ${agent_image}:${alias} failed without confirming that the alias is absent; no mutation was attempted."
    printf '%s\n' "${failure_message}" >&2
    exit 1
  fi
  kind="existing"

  if [[ -z "${app_before}" && -z "${agent_before}" ]]; then
    if [[ "${mode}" = stable && "${index}" -lt 2 ]]; then kind="new-immutable"; else kind="new-moving"; fi
  elif [[ -z "${app_before}" || -z "${agent_before}" ]]; then
    if [[ ( -n "${app_before}" && "${app_before}" != "${app_target}" ) \
          || ( -n "${agent_before}" && "${agent_before}" != "${agent_target}" ) ]]; then
      failure_message="Alias ${alias} is already an unrecognized partial pair; no mutation was attempted."
      printf '%s\n' "${failure_message}" >&2
      exit 1
    fi
    kind="partial-new-recovery"
  else
    if verify_attested_pair "${app_before}" "${agent_before}" >/dev/null; then
      kind="existing-attested"
    else
      prior_revision="$(resolve_pair_revision "${app_before}" "${agent_before}")"
      if allow_legacy_pair "${alias}" "${app_before}" "${agent_before}" "${prior_revision}"; then
        kind="legacy-unattested"
      else
        failure_message="Prior alias ${alias} lacks required provenance and does not match the one-time legacy bootstrap policy."
        printf '%s\n' "${failure_message}" >&2
        exit 1
      fi
    fi
    if [[ "${mode}" = stable && "${index}" -lt 2 \
          && ( "${app_before}" != "${app_target}" || "${agent_before}" != "${agent_target}" ) ]]; then
      failure_message="Immutable release alias ${alias} already exists at a different attested pair."
      printf '%s\n' "${failure_message}" >&2
      exit 1
    fi
  fi

  prior_app[index]="${app_before}"
  prior_agent[index]="${agent_before}"
  prior_kind[index]="${kind}"
  jq -c -n \
    --arg alias "${alias}" \
    --arg kind "${kind}" \
    --arg appPrior "${app_before}" \
    --arg agentPrior "${agent_before}" \
    --arg appTarget "${app_target}" \
    --arg agentTarget "${agent_target}" \
    '{
      alias: $alias,
      prior: {
        kind: $kind,
        appDigest: (if $appPrior == "" then null else $appPrior end),
        agentDigest: (if $agentPrior == "" then null else $agentPrior end)
      },
      target: {
        appDigest: $appTarget,
        agentDigest: $agentTarget
      }
    }' >> "${records_path}"
done

reconcile_range() {
  local first="$1"
  local last="$2"
  local attempt index image digest alias current settled
  for attempt in 1 2 3; do
    for ((index = first; index <= last; index += 1)); do
      alias="${aliases[index]}"
      for component in app agent; do
        if [[ "${component}" = app ]]; then
          image="${app_image}"
          digest="${app_target}"
        else
          image="${agent_image}"
          digest="${agent_target}"
        fi
        if ! current="$(resolve_digest "${image}" "${alias}")"; then
          printf 'Alias inspection failed for %s:%s during reconciliation attempt %d/3.\n' \
            "${image}" "${alias}" "${attempt}" >&2
          return 1
        fi
        if [[ "${current}" != "${digest}" ]]; then
          docker buildx imagetools create \
            --tag "${image}:${alias}" \
            "${image}@${digest}" || true
        fi
      done
    done

    settled=true
    for ((index = first; index <= last; index += 1)); do
      alias="${aliases[index]}"
      if ! app_current="$(resolve_digest "${app_image}" "${alias}")"; then
        printf 'App alias inspection failed for %s during reconciliation attempt %d/3.\n' \
          "${alias}" "${attempt}" >&2
        return 1
      fi
      if ! agent_current="$(resolve_digest "${agent_image}" "${alias}")"; then
        printf 'Agent alias inspection failed for %s during reconciliation attempt %d/3.\n' \
          "${alias}" "${attempt}" >&2
        return 1
      fi
      if [[ "${app_current}" != "${app_target}" || "${agent_current}" != "${agent_target}" ]]; then
        printf 'Alias %s is app=%s agent=%s, expected app=%s agent=%s (attempt %d/3).\n' \
          "${alias}" "${app_current:-missing}" "${agent_current:-missing}" \
          "${app_target}" "${agent_target}" "${attempt}" >&2
        settled=false
      fi
    done
    if [[ "${settled}" = true ]]; then
      return 0
    fi
    sleep "$((attempt * 2))"
  done
  return 1
}

rollback_changed_aliases() {
  local attempt index alias current expected settled partial retained inspection_failed
  partial=false
  for attempt in 1 2 3; do
    inspection_failed=false
    for index in "${!aliases[@]}"; do
      alias="${aliases[index]}"
      if [[ -n "${prior_app[index]}" ]]; then
        if ! current="$(resolve_digest "${app_image}" "${alias}")"; then
          inspection_failed=true
          continue
        fi
        expected="${prior_app[index]}"
        if [[ "${current}" != "${expected}" ]]; then
          docker buildx imagetools create \
            --tag "${app_image}:${alias}" \
            "${app_image}@${expected}" || true
        fi
      fi
      if [[ -n "${prior_agent[index]}" ]]; then
        if ! current="$(resolve_digest "${agent_image}" "${alias}")"; then
          inspection_failed=true
          continue
        fi
        expected="${prior_agent[index]}"
        if [[ "${current}" != "${expected}" ]]; then
          docker buildx imagetools create \
            --tag "${agent_image}:${alias}" \
            "${agent_image}@${expected}" || true
        fi
      fi
    done
    if [[ "${inspection_failed}" = true ]]; then
      sleep "$((attempt * 2))"
      continue
    fi

    settled=true
    partial=false
    retained=false
    for index in "${!aliases[@]}"; do
      alias="${aliases[index]}"
      if ! app_current="$(resolve_digest "${app_image}" "${alias}")"; then
        settled=false
        inspection_failed=true
        continue
      fi
      if ! agent_current="$(resolve_digest "${agent_image}" "${alias}")"; then
        settled=false
        inspection_failed=true
        continue
      fi
      if [[ -n "${prior_app[index]}" && "${app_current}" != "${prior_app[index]}" ]]; then
        settled=false
      elif [[ -z "${prior_app[index]}" && -n "${app_current}" \
              && "${app_current}" != "${app_target}" ]]; then
        settled=false
      fi
      if [[ -n "${prior_agent[index]}" && "${agent_current}" != "${prior_agent[index]}" ]]; then
        settled=false
      elif [[ -z "${prior_agent[index]}" && -n "${agent_current}" \
              && "${agent_current}" != "${agent_target}" ]]; then
        settled=false
      fi
      if [[ -z "${prior_app[index]}" && -z "${prior_agent[index]}" \
            && ( -n "${app_current}" || -n "${agent_current}" ) \
            && ( "${app_current}" != "${app_target}" || "${agent_current}" != "${agent_target}" ) ]]; then
        partial=true
      elif [[ "${prior_kind[index]:-}" = partial-new-recovery \
              && ( "${app_current}" != "${app_target}" || "${agent_current}" != "${agent_target}" ) ]]; then
        partial=true
      elif [[ -z "${prior_app[index]}" && -z "${prior_agent[index]}" \
              && "${app_current}" = "${app_target}" && "${agent_current}" = "${agent_target}" ]]; then
        retained=true
      elif [[ "${prior_kind[index]:-}" = partial-new-recovery \
              && "${app_current}" = "${app_target}" && "${agent_current}" = "${agent_target}" ]]; then
        retained=true
      fi
    done
    if [[ "${settled}" = true && "${inspection_failed}" = false ]]; then
      if [[ "${partial}" = true ]]; then
        rollback_status="partial-blocked"
      elif [[ "${retained}" = true ]]; then
        rollback_status="verified-with-retained-new-pair"
      else
        rollback_status="verified"
      fi
      return 0
    fi
    sleep "$((attempt * 2))"
  done
  rollback_status="failed"
  return 1
}

mutation_failed=false
if [[ "${mode}" = stable ]]; then
  # Exact release aliases settle first. A partial exact pair blocks the run
  # before either mutable stable alias is touched.
  if ! reconcile_range 0 1; then
    mutation_failed=true
  elif ! reconcile_range 2 2; then
    mutation_failed=true
  elif ! reconcile_range 3 3; then
    mutation_failed=true
  fi
elif ! reconcile_range 0 0; then
  mutation_failed=true
fi

if [[ "${mutation_failed}" = true ]]; then
  failure_message="The app and agent aliases did not reconcile to the attested target pair."
  if rollback_changed_aliases; then
    if [[ "${rollback_status}" = partial-blocked ]]; then
      status="partial-blocked"
    elif [[ "${rollback_status}" = verified-with-retained-new-pair ]]; then
      status="failed-retained-new-pair"
    else
      status="failed-rolled-back"
    fi
  else
    status="rollback-failed"
  fi
  write_evidence
  printf '%s Rollback status: %s.\n' "${failure_message}" "${rollback_status}" >&2
  exit 1
fi

status="final-verification-pending"
rollback_status="not-required"
write_evidence
if [[ "${evidence_inspection_complete}" != true \
      || "${evidence_target_pair_verified}" != true ]]; then
  status="final-verification-failed"
  rollback_status="not-attempted-final-verification-failed"
  failure_message="Final registry inspection did not prove every alias at the attested target pair; public state is ambiguous and no further mutation was attempted."
  rewrite_evidence_outcome
  printf '%s\n' "${failure_message}" >&2
  exit 1
fi
status="succeeded"
rewrite_evidence_outcome
printf 'All aliases reconciled to the attested app/agent pair at revision %s.\n' \
  "${target_revision}"
