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

function requireBranches(file, eventName, expectedBranches) {
  const branches = workflows[file]?.on?.[eventName]?.branches ?? [];
  if (JSON.stringify([...branches].sort()) !== JSON.stringify([...expectedBranches].sort())) {
    fail(
      `${file}: ${eventName} branches must be exactly ${expectedBranches.join(", ")}, got ${JSON.stringify(branches)}`
    );
  }
}

requireBranches(
  ".github/workflows/ci.yml",
  "push",
  ["main", "beta", "dev"]
);
for (const file of [
  ".github/workflows/codeql.yml",
  ".github/workflows/container-scan.yml",
  ".github/workflows/publish-images.yml"
]) {
  requireBranches(file, "push", ["main", "beta", "dev"]);
  requireBranches(file, "pull_request", ["main", "beta", "dev"]);
}
requireBranches(
  ".github/workflows/dependency-review.yml",
  "pull_request",
  ["main", "beta", "dev"]
);

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

function requireContainerConfigStep(file, jobName, job) {
  const steps = (job?.steps ?? []).filter(
    (step) => step.name === "Enforce container configuration policy"
  );
  if (steps.length !== 1
      || String(steps[0]?.run ?? "").trim() !== "npm run check:container-config") {
    fail(`${file}:${jobName}: must run the exact digest-pinned container configuration gate once`);
  }
}

for (const [file, workflow] of Object.entries(workflows)) {
  for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
    const steps = job?.steps ?? [];
    for (const step of steps) {
      const command = String(step.run ?? "").trim();
      if (!command.startsWith("npm ci")) continue;
      if (
        !command.includes("--engine-strict")
        || !command.includes("--dangerously-allow-all-scripts=false")
      ) {
        fail(`${file}:${jobName}: every npm ci must reject engine drift and the dangerous allow-all override`);
      }
      if (command.includes("--ignore-scripts=false")) {
        if (!command.includes("--strict-allow-scripts")) {
          fail(`${file}:${jobName}: script-enabled npm ci must enforce the reviewed allowScripts policy`);
        }
      } else if (!/(?:^|\s)--ignore-scripts(?:\s|$)/.test(command)) {
        fail(`${file}:${jobName}: npm ci must explicitly enable reviewed scripts or disable every script`);
      }
    }
    const npmIndexes = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) =>
        /(^|[\s;&|])npm(?:\s|$)/m.test(String(step.run ?? ""))
      )
      .map(({ index }) => index);
    if (!npmIndexes.length) continue;
    const setupIndex = steps.indexOf(actionStep(job, "actions/setup-node"));
    const bootstrapIndexes = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) =>
        String(step.run ?? "").trim() === "node scripts/bootstrap-npm.mjs"
      )
      .map(({ index }) => index);
    requireNode24Setup(file, jobName, job);
    if (
      setupIndex < 0
      || bootstrapIndexes.length !== 1
      || bootstrapIndexes[0] <= setupIndex
      || bootstrapIndexes[0] >= npmIndexes[0]
    ) {
      fail(`${file}:${jobName}: integrity-pinned npm bootstrap must run exactly once after setup-node and before every npm command`);
    }
  }
}

const ciFile = ".github/workflows/ci.yml";
const ciJobs = workflows[ciFile]?.jobs ?? {};
const quality = ciJobs.quality;
const productionBuild = ciJobs["production-build"];
const liveAcceptance = ciJobs["live-acceptance"];
const ciGate = ciJobs["ci-gate"];
const containerPolicyTests = (quality?.steps ?? []).filter(
  (step) => String(step.run ?? "").trim() === "npm run test:container-config-policy"
);
if (containerPolicyTests.length !== 1) {
  fail(`${ciFile}:quality: must run the fail-closed container configuration policy tests once`);
}
const releaseImagePolicyTests = (quality?.steps ?? []).filter(
  (step) => String(step.run ?? "").trim() === "npm run test:release-image-policy"
);
if (releaseImagePolicyTests.length !== 1) {
  fail(`${ciFile}:quality: must run the OCI whiteout/replacement policy tests once`);
}
const releaseAliasPolicyTests = (quality?.steps ?? []).filter(
  (step) => String(step.run ?? "").trim() === "npm run test:release-alias-policy"
);
if (releaseAliasPolicyTests.length !== 1) {
  fail(`${ciFile}:quality: must run the public alias transaction behavioral tests once`);
}
const qualitySteps = quality?.steps ?? [];
const npmInstallIndex = qualitySteps.findIndex(
  (step) => String(step.run ?? "").trim().startsWith("npm ci ")
);
const npmPolicyIndexes = qualitySteps
  .map((step, index) => ({ step, index }))
  .filter(({ step }) =>
    String(step.run ?? "").trim() === "npm run check:npm-install-policy"
  )
  .map(({ index }) => index);
if (
  npmInstallIndex < 0
  || npmPolicyIndexes.length !== 1
  || npmPolicyIndexes[0] <= npmInstallIndex
) {
  fail(`${ciFile}:quality: strict dependency install-script policy must run exactly once after npm ci`);
}
const secretSteps = quality?.steps ?? [];
const secretCheckout = actionStep(quality, "actions/checkout");
const secretRun = secretSteps.find((step) => step.name === "Scan history and exercise the fail-closed detector");
const secretUpload = actionStep(quality, "actions/upload-artifact");
if (secretCheckout?.with?.["fetch-depth"] !== 0) {
  fail(`${ciFile}:quality: the required quality context needs complete history for Gitleaks`);
}
if (String(secretRun?.run ?? "").trim() !== "bash scripts/check-gitleaks.sh") {
  fail(`${ciFile}:quality: must run the reviewed fail-closed Gitleaks wrapper`);
}
if (secretUpload?.with?.name !== "gitleaks-history"
    || secretUpload?.with?.path !== "test-results/gitleaks/gitleaks-git.json"
    || String(secretUpload?.if ?? "") !== "always()") {
  fail(`${ciFile}:quality: must retain the redacted full-history report even after findings`);
}
const gitleaksSource = readFileSync("scripts/check-gitleaks.sh", "utf8");
for (const invariant of [
  "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f",
  "--gitleaks-ignore-path .gitleaksignore",
  "--config .github/gitleaks.toml",
  "--ignore-gitleaks-allow",
  "--report-format json",
  "--redact=100",
  '"--log-opts=HEAD -m"',
  'expected_config_sha256="3970cce55841814bcad57f166c4cb69f23722d46d76b8dd3a3a8c8763ee41ffb"',
  "expected_history=(",
  "git rev-parse --is-shallow-repository",
  "GIT_NO_REPLACE_OBJECTS=1 git rev-list --count HEAD",
  "--env GIT_NO_REPLACE_OBJECTS=1",
  "git rev-parse --git-common-dir",
  "scanned_commit_count",
  '[[ "${scanned_commit_count}" != "${expected_commit_count}" ]]',
  'type == "array" and length == 0',
  'Unreviewed target-local configuration that detects nothing',
  "'gitleaks:allow'",
  "config_bypass_status",
  "inline_bypass_status",
  "target-local-config bypass test",
  "inline-suppression bypass test",
  "expected finding exit 1"
]) {
  if (!gitleaksSource.includes(invariant)) {
    fail(`scripts/check-gitleaks.sh: missing fail-closed invariant ${invariant}`);
  }
}
const reviewedFingerprints = readFileSync(".gitleaksignore", "utf8")
  .trim()
  .split(/\r?\n/);
