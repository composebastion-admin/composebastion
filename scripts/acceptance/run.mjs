import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acceptanceScenarioManifest } from "./scenario-manifest.mjs";
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
const candidateImage = `composebastion-app:${candidateVersion}`;
const candidateAgentImage = `composebastion-agent:${candidateVersion}`;
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
const publicImage = "ghcr.io/composebastion-admin/composebastion-app:1.0.6";
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

const nonqualifyingReasons = [];
if (worktreeDirty) nonqualifyingReasons.push("The working tree was dirty, so the built context is not identical to the recorded commit");
if (skipBuild) nonqualifyingReasons.push("Candidate image builds were skipped and existing local images were reused");
if (skipUpgrade) nonqualifyingReasons.push("The public 1.0.6 upgrade scenario was explicitly skipped");
if (allowNonqualifying) nonqualifyingReasons.push("Developer --allow-nonqualifying opt-out requested; this report cannot qualify a release");

const portBase = Number(process.env.ACCEPTANCE_PORT_BASE ?? 18000);
if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 64535) throw new Error("ACCEPTANCE_PORT_BASE must be an integer between 1024 and 64535");
const runtimeDir = path.join(resultsDir, `runtime-${portBase}`);
const candidateBuildContext = path.join(runtimeDir, "git-build-context");
const acceptanceBindDir = `/tmp/composebastion-acceptance-${portBase}-bind`;
const scenarioBackupDir = (scenario) => path.join(runtimeDir, `${scenario}-backups`);
const workloadPrefix = `cbacceptance${portBase}`;
const workloadProject = `${workloadPrefix}app`;
const workloadVolumeMarker = `volume-${randomUUID()}`;
const workloadBindMarker = `bind-${randomUUID()}`;
const projectName = (scenario) => `composebastion-acceptance-${portBase}-${scenario}`;
const failureLogPath = path.join(resultsDir, "failure.log");
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
      upgrade: projectName("upgrade")
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

