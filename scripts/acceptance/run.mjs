import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const resultsDir = path.join(root, "test-results", "acceptance");
const runtimeDir = path.join(resultsDir, "runtime");
const composeFile = path.join(root, "docker-compose.acceptance.yml");
const candidateVersion = "1.0.7-rc.1";
const candidateImage = `composebastion-app:${candidateVersion}`;
const publicImage = "ghcr.io/composebastion-admin/composebastion-app:1.0.6";
const keep = process.argv.includes("--keep");
const skipBuild = process.argv.includes("--skip-build");
const skipUpgrade = process.argv.includes("--skip-upgrade");
const report = {
  candidateVersion,
  startedAt: new Date().toISOString(),
  completedAt: null,
  status: "running",
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
  ownerPassword: `Cb!${randomBytes(18).toString("base64url")}9a`,
  workloadPassword: token(18),
  publicMarker: `upgrade-${token(6)}`
};

let sshPrivateKey = "";
let sshPublicKey = "";
let activeProject = null;
let activeEnv = null;
let sessionCookie = "";

function redact(value) {
  let text = String(value ?? "");
  for (const secret of Object.values(fixture)) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  if (sshPrivateKey) text = text.split(sshPrivateKey).join("[REDACTED-SSH-KEY]");
  return text;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
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
  return run("docker", ["compose", "--project-name", project, "--file", composeFile, ...args], {
    ...options,
    env
  });
}

async function record(name, action) {
  const item = { name, status: "running", startedAt: new Date().toISOString(), durationMs: 0 };
  report.scenarios.push(item);
  const started = Date.now();
  process.stdout.write(`\n[acceptance] ${name}\n`);
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function acceptanceEnv(image = candidateImage, overrides = {}) {
  return {
    ...process.env,
    COMPOSEBASTION_ACCEPTANCE_IMAGE: image,
    APP_SECRET: fixture.appSecret,
    POSTGRES_PASSWORD: fixture.postgresPassword,
    MINIO_ROOT_USER: fixture.minioUser,
    MINIO_ROOT_PASSWORD: fixture.minioPassword,
    SAMBA_USER: fixture.sambaUser,
    SAMBA_PASSWORD: fixture.sambaPassword,
    COMPOSEBASTION_SSH_AUTHORIZED_KEYS: sshPublicKey,
    ACCEPTANCE_HTTP_PORT: "18080",
    ACCEPTANCE_MAILPIT_PORT: "18025",
    ACCEPTANCE_MINIO_PORT: "19000",
    ...overrides
  };
}

async function api(pathname, { method = "GET", body, cookie = sessionCookie, baseUrl = "http://127.0.0.1:18080" } = {}) {
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
  return { data, setCookie: setCookie?.split(";", 1)[0] ?? "" };
}

async function waitForApiVersion(expected) {
  return retry(`API ${expected}`, async () => {
    const response = await fetch("http://127.0.0.1:18080/api/health");
    if (!response.ok) throw new Error(`health returned ${response.status}`);
    const body = await response.json();
    assert(body.version === expected, `expected runtime ${expected}, received ${body.version}`);
    return body;
  }, { attempts: 120, delayMs: 1_000 });
}

async function setupOwner() {
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
      includeDemoData: false
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

async function buildCandidate() {
  if (skipBuild) return "reused local image";
  await run("docker", [
    "build", "--target", "runtime",
    "--build-arg", `APP_VERSION=${candidateVersion}`,
    "--build-arg", "TRIVY_VERSION=0.72.0",
    "--tag", candidateImage, "."
  ], { inherit: true });
  return candidateImage;
}

async function createMinioBucket() {
  await retry("MinIO", async () => {
    const response = await fetch("http://127.0.0.1:19000/minio/health/live");
    if (!response.ok) throw new Error(`MinIO returned ${response.status}`);
  }, { attempts: 90, delayMs: 1_000 });
  const { CreateBucketCommand, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: "http://127.0.0.1:19000",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: fixture.minioUser, secretAccessKey: fixture.minioPassword }
  });
  await client.send(new CreateBucketCommand({ Bucket: "composebastion-acceptance" }));
  client.destroy();
}

