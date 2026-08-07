import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceUpgrade = path.join(root, "scripts", "upgrade-source.mjs");
const oldAppImage = `sha256:${"a".repeat(64)}`;
const oldWorkerImage = `sha256:${"b".repeat(64)}`;
const candidateAppImage = `sha256:${"c".repeat(64)}`;
const candidateWorkerImage = `sha256:${"d".repeat(64)}`;

async function mockDocker(directory) {
  const executable = path.join(directory, "docker-mock.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const log = process.env.MOCK_DOCKER_LOG;
appendFileSync(log, JSON.stringify(args) + "\\n");
const stateFile = process.env.MOCK_DOCKER_STATE;
const state = existsSync(stateFile) ? readFileSync(stateFile, "utf8").trim() : "old";
const setState = (value) => writeFileSync(stateFile, value);
const commandAt = (name) => args.indexOf(name);
const compose = args[0] === "compose";
if (compose && commandAt("ps") >= 0) {
  const service = args.at(-1);
  process.stdout.write(state + "-" + service + "\\n");
  process.exit(0);
}
if (args[0] === "inspect") {
  const container = args.at(-1);
  const service = container.endsWith("worker") ? "worker" : "app";
  const format = args[args.indexOf("--format") + 1] || "";
  const phase = container.split("-")[0];
  if (format === "{{.Image}}") {
    process.stdout.write((phase === "candidate"
      ? (service === "app" ? ${JSON.stringify(candidateAppImage)} : ${JSON.stringify(candidateWorkerImage)})
      : (service === "app" ? ${JSON.stringify(oldAppImage)} : ${JSON.stringify(oldWorkerImage)})) + "\\n");
  } else if (format.includes("version")) {
    process.stdout.write((phase === "candidate" ? "1.2.0-beta.1" : "1.1.2") + "\\n");
  } else if (format.includes("revision")) {
    process.stdout.write("${"e".repeat(40)}\\n");
  } else if (format === "{{.State.Running}}") {
    process.stdout.write("true\\n");
  } else if (format === "{{.State.Health.Status}}") {
    process.stdout.write(phase === "candidate" && process.env.MOCK_FAIL_CANDIDATE === "1" ? "unhealthy\\n" : "healthy\\n");
  }
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  const reference = args.at(-1);
  process.stdout.write((reference === "candidate-app" ? ${JSON.stringify(candidateAppImage)} : ${JSON.stringify(candidateWorkerImage)}) + "\\n");
  process.exit(0);
}
if (compose && commandAt("config") >= 0) {
  process.stdout.write(JSON.stringify({ services: { app: { image: "candidate-app" }, worker: { image: "candidate-worker" } } }) + "\\n");
  process.exit(0);
}
if (compose && commandAt("run") >= 0) {
  if (args.includes("reconcile")) {
    const volume = args[args.indexOf("--volume") + 1];
    const hostDirectory = volume.slice(0, volume.lastIndexOf(":"));
    writeFileSync(hostDirectory + "/database-transition.json", JSON.stringify({ schema: 1, changed: true, status: "reconciled" }), { mode: 0o600 });
    process.stdout.write("COMPOSEBASTION_DATABASE_CREDENTIAL_TRANSITION=unchanged\\n");
    process.stdout.write("COMPOSEBASTION_DATABASE_ENVIRONMENT_ACTION=canonicalize\\n");
  }
  process.exit(0);
}
if (compose && commandAt("up") >= 0) {
  setState(args.some((value) => value.endsWith("rollback.yml")) ? "rollback" : "candidate");
  process.exit(0);
}
process.exit(0);
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

async function runWrapper({ failCandidate = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "composebastion-source-upgrade-"));
  const docker = await mockDocker(directory);
  const logPath = path.join(directory, "docker.log");
  const statePath = path.join(directory, "state");
  const environmentPath = path.join(directory, ".env");
  const originalEnvironment = "DATABASE_URL=postgres://composebastion:composebastion@postgres:5432/composebastion\nSOURCE_SECRET=preserved\n";
  await writeFile(logPath, "");
  await writeFile(statePath, "old");
  await writeFile(environmentPath, originalEnvironment, { mode: 0o600 });
  const before = new Set((await readdir(root)).filter((name) => name.startsWith(".composebastion-source-upgrade-")));
  const result = spawnSync(process.execPath, [sourceUpgrade], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      COMPOSEBASTION_SOURCE_UPGRADE_DOCKER_BIN: docker,
      COMPOSEBASTION_SOURCE_UPGRADE_VERIFY_ATTEMPTS: "1",
      COMPOSEBASTION_SOURCE_UPGRADE_VERIFY_INTERVAL_MS: "0",
      COMPOSEBASTION_SOURCE_UPGRADE_ENV_FILE: environmentPath,
      MOCK_DOCKER_LOG: logPath,
      MOCK_DOCKER_STATE: statePath,
      MOCK_FAIL_CANDIDATE: failCandidate ? "1" : "0"
    }
  });
  const after = new Set((await readdir(root)).filter((name) => name.startsWith(".composebastion-source-upgrade-")));
  assert.deepEqual(after, before, "source upgrade left recovery state after a completed success or rollback");
  const commands = (await readFile(logPath, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const environment = await readFile(environmentPath, "utf8");
  await rm(directory, { recursive: true, force: true });
  return { result, commands, environment, originalEnvironment };
}

test("source upgrade verifies identities and persists its managed database transition", async () => {
  const { result, commands, environment } = await runWrapper();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /completed successfully/);
  assert(commands.some((args) => args[0] === "image" && args[1] === "inspect" && args.at(-1) === "candidate-app"));
  assert(commands.some((args) => args.includes("up") && args.includes("--no-deps") && args.includes("--force-recreate")));
  assert.match(environment, /# ComposeBastion managed legacy database transition\nDATABASE_URL=\n/);
  assert.match(environment, /SOURCE_SECRET=preserved/);
});

test("source upgrade restores the credential and environment before immutable no-deps rollback", async () => {
  const { result, commands, environment, originalEnvironment } = await runWrapper({ failCandidate: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Prior containers are healthy/);
  const restoreIndex = commands.findIndex((args) => args.includes("restore-legacy"));
  const rollbackIndex = commands.findIndex((args) => args.includes("up") && args.some((value) => value.endsWith("rollback.yml")));
  assert(restoreIndex >= 0 && rollbackIndex > restoreIndex, "credential restoration did not precede rollback startup");
  assert(commands[rollbackIndex].includes("--no-deps"));
  assert(commands[rollbackIndex].includes(oldAppImage) === false, "prior image IDs must stay in the protected overlay, not process arguments");
  assert.equal(environment, originalEnvironment);
});
