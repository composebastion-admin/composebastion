import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { dockerBindPathRelativeChild } from "./bind-paths.mjs";
import {
  acceptanceNonqualifyingReasons,
  acceptanceOwnsDockerResource,
  cleanupEvidenceFailures,
  composeProjectImageListArguments,
  ownedCandidateImageTags,
  requireImageComposeProject
} from "./qualification-policy.mjs";
import { acceptanceScenarioManifest } from "./scenario-manifest.mjs";
import { acceptanceUpgradeBaselines, acceptanceUpgradeBridge } from "./upgrade-baselines.mjs";
import { assertSafeTestResultsPath, digestGitBuildContext, materializeGitBuildContext } from "../materialize-git-context.mjs";
import { validateGoAttributionReview } from "../go-attribution-review.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const resultsDir = assertSafeTestResultsPath({
  repositoryRoot: root,
  destination: path.join(root, "test-results", "acceptance"),
  label: "Acceptance results directory"
});
const composeFile = path.join(root, "docker-compose.acceptance.yml");
const productionImageComposeFile = path.join(root, "docker-compose.image.yml");
const sourceAcceptanceComposeFile = path.join(root, "docker-compose.acceptance.source.yml");
const upgradeAcceptanceComposeFile = path.join(root, "docker-compose.acceptance.upgrade.yml");
const managerHardeningFile = path.join(root, "docker-compose.hardened.yml");
const agentHardeningFile = path.join(root, "agent-compose.hardened.yml");
const candidateVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
async function composeControlNames(files) {
  const names = new Set();
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    for (const match of contents.matchAll(/\$\{([A-Z0-9_]+)/g)) names.add(match[1]);
  }
  return Object.freeze([...names].sort());
}
const requiredImageComposeControls = await composeControlNames([productionImageComposeFile, composeFile]);
const requiredHardenedComposeControls = await composeControlNames([
  productionImageComposeFile,
  composeFile,
  managerHardeningFile,
  agentHardeningFile
]);
const requiredSourceComposeControls = await composeControlNames([
  path.join(root, "docker-compose.yml"),
  path.join(root, "docker-compose.prod.example.yml"),
  sourceAcceptanceComposeFile
]);
const goAttributionManifest = JSON.parse(await readFile(path.join(root, "LICENSES/go-modules/manifest.json"), "utf8"));
function goModuleLegalReviewGate(review) {
  const validated = validateGoAttributionReview(review);
  if (validated.status === "pending") {
    return {
      id: "go-module-legal-review",
      status: "manual-required",
      detail: "Review linked Go module inventories and any additional attribution obligations"
    };
  }
  return {
    id: "go-module-legal-review",
    status: "approved",
    detail: `Approved by ${validated.approvedBy} at ${validated.approvedAt}`
  };
}
const goLegalReviewGate = goModuleLegalReviewGate(goAttributionManifest.review);
const externalImageReferences = Object.freeze([
  ...acceptanceUpgradeBaselines.map((baseline) => baseline.pinnedImage),
  process.env.COMPOSEBASTION_ACCEPTANCE_BRIDGE_IMAGE || acceptanceUpgradeBridge.pinnedImage,
  "node:24-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a",
  "golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2",
  "alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b",
  "alpine:3.20.8@sha256:765942a4039992336de8dd5db680586e1a206607dd06170ff0a37267a9e01958",
  "postgres:16.6-alpine3.20@sha256:1e59919c179e296eaf3cc701f4d50bab5c393d7ed9746c188c9d519489c998dc",
  "redis:7.4.1-alpine3.20@sha256:c1e88455c85225310bbea54816e9c3f4b5295815e6dbf80c34d40afc6df28275",
  "axllent/mailpit:v1.21.8@sha256:81370195cd4a0eab9604d17c2617a7525b0486f9365555253b6c5376c6350f1a",
  "minio/minio:RELEASE.2024-12-18T13-15-44Z@sha256:1dce27c494a16bae114774f1cec295493f3613142713130c2d22dd5696be6ad3",
  "dockurr/samba:4.21.10@sha256:fe867f409d3601a2d89b2a6a6da1e4b82dbeb6d04c7a0fcd44488d87058bfe33",
  "registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"
]);
const keep = process.argv.includes("--keep");
const skipBuild = process.argv.includes("--skip-build");
const skipUpgrade = process.argv.includes("--skip-upgrade");
const allowNonqualifying = process.argv.includes("--allow-nonqualifying");

// Keep subprocesses deterministic and prevent unrelated shell or .env values
// from changing a release-qualification run. Docker context, local path/temp,
// locale, certificate, SSH-agent, and proxy settings are the only inherited
// host controls needed to reach the selected Docker daemon and public images.
const inheritedEnvironmentKeys = Object.freeze([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE",
  "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR",
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY", "DOCKER_API_VERSION",
  "SSH_AUTH_SOCK",
  "COMPOSEBASTION_ACCEPTANCE_BRIDGE_IMAGE",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy"
]);
const inheritedSensitiveEnvironmentKeys = Object.freeze(new Set([
  "DOCKER_HOST", "DOCKER_CONTEXT",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy"
]));

function curateHostEnvironment(source) {
  const curated = {};
  for (const name of inheritedEnvironmentKeys) {
    if (source[name] !== undefined && source[name] !== "") curated[name] = source[name];
  }
  curated.PATH ??= "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return curated;
}

const hostEnvironment = Object.freeze(curateHostEnvironment(process.env));