async function cleanupManagedDockerState() {
  if (!activeProject || !activeEnv) return;
  const cleanup = `
for id in $(docker ps -aq --filter name=cbacceptance); do docker rm -f "$id" >/dev/null 2>&1 || true; done
for volume in $(docker volume ls -q | awk '/^cbacceptance/ { print }'); do docker volume rm -f "$volume" >/dev/null 2>&1 || true; done
for network in $(docker network ls --format '{{.Name}}' | awk '/^cbacceptance/ { print }'); do docker network rm "$network" >/dev/null 2>&1 || true; done
rm -rf /tmp/composebastion-acceptance-bind/*
`;
  await compose(activeProject, activeEnv, ["exec", "-T", "sshhost", "sh", "-lc", cleanup]);
}

async function verifyMail(subject, minimum = 1) {
  return retry(`Mailpit message ${subject}`, async () => {
    const response = await fetch("http://127.0.0.1:18025/api/v1/messages");
    if (!response.ok) throw new Error(`Mailpit returned ${response.status}`);
    const body = await response.json();
    const messages = body.messages ?? body.Messages ?? [];
    const matches = messages.filter((message) => (message.Subject ?? message.subject) === subject);
    assert(matches.length >= minimum, `found ${matches.length} matching messages`);
    return matches.length;
  }, { attempts: 80, delayMs: 1_000 });
}

