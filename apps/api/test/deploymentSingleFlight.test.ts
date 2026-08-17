import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const query = vi.hoisted(() => vi.fn());
const transactionQuery = vi.hoisted(() => vi.fn());
const enqueueJobInTransaction = vi.hoisted(() => vi.fn());
const notifyJobQueued = vi.hoisted(() => vi.fn());
const runDocker = vi.hoisted(() => vi.fn());
const statHostPath = vi.hoisted(() => vi.fn());
const getHostForWorker = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction: (callback: (client: { query: typeof transactionQuery }) => Promise<unknown>) => (
    callback({ query: transactionQuery })
  )
}));

vi.mock("../src/services/crypto.js", () => ({
  decryptSecret: (value: string) => value,
  encryptSecret: (value: string) => `encrypted:${value}`
}));

vi.mock("../src/services/docker.js", () => ({
  executeDockerAction: vi.fn(),
  runDocker
}));

vi.mock("../src/services/files.js", () => ({
  statHostPath
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker
}));

vi.mock("../src/services/imageUpdates.js", () => ({
  findRegistryAuthForReference: vi.fn(async () => null)
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction,
  notifyJobQueued
}));

const {
  createDeploymentAnalysis,
  queueDeployment,
  deploymentAnalysisInternals
} = await import("../src/services/deployments.js");

const hostId = "11111111-1111-4111-8111-111111111111";
const analysisId = "22222222-2222-4222-8222-222222222222";