function gitCapture(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    env: { ...hostEnvironment, GIT_NO_REPLACE_OBJECTS: "1" },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

const candidateRevision = gitCapture(["rev-parse", "--verify", "HEAD^{commit}"]);
const candidateTree = gitCapture(["rev-parse", "--verify", "HEAD^{tree}"]);
const candidateBuildDate = gitCapture(["show", "-s", "--format=%cI", "HEAD"]);
const candidateBranch = gitCapture(["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
const worktreeStatus = gitCapture(["status", "--porcelain=v1", "--untracked-files=all"]);
const worktreeDirty = worktreeStatus !== "";
const dirtyEntryCount = worktreeDirty ? worktreeStatus.split(/\r?\n/).length : 0;
const dirtyStatusDigest = worktreeDirty
  ? `sha256:${createHash("sha256").update(worktreeStatus).digest("hex")}`
  : null;
if (!/^[a-f0-9]{40}$/.test(candidateRevision) || !/^[a-f0-9]{40}$/.test(candidateTree)) {
  throw new Error("Acceptance requires a Git checkout with full SHA-1 commit and tree identities");
}
if (Number.isNaN(Date.parse(candidateBuildDate))) throw new Error(`Invalid HEAD commit timestamp: ${candidateBuildDate}`);

const nonqualifyingReasons = acceptanceNonqualifyingReasons({
  worktreeDirty,
  skipBuild,
  skipUpgrade,
  allowNonqualifying,
  keep
});

const portBase = Number(process.env.ACCEPTANCE_PORT_BASE ?? 18000);
if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 64535) throw new Error("ACCEPTANCE_PORT_BASE must be an integer between 1024 and 64535");
const candidateTags = ownedCandidateImageTags({ revision: candidateRevision, portBase });
const candidateImage = candidateTags.app;
const candidateAgentImage = candidateTags.agent;
const runtimeDir = path.join(resultsDir, `runtime-${portBase}`);
const candidateBuildContext = path.join(runtimeDir, "git-build-context");
const acceptanceBindDir = `/tmp/composebastion-acceptance-${portBase}-bind`;
const acceptanceExternalBindDir = `${acceptanceBindDir}/external`;
const acceptanceComposeDir = `${acceptanceBindDir}/compose-workload`;
const scenarioBackupDir = (scenario) => path.join(runtimeDir, `${scenario}-backups`);
const workloadPrefix = `cbacceptance${portBase}`;
const workloadProject = `${workloadPrefix}app`;
const workloadVolumeMarker = `volume-${randomUUID()}`;
const workloadBindMarker = `bind-${randomUUID()}`;
const workloadRelativeBindMarker = `relative-bind-${randomUUID()}`;
const projectName = (scenario) => `composebastion-acceptance-${portBase}-${scenario}`;
const failureLogPath = path.join(resultsDir, "failure.log");
const liveBrowserEvidencePath = path.join(resultsDir, `live-browser-${candidateRevision}-${portBase}.json`);
const configuredSubnet = process.env.ACCEPTANCE_WORKLOAD_SUBNET
  ?? `10.${Math.floor(portBase / 256)}.${portBase % 256}.0/24`;
const subnetMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/.exec(configuredSubnet);
if (!subnetMatch) throw new Error("ACCEPTANCE_WORKLOAD_SUBNET must be a private IPv4 /24 ending in .0/24");
const subnetOctets = subnetMatch.slice(1).map(Number);
const privateSubnet = subnetOctets[0] === 10
  || (subnetOctets[0] === 172 && subnetOctets[1] >= 16 && subnetOctets[1] <= 31)
  || (subnetOctets[0] === 192 && subnetOctets[1] === 168);
if (subnetOctets.some((value) => value < 0 || value > 255) || !privateSubnet) {
  throw new Error("ACCEPTANCE_WORKLOAD_SUBNET must be an RFC1918 IPv4 /24");
}
const workloadAddressPrefix = subnetOctets.join(".");
const report = {
  candidateVersion,
  source: {
    headSha: candidateRevision,
    treeSha: candidateTree,
    branch: candidateBranch,
    commitTimestamp: candidateBuildDate,
    dirty: worktreeDirty,
    dirtyEntryCount,
    dirtyStatusDigest,
    contextIdentity: `git:${candidateRevision}:tree:${candidateTree}:${worktreeDirty ? `dirty:${dirtyStatusDigest}` : "clean"}`,
    buildContext: null,
    finalHeadSha: null,
    finalTreeSha: null,
    finalDirty: null,
    finalDirtyEntryCount: null,
    finalDirtyStatusDigest: null,
    identityStable: null,
    finalBuildContextDigest: null,
    finalBuildContextFileCount: null,
    buildContextStable: null
  },
  candidateImages: null,
  cleanup: {
    attempted: false,
    verified: false,
    projectResourcesChecked: false,
    workloadResourcesChecked: false,
    candidateImagesChecked: false,
    externalImagesChecked: false,
    runtimeInputsChecked: false,
    storageChecked: false,
    runtimeRemoved: false,
    bindRemoved: false,
    containers: [],
    images: [],
    networks: [],
    volumes: [],
    files: [],
    runtimeInputFiles: [],
    backupArtifacts: [],
    storageObjects: [],
    candidateTags: [],
    errors: []
  },
  acceptanceManifest: acceptanceScenarioManifest,
  releaseQualification: {
    automatedAcceptanceQualifying: false,
    manifestComplete: false,
    nonqualifyingReasons,
    deferredGates: [
      { id: "real-nas", status: "manual-required", detail: "Validate capture, verification, and restore against a real NAS" },
      { id: "real-cloud", status: "manual-required", detail: "Validate capture, verification, and restore against a real cloud/S3 target" },
      goLegalReviewGate
    ]
  },
  startedAt: new Date().toISOString(),
  completedAt: null,
  status: "running",
  environment: {
    portBase,
    workloadSubnet: configuredSubnet,
    platform: `${process.platform}/${process.arch}`,
    skipBuild,
    skipUpgrade,
    allowNonqualifying,
    keep,
    projects: {
      fresh: projectName("fresh"),
      source: projectName("source"),
      hardened: projectName("hardened"),
      currentStableUpgrade: projectName("upgrade-current-stable"),
      legacyUpgrade: projectName("upgrade-legacy")
    }
  },
  scenarios: []
};

const token = (bytes = 24) => randomBytes(bytes).toString("hex");
const fixture = {
  appSecret: token(32),
  postgresPassword: token(24),
  minioUser: `cb${token(6)}`,
  minioPassword: token(24),
  sambaUser: `cb${token(5)}`,
  sambaPassword: token(18),
  registryUser: `cb${token(5)}`,
  registryPassword: token(24),
  agentToken: token(32),
  ownerPassword: `Cb!${randomBytes(18).toString("base64url")}9a`,
  viewerPassword: `Vw!${randomBytes(18).toString("base64url")}7z`,
  operatorPassword: `Op!${randomBytes(18).toString("base64url")}8y`,
  adminPassword: `Ad!${randomBytes(18).toString("base64url")}6x`,
  workloadPassword: token(18),
  publicMarker: `upgrade-${token(6)}`
};
const sensitiveValues = new Set(Object.values(fixture).filter(Boolean).map(String));
for (const name of inheritedSensitiveEnvironmentKeys) {
  const value = hostEnvironment[name];
  if (value) sensitiveValues.add(String(value));
}

let sshPrivateKey = "";
let sshPublicKey = "";
let activeProject = null;
let activeEnv = null;
let sessionCookie = "";
let operatorSessionCookie = "";
let registryAuthFile = "";
let failureLogsCaptured = false;
let ownsRuntimeFixtures = false;
let gitBuildContextEvidence = null;
let externalImageBaseline = null;

function activePort(name, fallback) {
  return Number(activeEnv?.[name] ?? fallback);
}

function activeBaseUrl() {
  return `http://127.0.0.1:${activePort("ACCEPTANCE_HTTP_PORT", portBase + 80)}`;
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Acceptance port ${port} is already in use; choose another ACCEPTANCE_PORT_BASE`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

function redact(value) {
  let text = String(value ?? "");
  const values = sshPrivateKey ? [...sensitiveValues, sshPrivateKey] : [...sensitiveValues];
  for (const secret of values) {
    const variants = [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      Buffer.from(secret).toString("base64")
    ];
    for (const variant of variants) {
      if (variant) text = text.split(variant).join(secret === sshPrivateKey ? "[REDACTED-SSH-KEY]" : "[REDACTED]");
    }
  }
  return text;
}

function rememberSecret(value) {
  if (value) sensitiveValues.add(String(value));
}

function runtimeSecret(bytes = 24) {
  const value = token(bytes);
  rememberSecret(value);
  return value;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? hostEnvironment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (options.inherit) process.stdout.write(redact(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (options.inherit) process.stderr.write(redact(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      reject(new Error(redact(`${command} ${args.join(" ")} failed (${code})\n${stderr || stdout}`)));
    });
  });
}

async function setManagerBackupDirectoryOwnership(backupDir, mode) {
  const resolvedBackupDir = path.resolve(backupDir);
  const resolvedRuntimeDir = path.resolve(runtimeDir);
  if (
    resolvedBackupDir === resolvedRuntimeDir
    || !resolvedBackupDir.startsWith(`${resolvedRuntimeDir}${path.sep}`)
  ) {
    throw new Error(
      `Acceptance backup directory escapes the owned runtime: ${resolvedBackupDir}`
    );
  }
  const candidateAppId = report.candidateImages?.app?.id;
  assert(
    candidateAppId,
    "candidate app image identity is unavailable for backup ownership"
  );
  await run("docker", [
    "run", "--rm", "--user", "0:0",
    "--volume", `${resolvedBackupDir}:/data/backups`,
    candidateAppId,
    "sh", "-ceu",
    mode === "manager"
      ? "chown -R 1000:1000 /data/backups; chmod -R u+rwX,g-rwx,o-rwx /data/backups"
      : "chmod -R a+rwX /data/backups"
  ]);
}

function compose(project, env, args, options = {}) {
  assertExplicitComposeControls(env, requiredImageComposeControls, "production image acceptance Compose");
  return composeWithFiles(project, env, [productionImageComposeFile, composeFile], args, options);
}

function upgradeCompose(project, env, publicComposeFile, args, options = {}) {
  assertExplicitComposeControls(env, requiredImageComposeControls, "pre-1.2 upgrade acceptance Compose");
  return composeWithFiles(project, env, [publicComposeFile, upgradeAcceptanceComposeFile], args, options);
}

function composeWithFiles(project, env, files, args, options = {}) {
  return run("docker", [
    "compose", "--env-file", "/dev/null", "--project-name", project,
    ...files.flatMap((file) => ["--file", file]),
    ...args
  ], {
    ...options,
    env
  });
}

async function inspectComposeServiceImage(composeAction, service, {
  expectedId,
  expectedReference,
  expectedRevision,
  expectedCreated
} = {}) {
  const selected = await composeAction(["ps", "--quiet", service]);
  const containerIds = selected.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  assert(containerIds.length === 1, `${service} resolved to ${containerIds.length} containers`);
  const inspected = await run("docker", ["container", "inspect", containerIds[0], "--format", "{{json .}}"]);
  const detail = JSON.parse(inspected.stdout);
  const imageId = detail.Image;
  const configuredImage = detail.Config?.Image ?? null;
  if (expectedId) assert(imageId === expectedId, `${service} uses image ${imageId}, expected ${expectedId}`);
  if (expectedReference) {
    assert(configuredImage === expectedReference, `${service} is configured with ${configuredImage}, expected ${expectedReference}`);
  }
  const image = JSON.parse((await run("docker", ["image", "inspect", imageId, "--format", "{{json .}}"])).stdout);
  const labels = image.Config?.Labels ?? {};
  if (expectedRevision) {
    assert(labels["org.opencontainers.image.revision"] === expectedRevision,
      `${service} image revision is ${labels["org.opencontainers.image.revision"] ?? "missing"}, expected ${expectedRevision}`);
  }
  if (expectedCreated) {
    assert(labels["org.opencontainers.image.created"] === expectedCreated,
      `${service} image created label is ${labels["org.opencontainers.image.created"] ?? "missing"}, expected ${expectedCreated}`);
  }
  return {
    containerId: containerIds[0],
    configuredImage,
    id: imageId,
    revision: labels["org.opencontainers.image.revision"] ?? null,
    created: labels["org.opencontainers.image.created"] ?? null
  };
}

async function assertActiveCandidateServiceImage(service, kind = "app") {
  const expected = report.candidateImages?.[kind];
  assert(expected?.id, `candidate ${kind} image identity is unavailable`);
  return inspectComposeServiceImage(
    (args, options) => compose(activeProject, activeEnv, args, options),
    service,
    {
      expectedId: expected.id,
      expectedReference: kind === "agent" ? candidateAgentImage : candidateImage,
      expectedRevision: candidateRevision,
      expectedCreated: candidateBuildDate
    }
  );
}

function assertExplicitComposeControls(env, requiredControls, label) {
  const missing = requiredControls.filter((name) => !Object.hasOwn(env, name) || env[name] === undefined);
  if (missing.length > 0) throw new Error(`${label} is missing explicit controls: ${missing.join(", ")}`);
}

async function record(id, action) {
  const manifestEntry = acceptanceScenarioManifest.find((entry) => entry.id === id);
  if (!manifestEntry) throw new Error(`Unknown acceptance scenario ${id}`);
  if (report.scenarios.some((item) => item.id === id)) throw new Error(`Acceptance scenario ${id} was recorded more than once`);
  const item = { id, name: manifestEntry.name, status: "running", startedAt: new Date().toISOString(), durationMs: 0 };
  report.scenarios.push(item);
  const started = Date.now();
  process.stdout.write(`\n[acceptance] ${item.name}\n`);
  try {
    const detail = await action();
    item.status = "passed";
    if (detail !== undefined) item.detail = detail;
  } catch (error) {
    item.status = "failed";
    item.error = redact(error instanceof Error ? error.message : error);
    throw error;
  } finally {
    item.durationMs = Date.now() - started;
  }
}

function evidenceValue(detail, pathExpression) {
  return pathExpression.split(".").reduce((value, key) => value?.[key], detail);
}

function hasEvidence(value) {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function validateScenarioManifest() {
  const failures = [];
  for (const expected of acceptanceScenarioManifest) {
    const items = report.scenarios.filter((item) => item.id === expected.id);
    if (items.length !== 1) {
      failures.push(`${expected.id}: expected exactly one report entry, found ${items.length}`);
      continue;
    }
    const item = items[0];
    if (item.status === "skipped") continue;
    if (item.status !== "passed") {
      failures.push(`${expected.id}: status is ${item.status}`);
      continue;
    }
    for (const evidencePath of expected.requiredEvidence) {
      if (!hasEvidence(evidenceValue(item.detail, evidencePath))) {
        failures.push(`${expected.id}: missing required evidence ${evidencePath}`);
      }
    }
  }
  report.releaseQualification.manifestComplete = failures.length === 0
    && report.scenarios.every((item) => item.status === "passed");
  if (failures.length > 0) throw new Error(`Acceptance scenario manifest failed:\n${failures.join("\n")}`);
  return report.releaseQualification.manifestComplete;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readRegularFileNoFollow(filePath, { expectedMode, label = "acceptance file" } = {}) {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    assert(metadata.isFile(), `${label} is not a regular file`);
    if (expectedMode !== undefined) {
      assert((metadata.mode & 0o777) === expectedMode,
        `${label} mode is ${(metadata.mode & 0o777).toString(8)}, expected ${expectedMode.toString(8)}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function markNonqualifying(reason) {
  if (!report.releaseQualification.nonqualifyingReasons.includes(reason)) {
    report.releaseQualification.nonqualifyingReasons.push(reason);
  }
  report.releaseQualification.automatedAcceptanceQualifying = false;
}

function finalizeSourceEvidence() {
  const finalHeadSha = gitCapture(["rev-parse", "--verify", "HEAD^{commit}"]);
  const finalTreeSha = gitCapture(["rev-parse", "--verify", "HEAD^{tree}"]);
  const finalStatus = gitCapture(["status", "--porcelain=v1", "--untracked-files=all"]);
  const finalDirty = finalStatus !== "";
  const finalDirtyEntryCount = finalDirty ? finalStatus.split(/\r?\n/).length : 0;
  const finalDirtyStatusDigest = finalDirty
    ? `sha256:${createHash("sha256").update(finalStatus).digest("hex")}`
    : null;
  const identityStable = finalHeadSha === candidateRevision
    && finalTreeSha === candidateTree
    && finalStatus === worktreeStatus;
  let finalBuildContextDigest = null;
  let finalBuildContextFileCount = null;
  let buildContextStable = false;
  if (gitBuildContextEvidence) {
    try {
      const finalBuildContext = digestGitBuildContext(candidateBuildContext);
      finalBuildContextDigest = finalBuildContext.digest;
      finalBuildContextFileCount = finalBuildContext.fileCount;
      buildContextStable = finalBuildContextDigest === gitBuildContextEvidence.contextDigest
        && finalBuildContextFileCount === gitBuildContextEvidence.fileCount;
    } catch {
      buildContextStable = false;
    }
  }
  Object.assign(report.source, {
    finalHeadSha,
    finalTreeSha,
    finalDirty,
    finalDirtyEntryCount,
    finalDirtyStatusDigest,
    identityStable,
    finalBuildContextDigest,
    finalBuildContextFileCount,
    buildContextStable
  });
  if (!identityStable) {
    markNonqualifying("The Git HEAD or working-tree identity changed while acceptance was running");
  }
  if (!buildContextStable) {
    markNonqualifying("The exact Git-derived Docker build context was missing or changed while acceptance was running");
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function pathExists(location) {
  try {
    await access(location);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function retry(label, action, { attempts = 60, delayMs = 1_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`${label} did not become ready: ${redact(lastError instanceof Error ? lastError.message : lastError)}`);
}

function managerComposeControls({
  httpPort,
  backupDir,
  corsOrigin,
  allowPrivateAgentUrls,
  allowPrivateWebhookUrls,
  blockPrivateS3Endpoints,
  backupHostPathAllowedRoots,
  smtpHost
}) {
  return {
    COMPOSE_DISABLE_ENV_FILE: "1",
    COMPOSEBASTION_IMAGE: "composebastion-app",
    COMPOSEBASTION_VERSION: candidateVersion,
    APP_SECRET: fixture.appSecret,
    POSTGRES_PASSWORD: fixture.postgresPassword,
    DATABASE_URL: "",
    REDIS_URL: "redis://redis:6379",
    COMPOSEBASTION_BACKUP_DIR: backupDir,
    COMPOSEBASTION_HTTP_BIND_ADDRESS: "127.0.0.1",
    COMPOSEBASTION_HTTP_PORT: String(httpPort),
    CORS_ORIGINS: corsOrigin,
    SECURE_COOKIES: "false",
    TRUST_PROXY: "false",
    ALLOW_PRIVATE_AGENT_URLS: allowPrivateAgentUrls ? "true" : "false",
    ALLOW_PRIVATE_WEBHOOK_URLS: allowPrivateWebhookUrls ? "true" : "false",
    BLOCK_PRIVATE_S3_ENDPOINTS: blockPrivateS3Endpoints ? "true" : "false",
    BACKUP_ENCRYPTION_KEYS: "",
    BACKUP_ENCRYPTION_ACTIVE_KEY_ID: "app_secret",
    BACKUP_HOST_PATH_ALLOWED_ROOTS: backupHostPathAllowedRoots,
    IMAGE_SCANNER_PROVIDER: "auto",
    SMTP_HOST: smtpHost,
    SMTP_PORT: "1025",
    SMTP_USER: "",
    SMTP_PASS: "",
    SMTP_FROM: "acceptance@composebastion.invalid",
    HOST_CHECK_INTERVAL_MS: "10000",
    INVENTORY_SYNC_INTERVAL_MS: "60000"
  };
}

function acceptanceEnv(image = candidateImage, overrides = {}) {
  const scenario = overrides.ACCEPTANCE_SCENARIO ?? "fresh";
  const httpPort = String(overrides.ACCEPTANCE_HTTP_PORT ?? (portBase + 80));
  return {
    ...hostEnvironment,
    ...managerComposeControls({
      httpPort,
      backupDir: scenarioBackupDir(scenario),
      corsOrigin: `http://127.0.0.1:${httpPort}`,
      allowPrivateAgentUrls: true,
      allowPrivateWebhookUrls: true,
      blockPrivateS3Endpoints: false,
      backupHostPathAllowedRoots: acceptanceBindDir,
      smtpHost: "mailpit"
    }),
    COMPOSEBASTION_ACCEPTANCE_IMAGE: image,
    COMPOSEBASTION_ACCEPTANCE_AGENT_IMAGE: candidateAgentImage,
    MINIO_ROOT_USER: fixture.minioUser,
    MINIO_ROOT_PASSWORD: fixture.minioPassword,
    SAMBA_USER: fixture.sambaUser,
    SAMBA_PASSWORD: fixture.sambaPassword,
    REGISTRY_USER: fixture.registryUser,
    REGISTRY_PASSWORD: fixture.registryPassword,
    ACCEPTANCE_REGISTRY_AUTH_FILE: registryAuthFile,
    COMPOSEBASTION_SSH_AUTHORIZED_KEYS: sshPublicKey,
    ACCEPTANCE_HTTP_PORT: httpPort,
    ACCEPTANCE_MAILPIT_PORT: String(portBase + 25),
    ACCEPTANCE_MINIO_PORT: String(portBase + 1000),
    ACCEPTANCE_REGISTRY_PORT: String(portBase + 50),
    ACCEPTANCE_AGENT_PORT: String(portBase + 90),
    ACCEPTANCE_HARDENED_AGENT_PORT: String(portBase + 590),
    ACCEPTANCE_BIND_DIR: acceptanceBindDir,
    AGENT_TOKEN: fixture.agentToken,
    AGENT_READ_RATE_LIMIT: "221",
    AGENT_RUN_RATE_LIMIT: "43",
    AGENT_FILE_RATE_LIMIT: "79",
    AGENT_STREAM_RATE_LIMIT: "17",
    ...overrides
  };
}

async function api(pathname, { method = "GET", body, cookie = sessionCookie, baseUrl = activeBaseUrl() } = {}) {
  // The acceptance client only sends fixture data to its isolated loopback
  // Compose stack. It is never a general-purpose file-to-network transport.
  const parsedBaseUrl = new URL(baseUrl);
  assert(["127.0.0.1", "localhost", "[::1]"].includes(parsedBaseUrl.hostname), `acceptance API base URL must be loopback, received ${parsedBaseUrl.hostname}`);
  const headers = { accept: "application/json", origin: baseUrl };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) throw new Error(`${method} ${pathname} returned ${response.status}: ${redact(raw)}`);
  const setCookie = response.headers.get("set-cookie");
  const session = setCookie?.split(";", 1)[0] ?? "";
  rememberSecret(session);
  rememberSecret(session.includes("=") ? session.slice(session.indexOf("=") + 1) : "");
  return { data, setCookie: session };
}

async function waitForApiVersion(expected) {
  return retry(`API ${expected}`, async () => {
    const response = await fetch(`${activeBaseUrl()}/api/health`);
    if (!response.ok) throw new Error(`health returned ${response.status}`);
    const body = await response.json();
    assert(body.version === expected, `expected runtime ${expected}, received ${body.version}`);
    return body;
  }, { attempts: 120, delayMs: 1_000 });
}

async function waitForReadiness(label = "API readiness") {
  return retry(label, async () => {
    const response = await fetch(`${activeBaseUrl()}/api/health/ready`);
    const body = await response.json();
    assert(response.status === 200 && body.ok === true, `readiness returned ${response.status}`);
    return body;
  }, { attempts: 120, delayMs: 1_000 });
}

async function setupOwner({ includeDemoData = false } = {}) {
  const state = await api("/api/auth/setup-state");
  assert(state.data.needsSetup === true, "fresh installation did not request first-run setup");
  const setup = await api("/api/auth/setup", {
    method: "POST",
    cookie: "",
    body: {
      name: "Acceptance Owner",
      username: "acceptance-owner",
      email: "acceptance@composebastion.invalid",
      password: fixture.ownerPassword,
      includeDemoData
    }
  });
  assert(setup.setCookie.startsWith("cb_session="), "setup did not establish a session");
  sessionCookie = setup.setCookie;
}

async function loginOwner() {
  const login = await api("/api/auth/login", {
    method: "POST",
    cookie: "",
    body: { identifier: "acceptance-owner", password: fixture.ownerPassword }
  });
  assert(login.setCookie.startsWith("cb_session="), "login did not establish a session");
  sessionCookie = login.setCookie;
  return login.data.user;
}

async function runLiveBrowserSuite() {
  const outputDir = path.join(runtimeDir, "playwright-live-qualification");
  const jsonReport = path.join(outputDir, "results.json");
  await run("npm", ["run", "smoke:web:live:qualification"], {
    inherit: true,
    env: {
      ...hostEnvironment,
      COMPOSEBASTION_LIVE_BASE_URL: activeBaseUrl(),
      COMPOSEBASTION_LIVE_USERNAME: "acceptance-owner",
      COMPOSEBASTION_LIVE_PASSWORD: fixture.ownerPassword,
      COMPOSEBASTION_LIVE_VERSION: candidateVersion,
      COMPOSEBASTION_LIVE_OUTPUT_DIR: outputDir,
      COMPOSEBASTION_LIVE_JSON_REPORT: jsonReport
    }
  });
  const result = JSON.parse(await readFile(jsonReport, "utf8"));
  const expectedProjects = {
    chromiumDesktop: "chromium-live",
    chromiumMobile: "chromium-live-mobile",
    firefoxDesktop: "firefox-live-critical",
    firefoxMobile: "firefox-live-mobile-critical",
    webkitDesktop: "webkit-live-critical",
    webkitMobile: "webkit-live-mobile-critical"
  };
  const configuredProjects = new Set((result.config?.projects ?? []).map((project) => project.name));
  const tests = [];
  const collectTests = (suites) => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) tests.push(...(spec.tests ?? []));
      collectTests(suite.suites);
    }
  };
  collectTests(result.suites);
  const matrix = {};
  for (const [key, projectName] of Object.entries(expectedProjects)) {
    assert(configuredProjects.has(projectName), `live browser result omitted project ${projectName}`);
    const projectTests = tests.filter((item) => item.projectName === projectName);
    assert(projectTests.length > 0, `live browser project ${projectName} ran no tests`);
    assert(projectTests.every((item) =>
      item.status === "expected" && item.results?.at(-1)?.status === "passed"
    ), `live browser project ${projectName} was skipped, flaky, or failed`);
    matrix[key] = { project: projectName, tests: projectTests.length, passed: true };
  }
  assert((result.errors ?? []).length === 0, "live browser qualification reported top-level errors");
  const evidence = {
    realBrowser: true,
    database: true,
    redis: true,
    worker: true,
    readOnlyQualificationSmoke: true,
    projectCount: Object.keys(expectedProjects).length,
    matrix,
    rawSecretBearingArtifactsExcluded: true
  };
  const evidenceJson = redact(`${JSON.stringify(evidence, null, 2)}\n`);
  const evidenceFile = path.basename(liveBrowserEvidencePath);
  await writeFile(liveBrowserEvidencePath, evidenceJson, { mode: 0o600 });
  return {
    ...evidence,
    evidenceFile,
    evidenceSha256: `sha256:${createHash("sha256").update(evidenceJson).digest("hex")}`
  };
}

async function verifyRoleBoundaries() {
  const ownerCookie = sessionCookie;
  for (const [role, password] of [
    ["viewer", fixture.viewerPassword],
    ["operator", fixture.operatorPassword],
    ["admin", fixture.adminPassword]
  ]) {
    await api("/api/users", {
      method: "POST",
      body: { name: `Acceptance ${role}`, email: `${role}@composebastion.invalid`, password, role }
    });
  }

  const viewerLogin = await api("/api/auth/login", {
    method: "POST",
    cookie: "",
    body: { identifier: "viewer@composebastion.invalid", password: fixture.viewerPassword }
  });
  const forbidden = await fetch(`${activeBaseUrl()}/api/image-tags?image=nginx`, {
    headers: { cookie: viewerLogin.setCookie, origin: activeBaseUrl() }
  });
  assert(forbidden.status === 403, `viewer image tag lookup returned ${forbidden.status}`);

  const operatorLogin = await api("/api/auth/login", {
    method: "POST",
    cookie: "",
    body: { identifier: "operator@composebastion.invalid", password: fixture.operatorPassword }
  });
  operatorSessionCookie = operatorLogin.setCookie;
  const operatorUsers = await fetch(`${activeBaseUrl()}/api/users`, {
    headers: { cookie: operatorLogin.setCookie, origin: activeBaseUrl() }
  });
  assert(operatorUsers.status === 403, `operator user administration returned ${operatorUsers.status}`);

  const adminLogin = await api("/api/auth/login", {
    method: "POST",
    cookie: "",
    body: { identifier: "admin@composebastion.invalid", password: fixture.adminPassword }
  });
  const adminUsers = await fetch(`${activeBaseUrl()}/api/users`, {
    headers: { cookie: adminLogin.setCookie, origin: activeBaseUrl() }
  });
  assert(adminUsers.status === 200, `admin user administration returned ${adminUsers.status}`);
  sessionCookie = ownerCookie;
  return { viewerForbidden: true, operatorForbiddenFromAdmin: true, adminAllowed: true };
}

async function waitForJob(id, { timeoutMs = 10 * 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api(`/api/jobs/${id}`);
    const job = response.data.job;
    if (job.status === "completed") return job;
    if (["failed", "canceled"].includes(job.status)) {
      throw new Error(`job ${job.type} ${job.status}: ${redact(job.error ?? "unknown error")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`job ${id} timed out`);
}

async function prepareSshKey() {
  await mkdir(runtimeDir, { recursive: true });
  const keyPath = path.join(runtimeDir, "id_ed25519");
  await rm(keyPath, { force: true });
  await rm(`${keyPath}.pub`, { force: true });
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "composebastion-acceptance", "-f", keyPath]);
  sshPrivateKey = await readFile(keyPath, "utf8");
  sshPublicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
}

async function prepareRegistryCredentials() {
  const { hash } = await import("bcryptjs");
  registryAuthFile = path.join(runtimeDir, "registry.htpasswd");
  const passwordHash = await hash(fixture.registryPassword, 10);
  const htpasswd = `${fixture.registryUser}:${passwordHash}`;
  rememberSecret(Buffer.from(`${fixture.registryUser}:${fixture.registryPassword}`).toString("base64"));
  rememberSecret(passwordHash);
  rememberSecret(htpasswd);
  await writeFile(registryAuthFile, `${htpasswd}\n`, { mode: 0o600 });
}

async function registryRequest(pathname, init = {}) {
  const port = activePort("ACCEPTANCE_REGISTRY_PORT", portBase + 50);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Basic ${Buffer.from(`${fixture.registryUser}:${fixture.registryPassword}`).toString("base64")}`);
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers });
  if (!response.ok) throw new Error(`registry ${init.method ?? "GET"} ${pathname} returned ${response.status}: ${await response.text()}`);
  return response;
}

async function seedRegistry() {
  await retry("authenticated registry", async () => registryRequest("/v2/"), { attempts: 60, delayMs: 1_000 });
  const config = JSON.stringify({ architecture: "amd64", os: "linux", config: {}, rootfs: { type: "layers", diff_ids: [] }, history: [] });
  const digest = `sha256:${createHash("sha256").update(config).digest("hex")}`;
  const upload = await registryRequest("/v2/acceptance/test/blobs/uploads/", { method: "POST" });
  const location = upload.headers.get("location");
  assert(location, "registry blob upload did not return a location");
  const uploadUrl = new URL(location, `http://127.0.0.1:${activePort("ACCEPTANCE_REGISTRY_PORT", portBase + 50)}`);
  uploadUrl.searchParams.set("digest", digest);
  await registryRequest(`${uploadUrl.pathname}${uploadUrl.search}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: config
  });
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest, size: Buffer.byteLength(config) },
    layers: []
  });
  await registryRequest("/v2/acceptance/test/manifests/1.0.0", {
    method: "PUT",
    headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" },
    body: manifest
  });
}

async function verifyRegistryBoundary() {
  assert(operatorSessionCookie.startsWith("cb_session="), "operator session was not retained for registry acceptance");
  // This fixture is deliberately reachable and contains a valid tag. A
  // successful response before it is saved would therefore prove the private
  // network guard was bypassed, unlike testing an unused/closed port.
  const image = "registry:5000/acceptance/test";
  const blocked = await fetch(`${activeBaseUrl()}/api/image-tags?image=${encodeURIComponent(image)}`, {
    headers: { cookie: operatorSessionCookie, origin: activeBaseUrl() }
  });
  let blockedBody = {};
  try { blockedBody = await blocked.json(); } catch { /* Status is authoritative. */ }
  assert(
    blocked.status === 400 && blockedBody.code === "PRIVATE_REGISTRY_ADDRESS",
    `unsaved reachable private registry returned ${blocked.status}/${blockedBody.code ?? "no-code"}`
  );

  const created = await api("/api/registries", {
    method: "POST",
    cookie: operatorSessionCookie,
    body: {
      name: "Acceptance private registry",
      url: "http://registry:5000",
      username: fixture.registryUser,
      password: fixture.registryPassword,
      insecure: true
    }
  });
  try {
    const tags = await api(`/api/image-tags?image=${encodeURIComponent(image)}`, { cookie: operatorSessionCookie });
    assert(tags.data.tags.includes("1.0.0"), "saved private registry tags were not returned");
  } finally {
    await api(`/api/registries/${created.data.registry.id}`, { method: "DELETE", cookie: operatorSessionCookie });
  }
  return { operatorSavedPrivateRegistry: true, unsavedPrivateRegistryBlocked: true };
}

async function inspectCandidateImage(image, expectedTitle) {
  const inspected = await run("docker", ["image", "inspect", image, "--format", "{{json .}}"]).catch(() => {
    throw new Error(`Required local candidate image ${image} does not exist; omit --skip-build or build it first`);
  });
  const details = JSON.parse(inspected.stdout);
  const labels = details.Config?.Labels ?? {};
  assert(labels["org.opencontainers.image.version"] === candidateVersion, `${image} label version is ${labels["org.opencontainers.image.version"] ?? "missing"}`);
  assert(labels["org.opencontainers.image.title"] === expectedTitle, `${image} has the wrong image title label`);
  assert(labels["org.opencontainers.image.revision"] === candidateRevision, `${image} label revision is ${labels["org.opencontainers.image.revision"] ?? "missing"}, expected ${candidateRevision}`);
  assert(labels["org.opencontainers.image.created"] === candidateBuildDate, `${image} label created is ${labels["org.opencontainers.image.created"] ?? "missing"}, expected ${candidateBuildDate}`);
  return {
    image,
    id: details.Id,
    architecture: details.Architecture,
    title: labels["org.opencontainers.image.title"],
    version: labels["org.opencontainers.image.version"],
    revision: labels["org.opencontainers.image.revision"],
    created: labels["org.opencontainers.image.created"]
  };
}

async function inspectPublicUpgradeImage(baseline) {
  const inspected = await run(
    "docker",
    ["image", "inspect", baseline.pinnedImage, "--format", "{{json .}}"]
  );
  const details = JSON.parse(inspected.stdout);
  const repoDigest = (details.RepoDigests ?? []).find((value) =>
    /^ghcr\.io\/composebastion-admin\/composebastion-app@sha256:[a-f0-9]{64}$/i.test(value)
  );
  assert(
    repoDigest,
    `public ${baseline.version} image did not expose an immutable GHCR digest`
  );
  assert(
    repoDigest === baseline.pinnedImage,
    `public ${baseline.version} digest is ${repoDigest}, expected ${baseline.pinnedImage}`
  );
  const version = details.Config?.Labels?.["org.opencontainers.image.version"] ?? null;
  assert(
    version === baseline.version,
    `public upgrade image label is ${version ?? "missing"}, expected ${baseline.version}`
  );
  return {
    reference: baseline.pinnedImage,
    releaseTag: baseline.releaseTag,
    id: details.Id,
    repoDigest,
    architecture: details.Architecture,
    version
  };
}

async function inspectBridgeUpgradeImage() {
  const override = hostEnvironment.COMPOSEBASTION_ACCEPTANCE_BRIDGE_IMAGE;
  if (override) {
    const reason = "COMPOSEBASTION_ACCEPTANCE_BRIDGE_IMAGE is restricted to explicit --allow-nonqualifying developer runs";
    if (!allowNonqualifying) throw new Error(reason);
    markNonqualifying(reason);
  }
  const requested = override || acceptanceUpgradeBridge.pinnedImage;
  const immutable = /^ghcr\.io\/composebastion-admin\/composebastion-app@sha256:[a-f0-9]{64}$/i.test(requested);
  if (!immutable) {
    const reason = "COMPOSEBASTION_ACCEPTANCE_BRIDGE_IMAGE must name the published 1.1.3 image by immutable GHCR digest";
    if (!allowNonqualifying) throw new Error(reason);
    markNonqualifying(reason);
  }
  if (requested !== acceptanceUpgradeBridge.pinnedImage) {
    const reason = `1.1.3 bridge override ${requested} does not match the qualification digest ${acceptanceUpgradeBridge.pinnedImage}`;
    if (!allowNonqualifying) throw new Error(reason);
    markNonqualifying(reason);
  }
  await run("docker", ["pull", requested], { inherit: true });
  const details = JSON.parse((await run(
    "docker",
    ["image", "inspect", requested, "--format", "{{json .}}"]
  )).stdout);
  const repoDigest = (details.RepoDigests ?? []).find((value) =>
    /^ghcr\.io\/composebastion-admin\/composebastion-app@sha256:[a-f0-9]{64}$/i.test(value)
  );
  assert(repoDigest, "published 1.1.3 bridge image did not expose an immutable GHCR digest");
  if (immutable) assert(repoDigest === requested, `1.1.3 bridge digest is ${repoDigest}, expected ${requested}`);
  const labels = details.Config?.Labels ?? {};
  assert(labels["org.opencontainers.image.version"] === acceptanceUpgradeBridge.version,
    `bridge image label is ${labels["org.opencontainers.image.version"] ?? "missing"}, expected ${acceptanceUpgradeBridge.version}`);
  assert(labels["org.opencontainers.image.title"] === "ComposeBastion", "bridge image title label is invalid");
  return {
    reference: requested,
    releaseTag: acceptanceUpgradeBridge.releaseTag,
    repoDigest,
    id: details.Id,
    architecture: details.Architecture,
    version: labels["org.opencontainers.image.version"]
  };
}

async function buildCandidate() {
  if (!skipBuild) {
    await run("docker", [
      "build", "--target", "runtime",
      "--build-arg", `APP_VERSION=${candidateVersion}`,
      "--build-arg", `VCS_REF=${candidateRevision}`,
      "--build-arg", `BUILD_DATE=${candidateBuildDate}`,
      "--build-arg", "TRIVY_VERSION=0.72.0",
      "--tag", candidateImage, candidateBuildContext
    ], { inherit: true });
    await run("docker", [
      "build", "--file", path.join(candidateBuildContext, "Dockerfile.agent"), "--target", "runtime",
      "--build-arg", `APP_VERSION=${candidateVersion}`,
      "--build-arg", `VCS_REF=${candidateRevision}`,
      "--build-arg", `BUILD_DATE=${candidateBuildDate}`,
      "--tag", candidateAgentImage, candidateBuildContext
    ], { inherit: true });
  }
  const app = await inspectCandidateImage(candidateImage, "ComposeBastion");
  const agent = await inspectCandidateImage(candidateAgentImage, "ComposeBastion Agent");
  assert(app.version === agent.version, "Candidate app and agent version labels do not match");
  assert(app.revision === agent.revision, "Candidate app and agent revision labels do not match");
  assert(app.created === agent.created, "Candidate app and agent created labels do not match");
  const evidence = {
    reused: skipBuild,
    contextIdentity: report.source.contextIdentity,
    exactGitContext: !skipBuild,
    treeSha: gitBuildContextEvidence.treeSha,
    contextDigest: gitBuildContextEvidence.contextDigest,
    app,
    agent
  };
  report.candidateImages = evidence;
  return evidence;
}

async function verifyCandidateAboutArtifacts() {
  const script = [
    "const fs=require('node:fs');const path=require('node:path');",
    "const legal=['LICENSE.md','LICENSING_SUMMARY.md','COMMERCIAL-LICENSE.md','THIRD-PARTY-NOTICES.md'];",
    "for(const name of legal){const file=path.join('/licenses',name);if(!fs.existsSync(file)||fs.statSync(file).size===0)throw new Error('missing legal artifact '+name);}",
    "const assets='/app/apps/web/dist/assets';",
    "const js=fs.readdirSync(assets).filter(name=>name.endsWith('.js')).map(name=>fs.readFileSync(path.join(assets,name),'utf8')).join('\\n');",
    "for(const expected of [process.env.ACCEPTANCE_VERSION,'Source-available private use license','support@composebastion.com']){if(!js.includes(expected))throw new Error('About bundle is missing '+expected);}",
    "console.log(JSON.stringify({version:process.env.ACCEPTANCE_VERSION,legalFiles:legal.length,aboutBundle:true}));"
  ].join("");
  const result = await compose(activeProject, activeEnv, [
    "exec", "-T", "-e", `ACCEPTANCE_VERSION=${candidateVersion}`,
    "app", "node", "-e", script
  ]);
  return JSON.parse(result.stdout);
}

async function createMinioBucket() {
  await retry("MinIO", async () => {
    const response = await fetch(`http://127.0.0.1:${activePort("ACCEPTANCE_MINIO_PORT", portBase + 1000)}/minio/health/live`);
    if (!response.ok) throw new Error(`MinIO returned ${response.status}`);
  }, { attempts: 90, delayMs: 1_000 });
  const { CreateBucketCommand, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${activePort("ACCEPTANCE_MINIO_PORT", portBase + 1000)}`,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: fixture.minioUser, secretAccessKey: fixture.minioPassword }
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: "composebastion-acceptance" }));
  } finally {
    client.destroy();
  }
}

async function assertRemoteFixtureStorageEmpty() {
  const { ListObjectsV2Command, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${activePort("ACCEPTANCE_MINIO_PORT", portBase + 1000)}`,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: fixture.minioUser, secretAccessKey: fixture.minioPassword }
  });
  const objects = [];
  let continuationToken;
  try {
    do {
      const page = await client.send(new ListObjectsV2Command({
        Bucket: "composebastion-acceptance",
        ContinuationToken: continuationToken
      }));
      objects.push(...(page.Contents ?? []).map((item) => item.Key).filter(Boolean));
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  } finally {
    client.destroy();
  }
  const samba = await compose(activeProject, activeEnv, [
    "exec", "-T", "samba", "sh", "-lc", "find /storage -type f -print"
  ]);
  const smbFiles = samba.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  assert(objects.length === 0, `MinIO fixture retained ${objects.length} storage objects`);
  assert(smbFiles.length === 0, `SMB fixture retained ${smbFiles.length} storage files`);
  report.cleanup.storageChecked = true;
  report.cleanup.storageObjects = [];
  return { minioObjectsAbsent: true, smbFilesAbsent: true };
}

async function cleanupManagedDockerState() {
  if (!activeProject || !activeEnv) return;
  const cleanup = `
set -eu
for id in $( { docker ps -aq --filter 'label=com.docker.compose.project=${workloadProject}'; docker ps -aq --filter 'name=^/${workloadPrefix}'; } | sort -u); do docker rm -f "$id" >/dev/null; done
for volume in $( { docker volume ls -q --filter 'label=com.docker.compose.project=${workloadProject}'; docker volume ls -q --filter 'name=^${workloadPrefix}'; } | sort -u); do docker volume rm -f "$volume" >/dev/null; done
for network in $( { docker network ls -q --filter 'label=com.docker.compose.project=${workloadProject}'; docker network ls -q --filter 'name=^${workloadPrefix}'; } | sort -u); do docker network rm "$network" >/dev/null; done
find '${acceptanceBindDir}' -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
test -z "$(docker ps -aq --filter 'label=com.docker.compose.project=${workloadProject}')"
test -z "$(docker volume ls -q --filter 'label=com.docker.compose.project=${workloadProject}')"
test -z "$(docker network ls -q --filter 'label=com.docker.compose.project=${workloadProject}')"
test -z "$(docker ps -aq --filter 'name=^/${workloadPrefix}')"
test -z "$(docker volume ls -q --filter 'name=^${workloadPrefix}')"
test -z "$(docker network ls -q --filter 'name=^${workloadPrefix}')"
test -z "$(find '${acceptanceBindDir}' -mindepth 1 -maxdepth 1 -print -quit)"
`;
  await compose(activeProject, activeEnv, ["exec", "-T", "sshhost", "sh", "-lc", cleanup]);
}

async function verifyMail(subject, minimum = 1) {
  return retry(`Mailpit message ${subject}`, async () => {
    const response = await fetch(`http://127.0.0.1:${activePort("ACCEPTANCE_MAILPIT_PORT", portBase + 25)}/api/v1/messages`);
    if (!response.ok) throw new Error(`Mailpit returned ${response.status}`);
    const body = await response.json();
    const messages = body.messages ?? body.Messages ?? [];
    const matches = messages.filter((message) => (message.Subject ?? message.subject) === subject);
    assert(matches.length >= minimum, `found ${matches.length} matching messages`);
    return matches.length;
  }, { attempts: 80, delayMs: 1_000 });
}

async function verifySmtpAndWorker() {
  const unreachableHostPassword = runtimeSecret(20);
  const channelResponse = await api("/api/alerts/channels", {
    method: "POST",
    body: { name: "Acceptance email", type: "email", emailTo: "operator@composebastion.invalid", enabled: true }
  });
  const channel = channelResponse.data.channel;
  const tested = await api(`/api/alerts/channels/${channel.id}/test`, { method: "POST", body: {} });
  assert(tested.data.event.status === "success", "email channel test was not recorded as successful");
  await verifyMail("ComposeBastion test notification");

  const offlineHostResponse = await api("/api/hosts", {
    method: "POST",
    body: {
      name: "Acceptance unreachable host",
      hostname: "127.0.0.1",
      port: 1,
      username: "root",
      connectionMode: "ssh",
      sshAuthType: "password",
      sshPassword: unreachableHostPassword,
      dockerSocketPath: "/var/run/docker.sock",
      tags: ["acceptance", "unreachable"]
    }
  });
  const offlineHost = offlineHostResponse.data.host;
  await waitForJob(offlineHostResponse.data.job.id, { timeoutMs: 90_000 }).catch(() => undefined);
  await retry("offline host state", async () => {
    const current = await api(`/api/hosts/${offlineHost.id}`);
    assert(current.data.host.lastStatus === "offline", `host status is ${current.data.host.lastStatus}`);
  }, { attempts: 45, delayMs: 1_000 });

  await api("/api/alerts/rules", {
    method: "POST",
    body: {
      name: "Acceptance worker offline alert",
      condition: "host.offline",
      hostId: offlineHost.id,
      channelId: channel.id,
      enabled: true
    }
  });
  await verifyMail("ComposeBastion alert: Acceptance worker offline alert");
  return { testNotification: true, workerNotification: true };
}

async function createSshHost() {
  const response = await api("/api/hosts", {
    method: "POST",
    body: {
      name: "Acceptance Docker host",
      hostname: "sshhost",
      port: 22,
      username: "root",
      connectionMode: "ssh",
      sshAuthType: "key",
      sshPrivateKey,
      dockerSocketPath: "/var/run/docker.sock",
      tags: ["acceptance"]
    }
  });
  await waitForJob(response.data.job.id, { timeoutMs: 3 * 60_000 });
  const current = await api(`/api/hosts/${response.data.host.id}`);
  assert(current.data.host.lastStatus === "online", `SSH host is ${current.data.host.lastStatus}`);
  return current.data.host;
}

async function verifyAgentHost() {
  const agentPort = activePort("ACCEPTANCE_AGENT_PORT", portBase + 90);
  const unauthenticated = await fetch(`http://127.0.0.1:${agentPort}/api/health`);
  assert(unauthenticated.status === 401, `unauthenticated agent health returned ${unauthenticated.status}`);
  const direct = await retry("authenticated agent health", async () => {
    const response = await fetch(`http://127.0.0.1:${agentPort}/api/health`, {
      headers: { authorization: `Bearer ${fixture.agentToken}` }
    });
    const body = await response.json();
    assert(response.status === 200 && body.ok === true, `agent health returned ${response.status}`);
    return body;
  }, { attempts: 60, delayMs: 1_000 });
  assert(direct.agentVersion === candidateVersion, `agent reported version ${direct.agentVersion}`);
  assert(direct.dockerVersion && direct.composeVersion, "agent health omitted Docker or Compose version");

  const created = await api("/api/hosts", {
    method: "POST",
    body: {
      name: "Acceptance agent host",
      hostname: "agent",
      port: 8090,
      username: "agent",
      connectionMode: "agent",
      sshAuthType: "key",
      agentUrl: "http://agent:8090",
      agentToken: fixture.agentToken,
      dockerSocketPath: "/var/run/docker.sock",
      tags: ["acceptance", "agent"]
    }
  });
  await waitForJob(created.data.job.id, { timeoutMs: 3 * 60_000 });
  const current = await api(`/api/hosts/${created.data.host.id}`);
  assert(current.data.host.lastStatus === "online", `agent host is ${current.data.host.lastStatus}`);
  assert(current.data.host.agentVersion === candidateVersion, `manager recorded agent ${current.data.host.agentVersion}`);
  const usage = await api(`/api/hosts/${created.data.host.id}/containers/usage`);
  assert(Array.isArray(usage.data.usage), "agent container usage snapshot was not returned");

  const controller = new AbortController();
  const streamStarted = Date.now();
  try {
    const stream = await Promise.race([
      fetch(`http://127.0.0.1:${agentPort}/api/containers/usage-stream`, {
        headers: { authorization: `Bearer ${fixture.agentToken}` },
        signal: controller.signal
      }),
      sleep(30_000).then(() => { throw new Error("agent usage stream did not open within 30 seconds"); })
    ]);
    assert(stream.status === 200 && stream.body, `agent usage stream returned ${stream.status}`);
    const reader = stream.body.getReader();
    const firstFrame = await Promise.race([
      reader.read(),
      sleep(30_000).then(() => { throw new Error("agent usage stream did not emit within 30 seconds"); })
    ]);
    assert(firstFrame.done === false && firstFrame.value?.length > 0, "agent usage stream ended without data");
    await sleep(Math.max(0, 61_000 - (Date.now() - streamStarted)));

    const mutation = await fetch(`http://127.0.0.1:${agentPort}/api/run`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.agentToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ command: "docker version --format '{{.Server.Version}}'" })
    });
    const mutationBody = await mutation.json();
    assert(mutation.status === 200 && mutationBody.code === 0, `agent mutation after sustained stream returned ${mutation.status}`);
  } finally {
    controller.abort();
  }
  return {
    version: direct.agentVersion,
    usageSnapshot: true,
    sustainedUsageStream: true,
    mutationAfterStream: true,
    streamDurationMs: Date.now() - streamStarted
  };
}

