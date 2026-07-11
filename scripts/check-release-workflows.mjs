import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflowFiles = [
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/container-scan.yml",
  ".github/workflows/dependency-review.yml",
  ".github/workflows/publish-images.yml"
];
const failures = [];

function fail(message) {
  failures.push(message);
}

function loadWorkflow(file) {
  try {
    return parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${file}: invalid YAML (${error instanceof Error ? error.message : String(error)})`);
    return {};
  }
}

const workflows = Object.fromEntries(workflowFiles.map((file) => [file, loadWorkflow(file)]));
for (const [file, workflow] of Object.entries(workflows)) {
  const pullRequest = workflow?.on?.pull_request;
  if (pullRequest && typeof pullRequest === "object" && "paths" in pullRequest) {
    fail(`${file}: required pull-request workflows must not use path filters`);
  }

  for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact@") && step.with?.overwrite !== true) {
        fail(`${file}:${jobName}: upload-artifact must set overwrite: true so a rerun cannot retain stale archives`);
      }
    }
  }
}

const codeqlFile = ".github/workflows/codeql.yml";
const codeqlConcurrency = workflows[codeqlFile]?.concurrency ?? {};
const codeqlGroup = String(codeqlConcurrency.group ?? "");
const codeqlCancellation = String(codeqlConcurrency["cancel-in-progress"] ?? "");
if (codeqlGroup !== "codeql-${{ github.event_name }}-${{ github.ref }}") {
  fail(`${codeqlFile}: concurrency groups must separate event types and refs`);
}
if (codeqlCancellation !== "${{ github.event_name == 'pull_request' }}") {
  fail(`${codeqlFile}: only pull-request CodeQL runs may cancel an in-progress run`);
}

const expectedMatrix = [
  "agent:amd64:linux/amd64:Dockerfile.agent",
  "agent:arm64:linux/arm64:Dockerfile.agent",
  "app:amd64:linux/amd64:Dockerfile",
  "app:arm64:linux/arm64:Dockerfile"
];

function matrixEntries(job) {
  return (job?.strategy?.matrix?.include ?? [])
    .map((entry) => `${entry.component}:${entry.arch}:${entry.platform}:${entry.dockerfile}`)
    .sort();
}

function requireExactMatrix(file, jobName, job) {
  const actual = matrixEntries(job);
  if (JSON.stringify(actual) !== JSON.stringify(expectedMatrix)) {
    fail(`${file}:${jobName}: expected exact app/agent amd64/arm64 matrix, got ${JSON.stringify(actual)}`);
  }
}

function requireExactTagRescanMatrix(file, jobName, job) {
  const actual = (job?.strategy?.matrix?.include ?? [])
    .map((entry) => `${entry.component}:${entry.arch}`)
    .sort();
  const expected = ["agent:amd64", "agent:arm64", "app:amd64", "app:arm64"];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${file}:${jobName}: expected four tagged platform rescans, got ${JSON.stringify(actual)}`);
  }
}

function actionStep(job, action) {
  return (job?.steps ?? []).find((step) => typeof step.uses === "string" && step.uses.startsWith(`${action}@`));
}

function requireNode24Setup(file, jobName, job) {
  const step = actionStep(job, "actions/setup-node");
  if (!step) {
    fail(`${file}:${jobName}: repository Node scripts require an explicit setup-node step`);
    return;
  }
  if (String(step.with?.["node-version"] ?? "") !== "24") {
    fail(`${file}:${jobName}: repository Node scripts must run with Node 24`);
  }
}

