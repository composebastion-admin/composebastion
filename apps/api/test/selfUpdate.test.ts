import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getHostForWorker = vi.fn();
const runSshCommand = vi.fn();
const writeRemoteFile = vi.fn();
const query = vi.fn();
const enqueueJob = vi.fn();

vi.mock("../src/services/hosts.js", () => ({
  getHost: vi.fn(),
  getHostForWorker: (...args: unknown[]) => getHostForWorker(...args)
}));

vi.mock("../src/services/ssh.js", () => ({
  runSshCommand: (...args: unknown[]) => runSshCommand(...args),
  writeRemoteFile: (...args: unknown[]) => writeRemoteFile(...args)
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args)
}));

vi.mock("../src/services/redis.js", () => ({
  createRedis: () => null
}));

vi.mock("../src/services/jobs.js", () => ({
  buildJobProgress: (...args: unknown[]) => [{ id: "reconnect", args }],
  enqueueJob: (...args: unknown[]) => enqueueJob(...args)
}));

const hostId = "11111111-1111-4111-8111-111111111111";

function sshHost(mode: "ssh" | "agent" = "ssh") {
  return {
    public: { dockerSocketPath: "/var/run/docker.sock" },
    connectionMode: mode,
    ssh: { hostname: "vm.local", port: 22, username: "docker" },
    agent: mode === "agent" ? { url: "http://vm.local:8090", token: "token" } : null
  };
}

