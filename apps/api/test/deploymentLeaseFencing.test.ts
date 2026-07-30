import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const getHostForWorker = vi.hoisted(() => vi.fn());
const listHostIds = vi.hoisted(() => vi.fn());
const statHostPath = vi.hoisted(() => vi.fn());
const executeDockerAction = vi.hoisted(() => vi.fn());
const runDocker = vi.hoisted(() => vi.fn());
const runSshCommand = vi.hoisted(() => vi.fn());
const readRemoteFile = vi.hoisted(() => vi.fn());
const writeRemoteFile = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction: (callback: (client: { query: typeof query }) => Promise<unknown>) => (
    callback({ query })
  )
}));

vi.mock("../src/services/crypto.js", () => ({
  decryptSecret: (value: string) => value.replace(/^encrypted:/, ""),
  encryptSecret: (value: string) => `encrypted:${value}`
}));

vi.mock("../src/services/docker.js", () => ({
  executeDockerAction,
  runDocker
}));

vi.mock("../src/services/files.js", () => ({
  statHostPath
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker,
  listHostIds
}));

vi.mock("../src/services/imageUpdates.js", () => ({
  findRegistryAuthForReference: vi.fn(async () => null)
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn()
}));

vi.mock("../src/services/ssh.js", () => ({
  readRemoteFile,
  runSshCommand,
  writeRemoteFile
}));

const {
  analyzeDeployment,
  configureRegistryTrust,
  executeDeployment,
  deploymentAnalysisInternals
} = await import("../src/services/deployments.js");
const {
  currentRemoteMutationContext
} = await import("../src/services/remoteMutationProof.js");

const hostId = "11111111-1111-4111-8111-111111111111";
const analysisId = "22222222-2222-4222-8222-222222222222";
const composeYaml = "services:\n  app:\n    build: .\n";

function analysisRow() {
  const timestamp = new Date("2026-07-30T10:00:00.000Z");
  return {
    id: analysisId,
    host_id: hostId,
    source_id: null,
    source_type: "compose_upload",
    source_input: composeYaml,
    source_locator: "inline-compose:test",
    status: "queued",
    display_name: null,
    project_name: "lease-test",
    branch: null,
    compose_path: "compose.yaml",
    working_dir: "/home/docker/composebastion/lease-test",
    compose_yaml: composeYaml,
    env_encrypted: null,
    credential_username: null,
    credential_secret_encrypted: null,
    staging_directory: null,
    summary: {
      services: [],
      composeCandidates: [],
      dockerfileGenerated: false,
      trackedEnvFile: false
    },
    variables: [],
    warnings: [],
    blockers: [],
    registry_issues: [],
    error: null,
    expires_at: new Date(Date.now() + 60_000),
    created_at: timestamp,
    updated_at: timestamp,
    deployed_at: null
  };
}

function leaseLost(jobId: string) {
  return Object.assign(new Error(`Job ${jobId} no longer has an active lease`), {
    code: "JOB_LEASE_LOST"
  });
}