const expectedFingerprints = [
  "74185cb37ffafc5e5e625a0a1395252cd84b086d:apps/agent/src/config.ts:generic-api-key:10",
  "65e75888b9846983ffc03693c32b1fb14de31947:apps/api/test/migrationLint.test.ts:generic-api-key:7",
  "0dff59101d14c860f582ff788b49743632bfb921:apps/api/test/migrationLint.test.ts:generic-api-key:7"
];
if (JSON.stringify(reviewedFingerprints) !== JSON.stringify(expectedFingerprints)) {
  fail(".gitleaksignore: only the three reviewed historical false-positive fingerprints are allowed");
}
const expectedGitleaksConfig = String.raw`title = "ComposeBastion reviewed Gitleaks policy"

[extend]
useDefault = true

[[allowlists]]
description = "Exact public placeholders that exercise runtime rejection and migration ordering"
targetRules = ["generic-api-key"]
regexTarget = "line"
regexes = [
  '''^\s*"compose-contract-agent-token-0123456789abcdef",\s*$''',
  '''^\s*"003_ssh_password_auth\.sql",\s*$''',
]
`;
if (readFileSync(".github/gitleaks.toml", "utf8") !== expectedGitleaksConfig) {
  fail(".github/gitleaks.toml: reviewed default-extending policy or exact placeholder allowlists changed");
}
requireNode24Setup(ciFile, "production-build", productionBuild);
requireContainerConfigStep(ciFile, "production-build", productionBuild);
requireNode24Setup(ciFile, "live-acceptance", liveAcceptance);
const liveAcceptanceCheckout = actionStep(liveAcceptance, "actions/checkout");
if (liveAcceptanceCheckout?.with?.["fetch-depth"] !== 0) {
  fail(`${ciFile}:live-acceptance: historical public upgrade qualification requires complete Git history and tags`);
}
const installBrowser = (liveAcceptance?.steps ?? []).find((step) => String(step.run ?? "").includes("playwright install --with-deps chromium"));
if (!installBrowser) fail(`${ciFile}:live-acceptance: live Playwright requires an explicit Chromium installation`);
if (!(liveAcceptance?.steps ?? []).some((step) => String(step.run ?? "").trim() === "npm run acceptance:local")
    || !(liveAcceptance?.steps ?? []).some((step) => String(step.run ?? "").includes("acceptance:assert-report"))) {
  fail(`${ciFile}:live-acceptance: full release acceptance and its qualifying-report assertion are both required`);
}
const ciGateNeeds = Array.isArray(ciGate?.needs) ? ciGate.needs : [ciGate?.needs].filter(Boolean);
for (const dependency of ["browser-smoke", "production-build", "live-acceptance"]) {
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
const publicationBranches = [...(publish?.on?.push?.branches ?? [])].sort();
if (JSON.stringify(publicationBranches) !== JSON.stringify(["beta", "dev", "main"])) {
  fail(`${publishFile}: release-image verification must run on main, beta, and dev`);
}
requireNode24Setup(publishFile, "metadata", publishJobs.metadata);
requireContainerConfigStep(publishFile, "metadata", publishJobs.metadata);
const metadataSteps = publishJobs.metadata?.steps ?? [];
const releaseMetadataStep = metadataSteps.find((step) => step.id === "release");
const stableTagStep = metadataSteps.find((step) => step.id === "stable-tag");
const publicationStep = metadataSteps.find((step) => step.id === "publication");
const attributionInstallStep = metadataSteps.find((step) => step.name === "Install stable attribution policy dependencies");
const strictAttributionStep = metadataSteps.find((step) => step.name === "Require approved Go attribution before stable image publication");
if (!String(stableTagStep?.run ?? "").includes('echo "stable=true" >> "${GITHUB_OUTPUT}"')) {
  fail(`${publishFile}:metadata: stable tag validation must expose a successful stable-tag output`);
}
if (!String(releaseMetadataStep?.run ?? "").includes("refs/heads/main")
    || !String(releaseMetadataStep?.run ?? "").includes("cannot publish prerelease version")) {
  fail(`${publishFile}:metadata: the main image alias must reject prerelease package versions`);
}
if (!String(releaseMetadataStep?.run ?? "").includes("refs/heads/beta")
    || !String(releaseMetadataStep?.run ?? "").includes("requires an explicit prerelease version")) {
  fail(`${publishFile}:metadata: the beta image alias must require a prerelease package version`);
}
const publicationRun = String(publicationStep?.run ?? "");
for (const invariant of [
  "refs/tags/*",
  "refs/heads/main",
  'echo "required=${required}" >> "${GITHUB_OUTPUT}"'
]) {
  if (!publicationRun.includes(invariant)) {
    fail(`${publishFile}:metadata: public publication classification is missing ${invariant}`);
  }
}
if (publicationRun.includes("refs/heads/beta")) {
  fail(`${publishFile}:metadata: beta publication must not require stable legal approval`);
}
if (String(strictAttributionStep?.if ?? "") !== "steps.publication.outputs.required == 'true'"
    || String(strictAttributionStep?.run ?? "").trim() !== "npm run check:go-attribution:release") {
  fail(`${publishFile}:metadata: main and stable publications must require approved Go attribution`);
}
if (String(attributionInstallStep?.if ?? "") !== "steps.publication.outputs.required == 'true'"
    || String(attributionInstallStep?.run ?? "").trim()
      !== "npm ci --engine-strict --dangerously-allow-all-scripts=false --ignore-scripts") {
  fail(`${publishFile}:metadata: every stable publication must install locked attribution policy dependencies`);
}
const stableTagIndex = metadataSteps.indexOf(stableTagStep);
const publicationIndex = metadataSteps.indexOf(publicationStep);
const attributionInstallIndex = metadataSteps.indexOf(attributionInstallStep);
const strictAttributionIndex = metadataSteps.indexOf(strictAttributionStep);
if (stableTagIndex < 0 || publicationIndex <= stableTagIndex
    || attributionInstallIndex <= publicationIndex || strictAttributionIndex <= attributionInstallIndex) {
  fail(`${publishFile}:metadata: classify publication, install policy dependencies, and require approval in that order`);
}
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
const sbomIndex = buildSteps.findIndex((step) => step.name === "Generate an SPDX SBOM from the exact passing OCI layout");
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
  '[[ "${layer_digest}" =~ ^sha256:[a-f0-9]{64}$ ]]',
  '.config.Labels["org.opencontainers.image.title"]',
  '.config.Labels["org.opencontainers.image.source"]',
  '.config.Labels["org.opencontainers.image.licenses"]'
]) {
  if (!verificationRun.includes(invariant)) {
    fail(`${publishFile}:build-scan: archive blob-integrity verification is missing ${invariant}`);
  }
}
if ((verificationRun.match(/sha256sum/g) ?? []).length < 4) {
  fail(`${publishFile}:build-scan: archive, manifest, config, and every layer must be independently SHA-256 verified`);
}
const sbomRun = String(buildSteps[sbomIndex]?.run ?? "");
if (sbomRun.includes('--volume "/tmp:/out"')) {
  fail(`${publishFile}:build-scan: the SBOM generator must not receive writable access to release archives or metadata`);
}
for (const invariant of [
  "ghcr.io/anchore/syft:v1.50.0@sha256:1288ea4c8b38767b4e620c1e312c8cb26b6e887a99b4f07ab6cd19fc6f225026",
  'scan "oci-dir:/image"',
  'sbom_output_root="$(mktemp -d)"',
  '--volume "${layout}:/image:ro"',
  '--volume "${sbom_output_root}:/out"',
  'spdx-json=/out/${sbom_name}',
  'test ! -L "${generated_sbom}"',
  'install -m 0644 "${generated_sbom}" "${sbom}"',
  '(.name | type == "string" and length > 0)',
  '(.documentNamespace | type == "string" and test("^https://"))',
  '(.packages | type == "array" and length > 0)',
  'sbomSha256:$sbomSha256'
]) {
  if (!(sbomRun.includes(invariant) || String(publish?.env?.SYFT_IMAGE ?? "").includes(invariant))) {
    fail(`${publishFile}:build-scan: exact-layout SBOM generation is missing ${invariant}`);
  }
}
const buildUpload = actionStep(buildScan, "actions/upload-artifact");
const uploadIndex = buildSteps.indexOf(buildUpload);
if (!String(buildUpload?.with?.path ?? "").includes("release-${{ matrix.component }}-${{ matrix.arch }}.spdx.json")) {
  fail(`${publishFile}:build-scan: passing archive evidence must include its exact-layout SPDX SBOM`);
}
if (buildIndex < 0 || verificationIndex <= buildIndex || scanIndex <= verificationIndex
    || sbomIndex <= scanIndex || uploadIndex <= sbomIndex) {
  fail(`${publishFile}:build-scan: build, verify/extract, scan, SBOM, and upload must remain strictly ordered`);
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
const tagLabelStep = tagRescanSteps.find(
  (step) => step.name === "Verify immutable image labels"
);
const tagLabelRun = String(tagLabelStep?.run ?? "");
for (const invariant of [
  "org.opencontainers.image.title",
  "org.opencontainers.image.source",
  "org.opencontainers.image.licenses",
  'docker cp "${container_id}:/licenses/."',
  "cmp LICENSES/go-modules/manifest.json",
  "THIRD-PARTY-NOTICES.md",
  "go-buildinfo/trivy.artifacts.sha256",
  "go-buildinfo/agent.artifacts.sha256"
]) {
  if (!tagLabelRun.includes(invariant)) {
    fail(
      `${publishFile}:rescan-tag-images: immutable image label/legal verification is missing ${invariant}`
    );
  }
}
const tagRecordIndex = tagRescanSteps.findIndex((step) => step.name === "Record the exact passing index and platform digests");
const tagAttestationIndex = tagRescanSteps.findIndex((step) => step.name === "Verify the published platform SBOM attestation");
const tagUploadStep = actionStep(tagRescan, "actions/upload-artifact");
const tagUploadIndex = tagRescanSteps.indexOf(tagUploadStep);
if (tagScanIndex < 0 || tagAttestationIndex <= tagScanIndex
    || tagRecordIndex <= tagAttestationIndex || tagUploadIndex <= tagRecordIndex) {
  fail(`${publishFile}:rescan-tag-images: verify scan and SBOM attestation before persisting digest evidence`);
}
const tagAttestationRun = String(tagRescanSteps[tagAttestationIndex]?.run ?? "");
if (!tagAttestationRun.includes('gh attestation verify "oci://${IMAGE_REFERENCE}"')
    || !tagAttestationRun.includes("--predicate-type https://spdx.dev/Document/v2.3")
    || !tagAttestationRun.includes("--signer-workflow")
    || !tagAttestationRun.includes('--source-digest "${GITHUB_SHA}"')
    || tagRescan?.permissions?.attestations !== "read") {
  fail(`${publishFile}:rescan-tag-images: stable promotion must verify each platform SPDX attestation with signer/source constraints`);
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
for (const [jobName, dependency] of [["publish-branch", "release-image-gate"], ["promote-tag", "release-image-gate"]]) {
  if (!(publishJobs[jobName]?.needs ?? []).includes(dependency)) fail(`${publishFile}:${jobName}: must depend on ${dependency}`);
}

if (!String(publish?.concurrency?.group ?? "").includes("publish-images-publication")) {
  fail(`${publishFile}: branch and tag registry mutations must share one concurrency group`);
}
const publishBranch = publishJobs["publish-branch"];
const publishBranchCondition = String(publishBranch?.if ?? "");
if (publishBranchCondition.includes("always()")) {
  fail(`${publishFile}:publish-branch: mutating publication must not run after a failed dependency`);
}
for (const successGate of [
  "needs.metadata.result == 'success'",
  "needs.build-scan.result == 'success'",
  "needs.release-image-gate.result == 'success'"
]) {
  if (!publishBranchCondition.includes(successGate)) {
    fail(`${publishFile}:publish-branch: condition must require ${successGate}`);
  }
}
for (const branchRef of ["refs/heads/main", "refs/heads/beta"]) {
  if (!publishBranchCondition.includes(branchRef)) {
    fail(`${publishFile}:publish-branch: condition must explicitly allow ${branchRef}`);
  }
}
const copyRun = (publishBranch?.steps ?? []).find((step) => step.name === "Copy the scanned platform manifests")?.run ?? "";
if (!copyRun.includes('platform_tag="sha-${GITHUB_SHA}-${arch}"')) {
  fail(`${publishFile}:publish-branch: platform images must use deterministic full-commit tags`);
}
if (copyRun.includes("skopeo inspect")) {
  fail(`${publishFile}:publish-branch: raw skopeo failures must not be treated as confirmed tag absence`);
}
for (const invariant of [
  'sbom="/tmp/release-images/release-${component}-${arch}.spdx.json"',
  "expected_sbom_sha=",
  'test "$(sha256sum "${sbom}"',
  "skopeo copy",
  "--preserve-digests",
  "scripts/inspect-registry-reference.sh",
  'case "${inspection_status}" in',
  "3)"
]) {
  if (!copyRun.includes(invariant)) {
    fail(`${publishFile}:publish-branch: archive/SBOM digest-bound copy is missing ${invariant}`);
  }
}
const registryInspector = readFileSync("scripts/inspect-registry-reference.sh", "utf8");
for (const invariant of [
  'grep -Fqx "ERROR: ${reference}: not found"',
  "(manifest|name)[ _-]?unknown",
  "exit 3",
  "exit 2",
  "Registry inspection failed without a confirmed not-found response"
]) {
  if (!registryInspector.includes(invariant)) {
    fail(`scripts/inspect-registry-reference.sh: missing tri-state fail-closed invariant ${invariant}`);
  }
}
const aliasReconciler = readFileSync("scripts/reconcile-image-alias-pair.sh", "utf8");
for (const invariant of [
  "scripts/inspect-registry-reference.sh",
  "failed without confirming that the alias is absent; no mutation was attempted",
  "finalInspection",
  "inspection-error"
]) {
  if (!aliasReconciler.includes(invariant)) {
    fail(`scripts/reconcile-image-alias-pair.sh: missing fail-closed registry inspection invariant ${invariant}`);
  }
}
const aliasReconcilerTests = readFileSync("scripts/reconcile-image-alias-pair.test.sh", "utf8");
for (const invariant of [
  "transient-inspection-failure",
  "transient registry inspection mutated an alias",
  "confirmed skopeo not-found",
  "transient skopeo failure",
  'if [[ "$#" -ne 9',
  '[[ "$5" = "${GITHUB_REPOSITORY}" ]]',
  '[[ "$7" = "${expected_signer}" ]]',
  '[[ "$9" = "${expected_revision}" ]]',
  "final-evidence-inspection-failure",
  'status == "final-verification-failed"',
  "final evidence inspection failure attempted unexpected follow-up mutation"
]) {
  if (!aliasReconcilerTests.includes(invariant)) {
    fail(`scripts/reconcile-image-alias-pair.test.sh: missing registry fault-injection invariant ${invariant}`);
  }
}
const publishBranchSteps = publishBranch?.steps ?? [];
const copyIndex = publishBranchSteps.findIndex((step) => step.name === "Copy the scanned platform manifests");
const legalIndex = publishBranchSteps.findIndex((step) => step.name === "Verify every published platform label and legal root filesystem");
const legalRun = String(publishBranchSteps[legalIndex]?.run ?? "");
if (!legalRun.includes("scripts/verify-published-image.sh")
    || !legalRun.includes('"${image}@${digest}"')) {
  fail(`${publishFile}:publish-branch: every copied platform digest must pass final-rootfs legal verification`);
}
const publishedVerifier = readFileSync("scripts/verify-published-image.sh", "utf8");
for (const invariant of [
  "org.opencontainers.image.title",
  "org.opencontainers.image.source",
  "org.opencontainers.image.licenses",
  'docker cp "${container_id}:/licenses/."',
  "cmp LICENSES/go-modules/manifest.json",
  "THIRD-PARTY-NOTICES.md",
  "sha256sum -c",
  "go-buildinfo/trivy.artifacts.sha256",
  "go-buildinfo/agent.artifacts.sha256"
]) {
  if (!publishedVerifier.includes(invariant)) {
    fail(`scripts/verify-published-image.sh: published legal verification is missing ${invariant}`);
  }
}
const assembleRun = (publishBranch?.steps ?? []).find((step) => step.name === "Assemble and verify both immutable indexes")?.run ?? "";
if (!assembleRun.includes('index="${image}:sha-${GITHUB_SHA}"')) {
  fail(`${publishFile}:publish-branch: multi-architecture indexes must use the protected commit SHA tag`);
}
for (const arch of ["amd64", "arm64"]) {
  if (assembleRun.includes(`\${image}:sha-\${GITHUB_SHA}-${arch}`)) {
    fail(`${publishFile}:publish-branch: immutable index creation must not resolve a mutable ${arch} platform tag`);
  }
}
for (const digestSource of ['"${image}@${amd64_digest}"', '"${image}@${arm64_digest}"']) {
  if (!assembleRun.includes(digestSource)) {
    fail(`${publishFile}:publish-branch: immutable index must use verified digest source ${digestSource}`);
  }
}
for (const invariant of [
  'index_digest="$(bash scripts/inspect-registry-reference.sh buildx "${index}")"',
  'case "${inspection_status}" in',
  "3)",
  'docker buildx imagetools inspect --raw "${image}@${index_digest}"',
  'echo "${component}_digest=${index_digest}"',
  'echo "${component}_amd64_digest=${amd64_digest}"',
  'echo "${component}_arm64_digest=${arm64_digest}"'
]) {
  if (!assembleRun.includes(invariant)) fail(`${publishFile}:publish-branch: verified index binding is missing ${invariant}`);
}
const assembleIndex = publishBranchSteps.findIndex((step) => step.name === "Assemble and verify both immutable indexes");
const attestationSteps = publishBranchSteps.filter((step) =>
  typeof step.uses === "string" && step.uses.startsWith("actions/attest@")
);
const attestationTuples = attestationSteps.map((step) => [
  step.with?.["subject-name"] ?? "",
  step.with?.["subject-digest"] ?? "",
  step.with?.["subject-version"] ?? "",
  step.with?.["sbom-path"] ?? "",
  String(step.with?.["push-to-registry"] ?? "")
].join("|")).sort();
const expectedAttestationTuples = [
  "${{ env.APP_IMAGE }}|${{ steps.indexes.outputs.app_digest }}|${{ needs.metadata.outputs.version }}||true",
  "${{ env.AGENT_IMAGE }}|${{ steps.indexes.outputs.agent_digest }}|${{ needs.metadata.outputs.version }}||true",
  "${{ env.APP_IMAGE }}|${{ steps.indexes.outputs.app_amd64_digest }}||/tmp/release-images/release-app-amd64.spdx.json|true",
  "${{ env.APP_IMAGE }}|${{ steps.indexes.outputs.app_arm64_digest }}||/tmp/release-images/release-app-arm64.spdx.json|true",
  "${{ env.AGENT_IMAGE }}|${{ steps.indexes.outputs.agent_amd64_digest }}||/tmp/release-images/release-agent-amd64.spdx.json|true",
  "${{ env.AGENT_IMAGE }}|${{ steps.indexes.outputs.agent_arm64_digest }}||/tmp/release-images/release-agent-arm64.spdx.json|true"
].sort();
if (JSON.stringify(attestationTuples) !== JSON.stringify(expectedAttestationTuples)) {
  fail(`${publishFile}:publish-branch: both indexes need provenance and all four platform digests need registry SBOM attestations`);
}
for (const step of attestationSteps) {
  if (publishBranchSteps.indexOf(step) <= assembleIndex) {
    fail(`${publishFile}:publish-branch: attest only after both immutable indexes are verified`);
  }
}
for (const permission of ["id-token", "attestations", "artifact-metadata", "packages"]) {
  if (publishBranch?.permissions?.[permission] !== "write") {
    fail(`${publishFile}:publish-branch: ${permission}: write is required for registry attestations`);
  }
}
const branchAliasStep = (publishBranch?.steps ?? []).find((step) => step.name === "Reconcile branch alias to the attested image pair");
const branchAliasRun = branchAliasStep?.run ?? "";
if (branchAliasRun.includes(":latest")) fail(`${publishFile}:publish-branch: an untagged branch commit must not move latest`);
if (!branchAliasRun.includes("scripts/reconcile-image-alias-pair.sh")
    || !branchAliasRun.includes("/tmp/branch-alias-reconciliation.json")
    || !branchAliasRun.includes('mode="branch"')
    || !branchAliasRun.includes('mode="beta"')
    || !branchAliasRun.includes('aliases=("${GITHUB_REF_NAME}")')
    || !branchAliasRun.includes('aliases+=("${VERSION}")')
    || !branchAliasRun.includes('"${aliases[@]}"')
    || branchAliasStep?.env?.LEGACY_ALIAS_BOOTSTRAP_POLICY !== ".github/legacy-alias-bootstrap.json"
    || branchAliasStep?.env?.APP_INDEX_DIGEST !== "${{ steps.indexes.outputs.app_digest }}"
    || branchAliasStep?.env?.AGENT_INDEX_DIGEST !== "${{ steps.indexes.outputs.agent_digest }}"
    || branchAliasStep?.env?.VERSION !== "${{ needs.metadata.outputs.version }}") {
  fail(`${publishFile}:publish-branch: main/beta must use paired branch/prerelease attestation reconciliation`);
}
const branchReconciliationUpload = publishBranchSteps.find(
  (step) => step.name === "Upload paired branch-alias reconciliation evidence"
);
if (String(branchReconciliationUpload?.if ?? "") !== "always()"
    || branchReconciliationUpload?.with?.path !== "/tmp/branch-alias-reconciliation.json"
    || branchReconciliationUpload?.with?.["if-no-files-found"] !== "error") {
  fail(`${publishFile}:publish-branch: paired alias evidence must upload even after rollback/failure`);
}
const branchAliasIndex = publishBranchSteps.indexOf(branchAliasStep);
const finalAttestationIndex = Math.max(...attestationSteps.map((step) => publishBranchSteps.indexOf(step)));
if (copyIndex < 0 || legalIndex <= copyIndex || assembleIndex <= legalIndex
    || finalAttestationIndex <= assembleIndex || branchAliasIndex <= finalAttestationIndex) {
  fail(`${publishFile}:publish-branch: copy, legal verification, index assembly, attestations, and alias reconciliation must remain ordered`);
}
const promoteTag = publishJobs["promote-tag"];
const promoteTagCondition = String(promoteTag?.if ?? "");
if (promoteTagCondition.includes("always()")) {
  fail(`${publishFile}:promote-tag: mutating stable promotion must not run after a failed dependency`);
}
for (const successGate of [
  "needs.metadata.result == 'success'",
  "needs.release-image-gate.result == 'success'"
]) {
  if (!promoteTagCondition.includes(successGate)) {
    fail(`${publishFile}:promote-tag: condition must require ${successGate}`);
  }
}
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
  'gh attestation verify "oci://${image}@${expected}"',
  "--signer-workflow",
  '--source-digest "${GITHUB_SHA}"',
  'echo "${component}_digest=${expected}"'
]) {
  if (!promotionVerification.includes(invariant)) {
    fail(`${publishFile}:promote-tag: promotion digest verification is missing ${invariant}`);
  }
}
if (!promotionVerification.includes("indexDigest") || !promotionVerification.includes("platformDigest")) {
  fail(`${publishFile}:promote-tag: all four records must validate both index and platform digests`);
}
const stableAliasStep = (promoteTag?.steps ?? []).find((step) => step.name === "Reconcile stable aliases to the attested image pair");
const stableAliasRun = stableAliasStep?.run ?? "";
if (!stableAliasRun.includes("scripts/reconcile-image-alias-pair.sh")
    || !stableAliasRun.includes("/tmp/stable-alias-reconciliation.json")
    || !stableAliasRun.includes("stable")
    || !stableAliasRun.includes('"${VERSION}"')
    || !stableAliasRun.includes('"v${VERSION}"')
    || !stableAliasRun.includes('"${minor}"')
    || !stableAliasRun.includes("latest")
    || stableAliasStep?.env?.LEGACY_ALIAS_BOOTSTRAP_POLICY !== ".github/legacy-alias-bootstrap.json"
    || stableAliasStep?.env?.APP_INDEX_DIGEST !== "${{ steps.images.outputs.app_digest }}"
    || stableAliasStep?.env?.AGENT_INDEX_DIGEST !== "${{ steps.images.outputs.agent_digest }}") {
  fail(`${publishFile}:promote-tag: stable aliases must use the paired attestation/rollback reconciler`);
}
const stableReconciliationUpload = (promoteTag?.steps ?? []).find(
  (step) => step.name === "Upload paired stable-alias reconciliation evidence"
);
if (String(stableReconciliationUpload?.if ?? "") !== "always()"
    || stableReconciliationUpload?.with?.path !== "/tmp/stable-alias-reconciliation.json"
    || stableReconciliationUpload?.with?.["if-no-files-found"] !== "error") {
  fail(`${publishFile}:promote-tag: paired stable-alias evidence must upload after every outcome`);
}

