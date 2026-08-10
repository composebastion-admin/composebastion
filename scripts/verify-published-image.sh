#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 6 ]]; then
  printf 'Usage: bash scripts/verify-published-image.sh <app|agent> <amd64|arm64> <image@sha256:digest> <version> <revision> <created>\n' >&2
  exit 2
fi

component="$1"
architecture="$2"
image_reference="$3"
expected_version="$4"
expected_revision="$5"
expected_created="$6"

case "${component}" in
  app)
    expected_title="ComposeBastion"
    ;;
  agent)
    expected_title="ComposeBastion Agent"
    ;;
  *)
    printf 'Unsupported image component: %s\n' "${component}" >&2
    exit 2
    ;;
esac
case "${architecture}" in
  amd64|arm64)
    ;;
  *)
    printf 'Unsupported image architecture: %s\n' "${architecture}" >&2
    exit 2
    ;;
esac
if [[ ! "${image_reference}" =~ @sha256:[a-f0-9]{64}$ ]]; then
  printf 'Image reference must be digest-qualified: %s\n' "${image_reference}" >&2
  exit 2
fi
if [[ ! "${expected_revision}" =~ ^[a-f0-9]{40}$ ]]; then
  printf 'Expected revision must be a full 40-character commit SHA.\n' >&2
  exit 2
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repository_root}"

legal_directory="$(mktemp -d)"
container_id=""
cleanup() {
  if [[ -n "${container_id}" ]]; then
    docker rm -f "${container_id}" >/dev/null 2>&1 || true
  fi
  rm -rf "${legal_directory}"
}
trap cleanup EXIT

docker pull --platform "linux/${architecture}" "${image_reference}"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.title" }}' "${image_reference}")" = "${expected_title}"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.url" }}' "${image_reference}")" = "https://github.com/composebastion-admin/composebastion"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.source" }}' "${image_reference}")" = "https://github.com/composebastion-admin/composebastion"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.vendor" }}' "${image_reference}")" = "ComposeBastion Admin"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.licenses" }}' "${image_reference}")" = "LicenseRef-ComposeBastion-SourceAvailable-PrivateUse-1.0"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "${image_reference}")" = "${expected_version}"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${image_reference}")" = "${expected_revision}"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.created" }}' "${image_reference}")" = "${expected_created}"

container_id="$(docker create "${image_reference}")"
docker cp "${container_id}:/licenses/." "${legal_directory}/"
for artifact in \
  LICENSE.md \
  LICENSING_SUMMARY.md \
  COMMERCIAL-LICENSE.md \
  NOTICE.md \
  THIRD-PARTY-NOTICES.md \
  TRADEMARKS.md; do
  cmp "${artifact}" "${legal_directory}/${artifact}"
done
cmp LICENSES/go-modules/manifest.json "${legal_directory}/LICENSES/go-modules/manifest.json"
cmp LICENSES/go-modules/manifest.json "${legal_directory}/third-party/go-modules/manifest.json"

if [[ "${component}" = app ]]; then
  required_third_party=(
    trivy-LICENSE.txt
    trivy-NOTICE.txt
    oras-go-LICENSE.txt
    rclone-LICENSE.txt
    go-LICENSE.txt
    go-PATENTS.txt
    go-buildinfo/trivy.modules.tsv
    go-buildinfo/trivy.artifacts.sha256
    go-buildinfo/rclone.modules.tsv
    go-buildinfo/rclone.artifacts.sha256
  )
  checksum_manifests=(
    go-buildinfo/trivy.artifacts.sha256
    go-buildinfo/rclone.artifacts.sha256
  )
else
  required_third_party=(
    docker-cli-LICENSE.txt
    docker-cli-NOTICE.txt
    docker-compose-LICENSE.txt
    docker-compose-NOTICE.txt
    go-LICENSE.txt
    go-PATENTS.txt
    go-buildinfo/docker-cli.modules.tsv
    go-buildinfo/docker-compose.modules.tsv
    go-buildinfo/agent.artifacts.sha256
  )
  checksum_manifests=(
    go-buildinfo/agent.artifacts.sha256
  )
fi
for artifact in "${required_third_party[@]}"; do
  test -s "${legal_directory}/third-party/${artifact}"
done
(
  cd "${legal_directory}/third-party"
  for checksum_manifest in "${checksum_manifests[@]}"; do
    sha256sum -c "${checksum_manifest}"
  done
)

printf 'Verified %s linux/%s labels and final-rootfs legal artifacts at %s.\n' \
  "${component}" "${architecture}" "${image_reference}"
