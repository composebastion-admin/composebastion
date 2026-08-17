import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const getHostForWorker = vi.hoisted(() => vi.fn());
const runSshCommand = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction: (callback: (client: { query: typeof query }) => Promise<unknown>) => (
    callback({ query })
  )
}));

vi.mock("../src/services/docker.js", () => ({
  executeDockerAction: vi.fn(),
  runDocker: vi.fn()
}));

vi.mock("../src/services/files.js", () => ({
  statHostPath: vi.fn()
}));

vi.mock("../src/services/hosts.js", () => ({
  getHostForWorker: (...args: unknown[]) => getHostForWorker(...args),
  listHostIds: vi.fn()
}));

vi.mock("../src/services/imageUpdates.js", () => ({
  findRegistryAuthForReference: vi.fn()
}));

vi.mock("../src/services/jobs.js", () => ({
  enqueueJobInTransaction: vi.fn(),
  notifyJobQueued: vi.fn()
}));

vi.mock("../src/services/ssh.js", () => ({
  readRemoteFile: vi.fn(),
  runSshCommand: (...args: unknown[]) => runSshCommand(...args),
  writeRemoteFile: vi.fn()
}));

const hostId = "11111111-1111-4111-8111-111111111111";
const analysisId = "22222222-2222-4222-8222-222222222222";
const attemptToken = "33333333-3333-4333-8333-333333333333";
const attemptDirectory = `/home/docker/composebastion/.analysis/${analysisId}/${attemptToken}`;
const stagingDirectory = `${attemptDirectory}/checkout`;
const legacyStagingDirectory = `/home/docker/composebastion/.analysis/${analysisId}`;

function analysisRow(overrides: Record<string, unknown> = {}) {
  const timestamp = new Date("2026-07-30T10:00:00.000Z");
  return {
    id: analysisId,
    host_id: hostId,
    source_id: null,
    source_type: "image",
    source_input: "nginx:latest",
    source_locator: "nginx:latest",
    status: "failed",
    display_name: "Nginx",
    project_name: "nginx",
    branch: null,
    compose_path: null,
    working_dir: null,
    compose_yaml: "services:\n  nginx:\n    image: nginx:latest\n",
    env_encrypted: null,
    credential_secret_encrypted: null,
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
    expires_at: new Date("2026-07-30T09:00:00.000Z"),
    expiration_due: true,
    created_at: timestamp,
    updated_at: timestamp,
    deployed_at: null,
    staging_directory: stagingDirectory,
    ...overrides
  };
}