const ciFile = ".github/workflows/ci.yml";
const ciJobs = workflows[ciFile]?.jobs ?? {};
const liveAcceptance = ciJobs["live-acceptance"];
const ciGate = ciJobs["ci-gate"];
requireNode24Setup(ciFile, "live-acceptance", liveAcceptance);
const installBrowser = (liveAcceptance?.steps ?? []).find((step) => String(step.run ?? "").includes("playwright install --with-deps chromium"));
if (!installBrowser) fail(`${ciFile}:live-acceptance: live Playwright requires an explicit Chromium installation`);
if (!(liveAcceptance?.steps ?? []).some((step) => String(step.run ?? "").trim() === "npm run acceptance:local")
    || !(liveAcceptance?.steps ?? []).some((step) => String(step.run ?? "").includes("acceptance:assert-report"))) {
  fail(`${ciFile}:live-acceptance: full release acceptance and its qualifying-report assertion are both required`);
}
const ciGateNeeds = Array.isArray(ciGate?.needs) ? ciGate.needs : [ciGate?.needs].filter(Boolean);
for (const dependency of ["browser-smoke", "live-acceptance"]) {
  if (!ciGateNeeds.includes(dependency)) fail(`${ciFile}:ci-gate: aggregate must require ${dependency}`);
}

function requireExactGitBuildContext(file, jobName, job, buildStep) {
  const steps = job?.steps ?? [];
  const materializeIndex = steps.findIndex((step) => step.name === "Materialize exact Git build context");
  const buildIndex = steps.indexOf(buildStep);
  const materializeRun = String(steps[materializeIndex]?.run ?? "");
  if (!materializeRun.includes("scripts/materialize-git-context.mjs")
      || !materializeRun.includes("/tmp/composebastion-git-context")
      || !materializeRun.includes("GITHUB_SHA")) {
    fail(`${file}:${jobName}: exact Git context materialization is missing or not bound to GITHUB_SHA`);
  }
  if (buildStep?.with?.context !== "/tmp/composebastion-git-context"
      || buildStep?.with?.file !== "/tmp/composebastion-git-context/${{ matrix.dockerfile }}") {
    fail(`${file}:${jobName}: matrix builds must use the materialized exact Git context and its Dockerfile`);
  }
  if (materializeIndex < 0 || buildIndex <= materializeIndex) {
    fail(`${file}:${jobName}: exact Git context must be materialized before the image build`);
  }
}

function requireTrivy(file, jobName, job) {
  const step = actionStep(job, "aquasecurity/trivy-action");
  if (!step) {
    fail(`${file}:${jobName}: missing Trivy scan`);
    return;
  }
  if (step.with?.version !== "v0.72.0") fail(`${file}:${jobName}: Trivy must be v0.72.0`);
  if (String(step.with?.["exit-code"]) !== "1") fail(`${file}:${jobName}: Trivy must fail the job on findings`);
  if (String(step.with?.["ignore-unfixed"]) !== "false") fail(`${file}:${jobName}: unfixed findings must not be ignored`);
  if (step.with?.severity !== "HIGH,CRITICAL") fail(`${file}:${jobName}: scan severity must be HIGH,CRITICAL`);
  if (step.with?.trivyignores !== ".trivyignore.yaml") fail(`${file}:${jobName}: scans must use the path- and PURL-scoped Trivy ignore file`);
  if ("ignore-policy" in (step.with ?? {})) fail(`${file}:${jobName}: finding-only Rego policy cannot scope exceptions to an image target`);
}

const publishFile = ".github/workflows/publish-images.yml";
const publish = workflows[publishFile];
const publishJobs = publish?.jobs ?? {};
requireNode24Setup(publishFile, "metadata", publishJobs.metadata);
const buildScan = publishJobs["build-scan"];
requireNode24Setup(publishFile, "build-scan", buildScan);
requireExactMatrix(publishFile, "build-scan", buildScan);
requireTrivy(publishFile, "build-scan", buildScan);

