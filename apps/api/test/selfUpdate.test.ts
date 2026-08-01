import { beforeEach, describe, expect, it, vi } from "vitest";

const getHostForWorker = vi.fn();
const getHost = vi.fn();
const runSshCommand = vi.fn();
const writeRemoteFile = vi.fn();
const query = vi.fn();
const withTransaction = vi.fn();
const enqueueJob = vi.fn();
const enqueueJobInTransaction = vi.fn();
const notifyJobQueued = vi.fn();

vi.mock("../src/services/hosts.js", () => ({
  getHost: (...args: unknown[]) => getHost(...args),
  getHostForWorker: (...args: unknown[]) => getHostForWorker(...args)
}));

vi.mock("../src/services/ssh.js", () => ({
  runSshCommand: (...args: unknown[]) => runSshCommand(...args),
  writeRemoteFile: (...args: unknown[]) => writeRemoteFile(...args)
}));

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: (...args: unknown[]) => withTransaction(...args)
}));

vi.mock("../src/services/redis.js", () => ({
  createRedis: () => null
}));

vi.mock("../src/services/jobs.js", () => ({
  buildJobProgress: (type: string, phase: string) => [{ id: "reconnect", label: "Reconnect", status: phase === "completed" ? "completed" : phase === "failed" ? "failed" : "running" }],
  enqueueJob: (...args: unknown[]) => enqueueJob(...args),
  enqueueJobInTransaction: (...args: unknown[]) => enqueueJobInTransaction(...args),
  notifyJobQueued: (...args: unknown[]) => notifyJobQueued(...args)
}));

