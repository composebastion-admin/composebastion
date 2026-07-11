import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { acceptanceScenarioManifest } from "./scenario-manifest.mjs";

const candidateVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const root = new URL("../..", import.meta.url);

function curatedHostEnvironment(source) {
  const curated = {};
  for (const name of [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL",
    "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
    "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DOCKER_CONFIG"
  ]) {
    if (source[name] !== undefined && source[name] !== "") curated[name] = source[name];
  }
  curated.PATH ??= "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return curated;
}

const hostEnvironment = curatedHostEnvironment(process.env);

function assertPinnedImages(file, { allowInterpolated = false } = {}) {
  const contents = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  const failures = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const image = /^\s*(?:image:|FROM)\s+([^\s]+)/.exec(line)?.[1];
    if (!image || (allowInterpolated && image.includes("${"))) continue;
    if (!/@sha256:[a-f0-9]{64}$/i.test(image)) failures.push(`${file}:${index + 1}: ${image}`);
  }
  if (failures.length > 0) throw new Error(`Acceptance images must be pinned by immutable digest:\n${failures.join("\n")}`);
}

assertPinnedImages("docker-compose.acceptance.yml", { allowInterpolated: true });
assertPinnedImages("docker-compose.acceptance.source.yml");
assertPinnedImages("infra/dev/sshhost.Dockerfile");
assertPinnedImages("scripts/acceptance/run.mjs");

const runnerSource = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
for (const legacyValue of [
  "composebastion-acceptance-fresh",
  "composebastion-acceptance-source",
  "composebastion-acceptance-upgrade",
  "/tmp/composebastion-acceptance-bind",
  "172.31.250.0/24"
]) {
  if (runnerSource.includes(legacyValue)) throw new Error(`Acceptance runner still contains fixed shared state: ${legacyValue}`);
}

for (const fragment of [
  'gitCapture(["rev-parse", "--verify", "HEAD^{commit}"])',
  'gitCapture(["rev-parse", "--verify", "HEAD^{tree}"])',
  'gitCapture(["show", "-s", "--format=%cI", "HEAD"])',
  'gitCapture(["status", "--porcelain=v1", "--untracked-files=all"])',
  'labels["org.opencontainers.image.revision"] === candidateRevision',
  'labels["org.opencontainers.image.created"] === candidateBuildDate',
  'automatedAcceptanceQualifying',
  'identityStable',
  'buildContextStable',
  'materializeGitBuildContext',
  'assertSafeTestResultsPath',
  'GIT_NO_REPLACE_OBJECTS: "1"',
  'ACCEPTANCE_SOURCE_CONTEXT',
  'passed_nonqualifying',
  'validateScenarioManifest()',
  'manifestComplete',
  'COMPOSE_DISABLE_ENV_FILE: "1"',
  '"compose", "--env-file", "/dev/null"',
  '--allow-nonqualifying',
  '!releaseQualifying && !allowedDeveloperDiagnostic',
  'Developer --allow-nonqualifying opt-out requested',
  'volumeMarkerSeededAfterDeploy: true',
  'exactVolumeMarkerRestored: true',
  '[acceptance] ${item.name}',
  'productionImageCompose: true',
  'exactGitContext: !skipBuild',
  'exactGitContext: true',
  'operatorSavedPrivateRegistry: true',
  'restoredDataVerified: true',
  'preservedQueuedJob: true',
  'repoDigest',
  'real-nas',
  'real-cloud',
  'go-module-legal-review',
  'release-governance'
]) {
  if (!runnerSource.includes(fragment)) throw new Error(`Acceptance runner is missing release evidence invariant: ${fragment}`);
}
if (runnerSource.includes("...process.env")) throw new Error("Acceptance runner must not spread the ambient process environment");
const disposableYamlSource = /function disposableComposeYaml\(\) \{([\s\S]*?)\n\}\n\nasync function deployDisposableStack/.exec(runnerSource)?.[1];
if (!disposableYamlSource || disposableYamlSource.includes("proof.txt")) {
  throw new Error("Disposable workload startup must not write recovery evidence");
}
for (const fragment of [
  "docker exec \"$workload_id\" test ! -e /data/proof.txt",
  "volumeMarker: workloadVolumeMarker",
  "cat /data/proof.txt)\" = '${expectedVolumeMarker}'"
]) {
  if (!runnerSource.includes(fragment)) throw new Error(`Acceptance volume marker flow is missing ${fragment}`);
}
const expectedScenarioIds = ["candidate-images", "fresh-image-install", "source-production-install", "public-upgrade"];
if (JSON.stringify(acceptanceScenarioManifest.map((entry) => entry.id)) !== JSON.stringify(expectedScenarioIds)) {
  throw new Error("Acceptance scenario manifest IDs changed without updating the release contract");
}
for (const entry of acceptanceScenarioManifest) {
  if (!entry.name || !Array.isArray(entry.requiredEvidence) || entry.requiredEvidence.length === 0) {
    throw new Error(`Acceptance scenario ${entry.id} has no enforceable evidence contract`);
  }
}
for (const buildArgument of ["VCS_REF", "BUILD_DATE"]) {
  const occurrences = [...runnerSource.matchAll(new RegExp(`--build-arg[^\\n]+${buildArgument}=`, "g"))].length;
  if (occurrences !== 2) throw new Error(`Acceptance runner must pass ${buildArgument} to both candidate image builds; found ${occurrences}`);
}