async function verifyWorkerReadinessAndRedis(host) {
  await compose(activeProject, activeEnv, ["stop", "worker"]);
  await retry("worker-offline readiness", async () => {
    const response = await fetch(`${activeBaseUrl()}/api/health/ready`);
    const body = await response.json();
    assert(response.status === 503, `readiness returned ${response.status} while worker was stopped`);
    assert(body.checks?.worker?.ok === false, "worker readiness remained healthy after worker stop");
  }, { attempts: 40, delayMs: 1_000 });

  await compose(activeProject, activeEnv, ["start", "worker"]);
  await retry("worker restart readiness", async () => {
    const response = await fetch(`${activeBaseUrl()}/api/health/ready`);
    const body = await response.json();
    assert(response.status === 200 && body.checks?.worker?.ok === true, "worker did not become ready after restart");
  }, { attempts: 60, delayMs: 1_000 });

  await compose(activeProject, activeEnv, ["stop", "redis"]);
  try {
    await retry("Redis-outage readiness", async () => {
      const response = await fetch(`${activeBaseUrl()}/api/health/ready`);
      const body = await response.json();
      assert(response.status === 200 && body.ok === true, `readiness returned ${response.status} while Redis was stopped`);
      assert(body.checks?.database?.ok === true, "database readiness failed during Redis outage");
      assert(body.checks?.worker?.ok === true, "worker readiness failed during Redis outage");
      assert(body.checks?.redis?.ok === false, "Redis outage was not exposed in readiness diagnostics");
      assert(body.checks?.redis?.required === false, "Redis diagnostic was incorrectly marked as required");

      const redisDiagnostic = await fetch(`${activeBaseUrl()}/api/health/redis`);
      assert(redisDiagnostic.status === 503, `Redis diagnostic returned ${redisDiagnostic.status} during outage`);
    }, { attempts: 30, delayMs: 1_000 });

    const queued = await api(`/api/hosts/${host.id}/actions`, {
      method: "POST",
      body: { type: "host.check", payload: {} }
    });
    const completed = await waitForJob(queued.data.job.id, { timeoutMs: 2 * 60_000 });
    assert(completed.status === "completed", `database-polled job completed with ${completed.status}`);
  } finally {
    await compose(activeProject, activeEnv, ["start", "redis"]);
  }
  await retry("Redis restart", async () => {
    const ping = await compose(activeProject, activeEnv, ["exec", "-T", "redis", "redis-cli", "ping"]);
    assert(ping.stdout === "PONG", `Redis ping returned ${ping.stdout}`);
    const response = await fetch(`${activeBaseUrl()}/api/health/ready`);
    const body = await response.json();
    assert(response.status === 200 && body.checks?.redis?.ok === true, `readiness Redis diagnostic returned ${response.status}/${body.checks?.redis?.ok}`);
    const redisDiagnostic = await fetch(`${activeBaseUrl()}/api/health/redis`);
    const redisBody = await redisDiagnostic.json();
    assert(redisDiagnostic.status === 200 && redisBody.ok === true && redisBody.configured === true,
      `Redis diagnostic returned ${redisDiagnostic.status}/${redisBody.ok} after restart`);
    const subscribers = await compose(activeProject, activeEnv, ["exec", "-T", "redis", "redis-cli", "--raw", "PUBSUB", "NUMSUB", "jobs:queued"]);
    const subscriberCount = Number(subscribers.stdout.trim().split(/\s+/).at(-1));
    assert(subscriberCount >= 1, `worker Redis subscription count is ${subscriberCount}`);
  }, { attempts: 60, delayMs: 1_000 });
  return {
    absentWorkerFailedReadiness: true,
    redisDiagnosticNonBlocking: true,
    redisDatabasePollingCompleted: true,
    redisSubscriptionRestored: true,
    redisDiagnosticRecovered: true,
    redisRestartHealthy: true
  };
}

async function jobAttemptCount(jobId) {
  assert(/^[0-9a-f-]{36}$/i.test(jobId), "job id is not a UUID");
  const result = await compose(activeProject, activeEnv, [
    "exec", "-T", "postgres",
    "psql", "-U", "composebastion", "-d", "composebastion", "-Atc",
    `SELECT attempt_count FROM operation_jobs WHERE id = '${jobId}'`
  ]);
  return Number(result.stdout);
}

async function verifySafeJobLeaseRecovery(host) {
  let sshPaused = false;
  let workerNeedsStart = false;
  let jobId = null;
  try {
    await retry("idle queue before lease recovery", async () => {
      const status = await api("/api/jobs/status");
      assert(status.data.worker.queued === 0 && status.data.worker.running === 0, "job queue is not idle");
    });
    await compose(activeProject, activeEnv, ["stop", "worker"]);
    workerNeedsStart = true;
    await compose(activeProject, activeEnv, ["pause", "sshhost"]);
    sshPaused = true;
    const queued = await api(`/api/hosts/${host.id}/actions`, {
      method: "POST",
      body: { type: "host.check", payload: {} }
    });
    jobId = queued.data.job.id;
    await compose(activeProject, activeEnv, ["start", "worker"]);
    workerNeedsStart = false;
    await retry("safe job first lease", async () => {
      const current = await api(`/api/jobs/${jobId}`);
      assert(current.data.job.status === "running", `safe job is ${current.data.job.status}`);
      assert(await jobAttemptCount(jobId) === 1, "safe job was not on its first attempt");
    }, { attempts: 120, delayMs: 500 });

    await compose(activeProject, activeEnv, ["kill", "--signal", "SIGKILL", "worker"]);
    workerNeedsStart = true;
    await compose(activeProject, activeEnv, ["unpause", "sshhost"]);
    sshPaused = false;
    await compose(activeProject, activeEnv, ["up", "--detach", "worker"]);
    await assertActiveCandidateServiceImage("worker");
    workerNeedsStart = false;

    const completed = await waitForJob(jobId, { timeoutMs: 3 * 60_000 });
    assert(completed.status === "completed", `safe recovered job is ${completed.status}`);
    assert(await jobAttemptCount(jobId) === 2, "safe job did not complete on its second leased attempt");
    await retry("worker readiness after lease recovery", async () => {
      const response = await fetch(`${activeBaseUrl()}/api/health/ready`);
      const body = await response.json();
      assert(response.status === 200 && body.checks?.worker?.ok === true, "worker was not ready after lease recovery");
    });
    return { jobId, recoveredAttempt: 2, fencedWorkerLoss: true, candidateImageRebound: true };
  } finally {
    if (sshPaused) await compose(activeProject, activeEnv, ["unpause", "sshhost"]).catch(() => undefined);
    if (workerNeedsStart) await compose(activeProject, activeEnv, ["up", "--detach", "worker"]).catch(() => undefined);
  }
}

function disposableComposeYaml() {
  return `services:
  database:
    image: postgres:16.6-alpine3.20@sha256:1e59919c179e296eaf3cc701f4d50bab5c393d7ed9746c188c9d519489c998dc
    environment:
      POSTGRES_PASSWORD: \${WORKLOAD_DATABASE_PASSWORD}
    volumes:
      - database-data:/var/lib/postgresql/data
    networks:
      acceptance-net:
        ipv4_address: ${workloadAddressPrefix}.10
  workload:
    image: alpine:3.20.8@sha256:765942a4039992336de8dd5db680586e1a206607dd06170ff0a37267a9e01958
    command: ["sh", "-c", "sleep infinity"]
    volumes:
      - workload-data:/data
      - \${WORKLOAD_BIND_DIR}:/allowed
      - ./relative-data:/relative-allowed
    networks:
      acceptance-net:
        ipv4_address: ${workloadAddressPrefix}.20
volumes:
  database-data:
  workload-data:
networks:
  acceptance-net:
    driver: bridge
    ipam:
      config:
        - subnet: ${configuredSubnet}
`;
}

