import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildBridgeSelfUpdateControls, buildBridgeSelfUpdateLaunchScript } from "../src/services/selfUpdate.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const mockDocker = `#!/bin/sh
set -u
printf '%s\n' "$*" >> "$MOCK_STATE_DIR/commands.log"
phase="$(cat "$MOCK_STATE_DIR/phase")"
if [ "$1" = compose ]; then
  case " $* " in
    *" ps -q app "*) printf '%s\n' app-container; exit 0 ;;
    *" ps -q worker "*) printf '%s\n' worker-container; exit 0 ;;
    *" pull app worker "*) [ "$MOCK_FAIL" != pull ]; exit $? ;;
    *"source-env-probe.yml"*" config --format json "*)
      probe_template="$(printf '%s\n' "$*" | sed -n 's/.*-f \\([^ ]*source-env-probe\\.yml\\).*/\\1/p')"
      cp "$probe_template" "$MOCK_STATE_DIR/source-env-probe.yml"
      printf '%s\n' '{"services":{"composebastion-upgrade-probe":{"environment":{"COMPOSEBASTION_UPGRADE_SOURCE_DATABASE_URL":"postgres://composebastion:composebastion@postgres:5432/composebastion"}}}}' > "$MOCK_STATE_DIR/source-env-probe.json"
      cat "$MOCK_STATE_DIR/source-env-probe.json"
      exit 0 ;;
    *" config --format json "*)
      printf '%s\n' '{"services":{"app":{"environment":{"DATABASE_URL":"postgres://composebastion:managed@postgres:5432/composebastion"}},"worker":{"environment":{"DATABASE_URL":"postgres://composebastion:managed@postgres:5432/composebastion"}},"postgres":{"environment":{"POSTGRES_PASSWORD":"managed"}}}}'
      exit 0 ;;
    *" config "*)
      printf '%s\n' services: '  app:' '    image: candidate-app:1.2.0' '  worker:' '    image: candidate-worker:1.2.0'
      exit 0 ;;
    *" stop app worker "*) exit 0 ;;
    *"prepare-compose-upgrade.mjs"*)
      state_mount="$(printf '%s\n' "$*" | sed -n 's#.*--volume \\([^ ]*\\):/run/composebastion-upgrade .*#\\1#p')"
      case " $* " in
        *" restore-legacy "*)
          printf '%s\n' restored >> "$MOCK_STATE_DIR/events"
          [ "$MOCK_RESTORE_FAIL" != true ]
          exit $? ;;
        *" reconcile "*)
          [ "$MOCK_FAIL" != prepare ] || exit 1
          printf '%s\n' '{"schema":1,"transition":"legacy-managed-database-credential","status":"reconciled","changed":true}' > "$state_mount/database-transition.json"
          printf '%s\n' COMPOSEBASTION_DATABASE_CREDENTIAL_TRANSITION=unchanged
          printf '%s\n' COMPOSEBASTION_DATABASE_ENVIRONMENT_ACTION=canonicalize
          exit 0 ;;
      esac ;;
    *" up -d "*" app worker "*)
      case " $* " in
        *".rollback.yml"*)
          printf '%s\n' rollback >> "$MOCK_STATE_DIR/events"
          cp "$(printf '%s\n' "$*" | sed -n 's/.*-f \\([^ ]*\\.rollback\\.yml\\).*/\\1/p')" "$MOCK_STATE_DIR/rollback.yml"
          printf '%s\n' old > "$MOCK_STATE_DIR/phase"
          exit 0 ;;
      esac
      printf '%s\n' new > "$MOCK_STATE_DIR/phase"
      [ "$MOCK_FAIL" != up ]
      exit $? ;;
    *" exec -T app node "*)
      if [ "$phase" = new ] && [ "$MOCK_FAIL" = finalization_interrupt ]; then
        kill -TERM "$PPID"
        sleep 1
        exit 1
      fi
      exit 0 ;;
  esac