const buildStep = actionStep(buildScan, "docker/build-push-action");
if (!buildStep) fail(`${publishFile}:build-scan: missing Buildx build action`);
requireExactGitBuildContext(publishFile, "build-scan", buildScan, buildStep);
if (buildStep?.with?.push !== false) fail(`${publishFile}:build-scan: release archives must not push during build`);
if (buildStep?.with?.provenance !== false || buildStep?.with?.sbom !== false) {
  fail(`${publishFile}:build-scan: release OCI archives must contain one image manifest without nested attestations`);
}
if (!String(buildStep?.with?.outputs ?? "").includes("type=oci")) fail(`${publishFile}:build-scan: build output must be an OCI archive`);
for (const buildArg of ["APP_VERSION=", "VCS_REF=", "BUILD_DATE="]) {
  if (!String(buildStep?.with?.["build-args"] ?? "").includes(buildArg)) {
    fail(`${publishFile}:build-scan: missing deterministic ${buildArg.slice(0, -1)} build argument`);
  }
}
const buildSteps = buildScan?.steps ?? [];
const releaseScanStep = actionStep(buildScan, "aquasecurity/trivy-action");
const expectedLayout = "/tmp/release-${{ matrix.component }}-${{ matrix.arch }}-oci";
if (releaseScanStep?.with?.["scan-type"] !== "image" || releaseScanStep?.with?.input !== expectedLayout) {
  fail(`${publishFile}:build-scan: Trivy must scan the fresh OCI layout extracted from the exact release archive`);
}
const buildIndex = buildSteps.indexOf(buildStep);
const scanIndex = buildSteps.indexOf(releaseScanStep);
const verificationIndex = buildSteps.findIndex((step) => step.name === "Verify archive, extract the exact OCI layout, and record digests");
const verificationRun = buildSteps[verificationIndex]?.run ?? "";
for (const invariant of [
  'archive="/tmp/release-${{ matrix.component }}-${{ matrix.arch }}.tar"',
  'layout="/tmp/release-${{ matrix.component }}-${{ matrix.arch }}-oci"',
  'archive_sha="$(sha256sum "${archive}"',
  'rm -rf "${layout}"',
  'tar -xf "${archive}" -C "${layout}"',
  'test -f "${layout}/oci-layout"',
  'test -f "${layout}/index.json"'
]) {
  if (!verificationRun.includes(invariant)) {
    fail(`${publishFile}:build-scan: archive verification/extraction is missing ${invariant}`);
  }
}
for (const invariant of [
  '[[ "${manifest_digest}" =~ ^sha256:[a-f0-9]{64}$ ]]',
  'manifest_json="$(tar -xOf "${archive}" "${manifest_blob}")"',
  '[[ "${config_digest}" =~ ^sha256:[a-f0-9]{64}$ ]]',
  "mapfile -t layer_digests",
  'test "${#layer_digests[@]}" -gt 0',
  '[[ "${layer_digest}" =~ ^sha256:[a-f0-9]{64}$ ]]'
]) {
  if (!verificationRun.includes(invariant)) {
    fail(`${publishFile}:build-scan: archive blob-integrity verification is missing ${invariant}`);
  }
}
if ((verificationRun.match(/sha256sum/g) ?? []).length < 4) {
  fail(`${publishFile}:build-scan: archive, manifest, config, and every layer must be independently SHA-256 verified`);
}
const uploadIndex = buildSteps.indexOf(actionStep(buildScan, "actions/upload-artifact"));
if (buildIndex < 0 || verificationIndex <= buildIndex || scanIndex <= verificationIndex || uploadIndex <= scanIndex) {
  fail(`${publishFile}:build-scan: build, verify/extract, scan, and upload must remain strictly ordered`);
}