async function verifySmtpAndWorker() {
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
      sshPassword: token(20),
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

function disposableComposeYaml() {
  return `services:
  database:
    image: postgres:16.6-alpine3.20
    environment:
      POSTGRES_PASSWORD: \${WORKLOAD_DATABASE_PASSWORD}
    volumes:
      - database-data:/var/lib/postgresql/data
    networks:
      acceptance-net:
        ipv4_address: 172.31.250.10
  workload:
    image: alpine:3.20.8
    command: ["sh", "-c", "echo acceptance > /data/proof.txt; echo bind-ok > /allowed/proof.txt; sleep infinity"]
    volumes:
      - workload-data:/data
      - /tmp/composebastion-acceptance-bind:/allowed
    networks:
      acceptance-net:
        ipv4_address: 172.31.250.20
volumes:
  database-data:
  workload-data:
networks:
  acceptance-net:
    driver: bridge
    ipam:
      config:
        - subnet: 172.31.250.0/24
`;
}

async function deployDisposableStack(host) {
  const response = await api(`/api/hosts/${host.id}/compose`, {
    method: "POST",
    body: {
      name: "Acceptance disposable app",
      projectName: "cbacceptance",
      composeYaml: disposableComposeYaml(),
      env: `WORKLOAD_DATABASE_PASSWORD=${fixture.workloadPassword}\n`
    }
  });
  const stack = response.data.stack;
  const deployed = await api(`/api/compose/${stack.id}/deploy`, { method: "POST", body: {} });
  await waitForJob(deployed.data.job.id, { timeoutMs: 10 * 60_000 });
  const resources = await api(`/api/hosts/${host.id}/resources?kind=container`);
  assert(resources.data.resources.some((resource) => resource.name.includes("cbacceptance")), "deployed containers were not inventoried");
  return stack;
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
  return { s3, smb };
}

async function exerciseRecovery(host, stack, targets) {
  const created = await api("/api/recovery/points", {
    method: "POST",
    body: {
      hostId: host.id,
      name: "Acceptance remote-only recovery",
      appIdentity: { kind: "stack", stackId: stack.id, projectName: stack.projectName },
      backupTargetId: targets.s3.id,
      captureMode: "hot",
      triggerKind: "manual",
      stopFirst: false,
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

  const verify = await api(`/api/recovery/points/${pointId}/verify`, { method: "POST", body: {} });
  await waitForJob(verify.data.job.id, { timeoutMs: 10 * 60_000 });

  const restore = await api("/api/recovery/restore", {
    method: "POST",
    body: {
      recoveryPointId: pointId,
      targetHostId: host.id,
      options: {
        mode: "clone",
        stopExisting: false,
        projectNameOverride: "cbacceptanceclone",
        volumePrefix: "cbacceptanceclone",
        remapPorts: true,
        networkMode: "clone"
      }
    }
  });
  const restoreJob = await waitForJob(restore.data.job.id, { timeoutMs: 15 * 60_000 });
  assert(restoreJob.result?.composeRestored === true, "clone restore did not deploy the recovered Compose app");
  const restoredProject = restoreJob.result.projectName;
  assert(restoredProject, "clone restore did not report its project name");

  await compose(activeProject, activeEnv, [
    "exec", "-T", "sshhost", "sh", "-lc",
    `docker compose -p '${restoredProject}' -f '/tmp/composebastion/${pointId}/compose.yml' down -v --remove-orphans`
  ]);
  await api(`/api/recovery/points/${pointId}`, { method: "DELETE" });
  return { pointId, restoredProject, artifacts: detail.data.point.artifacts.length };
}

async function cleanupFresh(stack, targets) {
  if (stack) {
    const removed = await api(`/api/compose/${stack.id}/remove`, { method: "POST", body: { removeVolumes: true } });
    await waitForJob(removed.data.job.id, { timeoutMs: 5 * 60_000 });
    await api(`/api/compose/${stack.id}`, { method: "DELETE" });
  }
  for (const target of Object.values(targets ?? {})) {
    await api(`/api/recovery/targets/${target.id}`, { method: "DELETE" });
  }
}

async function freshCandidateScenario() {
  const project = "composebastion-acceptance-fresh";
  const env = acceptanceEnv();
  activeProject = project;
  activeEnv = env;
  sessionCookie = "";
  let stack;
  let targets;
  await compose(project, env, ["down", "--volumes", "--remove-orphans"], {}).catch(() => undefined);
  try {
    await compose(project, env, ["up", "--detach", "--build", "postgres", "redis", "mailpit", "minio", "samba", "sshhost"], { inherit: true });
    await cleanupManagedDockerState();
    await createMinioBucket();
    await compose(project, env, ["up", "--detach", "app", "worker"], { inherit: true });
    const health = await waitForApiVersion(candidateVersion);
    await setupOwner();

    await api("/api/auth/logout", { method: "POST", body: {} });
    sessionCookie = "";
    const user = await loginOwner();
    assert(user.role === "owner", "restored session is not the owner session");
    const sessions = await api("/api/auth/sessions");
    assert(sessions.data.sessions.some((item) => item.current), "current session was not listed");
    const ready = await api("/api/health/ready");
    assert(ready.data.ok === true, "Operations readiness was not healthy");

    await verifySmtpAndWorker();
    const host = await createSshHost();
    stack = await deployDisposableStack(host);
    targets = await createAndTestTargets();
    const recovery = await exerciseRecovery(host, stack, targets);
    await cleanupFresh(stack, targets);
    stack = undefined;
    targets = undefined;
    return { runtimeVersion: health.version, legalVersion: candidateVersion, recovery };
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
  const project = "composebastion-acceptance-source";
  const backupDir = path.join(runtimeDir, "source-backups");
  await mkdir(backupDir, { recursive: true });
  const env = {
    ...process.env,
    APP_SECRET: token(32),
    POSTGRES_PASSWORD: token(24),
    COMPOSEBASTION_BACKUP_DIR: backupDir,
    SECURE_COOKIES: "false"
  };
  const args = [
    "compose", "--project-name", project,
    "--file", path.join(root, "docker-compose.yml"),
    "--file", path.join(root, "docker-compose.prod.example.yml")
  ];
  await run("docker", [...args, "down", "--volumes", "--remove-orphans"], { env }).catch(() => undefined);
  try {
    await run("docker", [...args, "up", "--detach", "--build"], { env, inherit: true });
    await retry("source production API", async () => {
      const result = await run("docker", [...args, "exec", "-T", "app", "node", "-e", "fetch('http://127.0.0.1:8080/api/health/ready').then(async r=>{if(!r.ok)throw new Error(await r.text())})"], { env });
      return result;
    }, { attempts: 120, delayMs: 1_000 });
    const version = await run("docker", [...args, "exec", "-T", "app", "node", "-p", "require('./package.json').version"], { env });
    assert(version.stdout === candidateVersion, `source image reported ${version.stdout}`);
    const setupScript = "fetch('http://127.0.0.1:8080/api/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'source-owner',password:process.env.ACCEPTANCE_PASSWORD,includeDemoData:false})}).then(async r=>{if(!r.ok)throw new Error(await r.text())})";
    await run("docker", [...args, "exec", "-T", "-e", `ACCEPTANCE_PASSWORD=${fixture.ownerPassword}`, "app", "node", "-e", setupScript], { env });
    return { runtimeVersion: version.stdout, firstRunSetup: true };
  } finally {
    if (!keep) await run("docker", [...args, "down", "--volumes", "--remove-orphans"], { env }).catch(() => undefined);
  }
}

async function upgradeScenario() {
  const project = "composebastion-acceptance-upgrade";
  const oldEnv = acceptanceEnv(publicImage, { ACCEPTANCE_HTTP_PORT: "18080" });
  const newEnv = acceptanceEnv(candidateImage, { ACCEPTANCE_HTTP_PORT: "18080" });
  activeProject = project;
  activeEnv = oldEnv;
  sessionCookie = "";
  await compose(project, oldEnv, ["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
  try {
    await run("docker", ["pull", publicImage], { inherit: true });
    await compose(project, oldEnv, ["up", "--detach", "postgres", "redis", "app", "worker"], { inherit: true });
    await waitForApiVersion("1.0.6");
    await setupOwner();
    await api("/api/alerts/channels", {
      method: "POST",
      body: { name: fixture.publicMarker, type: "email", emailTo: "upgrade@composebastion.invalid", enabled: true }
    });
    await compose(project, oldEnv, ["stop", "app", "worker"]);
    activeEnv = newEnv;
    await compose(project, newEnv, ["up", "--detach", "app", "worker"], { inherit: true });
    await waitForApiVersion(candidateVersion);
    sessionCookie = "";
    await loginOwner();
    const channels = await api("/api/alerts/channels");
    assert(channels.data.channels.some((channel) => channel.name === fixture.publicMarker), "configuration did not survive the image upgrade");
    const state = await api("/api/auth/setup-state");
    assert(state.data.needsSetup === false, "database state did not survive the image upgrade");
    return { from: "1.0.6", to: candidateVersion, preservedConfiguration: true, preservedDatabase: true };
  } finally {
    if (!keep) {
      await compose(project, newEnv, ["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
      activeProject = null;
      activeEnv = null;
    }
  }
}

async function writeReport() {
  report.completedAt = new Date().toISOString();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const rows = report.scenarios.map((item) =>
    `| ${item.name.replaceAll("|", "\\|")} | ${item.status} | ${item.durationMs} | ${redact(item.error ?? "").replaceAll("|", "\\|")} |`
  );
  const markdown = `# ComposeBastion Acceptance Report

- Candidate: \`${candidateVersion}\`
- Status: **${report.status}**
- Started: ${report.startedAt}
- Completed: ${report.completedAt}
- Fixture credentials: redacted and not retained in this report

| Scenario | Status | Duration (ms) | Error |
|---|---:|---:|---|
${rows.join("\n")}
`;
  await mkdir(resultsDir, { recursive: true });
  await writeFile(path.join(resultsDir, "report.json"), redact(json));
  await writeFile(path.join(resultsDir, "report.md"), redact(markdown));
}

async function captureFailureLogs() {
  if (!activeProject || !activeEnv) return;
  try {
    const logs = await compose(activeProject, activeEnv, ["logs", "--no-color", "--tail", "300"]);
    await writeFile(path.join(resultsDir, "failure.log"), `${redact(logs.stdout)}\n`);
  } catch {
    // The structured report remains the primary result when Docker itself fails.
  }
}

async function main() {
  await mkdir(resultsDir, { recursive: true });
  await prepareSshKey();
  await record("Candidate runtime image build", buildCandidate);
  await record("Fresh candidate installation and recovery", freshCandidateScenario);
  await record("Fresh source-build production installation", sourceProductionScenario);
  if (!skipUpgrade) await record("Upgrade from public 1.0.6 with state preservation", upgradeScenario);
  report.status = "passed";
}

try {
  await main();
} catch (error) {
  report.status = "failed";
  await captureFailureLogs();
  process.exitCode = 1;
  console.error(`\n[acceptance] FAILED: ${redact(error instanceof Error ? error.message : error)}`);
} finally {
  await rm(runtimeDir, { recursive: true, force: true });
  await writeReport();
  console.log(`\n[acceptance] ${report.status.toUpperCase()} — reports: ${path.join(resultsDir, "report.md")}`);
}