function compose(project, env, args, options = {}) {
  assertExplicitComposeControls(env, requiredImageComposeControls, "production image acceptance Compose");
  return composeWithFiles(project, env, [productionImageComposeFile, composeFile], args, options);
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
  await run("npm", ["run", "smoke:web:live"], {
    inherit: true,
    env: {
      ...hostEnvironment,
      COMPOSEBASTION_LIVE_BASE_URL: activeBaseUrl(),
      COMPOSEBASTION_LIVE_USERNAME: "acceptance-owner",
      COMPOSEBASTION_LIVE_PASSWORD: fixture.ownerPassword,
      COMPOSEBASTION_LIVE_VERSION: candidateVersion,
      COMPOSEBASTION_LIVE_OUTPUT_DIR: path.join(runtimeDir, "playwright-live")
    }
  });
  return { realBrowser: true, database: true, redis: true, worker: true };
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

async function inspectPublicUpgradeImage() {
  const inspected = await run("docker", ["image", "inspect", publicImage, "--format", "{{json .}}"]);
  const details = JSON.parse(inspected.stdout);
  const repoDigest = (details.RepoDigests ?? []).find((value) =>
    /^ghcr\.io\/composebastion-admin\/composebastion-app@sha256:[a-f0-9]{64}$/i.test(value)
  );
  assert(repoDigest, "public 1.0.6 image did not expose an immutable GHCR digest");
  const version = details.Config?.Labels?.["org.opencontainers.image.version"] ?? null;
  assert(version === "1.0.6", `public upgrade image label is ${version ?? "missing"}`);
  return {
    reference: publicImage,
    id: details.Id,
    repoDigest,
    architecture: details.Architecture,
    version
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

async function cleanupManagedDockerState() {
  if (!activeProject || !activeEnv) return;
  const cleanup = `
for id in $(docker ps -aq --filter name=${workloadPrefix}); do docker rm -f "$id" >/dev/null 2>&1 || true; done
for volume in $(docker volume ls -q | awk '/^${workloadPrefix}/ { print }'); do docker volume rm -f "$volume" >/dev/null 2>&1 || true; done
for network in $(docker network ls --format '{{.Name}}' | awk '/^${workloadPrefix}/ { print }'); do docker network rm "$network" >/dev/null 2>&1 || true; done
find '${acceptanceBindDir}' -mindepth 1 -maxdepth 1 -exec rm -rf {} +
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
    workerNeedsStart = false;

    const completed = await waitForJob(jobId, { timeoutMs: 3 * 60_000 });
    assert(completed.status === "completed", `safe recovered job is ${completed.status}`);
    assert(await jobAttemptCount(jobId) === 2, "safe job did not complete on its second leased attempt");
    await retry("worker readiness after lease recovery", async () => {
      const response = await fetch(`${activeBaseUrl()}/api/health/ready`);
      const body = await response.json();
      assert(response.status === 200 && body.checks?.worker?.ok === true, "worker was not ready after lease recovery");
    });
    return { jobId, recoveredAttempt: 2, fencedWorkerLoss: true };
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
      - ${acceptanceBindDir}:/allowed
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
  const response = await api(`/api/hosts/${host.id}/compose`, {
    method: "POST",
    body: {
      name: "Acceptance disposable app",
      projectName: workloadProject,
      composeYaml: disposableComposeYaml(),
      env: `WORKLOAD_DATABASE_PASSWORD=${fixture.workloadPassword}\n`
    }
  });
  const stack = response.data.stack;
  const deployed = await api(`/api/compose/${stack.id}/deploy`, { method: "POST", body: {} });
  await waitForJob(deployed.data.job.id, { timeoutMs: 10 * 60_000 });
  const verifyStartup = `
set -eu
workload_id="$(docker ps -q --filter 'label=com.docker.compose.project=${workloadProject}' --filter 'label=com.docker.compose.service=workload')"
database_id="$(docker ps -q --filter 'label=com.docker.compose.project=${workloadProject}' --filter 'label=com.docker.compose.service=database')"
test -n "$workload_id" && test -n "$database_id"
test ! -e '${acceptanceBindDir}/proof.txt'
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
test -n "$bind_source"
mkdir -p "$bind_source"
docker exec "$workload_id" sh -c "printf '%s' '${workloadVolumeMarker}' > /data/proof.txt"
printf '%s' '${workloadBindMarker}' > "$bind_source/proof.txt"
docker exec "$database_id" psql -U postgres -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS acceptance_proof (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO acceptance_proof (id, value) VALUES (1, 'database-ok') ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;" >/dev/null
printf 'ACCEPTANCE_BIND_SOURCE=%s\n' "$bind_source"
`;
  const seeded = await compose(activeProject, activeEnv, ["exec", "-T", "sshhost", "sh", "-lc", seedRuntime]);
  const bindSourcePath = seeded.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("ACCEPTANCE_BIND_SOURCE="))
    ?.slice("ACCEPTANCE_BIND_SOURCE=".length);
  assert(/^\/[A-Za-z0-9._/-]+$/.test(bindSourcePath ?? ""), `Docker reported an unsafe acceptance bind source: ${JSON.stringify(bindSourcePath)}`);

  const verifyRuntime = `
set -eu
workload_id="$(docker ps -q --filter 'label=com.docker.compose.project=${workloadProject}' --filter 'label=com.docker.compose.service=workload')"
database_id="$(docker ps -q --filter 'label=com.docker.compose.project=${workloadProject}' --filter 'label=com.docker.compose.service=database')"
test "$(docker exec "$workload_id" cat /data/proof.txt)" = '${workloadVolumeMarker}'
test "$(cat '${bindSourcePath}/proof.txt')" = '${workloadBindMarker}'
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
      bindSourcePath
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
  assert(/^volume-[0-9a-f-]{36}$/.test(expectedVolumeMarker ?? ""), "workload volume marker is missing or invalid");
  assert(/^bind-[0-9a-f-]{36}$/.test(expectedBindMarker ?? ""), "workload bind marker is missing or invalid");
  assert(/^\/[A-Za-z0-9._/-]+$/.test(expectedBindSourcePath ?? ""), "workload bind source path is missing or invalid");
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
  assert(Number(restoreJob.result.restoredBindMounts) >= 1, "clone restore did not restore the allowed bind mount");

  const sourceWorkloadVolume = `${workloadProject}_workload-data`;
  const sourceDatabaseVolume = `${workloadProject}_database-data`;
  const restoredWorkloadVolume = restoreJob.result.volumeMap?.[sourceWorkloadVolume];
  const restoredDatabaseVolume = restoreJob.result.volumeMap?.[sourceDatabaseVolume];
  const restoredBindPath = restoreJob.result.bindMap?.[expectedBindSourcePath];
  const sourceNetwork = `${workloadProject}_acceptance-net`;
  const restoredNetwork = restoreJob.result.networkMap?.[sourceNetwork]
    ?? restoreJob.result.networkMap?.["acceptance-net"];
  assert(restoredWorkloadVolume && restoredWorkloadVolume !== sourceWorkloadVolume, "workload volume was not remapped for clone restore");
  assert(restoredDatabaseVolume && restoredDatabaseVolume !== sourceDatabaseVolume, "database volume was not remapped for clone restore");
  assert(restoredBindPath?.startsWith(`/var/lib/composebastion/restores/${pointId}/`), "bind mount was not restored into managed clone storage");
  assert(restoredNetwork && restoredNetwork !== sourceNetwork, "custom network was not remapped for clone restore");

  // The SSH fixture is a container controlling its sibling Docker daemon via
  // the socket. A real SSH host shares one filesystem with its daemon, while
  // this fixture has a container overlay. Prove recovery wrote the bind data,
  // then bridge that directory into the daemon-host bind path for runtime QA.
  const bridgeFixtureBind = `
set -eu
test "$(cat '${restoredBindPath}/proof.txt')" = '${expectedBindMarker}'
tar -C '${restoredBindPath}' -cf - . | docker run --rm -i -v '${restoredBindPath}:/target' alpine:3.20.8@sha256:765942a4039992336de8dd5db680586e1a206607dd06170ff0a37267a9e01958 sh -c 'cd /target && tar -xf -'
`;
  await compose(activeProject, activeEnv, ["exec", "-T", "sshhost", "sh", "-lc", bridgeFixtureBind]);

  const verifyCloneRuntime = `
set -eu
workload_id="$(docker ps -q --filter 'label=com.docker.compose.project=${restoredProject}' --filter 'label=com.docker.compose.service=workload')"
database_id="$(docker ps -q --filter 'label=com.docker.compose.project=${restoredProject}' --filter 'label=com.docker.compose.service=database')"
test -n "$workload_id" && test -n "$database_id"
test "$(docker exec "$workload_id" cat /data/proof.txt)" = '${expectedVolumeMarker}'
test "$(docker exec "$workload_id" cat /allowed/proof.txt)" = '${expectedBindMarker}'
test "$(docker exec "$database_id" psql -U postgres -Atc 'SELECT value FROM acceptance_proof WHERE id = 1')" = database-ok
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$workload_id")" = '${restoredWorkloadVolume}'
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$database_id")" = '${restoredDatabaseVolume}'
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/allowed"}}{{.Source}}{{end}}{{end}}' "$workload_id")" = '${restoredBindPath}'
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
    `docker compose --env-file /dev/null -p '${restoredProject}' -f '/tmp/composebastion/${pointId}/compose.yml' down -v --remove-orphans`
  ]);
  const cleanupRestoredBind = `
set -eu
docker run --rm -v '${restoredBindPath}:/target' alpine:3.20.8@sha256:765942a4039992336de8dd5db680586e1a206607dd06170ff0a37267a9e01958 sh -c 'find /target -mindepth 1 -delete'
rm -rf '${restoredBindPath}'
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
  activeProject = project;
  activeEnv = env;
  sessionCookie = "";
  operatorSessionCookie = "";
  let stack;
  let targets;
  await compose(project, env, ["down", "--volumes", "--remove-orphans"], {}).catch(() => undefined);
  try {
    await compose(project, env, ["up", "--detach", "--build", "postgres", "redis", "mailpit", "minio", "samba", "registry", "agent", "sshhost"], { inherit: true });
    await cleanupManagedDockerState();
    await createMinioBucket();
    await seedRegistry();
    await compose(project, env, ["up", "--detach", "app"], { inherit: true });
    const health = await waitForApiVersion(candidateVersion);
    await compose(project, env, ["up", "--detach", "worker"], { inherit: true });
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
    return {
      runtimeVersion: health.version,
      productionImageCompose: true,
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
      recovery
    };
  } catch (error) {
    await captureFailureLogs();
    throw error;
  } finally {
    if (!keep) {
      await cleanupManagedDockerState().catch(() => undefined);
      await compose(project, env, ["down", "--volumes", "--remove-orphans"], {}).catch(() => undefined);
      activeProject = null;
      activeEnv = null;
    }
  }
}

async function sourceProductionScenario() {
  const project = projectName("source");
  const backupDir = path.join(runtimeDir, "source-backups");
  const sourcePort = portBase + 180;
  const sourceUrl = `http://127.0.0.1:${sourcePort}`;
  await mkdir(backupDir, { recursive: true });
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
    ACCEPTANCE_SOURCE_CONTEXT: candidateBuildContext
  };
  assertExplicitComposeControls(env, requiredSourceComposeControls, "source production acceptance Compose");
  const args = [
    "compose", "--env-file", "/dev/null", "--project-name", project,
    "--file", path.join(root, "docker-compose.yml"),
    "--file", path.join(root, "docker-compose.prod.example.yml"),
    "--file", sourceAcceptanceComposeFile
  ];
  await run("docker", [...args, "down", "--volumes", "--remove-orphans"], { env }).catch(() => undefined);
  try {
    await run("docker", [...args, "up", "--detach", "--build"], { env, inherit: true });
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
      body: { username: "source-owner", password: fixture.ownerPassword, includeDemoData: false }
    });
    assert(setup.setCookie.startsWith("cb_session="), "source setup did not establish a session");
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
    await run("docker", [...args, "exec", "-T", "worker", "node", "-e", writeProof], { env });
    const appProof = await run("docker", [...args, "exec", "-T", "app", "node", "-e",
      `process.stdout.write(require('node:fs').readFileSync('/data/backups/${proofName}','utf8'))`], { env });
    assert(appProof.stdout === proofValue, "source app and worker did not share backup storage");
    assert((await readFile(path.join(backupDir, proofName), "utf8")) === proofValue, "source backup bind did not persist to the host");
    await rm(path.join(backupDir, proofName), { force: true });
    return {
      runtimeVersion: health.version,
      productionSourceCompose: true,
      exactGitContext: true,
      treeSha: gitBuildContextEvidence.treeSha,
      firstRunSetup: true,
      loginSession: true,
      configurationWrite: true,
      backupWrite: true,
      loopbackPort: sourcePort,
      pinnedFixtures: true
    };
  } catch (error) {
    try {
      const logs = await run("docker", [...args, "logs", "--no-color", "--tail", "300"], { env });
      await writeFile(failureLogPath, `${redact([logs.stdout, logs.stderr].filter(Boolean).join("\n"))}\n`);
      failureLogsCaptured = true;
    } catch {
      // Preserve the scenario error when Docker cannot return logs.
    }
    throw error;
  } finally {
    if (!keep) await run("docker", [...args, "down", "--volumes", "--remove-orphans"], { env }).catch(() => undefined);
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

  async function prepareBackupOwnership(mode) {
    await run("docker", [
      "run", "--rm", "--user", "0:0",
      "--volume", `${backupDir}:/data/backups`,
      candidateImage,
      "sh", "-ceu",
      mode === "hardened"
        ? "chown -R 1000:1000 /data/backups; chmod -R u+rwX,g+rwX,o-rwx /data/backups"
        : "chmod -R a+rwX /data/backups"
    ]);
  }

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
  await prepareBackupOwnership("hardened");
  activeProject = project;
  activeEnv = env;
  await hardenedCompose(["--profile", "hardening", "down", "--volumes", "--remove-orphans"]).catch(() => undefined);
  try {
    await hardenedCompose([
      "--profile", "hardening", "up", "--detach",
      "postgres", "redis", "registry", "app", "worker", "composebastion-agent"
    ], { inherit: true });
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
      await hardenedCompose(["--profile", "hardening", "down", "--volumes", "--remove-orphans"]).catch(() => undefined);
      await prepareBackupOwnership("cleanup").catch(() => undefined);
      activeProject = null;
      activeEnv = null;
    }
  }
}

async function upgradeScenario() {
  const project = projectName("upgrade");
  const upgradeOverrides = { ACCEPTANCE_SCENARIO: "upgrade", ACCEPTANCE_HTTP_PORT: String(portBase + 380) };
  const oldEnv = acceptanceEnv(publicImage, upgradeOverrides);
  const newEnv = acceptanceEnv(candidateImage, upgradeOverrides);
  await mkdir(oldEnv.COMPOSEBASTION_BACKUP_DIR, { recursive: true });
  activeProject = project;
  activeEnv = oldEnv;
  sessionCookie = "";
  const upgradeJobId = randomUUID();
  await compose(project, oldEnv, ["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
  try {
    await run("docker", ["pull", publicImage], { inherit: true });
    const publicImageEvidence = await inspectPublicUpgradeImage();
    await compose(project, oldEnv, ["up", "--detach", "postgres", "redis", "registry", "app", "worker"], { inherit: true });
    await waitForApiVersion("1.0.6");
    await seedRegistry();
    await setupOwner();
    await api("/api/alerts/channels", {
      method: "POST",
      body: { name: fixture.publicMarker, type: "email", emailTo: "upgrade@composebastion.invalid", enabled: true }
    });
    const savedRegistry = await api("/api/registries", {
      method: "POST",
      body: {
        name: `${fixture.publicMarker}-registry`,
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
        tags: ["demo", "acceptance", "upgrade"]
      }
    });
    const demoHost = demoHostResponse.data.host;
    await waitForJob(demoHostResponse.data.job.id, { timeoutMs: 2 * 60_000 });
    await compose(project, oldEnv, ["stop", "worker"]);
    const queued = await api(`/api/hosts/${demoHost.id}/actions`, {
      method: "POST",
      body: { type: "host.check", payload: {} }
    });
    const queuedJobId = queued.data.job.id;
    const queuedBeforeUpgrade = await api(`/api/jobs/${queuedJobId}`);
    assert(queuedBeforeUpgrade.data.job.status === "queued", "pre-upgrade API job was not queued while the worker was stopped");
    assert(/^[a-z0-9-]+$/i.test(fixture.publicMarker), "upgrade marker is not SQL-fixture safe");
    await compose(project, oldEnv, [
      "exec", "-T", "postgres",
      "psql", "-v", "ON_ERROR_STOP=1", "-U", "composebastion", "-d", "composebastion", "-c",
      `INSERT INTO operation_jobs (id, type, status, payload, result, created_at, updated_at, started_at, completed_at)
       VALUES ('${upgradeJobId}', 'host.check', 'completed',
         jsonb_build_object('acceptanceMarker', '${fixture.publicMarker}'),
         jsonb_build_object('preserved', true),
         now() - interval '1 minute', now(), now() - interval '30 seconds', now())`
    ]);
    await compose(project, oldEnv, ["stop", "app"]);
    activeEnv = newEnv;
    await compose(project, newEnv, ["up", "--detach", "app"], { inherit: true });
    await waitForApiVersion(candidateVersion);
    const queuedAfterMigration = await api(`/api/jobs/${queuedJobId}`);
    assert(queuedAfterMigration.data.job.status === "queued", "queued API job did not survive candidate migrations");
    assert(await jobAttemptCount(queuedJobId) === 0, "queued API job gained an attempt before the candidate worker started");
    await compose(project, newEnv, ["up", "--detach", "worker"], { inherit: true });
    await waitForReadiness("upgraded candidate readiness");
    sessionCookie = "";
    await loginOwner();
    const channels = await api("/api/alerts/channels");
    assert(channels.data.channels.some((channel) => channel.name === fixture.publicMarker), "configuration did not survive the image upgrade");
    const registries = await api("/api/registries");
    assert(registries.data.registries.some((registry) => registry.id === savedRegistry.data.registry.id), "encrypted registry configuration did not survive the upgrade");
    const encryptedRegistryTags = await api(`/api/image-tags?image=${encodeURIComponent("registry:5000/acceptance/test")}`);
    assert(encryptedRegistryTags.data.tags.includes("1.0.0"), "upgraded manager could not use preserved registry credentials");
    const state = await api("/api/auth/setup-state");
    assert(state.data.needsSetup === false, "database state did not survive the image upgrade");
    const completedQueuedJob = await waitForJob(queuedJobId, { timeoutMs: 3 * 60_000 });
    assert(completedQueuedJob.status === "completed", "queued pre-upgrade API job did not complete after upgrade");
    assert(await jobAttemptCount(queuedJobId) === 1, "queued pre-upgrade API job did not complete exactly once");
    await retry("upgraded worker idle queue", async () => {
      const worker = await api("/api/jobs/status");
      assert(worker.data.worker.available === true, "upgraded worker heartbeat was not available");
      assert(worker.data.worker.queued === 0 && worker.data.worker.running === 0,
        `upgrade left ${worker.data.worker.queued} queued/${worker.data.worker.running} running jobs`);
    });
    const preservedJobResult = await compose(project, newEnv, [
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
    assert(preservedJob.payload?.acceptanceMarker === fixture.publicMarker, "pre-upgrade operation job payload changed");
    assert(preservedJob.result?.preserved === true, "pre-upgrade operation job result changed");
    assert(preservedJob.attemptCount === 0 && preservedJob.leaseOwner === null && preservedJob.leaseExpiresAt === null,
      "worker reliability migration did not preserve legacy job defaults");
    const migrationResult = await compose(project, newEnv, [
      "exec", "-T", "postgres",
      "psql", "-v", "ON_ERROR_STOP=1", "-U", "composebastion", "-d", "composebastion", "-Atc",
      `SELECT json_build_object(
        'applied', (SELECT count(*) FROM schema_migrations WHERE version IN ('029_worker_reliability.sql', '030_migration_plan_binding.sql')),
        'workerTable', to_regclass('public.worker_instances') IS NOT NULL,
        'leaseIndex', to_regclass('public.operation_jobs_expired_lease_idx') IS NOT NULL,
        'planColumn', EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'migration_runs' AND column_name = 'plan_run_id'
        ),
        'planIndex', to_regclass('public.migration_runs_plan_run_unique_idx') IS NOT NULL
      )::text`
    ]);
    const migrated = JSON.parse(migrationResult.stdout);
    assert(Number(migrated.applied) === 2, "release-candidate migrations 029/030 were not recorded");
    assert(migrated.workerTable && migrated.leaseIndex && migrated.planColumn && migrated.planIndex,
      "release-candidate worker/migration schema is incomplete after upgrade");
    return {
      from: "1.0.6",
      to: candidateVersion,
      publicImage: publicImageEvidence,
      preservedConfiguration: true,
      preservedEncryptedConfiguration: true,
      preservedDatabase: true,
      preservedCompletedJob: true,
      preservedQueuedJob: true,
      migrations: ["029_worker_reliability.sql", "030_migration_plan_binding.sql"],
      workerMigrationHealthy: true
    };
  } catch (error) {
    await captureFailureLogs();
    throw error;
  } finally {
    if (!keep) {
      await compose(project, newEnv, ["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
      activeProject = null;
      activeEnv = null;
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
- Port base: \`${portBase}\`; workload subnet: \`${configuredSubnet}\`
- Projects: \`${projectName("fresh")}\`, \`${projectName("source")}\`, \`${projectName("hardened")}\`, \`${projectName("upgrade")}\`
- Fixture credentials: redacted and not retained in this report

## Automated qualification notes

${qualificationReasons}

## Deferred external/manual gates

${deferredGates}

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
    portBase + 1000
  ].map(assertPortAvailable));
  for (const location of [runtimeDir, acceptanceBindDir]) {
    if (await pathExists(location)) {
      throw new Error(`Acceptance fixture path ${location} already exists; use a different ACCEPTANCE_PORT_BASE or remove the retained fixture explicitly`);
    }
  }
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
    await record("public-upgrade", upgradeScenario);
  } else {
    const manifestEntry = acceptanceScenarioManifest.find((entry) => entry.id === "public-upgrade");
    report.scenarios.push({
      id: "public-upgrade",
      name: manifestEntry.name,
      status: "skipped",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      detail: "Explicit --skip-upgrade; this report is not automated-release-qualifying"
    });
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
  if (!keep && ownsRuntimeFixtures) {
    await rm(runtimeDir, { recursive: true, force: true });
    await rm(acceptanceBindDir, { recursive: true, force: true });
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