const hostId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

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
    enqueueJobInTransaction.mockReset();
    notifyJobQueued.mockReset();
    withTransaction.mockReset();
    query.mockReset();
    getHost.mockReset();
    getHostForWorker.mockResolvedValue(sshHost());
    getHost.mockResolvedValue(sshHost());
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "4242\n", stderr: "" });
    writeRemoteFile.mockResolvedValue(undefined);
    withTransaction.mockImplementation(async (callback: (client: unknown) => Promise<unknown>) => (
      callback({ query })
    ));
    notifyJobQueued.mockResolvedValue(undefined);
  });

  it("writes and starts a detached host-side self-update script", async () => {
    const { runSelfUpdate } = await import("../src/services/selfUpdate.js");

    const result = await runSelfUpdate(hostId, {
      workingDir: "/srv/composebastion",
      composeFile: "docker-compose.image.yml",
      versionMode: "pinned",
      targetVersion: "1.0.2"
    }, { jobId });

    expect(result).toMatchObject({
      handoffStarted: true,
      handoffPending: true,
      pid: "4242",
      targetVersion: "1.0.2",
      scriptPath: `/srv/composebastion/.composebastion-self-update-${jobId}.sh`,
      logPath: `/srv/composebastion/.composebastion-self-update-${jobId}.log`,
      outcomePath: `/srv/composebastion/.composebastion-self-update-${jobId}.outcome`,
      gatePath: `/srv/composebastion/.composebastion-self-update-${jobId}.gate`,
      lockPath: "/tmp/composebastion-self-update.lock"
    });
    expect(writeRemoteFile).toHaveBeenCalledWith(
      expect.anything(),
      `/srv/composebastion/.composebastion-self-update-${jobId}.sh`,
      expect.stringContaining("COMPOSEBASTION_VERSION=1.0.2")
    );
    const script = String(writeRemoteFile.mock.calls[0]?.[2] ?? "");
    expect(script).toContain('"$DOCKER_BIN" compose -f "$COMPOSE_FILE" pull app worker');
    expect(script).toContain("prepare-compose-upgrade.mjs \"$preparation_mode\"");
    expect(script).toContain('"$DOCKER_BIN" compose -f "$COMPOSE_FILE" stop app worker');
    expect(script).toContain('up -d --pull never --no-deps --force-recreate app worker');
    expect(script).toContain('wait_for_stack "$TARGET_VERSION" "$TARGET_VERSION" "$CANDIDATE_APP_IMAGE_ID" "$CANDIDATE_WORKER_IMAGE_ID"');
    expect(script).toContain("restore-legacy");
    expect(script).toContain("PREVIOUS_APP_IMAGE_ID");
    expect(script).toContain("pull_policy: never");
    expect(script).toContain("POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}");
    const preflight = String(runSshCommand.mock.calls[0]?.[1]);
    expect(preflight).toContain("readlink -f");
    expect(preflight).toContain("grep -Fx app");
    expect(preflight).toContain("apps/api/dist/worker.js");
    expect(preflight).toContain("org.opencontainers.image.source");
    const launch = String(runSshCommand.mock.calls[1]?.[1]);
    expect(launch).toContain('LOCK_PATH=\'/tmp/composebastion-self-update.lock\'');
    expect(launch).toContain("kill -0");
    expect(launch).toContain("/proc/$existing_owner/cmdline");
    expect(launch).toContain(`nohup '/srv/composebastion/.composebastion-self-update-${jobId}.sh'`);
  });

  it("confirms a persisted handoff through its job-specific gate", async () => {
    runSshCommand.mockReset().mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const { confirmSelfUpdateHandoff } = await import("../src/services/selfUpdate.js");
    const gatePath = `/srv/composebastion/.composebastion-self-update-${jobId}.gate`;

    await confirmSelfUpdateHandoff(hostId, {
      handoffStarted: true,
      handoffPending: true,
      pid: "4242",
      targetVersion: "1.0.2",
      workingDir: "/srv/composebastion",
      composeFile: "docker-compose.image.yml",
      scriptPath: `/srv/composebastion/.composebastion-self-update-${jobId}.sh`,
      logPath: `/srv/composebastion/.composebastion-self-update-${jobId}.log`,
      outcomePath: `/srv/composebastion/.composebastion-self-update-${jobId}.outcome`,
      gatePath,
      lockPath: "/tmp/composebastion-self-update.lock",
      handedOffAt: new Date().toISOString()
    });

    expect(runSshCommand.mock.calls[0]?.[1]).toContain(`: > '${gatePath}'`);
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

  it("runs self-update configuration persistence and audit on one transaction client", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const auditFailure = new Error("audit insert failed");
    const onChanged = vi.fn(async (client: { query: typeof query }) => {
      expect(client.query).toBe(query);
      throw auditFailure;
    });
    const { saveSelfUpdateConfig } = await import("../src/services/selfUpdate.js");

    await expect(saveSelfUpdateConfig({
      workingDir: "/srv/composebastion",
      composeFile: "docker-compose.image.yml"
    }, onChanged)).rejects.toBe(auditFailure);

    expect(query.mock.calls[1]?.[0]).toContain("INSERT INTO system_settings");
    expect(onChanged).toHaveBeenCalledWith(
      expect.objectContaining({ query }),
      expect.objectContaining({ workingDir: "/srv/composebastion" })
    );
  });

  it("commits the self-update job and audit callback in one transaction", async () => {
    query.mockResolvedValueOnce({
      rows: [{
        value: {
          hostId,
          workingDir: "/srv/composebastion",
          composeFile: "docker-compose.image.yml",
          versionMode: "pinned",
          targetVersion: "1.2.0"
        }
      }]
    });
    enqueueJobInTransaction.mockResolvedValueOnce({ id: jobId, hostId });
    const onQueued = vi.fn(async () => undefined);
    const { enqueueSelfUpdate } = await import("../src/services/selfUpdate.js");

    await expect(enqueueSelfUpdate({ targetVersion: "1.2.0" }, "user-1", onQueued))
      .resolves.toMatchObject({ id: jobId, hostId });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(enqueueJobInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ query }),
      expect.objectContaining({
        type: "system.self_update",
        hostId,
        payload: expect.objectContaining({ targetVersion: "1.2.0" })
      }),
      "user-1"
    );
    expect(onQueued).toHaveBeenCalledWith(
      expect.objectContaining({ query }),
      expect.objectContaining({ id: jobId, hostId })
    );
    expect(notifyJobQueued).toHaveBeenCalledWith(jobId);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("does not publish a self-update job when its transactional audit callback fails", async () => {
    query.mockResolvedValueOnce({
      rows: [{
        value: {
          hostId,
          workingDir: "/srv/composebastion",
          composeFile: "docker-compose.image.yml",
          versionMode: "pinned",
          targetVersion: "1.2.0"
        }
      }]
    });
    enqueueJobInTransaction.mockResolvedValueOnce({ id: jobId, hostId });
    const auditFailure = new Error("audit insert failed");
    const { enqueueSelfUpdate } = await import("../src/services/selfUpdate.js");

    await expect(enqueueSelfUpdate(
      { targetVersion: "1.2.0" },
      "user-1",
      async () => {
        throw auditFailure;
      }
    )).rejects.toBe(auditFailure);

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });

  it("compares semantic versions without treating older releases as updates", async () => {
    const { compareVersions, updateAvailable } = await import("../src/services/selfUpdate.js");

    expect(compareVersions("1.0.4", "1.0.0")).toBe(1);
    expect(compareVersions("v1.0.0", "v1.0.2")).toBe(-1);
    expect(compareVersions("1.0.4-beta.1", "1.0.4")).toBe(-1);
    expect(updateAvailable("1.0.2", "1.0.0")).toBe(false);
    expect(updateAvailable("1.0.2", "1.0.4")).toBe(true);
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

  function pendingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: jobId,
      type: "system.self_update",
      status: "running",
      host_id: hostId,
      payload: {
        workingDir: "/srv/composebastion",
        composeFile: "docker-compose.image.yml",
        versionMode: "pinned",
        targetVersion: "1.0.2"
      },
      result: {
        handoffPending: true,
        handedOffAt: new Date().toISOString()
      },
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides
    };
  }

  it.each([
    ["passed", "complete", "not_required", "0", "completed"],
    ["failed", "verification", "succeeded", "1", "failed"]
  ])("reconciles a strict %s authoritative outcome", async (status, stage, rollback, exitCode, terminalStatus) => {
    query
      .mockResolvedValueOnce({ rows: [pendingRow()] })
      .mockResolvedValueOnce({ rows: [{ id: jobId }], rowCount: 1 });
    runSshCommand.mockReset().mockResolvedValueOnce({
      code: 0,
      stderr: "",
      stdout: [
        "schema=1",
        `job_id=${jobId}`,
        `status=${status}`,
        `stage=${stage}`,
        `rollback=${rollback}`,
        "target_version=1.0.2",
        `exit_code=${exitCode}`,
        ""
      ].join("\n")
    });
    const { reconcileSelfUpdateHandoffs } = await import("../src/services/selfUpdate.js");

    const result = await reconcileSelfUpdateHandoffs();

    expect(result).toMatchObject(status === "passed" ? { completed: 1, failed: 0 } : { completed: 0, failed: 1 });
    expect(query.mock.calls[1]?.[1]?.[1]).toBe(terminalStatus);
    expect(query.mock.calls[1]?.[0]).toContain("result ->> 'handoffPending' = 'true'");
  });

  it("keeps an active detached updater nonterminal", async () => {
    query.mockResolvedValueOnce({ rows: [pendingRow()] });
    runSshCommand.mockReset()
      .mockResolvedValueOnce({ code: 44, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const { reconcileSelfUpdateHandoffs } = await import("../src/services/selfUpdate.js");

    await expect(reconcileSelfUpdateHandoffs()).resolves.toEqual({ completed: 0, failed: 0, pending: 1 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(runSshCommand.mock.calls[1]?.[1]).toContain("/proc/$owner/cmdline");
  });

  it("fails a malformed outcome immediately with a sanitized error", async () => {
    query
      .mockResolvedValueOnce({ rows: [pendingRow()] })
      .mockResolvedValueOnce({ rows: [{ id: jobId }], rowCount: 1 });
    runSshCommand.mockReset().mockResolvedValueOnce({
      code: 0,
      stdout: "schema=1\njob_id=wrong-job\nstatus=passed\nstage=complete\nrollback=not_required\ntarget_version=1.0.2\nexit_code=0\nSECRET=hidden\n",
      stderr: ""
    });
    const { reconcileSelfUpdateHandoffs } = await import("../src/services/selfUpdate.js");

    await expect(reconcileSelfUpdateHandoffs()).resolves.toEqual({ completed: 0, failed: 1, pending: 0 });
    expect(query.mock.calls[1]?.[1]?.[2]).toBe("Self-update wrote an invalid authoritative outcome.");
  });

  it("fails a timed-out handoff without retaining remote error text", async () => {
    query
      .mockResolvedValueOnce({
        rows: [pendingRow({ result: { handoffPending: true, handedOffAt: "2026-01-01T00:00:00.000Z" } })]
      })
      .mockResolvedValueOnce({ rows: [{ id: jobId }], rowCount: 1 });
    runSshCommand.mockReset().mockRejectedValueOnce(new Error("ssh user:secret unavailable"));
    const { reconcileSelfUpdateHandoffs } = await import("../src/services/selfUpdate.js");

    await expect(reconcileSelfUpdateHandoffs()).resolves.toEqual({ completed: 0, failed: 1, pending: 0 });
    expect(query.mock.calls[1]?.[1]?.[2]).toBe("Self-update outcome could not be reconciled before the handoff timeout.");
  });
});
