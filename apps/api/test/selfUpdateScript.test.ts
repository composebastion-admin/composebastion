import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildSelfUpdateLockLaunchScript, buildSelfUpdateScript } from "../src/services/selfUpdate.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "composebastion-self-update-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const mockDocker = `#!/bin/sh
set -u
printf '%s\\n' "$*" >> "$MOCK_STATE_DIR/commands.log"
phase="$(cat "$MOCK_STATE_DIR/phase")"
if [ "$1" = "compose" ]; then
  case " $* " in
    *" ps -q app "*) printf '%s\\n' app-container; exit 0 ;;
    *" ps -q worker "*) printf '%s\\n' worker-container; exit 0 ;;
    *" pull app worker "*)
      if [ "$MOCK_FAIL" = "pull" ]; then exit 1; fi
      exit 0
      ;;
    *" config --format json "*)
      printf '%s\n' '{"services":{"app":{"environment":{"DATABASE_URL":"postgres://composebastion:managed@postgres:5432/composebastion"}},"worker":{"environment":{"DATABASE_URL":"postgres://composebastion:managed@postgres:5432/composebastion"}},"postgres":{"environment":{"POSTGRES_PASSWORD":"managed"}}}}'
      exit 0
      ;;
    *" config "*)
      printf '%s\n' 'services:' '  app:' '    image: candidate-app:latest' '  worker:' '    image: candidate-worker:latest'
      exit 0
      ;;
    *" stop app worker "*) exit 0 ;;
    *"prepare-compose-upgrade.mjs"*)
      case " $* " in *"candidate.yml"*) ;; *) exit 93 ;; esac
      state_mount="$(printf '%s\n' "$*" | sed -n 's#.*--volume \\([^ ]*\\):/run/composebastion-upgrade .*#\\1#p')"
      case " $* " in
        *"prepare-compose-upgrade.mjs"*"reconcile"*)
          if [ "$MOCK_FAIL" = "prepare" ]; then exit 1; fi
          if [ "$MOCK_CREDENTIAL_CHANGED" = "true" ]; then
            printf '%s\n' '{"schema":1,"transition":"legacy-managed-database-credential","status":"reconciled","changed":true}' > "$state_mount/database-transition.json"
            printf '%s\n' 'COMPOSEBASTION_DATABASE_CREDENTIAL_TRANSITION=changed'
          else
            printf '%s\n' '{"schema":1,"transition":"legacy-managed-database-credential","status":"unchanged","changed":false}' > "$state_mount/database-transition.json"
            printf '%s\n' 'COMPOSEBASTION_DATABASE_CREDENTIAL_TRANSITION=unchanged'
          fi
          printf '%s\n' "COMPOSEBASTION_DATABASE_ENVIRONMENT_ACTION=$MOCK_ENVIRONMENT_ACTION"
          exit 0
          ;;
        *"prepare-compose-upgrade.mjs"*"restore-legacy"*)
          : > "$MOCK_STATE_DIR/credential-restored"
          if [ "$MOCK_RESTORE_FAIL" = "true" ]; then exit 1; fi
          exit 0
          ;;
      esac
      ;;
    *" up -d "*" app worker "*)
      candidate_path="$(printf '%s\\n' "$*" | sed -n 's/.*-f \\([^ ]*candidate\\.yml\\).*/\\1/p')"
      if [ -n "$candidate_path" ]; then cp "$candidate_path" "$MOCK_STATE_DIR/candidate.yml"; fi
      case " $* " in
        *".rollback.yml"*)
          cp "$(printf '%s\\n' "$*" | sed -n 's/.*-f \\([^ ]*\\.rollback\\.yml\\).*/\\1/p')" "$MOCK_STATE_DIR/rollback.yml"
          printf '%s\\n' old > "$MOCK_STATE_DIR/phase"
          exit 0
          ;;
      esac
      if [ "$MOCK_FAIL" = "up" ] && [ ! -f "$MOCK_STATE_DIR/up-failed" ]; then
        : > "$MOCK_STATE_DIR/up-failed"
        printf '%s\\n' new > "$MOCK_STATE_DIR/phase"
        exit 1
      fi
      printf '%s\\n' new > "$MOCK_STATE_DIR/phase"
      exit 0
      ;;
    *" exec -T app node "*)
      if [ "$phase" = "new" ] && [ "$MOCK_FAIL" = "finalization_interrupt" ]; then
        kill -TERM "$PPID"
        sleep 1
        exit 1
      fi
      case " $* " in
        *'worker?.state!=="draining"'*)
          # Handoff / candidate_handoff probes accept a draining worker.
          exit 0
          ;;
        *'ready.checks?.worker?.ok'*)
          # Full readiness requires worker.ok, which cannot pass before outcome publication.
          exit 1
          ;;
      esac
      exit 0 ;;
    *" exec -T worker node "*)
      if [ "$phase" = "new" ] && [ "$MOCK_FAIL" = "worker_marker" ]; then exit 1; fi
      exit 0 ;;
  esac
fi
if [ "$1" = "inspect" ]; then
  format="$3"
  container="$4"
  phase="$(cat "$MOCK_STATE_DIR/phase")"
  printf 'inspect-state=%s container=%s format=%s\\n' "$phase" "$container" "$format" >> "$MOCK_STATE_DIR/commands.log"
  case "$format" in
    *".State.Running"*) printf '%s\\n' true ;;
    *".State.Health.Status"*)
      if [ "$phase" = "new" ] && [ "$MOCK_FAIL" = "verification" ]; then printf '%s\\n' unhealthy; else printf '%s\\n' healthy; fi
      ;;
    *"org.opencontainers.image.title"*) printf '%s\\n' ComposeBastion ;;
    *"org.opencontainers.image.source"*) printf '%s\\n' https://github.com/composebastion-admin/composebastion ;;
    *"org.opencontainers.image.version"*)
      if [ "$phase" = "old" ]; then printf '%s\\n' 1.0.1; else printf '%s\\n' 1.0.2; fi
      ;;
    *"{{.Config.Image}}"*) printf '%s\\n' ghcr.io/composebastion-admin/composebastion-app:latest ;;
    *"{{.Image}}"*)
      if [ "$phase" = "old" ]; then
        printf '%s\\n' sha256:aaaaaaaa
      else
        printf '%s\\n' sha256:cccccccc
      fi
      ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then printf '%s\n' sha256:cccccccc; exit 0; fi
if [ "$1" = "image" ] && [ "$2" = "tag" ]; then exit 0; fi
exit 1
`;