fi
if [ "$1" = inspect ]; then
  format="$3"
  phase="$(cat "$MOCK_STATE_DIR/phase")"
  case "$format" in
    *".State.Running"*) printf '%s\n' true ;;
    *".State.Health.Status"*)
      if [ "$phase" = new ] && [ "$MOCK_FAIL" = verification ]; then printf '%s\n' unhealthy; else printf '%s\n' healthy; fi ;;
    *"org.opencontainers.image.title"*)
      if [ "$phase" = new ] && [ "$MOCK_FAIL" = identity ]; then printf '%s\n' Lookalike; else printf '%s\n' ComposeBastion; fi ;;
    *"org.opencontainers.image.source"*) printf '%s\n' https://github.com/composebastion-admin/composebastion ;;
    *"org.opencontainers.image.version"*)
      if [ "$phase" = old ]; then printf '%s\n' 1.1.3; else printf '%s\n' 1.2.0; fi ;;
    *"{{.Config.Image}}"*)
      if [ "$4" = app-container ]; then printf '%s\n' prior-app:1.1.3; else printf '%s\n' prior-worker:1.1.3; fi ;;
    *"{{.Image}}"*)
      if [ "$phase" = old ]; then
        if [ "$4" = app-container ]; then printf '%s\n' sha256:aaaaaaaa; else printf '%s\n' sha256:bbbbbbbb; fi
      else
        if [ "$4" = app-container ]; then printf '%s\n' sha256:cccccccc; else printf '%s\n' sha256:dddddddd; fi
      fi ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  case "$5" in candidate-app:*) printf '%s\n' sha256:cccccccc ;; *) printf '%s\n' sha256:dddddddd ;; esac
  exit 0