const scanFile = ".github/workflows/container-scan.yml";
const scan = workflows[scanFile];
const containerConfig = scan?.jobs?.["container-config"];
const imageScan = scan?.jobs?.["image-scan"];
requireNode24Setup(scanFile, "container-config", containerConfig);
requireContainerConfigStep(scanFile, "container-config", containerConfig);
requireNode24Setup(scanFile, "image-scan", imageScan);
requireExactMatrix(scanFile, "image-scan", imageScan);
requireTrivy(scanFile, "image-scan", imageScan);
requireExactGitBuildContext(scanFile, "image-scan", imageScan, actionStep(imageScan, "docker/build-push-action"));
const containerGate = scan?.jobs?.["container-scan-gate"];
if (containerGate?.name !== "Container scan gate") fail(`${scanFile}: aggregate check name changed`);
if (!String(containerGate?.if ?? "").includes("always()")) fail(`${scanFile}: aggregate gate must run after scan failure or cancellation`);
const containerGateNeeds = Array.isArray(containerGate?.needs)
  ? containerGate.needs
  : [containerGate?.needs].filter(Boolean);
for (const dependency of ["container-config", "image-scan"]) {
  if (!containerGateNeeds.includes(dependency)) {
    fail(`${scanFile}:container-scan-gate: aggregate must require ${dependency}`);
  }
}
const containerGateRun = String(containerGate?.steps?.[0]?.run ?? "");
if (!containerGateRun.includes('test "${CONTAINER_CONFIG_RESULT}" = success')
    || containerGate?.steps?.[0]?.env?.CONTAINER_CONFIG_RESULT !== "${{ needs.container-config.result }}") {
  fail(`${scanFile}:container-scan-gate: aggregate must fail when container configuration policy fails`);
}

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
const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
if (rootPackage?.scripts?.["check:gitleaks"] !== "bash scripts/check-gitleaks.sh") {
  fail("package.json: the reviewed Gitleaks gate must remain directly runnable");
}
const releaseProcess = readFileSync(".github/RELEASE_PROCESS.md", "utf8");
for (const command of [
  "node scripts/bootstrap-npm.mjs",
  "npm ci --engine-strict --strict-allow-scripts --dangerously-allow-all-scripts=false --ignore-scripts=false",
  "npm run check:npm-version",
  "npm run check:npm-install-policy",
  "npm run check:gitleaks",
  "npm run check:go-attribution:release",
  "npm run test:go-attribution-policy",
  "npm run test:container-config-policy",
  "npm run test:release-image-policy",
  "npm run test:release-alias-policy",
  "npm run test:acceptance-policy",
  "npm run check:container-config",
  "npm run acceptance:assert-report",
  "npm run release:verify-images"
]) {
  if (!releaseProcess.includes(command)) {
    fail(`.github/RELEASE_PROCESS.md: local release verification is missing CI-parity command ${command}`);
  }
}
if (rootPackage?.scripts?.["check:container-config"] !== "node scripts/check-container-config.mjs"
    || rootPackage?.scripts?.["test:container-config-policy"] !== "node --test scripts/container-config-policy.test.mjs"
    || rootPackage?.scripts?.["test:release-image-policy"] !== "node --test scripts/oci-rootfs.test.mjs"
    || rootPackage?.scripts?.["test:release-alias-policy"] !== "bash scripts/reconcile-image-alias-pair.test.sh") {
  fail("package.json: container configuration live gate and policy tests must remain directly runnable");
}
const containerConfigSource = readFileSync("scripts/check-container-config.mjs", "utf8");
for (const invariant of [
  "aquasec/trivy:0.72.0@sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f",
  'const useDocker = !cliOptions.has("--local")',
  '"--ignorefile", "/dev/null"',
  "actualVersion !== expectedTrivyVersion",
  "evaluateContainerConfigReport(target, report)"
]) {
  if (!containerConfigSource.includes(invariant)) {
    fail(`scripts/check-container-config.mjs: missing fail-closed invariant ${invariant}`);
  }
}
const containerPolicySource = readFileSync("scripts/container-config-policy.mjs", "utf8");
for (const invariant of [
  'export const expectedTrivyVersion = "0.72.0"',
  '"Dockerfile.agent:DS-0002"',
  '"infra/dev/sshhost.Dockerfile:DS-0002"',
  "userChecks.length !== 1",
  "admitted.length !== 1",
  "report?.ArtifactName !== target"
]) {
  if (!containerPolicySource.includes(invariant)) {
    fail(`scripts/container-config-policy.mjs: missing fail-closed invariant ${invariant}`);
  }
}
const releaseImageVerifier = readFileSync("scripts/verify-release-images.mjs", "utf8");
if (!releaseImageVerifier.includes('"--ignorefile", "/workspace/.trivyignore.yaml"') || releaseImageVerifier.includes("--ignore-policy")) {
  fail("scripts/verify-release-images.mjs: local release scans must use the path- and PURL-scoped YAML ignore file");
}
if (releaseImageVerifier.includes('`${reportDirectory}:/reports`')) {
  fail("scripts/verify-release-images.mjs: the scanner must not receive writable access to archives or verification metadata");
}
for (const invariant of [
  "mkdtempSync(",
  '`${scanOutputDirectory}:/scan-output`',
  '`${repositoryRoot}:/workspace:ro`',
  "copyFileSync(generatedScanPath, scanPath)",
  "rmSync(scanOutputDirectory, { recursive: true, force: true })",
  "rmSync(trivyCacheDirectory, { recursive: true, force: true })",
  "finalArchiveDigest === image.archiveDigest"
]) {
  if (!releaseImageVerifier.includes(invariant)) {
    fail(`scripts/verify-release-images.mjs: isolated scanner output/archive revalidation is missing ${invariant}`);
  }
}
for (const invariant of ["materializeGitBuildContext", "assertSafeTestResultsPath", "GIT_NO_REPLACE_OBJECTS", "buildContextDirectory", "sourceContext.contextDigest", "digestGitBuildContext"]) {
  if (!releaseImageVerifier.includes(invariant)) {
    fail(`scripts/verify-release-images.mjs: exact Git build-context verification is missing ${invariant}`);
  }
}
for (const invariant of [
  "org.opencontainers.image.title",
  "org.opencontainers.image.source",
  "org.opencontainers.image.licenses",
  "verifyLegalArtifacts",
  "LICENSES/go-modules/manifest.json",
  "third-party/go-modules/manifest.json",
  "go-buildinfo/trivy.artifacts.sha256",
  "go-buildinfo/agent.artifacts.sha256"
]) {
  if (!releaseImageVerifier.includes(invariant)) {
    fail(
      `scripts/verify-release-images.mjs: exact image label/legal verification is missing ${invariant}`
    );
  }
}
const cleanupIndex = releaseImageVerifier.indexOf("rmSync(reportDirectory, { recursive: true, force: true });");
const argumentValidationIndex = releaseImageVerifier.indexOf("if (process.argv.length > 2)");
if (cleanupIndex < 0 || argumentValidationIndex < 0 || cleanupIndex > argumentValidationIndex) {
  fail("scripts/verify-release-images.mjs: stale passing evidence must be removed before CLI argument validation");
}
const ociRootfsPolicy = readFileSync("scripts/oci-rootfs.mjs", "utf8");
const ociRootfsTests = readFileSync("scripts/oci-rootfs.test.mjs", "utf8");
for (const invariant of [
  'entries.has(".wh..wh..opq")',
  "addLayerEntry",
  "duplicate normalized member",
  "const entry = entries.get(normalizedTarget)",
  "layerHidesTarget(entries, normalizedTarget)",
  'value.startsWith("/")',
  'segments.includes("..")'
]) {
  if (!ociRootfsPolicy.includes(invariant)) {
    fail(`scripts/oci-rootfs.mjs: whiteout-aware final-rootfs policy is missing ${invariant}`);
  }
}
for (const fixture of [
  "preserves POSIX backslashes instead of treating them as separators",
  "rejects absolute and parent-traversing layer entries",
  "rejects duplicate normalized layer members",
  "detects a direct whiteout",
  "detects an ancestor whiteout",
  "detects ancestor and root opaque whiteouts",
  "a same-layer replacement wins over whiteout markers"
]) {
  if (!ociRootfsTests.includes(fixture)) {
    fail(`scripts/oci-rootfs.test.mjs: missing regression fixture ${fixture}`);
  }
}
if (ociRootfsPolicy.includes('.replaceAll("\\\\", "/")')
    || releaseImageVerifier.includes('.replaceAll("\\\\", "/")')) {
  fail("OCI/Linux archive paths must preserve literal backslashes rather than aliasing them to POSIX separators");
}
for (const invariant of [
  "--source-digest",
  "--signer-workflow",
  "verify_attested_pair",
  "rollback_changed_aliases",
  "prior_app[index]",
  "prior_agent[index]",
  'rollback_status="partial-blocked"',
  'rollback_status="verified-with-retained-new-pair"',
  'status="failed-retained-new-pair"',
  'status="final-verification-pending"',
  'status="final-verification-failed"',
  "finalInspectionComplete",
  "finalTargetPairVerified",
  'kind="new-moving"',
  "branch|beta|stable",
  "reconcile_range 1 1",
  "allow_legacy_pair",
  "LEGACY_ALIAS_BOOTSTRAP_POLICY",
  "reconcile_range 0 1",
  "reconcile_range 2 2",
  "reconcile_range 3 3",
  "crossRepositoryAtomicity: false"
]) {
  if (!aliasReconciler.includes(invariant)) {
    fail(`scripts/reconcile-image-alias-pair.sh: paired alias transaction is missing ${invariant}`);
  }
}
const legacyAliasBootstrap = JSON.parse(readFileSync(".github/legacy-alias-bootstrap.json", "utf8"));
const expectedLegacyAliasBootstrap = [
  "refs/heads/beta:beta:5ef8ded5da914aa29c3caca5854fe2840dc7eb7f:sha256:3eca4a8405650896b82c9557b624828099c59ba45627571e00a8a519af74f431:sha256:7cd3358d80be4a0663f6cff51ca8b7cf325d831aea8b0a57dc7a36d8f6eb0f0d",
  "refs/heads/main:main:4ec6871a20ce7014272b8f1390e74b5e9b958779:sha256:795d0c92953466a76f032ad46a8f652a68905a618e7ac01b7ff0f29f4da949d3:sha256:071df334ae03317eedf44a0dcd61ee0b7ebae4d265927471fce487f97bf00ac4",
  "refs/tags/v1.2.0:latest:6127ddb16cbfc9cf13a3241bd80c96001e2df29f:sha256:53cceea331c04260ef30aba495ef912dc923e3636f0b5b70e66bfad02f284674:sha256:e517d9fe5a46f8cce16b7e5c491256e1b459df784f86107b0f42725b2ed55cba"
];
const actualLegacyAliasBootstrap = (legacyAliasBootstrap?.entries ?? [])
  .map((entry) => `${entry.targetRef}:${entry.alias}:${entry.revision}:${entry.appDigest}:${entry.agentDigest}`);
