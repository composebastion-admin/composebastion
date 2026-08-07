import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = path.join(repositoryRoot, "scripts", "upgrade-image.sh");
const oldImage = `sha256:${"a".repeat(64)}`;
const candidateImage = `sha256:${"c".repeat(64)}`;
const legacyUrl = "postgres://composebastion:composebastion@postgres:5432/composebastion";

async function createMockDocker(directory) {
  const mockPath = path.join(directory, "docker-mock.mjs");
  await writeFile(mockPath, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const log = (entry) => appendFileSync(process.env.MOCK_LOG, JSON.stringify(entry) + "\\n");
log(args);
const stateFile = process.env.MOCK_STATE;
const state = existsSync(stateFile) ? readFileSync(stateFile, "utf8").trim() : "old";
const compose = args[0] === "compose";
const has = (value) => args.includes(value);
const service = args.at(-1);
if (compose && has("ps")) {
  process.stdout.write(state + "-" + service + "\\n");
  process.exit(0);
}
if (args[0] === "inspect") {
  const container = args.at(-1);
  const phase = container.startsWith("candidate") ? "candidate" : "old";
  const format = args[args.indexOf("--format") + 1] || "";
  if (format === "{{.Image}}") process.stdout.write((phase === "candidate" ? ${JSON.stringify(candidateImage)} : ${JSON.stringify(oldImage)}) + "\\n");
  else if (format.includes("version")) process.stdout.write((phase === "candidate" ? "1.2.0" : "1.1.3") + "\\n");
  else if (format === "{{.State.Running}}") process.stdout.write("true\\n");
  else if (format === "{{.State.Health.Status}}") process.stdout.write(phase === "candidate" && process.env.MOCK_FAIL_STAGE === "verification" ? "unhealthy\\n" : "healthy\\n");
  else if (format.includes("image.title")) process.stdout.write("ComposeBastion\\n");
  else if (format.includes("image.source")) process.stdout.write("https://github.com/composebastion-admin/composebastion\\n");
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  process.stdout.write(${JSON.stringify(candidateImage)} + "\\n");
  process.exit(0);
}
if (compose && has("config")) {
  if (has("--format")) {
    process.stdout.write(JSON.stringify({ services: { app: { image: "candidate-app", environment: { DATABASE_URL: ${JSON.stringify(legacyUrl)} } }, worker: { image: "candidate-worker" } } }) + "\\n");
  } else {
    process.stdout.write("services:\\n  app:\\n    image: candidate-app\\n  worker:\\n    image: candidate-worker\\n");
  }
  process.exit(0);
}
if (compose && has("pull")) {
  if (process.env.MOCK_FAIL_STAGE === "interrupt") process.kill(process.ppid, "SIGTERM");
  process.exit(process.env.MOCK_FAIL_STAGE === "pull" ? 1 : 0);
}
if (compose && has("run")) {
  if (service === "storage-init") process.exit(process.env.MOCK_FAIL_STAGE === "storage" ? 1 : 0);
  if (has("restore-legacy")) {
    log({ event: "restore", environment: readFileSync(process.env.MOCK_ENV, "utf8") });
    process.exit(0);
  }
  if (service === "database-init" || (args.some((value) => value.endsWith("prepare-database-upgrade.mjs")) && has("reconcile"))) {
    if (process.env.MOCK_FAIL_STAGE === "database") process.exit(1);
    process.stdout.write("COMPOSEBASTION_DATABASE_CREDENTIAL_TRANSITION=changed\\n");
    process.stdout.write("COMPOSEBASTION_DATABASE_ENVIRONMENT_ACTION=canonicalize\\n");
    process.exit(0);
  }
}
if (compose && has("up")) {
  const rollback = args.some((value) => value.endsWith("rollback.yml"));
  if (!rollback && process.env.MOCK_FAIL_STAGE === "startup") process.exit(1);
  writeFileSync(stateFile, rollback ? "old" : "candidate");
  if (rollback) log({ event: "rollback-start", environment: readFileSync(process.env.MOCK_ENV, "utf8"), noDeps: has("--no-deps") });
  process.exit(0);
}
if (compose && has("exec")) {
  if (process.env.MOCK_FAIL_STAGE === "promotion" && process.env.MOCK_TARGET_TO_REMOVE && existsSync(process.env.MOCK_TARGET_TO_REMOVE)) {
    unlinkSync(process.env.MOCK_TARGET_TO_REMOVE);
  }
  process.exit(0);
}
process.exit(0);
`, { mode: 0o700 });
  await chmod(mockPath, 0o700);
  return mockPath;
}

async function createMockMove(directory) {
  const binDirectory = path.join(directory, "bin");
  const mockPath = path.join(binDirectory, "mv");
  await mkdir(binDirectory);
  await writeFile(mockPath, `#!/usr/bin/env node
import { mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
const args = process.argv.slice(2);
const result = spawnSync("/bin/mv", args, { stdio: "inherit" });
if (result.status === 0 && path.basename(args.at(-1) || "") === "current-overlay.yml") {
  const action = process.env.MOCK_FINALIZATION_ACTION || "";
  if (action === "block-outcome") {
    const recovery = readdirSync(process.cwd()).find((name) => name.startsWith(".composebastion-image-upgrade-") && name.endsWith(".recovery"));
    if (recovery) mkdirSync(recovery.replace(/\\.recovery$/, ".outcome"));
  } else if (action === "interrupt") {
    process.kill(process.ppid, "SIGTERM");
  }
}
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  await chmod(mockPath, 0o700);
  return binDirectory;
}

async function runUpgrade(failure = "", finalizationAction = "") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "composebastion-image-upgrade-"));
  const mock = await createMockDocker(directory);
  const binDirectory = await createMockMove(directory);
  const currentBase = path.join(directory, "current.yml");
  const targetBase = path.join(directory, "target.yml");
  const currentOverlay = path.join(directory, "current-overlay.yml");
  const targetOverlay = path.join(directory, "target-overlay.yml");
  const environment = path.join(directory, ".env");
  const state = path.join(directory, "mock.state");
  const log = path.join(directory, "mock.log");
  const oldBase = "services:\n  app:\n    image: old\n";
  const newBase = "services:\n  app:\n    image: candidate\n";
  const oldOverlay = "services:\n  worker:\n    image: old\n";
  const newOverlay = "services:\n  worker:\n    image: candidate\n";
  const originalEnvironment = `COMPOSEBASTION_VERSION=1.1.3\nPOSTGRES_PASSWORD=random-password\nDATABASE_URL=${legacyUrl}\nAPP_SECRET=${"x".repeat(32)}\n`;
  await Promise.all([
    writeFile(currentBase, oldBase),
    writeFile(targetBase, newBase),
    writeFile(currentOverlay, oldOverlay),
    writeFile(targetOverlay, newOverlay),
    writeFile(environment, originalEnvironment, { mode: 0o600 }),
    writeFile(state, "old"),
    writeFile(log, "")
  ]);
  const result = spawnSync("sh", [
    wrapper,
    "--version", "1.2.0",
    "--env-file", ".env",
    "--compose", "current.yml", "target.yml",
    "--compose", "current-overlay.yml", "target-overlay.yml"
  ], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      COMPOSEBASTION_IMAGE_UPGRADE_DOCKER_BIN: mock,
      COMPOSEBASTION_IMAGE_UPGRADE_VERIFY_ATTEMPTS: "1",
      COMPOSEBASTION_IMAGE_UPGRADE_VERIFY_INTERVAL_SECONDS: "0",
      MOCK_FAIL_STAGE: failure,
      MOCK_LOG: log,
      MOCK_STATE: state,
      MOCK_ENV: environment,
      MOCK_TARGET_TO_REMOVE: targetOverlay,
      MOCK_FINALIZATION_ACTION: finalizationAction
    }
  });
  const entries = (await readFile(log, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const files = await readdir(directory);
  const output = {
    result,
    entries,
    environment: await readFile(environment, "utf8"),
    currentBase: await readFile(currentBase, "utf8"),
    currentOverlay: await readFile(currentOverlay, "utf8"),
    originalEnvironment,
    oldBase,
    newBase,
    oldOverlay,
    newOverlay,
    recovery: files.filter((name) => name.endsWith(".recovery")),
    outcomes: files.filter((name) => name.endsWith(".outcome")),
    outcomeText: await Promise.all(files.filter((name) => name.endsWith(".outcome")).map((name) =>
      readFile(path.join(directory, name), "utf8").catch(() => "")
    ))
  };
  await rm(directory, { recursive: true, force: true });
  return output;
}

test("manual image wrapper prepares, verifies, and promotes every target Compose file", async () => {
  const result = await runUpgrade();
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.equal(result.currentBase, result.newBase);
  assert.equal(result.currentOverlay, result.newOverlay);
  assert.match(result.environment, /COMPOSEBASTION_VERSION=1\.2\.0/);
  assert.match(result.environment, /DATABASE_URL=\n$/m);
  assert.equal(result.recovery.length, 0);
  assert.equal(result.outcomes.length, 1);
  const program = await readFile(wrapper, "utf8");
  assert(program.lastIndexOf("write_outcome passed complete not_required 0") < program.lastIndexOf("trap - HUP INT TERM"));
  assert(program.lastIndexOf("trap - HUP INT TERM") < program.lastIndexOf("rm -rf -- \"$STATE_DIRECTORY\""));
  const initializerRuns = result.entries.filter(Array.isArray).filter((args) => args.includes("run"));
  assert(initializerRuns.some((args) => args.at(-1) === "storage-init" && args.includes("--no-deps")));
  const reconciliation = initializerRuns.find((args) => args.includes("reconcile"));
  assert(reconciliation?.includes("database-init"));
  assert.equal(reconciliation?.[reconciliation.indexOf("--user") + 1], "0:0");
});

for (const stage of ["pull", "storage", "database", "startup", "verification", "promotion"]) {
  test(`manual image wrapper rolls back a ${stage} failure safely`, async () => {
    const result = await runUpgrade(stage);
    assert.notEqual(result.result.status, 0);
    assert.equal(result.environment, result.originalEnvironment);
    assert.equal(result.currentBase, result.oldBase);
    assert.equal(result.currentOverlay, result.oldOverlay);
    assert.equal(result.recovery.length, 0);
    assert.equal(result.outcomes.length, 1);
    if (!["pull"].includes(stage)) {
      const restoreIndex = result.entries.findIndex((entry) => !Array.isArray(entry) && entry.event === "restore");
      const rollbackIndex = result.entries.findIndex((entry) => !Array.isArray(entry) && entry.event === "rollback-start");
      if (["database", "startup", "verification", "promotion"].includes(stage)) {
        assert(restoreIndex >= 0 && rollbackIndex > restoreIndex, "credential restoration must precede immutable startup");
        assert.match(result.entries[restoreIndex].environment, /COMPOSEBASTION_VERSION=1\.2\.0/);
        const restoration = result.entries.find((entry) => Array.isArray(entry) && entry.includes("restore-legacy"));
        assert.equal(restoration?.[restoration.indexOf("--user") + 1], "0:0");
      }
      assert.equal(result.entries[rollbackIndex]?.noDeps, true);
      assert.equal(result.entries[rollbackIndex]?.environment, result.originalEnvironment);
    }
  });
}

test("manual image wrapper traps interruption and retains a truthful recovery outcome", async () => {
  const result = await runUpgrade("interrupt");
  assert.equal(result.result.status, 130);
  assert.equal(result.environment, result.originalEnvironment);
  assert.equal(result.currentBase, result.oldBase);
  assert.equal(result.recovery.length, 0);
  assert.equal(result.outcomes.length, 1);
  assert.match(result.result.stderr, /failed at interrupted; automatic rollback succeeded/);
});

test("manual image wrapper rolls back and retains recovery inputs when outcome publication fails", async () => {
  const result = await runUpgrade("", "block-outcome");
  assert.notEqual(result.result.status, 0);
  assert.equal(result.environment, result.originalEnvironment);
  assert.equal(result.currentBase, result.oldBase);
  assert.equal(result.currentOverlay, result.oldOverlay);
  assert.equal(result.recovery.length, 1);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomeText[0], "");
  assert.match(result.result.stderr, /authoritative outcome could not be published/);
  const restoreIndex = result.entries.findIndex((entry) => !Array.isArray(entry) && entry.event === "restore");
  const rollbackIndex = result.entries.findIndex((entry) => !Array.isArray(entry) && entry.event === "rollback-start");
  assert(restoreIndex >= 0 && rollbackIndex > restoreIndex);
});