async function runGeneratedUpdate(
  failure: "" | "pull" | "prepare" | "up" | "verification" | "worker_marker" | "finalization_interrupt",
  targetVersion = "1.0.2",
  credentialChanged = false,
  restoreFails = false,
  environmentAction: "canonicalize" | "preserve" = credentialChanged ? "canonicalize" : "preserve",
  blockOutcomePublication = false
) {
  const directory = await temporaryDirectory();
  const stateDirectory = path.join(directory, "state");
  const lockPath = path.join(directory, "manager.lock");
  const scriptPath = path.join(directory, "update.sh");
  const outcomePath = path.join(directory, "outcome");
  const gatePath = path.join(directory, "gate");
  const envBackupPath = path.join(directory, "env.backup");
  const rollbackComposePath = path.join(directory, ".composebastion-self-update-shell-job.rollback.yml");
  const dockerPath = path.join(directory, "docker-mock");
  const composePath = "compose.yml";
  const originalEnvironment = "COMPOSEBASTION_VERSION=latest\nAPP_SECRET=do-not-log-or-lose\n";

  await mkdir(stateDirectory);
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "job"), "shell-job\n");
  await writeFile(path.join(lockPath, "script"), `${scriptPath}\n`);
  await writeFile(path.join(directory, composePath), "services: {}\n");
  await writeFile(path.join(directory, ".env"), originalEnvironment);
  await writeFile(path.join(stateDirectory, "phase"), "old\n");
  await writeFile(gatePath, "");
  await writeFile(dockerPath, mockDocker);
  await chmod(dockerPath, 0o700);
  await writeFile(scriptPath, `${buildSelfUpdateScript({
    workingDir: directory,
    composeFile: composePath,
    versionMode: targetVersion === "latest" ? "latest" : "pinned",
    targetVersion
  }, "/var/run/docker.sock", {
    jobId: "shell-job",
    lockPath,
    outcomePath,
    gatePath,
    envBackupPath,
    rollbackComposePath
  })}\n`);
  await chmod(scriptPath, 0o700);
  if (blockOutcomePublication) await mkdir(outcomePath);

  let exitCode = 0;
  let stderr = "";
  try {
    await execFileAsync("/bin/sh", [
      "-c",
      "printf '%s\\n' \"$$\" > \"$1/owner\"; exec \"$2\"",
      "self-update-wrapper",
      lockPath,
      scriptPath
    ], {
      env: {
        ...process.env,
        COMPOSEBASTION_SELF_UPDATE_DOCKER_BIN: dockerPath,
        COMPOSEBASTION_SELF_UPDATE_VERIFY_ATTEMPTS: "1",
        COMPOSEBASTION_SELF_UPDATE_VERIFY_INTERVAL_SECONDS: "0",
        COMPOSEBASTION_SELF_UPDATE_GATE_ATTEMPTS: "1",
        MOCK_STATE_DIR: stateDirectory,
        MOCK_FAIL: failure,
        MOCK_CREDENTIAL_CHANGED: String(credentialChanged),
        MOCK_ENVIRONMENT_ACTION: environmentAction,
        MOCK_RESTORE_FAIL: String(restoreFails)
      }
    });
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    exitCode = Number(failure.code ?? 1);
    stderr = failure.stderr ?? "";
  }

  return {
    directory,
    stateDirectory,
    lockPath,
    outcome: await readFile(outcomePath, "utf8").catch(() => ""),
    environment: await readFile(path.join(directory, ".env"), "utf8"),
    originalEnvironment,
    commands: await readFile(path.join(stateDirectory, "commands.log"), "utf8"),
    candidate: await readFile(path.join(stateDirectory, "candidate.yml"), "utf8").catch(() => ""),
    rollback: await readFile(path.join(stateDirectory, "rollback.yml"), "utf8").catch(() => ""),
    rollbackComposePath,
    envBackupPath,
    upgradeStateDirectory: path.join(directory, ".composebastion-self-update-shell-job.upgrade"),
    script: await readFile(scriptPath, "utf8"),
    stderr,
    exitCode
  };
}