describe("self update service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueJob.mockReset();
    getHostForWorker.mockResolvedValue(sshHost());
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "4242\n", stderr: "" });
    writeRemoteFile.mockResolvedValue(undefined);
  });

  it("creates the detached updater log privately and refuses an existing symlink", async () => {
    const { buildBridgeSelfUpdateLaunchScript } = await import("../src/services/selfUpdate.js");
    const directory = mkdtempSync(join(tmpdir(), "composebastion-bridge-launch-"));

    try {
      const scriptPath = join(directory, "update.sh");
      const logPath = join(directory, "update.log");
      const lockPath = join(directory, "update.lock");
      writeFileSync(scriptPath, "#!/bin/sh\nprintf '%s\\n' secure-log\n", { mode: 0o700 });
      chmodSync(scriptPath, 0o700);

      const launch = buildBridgeSelfUpdateLaunchScript({
        jobId: "secure-log",
        scriptPath,
        logPath,
        lockPath
      });
      execFileSync("/bin/sh", ["-c", launch], { cwd: directory, stdio: "pipe" });

      let logContents = "";
      for (let attempt = 0; attempt < 200; attempt += 1) {
        logContents = readFileSync(logPath, "utf8");
        if (logContents.includes("secure-log")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(logContents).toContain("secure-log");
      expect(statSync(logPath).mode & 0o777).toBe(0o600);

      const symlinkLogPath = join(directory, "symlink.log");
      const externalPath = join(directory, "external.txt");
      const symlinkLockPath = join(directory, "symlink.lock");
      writeFileSync(externalPath, "unchanged\n", { mode: 0o600 });
      symlinkSync(externalPath, symlinkLogPath);
      const symlinkLaunch = buildBridgeSelfUpdateLaunchScript({
        jobId: "symlink-log",
        scriptPath,
        logPath: symlinkLogPath,
        lockPath: symlinkLockPath
      });

      expect(() => execFileSync("/bin/sh", ["-c", symlinkLaunch], { cwd: directory, stdio: "pipe" })).toThrow();
      expect(readFileSync(externalPath, "utf8")).toBe("unchanged\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes and starts a detached host-side self-update script", async () => {
    const { runSelfUpdate } = await import("../src/services/selfUpdate.js");

    const result = await runSelfUpdate(hostId, {
      workingDir: "/srv/composebastion",
      composeFile: "docker-compose.image.yml",
      versionMode: "pinned",
      targetVersion: "1.0.2"
    }, { jobId: "test-job" });

    expect(result).toMatchObject({
      handoffStarted: true,
      handoffPending: true,
      pid: "4242",
      targetVersion: "1.0.2",
      logPath: "/srv/composebastion/.composebastion-self-update-test-job.log",
      outcomePath: "/srv/composebastion/.composebastion-self-update-test-job.outcome",
      gatePath: "/srv/composebastion/.composebastion-self-update-test-job.gate"
    });
    expect(writeRemoteFile).toHaveBeenCalledWith(
      expect.anything(),
      "/srv/composebastion/.composebastion-self-update-test-job.sh",
      expect.stringContaining("TARGET_VERSION='1.0.2'")
    );
    const script = String(writeRemoteFile.mock.calls[0]?.[2] ?? "");
    expect(script).toContain("prepare-compose-upgrade.mjs");
    expect(script).toContain("--pull never --no-deps --force-recreate app worker");
    expect(script).toContain("COMPOSEBASTION_DATABASE_CREDENTIAL_TRANSITION");
    expect(script).toContain("COMPOSEBASTION_DATABASE_ENVIRONMENT_ACTION");
    expect(script).toContain("COMPOSEBASTION_UPGRADE_SOURCE_DATABASE_URL: \\${DATABASE_URL-}");
    expect(String(runSshCommand.mock.calls[1]?.[1])).toContain(".composebastion-self-update-test-job.sh");
    expect(String(runSshCommand.mock.calls[1]?.[1])).toContain("umask 077");
    expect(String(runSshCommand.mock.calls[1]?.[1])).toContain('exec 3> "$LOG_PATH"');
    expect(String(runSshCommand.mock.calls[1]?.[1])).toContain('nohup "$SCRIPT_PATH" >&3 2>&1');
  });

  it("requires SSH mode for the detached self-update handoff", async () => {
    getHostForWorker.mockResolvedValueOnce(sshHost("agent"));
    const { runSelfUpdate } = await import("../src/services/selfUpdate.js");

    await expect(runSelfUpdate(hostId, {
      workingDir: "/srv/composebastion",
      composeFile: "docker-compose.image.yml",
      versionMode: "latest",
      targetVersion: "latest"
    })).rejects.toThrow("requires the manager host to use SSH mode");
  });

  it("rejects non-semver start overrides even while following latest", async () => {
    query.mockResolvedValueOnce({
      rows: [{
        value: {
          hostId,
          workingDir: "/srv/composebastion",
          composeFile: "docker-compose.image.yml",
          versionMode: "latest",
          targetVersion: "latest"
        }
      }]
    });
    const { enqueueSelfUpdate } = await import("../src/services/selfUpdate.js");

    await expect(enqueueSelfUpdate({ targetVersion: "nightly" }, "user-1"))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("compares semantic versions without treating older releases as updates", async () => {
    const { compareVersions, updateAvailable } = await import("../src/services/selfUpdate.js");

    expect(compareVersions("1.0.4", "1.0.0")).toBe(1);
    expect(compareVersions("v1.0.0", "v1.0.2")).toBe(-1);
    expect(compareVersions("1.0.4-beta.1", "1.0.4")).toBe(-1);
    expect(updateAvailable("1.0.2", "1.0.0")).toBe(false);
    expect(updateAvailable("1.0.2", "1.0.4")).toBe(true);
  });

  it("strictly parses authoritative bridge outcomes", async () => {
    const { parseBridgeSelfUpdateOutcome } = await import("../src/services/selfUpdate.js");
    const outcome = parseBridgeSelfUpdateOutcome([
      "schema=1",
      "job_id=test-job",
      "status=failed",
      "stage=verification",
      "rollback=succeeded",
      "target_version=1.2.0",
      "exit_code=1",
      ""
    ].join("\n"), "test-job", "1.2.0");

    expect(outcome).toMatchObject({ status: "failed", stage: "verification", rollback: "succeeded" });
    expect(() => parseBridgeSelfUpdateOutcome("schema=1\n", "test-job", "1.2.0")).toThrow("unexpected schema");
  });

  it.each([
    ["passed", "completed"],
    ["failed", "failed"]
  ] as const)("reconciles a %s updater outcome to a truthful API job", async (outcomeStatus, apiStatus) => {
    const targetVersion = "1.2.0";
    const outcome = [
      "schema=1",
      "job_id=test-job",
      `status=${outcomeStatus}`,
      `stage=${outcomeStatus === "passed" ? "complete" : "verification"}`,
      `rollback=${outcomeStatus === "passed" ? "not_required" : "succeeded"}`,
      `target_version=${targetVersion}`,
      `exit_code=${outcomeStatus === "passed" ? "0" : "1"}`,
      ""
    ].join("\n");
    query
      .mockResolvedValueOnce({ rows: [{
        id: "test-job",
        type: "system.self_update",
        host_id: hostId,
        payload: {
          workingDir: "/srv/composebastion",
          composeFile: "docker-compose.image.yml",
          versionMode: "pinned",
          targetVersion
        },
        result: { handoffPending: true, handedOffAt: new Date().toISOString() },
        created_at: new Date(),
        updated_at: new Date()
      }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "test-job" }] });
    runSshCommand.mockReset().mockResolvedValueOnce({ code: 0, stdout: outcome, stderr: "" });
    const { reconcileBridgeSelfUpdateHandoffs } = await import("../src/services/selfUpdate.js");

    const result = await reconcileBridgeSelfUpdateHandoffs();

    expect(result).toEqual({ completed: apiStatus === "completed" ? 1 : 0, failed: apiStatus === "failed" ? 1 : 0, pending: 0 });
    expect(String(query.mock.calls.at(-1)?.[0])).toContain("SET status = $2");
    expect(query.mock.calls.at(-1)?.[1]?.[1]).toBe(apiStatus);
  });

  it("uses the newest semver tag when GitHub latest release is stale", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/tags")) {
        return new Response(JSON.stringify([{ name: "v1.0.4" }, { name: "v1.0.3" }, { name: "v1.0.0" }]), { status: 200 });
      }
      if (url.includes("/releases")) {
        return new Response(JSON.stringify([{ tag_name: "v1.0.0", html_url: "https://example.test/v1.0.0", draft: false }]), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    query.mockResolvedValue({ rows: [] });
    const { checkSelfUpdateLatest } = await import("../src/services/selfUpdate.js");

    const latest = await checkSelfUpdateLatest();

    expect(latest.version).toBe("1.0.4");
    fetchSpy.mockRestore();
  });
});