describe("deployment lease fencing and attempt isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockReset();
    getHostForWorker.mockReset();
    listHostIds.mockReset();
    statHostPath.mockReset();
    executeDockerAction.mockReset();
    runDocker.mockReset();
    runSshCommand.mockReset();
    readRemoteFile.mockReset();
    writeRemoteFile.mockReset();

    getHostForWorker.mockResolvedValue({
      public: {
        id: hostId,
        name: "Manager",
        username: "docker",
        dockerSocketPath: "/var/run/docker.sock"
      },
      connectionMode: "ssh",
      ssh: { hostname: "docker.example.test", port: 22, username: "docker" },
      agent: null
    });
    runDocker.mockResolvedValue({ stdout: "", stderr: "" });
    runSshCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM compose_stacks")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
  });

  it("does not let an old analysis attempt overwrite the newer attempt's ready result", async () => {
    const state = analysisRow();
    const writes: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        if (sql.includes("SELECT * FROM deployment_analyses")) {
          return { rows: [{ ...state }], rowCount: 1 };
        }
        if (sql.includes("SET status = 'analyzing'")) {
          if (!["queued", "failed", "analyzing"].includes(state.status)) {
            return { rows: [], rowCount: 0 };
          }
          state.status = "analyzing";
          state.error = null;
          state.staging_directory = values[1] as null;
          writes.push("analyzing");
          return { rows: [{ ...state }], rowCount: 1 };
        }
        if (sql.includes("SET status = 'ready'")) {
          if (state.status !== "analyzing" || state.staging_directory !== values[9]) {
            return { rows: [], rowCount: 0 };
          }
          state.status = "ready";
          state.source_locator = values[1] as string;
          state.display_name = values[2] as string;
          state.project_name = values[3] as string;
          state.branch = values[4] as string | null;
          state.compose_path = values[5] as string;
          state.working_dir = values[6] as string;
          state.compose_yaml = values[7] as string;
          state.env_encrypted = values[8] as string | null;
          state.staging_directory = values[9] as string | null;
          state.summary = JSON.parse(String(values[10]));
          state.variables = JSON.parse(String(values[11]));
          state.warnings = JSON.parse(String(values[12]));
          state.blockers = JSON.parse(String(values[13]));
          state.registry_issues = JSON.parse(String(values[14]));
          writes.push("ready");
          return { rows: [{ ...state }], rowCount: 1 };
        }
        if (sql.includes("SET status = 'failed'")) {
          state.status = "failed";
          state.error = String(values[1]);
          writes.push("failed");
          return { rows: [{ ...state }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      })
    };

    let oldActive = true;
    let releaseOldStat!: () => void;
    let signalOldStatStarted!: () => void;
    const oldStatStarted = new Promise<void>((resolve) => {
      signalOldStatStarted = resolve;
    });
    const oldStat = new Promise<{ exists: false }>((resolve) => {
      releaseOldStat = () => resolve({ exists: false });
    });
    statHostPath
      .mockImplementationOnce(() => {
        signalOldStatStarted();
        return oldStat;
      })
      .mockResolvedValue({ exists: false });

    const oldFence = {
      assertActive: async () => {
        if (!oldActive) throw leaseLost("old-job");
      },
      withActiveLease: async <T>(callback: (leasedClient: typeof client) => Promise<T>) => {
        if (!oldActive) throw leaseLost("old-job");
        return callback(client);
      }
    };
    const newFence = {
      assertActive: async () => undefined,
      withActiveLease: async <T>(callback: (leasedClient: typeof client) => Promise<T>) => (
        callback(client)
      )
    };

    const oldAttempt = analyzeDeployment(
      analysisId,
      oldFence,
      { jobId: "old-job", attemptCount: 1 }
    );
    await oldStatStarted;

    oldActive = false;
    state.status = "failed";
    state.error = "WORKER_LOST: Worker lease expired during attempt 1";

    const newer = await analyzeDeployment(
      analysisId,
      newFence,
      { jobId: "new-job", attemptCount: 2 }
    );
    expect(newer.analysis.status).toBe("ready");

    releaseOldStat();
    await expect(oldAttempt).rejects.toMatchObject({ code: "JOB_LEASE_LOST" });

    expect(state.status).toBe("ready");
    expect(writes.filter((write) => write === "ready")).toHaveLength(1);
    expect(writes.at(-1)).toBe("ready");
  });

  it("uses distinct owner-marked checkout paths for separate Git analysis attempts", () => {
    const firstToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondToken = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const first = deploymentAnalysisInternals.deploymentAnalysisAttempt(
      "docker",
      analysisId,
      firstToken
    );
    const second = deploymentAnalysisInternals.deploymentAnalysisAttempt(
      "docker",
      analysisId,
      secondToken
    );

    expect(first.checkoutDirectory).not.toBe(second.checkoutDirectory);
    expect(first.checkoutDirectory).toContain(`/.analysis/${analysisId}/${firstToken}/checkout`);
    expect(second.checkoutDirectory).toContain(`/.analysis/${analysisId}/${secondToken}/checkout`);
    expect(first.ownerRecord).toBe(
      `composebastion-deployment-analysis-v1:${analysisId}:${firstToken}`
    );
    expect(
      deploymentAnalysisInternals.expectedDeploymentAnalysisAttempt(
        "docker",
        analysisId,
        first.checkoutDirectory
      )
    ).toEqual(first);
  });

  it("does not launch Git staging cleanup after the analysis lease is lost", async () => {
    const state = {
      ...analysisRow(),
      source_type: "git",
      source_input: "https://github.com/example/app.git",
      source_locator: "https://github.com/example/app.git",
      staging_directory: null
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT * FROM deployment_analyses")) {
          return { rows: [{ ...state }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      })
    };
    let leaseTransactions = 0;
    const fence = {
      assertActive: async () => undefined,
      withActiveLease: async <T>(
        callback: (leasedClient: typeof client) => Promise<T>
      ) => {
        leaseTransactions += 1;
        if (leaseTransactions === 2) throw leaseLost("analysis-cleanup-job");
        return callback(client);
      }
    };

    await expect(analyzeDeployment(
      analysisId,
      fence,
      { jobId: "analysis-cleanup-job", attemptCount: 1 }
    )).rejects.toMatchObject({ code: "JOB_LEASE_LOST" });
    expect(runSshCommand).not.toHaveBeenCalled();
    expect(writeRemoteFile).not.toHaveBeenCalled();
  });

  it("fails closed without a stale deployed write when the lease is lost during Compose execution", async () => {
    const state = {
      ...analysisRow(),
      status: "deploying",
      display_name: "Lease Test",
      project_name: "lease-test",
      working_dir: "/home/docker/composebastion/lease-test",
      compose_path: "compose.yaml"
    };
    const leasedQueries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        leasedQueries.push(sql);
        if (sql.includes("SELECT * FROM deployment_analyses")) {
          return { rows: [{ ...state }], rowCount: 1 };
        }
        if (sql.includes("AS reconciliation_required")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      })
    };
    let active = true;
    const fence = {
      assertActive: async () => {
        if (!active) throw leaseLost("execute-job");
      },
      withActiveLease: async <T>(callback: (leasedClient: typeof client) => Promise<T>) => {
        if (!active) throw leaseLost("execute-job");
        return callback(client);
      }
    };
    let signalDeployStarted!: () => void;
    let releaseDeploy!: () => void;
    const deployStarted = new Promise<void>((resolve) => {
      signalDeployStarted = resolve;
    });
    const deployResult = new Promise<{ stackId: string }>((resolve) => {
      releaseDeploy = () => resolve({
        stackId: "33333333-3333-4333-8333-333333333333"
      });
    });
    executeDockerAction.mockImplementationOnce(async () => {
      signalDeployStarted();
      return deployResult;
    });
    statHostPath.mockResolvedValue({ exists: false });

    const execution = executeDeployment(
      analysisId,
      fence,
      { jobId: "execute-job", attemptCount: 1 }
    );
    await deployStarted;

    active = false;
    state.status = "failed";
    state.error = "WORKER_LOST: Worker lease expired during attempt 1";
    releaseDeploy();

    await expect(execution).rejects.toMatchObject({
      code: "DEPLOYMENT_REMOTE_OUTCOME_UNKNOWN",
      message: expect.stringContaining("REMOTE_OUTCOME_UNKNOWN")
    });
    expect(leasedQueries.some((sql) =>
      sql.includes("pg_advisory_xact_lock")
    )).toBe(false);
    expect(leasedQueries.some((sql) => sql.includes("SET status = 'deployed'"))).toBe(false);
    expect(leasedQueries.some((sql) => sql.includes("SET status = 'failed'"))).toBe(false);
  });

  it("preserves an authoritative Compose failure instead of requiring ambiguous-outcome reconciliation", async () => {
    const state = {
      ...analysisRow(),
      status: "deploying",
      display_name: "Lease Test",
      project_name: "lease-test",
      working_dir: "/home/docker/composebastion/lease-test",
      compose_path: "compose.yaml"
    };
    const leasedQueries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        leasedQueries.push(sql);
        if (sql.includes("SELECT * FROM deployment_analyses")) {
          return { rows: [{ ...state }], rowCount: 1 };
        }
        if (sql.includes("SET status = 'failed'")) {
          state.status = "failed";
          return { rows: [{ ...state }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      })
    };
    const fence = {
      jobId: "authoritative-failure-job",
      attemptCount: 1,
      assertActive: async () => undefined,
      withActiveLease: async <T>(
        callback: (leasedClient: typeof client) => Promise<T>
      ) => callback(client)
    };
    const failure = new Error("Compose rejected the bound configuration");
    executeDockerAction.mockRejectedValueOnce(failure);
    statHostPath.mockResolvedValue({ exists: false });

    await expect(
      executeDeployment(
        analysisId,
        fence,
        { jobId: "authoritative-failure-job", attemptCount: 1 }
      )
    ).rejects.toBe(failure);

    expect(state.status).toBe("failed");
    expect(leasedQueries.some((sql) =>
      sql.includes("SET status = 'failed'")
    )).toBe(true);
  });

  it("redacts bound deployment secrets from thrown and persisted failures", async () => {
    const secret = "qualification-secret-value-4381";
    const state = {
      ...analysisRow(),
      status: "deploying",
      display_name: "Lease Test",
      project_name: "lease-test",
      working_dir: "/home/docker/composebastion/lease-test",
      compose_path: "compose.yaml",
      env_encrypted: `encrypted:DB_PASSWORD='${secret}'`,
      variables: [{ key: "DB_PASSWORD", secret: true }]
    };
    let persistedError = "";
    const client = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        if (sql.includes("SELECT * FROM deployment_analyses")) {
          return { rows: [{ ...state }], rowCount: 1 };
        }
        if (sql.includes("SET status = 'failed'")) {
          persistedError = String(values[1] ?? "");
          state.status = "failed";
          state.error = persistedError;
          return { rows: [{ ...state }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      })
    };
    const fence = {
      jobId: "redacted-failure-job",
      attemptCount: 1,
      assertActive: async () => undefined,
      withActiveLease: async <T>(
        callback: (leasedClient: typeof client) => Promise<T>
      ) => callback(client)
    };
    const failure = new Error(
      `Compose rejected DB_PASSWORD=${secret}; encoded=${encodeURIComponent(secret)}`
    );
    executeDockerAction.mockRejectedValueOnce(failure);
    statHostPath.mockResolvedValue({ exists: false });

    await expect(
      executeDeployment(
        analysisId,
        fence,
        { jobId: "redacted-failure-job", attemptCount: 1 }
      )
    ).rejects.toThrow("DB_PASSWORD=[REDACTED]");

    expect(failure.message).not.toContain(secret);
    expect(persistedError).not.toContain(secret);
    expect(persistedError).toContain("[REDACTED]");
  });

  it("does not downgrade an ambiguous analysis image pull to a metadata warning", async () => {
    const state = {
      ...analysisRow(),
      source_type: "image",
      source_input: "registry.example.test/team/app:1",
      source_locator: "registry.example.test/team/app:1",
      project_name: "image-analysis"
    };
    const writes: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT * FROM deployment_analyses")) {
          return { rows: [{ ...state }], rowCount: 1 };
        }
        if (sql.includes("SET status = 'analyzing'")) {
          state.status = "analyzing";
          writes.push("analyzing");
          return { rows: [{ ...state }], rowCount: 1 };
        }
        if (sql.includes("SET status = 'ready'")) {
          writes.push("ready");
          return { rows: [{ ...state, status: "ready" }], rowCount: 1 };
        }
        if (sql.includes("SET status = 'failed'")) {
          writes.push("failed");
          return { rows: [{ ...state, status: "failed" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      })
    };
    const fence = {
      assertActive: async () => undefined,
      withActiveLease: async <T>(
        callback: (leasedClient: typeof client) => Promise<T>
      ) => callback(client)
    };
    runDocker
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(Object.assign(
        new Error("image pull response was lost"),
        { code: "DOCKER_REMOTE_OUTCOME_UNKNOWN" }
      ));

    await expect(analyzeDeployment(
      analysisId,
      fence,
      { jobId: "image-analysis-job", attemptCount: 1 }
    )).rejects.toMatchObject({
      code: "DEPLOYMENT_REMOTE_OUTCOME_UNKNOWN",
      message: expect.stringContaining("REMOTE_OUTCOME_UNKNOWN")
    });
    expect(writes).toEqual(["analyzing"]);
  });

  it("marks registry-trust installation ambiguous when its lease is lost during Docker restart", async () => {
    runDocker.mockResolvedValue({ stdout: "{}", stderr: "" });
    const registryJobId = "33333333-3333-4333-8333-333333333333";
    let active = true;
    const fence = {
      jobId: registryJobId,
      attemptCount: 1,
      assertActive: async () => {
        if (!active) throw leaseLost(registryJobId);
      },
      withActiveLease: async <T>(_callback: unknown): Promise<T> => {
        throw new Error("Registry trust should not perform database writes.");
      }
    };
    let signalInstallStarted!: () => void;
    let releaseInstall!: () => void;
    const installStarted = new Promise<void>((resolve) => {
      signalInstallStarted = resolve;
    });
    const install = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      releaseInstall = () => resolve({ code: 0, stdout: "", stderr: "" });
    });
    const mutationPhases: string[] = [];
    writeRemoteFile.mockImplementationOnce(async () => {
      mutationPhases.push(
        currentRemoteMutationContext()?.phase ?? "missing"
      );
    });
    runSshCommand
      // Initial trust check: passwordless sudo is available.
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      // Read the current daemon configuration.
      .mockResolvedValueOnce({ code: 0, stdout: "{}", stderr: "" })
      // Validate the generated candidate.
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      // Install and restart Docker while the worker still owns the lease.
      .mockImplementationOnce(() => {
        mutationPhases.push(
          currentRemoteMutationContext()?.phase ?? "missing"
        );
        signalInstallStarted();
        return install;
      })
      // Production transport persists cleanup proof before launching it.
      .mockImplementationOnce(async () => {
        mutationPhases.push(
          currentRemoteMutationContext()?.phase ?? "missing"
        );
        return { code: 0, stdout: "", stderr: "" };
      });

    const operation = configureRegistryTrust(
      hostId,
      "registry.internal:5000",
      fence,
      { jobId: registryJobId, attemptCount: 1 }
    );
    await installStarted;
    active = false;
    releaseInstall();

    await expect(operation).rejects.toMatchObject({
      code: "REGISTRY_TRUST_REMOTE_OUTCOME_UNKNOWN",
      message: expect.stringContaining("REMOTE_OUTCOME_UNKNOWN")
    });
    expect(runSshCommand).toHaveBeenCalledTimes(4);
    expect(runSshCommand.mock.calls.some((call) =>
      String(call[1]).includes("rm -f --")
    )).toBe(false);
    expect(mutationPhases).toEqual([
      "registry-trust-stage",
      "registry-trust-install"
    ]);
  });

  it("uses deterministic owned registry artifacts and removes the candidate after success", async () => {
    const registryJobId = "55555555-5555-4555-8555-555555555555";
    const fence = {
      jobId: registryJobId,
      attemptCount: 2,
      assertActive: async () => undefined,
      withActiveLease: async <T>(
        callback: (client: { query: typeof query }) => Promise<T>
      ) => callback({ query })
    };
    runDocker
      .mockResolvedValueOnce({ stdout: "{}", stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          "registry.internal:5000": { Secure: false }
        }),
        stderr: ""
      });
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "{}", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    await expect(configureRegistryTrust(
      hostId,
      "registry.internal:5000",
      fence,
      { jobId: registryJobId, attemptCount: 2 }
    )).resolves.toMatchObject({
      trusted: true,
      changed: true,
      backupPath:
        `/etc/docker/daemon.json.composebastion-${registryJobId}-2.bak`
    });

    const candidatePath =
      `/tmp/composebastion-daemon-${registryJobId}-2.json`;
    expect(writeRemoteFile).toHaveBeenCalledWith(
      expect.anything(),
      candidatePath,
      expect.any(String)
    );
    expect(runSshCommand.mock.calls[3]?.[1]).toContain(
      `/etc/docker/daemon.json.composebastion-${registryJobId}-2.bak`
    );
    expect(runSshCommand.mock.calls[4]?.[1]).toContain(
      `rm -f -- '${candidatePath}'`
    );
  });

  it("does not report registry-trust success when normal candidate cleanup fails", async () => {
    const registryJobId = "66666666-6666-4666-8666-666666666666";
    const fence = {
      jobId: registryJobId,
      attemptCount: 1,
      assertActive: async () => undefined,
      withActiveLease: async <T>(
        callback: (client: { query: typeof query }) => Promise<T>
      ) => callback({ query })
    };
    runDocker
      .mockResolvedValueOnce({ stdout: "{}", stderr: "" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          "registry.internal:5000": { Secure: false }
        }),
        stderr: ""
      });
    runSshCommand
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "{}", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "temporary file busy"
      });

    await expect(configureRegistryTrust(
      hostId,
      "registry.internal:5000",
      fence,
      { jobId: registryJobId, attemptCount: 1 }
    )).rejects.toMatchObject({
      code: "REGISTRY_TRUST_CANDIDATE_CLEANUP_REQUIRED",
      message: expect.stringContaining("REMOTE_OUTCOME_UNKNOWN")
    });
  });

  it("preserves the ambiguous registry-trust install proof while the lease remains active", async () => {
    runDocker.mockResolvedValue({ stdout: "{}", stderr: "" });
    const registryJobId = "44444444-4444-4444-8444-444444444444";
    const fence = {
      jobId: registryJobId,
      attemptCount: 1,
      assertActive: async () => undefined,
      withActiveLease: async <T>(
        callback: (client: { query: typeof query }) => Promise<T>
      ) => callback({ query })
    };
    const mutationPhases: string[] = [];
    writeRemoteFile.mockImplementationOnce(async () => {
      mutationPhases.push(
        currentRemoteMutationContext()?.phase ?? "missing"
      );
    });
    runSshCommand
      // Initial trust check: passwordless sudo is available.
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      // Read the current daemon configuration.
      .mockResolvedValueOnce({ code: 0, stdout: "{}", stderr: "" })
      // Validate the generated candidate.
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      // The transport cannot prove whether install/restart completed.
      .mockImplementationOnce(async () => {
        mutationPhases.push(
          currentRemoteMutationContext()?.phase ?? "missing"
        );
        throw Object.assign(
          new Error("registry install response was lost"),
          { code: "REMOTE_MUTATION_OUTCOME_UNKNOWN" }
        );
      });

    await expect(configureRegistryTrust(
      hostId,
      "registry.internal:5000",
      fence,
      { jobId: registryJobId, attemptCount: 1 }
    )).rejects.toMatchObject({
      code: "REGISTRY_TRUST_REMOTE_OUTCOME_UNKNOWN",
      message: expect.stringContaining("REMOTE_OUTCOME_UNKNOWN")
    });

    expect(runSshCommand).toHaveBeenCalledTimes(4);
    expect(runSshCommand.mock.calls.some((call) =>
      String(call[1]).includes("rm -f --")
    )).toBe(false);
    expect(mutationPhases).toEqual([
      "registry-trust-stage",
      "registry-trust-install"
    ]);
    expect(mutationPhases.at(-1)).toBe("registry-trust-install");
  });
});
