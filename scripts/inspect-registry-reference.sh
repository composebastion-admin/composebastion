#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 2 ]]; then
  printf 'Usage: %s buildx REFERENCE | %s skopeo AUTHFILE REFERENCE\n' "$0" "$0" >&2
  exit 64
fi

mode="$1"
case "${mode}" in
  buildx)
    if [[ "$#" -ne 2 ]]; then
      printf 'buildx inspection requires exactly one reference.\n' >&2
      exit 64
    fi
    reference="$2"
    ;;
  skopeo)
    if [[ "$#" -ne 3 ]]; then
      printf 'skopeo inspection requires an auth file and one reference.\n' >&2
      exit 64
    fi
    authfile="$2"
    reference="$3"
    ;;
  *)
    printf 'Inspection mode must be buildx or skopeo, got %s.\n' "${mode}" >&2
    exit 64
    ;;
esac

inspection_root="$(mktemp -d)"
inspection_stdout="${inspection_root}/stdout"
inspection_stderr="${inspection_root}/stderr"
# Invoked indirectly by the EXIT trap.
# shellcheck disable=SC2329
cleanup() {
  rm -rf "${inspection_root}"
}
trap cleanup EXIT

set +e
if [[ "${mode}" = buildx ]]; then
  docker buildx imagetools inspect "${reference}" \
    --format '{{json .Manifest}}' \
    >"${inspection_stdout}" 2>"${inspection_stderr}"
else
  skopeo inspect \
    --authfile "${authfile}" \
    --format '{{.Digest}}' \
    "docker://${reference}" \
    >"${inspection_stdout}" 2>"${inspection_stderr}"
fi
inspection_status=$?
set -e

if [[ "${inspection_status}" -eq 0 ]]; then
  if [[ "${mode}" = buildx ]]; then
    digest="$(jq -er '.digest | select(test("^sha256:[a-f0-9]{64}$"))' "${inspection_stdout}")" || {
      printf 'Registry inspection succeeded but returned no valid manifest digest for %s.\n' "${reference}" >&2
      exit 2
    }
  else
    digest="$(tr -d '\r\n' < "${inspection_stdout}")"
    if [[ ! "${digest}" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      printf 'Registry inspection succeeded but returned no valid manifest digest for %s.\n' "${reference}" >&2
      exit 2
    fi
  fi
  printf '%s\n' "${digest}"
  exit 0
fi

if grep -Fqx "ERROR: ${reference}: not found" "${inspection_stderr}" \
    || grep -Eiq '(^|[^[:alpha:]])(manifest|name)[ _-]?unknown([^[:alpha:]]|$)' "${inspection_stderr}"; then
  exit 3
fi

printf 'Registry inspection failed without a confirmed not-found response for %s:\n' "${reference}" >&2
sed -E \
  -e 's#(https?://)[^/@[:space:]]+@#\1[redacted]@#g' \
  -e 's#([Aa]uthorization:)[[:space:]]*[^[:space:]]+#\1 [redacted]#g' \
  "${inspection_stderr}" >&2
exit 2