for (const file of [".github/RELEASE_PROCESS.md", "docs/installation.md"]) {
  const contents = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  for (const placeholder of [
    "ci-test-secret-which-is-at-least-32-chars-long",
    "release-test-secret-which-is-at-least-32-chars-long",
    "ci-test-agent-token-which-is-at-least-32-chars-long"
  ]) {
    if (contents.includes(placeholder)) throw new Error(`${file} publishes fixed credential placeholder ${placeholder}`);
  }
}

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
if (packageJson.scripts?.["acceptance:assert-report"] !== "node scripts/acceptance/assert-report.mjs") {
  throw new Error("package.json is missing the acceptance report assertion command");
}
const ciSource = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
if (!ciSource.includes("run: npm run acceptance:assert-report")) {
  throw new Error("Required CI does not explicitly assert the generated acceptance report");
}
if (ciSource.includes("--allow-nonqualifying")) {
  throw new Error("Required CI must not use the developer-only nonqualifying acceptance opt-out");
}
const reportAssertionSource = readFileSync(new URL("./assert-report.mjs", import.meta.url), "utf8");
for (const fragment of [
  'report.status !== "passed"',
  'automatedAcceptanceQualifying !== true',
  'manifestComplete !== true'
]) {
  if (!reportAssertionSource.includes(fragment)) throw new Error(`Acceptance report assertion is missing ${fragment}`);
}

const secret = () => randomBytes(24).toString("hex");
const env = {
  ...hostEnvironment,
  COMPOSE_DISABLE_ENV_FILE: "1",
  COMPOSEBASTION_IMAGE: "composebastion-app",
  COMPOSEBASTION_VERSION: candidateVersion,
  COMPOSEBASTION_ACCEPTANCE_IMAGE: `composebastion-app:${candidateVersion}`,
  COMPOSEBASTION_ACCEPTANCE_AGENT_IMAGE: `composebastion-agent:${candidateVersion}`,
  APP_SECRET: secret(),
  POSTGRES_PASSWORD: secret(),
  MINIO_ROOT_USER: "acceptance",
  MINIO_ROOT_PASSWORD: secret(),
  SAMBA_USER: "acceptance",
  SAMBA_PASSWORD: secret(),
  REGISTRY_USER: "acceptance",
  REGISTRY_PASSWORD: secret(),
  ACCEPTANCE_REGISTRY_AUTH_FILE: "/tmp/composebastion-acceptance-registry.htpasswd",
  ACCEPTANCE_BIND_DIR: "/tmp/composebastion-acceptance-config-bind",
  ACCEPTANCE_MAILPIT_PORT: "18025",
  ACCEPTANCE_MINIO_PORT: "19000",
  ACCEPTANCE_REGISTRY_PORT: "18050",
  ACCEPTANCE_AGENT_PORT: "18090",
  ACCEPTANCE_SOURCE_CONTEXT: "/tmp/composebastion-acceptance-git-context",
  COMPOSEBASTION_HTTP_BIND_ADDRESS: "127.0.0.1",
  COMPOSEBASTION_HTTP_PORT: "18080",
  ACCEPTANCE_SOURCE_HTTP_PORT: "18180",
  COMPOSEBASTION_BACKUP_DIR: "/tmp/composebastion-acceptance-config-backups",
  SECURE_COOKIES: "false",
  CORS_ORIGINS: "http://127.0.0.1:18080",
  REDIS_URL: "redis://redis:6379",
  TRUST_PROXY: "false",
  SMTP_HOST: "mailpit",
  SMTP_PORT: "1025",
  SMTP_USER: "",
  SMTP_PASS: "",
  SMTP_FROM: "acceptance@composebastion.invalid",
  ALLOW_PRIVATE_AGENT_URLS: "true",
  ALLOW_PRIVATE_WEBHOOK_URLS: "true",
  BLOCK_PRIVATE_S3_ENDPOINTS: "false",
  BACKUP_ENCRYPTION_KEYS: "",
  BACKUP_ENCRYPTION_ACTIVE_KEY_ID: "app_secret",
  BACKUP_HOST_PATH_ALLOWED_ROOTS: "/tmp/composebastion-acceptance-config-bind",
  IMAGE_SCANNER_PROVIDER: "auto",
  HOST_CHECK_INTERVAL_MS: "10000",
  INVENTORY_SYNC_INTERVAL_MS: "60000",
  AGENT_TOKEN: secret(),
  COMPOSEBASTION_SSH_AUTHORIZED_KEYS: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcceptanceConfigOnly composebastion"
};