if (legacyAliasBootstrap?.schemaVersion !== 1
    || JSON.stringify(actualLegacyAliasBootstrap) !== JSON.stringify(expectedLegacyAliasBootstrap)
    || legacyAliasBootstrap.entries.some((entry) =>
      entry.status !== "pending"
      || entry.expiresOn !== "2026-08-31"
      || entry.appImage !== "ghcr.io/composebastion-admin/composebastion-app"
      || entry.agentImage !== "ghcr.io/composebastion-admin/composebastion-agent"
    )) {
  fail(".github/legacy-alias-bootstrap.json: one-time migration must remain limited to the three observed unattested alias pairs");
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
    || !/^ARG TRIVY_GO_GIT_VERSION=v5\.19\.2$/m.test(appDockerfile)
    || !appDockerfile.includes('go get "oras.land/oras-go/v2@${TRIVY_ORAS_VERSION}"')
    || !appDockerfile.includes('go get "github.com/go-git/go-git/v5@${TRIVY_GO_GIT_VERSION}"')
    || !appDockerfile.includes("go test oras.land/oras-go/v2/content/file -run '^Test_extractTarDirectory_HardLink$'")
    || !appDockerfile.includes(goBuilder)) {
  fail("Dockerfile: embedded Trivy must retain the reviewed ORAS, go-git, and patched Go toolchain rebuild");
}
for (const [invariant, message] of [
  [nodeBase, "pinned multi-architecture Node base"],
  ["apk add --no-cache 'libcrypto3=3.5.7-r0' 'libssl3=3.5.7-r0'", "exact fixed Alpine OpenSSL packages"],
  ["ENV GOTOOLCHAIN=local", "local-only pinned Go toolchain"],
  ['echo "${TRIVY_SOURCE_SHA256}  /tmp/trivy-source.tar.gz" | sha256sum -c -', "Trivy source checksum verification"],
  ["go build -mod=readonly -buildvcs=false -trimpath", "read-only deterministic Trivy module build"],
  ['go version -m /out/trivy | grep -F "oras.land/oras-go/v2"', "embedded ORAS version verification"],
  ['go version -m /out/trivy | grep -F "github.com/go-git/go-git/v5"', "embedded go-git version verification"],
  ["ARG RCLONE_VERSION=1.74.4", "reviewed rclone version"],
  ["ARG RCLONE_SOURCE_COMMIT=5bc93a2a7ab0ebd0a11352bc4968eabeffb18027", "reviewed rclone source commit"],
  ["ARG RCLONE_SOURCE_SHA256=1d604c49673ddbb8829563c6768d3d69cd0a8ddc4a0beec3b42a9dae3ea34a63", "rclone source checksum"],
  ["ARG RCLONE_LICENSE_SHA256=8cd2e9e750b90a04b7d82dbbca3930c696ae0309d7c10464f90a44f45754cd04", "rclone license checksum"],
  ["ARG GO_GRPC_VERSION=1.82.1", "reviewed patched gRPC version"],
  ["ARG GO_TEXT_VERSION=0.39.0", "reviewed patched Go text version"],
  ['echo "${RCLONE_SOURCE_SHA256}  /tmp/rclone-source.tar.gz" | sha256sum -c -', "rclone source verification"],
  ['echo "${RCLONE_LICENSE_SHA256}  /src/COPYING" | sha256sum -c -', "rclone license verification"],
  ['go get "google.golang.org/grpc@v${GO_GRPC_VERSION}"', "patched manager-tool gRPC dependency"],
  ['go get "golang.org/x/text@v${GO_TEXT_VERSION}"', "patched manager-tool text dependency"],
  ["go build -mod=readonly -buildvcs=false -trimpath", "read-only deterministic manager-tool builds"],
  ["COPY --from=trivy-builder /out/licenses/ /licenses/third-party/", "Trivy/ORAS/Go licenses"],
  ["COPY --from=rclone-builder /out/licenses/ /licenses/third-party/", "rclone license and linked-module evidence"],
  ["node -e \"Promise.all([import('@composebastion/shared'), import('semver')])\"", "runtime workspace dependency resolution check"],
  ["go-buildinfo/trivy.modules.tsv", "Trivy linked-module inventory"],
  ["go-buildinfo/rclone.modules.tsv", "rclone linked-module inventory"],
  ["go-buildinfo/trivy.artifacts.sha256", "Trivy legal-artifact checksums"],
  ["go-buildinfo/rclone.artifacts.sha256", "rclone legal-artifact checksums"],
  ["COPY LICENSES/go-modules/ /licenses/third-party/go-modules/", "checked-in Go attribution bundle"],
  ["node /tmp/go-attribution.mjs verify", "linked Go attribution verification"],
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
  [/^ARG COMPOSE_SOURCE_SHA256=34387f32377bffac7ee0a70d78435af3b59a075b6f29409172c6d6346ca0340d$/m, "Docker Compose source checksum"],
  [/^ARG COMPOSE_GRPC_VERSION=1\.82\.1$/m, "patched Docker Compose gRPC version"],
  [/^ARG GO_TEXT_VERSION=0\.39\.0$/m, "patched Docker Compose text version"]
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
  ['go mod edit -require="google.golang.org/grpc@v${COMPOSE_GRPC_VERSION}"', "patched Docker Compose gRPC dependency"],
  ['go mod edit -require="golang.org/x/text@v${GO_TEXT_VERSION}"', "patched Docker Compose text dependency"],
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
  ["node -e \"import('@composebastion/shared')\"", "agent runtime workspace dependency resolution check"],
  ["COPY LICENSES/go-modules/ /licenses/third-party/go-modules/", "checked-in Go attribution bundle"],
  ["node /tmp/go-attribution.mjs verify", "linked Go attribution verification"],
  ['docker --version | grep -F "Docker version ${DOCKER_CLI_VERSION},"', "runtime Docker CLI version check"],
  ['test "$(docker compose version --short)" = "${COMPOSE_VERSION}"', "runtime Compose version check"]
]) {
  if (!agentDockerfile.includes(invariant)) fail(`Dockerfile.agent: missing ${message}`);
}
if (agentDockerfile.includes("apk upgrade")) fail("Dockerfile.agent: broad mutable runtime apk upgrades are forbidden; pin required security packages exactly");