async function deployDisposableStack(host) {
  await api(`/api/hosts/${host.id}/files/write`, {
    method: "POST",
    body: {
      path: `${acceptanceComposeDir}/compose.yml`,
      content: disposableComposeYaml()
    }
  });
  await api(`/api/hosts/${host.id}/files/write`, {
    method: "POST",
    body: {
      path: `${acceptanceComposeDir}/.env`,
      content: `WORKLOAD_DATABASE_PASSWORD=${fixture.workloadPassword}\nWORKLOAD_BIND_DIR=${acceptanceExternalBindDir}\n`
    }
  });
  const response = await api(`/api/hosts/${host.id}/actions`, {
    method: "POST",
    body: {
      type: "compose.deployPath",
      payload: {
        projectName: workloadProject,
        workingDir: acceptanceComposeDir,
        composePath: "compose.yml"
      }
    }
  });
  const deployed = await waitForJob(response.data.job.id, { timeoutMs: 10 * 60_000 });
  const stacks = await api(`/api/hosts/${host.id}/compose`);
  const stack = stacks.data.stacks.find((item) => item.id === deployed.result?.stackId);
  assert(stack, "path-deployed acceptance stack was not registered");
  const verifyStartup = `
set -eu
workload_id="$(docker ps -q --filter 'label=com.docker.compose.project=${workloadProject}' --filter 'label=com.docker.compose.service=workload')"
database_id="$(docker ps -q --filter 'label=com.docker.compose.project=${workloadProject}' --filter 'label=com.docker.compose.service=database')"
test -n "$workload_id" && test -n "$database_id"
test ! -e '${acceptanceExternalBindDir}/proof.txt'
test ! -e '${acceptanceComposeDir}/relative-data/proof.txt'
docker exec "$workload_id" test ! -e /data/proof.txt
docker exec "$database_id" pg_isready -U postgres >/dev/null
test "$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$workload_id")" = '${workloadAddressPrefix}.20'
test "$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$database_id")" = '${workloadAddressPrefix}.10'
docker volume inspect '${workloadProject}_workload-data' >/dev/null
docker volume inspect '${workloadProject}_database-data' >/dev/null
docker network inspect '${workloadProject}_acceptance-net' >/dev/null
`;
  await retry("disposable Compose startup", async () => {
    await compose(activeProject, activeEnv, ["exec", "-T", "sshhost", "sh", "-lc", verifyStartup]);
  }, { attempts: 30, delayMs: 1_000 });

  const seedRuntime = `
set -eu
workload_id="$(docker ps -q --filter 'label=com.docker.compose.project=${workloadProject}' --filter 'label=com.docker.compose.service=workload')"
database_id="$(docker ps -q --filter 'label=com.docker.compose.project=${workloadProject}' --filter 'label=com.docker.compose.service=database')"
bind_source="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/allowed"}}{{.Source}}{{end}}{{end}}' "$workload_id")"
relative_bind_source="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/relative-allowed"}}{{.Source}}{{end}}{{end}}' "$workload_id")"
test -n "$bind_source" && test -n "$relative_bind_source"
docker exec "$workload_id" sh -c "printf '%s' '${workloadVolumeMarker}' > /data/proof.txt"
docker exec "$database_id" psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS acceptance_proof (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO acceptance_proof (id, value) VALUES (1, 'database-ok') ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;" >/dev/null
printf 'ACCEPTANCE_BIND_SOURCE=%s\n' "$bind_source"
printf 'ACCEPTANCE_RELATIVE_BIND_SOURCE=%s\n' "$relative_bind_source"
`;
  const seeded = await compose(activeProject, activeEnv, ["exec", "-T", "sshhost", "sh", "-lc", seedRuntime]);
  const bindSourcePath = seeded.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("ACCEPTANCE_BIND_SOURCE="))
    ?.slice("ACCEPTANCE_BIND_SOURCE=".length);
  const relativeBindSourcePath = seeded.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("ACCEPTANCE_RELATIVE_BIND_SOURCE="))
    ?.slice("ACCEPTANCE_RELATIVE_BIND_SOURCE=".length);
  assert(/^\/[A-Za-z0-9._/-]+$/.test(bindSourcePath ?? ""), `Docker reported an unsafe acceptance bind source: ${JSON.stringify(bindSourcePath)}`);
  assert(/^\/[A-Za-z0-9._/-]+$/.test(relativeBindSourcePath ?? ""), `Docker reported an unsafe relative bind source: ${JSON.stringify(relativeBindSourcePath)}`);
  const bindChild = dockerBindPathRelativeChild(acceptanceBindDir, bindSourcePath);
  assert(bindChild === "external", `external bind was not resolved to the configured fixture path: expected ${JSON.stringify(acceptanceExternalBindDir)}, got ${JSON.stringify(bindSourcePath)}`);
  const bindHostPath = path.posix.join(acceptanceBindDir, bindChild);
  assert(bindHostPath === acceptanceExternalBindDir, "external bind canonical host path changed unexpectedly");
  const relativeBindChild = dockerBindPathRelativeChild(acceptanceComposeDir, relativeBindSourcePath);
  assert(relativeBindChild, `relative bind was not resolved beneath the Compose working directory: expected beneath ${JSON.stringify(acceptanceComposeDir)}, got ${JSON.stringify(relativeBindSourcePath)}`);
  const relativeBindHostPath = path.posix.join(acceptanceComposeDir, relativeBindChild);
  assert(
    /^\/[A-Za-z0-9._/-]+$/.test(bindHostPath)
      && /^\/[A-Za-z0-9._/-]+$/.test(relativeBindHostPath)
      && relativeBindHostPath.startsWith(`${acceptanceComposeDir}/`),
    `canonical fixture bind path is unsafe: ${JSON.stringify({ bindHostPath, relativeBindHostPath })}`
  );

  // Docker Desktop reports daemon-side paths through /host_mnt, while this
  // disposable SSH container reaches the same host bind through the canonical
  // paths mounted into the fixture. Seed the real host-visible paths and prove
  // both workload mounts see their markers before recovery. The external bind
  // is also mirrored to the daemon-reported path in the SSH overlay because it
  // is intentionally captured as its own artifact; the relative bind is not.
  const seedFixtureBinds = `
set -eu
workload_id="$(docker ps -q --filter 'label=com.docker.compose.project=${workloadProject}' --filter 'label=com.docker.compose.service=workload')"
test -n "$workload_id"
mkdir -p '${bindHostPath}' '${relativeBindHostPath}'
if [ '${relativeBindSourcePath}' != '${relativeBindHostPath}' ]; then
  test ! -e '${relativeBindSourcePath}/proof.txt'
fi
printf '%s' '${workloadBindMarker}' > '${bindHostPath}/proof.txt'
if [ '${bindSourcePath}' != '${bindHostPath}' ]; then
  mkdir -p '${bindSourcePath}'
  printf '%s' '${workloadBindMarker}' > '${bindSourcePath}/proof.txt'
fi
printf '%s' '${workloadRelativeBindMarker}' > '${relativeBindHostPath}/proof.txt'
test "$(docker exec "$workload_id" cat /allowed/proof.txt)" = '${workloadBindMarker}'
test "$(docker exec "$workload_id" cat /relative-allowed/proof.txt)" = '${workloadRelativeBindMarker}'
`;
  await compose(activeProject, activeEnv, ["exec", "-T", "sshhost", "sh", "-lc", seedFixtureBinds]);

  const verifyRuntime = `
set -eu
workload_id="$(docker ps -q --filter 'label=com.docker.compose.project=${workloadProject}' --filter 'label=com.docker.compose.service=workload')"
database_id="$(docker ps -q --filter 'label=com.docker.compose.project=${workloadProject}' --filter 'label=com.docker.compose.service=database')"
test "$(docker exec "$workload_id" cat /data/proof.txt)" = '${workloadVolumeMarker}'
test "$(cat '${bindSourcePath}/proof.txt')" = '${workloadBindMarker}'
test "$(cat '${bindHostPath}/proof.txt')" = '${workloadBindMarker}'
test "$(cat '${relativeBindHostPath}/proof.txt')" = '${workloadRelativeBindMarker}'
if [ '${relativeBindSourcePath}' != '${relativeBindHostPath}' ]; then
  test ! -e '${relativeBindSourcePath}/proof.txt'
fi
test "$(docker exec "$workload_id" cat /allowed/proof.txt)" = '${workloadBindMarker}'
test "$(docker exec "$workload_id" cat /relative-allowed/proof.txt)" = '${workloadRelativeBindMarker}'
test "$(docker exec "$database_id" psql -U postgres -Atc 'SELECT value FROM acceptance_proof WHERE id = 1')" = database-ok
test "$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$workload_id")" = '${workloadAddressPrefix}.20'
test "$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$database_id")" = '${workloadAddressPrefix}.10'
docker volume inspect '${workloadProject}_workload-data' >/dev/null
docker volume inspect '${workloadProject}_database-data' >/dev/null
docker network inspect '${workloadProject}_acceptance-net' >/dev/null
`;
  await retry("seeded disposable Compose runtime", async () => {
    await compose(activeProject, activeEnv, ["exec", "-T", "sshhost", "sh", "-lc", verifyRuntime]);
  }, { attempts: 30, delayMs: 1_000 });
  const resources = await api(`/api/hosts/${host.id}/resources?kind=container`);
  assert(resources.data.resources.some((resource) => resource.name.includes(workloadProject)), "deployed containers were not inventoried");
  return {
    ...stack,
    acceptanceEvidence: {
      namedVolumes: true,
      allowedBindMount: true,
      database: true,
      customNetwork: true,
      staticAddresses: true,
      volumeMarker: workloadVolumeMarker,
      volumeMarkerSeededAfterDeploy: true,
      bindMarker: workloadBindMarker,
      bindSourcePath,
      bindHostPath,
      relativeBindMarker: workloadRelativeBindMarker,
      relativeBindSourcePath,
      relativeBindHostPath,
      composeWorkingDir: acceptanceComposeDir
    }
  };
}

async function createAndTestTargets() {
  const s3Response = await api("/api/recovery/targets", {
    method: "POST",
    body: {
      name: "Acceptance MinIO",
      type: "s3",
      endpoint: "http://minio:9000",
      bucket: "composebastion-acceptance",
      region: "us-east-1",
      prefix: "candidate",
      forcePathStyle: true,
      accessKeyId: fixture.minioUser,
      secretAccessKey: fixture.minioPassword,
      localCachePolicy: "remote_only",
      enabled: true
    }
  });
  const s3 = s3Response.data.target;
  const s3Test = await api(`/api/recovery/targets/${s3.id}/test`, { method: "POST", body: {} });
  assert(s3Test.data.ok === true, "S3 target check failed");

  const smbResponse = await api("/api/recovery/targets", {
    method: "POST",
    body: {
      name: "Acceptance Samba",
      type: "rclone",
      provider: "smb",
      server: "samba",
      share: "acceptance",
      username: fixture.sambaUser,
      password: fixture.sambaPassword,
      port: 445,
      localCachePolicy: "keep",
      enabled: true
    }
  });
  const smb = smbResponse.data.target;
  await retry("SMB target", async () => {
    const result = await api(`/api/recovery/targets/${smb.id}/test`, { method: "POST", body: {} });
    assert(result.data.ok === true, "SMB target check failed");
  }, { attempts: 20, delayMs: 2_000 });
  return {
    s3,
    smb,
    acceptanceEvidence: { s3Connection: true, smbConnection: true }
  };
}