test("manual image wrapper rolls back if interrupted after Compose promotion but before outcome publication", async () => {
  const result = await runUpgrade("", "interrupt");
  assert.equal(result.result.status, 130);
  assert.equal(result.environment, result.originalEnvironment);
  assert.equal(result.currentBase, result.oldBase);
  assert.equal(result.currentOverlay, result.oldOverlay);
  assert.equal(result.recovery.length, 0);
  assert.equal(result.outcomes.length, 1);
  assert.match(result.outcomeText[0], /status=failed\nstage=interrupted\nrollback=succeeded/);
});

test("manual image wrapper rejects duplicate and inode-aliased Compose mappings before mutation", async () => {
  for (const scenario of ["duplicate-current", "duplicate-target", "cross-role", "hardlink"]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "composebastion-image-upgrade-alias-"));
    try {
      const mock = await createMockDocker(directory);
      const environment = path.join(directory, ".env");
      const log = path.join(directory, "mock.log");
      const state = path.join(directory, "mock.state");
      await Promise.all([
        writeFile(environment, "COMPOSEBASTION_VERSION=1.1.3\n", { mode: 0o600 }),
        writeFile(path.join(directory, "current.yml"), "services: {}\n"),
        writeFile(path.join(directory, "current-two.yml"), "services: {}\n"),
        writeFile(path.join(directory, "target.yml"), "services: {}\n"),
        writeFile(path.join(directory, "target-two.yml"), "services: {}\n"),
        writeFile(log, ""),
        writeFile(state, "old")
      ]);
      if (scenario === "hardlink") {
        await rm(path.join(directory, "current-two.yml"));
        await link(path.join(directory, "current.yml"), path.join(directory, "current-two.yml"));
      }
      const pairs = scenario === "duplicate-current"
        ? [["current.yml", "target.yml"], ["current.yml", "target-two.yml"]]
        : scenario === "duplicate-target"
          ? [["current.yml", "target.yml"], ["current-two.yml", "target.yml"]]
          : scenario === "cross-role"
            ? [["current.yml", "target.yml"], ["target.yml", "target-two.yml"]]
            : [["current.yml", "target.yml"], ["current-two.yml", "target-two.yml"]];
      const args = [wrapper, "--version", "1.2.0", "--env-file", ".env"];
      for (const [current, target] of pairs) args.push("--compose", current, target);
      const result = spawnSync("sh", args, {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          COMPOSEBASTION_IMAGE_UPGRADE_DOCKER_BIN: mock,
          MOCK_LOG: log,
          MOCK_STATE: state,
          MOCK_ENV: environment
        }
      });
      assert.equal(result.status, 64, scenario);
      assert.match(result.stderr, /must be unique and must not alias/);
      assert.equal(await readFile(environment, "utf8"), "COMPOSEBASTION_VERSION=1.1.3\n");
      assert.equal(await readFile(log, "utf8"), "");
      assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".recovery")), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("manual image wrapper atomically updates an env file on a different filesystem", async (context) => {
  const sharedMemory = "/dev/shm";
  const required = process.env.COMPOSEBASTION_REQUIRE_CROSS_FILESYSTEM_TEST === "1";
  try {
    await access(sharedMemory);
  } catch {
    if (required) assert.fail("qualification requires a writable /dev/shm secondary filesystem");
    context.skip("no writable secondary filesystem is available");
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "composebastion-image-upgrade-cross-device-"));
  const externalDirectory = await mkdtemp(path.join(sharedMemory, "composebastion-image-upgrade-env-"));
  try {
    if ((await stat(directory)).dev === (await stat(externalDirectory)).dev) {
      if (required) assert.fail("qualification requires /dev/shm and the working directory to use different filesystems");
      context.skip("the selected paths are on the same filesystem");
      return;
    }
    const mock = await createMockDocker(directory);
    const current = path.join(directory, "current.yml");
    const target = path.join(directory, "target.yml");
    const environment = path.join(externalDirectory, ".env");
    const state = path.join(directory, "mock.state");
    const log = path.join(directory, "mock.log");
    await Promise.all([
      writeFile(current, "services:\n  app:\n    image: old\n"),
      writeFile(target, "services:\n  app:\n    image: candidate\n"),
      writeFile(environment, `COMPOSEBASTION_VERSION=1.1.3\nPOSTGRES_PASSWORD=managed\nDATABASE_URL=${legacyUrl}\n`, { mode: 0o600 }),
      writeFile(state, "old"),
      writeFile(log, "")
    ]);
    const result = spawnSync("sh", [
      wrapper, "--version", "1.2.0", "--env-file", environment,
      "--compose", "current.yml", "target.yml"
    ], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        COMPOSEBASTION_IMAGE_UPGRADE_DOCKER_BIN: mock,
        COMPOSEBASTION_IMAGE_UPGRADE_VERIFY_ATTEMPTS: "1",
        COMPOSEBASTION_IMAGE_UPGRADE_VERIFY_INTERVAL_SECONDS: "0",
        MOCK_FAIL_STAGE: "",
        MOCK_LOG: log,
        MOCK_STATE: state,
        MOCK_ENV: environment
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(environment, "utf8"), /COMPOSEBASTION_VERSION=1\.2\.0/);
    assert.deepEqual((await readdir(externalDirectory)).filter((name) => name.includes(".composebastion-")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(externalDirectory, { recursive: true, force: true });
  }
});

test("manual image wrapper rejects nested current and target Compose paths before mutation", async () => {
  for (const nestedSide of ["current", "target", "target-traversal"]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "composebastion-image-upgrade-path-"));
    try {
      const mock = await createMockDocker(directory);
      await mkdir(path.join(directory, "nested"));
      await writeFile(path.join(directory, ".env"), "COMPOSEBASTION_VERSION=1.1.3\n", { mode: 0o600 });
      await writeFile(path.join(directory, "current.yml"), "services: {}\n");
      await writeFile(path.join(directory, "target.yml"), "services: {}\n");
      await writeFile(path.join(directory, "nested", `${nestedSide}.yml`), "services: {}\n");
      const log = path.join(directory, "mock.log");
      const state = path.join(directory, "mock.state");
      await writeFile(log, "");
      await writeFile(state, "old");
      const current = nestedSide === "current" ? `nested/${nestedSide}.yml` : "current.yml";
      const target = nestedSide === "target"
        ? `nested/${nestedSide}.yml`
        : nestedSide === "target-traversal"
          ? "nested/../target.yml"
          : "target.yml";
      const result = spawnSync("sh", [
        wrapper,
        "--version", "1.2.0",
        "--env-file", ".env",
        "--compose", current, target
      ], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          COMPOSEBASTION_IMAGE_UPGRADE_DOCKER_BIN: mock,
          MOCK_LOG: log,
          MOCK_STATE: state,
          MOCK_ENV: path.join(directory, ".env")
        }
      });
      assert.equal(result.status, 64);
      assert.match(result.stderr, /direct child of the working directory/);
      assert.equal(await readFile(path.join(directory, ".env"), "utf8"), "COMPOSEBASTION_VERSION=1.1.3\n");
      assert.equal(await readFile(log, "utf8"), "");
      assert.deepEqual((await readdir(directory)).filter((name) => name.includes(".recovery")), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("upgrade recovery artifacts are excluded from Git and Docker contexts", async () => {
  const exclusions = [
    [".composebastion-image-upgrade-*", ".composebastion-image-upgrade-job.recovery"],
    [".composebastion-source-upgrade-*", ".composebastion-source-upgrade-job.recovery"],
    [".composebastion-self-update-*", ".composebastion-self-update-job.recovery"]
  ];
  const dockerIgnore = await readFile(path.join(repositoryRoot, ".dockerignore"), "utf8");
  for (const [pattern, representative] of exclusions) {
    const ignored = spawnSync("git", ["check-ignore", "--no-index", "--quiet", representative], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.equal(ignored.status, 0, `${representative} must be ignored by Git`);
    assert(dockerIgnore.split(/\r?\n/).includes(pattern), `${pattern} must be excluded from Docker contexts`);
  }
});