const tagRescan = publishJobs["rescan-tag-images"];
requireExactTagRescanMatrix(publishFile, "rescan-tag-images", tagRescan);
requireTrivy(publishFile, "rescan-tag-images", tagRescan);
if (actionStep(tagRescan, "docker/build-push-action")) fail(`${publishFile}:rescan-tag-images: stable tags must rescan existing SHA images without rebuilding`);
if (!actionStep(tagRescan, "docker/setup-buildx-action")) fail(`${publishFile}:rescan-tag-images: missing Buildx setup`);
if (!actionStep(tagRescan, "docker/login-action")) fail(`${publishFile}:rescan-tag-images: missing authenticated registry read`);
const tagRescanSteps = tagRescan?.steps ?? [];
const resolveDigestRun = tagRescanSteps.find((step) => step.name === "Resolve the protected-commit platform digest")?.run ?? "";
for (const invariant of [
  'index_reference="${image}@${index_digest}"',
  'docker buildx imagetools inspect --raw "${index_reference}"',
  'echo "index_digest=${index_digest}"',
  'echo "platform_digest=${digest}"'
]) {
  if (!resolveDigestRun.includes(invariant)) {
    fail(`${publishFile}:rescan-tag-images: digest resolution must preserve ${invariant}`);
  }
}
const tagScanIndex = tagRescanSteps.indexOf(actionStep(tagRescan, "aquasecurity/trivy-action"));
const tagRecordIndex = tagRescanSteps.findIndex((step) => step.name === "Record the exact passing index and platform digests");
const tagUploadStep = actionStep(tagRescan, "actions/upload-artifact");
const tagUploadIndex = tagRescanSteps.indexOf(tagUploadStep);
if (tagScanIndex < 0 || tagRecordIndex <= tagScanIndex || tagUploadIndex <= tagRecordIndex) {
  fail(`${publishFile}:rescan-tag-images: persist and upload digest evidence only after the exact platform scan passes`);
}
const tagRecordRun = tagRescanSteps[tagRecordIndex]?.run ?? "";
for (const invariant of ["indexDigest:$indexDigest", "platformDigest:$platformDigest", 'tag-rescan-${{ matrix.component }}-${{ matrix.arch }}.json']) {
  if (!tagRecordRun.includes(invariant)) fail(`${publishFile}:rescan-tag-images: digest record is missing ${invariant}`);
}
if (tagUploadStep?.with?.name !== "tag-rescan-${{ matrix.component }}-${{ matrix.arch }}"
    || !String(tagUploadStep?.with?.path ?? "").includes("tag-rescan-${{ matrix.component }}-${{ matrix.arch }}.json")) {
  fail(`${publishFile}:rescan-tag-images: each passing platform scan must upload its exact digest record`);
}

const releaseGate = publishJobs["release-image-gate"];
if (releaseGate?.name !== "Release image security gate") fail(`${publishFile}: release aggregate check name changed`);
if (!String(releaseGate?.if ?? "").includes("always()")) fail(`${publishFile}: release aggregate gate must run even after failures or skips`);
for (const dependency of ["metadata", "build-scan", "rescan-tag-images"]) {
  if (!(releaseGate?.needs ?? []).includes(dependency)) fail(`${publishFile}: release aggregate gate must require ${dependency}`);
}
for (const [jobName, dependency] of [["publish-main", "release-image-gate"], ["promote-tag", "release-image-gate"]]) {
  if (!(publishJobs[jobName]?.needs ?? []).includes(dependency)) fail(`${publishFile}:${jobName}: must depend on ${dependency}`);
}