async function exerciseRecovery(host, stack, targets) {
  const expectedVolumeMarker = stack.acceptanceEvidence?.volumeMarker;
  const expectedBindMarker = stack.acceptanceEvidence?.bindMarker;
  const expectedBindSourcePath = stack.acceptanceEvidence?.bindSourcePath;
  const expectedBindHostPath = stack.acceptanceEvidence?.bindHostPath;
  const expectedRelativeBindMarker = stack.acceptanceEvidence?.relativeBindMarker;
  const expectedRelativeBindSourcePath = stack.acceptanceEvidence?.relativeBindSourcePath;
  const expectedRelativeBindHostPath = stack.acceptanceEvidence?.relativeBindHostPath;
  const expectedComposeWorkingDir = stack.acceptanceEvidence?.composeWorkingDir;
  assert(/^volume-[0-9a-f-]{36}$/.test(expectedVolumeMarker ?? ""), "workload volume marker is missing or invalid");
  assert(/^bind-[0-9a-f-]{36}$/.test(expectedBindMarker ?? ""), "workload bind marker is missing or invalid");
  assert(/^\/[A-Za-z0-9._/-]+$/.test(expectedBindSourcePath ?? ""), "workload bind source path is missing or invalid");
  assert(/^\/[A-Za-z0-9._/-]+$/.test(expectedBindHostPath ?? ""), "workload canonical bind host path is missing or invalid");
  assert(/^relative-bind-[0-9a-f-]{36}$/.test(expectedRelativeBindMarker ?? ""), "relative bind marker is missing or invalid");
  assert(/^\/[A-Za-z0-9._/-]+$/.test(expectedRelativeBindSourcePath ?? ""), "relative bind source path is missing or invalid");
  assert(/^\/[A-Za-z0-9._/-]+$/.test(expectedRelativeBindHostPath ?? ""), "relative bind canonical host path is missing or invalid");
  assert(/^\/[A-Za-z0-9._/-]+$/.test(expectedComposeWorkingDir ?? ""), "Compose working directory is missing or invalid");
  const created = await api("/api/recovery/points", {
    method: "POST",
    body: {
      hostId: host.id,
      name: "Acceptance remote-only recovery",
      appIdentity: { kind: "stack", stackId: stack.id, projectName: stack.projectName },
      backupTargetId: targets.s3.id,
      captureMode: "stop_first",
      triggerKind: "manual",
      stopFirst: true,
      extraIncludePaths: []
    }
  });
  const pointId = created.data.point.id;
  const captureJob = await waitForJob(created.data.job.id, { timeoutMs: 15 * 60_000 });
  assert(captureJob.status === "completed", "recovery capture did not complete");
  const detail = await api(`/api/recovery/points/${pointId}`);
  const artifactErrors = detail.data.point.artifacts
    .filter((artifact) => artifact.status !== "completed")
    .map((artifact) => `${artifact.kind}: ${artifact.error ?? artifact.status}`)
    .join("; ");
  assert(
    detail.data.point.status === "completed",
    `recovery point is ${detail.data.point.status}: ${detail.data.point.error ?? artifactErrors ?? "unknown error"}`
  );
  assert(detail.data.point.artifacts.length >= 3, "recovery point did not capture the Compose app and data");
  assert(detail.data.point.artifacts.every((artifact) => artifact.status === "completed"), "one or more recovery artifacts failed");
  const artifactKinds = new Set(detail.data.point.artifacts.map((artifact) => artifact.kind));
  for (const requiredKind of ["metadata", "compose_yaml", "volume", "host_folder"]) {
    assert(artifactKinds.has(requiredKind), `recovery point is missing ${requiredKind}`);
  }
  for (const artifact of detail.data.point.artifacts) {
    assert(artifact.backupTargetId === targets.s3.id, `${artifact.kind} is not linked to the remote target`);
    assert(typeof artifact.metadata?.remoteObjectKey === "string" && artifact.metadata.remoteObjectKey, `${artifact.kind} has no remote object key`);
    assert(artifact.metadata?.remoteBackend === "s3", `${artifact.kind} did not record the S3 backend`);
    assert(artifact.metadata?.localCachePolicy === "remote_only", `${artifact.kind} did not record remote-only storage`);
    assert(Number(artifact.metadata?.remoteSizeBytes) === artifact.sizeBytes, `${artifact.kind} remote size metadata does not match`);
  }
  const storageKeys = Buffer.from(JSON.stringify(detail.data.point.artifacts.map((artifact) => artifact.storageKey))).toString("base64");
  const assertRemoteOnly = [
    "const fs=require('node:fs');const path=require('node:path');",
    "const root=path.resolve('/data/backups/recovery-points',process.env.ACCEPTANCE_POINT_ID);",
    "const keys=JSON.parse(Buffer.from(process.env.ACCEPTANCE_STORAGE_KEYS,'base64').toString('utf8'));",
    "const local=keys.filter(key=>fs.existsSync(path.resolve(root,key)));",
    "if(local.length)throw new Error('remote-only artifacts remain local: '+local.join(','));"
  ].join("");
  await compose(activeProject, activeEnv, [
    "exec", "-T",
    "-e", `ACCEPTANCE_POINT_ID=${pointId}`,
    "-e", `ACCEPTANCE_STORAGE_KEYS=${storageKeys}`,
    "worker", "node", "-e", assertRemoteOnly
  ]);

  const verify = await api(`/api/recovery/points/${pointId}/verify`, { method: "POST", body: {} });
  const verifyJob = await waitForJob(verify.data.job.id, { timeoutMs: 10 * 60_000 });
  assert(verifyJob.result?.verifyStatus === "completed", `recovery verification result is ${verifyJob.result?.verifyStatus ?? "missing"}`);
  assert(Number(verifyJob.result?.artifactCount) === detail.data.point.artifacts.length, "recovery verification artifact count changed");
  const verifiedDetail = await api(`/api/recovery/points/${pointId}`);
  assert(verifiedDetail.data.point.metadata?.verifyStatus === "completed", "recovery point did not persist completed verification state");
  assert(typeof verifiedDetail.data.point.metadata?.verifiedAt === "string", "recovery point did not persist verifiedAt");
  assert((verifiedDetail.data.point.metadata?.verifyFailures ?? []).length === 0, "recovery point persisted verification failures");

  const restore = await api("/api/recovery/restore", {
    method: "POST",
    body: {
      recoveryPointId: pointId,
      targetHostId: host.id,
      options: {
        mode: "clone",
        stopExisting: false,
        projectNameOverride: `${workloadPrefix}clone`,
        volumePrefix: `${workloadPrefix}clone`,
        remapPorts: true,
        networkMode: "clone"
      }
    }
  });
  const restoreJob = await waitForJob(restore.data.job.id, { timeoutMs: 15 * 60_000 });
  assert(restoreJob.result?.composeRestored === true, "clone restore did not deploy the recovered Compose app");
  const restoredProject = restoreJob.result.projectName;
  assert(restoredProject, "clone restore did not report its project name");
  assert(restoredProject.startsWith(workloadPrefix), "clone restore returned an unexpected project name");
  assert(Number(restoreJob.result.restoredVolumes) >= 2, "clone restore did not restore both named volumes");
  assert(Number(restoreJob.result.restoredBindMounts) >= 2, "clone restore did not restore both the working directory and external bind mount");

  const sourceWorkloadVolume = `${workloadProject}_workload-data`;
  const sourceDatabaseVolume = `${workloadProject}_database-data`;
  const restoredWorkloadVolume = restoreJob.result.volumeMap?.[sourceWorkloadVolume];
  const restoredDatabaseVolume = restoreJob.result.volumeMap?.[sourceDatabaseVolume];
  const restoredBindPath = restoreJob.result.bindMap?.[expectedBindSourcePath];
  const restoredWorkingDir = restoreJob.result.bindMap?.[expectedComposeWorkingDir];
  const relativeChildPath = dockerBindPathRelativeChild(
    expectedComposeWorkingDir,
    expectedRelativeBindSourcePath
  );
  assert(relativeChildPath, "relative bind did not preserve a safe child path beneath the Compose working directory");
  const restoredRelativeBindPath = restoredWorkingDir && relativeChildPath
    ? path.posix.join(restoredWorkingDir, relativeChildPath)
    : null;
  const sourceNetwork = `${workloadProject}_acceptance-net`;
  const restoredNetwork = restoreJob.result.networkMap?.[sourceNetwork]
    ?? restoreJob.result.networkMap?.["acceptance-net"];
  assert(restoredWorkloadVolume && restoredWorkloadVolume !== sourceWorkloadVolume, "workload volume was not remapped for clone restore");
  assert(restoredDatabaseVolume && restoredDatabaseVolume !== sourceDatabaseVolume, "database volume was not remapped for clone restore");
  assert(restoredBindPath?.startsWith(`/var/lib/composebastion/restores/${pointId}/`), "bind mount was not restored into managed clone storage");
  assert(restoredWorkingDir?.startsWith(`/var/lib/composebastion/restores/${pointId}/`), "Compose working directory was not restored into managed clone storage");
  assert(restoredRelativeBindPath?.startsWith(`${restoredWorkingDir}/`), "relative bind was not derived beneath the managed Compose working directory");
  assert(restoredBindPath !== expectedBindSourcePath, "external bind reused the live source path");
  assert(restoredRelativeBindPath !== expectedRelativeBindSourcePath, "relative bind reused the live source path");
  assert(restoredNetwork && restoredNetwork !== sourceNetwork, "custom network was not remapped for clone restore");

  // The SSH fixture is a container controlling its sibling Docker daemon via
  // the socket. A real SSH host shares one filesystem with its daemon, while
  // this fixture has a container overlay. Prove recovery wrote the bind data,
  // then bridge that directory into the daemon-host bind path for runtime QA.
  const bridgeFixtureBind = `
set -eu
test "$(cat '${restoredBindPath}/proof.txt')" = '${expectedBindMarker}'
test "$(cat '${restoredRelativeBindPath}/proof.txt')" = '${expectedRelativeBindMarker}'
tar -C '${restoredBindPath}' -cf - . | docker run --rm -i -v '${restoredBindPath}:/target' alpine:3.20.8@sha256:765942a4039992336de8dd5db680586e1a206607dd06170ff0a37267a9e01958 sh -c 'cd /target && tar -xf -'
tar -C '${restoredRelativeBindPath}' -cf - . | docker run --rm -i -v '${restoredRelativeBindPath}:/target' alpine:3.20.8@sha256:765942a4039992336de8dd5db680586e1a206607dd06170ff0a37267a9e01958 sh -c 'cd /target && tar -xf -'
`;
  await compose(activeProject, activeEnv, ["exec", "-T", "sshhost", "sh", "-lc", bridgeFixtureBind]);

  const verifyCloneRuntime = `
set -eu
workload_id="$(docker ps -q --filter 'label=com.docker.compose.project=${restoredProject}' --filter 'label=com.docker.compose.service=workload')"
database_id="$(docker ps -q --filter 'label=com.docker.compose.project=${restoredProject}' --filter 'label=com.docker.compose.service=database')"
test -n "$workload_id" && test -n "$database_id"
test "$(docker exec "$workload_id" cat /data/proof.txt)" = '${expectedVolumeMarker}'
test "$(docker exec "$workload_id" cat /allowed/proof.txt)" = '${expectedBindMarker}'
test "$(docker exec "$workload_id" cat /relative-allowed/proof.txt)" = '${expectedRelativeBindMarker}'
test "$(docker exec "$database_id" psql -U postgres -Atc 'SELECT value FROM acceptance_proof WHERE id = 1')" = database-ok
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$workload_id")" = '${restoredWorkloadVolume}'
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$database_id")" = '${restoredDatabaseVolume}'
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/allowed"}}{{.Source}}{{end}}{{end}}' "$workload_id")" = '${restoredBindPath}'
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/relative-allowed"}}{{.Source}}{{end}}{{end}}' "$workload_id")" = '${restoredRelativeBindPath}'
docker network inspect '${restoredNetwork}' >/dev/null
workload_ip="$(docker inspect --format '{{(index .NetworkSettings.Networks "${restoredNetwork}").IPAddress}}' "$workload_id")"
database_ip="$(docker inspect --format '{{(index .NetworkSettings.Networks "${restoredNetwork}").IPAddress}}' "$database_id")"
test -n "$workload_ip" && test -n "$database_ip" && test "$workload_ip" != "$database_ip"
test "$workload_ip" != '${workloadAddressPrefix}.20'
test "$database_ip" != '${workloadAddressPrefix}.10'
`;
  await retry("restored Compose data and network", async () => {
    await compose(activeProject, activeEnv, ["exec", "-T", "sshhost", "sh", "-lc", verifyCloneRuntime]);
  }, { attempts: 60, delayMs: 1_000 });

  await compose(activeProject, activeEnv, [
    "exec", "-T", "sshhost", "sh", "-lc",
    `docker compose --env-file '${restoredWorkingDir}/.env' -p '${restoredProject}' -f '${restoredWorkingDir}/compose.yml' down -v --remove-orphans`
  ]);
  const cleanupRestoredBind = `
set -eu
docker run --rm -v '${restoredBindPath}:/target' alpine:3.20.8@sha256:765942a4039992336de8dd5db680586e1a206607dd06170ff0a37267a9e01958 sh -c 'find /target -mindepth 1 -delete'
docker run --rm -v '${restoredRelativeBindPath}:/target' alpine:3.20.8@sha256:765942a4039992336de8dd5db680586e1a206607dd06170ff0a37267a9e01958 sh -c 'find /target -mindepth 1 -delete'
rm -rf '${restoredBindPath}'
rm -rf '${restoredWorkingDir}'
test "$(cat '${expectedBindSourcePath}/proof.txt')" = '${expectedBindMarker}'
test "$(cat '${expectedBindHostPath}/proof.txt')" = '${expectedBindMarker}'
test "$(cat '${expectedRelativeBindHostPath}/proof.txt')" = '${expectedRelativeBindMarker}'
if [ '${expectedRelativeBindSourcePath}' != '${expectedRelativeBindHostPath}' ]; then
  test ! -e '${expectedRelativeBindSourcePath}/proof.txt'
fi
source_workload_id="$(docker ps -q --filter 'label=com.docker.compose.project=${workloadProject}' --filter 'label=com.docker.compose.service=workload')"
test -n "$source_workload_id"
test "$(docker exec "$source_workload_id" cat /allowed/proof.txt)" = '${expectedBindMarker}'
test "$(docker exec "$source_workload_id" cat /relative-allowed/proof.txt)" = '${expectedRelativeBindMarker}'
`;
  await compose(activeProject, activeEnv, ["exec", "-T", "sshhost", "sh", "-lc", cleanupRestoredBind]);
  await api(`/api/recovery/points/${pointId}`, { method: "DELETE" });
  const deleted = await fetch(`${activeBaseUrl()}/api/recovery/points/${pointId}`, {
    headers: { cookie: sessionCookie, origin: activeBaseUrl() }
  });
  assert(deleted.status === 404, `deleted recovery point returned ${deleted.status}`);
  const { ListObjectsV2Command, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${activePort("ACCEPTANCE_MINIO_PORT", portBase + 1000)}`,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: fixture.minioUser, secretAccessKey: fixture.minioPassword }
  });
  try {
    const remaining = await client.send(new ListObjectsV2Command({
      Bucket: "composebastion-acceptance",
      Prefix: `candidate/${pointId}/`
    }));
    assert((remaining.Contents ?? []).length === 0, "recovery point cleanup left remote S3 objects");
  } finally {
    client.destroy();
  }
  const cloneCleanup = `
test -z "$(docker ps -aq --filter 'label=com.docker.compose.project=${restoredProject}')"
test -z "$(docker network ls -q --filter 'label=com.docker.compose.project=${restoredProject}')"
test -z "$(docker volume ls -q --filter 'label=com.docker.compose.project=${restoredProject}')"
`;
  await compose(activeProject, activeEnv, ["exec", "-T", "sshhost", "sh", "-lc", cloneCleanup]);
  return {
    pointId,
    restoredProject,
    artifacts: detail.data.point.artifacts.length,
    remoteOnlyVerified: true,
    verificationStateVerified: true,
    restoredDataVerified: true,
    exactVolumeMarkerRestored: true,
    restoredNetworkBehaviorVerified: true,
    sshFixtureBindBridge: true,
    cleanupVerified: true
  };
}

async function cleanupFresh(stack, targets) {
  if (stack) {
    const removed = await api(`/api/compose/${stack.id}/remove`, { method: "POST", body: { removeVolumes: true } });
    await waitForJob(removed.data.job.id, { timeoutMs: 5 * 60_000 });
    await api(`/api/compose/${stack.id}`, { method: "DELETE" });
  }
  for (const target of [targets?.s3, targets?.smb].filter(Boolean)) {
    await api(`/api/recovery/targets/${target.id}`, { method: "DELETE" });
  }
}

async function freshCandidateScenario() {
  const project = projectName("fresh");
  const env = acceptanceEnv(candidateImage, { ACCEPTANCE_SCENARIO: "fresh" });
  await mkdir(env.COMPOSEBASTION_BACKUP_DIR, { recursive: true });
  await setManagerBackupDirectoryOwnership(
    env.COMPOSEBASTION_BACKUP_DIR,
    "manager"
  );
  activeProject = project;
  activeEnv = env;
  sessionCookie = "";
  operatorSessionCookie = "";
  let stack;
  let targets;
  try {
    await compose(project, env, ["up", "--detach", "--build", "postgres", "redis", "mailpit", "minio", "samba", "registry", "agent", "sshhost"], { inherit: true });
    const agentImage = await assertActiveCandidateServiceImage("agent", "agent");
    await cleanupManagedDockerState();
    await createMinioBucket();
    await seedRegistry();
    await compose(project, env, ["up", "--detach", "app"], { inherit: true });
    const appImage = await assertActiveCandidateServiceImage("app");
    const health = await waitForApiVersion(candidateVersion);
    await compose(project, env, ["up", "--detach", "worker"], { inherit: true });
    const workerImage = await assertActiveCandidateServiceImage("worker");
    await waitForReadiness("fresh candidate readiness");
    await setupOwner();

    await api("/api/auth/logout", { method: "POST", body: {} });
    sessionCookie = "";
    const user = await loginOwner();
    assert(user.role === "owner", "restored session is not the owner session");
    const sessions = await api("/api/auth/sessions");
    assert(sessions.data.sessions.some((item) => item.current), "current session was not listed");
    const ready = await api("/api/health/ready");
    assert(ready.data.ok === true, "Operations readiness was not healthy");
    const about = await verifyCandidateAboutArtifacts();
    const liveBrowser = await runLiveBrowserSuite();

    const roles = await verifyRoleBoundaries();
    const mail = await verifySmtpAndWorker();
    const registry = await verifyRegistryBoundary();
    const agent = await verifyAgentHost();
    const host = await createSshHost();
    const workerReliability = await verifyWorkerReadinessAndRedis(host);
    const leaseRecovery = await verifySafeJobLeaseRecovery(host);
    stack = await deployDisposableStack(host);
    const workload = stack.acceptanceEvidence;
    targets = await createAndTestTargets();
    const targetEvidence = targets.acceptanceEvidence;
    const recovery = await exerciseRecovery(host, stack, targets);
    await cleanupFresh(stack, targets);
    stack = undefined;
    targets = undefined;
    const storageCleanup = await assertRemoteFixtureStorageEmpty();
    return {
      runtimeVersion: health.version,
      productionImageCompose: true,
      imageBindings: { app: appImage, worker: workerImage, agent: agentImage },
      firstRunSetup: true,
      loginSession: true,
      operationsReadiness: true,
      liveBrowser,
      about,
      mail,
      roles,
      registry,
      agent,
      workerReliability,
      leaseRecovery,
      workload,
      targets: targetEvidence,
      recovery,
      storageCleanup
    };
  } catch (error) {
    await captureFailureLogs();
    throw error;
  } finally {
    if (!keep) {
      try {
        await cleanupManagedDockerState();
        await compose(project, env, ["down", "--volumes", "--remove-orphans", "--rmi", "local"]);
      } finally {
        try {
          await setManagerBackupDirectoryOwnership(
            env.COMPOSEBASTION_BACKUP_DIR,
            "cleanup"
          );
        } finally {
          activeProject = null;
          activeEnv = null;
        }
      }
    }
  }
}

async function sourceProductionScenario() {
  const project = projectName("source");
  const backupDir = path.join(runtimeDir, "source-backups");
  const sourcePort = portBase + 180;
  const sourceUrl = `http://127.0.0.1:${sourcePort}`;
  await mkdir(backupDir, { recursive: true });
  await setManagerBackupDirectoryOwnership(backupDir, "manager");
  const env = {
    ...hostEnvironment,
    ...managerComposeControls({
      httpPort: sourcePort,
      backupDir,
      corsOrigin: sourceUrl,
      allowPrivateAgentUrls: false,
      allowPrivateWebhookUrls: false,
      blockPrivateS3Endpoints: true,
      backupHostPathAllowedRoots: backupDir,
      smtpHost: ""
    }),
    ACCEPTANCE_SOURCE_HTTP_PORT: String(sourcePort),
    ACCEPTANCE_SOURCE_CONTEXT: candidateBuildContext,
    ACCEPTANCE_CANDIDATE_VERSION: candidateVersion,
    ACCEPTANCE_CANDIDATE_REVISION: candidateRevision,
    ACCEPTANCE_CANDIDATE_BUILD_DATE: candidateBuildDate
  };
  assertExplicitComposeControls(env, requiredSourceComposeControls, "source production acceptance Compose");
  const args = [
    "compose", "--env-file", "/dev/null", "--project-name", project,
    "--file", path.join(root, "docker-compose.yml"),
    "--file", path.join(root, "docker-compose.prod.example.yml"),
    "--file", sourceAcceptanceComposeFile
  ];
  const sourceCompose = (composeArgs, options = {}) => run("docker", [...args, ...composeArgs], { ...options, env });
  try {
    await sourceCompose(["up", "--detach", "--build"], { inherit: true });
    const sourceImages = {
      app: await inspectComposeServiceImage(sourceCompose, "app", {
        expectedRevision: candidateRevision,
        expectedCreated: candidateBuildDate
      }),
      worker: await inspectComposeServiceImage(sourceCompose, "worker", {
        expectedRevision: candidateRevision,
        expectedCreated: candidateBuildDate
      })
    };
    const health = await retry("source production API", async () => {
      const response = await fetch(`${sourceUrl}/api/health/ready`);
      if (!response.ok) throw new Error(await response.text());
      const versionResponse = await fetch(`${sourceUrl}/api/health`);
      const body = await versionResponse.json();
      assert(body.version === candidateVersion, `source runtime reported ${body.version}`);
      return body;
    }, { attempts: 120, delayMs: 1_000 });
    const state = await api("/api/auth/setup-state", { cookie: "", baseUrl: sourceUrl });
    assert(state.data.needsSetup === true, "fresh source installation did not request setup");
    const setup = await api("/api/auth/setup", {
      method: "POST",
      cookie: "",
      baseUrl: sourceUrl,
      body: { username: "source-owner", password: fixture.ownerPassword, includeDemoData: true }
    });
    assert(setup.setCookie.startsWith("cb_session="), "source setup did not establish a session");
    const demoHosts = await api("/api/hosts", {
      cookie: setup.setCookie,
      baseUrl: sourceUrl
    });
    assert(
      demoHosts.data.hosts.some((host) =>
        Array.isArray(host.tags) && host.tags.includes("demo")
      ),
      "source setup with demo data did not create the demo workspace"
    );
    await api("/api/auth/logout", { method: "POST", cookie: setup.setCookie, baseUrl: sourceUrl, body: {} });
    const login = await api("/api/auth/login", {
      method: "POST",
      cookie: "",
      baseUrl: sourceUrl,
      body: { identifier: "source-owner", password: fixture.ownerPassword }
    });
    assert(login.setCookie.startsWith("cb_session="), "source login did not establish a session");
    const me = await api("/api/auth/me", { cookie: login.setCookie, baseUrl: sourceUrl });
    assert(me.data.user.role === "owner", "source login did not restore the owner account");
    const channelName = `Source acceptance ${candidateVersion}`;
    await api("/api/alerts/channels", {
      method: "POST",
      cookie: login.setCookie,
      baseUrl: sourceUrl,
      body: { name: channelName, type: "email", emailTo: "source@composebastion.invalid", enabled: true }
    });
    const channels = await api("/api/alerts/channels", { cookie: login.setCookie, baseUrl: sourceUrl });
    assert(channels.data.channels.some((channel) => channel.name === channelName), "source configuration write was not readable");

    const proofName = "source-install-proof.txt";
    const proofValue = "source-backup-write-ok";
    const writeProof = `require('node:fs').writeFileSync('/data/backups/${proofName}','${proofValue}')`;
    await sourceCompose(["exec", "-T", "worker", "node", "-e", writeProof]);
    const appProof = await sourceCompose(["exec", "-T", "app", "node", "-e",
      `process.stdout.write(require('node:fs').readFileSync('/data/backups/${proofName}','utf8'))`]);
    assert(appProof.stdout === proofValue, "source app and worker did not share backup storage");
    const hostProof = await run("docker", [
      "run", "--rm", "--user", "1000:1000",
      "--volume", `${path.resolve(backupDir)}:/data/backups:ro`,
      report.candidateImages.app.id,
      "node", "-e",
      `process.stdout.write(require('node:fs').readFileSync('/data/backups/${proofName}','utf8'))`
    ]);
    assert(hostProof.stdout === proofValue, "source backup bind did not persist to the host");
    await sourceCompose(["exec", "-T", "worker", "node", "-e",
      `require('node:fs').unlinkSync('/data/backups/${proofName}')`]);
    return {
      runtimeVersion: health.version,
      productionSourceCompose: true,
      exactGitContext: true,
      treeSha: gitBuildContextEvidence.treeSha,
      sourceImages,
      firstRunSetup: true,
      demoDataSeeded: true,
      loginSession: true,
      configurationWrite: true,
      backupWrite: true,
      loopbackPort: sourcePort,
      pinnedFixtures: true
    };
  } catch (error) {
    try {
      const logs = await sourceCompose(["logs", "--no-color", "--tail", "300"]);
      await writeFile(failureLogPath, `${redact([logs.stdout, logs.stderr].filter(Boolean).join("\n"))}\n`);
      failureLogsCaptured = true;
    } catch {
      // Preserve the scenario error when Docker cannot return logs.
    }
    throw error;
  } finally {
    if (!keep) {
      try {
        await sourceCompose(["down", "--volumes", "--remove-orphans", "--rmi", "local"]);
      } finally {
        await setManagerBackupDirectoryOwnership(backupDir, "cleanup");
      }
    }
  }
}

async function hardenedContainersScenario() {
  const project = projectName("hardened");
  const managerPort = portBase + 580;
  const registryPort = portBase + 550;
  const agentPort = portBase + 590;
  const files = [productionImageComposeFile, composeFile, managerHardeningFile, agentHardeningFile];
  const env = acceptanceEnv(candidateImage, {
    ACCEPTANCE_SCENARIO: "hardened",
    ACCEPTANCE_HTTP_PORT: String(managerPort),
    ACCEPTANCE_REGISTRY_PORT: String(registryPort),
    ACCEPTANCE_HARDENED_AGENT_PORT: String(agentPort),
    COMPOSEBASTION_UID: "1000",
    COMPOSEBASTION_GID: "1000"
  });
  const backupDir = env.COMPOSEBASTION_BACKUP_DIR;
  assertExplicitComposeControls(env, requiredHardenedComposeControls, "hardened production image acceptance Compose");
  const hardenedCompose = (args, options = {}) => composeWithFiles(project, env, files, args, options);

  async function inspectService(service, expectedUser = null) {
    const container = await hardenedCompose(["--profile", "hardening", "ps", "--quiet", service]);
    assert(container.stdout, `${service} container was not created`);
    const inspected = await run("docker", ["inspect", container.stdout]);
    const detail = JSON.parse(inspected.stdout)[0];
    assert(detail.HostConfig.ReadonlyRootfs === true, `${service} root filesystem is writable`);
    assert(detail.HostConfig.Init === true, `${service} does not use an init process`);
    assert(detail.HostConfig.CapDrop?.includes("ALL"), `${service} did not drop all capabilities`);
    assert(detail.HostConfig.SecurityOpt?.includes("no-new-privileges:true"), `${service} allows new privileges`);
    if (expectedUser) assert(detail.Config.User === expectedUser, `${service} runs as ${detail.Config.User || "root"}`);
    const tmpfs = detail.HostConfig.Tmpfs?.["/tmp"]
      ?? detail.Mounts?.find((mount) => mount.Destination === "/tmp" && mount.Type === "tmpfs")?.Type;
    assert(tmpfs, `${service} does not have a writable /tmp tmpfs`);
    const environment = Object.fromEntries((detail.Config.Env ?? []).map((entry) => {
      const separator = entry.indexOf("=");
      return separator === -1 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
    return { detail, environment };
  }

  async function assertRootfsRejectsWrite(service) {
    const script = "const fs=require('node:fs');try{fs.writeFileSync('/app/.hardening-write-test','blocked');process.exit(1)}catch{process.exit(0)}";
    await hardenedCompose(["--profile", "hardening", "exec", "-T", service, "node", "-e", script]);
  }

  async function agentApi(pathname, { method = "GET", body } = {}) {
    const response = await fetch(`http://127.0.0.1:${agentPort}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${fixture.agentToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
    if (!response.ok) throw new Error(`${method} agent ${pathname} returned ${response.status}: ${redact(raw)}`);
    return data;
  }

  await mkdir(backupDir, { recursive: true });
  await setManagerBackupDirectoryOwnership(backupDir, "manager");
  activeProject = project;
  activeEnv = env;
  try {
    await hardenedCompose([
      "--profile", "hardening", "up", "--detach",
      "postgres", "redis", "registry", "app", "worker", "composebastion-agent"
    ], { inherit: true });
    const imageBindings = {
      app: await inspectComposeServiceImage(hardenedCompose, "app", {
        expectedId: report.candidateImages.app.id,
        expectedReference: candidateImage,
        expectedRevision: candidateRevision,
        expectedCreated: candidateBuildDate
      }),
      worker: await inspectComposeServiceImage(hardenedCompose, "worker", {
        expectedId: report.candidateImages.app.id,
        expectedReference: candidateImage,
        expectedRevision: candidateRevision,
        expectedCreated: candidateBuildDate
      }),
      agent: await inspectComposeServiceImage(hardenedCompose, "composebastion-agent", {
        expectedId: report.candidateImages.agent.id,
        expectedReference: candidateAgentImage,
        expectedRevision: candidateRevision,
        expectedCreated: candidateBuildDate
      })
    };
    await seedRegistry();
    await waitForApiVersion(candidateVersion);
    await waitForReadiness("hardened manager readiness");

    for (const service of ["app", "worker"]) {
      const inspected = await inspectService(service, "1000:1000");
      assert(inspected.environment.HOME === "/tmp", `${service} HOME is not routed to writable /tmp`);
      assert(inspected.environment.TRIVY_CACHE_DIR === "/var/cache/composebastion/trivy", `${service} Trivy cache path is incorrect`);
      const backupMount = inspected.detail.Mounts?.find((mount) => mount.Destination === "/data/backups");
      const cacheMount = inspected.detail.Mounts?.find((mount) => mount.Destination === "/var/cache/composebastion/trivy");
      assert(backupMount?.Type === "bind", `${service} backup storage is not the production bind mount`);
      assert(cacheMount?.Type === "volume", `${service} Trivy cache is not a dedicated volume`);
      const identity = await hardenedCompose(["--profile", "hardening", "exec", "-T", service, "sh", "-c", "printf '%s:%s' \"$(id -u)\" \"$(id -g)\""]);
      assert(identity.stdout === "1000:1000", `${service} process identity is ${identity.stdout}`);
      await hardenedCompose([
        "--profile", "hardening", "exec", "-T", service, "node", "-e",
        `const fs=require('node:fs');fs.writeFileSync('/data/backups/${service}-proof','ok');fs.writeFileSync('/var/cache/composebastion/trivy/${service}-proof','ok');fs.writeFileSync('/tmp/${service}-proof','ok')`
      ]);
      await assertRootfsRejectsWrite(service);
    }

    await hardenedCompose(["--profile", "hardening", "up", "--detach", "--force-recreate", "app", "worker"]);
    imageBindings.recreatedApp = await inspectComposeServiceImage(hardenedCompose, "app", {
      expectedId: report.candidateImages.app.id,
      expectedReference: candidateImage
    });
    imageBindings.recreatedWorker = await inspectComposeServiceImage(hardenedCompose, "worker", {
      expectedId: report.candidateImages.app.id,
      expectedReference: candidateImage
    });
    await waitForReadiness("recreated hardened manager readiness");
    const managerProof = await hardenedCompose([
      "--profile", "hardening", "exec", "-T", "app", "node", "-e",
      "const fs=require('node:fs');for(const root of ['/data/backups','/var/cache/composebastion/trivy'])for(const service of ['app','worker'])if(fs.readFileSync(`${root}/${service}-proof`,'utf8')!=='ok')process.exit(1)"
    ]);
    assert(managerProof.stdout === "", "manager writable storage proof emitted unexpected output");

    await retry("hardened agent", async () => {
      const health = await agentApi("/api/health");
      assert(health.ok === true, health.dockerError ?? "agent Docker check failed");
    }, { attempts: 90, delayMs: 1_000 });
    const inspectedAgent = await inspectService("composebastion-agent");
    assert(inspectedAgent.environment.HOME === "/tmp/composebastion", "agent HOME is not on persistent storage");
    assert(inspectedAgent.environment.DOCKER_CONFIG === "/tmp/composebastion/.docker", "agent Docker config is not on persistent storage");
    for (const key of ["AGENT_READ_RATE_LIMIT", "AGENT_RUN_RATE_LIMIT", "AGENT_FILE_RATE_LIMIT", "AGENT_STREAM_RATE_LIMIT"]) {
      assert(inspectedAgent.environment[key] === env[key], `${key} did not propagate to the hardened agent`);
    }
    const agentDataMount = inspectedAgent.detail.Mounts?.find((mount) => mount.Destination === "/tmp/composebastion");
    assert(agentDataMount?.Type === "volume", "agent persistent data is not a named volume");
    const agentIdentity = await hardenedCompose(["--profile", "hardening", "exec", "-T", "composebastion-agent", "id", "-u"]);
    assert(agentIdentity.stdout === "0", `agent unexpectedly runs as UID ${agentIdentity.stdout}`);
    await assertRootfsRejectsWrite("composebastion-agent");

    const dockerResult = await agentApi("/api/run", {
      method: "POST",
      body: { command: "docker version --format '{{.Server.Version}}'" }
    });
    assert(dockerResult.code === 0 && dockerResult.stdout.trim(), "agent could not run an allowed Docker command");
    await agentApi("/api/files/write", {
      method: "POST",
      body: { path: "/tmp/composebastion/acceptance/persistence.txt", content: "persistent-agent-data" }
    });

    assert(/^[a-z0-9]+$/i.test(fixture.registryUser) && /^[a-z0-9]+$/i.test(fixture.registryPassword), "registry fixture credentials are not shell-safe");
    const registryOrigin = `127.0.0.1:${registryPort}`;
    const login = await agentApi("/api/run", {
      method: "POST",
      body: {
        command: `printf %s '${fixture.registryPassword}' | docker login '${registryOrigin}' --username '${fixture.registryUser}' --password-stdin`
      }
    });
    assert(login.code === 0, "agent registry login failed");

    await hardenedCompose([
      "--profile", "hardening", "up", "--detach", "--force-recreate", "composebastion-agent"
    ]);
    imageBindings.recreatedAgent = await inspectComposeServiceImage(hardenedCompose, "composebastion-agent", {
      expectedId: report.candidateImages.agent.id,
      expectedReference: candidateAgentImage
    });
    await retry("recreated hardened agent", async () => {
      const health = await agentApi("/api/health");
      assert(health.ok === true, "recreated agent is not healthy");
    }, { attempts: 90, delayMs: 1_000 });
    const persisted = await agentApi("/api/files/read?path=%2Ftmp%2Fcomposebastion%2Facceptance%2Fpersistence.txt");
    assert(persisted.content === "persistent-agent-data", "agent file did not survive container recreation");
    const configResponse = await agentApi("/api/files/read?path=%2Ftmp%2Fcomposebastion%2F.docker%2Fconfig.json");
    const dockerConfig = JSON.parse(configResponse.content);
    const storedCredential = dockerConfig.auths?.[registryOrigin] ?? dockerConfig.auths?.[`http://${registryOrigin}`];
    assert(storedCredential?.auth || storedCredential?.identitytoken, "agent registry credentials did not survive container recreation");

    return {
      productionImageCompose: true,
      imageBindings,
      managerIdentity: "1000:1000",
      managerRootfs: "read-only",
      managerCapabilitiesDropped: true,
      managerNoNewPrivileges: true,
      managerInit: true,
      managerTmpfs: true,
      writableBackups: true,
      writableTrivyCache: true,
      persistentBackups: true,
      persistentTrivyCache: true,
      agentIdentity: "root (Docker socket trust boundary)",
      agentRootfs: "read-only",
      agentCapabilitiesDropped: true,
      agentNoNewPrivileges: true,
      agentInit: true,
      agentTmpfs: true,
      agentDockerCommand: true,
      agentFilePersistence: true,
      agentRegistryLoginPersistence: true
    };
  } catch (error) {
    await captureFailureLogs();
    throw error;
  } finally {
    if (!keep) {
      try {
        await hardenedCompose(["--profile", "hardening", "down", "--volumes", "--remove-orphans", "--rmi", "local"]);
      } finally {
        try {
          await setManagerBackupDirectoryOwnership(backupDir, "cleanup");
        } finally {
          activeProject = null;
          activeEnv = null;
        }
      }
    }
  }
}

function materializePre12UpgradeCompose(contents, acceptanceRuntimeDir) {
  const definition = parse(contents);
  const app = definition?.services?.app;
  assert(app && definition.services?.worker, "public pre-1.2 Compose is missing app or worker");
  app.volumes = [...(app.volumes ?? []), `${acceptanceRuntimeDir}:/acceptance-runtime`];
  const forcedFailureProgram = [
    "const fs=require('node:fs');",
    "const version=require('/app/package.json').version;",
    `if(version===${JSON.stringify(candidateVersion)}&&fs.existsSync('/acceptance-runtime/force-candidate-unhealthy'))process.exit(1);`,
    "fetch('http://127.0.0.1:8080/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"
  ].join("");
  app.healthcheck = {
    test: ["CMD", "node", "-e", forcedFailureProgram],
    interval: "2s",
    timeout: "3s",
    retries: 3,
    start_period: "5s"
  };
  return stringify(definition);
}

function renderUpgradeEnvironment(values) {
  return `${Object.entries(values).map(([name, raw]) => {
    const value = String(raw ?? "");
    assert(/^[A-Z][A-Z0-9_]*$/.test(name), `invalid upgrade environment name ${name}`);
    assert(!/[\r\n]/.test(value), `upgrade environment ${name} contains a newline`);
    return `${name}=${value}`;
  }).join("\n")}\n`;
}

async function waitForSelfUpdateOutcome(outcomePath, expectedStatus, readOutcome) {
  assert(typeof readOutcome === "function", "self-update outcome reader is required");
  return retry(`self-update outcome ${path.basename(outcomePath)}`, async () => {
    const contents = await readOutcome(outcomePath, "self-update outcome");
    const outcome = Object.fromEntries(contents.trim().split(/\r?\n/).map((line) => {
      const separator = line.indexOf("=");
      assert(separator > 0, `invalid updater outcome line ${line}`);
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    assert(outcome.status === expectedStatus,
      `updater outcome is ${outcome.status ?? "missing"}, expected ${expectedStatus}`);
    return outcome;
  }, { attempts: 240, delayMs: 1_000 });
}

async function upgradeScenario(baseline) {
  const scenarioName = `upgrade-${baseline.key}`;
  const project = projectName(scenarioName);
  const managerDir = path.join(runtimeDir, scenarioName);
  const publicComposeFile = path.join(managerDir, "docker-compose.image.yml");
  const managerEnvPath = path.join(managerDir, ".env");
  const forcedFailureMarker = path.join(runtimeDir, "force-candidate-unhealthy");
  const externalOwnershipTarget = path.join(runtimeDir, `${scenarioName}-external-owner`);
  const backupSymlinkPath = path.join(scenarioBackupDir(scenarioName), ".composebastion-storage-owner");
  const legacyDatabasePlaceholder = "postgres://composebastion:composebastion@postgres:5432/composebastion";
  const registryOrigin = `127.0.0.1:${portBase + 50}`;
  const registryImage = `${registryOrigin}/composebastion-app`;
  const publicRegistryReference = `${registryImage}:${baseline.version}`;
  const bridgeRegistryReference = `${registryImage}:${acceptanceUpgradeBridge.version}`;
  const candidateRegistryReference = `${registryImage}:${candidateVersion}`;
  const upgradeOverrides = {
    ACCEPTANCE_SCENARIO: scenarioName,
    ACCEPTANCE_HTTP_PORT: String(portBase + baseline.portOffset),
    ACCEPTANCE_RUNTIME_DIR: runtimeDir,
    COMPOSEBASTION_IMAGE: registryImage
  };
  const oldOverrides = {
    ...upgradeOverrides,
    COMPOSEBASTION_VERSION: baseline.version,
    DATABASE_URL: legacyDatabasePlaceholder
  };
  const newOverrides = {
    ...upgradeOverrides,
    COMPOSEBASTION_VERSION: candidateVersion,
    DATABASE_URL: ""
  };
  let oldEnv = acceptanceEnv(baseline.pinnedImage, oldOverrides);
  const newEnv = acceptanceEnv(candidateImage, newOverrides);
  const scenarioCompose = (env, args, options = {}) => (
    upgradeCompose(project, env, publicComposeFile, args, options)
  );
  const readProtectedManagerFile = async (filePath, label) => {
    const resolvedManagerDir = path.resolve(managerDir);
    const resolvedFilePath = path.resolve(filePath);
    assert(
      path.dirname(resolvedFilePath) === resolvedManagerDir,
      `${label} is not a direct child of the manager directory`
    );
    const managerDirectory = await lstat(resolvedManagerDir);
    assert(
      managerDirectory.isDirectory() && !managerDirectory.isSymbolicLink(),
      "upgrade manager directory is not a real directory"
    );
    const result = await scenarioCompose(activeEnv, [
      "exec", "-T", "sshhost", "sh", "-ceu",
      "file=$1; [ -f \"$file\" ]; [ ! -L \"$file\" ]; [ \"$(stat -c %a -- \"$file\")\" = 600 ]; exec cat -- \"$file\"",
      "read-protected-manager-file", resolvedFilePath
    ]);
    return result.stdout;
  };
  const clearProtectedManagerDirectory = async () => {
    const resolvedManagerDir = path.resolve(managerDir);
    const resolvedRuntimeDir = path.resolve(runtimeDir);
    assert(
      path.dirname(resolvedManagerDir) === resolvedRuntimeDir,
      "upgrade manager directory is not a direct child of the acceptance runtime"
    );
    const managerDirectory = await lstat(resolvedManagerDir);
    assert(
      managerDirectory.isDirectory() && !managerDirectory.isSymbolicLink(),
      "upgrade manager cleanup target is not a real directory"
    );
    const candidateAppId = report.candidateImages?.app?.id;
    assert(candidateAppId, "upgrade manager cleanup is missing the candidate app image");
    const cleanerProgram = [
      "const fs=require('node:fs');",
      "const path=require('node:path');",
      "for(const name of fs.readdirSync('/manager')){",
      "if(name==='.'||name==='..'||name.includes('/'))process.exit(2);",
      "fs.rmSync(path.join('/manager',name),{recursive:true,force:true,maxRetries:3});",
      "}"
    ].join("");
    await run("docker", [
      "run", "--rm", "--user", "0:0", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--cap-add", "DAC_READ_SEARCH",
      "--security-opt", "no-new-privileges=true",
      "--volume", `${resolvedManagerDir}:/manager`,
      candidateAppId,
      "node", "-e", cleanerProgram
    ]);
  };
  await mkdir(oldEnv.COMPOSEBASTION_BACKUP_DIR, { recursive: true });
  activeProject = project;
  activeEnv = oldEnv;
  sessionCookie = "";
  const upgradeJobId = randomUUID();
  const upgradeLocalTargetId = randomUUID();
  const upgradeRepositoryId = randomUUID();
  const upgradeEnvironmentSecret = runtimeSecret(20);
  const upgradeMarker = `${fixture.publicMarker}-${baseline.key}`;
  const projectVolumeNames = async () => {
    const result = await run("docker", [
      "volume", "ls",
      "--filter", `label=com.docker.compose.project=${project}`,
      "--format", "{{.Name}}"
    ]);
    return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).sort();
  };
  const assertManagedCredential = async (credential, label) => {
    const credentialCommand = credential === "legacy"
      ? "PGPASSWORD=composebastion psql -h 127.0.0.1 -U composebastion -d composebastion -Atc 'SELECT 1'"
      : "PGPASSWORD=\"$POSTGRES_PASSWORD\" psql -h 127.0.0.1 -U composebastion -d composebastion -Atc 'SELECT 1'";
    const result = await scenarioCompose(activeEnv, [
      "exec", "-T", "postgres", "sh", "-ceu",
      credentialCommand
    ]);
    assert(result.stdout.trim() === "1", `${label} did not accept the expected ${credential} managed credential`);
  };
  try {
    await mkdir(managerDir, { recursive: true, mode: 0o700 });
    const exactPublicCompose = gitCapture(["show", `v${baseline.version}:docker-compose.image.yml`]);
    await writeFile(
      publicComposeFile,
      materializePre12UpgradeCompose(exactPublicCompose, runtimeDir),
      { mode: 0o600 }
    );
    const publicControls = [...exactPublicCompose.matchAll(/\$\{([A-Z0-9_]+)/g)]
      .map((match) => match[1]);
    const managerEnvironment = Object.fromEntries(
      [...new Set(publicControls)].map((name) => [name, oldEnv[name] ?? ""])
    );
    Object.assign(managerEnvironment, {
      COMPOSE_PROJECT_NAME: project,
      COMPOSEBASTION_IMAGE: registryImage,
      COMPOSEBASTION_VERSION: baseline.version,
      DATABASE_URL: oldOverrides.DATABASE_URL
    });
    await writeFile(managerEnvPath, renderUpgradeEnvironment(managerEnvironment), { mode: 0o600 });
    const initialManagerEnvironment = await lstat(managerEnvPath);
    assert(initialManagerEnvironment.isFile() && !initialManagerEnvironment.isSymbolicLink(),
      "upgrade manager environment is not a regular file");
    assert((initialManagerEnvironment.mode & 0o777) === 0o600,
      "upgrade manager environment is not protected with mode 0600");
    await writeFile(externalOwnershipTarget, "external ownership must remain unchanged\n", { mode: 0o600 });
    const externalOwnerBefore = await stat(externalOwnershipTarget);
    await rm(backupSymlinkPath, { force: true });
    await symlink(`/acceptance-runtime/${path.basename(externalOwnershipTarget)}`, backupSymlinkPath);
    await setManagerBackupDirectoryOwnership(
      oldEnv.COMPOSEBASTION_BACKUP_DIR,
      "manager"
    );
    await run("docker", ["pull", baseline.pinnedImage], { inherit: true });
    const publicImageEvidence = await inspectPublicUpgradeImage(baseline);
    const bridgeImageEvidence = await inspectBridgeUpgradeImage();
    oldEnv = acceptanceEnv(publicImageEvidence.repoDigest, oldOverrides);
    activeEnv = oldEnv;
    await scenarioCompose(oldEnv, ["up", "--detach", "--build", "postgres", "redis", "registry", "sshhost"], { inherit: true });
    await retry("upgrade registry", async () => {
      const response = await fetch(`http://${registryOrigin}/v2/`);
      assert(response.ok, `upgrade registry returned ${response.status}`);
    });
    for (const [imageId, reference] of [
      [publicImageEvidence.id, publicRegistryReference],
      [bridgeImageEvidence.id, bridgeRegistryReference],
      [report.candidateImages.app.id, candidateRegistryReference]
    ]) {
      await run("docker", ["image", "tag", imageId, reference]);
      await run("docker", ["push", reference], { inherit: true });
    }
    if (baseline.initialManagedCredential === "legacy") {
      await scenarioCompose(oldEnv, [
        "exec", "-T", "postgres",
        "psql", "-v", "ON_ERROR_STOP=1", "-U", "composebastion", "-d", "composebastion", "-c",
        "ALTER ROLE composebastion PASSWORD 'composebastion'"
      ]);
    }
    // Start the exact public image without candidate-only initializers. The
    // candidate preparation must repair this nested root-owned path later.
    await scenarioCompose(oldEnv, ["up", "--detach", "--no-deps", "app", "worker"], { inherit: true });
    const imageBindings = {
      publicApp: await inspectComposeServiceImage(
        (args, options) => scenarioCompose(oldEnv, args, options),
        "app",
        { expectedId: publicImageEvidence.id, expectedReference: publicRegistryReference }
      ),
      publicWorker: await inspectComposeServiceImage(
        (args, options) => scenarioCompose(oldEnv, args, options),
        "worker",
        { expectedId: publicImageEvidence.id, expectedReference: publicRegistryReference }
      )
    };
    const initialVolumeNames = await projectVolumeNames();
    assert(initialVolumeNames.length > 0, "upgrade fixture did not create persistent Compose volumes");
    await waitForApiVersion(baseline.version);
    await assertManagedCredential(baseline.initialManagedCredential, `public ${baseline.version}`);
    await scenarioCompose(oldEnv, [
      "exec", "-T", "app", "sh", "-ceu",
      "mkdir -p /data/backups/recovery-points; touch /data/backups/recovery-points/.pre-1.2-owner"
    ]);
    await seedRegistry();
    await setupOwner();
    await api("/api/alerts/channels", {
      method: "POST",
      body: { name: upgradeMarker, type: "email", emailTo: "upgrade@composebastion.invalid", enabled: true }
    });
    const savedRegistry = await api("/api/registries", {
      method: "POST",
      body: {
        name: `${upgradeMarker}-registry`,
        url: "http://registry:5000",
        username: fixture.registryUser,
        password: fixture.registryPassword,
        insecure: true
      }
    });
    const upgradeDemoPassword = runtimeSecret(20);
    const demoHostResponse = await api("/api/hosts", {
      method: "POST",
      body: {
        name: "Upgrade demo host",
        hostname: "demo.upgrade.composebastion.local",
        port: 22,
        username: "demo",
        connectionMode: "ssh",
        sshAuthType: "password",
        sshPassword: upgradeDemoPassword,
        dockerSocketPath: "/var/run/docker.sock",
        tags: ["demo", "acceptance", scenarioName]
      }
    });
    const demoHost = demoHostResponse.data.host;
    await waitForJob(demoHostResponse.data.job.id, { timeoutMs: 2 * 60_000 });
    const managerHostResponse = await api("/api/hosts", {
      method: "POST",
      body: {
        name: `Upgrade manager ${baseline.version}`,
        hostname: "sshhost",
        port: 22,
        username: "root",
        connectionMode: "ssh",
        sshAuthType: "key",
        sshPrivateKey,
        dockerSocketPath: "/var/run/docker.sock",
        tags: ["acceptance", "manager", scenarioName]
      }
    });
    const managerHost = managerHostResponse.data.host;
    await waitForJob(managerHostResponse.data.job.id, { timeoutMs: 3 * 60_000 });
    await api("/api/self-update/config", {
      method: "PUT",
      body: {
        hostId: managerHost.id,
        workingDir: managerDir,
        composeFile: path.basename(publicComposeFile),
        versionMode: "pinned",
        targetVersion: acceptanceUpgradeBridge.version
      }
    });
    await scenarioCompose(oldEnv, ["stop", "worker"]);
    const queued = await api(`/api/hosts/${demoHost.id}/actions`, {
      method: "POST",
      body: { type: "host.check", payload: {} }
    });
    const queuedJobId = queued.data.job.id;
    const queuedBeforeUpgrade = await api(`/api/jobs/${queuedJobId}`);
    assert(queuedBeforeUpgrade.data.job.status === "queued", "pre-upgrade API job was not queued while the worker was stopped");
    assert(/^[a-z0-9-]+$/i.test(upgradeMarker), "upgrade marker is not SQL-fixture safe");
    await scenarioCompose(oldEnv, [
      "exec", "-T", "postgres",
      "psql", "-v", "ON_ERROR_STOP=1", "-U", "composebastion", "-d", "composebastion", "-c",
      `INSERT INTO operation_jobs (id, type, status, payload, result, created_at, updated_at, started_at, completed_at)
       VALUES ('${upgradeJobId}', 'host.check', 'completed',
         jsonb_build_object('acceptanceMarker', '${upgradeMarker}'),
         jsonb_build_object('preserved', true),
         now() - interval '1 minute', now(), now() - interval '30 seconds', now());
       INSERT INTO backup_targets (
         id, name, kind, enabled, config, local_cache_policy,
         health_status, health_checked_at, health_error, created_at, updated_at
       ) VALUES (
         '${upgradeLocalTargetId}', '${upgradeMarker}-legacy-local', 'local', true,
         jsonb_build_object('basePath', '/legacy/unsupported/path'), 'remote_only',
         'healthy', now(), 'legacy probe did not perform I/O', now(), now()
       );
       INSERT INTO github_repositories (
         id, name, repository_url, owner, repo, branch, compose_path, project_name,
         env, default_host_id, host_clone_url, host_clone_directory, created_at, updated_at
       ) VALUES (
         '${upgradeRepositoryId}', '${upgradeMarker}-repository',
         'https://github.com/composebastion/example.git', 'composebastion', 'example',
         'main', 'compose.yml', '${upgradeMarker}-project',
         E'PUBLIC_SETTING=upgrade-preserved\\nSECRET_TOKEN=${upgradeEnvironmentSecret}',
         '${demoHost.id}', 'https://github.com/composebastion/example.git',
         '/tmp/${upgradeMarker}-repository', now(), now()
       )`
    ]);
    const oldHopStart = await api("/api/self-update/start", {
      method: "POST",
      body: { targetVersion: acceptanceUpgradeBridge.version }
    });
    const oldHopJobId = oldHopStart.data.job.id;
    await scenarioCompose(oldEnv, ["up", "--detach", "--no-deps", "worker"], { inherit: true });
    await waitForApiVersion(acceptanceUpgradeBridge.version);
    const bridgeEnv = acceptanceEnv(bridgeImageEvidence.repoDigest, {
      ...upgradeOverrides,
      COMPOSEBASTION_VERSION: acceptanceUpgradeBridge.version,
      DATABASE_URL: oldOverrides.DATABASE_URL
    });
    activeEnv = bridgeEnv;
    sessionCookie = "";
    await loginOwner();
    const oldHopJob = await api(`/api/jobs/${oldHopJobId}`);
    assert(oldHopJob.data.job.status === "completed", "public updater did not complete the old-to-bridge handoff job");
    imageBindings.bridgeApp = await inspectComposeServiceImage(
      (args, options) => scenarioCompose(bridgeEnv, args, options),
      "app",
      { expectedId: bridgeImageEvidence.id, expectedReference: bridgeRegistryReference }
    );
    imageBindings.bridgeWorker = await inspectComposeServiceImage(
      (args, options) => scenarioCompose(bridgeEnv, args, options),
      "worker",
      { expectedId: bridgeImageEvidence.id, expectedReference: bridgeRegistryReference }
    );
    const dependencyContainerIds = {
      postgres: (await scenarioCompose(bridgeEnv, ["ps", "-q", "postgres"])).stdout.trim(),
      redis: (await scenarioCompose(bridgeEnv, ["ps", "-q", "redis"])).stdout.trim()
    };
    assert(dependencyContainerIds.postgres && dependencyContainerIds.redis,
      "bridge fixture dependency container identities are missing");
    await api("/api/self-update/config", {
      method: "PUT",
      body: {
        hostId: managerHost.id,
        workingDir: managerDir,
        composeFile: path.basename(publicComposeFile),
        versionMode: "pinned",
        targetVersion: candidateVersion
      }
    });
    const environmentBeforeFailure = await readProtectedManagerFile(
      managerEnvPath,
      "pre-upgrade manager environment"
    );
    await writeFile(forcedFailureMarker, "candidate-only health failure\n", { mode: 0o600 });
    const failedStart = await api("/api/self-update/start", {
      method: "POST",
      body: { targetVersion: candidateVersion }
    });
    const failedJobId = failedStart.data.job.id;
    const failedOutcomePath = path.join(managerDir, `.composebastion-self-update-${failedJobId}.outcome`);
    const failedLogPath = path.join(managerDir, `.composebastion-self-update-${failedJobId}.log`);
    const failedOutcome = await waitForSelfUpdateOutcome(
      failedOutcomePath,
      "failed",
      readProtectedManagerFile
    );
    assert(failedOutcome.stage === "verification" && failedOutcome.rollback === "succeeded",
      `forced updater failure reported stage=${failedOutcome.stage} rollback=${failedOutcome.rollback}`);
    await waitForApiVersion(acceptanceUpgradeBridge.version);
    await waitForReadiness("automatic bridge rollback readiness");
    sessionCookie = "";
    await loginOwner();
    const failedJob = await retry("failed updater API reconciliation", async () => {
      const current = await api(`/api/jobs/${failedJobId}`);
      assert(current.data.job.status === "failed", `bridge updater API job is ${current.data.job.status}`);
      return current;
    }, { attempts: 120, delayMs: 1_000 });
    assert(failedJob.data.job.result?.outcome?.status === "failed"
      && failedJob.data.job.result?.outcome?.stage === "verification",
    "bridge updater failure API job is missing its authoritative outcome");
    assert(await readProtectedManagerFile(
      managerEnvPath,
      "rolled-back manager environment"
    ) === environmentBeforeFailure,
      "automatic rollback did not restore the exact pre-upgrade environment");
    const expectedTransition = baseline.expectedCredentialTransition;
    const expectedEnvironmentAction = baseline.expectedEnvironmentAction;
    const failedLog = await readProtectedManagerFile(failedLogPath, "failed updater log");
    assert(failedLog.includes(
      `COMPOSEBASTION_DATABASE_CREDENTIAL_TRANSITION=${expectedTransition}`
    ), "failed updater log does not record the candidate preparation transition");
    assert(failedLog.includes(
      `COMPOSEBASTION_DATABASE_ENVIRONMENT_ACTION=${expectedEnvironmentAction}`
    ), "failed updater log does not record the raw environment action");
    await assertManagedCredential(baseline.rollbackManagedCredential, `failed ${baseline.version} rollback`);
    imageBindings.rollbackApp = await inspectComposeServiceImage(
      (args, options) => scenarioCompose(bridgeEnv, args, options),
      "app",
      { expectedId: bridgeImageEvidence.id, expectedReference: bridgeRegistryReference }
    );
    imageBindings.rollbackWorker = await inspectComposeServiceImage(
      (args, options) => scenarioCompose(bridgeEnv, args, options),
      "worker",
      { expectedId: bridgeImageEvidence.id, expectedReference: bridgeRegistryReference }
    );
    assert((await scenarioCompose(bridgeEnv, ["ps", "-q", "postgres"])).stdout.trim() === dependencyContainerIds.postgres,
      "automatic rollback recreated PostgreSQL");
    assert((await scenarioCompose(bridgeEnv, ["ps", "-q", "redis"])).stdout.trim() === dependencyContainerIds.redis,
      "automatic rollback recreated Redis");
    await rm(forcedFailureMarker, { force: true });
    const successfulStart = await api("/api/self-update/start", {
      method: "POST",
      body: { targetVersion: candidateVersion }
    });
    const successfulJobId = successfulStart.data.job.id;
    const successfulOutcomePath = path.join(managerDir, `.composebastion-self-update-${successfulJobId}.outcome`);
    const successfulLogPath = path.join(managerDir, `.composebastion-self-update-${successfulJobId}.log`);
    const successfulOutcome = await waitForSelfUpdateOutcome(
      successfulOutcomePath,
      "passed",
      readProtectedManagerFile
    );
    assert(successfulOutcome.stage === "complete" && successfulOutcome.rollback === "not_required",
      "successful bridge-to-candidate updater outcome is incomplete");
    activeEnv = newEnv;
    await waitForApiVersion(candidateVersion);
    await waitForReadiness("successful bridge-to-candidate readiness");
    sessionCookie = "";
    await loginOwner();
    const successfulJob = await retry("successful updater API reconciliation", async () => {
      const current = await api(`/api/jobs/${successfulJobId}`);
      assert(current.data.job.status === "completed", `successful updater API job is ${current.data.job.status}`);
      return current.data.job;
    }, { attempts: 120, delayMs: 1_000 });
    assert(successfulJob.result?.outcome?.status === "passed",
      "successful updater API job is missing its authoritative outcome");
    const canonicalEnvironment = await readProtectedManagerFile(
      managerEnvPath,
      "successful manager environment"
    );
    const successfulLog = await readProtectedManagerFile(
      successfulLogPath,
      "successful updater log"
    );
    assert(successfulLog.includes(
      `COMPOSEBASTION_DATABASE_CREDENTIAL_TRANSITION=${expectedTransition}`
    ), "successful updater log does not record the candidate preparation transition");
    assert(successfulLog.includes(
      `COMPOSEBASTION_DATABASE_ENVIRONMENT_ACTION=${expectedEnvironmentAction}`
    ), "successful updater log does not record the raw environment action");
    assert(canonicalEnvironment.includes(`COMPOSEBASTION_VERSION=${candidateVersion}\n`),
      "successful updater did not persist the candidate version");
    assert(canonicalEnvironment.includes("DATABASE_URL=\n"),
      "successful updater did not persist the canonical managed database selection");
    assert(canonicalEnvironment.includes("# ComposeBastion managed legacy database transition\nDATABASE_URL=\n"),
      "raw legacy environment assignment was not replaced with its managed canonical override");
    await assertManagedCredential("canonical", `successful ${baseline.version} upgrade`);
    imageBindings.candidateApp = await inspectComposeServiceImage(
      (args, options) => scenarioCompose(newEnv, args, options),
      "app",
      {
        expectedId: report.candidateImages.app.id,
        expectedReference: candidateRegistryReference,
        expectedRevision: candidateRevision,
        expectedCreated: candidateBuildDate
      }
    );
    imageBindings.candidateWorker = await inspectComposeServiceImage(
      (args, options) => scenarioCompose(newEnv, args, options),
      "worker",
      {
        expectedId: report.candidateImages.app.id,
        expectedReference: candidateRegistryReference,
        expectedRevision: candidateRevision,
        expectedCreated: candidateBuildDate
      }
    );
    imageBindings.reupgradeApp = imageBindings.candidateApp;
    imageBindings.reupgradeWorker = imageBindings.candidateWorker;
    await scenarioCompose(newEnv, [
      "exec", "-T", "app", "node", "-e",
      "const s=require('node:fs').lstatSync('/data/backups/recovery-points/.pre-1.2-owner');if(s.uid!==1000||s.gid!==1000)process.exit(1)"
    ]);
    await scenarioCompose(newEnv, [
      "exec", "-T", "app", "node", "-e",
      "const s=require('node:fs').lstatSync('/data/backups/.composebastion-storage-owner');if(!s.isSymbolicLink())process.exit(1)"
    ]);
    const externalOwnerAfter = await stat(externalOwnershipTarget);
    assert(
      externalOwnerAfter.uid === externalOwnerBefore.uid
        && externalOwnerAfter.gid === externalOwnerBefore.gid,
      "backup ownership preparation changed an external symlink target"
    );
    assert(
      await readRegularFileNoFollow(externalOwnershipTarget, {
        expectedMode: 0o600,
        label: "external ownership target"
      }) === "external ownership must remain unchanged\n",
      "backup ownership preparation overwrote an external symlink target"
    );
    sessionCookie = "";
    await loginOwner();
    const channels = await api("/api/alerts/channels");
    assert(channels.data.channels.some((channel) => channel.name === upgradeMarker), "configuration did not survive the image upgrade");
    const registries = await api("/api/registries");
    assert(registries.data.registries.some((registry) => registry.id === savedRegistry.data.registry.id), "encrypted registry configuration did not survive the upgrade");
    const encryptedRegistryTags = await api(`/api/image-tags?image=${encodeURIComponent("registry:5000/acceptance/test")}`);
    assert(encryptedRegistryTags.data.tags.includes("1.0.0"), "upgraded manager could not use preserved registry credentials");
    const state = await api("/api/auth/setup-state");
    assert(state.data.needsSetup === false, "database state did not survive the image upgrade");
    const upgradedSource = await api(`/api/deployment-sources/${upgradeRepositoryId}`);
    assert(
      upgradedSource.data.source.safeEnvironment?.PUBLIC_SETTING === "upgrade-preserved",
      "legacy source non-secret environment was not preserved through encrypted backfill"
    );
    assert(
      !Object.prototype.hasOwnProperty.call(upgradedSource.data.source.safeEnvironment ?? {}, "SECRET_TOKEN")
        && !JSON.stringify(upgradedSource.data).includes(upgradeEnvironmentSecret),
      "legacy source secret environment was disclosed by the upgraded API"
    );
    const completedQueuedJob = await waitForJob(queuedJobId, { timeoutMs: 3 * 60_000 });
    assert(completedQueuedJob.status === "completed", "queued pre-upgrade API job did not complete after upgrade");
    assert(await jobAttemptCount(queuedJobId) === 1, "queued pre-upgrade API job did not complete exactly once");
    await retry("upgraded worker idle queue", async () => {
      const worker = await api("/api/jobs/status");
      assert(worker.data.worker.available === true, "upgraded worker heartbeat was not available");
      assert(worker.data.worker.queued === 0 && worker.data.worker.running === 0,
        `upgrade left ${worker.data.worker.queued} queued/${worker.data.worker.running} running jobs`);
    });
    const preservedJobResult = await scenarioCompose(newEnv, [
      "exec", "-T", "postgres",
      "psql", "-v", "ON_ERROR_STOP=1", "-U", "composebastion", "-d", "composebastion", "-Atc",
      `SELECT json_build_object(
        'id', id,
        'type', type,
        'status', status,
        'payload', payload,
        'result', result,
        'attemptCount', attempt_count,
        'leaseOwner', lease_owner,
        'leaseExpiresAt', lease_expires_at
      )::text FROM operation_jobs WHERE id = '${upgradeJobId}'`
    ]);
    const preservedJob = JSON.parse(preservedJobResult.stdout);
    assert(preservedJob.id === upgradeJobId, "pre-upgrade operation job was not preserved");
    assert(preservedJob.type === "host.check" && preservedJob.status === "completed", "pre-upgrade operation job changed state");
    assert(preservedJob.payload?.acceptanceMarker === upgradeMarker, "pre-upgrade operation job payload changed");
    assert(preservedJob.result?.preserved === true, "pre-upgrade operation job result changed");
    assert(preservedJob.attemptCount === 0 && preservedJob.leaseOwner === null && preservedJob.leaseExpiresAt === null,
      "worker reliability migration did not preserve legacy job defaults");
    const migrationResult = await scenarioCompose(newEnv, [
      "exec", "-T", "postgres",
      "psql", "-v", "ON_ERROR_STOP=1", "-U", "composebastion", "-d", "composebastion", "-Atc",
      `SELECT json_build_object(
        'applied', (SELECT count(*) FROM schema_migrations WHERE version IN (
          '029_worker_reliability.sql',
          '030_migration_plan_binding.sql',
          '031_universal_deployments.sql',
          '032_normalize_local_backup_targets.sql',
          '033_remote_artifact_orphans.sql',
          '034_github_deployment_jobs.sql',
          '035_recovery_restore_attempts.sql',
          '036_deployment_analysis_binding.sql',
          '037_stack_source_environment_binding.sql',
          '038_github_clone_deployment_jobs.sql'
        )),
        'workerTable', to_regclass('public.worker_instances') IS NOT NULL,
        'leaseIndex', to_regclass('public.operation_jobs_expired_lease_idx') IS NOT NULL,
        'planColumn', EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'migration_runs' AND column_name = 'plan_run_id'
        ),
        'planIndex', to_regclass('public.migration_runs_plan_run_unique_idx') IS NOT NULL,
        'deploymentSourcesTable', to_regclass('public.deployment_sources') IS NOT NULL,
        'deploymentSourceColumn', EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'compose_stacks' AND column_name = 'deployment_source_id'
        ),
        'remoteArtifactOrphansTable',
          to_regclass('public.remote_artifact_orphans') IS NOT NULL,
        'remoteArtifactEncryptedTargetSnapshot', EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'remote_artifact_orphans'
            AND column_name = 'target_snapshot_encrypted'
            AND is_nullable = 'NO'
        ),
        'githubDeploymentJobsTable',
          to_regclass('public.github_deployment_jobs') IS NOT NULL,
        'githubCloneDeploymentJobsTable',
          to_regclass('public.github_clone_deployment_jobs') IS NOT NULL,
        'githubCloneDeploymentBindingSchema', (
          SELECT count(*) = 5 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'github_clone_deployment_jobs'
            AND column_name IN (
              'source_commit_sha',
              'compose_sha256',
              'environment_encrypted',
              'environment_binding',
              'stack_id'
            )
        ) AND (
          SELECT count(*) = 3 FROM pg_constraint
          WHERE conname IN (
            'github_clone_deployment_jobs_source_commit_sha_format',
            'github_clone_deployment_jobs_compose_sha256_format',
            'github_clone_deployment_jobs_environment_binding_format'
          )
            AND conrelid = 'public.github_clone_deployment_jobs'::regclass
        ) AND
          to_regclass('public.github_clone_deployment_jobs_target_idx') IS NOT NULL
        AND
          to_regclass('public.github_clone_deployment_jobs_directory_idx') IS NOT NULL,
        'recoveryRestoreAttemptsTable',
          to_regclass('public.recovery_restore_attempts') IS NOT NULL,
        'recoveryRestoreResourcesTable',
          to_regclass('public.recovery_restore_resources') IS NOT NULL,
        'recoveryRestoreBackupOwner', EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'recovery_restore_attempts'
            AND column_name = 'backup_id'
            AND is_nullable = 'YES'
        ),
        'recoveryRestoreJobIndex',
          to_regclass('public.recovery_restore_attempts_job_idx') IS NOT NULL,
        'deploymentAnalysisBindingColumns', (
          SELECT count(*) = 3 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'deployment_analyses'
            AND column_name IN ('source_revision', 'compose_sha256', 'environment_sha256')
            AND is_nullable = 'YES'
        ),
        'deploymentAnalysisBindingConstraints', (
          SELECT count(*) = 3 FROM pg_constraint
          WHERE conname IN (
            'deployment_analyses_source_revision_format',
            'deployment_analyses_compose_sha256_format',
            'deployment_analyses_environment_sha256_format'
          )
            AND conrelid = 'public.deployment_analyses'::regclass
        ),
        'stackSourceEnvironmentBinding', (
          SELECT count(*) = 2 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'compose_stacks'
            AND column_name IN (
              'source_environment_encrypted',
              'source_environment_binding'
            )
            AND is_nullable = 'YES'
        ) AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'compose_stacks_source_environment_binding_format'
            AND conrelid = 'public.compose_stacks'::regclass
        ),
        'legacyDeploymentSource', (
          SELECT json_build_object(
            'id', id,
            'legacyId', metadata ->> 'legacyGithubRepositoryId',
            'sourceLocator', source_locator,
            'projectName', project_name,
            'environmentEncrypted', env_encrypted IS NOT NULL,
            'ciphertextContainsPlaintextSecret',
              position('${upgradeEnvironmentSecret}' in COALESCE(env_encrypted, '')) > 0
          ) FROM deployment_sources
          WHERE id = '${upgradeRepositoryId}'
        ),
        'legacyLocalTarget', (
          SELECT json_build_object(
            'config', config,
            'localCachePolicy', local_cache_policy,
            'healthStatus', health_status,
            'healthCheckedAt', health_checked_at,
            'healthError', health_error
          ) FROM backup_targets
          WHERE id = '${upgradeLocalTargetId}'
        )
      )::text`
    ]);
    const migrated = JSON.parse(migrationResult.stdout);
    assert(Number(migrated.applied) === 10, "release-candidate migrations 029-038 were not recorded");
    assert(migrated.workerTable && migrated.leaseIndex && migrated.planColumn && migrated.planIndex,
      "release-candidate worker/migration schema is incomplete after upgrade");
    assert(migrated.deploymentSourcesTable && migrated.deploymentSourceColumn,
      "universal deployment schema is incomplete after upgrade");
    assert(
      migrated.remoteArtifactOrphansTable && migrated.remoteArtifactEncryptedTargetSnapshot,
      "remote artifact orphan durability schema is incomplete after upgrade"
    );
    assert(
      migrated.githubDeploymentJobsTable,
      "GitHub deployment completion binding schema is incomplete after upgrade"
    );
    assert(
      migrated.githubCloneDeploymentJobsTable
        && migrated.githubCloneDeploymentBindingSchema,
      "GitHub clone deployment revision/environment binding schema is incomplete after upgrade"
    );
    assert(
      migrated.recoveryRestoreAttemptsTable
        && migrated.recoveryRestoreResourcesTable
        && migrated.recoveryRestoreBackupOwner
        && migrated.recoveryRestoreJobIndex,
      "durable recovery restore-attempt schema is incomplete after upgrade"
    );
    assert(
      migrated.deploymentAnalysisBindingColumns
        && migrated.deploymentAnalysisBindingConstraints,
      "deployment analysis revision/digest binding schema is incomplete after upgrade"
    );
    assert(
      migrated.stackSourceEnvironmentBinding,
      "stack source-environment binding schema is incomplete after upgrade"
    );
    assert(
      migrated.legacyDeploymentSource?.id === upgradeRepositoryId
        && migrated.legacyDeploymentSource?.legacyId === upgradeRepositoryId
        && migrated.legacyDeploymentSource?.sourceLocator === "https://github.com/composebastion/example.git"
        && migrated.legacyDeploymentSource?.projectName === `${upgradeMarker}-project`
        && migrated.legacyDeploymentSource?.environmentEncrypted === true
        && migrated.legacyDeploymentSource?.ciphertextContainsPlaintextSecret === false,
      "legacy GitHub repository was not preserved and backfilled as a deployment source"
    );
    assert(
      migrated.legacyLocalTarget?.localCachePolicy === "keep"
        && migrated.legacyLocalTarget?.config
        && Object.keys(migrated.legacyLocalTarget.config).length === 0
        && migrated.legacyLocalTarget?.healthStatus === "unknown"
        && migrated.legacyLocalTarget?.healthCheckedAt === null
        && migrated.legacyLocalTarget?.healthError === null,
      "legacy local backup target was not canonicalized without losing the row"
    );
    const finalVolumes = await projectVolumeNames();
    assert(JSON.stringify(finalVolumes) === JSON.stringify(initialVolumeNames),
      "real updater rollback/re-upgrade replaced or removed persistent Compose volumes");
    const rollbackEvidence = {
      rollbackVersion: acceptanceUpgradeBridge.version,
      rollbackPreservedConfiguration: true,
      rollbackPreservedDatabase: true,
      reupgradeVersion: candidateVersion,
      reupgradePreservedConfiguration: true,
      reupgradePreservedDatabase: true,
      volumesRetained: true,
      rollbackReupgradeHealthy: true,
      credentialRollbackVerified: true,
      credentialRestoration: true,
      rollbackDependenciesBypassed: true,
      immutableBridgeRollback: true,
      dependencyContainerIdsPreserved: true,
      forcedFailureStage: failedOutcome.stage,
      updaterOutcome: failedOutcome.status,
      successfulReupgrade: successfulOutcome.status === "passed",
      canonicalEnvironmentPersisted: true
    };
    return {
      from: baseline.version,
      to: candidateVersion,
      publicImage: publicImageEvidence,
      bridge: bridgeImageEvidence,
      bridgeVersion: acceptanceUpgradeBridge.version,
      oldUpdaterApiHop: true,
      oldUpdaterJobId,
      realApiHandoff: true,
      protectedEnvironmentFile: true,
      candidatePreparationTransitionRecorded: true,
      credentialPreparation: {
        credentialTransition: baseline.expectedCredentialTransition,
        environmentAction: baseline.expectedEnvironmentAction,
        rawEnvironmentCanonicalized: true,
        actualRotationVerified: baseline.expectedCredentialTransition === "changed",
        restorationVerified: baseline.expectedCredentialTransition === "changed",
        unchangedCredentialVerified: baseline.expectedCredentialTransition === "unchanged"
      },
      hardenedUpdaterJobs: {
        failed: {
          jobId: failedJobId,
          outcomeFile: path.basename(failedOutcomePath)
        },
        successful: {
          jobId: successfulJobId,
          outcomeFile: path.basename(successfulOutcomePath)
        }
      },
      bridgeComposeDefinitionRetained: true,
      imageBindings,
      preservedConfiguration: true,
      preservedEncryptedConfiguration: true,
      preservedDatabase: true,
      preservedCompletedJob: true,
      preservedQueuedJob: true,
      legacyEnvironmentPlaceholderHandled: true,
      legacyBackupOwnershipMigrated: true,
      pre12ComposeInitializerServicesAbsent: true,
      candidateCompatibilityEntrypointUsed: true,
      recursiveOwnershipSymlinkSafe: true,
      migrations: [
        "029_worker_reliability.sql",
        "030_migration_plan_binding.sql",
        "031_universal_deployments.sql",
        "032_normalize_local_backup_targets.sql",
        "033_remote_artifact_orphans.sql",
        "034_github_deployment_jobs.sql",
        "035_recovery_restore_attempts.sql",
        "036_deployment_analysis_binding.sql",
        "037_stack_source_environment_binding.sql",
        "038_github_clone_deployment_jobs.sql"
      ],
      workerMigrationHealthy: true,
      recoveryRestoreAttemptMigrationHealthy: true,
      deploymentAnalysisBindingMigrationHealthy: true,
      stackSourceEnvironmentBindingMigrationHealthy: true,
      githubCloneDeploymentBindingMigrationHealthy: true,
      universalDeploymentMigrationHealthy: true,
      legacyRepositoryBackfilled: true,
      legacySourceEnvironmentEncrypted: true,
      legacySourceEnvironmentApiRedacted: true,
      legacyLocalTargetCanonicalized: true,
      ...rollbackEvidence
    };
  } catch (error) {
    await captureFailureLogs();
    throw error;
  } finally {
    if (!keep) {
      try {
        if (await pathExists(publicComposeFile)) {
          await scenarioCompose(newEnv, ["down", "--volumes", "--remove-orphans", "--rmi", "local"]);
        }
      } finally {
        try {
          await setManagerBackupDirectoryOwnership(
            newEnv.COMPOSEBASTION_BACKUP_DIR,
            "cleanup"
          );
        } finally {
          if (await pathExists(managerDir)) await clearProtectedManagerDirectory();
          for (const reference of [publicRegistryReference, bridgeRegistryReference, candidateRegistryReference]) {
            await run("docker", ["image", "rm", reference]).catch(() => undefined);
          }
          await rm(forcedFailureMarker, { force: true });
          await rm(managerDir, { recursive: true, force: true });
          await rm(externalOwnershipTarget, { force: true });
          activeProject = null;
          activeEnv = null;
        }
      }
    }
  }
}

async function writeReport() {
  if (report.status === "passed" || report.status === "passed_nonqualifying") {
    report.releaseQualification.automatedAcceptanceQualifying = report.releaseQualification.manifestComplete
      && report.releaseQualification.nonqualifyingReasons.length === 0;
    report.status = report.releaseQualification.automatedAcceptanceQualifying ? "passed" : "passed_nonqualifying";
  }
  report.completedAt = new Date().toISOString();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const qualificationReasons = report.releaseQualification.nonqualifyingReasons.length > 0
    ? report.releaseQualification.nonqualifyingReasons.map((reason) => `  - ${reason}`).join("\n")
    : "  - None";
  const deferredGates = report.releaseQualification.deferredGates
    .map((gate) => `  - ${gate.id}: ${gate.status} — ${gate.detail}`)
    .join("\n");
  const rows = report.scenarios.map((item) => {
    const manifestEntry = acceptanceScenarioManifest.find((entry) => entry.id === item.id);
    const evidence = item.status === "passed"
      ? (manifestEntry?.requiredEvidence ?? []).map((evidencePath) => {
        const value = evidenceValue(item.detail, evidencePath);
        const rendered = typeof value === "object" ? JSON.stringify(value) : String(value);
        return `${evidencePath}=${rendered}`;
      }).join(", ")
      : item.error ?? (item.status === "skipped" ? item.detail : "") ?? "";
    return `| ${item.id} | ${item.name.replaceAll("|", "\\|")} | ${item.status} | ${item.durationMs} | ${redact(evidence).replaceAll("|", "\\|")} |`;
  });
  const markdown = `# ComposeBastion Acceptance Report

- Candidate: \`${candidateVersion}\`
- HEAD: \`${report.source.headSha}\`
- Commit timestamp: \`${report.source.commitTimestamp}\`
- Context: \`${report.source.contextIdentity}\`
- Docker build context: \`${report.source.buildContext?.strategy ?? "missing"}\` tree \`${report.source.buildContext?.treeSha ?? "missing"}\` (\`${report.source.buildContext?.contextDigest ?? "missing"}\`)
- Docker build context stable: **${report.source.buildContextStable ? "yes" : "no"}**
- Working tree dirty: **${report.source.dirty ? `yes (${report.source.dirtyEntryCount} entries)` : "no"}**
- Status: **${report.status}**
- Started: ${report.startedAt}
- Completed: ${report.completedAt}
- Automated acceptance qualifying: **${report.releaseQualification.automatedAcceptanceQualifying ? "yes" : "no"}**
- Required scenario manifest complete: **${report.releaseQualification.manifestComplete ? "yes" : "no"}**
- Disposable cleanup verified: **${report.cleanup.verified ? "yes" : "no"}**
- Port base: \`${portBase}\`; workload subnet: \`${configuredSubnet}\`
- Projects: ${Object.values(report.environment.projects).map((project) => `\`${project}\``).join(", ")}
- Fixture credentials: redacted and not retained in this report

## Automated qualification notes

${qualificationReasons}

## Deferred external/manual gates

${deferredGates}

## Disposable cleanup

- Runtime directory removed: **${report.cleanup.runtimeRemoved ? "yes" : "no"}**
- Bind directory removed: **${report.cleanup.bindRemoved ? "yes" : "no"}**
- Residual containers/images/networks/volumes: **${[
    report.cleanup.containers.length,
    report.cleanup.images.length,
    report.cleanup.networks.length,
    report.cleanup.volumes.length
  ].join("/")}**
- Residual files/runtime inputs/backups/storage objects: **${[
    report.cleanup.files.length,
    report.cleanup.runtimeInputFiles.length,
    report.cleanup.backupArtifacts.length,
    report.cleanup.storageObjects.length
  ].join("/")}**
- Cleanup errors: **${report.cleanup.errors.length}**

| ID | Scenario | Status | Duration (ms) | Required evidence / error |
|---|---|---:|---:|---|
${rows.join("\n")}
`;
  await mkdir(resultsDir, { recursive: true });
  await writeFile(path.join(resultsDir, "report.json"), redact(json));
  await writeFile(path.join(resultsDir, "report.md"), redact(markdown));
}

async function captureFailureLogs() {
  if (failureLogsCaptured || !activeProject || !activeEnv) return;
  try {
    const logs = await compose(activeProject, activeEnv, ["logs", "--no-color", "--tail", "300"]);
    await writeFile(failureLogPath, `${redact([logs.stdout, logs.stderr].filter(Boolean).join("\n"))}\n`);
    failureLogsCaptured = true;
  } catch {
    // The structured report remains the primary result when Docker itself fails.
  }
}

function parseDockerRows(output, fieldCount) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const fields = line.split("\t");
    while (fields.length < fieldCount) fields.push("");
    return fields;
  });
}

function ownsDockerProject(project) {
  return Object.values(report.environment.projects).includes(project)
    || project.startsWith(workloadPrefix);
}

function ownsDockerResource(project, name) {
  return acceptanceOwnsDockerResource({
    project,
    name,
    projectNames: Object.values(report.environment.projects),
    workloadPrefix
  });
}

async function collectOwnedDockerResources() {
  const [containerResult, networkResult, volumeResult, imageResult] = await Promise.all([
    run("docker", ["container", "ls", "--all", "--no-trunc", "--format",
      '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}']),
    run("docker", ["network", "ls", "--no-trunc", "--format",
      '{{.ID}}\t{{.Name}}\t{{.Label "com.docker.compose.project"}}']),
    run("docker", ["volume", "ls", "--format",
      '{{.Name}}\t{{.Label "com.docker.compose.project"}}']),
    run("docker", composeProjectImageListArguments)
  ]);
  const containers = parseDockerRows(containerResult.stdout, 3)
    .filter(([, name, project]) =>
      ownsDockerResource(project, name)
    )
    .map(([id, name, project]) => ({ id, name, project }));
  const networks = parseDockerRows(networkResult.stdout, 3)
    .filter(([, name, project]) =>
      ownsDockerResource(project, name)
    )
    .map(([id, name, project]) => ({ id, name, project }));
  const volumes = parseDockerRows(volumeResult.stdout, 2)
    .filter(([name, project]) =>
      ownsDockerResource(project, name)
    )
    .map(([name, project]) => ({ name, project }));
  const imageRows = parseDockerRows(imageResult.stdout, 2);
  const imageProjects = new Map(await Promise.all(
    [...new Set(imageRows.map(([id]) => id))].map(async (id) => {
      const inspected = JSON.parse((await run(
        "docker",
        ["image", "inspect", id, "--format", "{{json .}}"]
      )).stdout);
      return [id, requireImageComposeProject(inspected)];
    })
  ));
  const images = imageRows
    .map(([id, reference]) => ({ id, reference, project: imageProjects.get(id) ?? "" }))
    .filter(({ project }) => ownsDockerProject(project));
  return { containers, networks, volumes, images };
}

async function inspectImageOrNull(reference) {
  try {
    return JSON.parse((await run("docker", ["image", "inspect", reference, "--format", "{{json .}}"])).stdout);
  } catch {
    return null;
  }
}

async function snapshotExternalImages() {
  externalImageBaseline = new Map();
  for (const reference of externalImageReferences) {
    externalImageBaseline.set(reference, (await inspectImageOrNull(reference))?.Id ?? null);
  }
}

async function assertNoPreexistingOwnedState() {
  const resources = await collectOwnedDockerResources();
  const existingTags = [];
  for (const reference of [candidateImage, candidateAgentImage]) {
    if (await inspectImageOrNull(reference)) existingTags.push(reference);
  }
  const residualCount = Object.values(resources).reduce((total, items) => total + items.length, 0);
  if (residualCount > 0 || existingTags.length > 0) {
    throw new Error(
      `Acceptance-owned Docker state already exists for port ${portBase}; choose another ACCEPTANCE_PORT_BASE or remove the retained fixture explicitly`
    );
  }
}

async function performFinalCleanup() {
  if (keep || !ownsRuntimeFixtures) return;
  report.cleanup.attempted = true;
  const cleanupErrors = [];
  const cleanupStep = async (label, action) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(`${label}: ${redact(error instanceof Error ? error.message : error)}`);
    }
  };

  let resources = { containers: [], networks: [], volumes: [], images: [] };
  await cleanupStep("inspect owned Docker resources", async () => {
    resources = await collectOwnedDockerResources();
    report.cleanup.projectResourcesChecked = true;
    report.cleanup.workloadResourcesChecked = true;
  });
  for (const container of resources.containers) {
    await cleanupStep(`remove container ${container.id}`, () => run("docker", ["container", "rm", "--force", container.id]));
  }
  for (const network of resources.networks) {
    await cleanupStep(`remove network ${network.id}`, () => run("docker", ["network", "rm", network.id]));
  }
  for (const volume of resources.volumes) {
    await cleanupStep(`remove volume ${volume.name}`, () => run("docker", ["volume", "rm", "--force", volume.name]));
  }
  const ownedImageReferences = [...new Set(resources.images.map((image) => image.reference))]
    .filter((reference) => reference && reference !== "<none>:<none>");
  for (const reference of ownedImageReferences) {
    await cleanupStep(`remove project image ${reference}`, () => run("docker", ["image", "rm", reference]));
  }

  for (const [kind, reference] of Object.entries({ app: candidateImage, agent: candidateAgentImage })) {
    await cleanupStep(`remove candidate ${kind} tag`, async () => {
      const before = await inspectImageOrNull(reference);
      const expectedId = report.candidateImages?.[kind]?.id ?? null;
      if (expectedId && !before) throw new Error(`owned tag ${reference} disappeared before cleanup`);
      if (expectedId && before?.Id !== expectedId) {
        throw new Error(`owned tag ${reference} changed from ${expectedId} to ${before.Id}`);
      }
      if (before) await run("docker", ["image", "rm", reference]);
      if (await inspectImageOrNull(reference)) throw new Error(`owned tag ${reference} remains after removal`);
    });
  }

  for (const [kind, expected] of Object.entries(report.candidateImages
    ? { app: report.candidateImages.app, agent: report.candidateImages.agent }
    : {})) {
    await cleanupStep(`verify candidate ${kind} image removal`, async () => {
      const remaining = await inspectImageOrNull(expected.id);
      if (!remaining) return;
      const foreignTags = (remaining.RepoTags ?? []).filter((tag) => ![candidateImage, candidateAgentImage].includes(tag));
      if (foreignTags.length > 0) {
        throw new Error(`candidate image ${expected.id} is retained by ${foreignTags.length} non-acceptance tag(s)`);
      }
      await run("docker", ["image", "rm", expected.id]);
      if (await inspectImageOrNull(expected.id)) throw new Error(`candidate image ${expected.id} remains after removal`);
    });
  }
  report.cleanup.candidateImagesChecked = true;

  if (!(externalImageBaseline instanceof Map)) {
    cleanupErrors.push("restore external image cache baseline: external image baseline was not captured");
  } else {
    for (const reference of externalImageReferences) {
      await cleanupStep(`restore external image ${reference}`, async () => {
        const baselineId = externalImageBaseline.get(reference) ?? null;
        const current = await inspectImageOrNull(reference);
        if (baselineId) {
          if (!current || current.Id !== baselineId) {
            throw new Error(`pre-existing external image ${reference} changed during acceptance`);
          }
          return;
        }
        if (current) {
          await run("docker", ["image", "rm", reference]);
          if (await inspectImageOrNull(reference)) {
            throw new Error(`new external image ${reference} remains after removal`);
          }
        }
      });
    }
    report.cleanup.externalImagesChecked = true;
  }

  await cleanupStep("remove acceptance runtime directory", () => rm(runtimeDir, { recursive: true, force: true }));
  await cleanupStep("remove acceptance bind directory", () => rm(acceptanceBindDir, { recursive: true, force: true }));

  let residual = { containers: [], networks: [], volumes: [], images: [] };
  await cleanupStep("verify owned Docker resource cleanup", async () => {
    residual = await collectOwnedDockerResources();
    report.cleanup.projectResourcesChecked = true;
    report.cleanup.workloadResourcesChecked = true;
  });
  report.cleanup.containers = residual.containers.map((item) => `${item.id}:${item.project || item.name}`);
  report.cleanup.networks = residual.networks.map((item) => `${item.id}:${item.project || item.name}`);
  report.cleanup.volumes = residual.volumes.map((item) => `${item.name}:${item.project}`);
  report.cleanup.images = residual.images.map((item) => `${item.id}:${item.reference}`);

  for (const reference of [candidateImage, candidateAgentImage]) {
    if (await inspectImageOrNull(reference)) report.cleanup.candidateTags.push(reference);
  }
  for (const expected of report.candidateImages
    ? [report.candidateImages.app, report.candidateImages.agent]
    : []) {
    if (await inspectImageOrNull(expected.id)) report.cleanup.images.push(expected.id);
  }
  if (externalImageBaseline instanceof Map) {
    for (const reference of externalImageReferences) {
      if (!externalImageBaseline.get(reference) && await inspectImageOrNull(reference)) {
        report.cleanup.images.push(reference);
      }
    }
  }

  report.cleanup.runtimeRemoved = !(await pathExists(runtimeDir));
  report.cleanup.bindRemoved = !(await pathExists(acceptanceBindDir));
  report.cleanup.files = report.cleanup.bindRemoved ? [] : [acceptanceBindDir];
  const runtimeInputPaths = [
    registryAuthFile,
    path.join(runtimeDir, "id_ed25519"),
    path.join(runtimeDir, "id_ed25519.pub")
  ].filter(Boolean);
  report.cleanup.runtimeInputFiles = [];
  for (const location of runtimeInputPaths) {
    if (await pathExists(location)) report.cleanup.runtimeInputFiles.push(location);
  }
  report.cleanup.backupArtifacts = [];
  for (const scenario of [
    "fresh",
    "source",
    "hardened",
    ...acceptanceUpgradeBaselines.map((baseline) => `upgrade-${baseline.key}`)
  ]) {
    const location = scenarioBackupDir(scenario);
    if (await pathExists(location)) report.cleanup.backupArtifacts.push(location);
  }
  report.cleanup.runtimeInputsChecked = true;
  report.cleanup.errors = cleanupErrors;
  report.cleanup.verified = true;
  const failures = cleanupEvidenceFailures(report.cleanup);
  if (failures.length > 0) {
    report.cleanup.verified = false;
    for (const failure of failures) {
      if (!report.cleanup.errors.includes(failure)) report.cleanup.errors.push(failure);
    }
  }
}

async function main() {
  await Promise.all([
    portBase + 25,
    portBase + 50,
    portBase + 80,
    portBase + 90,
    portBase + 180,
    portBase + 380,
    portBase + 550,
    portBase + 580,
    portBase + 590,
    portBase + 680,
    portBase + 1000
  ].map(assertPortAvailable));
  for (const location of [runtimeDir, acceptanceBindDir, liveBrowserEvidencePath]) {
    if (await pathExists(location)) {
      throw new Error(`Acceptance fixture path ${location} already exists; use a different ACCEPTANCE_PORT_BASE or remove the retained fixture explicitly`);
    }
  }
  await snapshotExternalImages();
  await assertNoPreexistingOwnedState();
  ownsRuntimeFixtures = true;
  await mkdir(resultsDir, { recursive: true });
  await rm(failureLogPath, { force: true });
  await mkdir(acceptanceBindDir, { recursive: true });
  gitBuildContextEvidence = materializeGitBuildContext({
    repositoryRoot: root,
    revision: candidateRevision,
    destination: candidateBuildContext
  });
  if (gitBuildContextEvidence.commitSha !== candidateRevision || gitBuildContextEvidence.treeSha !== candidateTree) {
    throw new Error("Exact Git build context does not match the recorded candidate commit/tree");
  }
  report.source.buildContext = gitBuildContextEvidence;
  await prepareSshKey();
  await prepareRegistryCredentials();
  await record("candidate-images", buildCandidate);
  await record("fresh-image-install", freshCandidateScenario);
  await record("source-production-install", sourceProductionScenario);
  await record("hardened-overlays", hardenedContainersScenario);
  if (!skipUpgrade) {
    for (const baseline of acceptanceUpgradeBaselines) {
      await record(
        baseline.scenarioId,
        () => upgradeScenario(baseline)
      );
    }
  } else {
    for (const baseline of acceptanceUpgradeBaselines) {
      const manifestEntry = acceptanceScenarioManifest.find(
        (entry) => entry.id === baseline.scenarioId
      );
      report.scenarios.push({
        id: baseline.scenarioId,
        name: manifestEntry.name,
        status: "skipped",
        startedAt: new Date().toISOString(),
        durationMs: 0,
        detail: "Explicit --skip-upgrade; this report is not automated-release-qualifying"
      });
    }
  }
  validateScenarioManifest();
  report.releaseQualification.automatedAcceptanceQualifying = report.releaseQualification.manifestComplete
    && report.releaseQualification.nonqualifyingReasons.length === 0;
  report.status = report.releaseQualification.automatedAcceptanceQualifying ? "passed" : "passed_nonqualifying";
}

try {
  await main();
} catch (error) {
  markNonqualifying("One or more automated acceptance scenarios failed");
  report.status = "failed";
  await captureFailureLogs();
  process.exitCode = 1;
  console.error(`\n[acceptance] FAILED: ${redact(error instanceof Error ? error.message : error)}`);
} finally {
  finalizeSourceEvidence();
  try {
    await performFinalCleanup();
  } catch (error) {
    report.cleanup.attempted = true;
    report.cleanup.verified = false;
    report.cleanup.errors.push(`unhandled cleanup error: ${redact(error instanceof Error ? error.message : error)}`);
  }
  const cleanupFailures = cleanupEvidenceFailures(report.cleanup);
  if (!keep && ownsRuntimeFixtures && cleanupFailures.length > 0) {
    markNonqualifying("Disposable acceptance cleanup did not complete with empty verified state");
    report.status = "failed";
    process.exitCode = 1;
    console.error(`\n[acceptance] CLEANUP FAILED: ${cleanupFailures.join("; ")}`);
  } else if (keep && ownsRuntimeFixtures) {
    console.log(`[acceptance] retained runtime fixtures in ${runtimeDir}`);
  }
  await writeReport();
  const releaseQualifying = report.status === "passed"
    && report.releaseQualification.automatedAcceptanceQualifying === true
    && report.releaseQualification.manifestComplete === true;
  const allowedDeveloperDiagnostic = allowNonqualifying && report.status === "passed_nonqualifying";
  if (!releaseQualifying && !allowedDeveloperDiagnostic) {
    process.exitCode = 1;
  } else if (allowedDeveloperDiagnostic) {
    console.warn("[acceptance] developer diagnostic completed with a nonqualifying report; required CI must not use --allow-nonqualifying");
  }
  console.log(`\n[acceptance] ${report.status.toUpperCase()} — reports: ${path.join(resultsDir, "report.md")}`);
}