fi
if [ "$1" = image ] && [ "$2" = tag ]; then exit 0; fi
exit 1
`;

async function runBridge(
  failure: "" | "pull" | "prepare" | "up" | "verification" | "identity" | "finalization_interrupt",
  restoreFails = false,
  confirmGate = true,
  blockOutcomePublication = false
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "composebastion-bridge-update-"));
  temporaryDirectories.push(directory);
  const stateDirectory = path.join(directory, "state");
  const lockPath = path.join(directory, "lock");
  const outcomePath = path.join(directory, "outcome");
  const gatePath = path.join(directory, "gate");
  const envBackupPath = path.join(directory, "env.backup");
  const rollbackComposePath = path.join(directory, ".composebastion-self-update-bridge-job.rollback.yml");
  const scriptPath = path.join(directory, "update.sh");
  const dockerPath = path.join(directory, "docker-mock");
  const originalEnvironment = "COMPOSEBASTION_VERSION=1.1.3\nPOSTGRES_PASSWORD=managed\nDATABASE_URL=postgres://composebastion:composebastion@postgres:5432/composebastion\nAPP_SECRET=preserved\n";
  await mkdir(stateDirectory);
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "job"), "bridge-job\n");
  await writeFile(path.join(lockPath, "script"), `${scriptPath}\n`);
  await writeFile(path.join(directory, "compose.yml"), "services: {}\n");
  await writeFile(path.join(directory, ".env"), originalEnvironment);
  await writeFile(path.join(stateDirectory, "phase"), "old\n");
  await writeFile(path.join(stateDirectory, "events"), "");
  if (confirmGate) await writeFile(gatePath, "");
  await writeFile(dockerPath, mockDocker);
  await chmod(dockerPath, 0o700);
  const controls = buildBridgeSelfUpdateControls({
    workingDir: directory,
    composeFile: "compose.yml",
    versionMode: "pinned",
    targetVersion: "1.2.0"
  }, "/var/run/docker.sock", {
    jobId: "bridge-job",
    lockPath,
    outcomePath,
    gatePath,
    envBackupPath,
    rollbackComposePath
  });
  const program = await readFile(new URL("../../../scripts/bridge-self-update.sh", import.meta.url), "utf8");
  await writeFile(scriptPath, `${controls}\n${program}`);
  await chmod(scriptPath, 0o700);
  if (blockOutcomePublication) await mkdir(outcomePath);
  let exitCode = 0;
  let stderr = "";
  try {
    await execFileAsync("/bin/sh", ["-c", "printf '%s\\n' \"$$\" > \"$1/owner\"; exec \"$2\"", "bridge-wrapper", lockPath, scriptPath], {
      env: {
        ...process.env,
        COMPOSEBASTION_SELF_UPDATE_DOCKER_BIN: dockerPath,
        COMPOSEBASTION_SELF_UPDATE_VERIFY_ATTEMPTS: "1",
        COMPOSEBASTION_SELF_UPDATE_VERIFY_INTERVAL_SECONDS: "0",
        COMPOSEBASTION_SELF_UPDATE_GATE_ATTEMPTS: "1",
        MOCK_STATE_DIR: stateDirectory,
        MOCK_FAIL: failure,
        MOCK_RESTORE_FAIL: String(restoreFails)
      }
    });
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    exitCode = Number(failure.code ?? 1);
    stderr = failure.stderr ?? "";
  }
  return {
    exitCode,
    outcome: await readFile(outcomePath, "utf8").catch(() => ""),
    environment: await readFile(path.join(directory, ".env"), "utf8"),
    originalEnvironment,
    commands: await readFile(path.join(stateDirectory, "commands.log"), "utf8").catch(() => ""),
    events: await readFile(path.join(stateDirectory, "events"), "utf8"),
    rollback: await readFile(path.join(stateDirectory, "rollback.yml"), "utf8").catch(() => ""),
    sourceProbeTemplate: await readFile(path.join(stateDirectory, "source-env-probe.yml"), "utf8").catch(() => ""),
    sourceProbe: await readFile(path.join(stateDirectory, "source-env-probe.json"), "utf8").catch(() => ""),
    envBackupPath,
    rollbackComposePath,
    upgradeStateDirectory: path.join(directory, ".composebastion-self-update-bridge-job.upgrade"),
    program,
    stderr
  };
}

describe("1.1.3 bridge updater shell", () => {
  it("pins, prepares, verifies, and persists the canonical managed database selection", async () => {
    const result = await runBridge("");
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toContain("job_id=bridge-job\nstatus=passed\nstage=complete");
    expect(result.environment).toContain("COMPOSEBASTION_VERSION=1.2.0");
    expect(result.environment).toContain("DATABASE_URL=\n");
    expect(result.environment).toContain("APP_SECRET=preserved");
    expect(result.commands).toContain("run --rm --no-deps --user 0:0");
    expect(result.commands).toContain("up -d --pull never --no-deps --force-recreate app worker");
    expect(result.sourceProbeTemplate).toContain("COMPOSEBASTION_UPGRADE_SOURCE_DATABASE_URL: ${DATABASE_URL-}");
    expect(JSON.parse(result.sourceProbe).services["composebastion-upgrade-probe"].environment)
      .toMatchObject({ COMPOSEBASTION_UPGRADE_SOURCE_DATABASE_URL: "postgres://composebastion:composebastion@postgres:5432/composebastion" });
    expect(result.program.lastIndexOf("write_outcome passed complete not_required 0")).toBeLessThan(
      result.program.lastIndexOf("trap - HUP INT TERM")
    );
    expect(result.program.lastIndexOf("trap - HUP INT TERM")).toBeLessThan(
      result.program.lastIndexOf("success_cleanup_failed=0")
    );
  });

  it("restores the credential before the environment and immutable bridge images", async () => {
    const result = await runBridge("verification");
    expect(result.exitCode).toBe(1);
    expect(result.outcome, `${result.events}\n${result.commands}`).toContain("stage=verification\nrollback=succeeded");
    expect(result.environment).toBe(result.originalEnvironment);
    expect(result.events).toBe("restored\nrollback\n");
    expect(result.rollback).toContain("image: sha256:aaaaaaaa");
    expect(result.rollback).toContain("image: sha256:bbbbbbbb");
    expect(result.commands).toContain("rollback.yml up -d --pull never --no-deps --force-recreate app worker");
  });

  it("rejects a candidate without the official image identity labels", async () => {
    const result = await runBridge("identity");
    expect(result.exitCode).toBe(1);
    expect(result.outcome).toContain("stage=verification\nrollback=succeeded");
    expect(result.environment).toBe(result.originalEnvironment);
  });

  it("retains protected recovery state when credential restoration fails", async () => {
    const result = await runBridge("up", true);
    expect(result.exitCode).toBe(1);
    expect(result.outcome).toContain("rollback=failed");
    expect((await stat(result.envBackupPath)).mode & 0o077).toBe(0);
    await expect(stat(path.join(result.upgradeStateDirectory, "database-transition.json"))).resolves.toBeTruthy();
  });

  it("restores only the environment when pull fails before services are touched", async () => {
    const result = await runBridge("pull");
    expect(result.exitCode).toBe(1);
    expect(result.outcome).toContain("stage=pull\nrollback=succeeded");
    expect(result.environment).toBe(result.originalEnvironment);
    expect(result.commands).not.toContain("rollback.yml up -d");
  });

  it("writes an authoritative failed outcome when the persisted handoff is never confirmed", async () => {
    const result = await runBridge("", false, false);
    expect(result.exitCode).toBe(75);
    expect(result.outcome).toContain("status=failed\nstage=handoff_confirmation\nrollback=not_required");
    expect(result.commands).toBe("");
  });

  it("rolls back and retains protected inputs when the success outcome cannot be published", async () => {
    const result = await runBridge("", false, true, true);

    expect(result.exitCode).toBe(1);
    expect(result.outcome).toBe("");
    expect(result.environment).toBe(result.originalEnvironment);
    await expect(stat(result.envBackupPath)).resolves.toBeTruthy();
    await expect(stat(result.rollbackComposePath)).resolves.toBeTruthy();
    await expect(stat(path.join(result.upgradeStateDirectory, "database-transition.json"))).resolves.toBeTruthy();
    expect(result.stderr).toContain("authoritative failure outcome");
  });

  it("rolls back through the armed trap when interrupted during final verification", async () => {
    const result = await runBridge("finalization_interrupt");

    expect(result.exitCode).toBe(130);
    expect(result.outcome).toContain("status=failed\nstage=interrupted\nrollback=succeeded");
    expect(result.environment).toBe(result.originalEnvironment);
    expect(result.events).toBe("restored\nrollback\n");
  });
});

describe("1.1.3 bridge manager-host lock", () => {
  it("refuses a recent incomplete lock and safely reclaims it after the recovery age", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "composebastion-bridge-lock-"));
    temporaryDirectories.push(directory);
    const lockPath = path.join(directory, "lock");
    const scriptPath = path.join(directory, "job.sh");
    const logPath = path.join(directory, "job.log");
    await mkdir(lockPath);
    await writeFile(scriptPath, "#!/bin/sh\nsleep 30\n");
    await chmod(scriptPath, 0o700);
    const launch = buildBridgeSelfUpdateLaunchScript({ jobId: "bridge-lock-job", scriptPath, logPath, lockPath });
    const recent = await execFileAsync("/bin/sh", ["-c", launch]).then(
      (result) => ({ ...result, code: 0 }),
      (error: { code?: number; stderr?: string }) => ({ code: Number(error.code ?? 1), stderr: error.stderr ?? "" })
    );
    expect(recent.code).toBe(75);
    const old = new Date(Date.now() - 180_000);
    await utimes(lockPath, old, old);
    const reclaimed = await execFileAsync("/bin/sh", ["-c", launch]);
    process.kill(Number(reclaimed.stdout.trim()), "SIGTERM");
  });
});

describe("1.1.3 bridge recovery artifact exclusions", () => {
  it("excludes every upgrade recovery family from Git and Docker contexts", async () => {
    const exclusions = [
      [".composebastion-image-upgrade-*", ".composebastion-image-upgrade-job.recovery"],
      [".composebastion-source-upgrade-*", ".composebastion-source-upgrade-job.recovery"],
      [".composebastion-self-update-*", ".composebastion-self-update-job.recovery"]
    ];
    const dockerIgnore = await readFile(path.join(repositoryRoot, ".dockerignore"), "utf8");
    for (const [pattern, representative] of exclusions) {
      await expect(execFileAsync("git", ["check-ignore", "--no-index", "--quiet", representative], {
        cwd: repositoryRoot
      })).resolves.toBeTruthy();
      expect(dockerIgnore.split(/\r?\n/)).toContain(pattern);
    }
  });
});