if (!String(publish?.concurrency?.group ?? "").includes("publish-images-publication")) {
  fail(`${publishFile}: main and tag registry mutations must share one concurrency group`);
}
const copyRun = (publishJobs["publish-main"]?.steps ?? []).find((step) => step.name === "Copy the scanned platform manifests")?.run ?? "";
if (!copyRun.includes('platform_tag="run-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${arch}"')) {
  fail(`${publishFile}:publish-main: platform images must use immutable run-scoped tags`);
}
const assembleRun = (publishJobs["publish-main"]?.steps ?? []).find((step) => step.name === "Assemble and verify both immutable indexes")?.run ?? "";
if (!assembleRun.includes('index="${image}:sha-${GITHUB_SHA}"')) {
  fail(`${publishFile}:publish-main: multi-architecture indexes must use the protected commit SHA tag`);
}
for (const arch of ["amd64", "arm64"]) {
  if (!assembleRun.includes(`\${image}:run-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}-${arch}`)) {
    fail(`${publishFile}:publish-main: ${arch} index source must be the current run-scoped tag`);
  }
}
for (const invariant of [
  'index_digest="$(jq -er',
  'docker buildx imagetools inspect --raw "${image}@${index_digest}"',
  'echo "${component}_digest=${index_digest}"'
]) {
  if (!assembleRun.includes(invariant)) fail(`${publishFile}:publish-main: verified index binding is missing ${invariant}`);
}
const mainAliasStep = (publishJobs["publish-main"]?.steps ?? []).find((step) => step.name === "Apply main aliases after both immutable indexes exist");
const mainAliasRun = mainAliasStep?.run ?? "";
if (mainAliasRun.includes(":latest")) fail(`${publishFile}:publish-main: an untagged main commit must not move latest`);
if (!mainAliasRun.includes('"${image}@${digest}"')
    || mainAliasRun.includes('"${image}:sha-${GITHUB_SHA}"')
    || mainAliasStep?.env?.APP_INDEX_DIGEST !== "${{ steps.indexes.outputs.app_digest }}"
    || mainAliasStep?.env?.AGENT_INDEX_DIGEST !== "${{ steps.indexes.outputs.agent_digest }}") {
  fail(`${publishFile}:publish-main: main aliases must use the just-verified digest-qualified index sources`);
}
const promoteTag = publishJobs["promote-tag"];
const promoteDownload = actionStep(promoteTag, "actions/download-artifact");
if (promoteDownload?.with?.pattern !== "tag-rescan-*"
    || promoteDownload?.with?.["merge-multiple"] !== true
    || promoteDownload?.with?.path !== "/tmp/tag-rescans") {
  fail(`${publishFile}:promote-tag: promotion must download only the four passing tag-rescan digest records`);
}
const promotionVerification = (promoteTag?.steps ?? []).find((step) => step.name === "Verify both immutable indexes before promotion")?.run ?? "";
for (const invariant of [
  'test "${#records[@]}" = 4',
  '"${image}:sha-${GITHUB_SHA}"',
  'test "${current}" = "${expected}"',
  'echo "${component}_digest=${expected}"'
]) {
  if (!promotionVerification.includes(invariant)) {
    fail(`${publishFile}:promote-tag: promotion digest verification is missing ${invariant}`);
  }
}
if (!promotionVerification.includes("indexDigest") || !promotionVerification.includes("platformDigest")) {
  fail(`${publishFile}:promote-tag: all four records must validate both index and platform digests`);
}
const stableAliasStep = (promoteTag?.steps ?? []).find((step) => step.name === "Apply stable aliases after all scans pass");
const stableAliasRun = stableAliasStep?.run ?? "";
if (!stableAliasRun.includes('"${image}:latest"')) fail(`${publishFile}:promote-tag: verified stable tags must move latest`);
if (!stableAliasRun.includes('source="${image}@${digest}"')
    || stableAliasRun.includes('source="${image}:sha-${GITHUB_SHA}"')
    || stableAliasStep?.env?.APP_INDEX_DIGEST !== "${{ steps.images.outputs.app_digest }}"
    || stableAliasStep?.env?.AGENT_INDEX_DIGEST !== "${{ steps.images.outputs.agent_digest }}") {
  fail(`${publishFile}:promote-tag: every stable alias must use the revalidated digest-qualified index source`);
}

const scanFile = ".github/workflows/container-scan.yml";
const scan = workflows[scanFile];
const imageScan = scan?.jobs?.["image-scan"];
requireNode24Setup(scanFile, "image-scan", imageScan);
requireExactMatrix(scanFile, "image-scan", imageScan);
requireTrivy(scanFile, "image-scan", imageScan);
requireExactGitBuildContext(scanFile, "image-scan", imageScan, actionStep(imageScan, "docker/build-push-action"));
const containerGate = scan?.jobs?.["container-scan-gate"];
if (containerGate?.name !== "Container scan gate") fail(`${scanFile}: aggregate check name changed`);
if (!String(containerGate?.if ?? "").includes("always()")) fail(`${scanFile}: aggregate gate must run after scan failure or cancellation`);