describe("generated self-update shell program", () => {
  it("updates and verifies app plus worker before reporting success", async () => {
    const result = await runGeneratedUpdate("");

    expect(result.exitCode).toBe(0);
    expect(result.outcome).toContain("status=passed\nstage=complete\nrollback=not_required");
    expect(result.script).toContain("candidate_handoff");
    expect(result.environment).toContain("COMPOSEBASTION_VERSION=1.0.2");
    expect(result.environment).toContain("APP_SECRET=do-not-log-or-lose");
    expect(result.commands).toContain("prepare-compose-upgrade.mjs reconcile");
    expect(result.commands).toContain("candidate.yml run --rm --no-deps --user 0:0");
    expect(result.commands).toContain("up -d --pull never --no-deps --force-recreate app worker");
    expect(result.candidate).toContain("POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}");
    expect(result.script.lastIndexOf("if ! write_outcome passed complete not_required 0")).toBeLessThan(
      result.script.lastIndexOf("trap - HUP INT TERM")
    );
    expect(result.script.lastIndexOf("trap - HUP INT TERM")).toBeLessThan(
      result.script.lastIndexOf("success_cleanup_failed=0")
    );
    await expect(stat(result.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["prepare", "up", "verification"] as const)("restores the exact environment and immutable prior images after %s failure", async (failure) => {
    const result = await runGeneratedUpdate(failure, "latest");

    expect(result.exitCode).toBe(1);
    expect(result.outcome).toContain(`status=failed\nstage=${failure}\nrollback=succeeded`);
    expect(result.environment).toBe(result.originalEnvironment);
    expect(result.rollback).toContain("image: sha256:aaaaaaaa");
    expect(result.rollback.match(/image: sha256:aaaaaaaa/g)).toHaveLength(2);
    expect(result.rollback).toContain("pull_policy: never");
    expect(result.commands).toContain("image tag sha256:aaaaaaaa ghcr.io/composebastion-admin/composebastion-app:latest");
    expect(result.commands).toContain("-f");
    expect(result.commands).toContain(".rollback.yml up -d --pull never --no-deps --force-recreate app worker");
    expect(await readFile(path.join(result.stateDirectory, "phase"), "utf8")).toBe("old\n");
  });

  it("rejects a candidate whose worker never publishes container-local readiness", async () => {
    const result = await runGeneratedUpdate("worker_marker");

    expect(result.exitCode).toBe(1);
    expect(result.outcome).toContain("status=failed\nstage=verification\nrollback=succeeded");
    expect(result.commands).toContain("exec -T worker node -e");
    expect(result.commands).toContain("/tmp/composebastion-worker-ready.json");
    expect(await readFile(path.join(result.stateDirectory, "phase"), "utf8")).toBe("old\n");
  });

  it("restores a recorded legacy credential before recreating prior images", async () => {
    const result = await runGeneratedUpdate("up", "latest", true);

    expect(result.exitCode).toBe(1);
    expect(result.outcome).toContain("rollback=succeeded");
    expect(result.commands).toContain("prepare-compose-upgrade.mjs restore-legacy");
    await expect(stat(path.join(result.stateDirectory, "credential-restored"))).resolves.toBeTruthy();
  });

  it("persists the canonical DATABASE_URL selection after a managed credential transition", async () => {
    const result = await runGeneratedUpdate("", "1.0.2", true);

    expect(result.exitCode).toBe(0);
    expect(result.environment).toContain("# ComposeBastion managed legacy database transition\nDATABASE_URL=\n");
    expect(result.environment).toContain("APP_SECRET=do-not-log-or-lose");
  });

  it("canonicalizes a stale environment even when the credential was already current", async () => {
    const result = await runGeneratedUpdate("", "1.0.2", false, false, "canonicalize");

    expect(result.exitCode).toBe(0);
    expect(result.environment).toContain("# ComposeBastion managed legacy database transition\nDATABASE_URL=\n");
  });

  it("retains protected recovery artifacts when credential rollback cannot finish", async () => {
    const result = await runGeneratedUpdate("up", "latest", true, true);

    expect(result.exitCode).toBe(1);
    expect(result.outcome).toContain("rollback=failed");
    await expect(stat(result.rollbackComposePath)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(stat(result.envBackupPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(stat(path.join(result.upgradeStateDirectory, "database-transition.json"))).resolves.toBeTruthy();
    expect((await stat(result.rollbackComposePath)).mode & 0o077).toBe(0);
    expect((await stat(result.envBackupPath)).mode & 0o077).toBe(0);
  });

  it("restores the environment without recreating healthy services when pull fails", async () => {
    const result = await runGeneratedUpdate("pull", "latest");

    expect(result.exitCode).toBe(1);
    expect(result.outcome).toContain("stage=pull\nrollback=succeeded");
    expect(result.environment).toBe(result.originalEnvironment);
    expect(result.commands).not.toContain(".rollback.yml up -d");
  });

  it("rolls back and retains recovery inputs when the success outcome cannot be published", async () => {
    const result = await runGeneratedUpdate("", "1.0.2", true, false, "canonicalize", true);

    expect(result.exitCode).toBe(1);
    expect(result.outcome).toBe("");
    expect(result.environment).toBe(result.originalEnvironment);
    expect(await readFile(path.join(result.stateDirectory, "phase"), "utf8")).toBe("old\n");
    await expect(stat(result.rollbackComposePath)).resolves.toBeTruthy();
    await expect(stat(result.envBackupPath)).resolves.toBeTruthy();
    await expect(stat(path.join(result.upgradeStateDirectory, "database-transition.json"))).resolves.toBeTruthy();
    expect(result.stderr).toContain("authoritative failure outcome");
  });

  it("uses the armed interruption trap to roll back during final verification", async () => {
    const result = await runGeneratedUpdate("finalization_interrupt", "1.0.2", true);

    expect(result.exitCode).toBe(130);
    expect(result.outcome).toContain("status=failed\nstage=interrupted\nrollback=succeeded");
    expect(result.environment).toBe(result.originalEnvironment);
    expect(await readFile(path.join(result.stateDirectory, "phase"), "utf8")).toBe("old\n");
  });
});

async function runLaunchScript(script: string) {
  try {
    return { ...(await execFileAsync("/bin/sh", ["-c", script])), code: 0 };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: Number(failure.code ?? 1), stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("manager-host self-update lock", () => {
  async function launchFixture() {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, "global.lock");
    const scriptPath = path.join(directory, "job.sh");
    const logPath = path.join(directory, "job.log");
    await writeFile(scriptPath, "#!/bin/sh\nsleep 30\n");
    await chmod(scriptPath, 0o700);
    return {
      directory,
      lockPath,
      scriptPath,
      launch: buildSelfUpdateLockLaunchScript({ jobId: "new-job", scriptPath, logPath, lockPath })
    };
  }

  it("refuses a recent metadata-less lock but reclaims it after the safety age", async () => {
    const fixture = await launchFixture();
    await mkdir(fixture.lockPath);

    const recent = await runLaunchScript(fixture.launch);
    expect(recent.code).toBe(75);
    expect(recent.stderr).toContain("recent self-update lock");

    const old = new Date(Date.now() - 180_000);
    await utimes(fixture.lockPath, old, old);
    const reclaimed = await runLaunchScript(fixture.launch);
    expect(reclaimed.code).toBe(0);
    process.kill(Number(reclaimed.stdout.trim()), "SIGTERM");
  });

  it.skipIf(process.platform !== "linux")("reclaims an aged lock whose live PID belongs to an unrelated process", async () => {
    const fixture = await launchFixture();
    await mkdir(fixture.lockPath);
    await writeFile(path.join(fixture.lockPath, "owner"), `${process.pid}\n`);
    await writeFile(path.join(fixture.lockPath, "job"), "old-job\n");
    await writeFile(path.join(fixture.lockPath, "script"), "/tmp/not-the-running-command.sh\n");
    const old = new Date(Date.now() - 180_000);
    await utimes(fixture.lockPath, old, old);

    const reclaimed = await runLaunchScript(fixture.launch);

    expect(reclaimed.code).toBe(0);
    process.kill(Number(reclaimed.stdout.trim()), "SIGTERM");
  });
});