const readyAnalysis = {
  id: analysisId,
  host_id: hostId,
  source_id: null,
  source_type: "image",
  source_input: "nginx:latest",
  source_locator: "nginx:latest",
  status: "ready",
  display_name: "Nginx",
  project_name: "nginx",
  branch: null,
  compose_path: "compose.yaml",
  working_dir: "/srv/nginx",
  compose_yaml: "services:\n  app:\n    image: nginx:latest\n",
  env_encrypted: null,
  credential_username: null,
  credential_secret_encrypted: null,
  staging_directory: null,
  summary: {
    services: [{ name: "app", image: "nginx:latest", build: null, ports: [], volumes: [] }],
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
  created_at: new Date("2026-07-30T10:00:00.000Z"),
  updated_at: new Date("2026-07-30T10:00:00.000Z"),
  deployed_at: null
};

describe("deployment execution single flight", () => {
  beforeEach(() => {
    query.mockReset();
    transactionQuery.mockReset();
    enqueueJobInTransaction.mockReset();
    notifyJobQueued.mockReset();
    runDocker.mockReset();
    statHostPath.mockReset();
    getHostForWorker.mockReset();

    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM deployment_analyses")) return { rows: [readyAnalysis] };
      return { rows: [] };
    });
    runDocker.mockResolvedValue({ stdout: "" });
    statHostPath.mockResolvedValue({ exists: false });
    getHostForWorker.mockResolvedValue({
      public: {
        name: "Manager",
        username: "docker",
        dockerSocketPath: "/var/run/docker.sock"
      },
      connectionMode: "ssh",
      ssh: {}
    });
  });

  it("uses a ready-to-deploy compare-and-set before creating the job", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts")) {
        return { rows: [{ id: hostId }], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(queueDeployment(analysisId, {}, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("already queued")
    });

    const update = String(transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE deployment_analyses")
    )?.[0] ?? "");
    expect(update).toContain("AND status = 'ready'");
    expect(update).toContain("AND expires_at > now()");
    expect(enqueueJobInTransaction).not.toHaveBeenCalled();
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });

  it("requires Git branch and Compose-path changes to be reanalyzed", async () => {
    const gitAnalysis = {
      ...readyAnalysis,
      source_type: "git",
      source_input: "https://git.example.test/acme/app.git",
      source_locator: "https://git.example.test/acme/app.git",
      branch: "main",
      compose_path: "compose.yaml",
      source_revision: "a".repeat(40),
      compose_sha256: createHash("sha256")
        .update(readyAnalysis.compose_yaml)
        .digest("hex"),
      environment_sha256: deploymentAnalysisInternals.environmentSha256("")
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM deployment_analyses")) {
        return { rows: [gitAnalysis] };
      }
      return { rows: [] };
    });

    await expect(
      queueDeployment(analysisId, { branch: "release" }, "user-1")
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("branch cannot be changed")
    });
    await expect(
      queueDeployment(analysisId, { composePath: "ops/compose.yaml" }, "user-1")
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Compose path cannot be changed")
    });

    expect(transactionQuery).not.toHaveBeenCalled();
    expect(enqueueJobInTransaction).not.toHaveBeenCalled();
  });

  it("rejects legacy or tampered Git analyses without a valid revision-to-Compose binding", async () => {
    const gitAnalysis = {
      ...readyAnalysis,
      source_type: "git",
      source_input: "https://git.example.test/acme/app.git",
      source_locator: "https://git.example.test/acme/app.git",
      branch: "main",
      source_revision: null,
      compose_sha256: createHash("sha256")
        .update(readyAnalysis.compose_yaml)
        .digest("hex"),
      environment_sha256: deploymentAnalysisInternals.environmentSha256("")
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM deployment_analyses")) {
        return { rows: [gitAnalysis] };
      }
      return { rows: [] };
    });

    await expect(queueDeployment(analysisId, {}, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("analyzed Git revision is missing")
    });

    gitAnalysis.source_revision = "a".repeat(40);
    gitAnalysis.compose_sha256 = "0".repeat(64);
    await expect(queueDeployment(analysisId, {}, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("stored Git Compose definition")
    });

    gitAnalysis.compose_sha256 = createHash("sha256")
      .update(readyAnalysis.compose_yaml)
      .digest("hex");
    gitAnalysis.environment_sha256 = "0".repeat(64);
    await expect(queueDeployment(analysisId, {}, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("stored Git environment")
    });

    expect(transactionQuery).not.toHaveBeenCalled();
    expect(enqueueJobInTransaction).not.toHaveBeenCalled();
  });

  it("blocks a new analysis target while an older worker-loss outcome remains unreconciled", async () => {
    const ambiguousAnalysisId = "33333333-3333-4333-8333-333333333333";
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts")) {
        return { rows: [{ id: hostId }], rowCount: 1 };
      }
      if (sql.includes("UPDATE deployment_analyses")) {
        return {
          rows: [{ ...readyAnalysis, status: "deploying" }],
          rowCount: 1
        };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("AS reconciliation_required")) {
        return {
          rows: [{
            id: ambiguousAnalysisId,
            reconciliation_required: true
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(queueDeployment(analysisId, {}, "user-1")).rejects.toMatchObject({
      statusCode: 409,
      code: "DEPLOYMENT_TARGET_RECONCILIATION_REQUIRED",
      message: expect.stringContaining("unresolved remote outcome")
    });

    const advisoryKeys = transactionQuery.mock.calls
      .filter(([sql]) => String(sql).includes("pg_advisory_xact_lock"))
      .map(([, values]) => values?.[0]);
    expect(advisoryKeys).toEqual([
      `docker-mutation-admission:${hostId}`,
      `deployment-target:path:${hostId}:*`,
      `deployment-target:path:${hostId}:/srv/nginx`,
      `deployment-target:project:${hostId}:nginx`
    ]);
    const hostRowIndex = transactionQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes("FROM docker_hosts")
    );
    const firstAdvisoryIndex = transactionQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes("pg_advisory_xact_lock")
    );
    expect(String(transactionQuery.mock.calls[hostRowIndex]?.[0])).toContain("FOR SHARE");
    expect(hostRowIndex).toBeGreaterThanOrEqual(0);
    expect(firstAdvisoryIndex).toBeGreaterThan(hostRowIndex);
    const conflictSql = String(transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("AS reconciliation_required")
    )?.[0]);
    expect(conflictSql).toContain("ambiguous_jobs.status = 'failed'");
    expect(conflictSql).toContain("ambiguous_jobs.error LIKE 'WORKER_LOST:%'");
    expect(conflictSql).toContain("ambiguous_jobs.error LIKE 'REMOTE_OUTCOME_UNKNOWN:%'");
    expect(enqueueJobInTransaction).not.toHaveBeenCalled();
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });

  it("admits the target after durable authoritative reconciliation evidence clears the ambiguity", async () => {
    const job = { id: "44444444-4444-4444-8444-444444444444" };
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts")) {
        return { rows: [{ id: hostId }], rowCount: 1 };
      }
      if (sql.includes("UPDATE deployment_analyses")) {
        return {
          rows: [{ ...readyAnalysis, status: "deploying" }],
          rowCount: 1
        };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("AS reconciliation_required")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    enqueueJobInTransaction.mockResolvedValue(job);

    await expect(queueDeployment(analysisId, {}, "user-1")).resolves.toMatchObject({
      analysis: { id: analysisId, status: "deploying" },
      job
    });

    const conflictCall = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("AS reconciliation_required")
    );
    expect(String(conflictCall?.[0])).toContain(
      "reconciled_jobs.result-> $5 ->> 'status' = 'reconciled'"
    );
    expect(conflictCall?.[1]?.[4]).toBe("remoteOutcomeReconciliation");
    expect(enqueueJobInTransaction).toHaveBeenCalledOnce();
    expect(notifyJobQueued).toHaveBeenCalledWith(job.id);
  });

  it("does not publish a deployment job when its transactional audit callback fails", async () => {
    const job = { id: "55555555-5555-4555-8555-555555555555" };
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM docker_hosts")) {
        return { rows: [{ id: hostId }], rowCount: 1 };
      }
      if (sql.includes("UPDATE deployment_analyses")) {
        return {
          rows: [{ ...readyAnalysis, status: "deploying" }],
          rowCount: 1
        };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("AS reconciliation_required")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    enqueueJobInTransaction.mockResolvedValue(job);
    const auditFailure = new Error("audit insert failed");

    await expect(queueDeployment(
      analysisId,
      {},
      "user-1",
      async () => {
        throw auditFailure;
      }
    )).rejects.toBe(auditFailure);

    expect(enqueueJobInTransaction).toHaveBeenCalledOnce();
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });

  it("does not publish a new analysis when its transactional audit callback fails", async () => {
    const job = { id: "66666666-6666-4666-8666-666666666666" };
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO deployment_analyses")) {
        return {
          rows: [{
            ...readyAnalysis,
            status: "queued",
            source_type: "image",
            source_input: "nginx:latest",
            source_locator: "nginx:latest"
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    });
    enqueueJobInTransaction.mockResolvedValue(job);
    const auditFailure = new Error("audit insert failed");

    await expect(createDeploymentAnalysis(
      {
        hostId,
        source: "nginx:latest",
        sourceType: "image"
      },
      "user-1",
      async () => {
        throw auditFailure;
      }
    )).rejects.toBe(auditFailure);

    expect(enqueueJobInTransaction).toHaveBeenCalledOnce();
    expect(notifyJobQueued).not.toHaveBeenCalled();
  });
});