const trivyIgnoreSource = readFileSync(".trivyignore.yaml", "utf8");
const trivyIgnore = parse(trivyIgnoreSource);
if (trivyIgnoreSource.includes("CVE-2026-50151")) fail(".trivyignore.yaml: CVE-2026-50151 must not be suppressed");
const allowedPolicyCves = ["CVE-2026-34040", "CVE-2026-41567", "CVE-2026-42306"];
const ignoreEntries = trivyIgnore?.vulnerabilities ?? [];
const policyCves = ignoreEntries.map((entry) => entry?.id);
if (JSON.stringify(policyCves.sort()) !== JSON.stringify([...allowedPolicyCves].sort())) {
  fail(`.trivyignore.yaml: only the three reviewed daemon-only exceptions are allowed, got ${JSON.stringify(policyCves)}`);
}
for (const cve of allowedPolicyCves) {
  const entry = ignoreEntries.find((candidate) => candidate?.id === cve);
  if (JSON.stringify(entry?.paths) !== JSON.stringify(["usr/local/lib/docker/cli-plugins/docker-compose"])
      || JSON.stringify(entry?.purls) !== JSON.stringify(["pkg:golang/github.com/docker/docker@v28.5.2%2Bincompatible"])
      || !String(entry?.statement ?? "").includes("pkg/namesgenerator")) {
    fail(`.trivyignore.yaml: ${cve} must be scoped to the exact Compose target, Docker module PURL, and reachability statement`);
  }
}
const releaseImageVerifier = readFileSync("scripts/verify-release-images.mjs", "utf8");
if (!releaseImageVerifier.includes('"--ignorefile", "/workspace/.trivyignore.yaml"') || releaseImageVerifier.includes("--ignore-policy")) {
  fail("scripts/verify-release-images.mjs: local release scans must use the path- and PURL-scoped YAML ignore file");
}
for (const invariant of ["materializeGitBuildContext", "assertSafeTestResultsPath", "GIT_NO_REPLACE_OBJECTS", "buildContextDirectory", "sourceContext.contextDigest", "digestGitBuildContext"]) {
  if (!releaseImageVerifier.includes(invariant)) {
    fail(`scripts/verify-release-images.mjs: exact Git build-context verification is missing ${invariant}`);
  }
}
const appDockerfile = readFileSync("Dockerfile", "utf8");
const agentDockerfile = readFileSync("Dockerfile.agent", "utf8");
const nodeBase = "node:24-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a";
const goBuilder = "golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2";

function requirePinnedExternalImages(file, dockerfile) {
  const stageAliases = new Set(
    [...dockerfile.matchAll(/^FROM(?: --platform=\S+)? \S+ AS (\S+)$/gim)].map((match) => match[1])
  );
  const references = [...dockerfile.matchAll(/^FROM(?: --platform=\S+)? (\S+)/gim)].map((match) => match[1]);
  for (const reference of references) {
    if (stageAliases.has(reference) || reference === "scratch") continue;
    if (!reference.includes("@sha256:")) fail(`${file}: external base image ${reference} must be digest-pinned`);
    if (reference.startsWith("node:") && reference !== nodeBase) fail(`${file}: unexpected Node base ${reference}`);
    if (reference.startsWith("golang:") && reference !== goBuilder) fail(`${file}: unexpected Go builder ${reference}`);
  }
}