describe("expired deployment analysis cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockReset();
    getHostForWorker.mockReset();
    runSshCommand.mockReset();
  });

  it("skips an expired analysis whose row is already locked by queue or retry admission", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });

    const { cleanupExpiredDeploymentAnalyses } = await import("../src/services/deployments.js");
    await expect(cleanupExpiredDeploymentAnalyses()).resolves.toEqual({
      expired: 0,
      stagingCleanup: {
        checked: 0,
        cleaned: 0,
        skipped: 0,
        failures: []
      }
    });

    expect(query).toHaveBeenCalledTimes(2);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("FOR UPDATE OF analyses SKIP LOCKED");
    expect(getHostForWorker).not.toHaveBeenCalled();
    expect(runSshCommand).not.toHaveBeenCalled();
  });

  it("preserves a locked expired analysis whenever any matching analyze or deploy job is active", async () => {
    query
      .mockResolvedValueOnce({ rows: [analysisRow({ status: "failed" })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ analysis_id: analysisId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { cleanupExpiredDeploymentAnalyses } = await import("../src/services/deployments.js");
    await expect(cleanupExpiredDeploymentAnalyses()).resolves.toEqual({
      expired: 0,
      stagingCleanup: {
        checked: 0,
        cleaned: 0,
        skipped: 0,
        failures: []
      }
    });

    expect(query).toHaveBeenCalledTimes(3);
    const activeSql = String(query.mock.calls[1]?.[0]);
    expect(activeSql).toContain("jobs.status IN ('queued', 'running')");
    expect(activeSql).toContain("jobs.type IN ('deploy.analyze', 'deploy.execute')");
    expect(activeSql).toContain("jobs.payload->>'analysisId' = ANY($1::text[])");
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE deployment_analyses")
    )).toBe(false);
    expect(getHostForWorker).not.toHaveBeenCalled();
  });

  it("expires a terminal stale analysis, clears secrets, and cleans its managed staging directory", async () => {
    query
      .mockResolvedValueOnce({ rows: [analysisRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [analysisRow({
          status: "expired",
          env_encrypted: null,
          credential_secret_encrypted: null
        })],
        rowCount: 1
      })
      .mockResolvedValueOnce({
        rows: [{ id: analysisId, host_id: hostId }],
        rowCount: 1
      })
      .mockResolvedValueOnce({
        rows: [{
          id: analysisId,
          host_id: hostId,
          staging_directory: stagingDirectory
        }],
        rowCount: 1
      })
      .mockResolvedValueOnce({ rows: [{ id: analysisId }], rowCount: 1 });
    getHostForWorker.mockResolvedValue({
      public: { id: hostId, username: "docker" },
      connectionMode: "ssh",
      ssh: { hostname: "docker.example.test", port: 22, username: "docker" },
      agent: null
    });
    runSshCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const { cleanupExpiredDeploymentAnalyses } = await import("../src/services/deployments.js");
    await expect(cleanupExpiredDeploymentAnalyses()).resolves.toEqual({
      expired: 1,
      stagingCleanup: {
        checked: 1,
        cleaned: 1,
        skipped: 0,
        failures: []
      }
    });

    expect(query).toHaveBeenCalledTimes(6);
    const selectionSql = String(query.mock.calls[0]?.[0]);
    const updateSql = String(query.mock.calls[2]?.[0]);
    const cleanupSelectionSql = String(query.mock.calls[4]?.[0]);
    const cleanupUpdateSql = String(query.mock.calls[5]?.[0]);
    expect(selectionSql).toContain("analyses.status NOT IN ('deployed', 'expired')");
    expect(selectionSql).toContain("FOR UPDATE OF analyses SKIP LOCKED");
    expect(updateSql).toContain("env_encrypted = null");
    expect(updateSql).toContain("credential_secret_encrypted = null");
    expect(updateSql).toContain("status NOT IN ('deployed', 'expired')");
    expect(cleanupSelectionSql).toContain("analyses.status IN ('failed', 'deployed', 'expired')");
    expect(cleanupSelectionSql).toContain("FOR UPDATE OF analyses SKIP LOCKED");
    expect(cleanupSelectionSql).toContain("jobs.status IN ('queued', 'running')");
    expect(cleanupUpdateSql).toContain("staging_directory = null");
    expect(cleanupUpdateSql).toContain("analyses.staging_directory = $3");
    expect(cleanupUpdateSql).toContain("NOT EXISTS");
    expect(getHostForWorker).toHaveBeenCalledWith(hostId);
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "docker.example.test" }),
      expect.stringContaining(`staging_directory='${attemptDirectory}'`),
      { timeoutMs: 30_000 }
    );
    expect(String(runSshCommand.mock.calls[0]?.[1])).toContain(
      `.composebastion-owner`
    );
    expect(String(runSshCommand.mock.calls[0]?.[1])).toContain(
      `composebastion-deployment-analysis-v1:${analysisId}:${attemptToken}`
    );
    expect(String(runSshCommand.mock.calls[0]?.[1])).toContain(
      "if [ -e \"$staging_directory\" ] || [ -L \"$staging_directory\" ]"
    );
    expect(String(runSshCommand.mock.calls[0]?.[1])).toContain(
      "rm -rf -- \"$staging_directory\""
    );
  });

  it("retains a failed staging cleanup obligation and clears it only after a later verified retry", async () => {
    let cleared = false;
    query.mockImplementation(async (sql: string) => {
      if (
        sql.includes("FROM deployment_analyses AS analyses")
        && sql.includes("status NOT IN ('deployed', 'expired')")
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (
        sql.includes("SELECT analyses.id, analyses.host_id")
        && !sql.includes("SELECT analyses.id, analyses.host_id, analyses.staging_directory")
      ) {
        return {
          rows: cleared ? [] : [{ id: analysisId, host_id: hostId }],
          rowCount: cleared ? 0 : 1
        };
      }
      if (
        sql.includes("SELECT analyses.id, analyses.host_id, analyses.staging_directory")
      ) {
        return {
          rows: [{
            id: analysisId,
            host_id: hostId,
            staging_directory: stagingDirectory
          }],
          rowCount: 1
        };
      }
      if (sql.includes("SET staging_directory = null")) {
        cleared = true;
        return { rows: [{ id: analysisId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    getHostForWorker.mockResolvedValue({
      public: { id: hostId, username: "docker" },
      connectionMode: "ssh",
      ssh: { hostname: "docker.example.test", port: 22, username: "docker" },
      agent: null
    });
    runSshCommand
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "permission denied" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { cleanupExpiredDeploymentAnalyses } = await import("../src/services/deployments.js");
    const first = await cleanupExpiredDeploymentAnalyses();
    const second = await cleanupExpiredDeploymentAnalyses();

    expect(first).toEqual({
      expired: 0,
      stagingCleanup: {
        checked: 1,
        cleaned: 0,
        skipped: 0,
        failures: [{
          analysisId,
          hostId,
          code: "remove_failed",
          error: "permission denied"
        }]
      }
    });
    expect(second).toEqual({
      expired: 0,
      stagingCleanup: {
        checked: 1,
        cleaned: 1,
        skipped: 0,
        failures: []
      }
    });
    expect(runSshCommand).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.filter(([sql]) =>
      String(sql).includes("SET staging_directory = null")
    )).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      "worker.deployment_analysis_staging_cleanup",
      expect.objectContaining({
        checked: 1,
        cleaned: 0,
        failures: [expect.objectContaining({ code: "remove_failed" })]
      })
    );
    warn.mockRestore();
  });

  it("preserves a legacy unmarked staging path even when the database row still names it", async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ id: analysisId, host_id: hostId }],
        rowCount: 1
      })
      .mockResolvedValueOnce({
        rows: [{
          id: analysisId,
          host_id: hostId,
          staging_directory: legacyStagingDirectory
        }],
        rowCount: 1
      });
    getHostForWorker.mockResolvedValue({
      public: { id: hostId, username: "docker" },
      connectionMode: "ssh",
      ssh: { hostname: "docker.example.test", port: 22, username: "docker" },
      agent: null
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { cleanupExpiredDeploymentAnalyses } = await import("../src/services/deployments.js");
    const result = await cleanupExpiredDeploymentAnalyses();

    expect(result.stagingCleanup).toEqual({
      checked: 1,
      cleaned: 0,
      skipped: 0,
      failures: [{
        analysisId,
        hostId,
        code: "legacy_unowned",
        error: "The legacy staging directory has no ownership marker and was preserved for manual inspection."
      }]
    });
    expect(runSshCommand).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("SET staging_directory = null")
    )).toBe(false);
    warn.mockRestore();
  });

  it("rechecks active jobs under the analysis row lock before touching staging", async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ id: analysisId, host_id: hostId }],
        rowCount: 1
      })
      // Simulate a job becoming active after the maintenance candidate scan.
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { cleanupExpiredDeploymentAnalyses } = await import("../src/services/deployments.js");
    await expect(cleanupExpiredDeploymentAnalyses()).resolves.toEqual({
      expired: 0,
      stagingCleanup: {
        checked: 1,
        cleaned: 0,
        skipped: 1,
        failures: []
      }
    });

    const candidateSql = String(query.mock.calls[1]?.[0]);
    const lockedSql = String(query.mock.calls[2]?.[0]);
    for (const sql of [candidateSql, lockedSql]) {
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain("jobs.status IN ('queued', 'running')");
      expect(sql).toContain("jobs.type IN ('deploy.analyze', 'deploy.execute')");
    }
    expect(lockedSql).toContain("FOR UPDATE OF analyses SKIP LOCKED");
    expect(getHostForWorker).not.toHaveBeenCalled();
    expect(runSshCommand).not.toHaveBeenCalled();
  });

  it("refuses cleanup when the recorded path does not match the selected host's managed root", async () => {
    const mismatchedDirectory = `/home/another-user/composebastion/.analysis/${analysisId}`;
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ id: analysisId, host_id: hostId }],
        rowCount: 1
      })
      .mockResolvedValueOnce({
        rows: [{
          id: analysisId,
          host_id: hostId,
          staging_directory: mismatchedDirectory
        }],
        rowCount: 1
      });
    getHostForWorker.mockResolvedValue({
      public: { id: hostId, username: "docker" },
      connectionMode: "ssh",
      ssh: { hostname: "docker.example.test", port: 22, username: "docker" },
      agent: null
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { cleanupExpiredDeploymentAnalyses } = await import("../src/services/deployments.js");
    const result = await cleanupExpiredDeploymentAnalyses();

    expect(result.stagingCleanup).toEqual({
      checked: 1,
      cleaned: 0,
      skipped: 0,
      failures: [{
        analysisId,
        hostId,
        code: "path_mismatch",
        error: "The recorded staging directory does not match the managed path for this analysis and host."
      }]
    });
    expect(runSshCommand).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("SET staging_directory = null")
    )).toBe(false);
    warn.mockRestore();
  });

  it.each([
    ["queued", "deploy.analyze"],
    ["analyzing", "deploy.analyze"],
    ["deploying", "deploy.execute"]
  ])(
    "GET returns authoritative %s status and retains secrets while an active %s job protects the expired row",
    async (status) => {
      query
        .mockResolvedValueOnce({ rows: [analysisRow({ status })], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ analysis_id: analysisId }], rowCount: 1 });

      const { getDeploymentAnalysis } = await import("../src/services/deployments.js");
      const analysis = await getDeploymentAnalysis(analysisId);

      expect(analysis?.status).toBe(status);
      expect(query).toHaveBeenCalledTimes(2);
      expect(String(query.mock.calls[0]?.[0])).toContain("FOR UPDATE OF analyses");
      expect(String(query.mock.calls[1]?.[0])).toContain("jobs.status IN ('queued', 'running')");
      expect(query.mock.calls.some(([sql]) =>
        String(sql).includes("UPDATE deployment_analyses")
      )).toBe(false);
    }
  );

  it("GET atomically expires a due inactive analysis before rendering it", async () => {
    query
      .mockResolvedValueOnce({ rows: [analysisRow({ status: "failed" })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [analysisRow({
          status: "expired",
          env_encrypted: null,
          credential_secret_encrypted: null
        })],
        rowCount: 1
      });

    const { getDeploymentAnalysis } = await import("../src/services/deployments.js");
    const analysis = await getDeploymentAnalysis(analysisId);

    expect(analysis?.status).toBe("expired");
    expect(query).toHaveBeenCalledTimes(3);
    expect(String(query.mock.calls[0]?.[0])).toContain("FOR UPDATE OF analyses");
    expect(String(query.mock.calls[2]?.[0])).toContain("credential_secret_encrypted = null");
  });
});