const notices = readFileSync("THIRD-PARTY-NOTICES.md", "utf8");
const goAttributionManifest = JSON.parse(readFileSync("LICENSES/go-modules/manifest.json", "utf8"));
for (const component of ["Trivy", "ORAS Go v2", "rclone", "Docker CLI", "Docker Compose", "Go standard library"]) {
  if (!notices.includes(`| ${component} |`)) fail(`THIRD-PARTY-NOTICES.md: missing bundled runtime tool ${component}`);
}
const legalReview = goAttributionManifest.review;
if (!["pending", "approved"].includes(legalReview?.status)) {
  fail("LICENSES/go-modules/manifest.json: legal-review status must be pending or approved");
} else if (!notices.includes(`Legal review status: ${legalReview.status}.`)) {
  fail("THIRD-PARTY-NOTICES.md: legal-review status must match the Go attribution manifest");
} else if (legalReview.status === "approved"
    && (!notices.includes(`recorded by ${legalReview.approvedBy} at ${legalReview.approvedAt}.`))) {
  fail("THIRD-PARTY-NOTICES.md: approved legal-review evidence must match the Go attribution manifest");
}
if (!notices.includes("/licenses/third-party/go-buildinfo/")
    || !notices.includes("/licenses/third-party/go-modules/")) {
  fail("THIRD-PARTY-NOTICES.md: linked Go module inventory and attribution bundle must be explicit");
}

if (failures.length > 0) {
  throw new Error(`Release workflow validation failed:\n${failures.join("\n")}`);
}

console.log("Release workflows preserve the four-image build, exact scan, aggregate gate, and promotion invariants.");