requirePinnedExternalImages("Dockerfile", appDockerfile);
requirePinnedExternalImages("Dockerfile.agent", agentDockerfile);
if (!/^ARG TRIVY_VERSION=0\.72\.0$/m.test(appDockerfile)) fail("Dockerfile: embedded Trivy must be 0.72.0");
if (!/^ARG TRIVY_SOURCE_COMMIT=8a32853686209a428179bb3a1688802b25691564$/m.test(appDockerfile)
    || !/^ARG TRIVY_SOURCE_SHA256=5a922c388846d11345ce8283e4373be312458f002abc667c3cd1f77c43163725$/m.test(appDockerfile)) {
  fail("Dockerfile: embedded Trivy source must be pinned to the reviewed v0.72.0 commit and archive checksum");
}
if (!/^ARG TRIVY_ORAS_VERSION=v2\.6\.2$/m.test(appDockerfile)
    || !appDockerfile.includes('go get "oras.land/oras-go/v2@${TRIVY_ORAS_VERSION}"')
    || !appDockerfile.includes("go test oras.land/oras-go/v2/content/file -run '^Test_extractTarDirectory_HardLink$'")
    || !appDockerfile.includes(goBuilder)) {
  fail("Dockerfile: embedded Trivy must retain the reviewed ORAS and patched Go toolchain rebuild");
}
for (const [invariant, message] of [
  [nodeBase, "pinned multi-architecture Node base"],
  ["apk add --no-cache 'libcrypto3=3.5.7-r0' 'libssl3=3.5.7-r0'", "exact fixed Alpine OpenSSL packages"],
  ["ENV GOTOOLCHAIN=local", "local-only pinned Go toolchain"],
  ['echo "${TRIVY_SOURCE_SHA256}  /tmp/trivy-source.tar.gz" | sha256sum -c -', "Trivy source checksum verification"],
  ["go build -mod=readonly -buildvcs=false -trimpath", "read-only deterministic Trivy module build"],
  ['go version -m /out/trivy | grep -F "oras.land/oras-go/v2"', "embedded ORAS version verification"],
  ["ARG RCLONE_VERSION=1.74.4", "reviewed rclone version"],
  ["ARG RCLONE_SOURCE_COMMIT=5bc93a2a7ab0ebd0a11352bc4968eabeffb18027", "reviewed rclone source commit"],
  ["ARG RCLONE_SHA256_AMD64=fe435e0c36228e7c2f116a8701f01127bb1f694005fc11d1f27186c8bca4115d", "rclone amd64 checksum"],
  ["ARG RCLONE_SHA256_ARM64=97685285c9ad6a0cf17d5844115d2a67245af6444db672187074bd9c358de419", "rclone arm64 checksum"],
  ["ARG RCLONE_LICENSE_SHA256=8cd2e9e750b90a04b7d82dbbca3930c696ae0309d7c10464f90a44f45754cd04", "rclone license checksum"],
  ['echo "${rclone_sha256}  /tmp/rclone.zip" | sha256sum -c -', "architecture-specific rclone archive verification"],
  ['echo "${RCLONE_LICENSE_SHA256}  /tmp/rclone-LICENSE" | sha256sum -c -', "rclone license verification"],
  ["COPY --from=trivy-builder /out/licenses/ /licenses/third-party/", "Trivy/ORAS/Go licenses"],
  ["COPY --from=rclone-evidence /out/licenses/ /licenses/third-party/", "rclone license and linked-module evidence"],
  ["node -e \"Promise.all([import('@composebastion/shared'), import('semver')])\"", "runtime workspace dependency resolution check"],
  ["go-buildinfo/trivy.modules.tsv", "Trivy linked-module inventory"],
  ["go-buildinfo/rclone.modules.tsv", "rclone linked-module inventory"],
  ["go-buildinfo/trivy.artifacts.sha256", "Trivy legal-artifact checksums"],
  ["go-buildinfo/rclone.artifacts.sha256", "rclone legal-artifact checksums"],
  ['trivy --version | grep -F "Version: ${TRIVY_VERSION}"', "runtime Trivy version check"],
  ['rclone version | grep -F "rclone v${RCLONE_VERSION}"', "runtime rclone version check"]
]) {
  if (!appDockerfile.includes(invariant)) fail(`Dockerfile: missing ${message}`);
}
if (appDockerfile.includes("apk upgrade")) fail("Dockerfile: broad mutable runtime apk upgrades are forbidden; pin required security packages exactly");