function assertAllComposeControlsSet(files) {
  const missing = new Set();
  for (const file of files) {
    const contents = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    for (const match of contents.matchAll(/\$\{([A-Z0-9_]+)/g)) {
      if (!Object.hasOwn(env, match[1])) missing.add(match[1]);
    }
  }
  if (missing.size > 0) throw new Error(`Acceptance environment does not explicitly set Compose controls: ${[...missing].sort().join(", ")}`);
}

function validateRenderedCompose(label, files) {
  assertAllComposeControlsSet(files);
  const args = ["compose", "--env-file", "/dev/null", ...files.flatMap((file) => ["--file", file]), "config", "--format", "json"];
  const result = spawnSync("docker", args, {
    cwd: root,
    env,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  const rendered = JSON.parse(result.stdout);
  const failures = [];
  for (const [name, service] of Object.entries(rendered.services ?? {})) {
    if (service.build) continue;
    const image = String(service.image ?? "");
    const localCandidate = service.pull_policy === "never"
      && [env.COMPOSEBASTION_ACCEPTANCE_IMAGE, env.COMPOSEBASTION_ACCEPTANCE_AGENT_IMAGE].includes(image);
    if (!localCandidate && !/@sha256:[a-f0-9]{64}$/i.test(image)) failures.push(`${name}: ${image || "missing image"}`);
  }
  if (failures.length > 0) throw new Error(`${label} rendered unpinned third-party images:\n${failures.join("\n")}`);
  console.log(`${label} Compose configuration is valid and reproducibly pinned.`);
  return rendered;
}

function assertLoopbackPort(rendered, serviceName, published) {
  const ports = rendered.services?.[serviceName]?.ports ?? [];
  const match = ports.some((port) => String(port.published) === String(published)
    && Number(port.target) === 8080
    && port.host_ip === "127.0.0.1");
  if (!match) throw new Error(`${serviceName} does not publish the expected loopback port ${published}`);
}

const acceptance = validateRenderedCompose("Acceptance fixture", ["docker-compose.image.yml", "docker-compose.acceptance.yml"]);
for (const [service, port] of [["app", 18080], ["mailpit", 18025], ["minio", 19000], ["registry", 18050], ["agent", 18090]]) {
  const ports = acceptance.services?.[service]?.ports ?? [];
  if (!ports.some((item) => String(item.published) === String(port) && item.host_ip === "127.0.0.1")) {
    throw new Error(`${service} does not publish expected loopback port ${port}`);
  }
}
if (acceptance.services?.app?.environment?.BACKUP_HOST_PATH_ALLOWED_ROOTS !== env.ACCEPTANCE_BIND_DIR) {
  throw new Error("Acceptance bind allowlist was not routed to the app");
}
for (const serviceName of ["app", "worker"]) {
  const service = acceptance.services?.[serviceName];
  const backupMount = (service?.volumes ?? []).find((volume) => volume.target === "/data/backups");
  if (backupMount?.source !== env.COMPOSEBASTION_BACKUP_DIR || backupMount?.type !== "bind") {
    throw new Error(`${serviceName} does not retain the production image Compose backup bind mount`);
  }
  if (service?.depends_on?.redis?.condition !== "service_started" || service?.depends_on?.redis?.required !== false) {
    throw new Error(`${serviceName} does not retain optional production Redis startup semantics`);
  }
}
const sshBind = (acceptance.services?.sshhost?.volumes ?? []).find((volume) => volume.target === env.ACCEPTANCE_BIND_DIR);
if (sshBind?.source !== env.ACCEPTANCE_BIND_DIR) throw new Error("Acceptance bind fixture was not mounted at its isolated path");
const source = validateRenderedCompose("Source-production acceptance", [
  "docker-compose.yml",
  "docker-compose.prod.example.yml",
  "docker-compose.acceptance.source.yml"
]);
assertLoopbackPort(source, "app", 18180);
for (const serviceName of ["app", "worker"]) {
  if (source.services?.[serviceName]?.build?.context !== env.ACCEPTANCE_SOURCE_CONTEXT) {
    throw new Error(`${serviceName} source build does not use the exact Git context override`);
  }
}