for (const [pattern, message] of [
  [/^ARG DOCKER_CLI_VERSION=29\.6\.1$/m, "Docker CLI version"],
  [/^ARG DOCKER_CLI_SOURCE_COMMIT=8900f1d330cb39e93e16d780a26bff1d7e07ba03$/m, "Docker CLI source commit"],
  [/^ARG DOCKER_CLI_SOURCE_SHA256=41540b35a1157e76eb1a3c3e87dd196896a8e76b27c4bfcafb826dbc15b0acd9$/m, "Docker CLI source checksum"],
  [/^ARG COMPOSE_VERSION=5\.3\.1$/m, "Docker Compose version"],
  [/^ARG COMPOSE_SOURCE_COMMIT=f32009d4a2c687dd405398cc7975d12dccaf8dff$/m, "Docker Compose source commit"],
  [/^ARG COMPOSE_SOURCE_SHA256=34387f32377bffac7ee0a70d78435af3b59a075b6f29409172c6d6346ca0340d$/m, "Docker Compose source checksum"]
]) {
  if (!pattern.test(agentDockerfile)) fail(`Dockerfile.agent: missing reviewed ${message}`);
}
for (const [invariant, message] of [
  [nodeBase, "pinned multi-architecture Node base"],
  [goBuilder, "pinned multi-architecture Go builder"],
  ["ENV GOTOOLCHAIN=local", "local-only pinned Go toolchain"],
  ["apk add --no-cache 'libcrypto3=3.5.7-r0' 'libssl3=3.5.7-r0'", "exact fixed Alpine OpenSSL packages"],
  ['echo "${DOCKER_CLI_SOURCE_SHA256}  /tmp/docker-cli.tar.gz" | sha256sum -c -', "Docker CLI source checksum verification"],
  ['echo "${COMPOSE_SOURCE_SHA256}  /tmp/compose.tar.gz" | sha256sum -c -', "Docker Compose source checksum verification"],
  ["mkdir -p /go/src/github.com/docker/cli", "Docker CLI GOPATH source layout"],
  ["GO111MODULE=off CGO_ENABLED=0", "vendored GOPATH-mode Docker CLI build"],
  ["go build -buildvcs=false -trimpath", "deterministic Docker CLI build"],
  ["-o /out/docker github.com/docker/cli/cmd/docker", "Docker CLI package build target"],
  ["go build -mod=readonly -buildvcs=false -trimpath", "read-only deterministic Compose build"],
  ["go list -mod=readonly -tags \"e2e\" -deps ./cmd | LC_ALL=C sort -u", "e2e-tagged Compose dependency reachability evidence"],
  ['test "$(grep \'^github.com/docker/docker/\' /out/evidence/docker-compose-go-dependencies.txt)" = "github.com/docker/docker/pkg/namesgenerator"', "Docker daemon package exclusion"],
  ["go version -m /out/docker | grep -F \"go1.26.5\"", "Docker CLI Go version verification"],
  ["go version -m /out/docker-compose | grep -F \"go1.26.5\"", "Compose Go version verification"],
  ["go-buildinfo/docker-cli.modules.tsv", "Docker CLI linked-module inventory"],
  ["go-buildinfo/docker-compose.modules.tsv", "Compose linked-module inventory"],
  ["go-buildinfo/agent.artifacts.sha256", "agent tool legal-artifact checksums"],
  ["COPY --from=docker-tools-builder /out/licenses/ /licenses/third-party/", "Docker/Compose/Go licenses"],
  ['docker --version | grep -F "Docker version ${DOCKER_CLI_VERSION},"', "runtime Docker CLI version check"],
  ['test "$(docker compose version --short)" = "${COMPOSE_VERSION}"', "runtime Compose version check"]
]) {
  if (!agentDockerfile.includes(invariant)) fail(`Dockerfile.agent: missing ${message}`);
}
if (agentDockerfile.includes("apk upgrade")) fail("Dockerfile.agent: broad mutable runtime apk upgrades are forbidden; pin required security packages exactly");

const notices = readFileSync("THIRD-PARTY-NOTICES.md", "utf8");
for (const component of ["Trivy", "ORAS Go v2", "rclone", "Docker CLI", "Docker Compose", "Go standard library"]) {
  if (!notices.includes(`| ${component} |`)) fail(`THIRD-PARTY-NOTICES.md: missing bundled runtime tool ${component}`);
}
if (!notices.includes("Legal review status: pending") || !notices.includes("/licenses/third-party/go-buildinfo/")) {
  fail("THIRD-PARTY-NOTICES.md: linked Go module evidence and pending manual legal-review status must be explicit");
}

if (failures.length > 0) {
  throw new Error(`Release workflow validation failed:\n${failures.join("\n")}`);
}

console.log("Release workflows preserve the four-image build, exact scan, aggregate gate, and promotion invariants.");
