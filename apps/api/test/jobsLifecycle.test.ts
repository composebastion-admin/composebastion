import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction: (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query })
}));

vi.mock("../src/services/redis.js", () => ({
  createRedis: () => null
}));

const { buildJobProgress, cancelQueuedJob, markJobProgressStep, retryJob, updateJobProgress } = await import("../src/services/jobs.js");
const { encryptSecret } = await import("../src/services/crypto.js");

const now = new Date("2026-06-16T12:00:00.000Z");
const hostId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const analysisId = "44444444-4444-4444-8444-444444444444";
const lease = { workerId: "55555555-5555-4555-8555-555555555555", attemptCount: 1 };

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    type: "container.restart",
    status: "failed",
    host_id: hostId,
    payload: { containerId: "demo-container" },
    result: null,
    progress: [],
    error: "boom",
    created_by: userId,
    created_at: now,
    updated_at: now,
    started_at: now,
    completed_at: now,
    ...overrides
  };
}

describe("job lifecycle helpers", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("cancels only queued jobs", async () => {
    query.mockResolvedValueOnce({ rows: [jobRow({ status: "canceled", error: "Canceled before start" })] });

    const result = await cancelQueuedJob("33333333-3333-4333-8333-333333333333");

    expect(result.canceled).toBe(true);
    expect(result.job?.status).toBe("canceled");
    expect(query.mock.calls[0]?.[0]).toContain("WHERE id = $1 AND status = 'queued'");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "Canceled before start"
    ]);
  });

  it("returns the current job when cancel cannot update it", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ status: "running" })] });

    const result = await cancelQueuedJob("33333333-3333-4333-8333-333333333333");

    expect(result).toMatchObject({ canceled: false, job: { status: "running" } });
  });

  it.each([
    {
      label: "backup capture",
      type: "volume.backup",
      payload: { backupId: "44444444-4444-4444-8444-444444444441" },
      expectedSql: ["UPDATE backups SET status = 'failed'", "UPDATE backup_schedules"]
    },
    {
      label: "backup drill",
      type: "backup.drill",
      payload: { backupId: "44444444-4444-4444-8444-444444444442" },
      expectedSql: ["last_drill_status = 'failed'"]
    },
    {
      label: "recovery capture",
      type: "recovery.create",
      payload: { recoveryPointId: "44444444-4444-4444-8444-444444444443" },
      expectedSql: ["UPDATE recovery_points", "UPDATE recovery_artifacts"]
    },
    {
      label: "recovery drill",
      type: "recovery.restore",
      payload: {
        recoveryPointId: "44444444-4444-4444-8444-444444444444",
        drill: true
      },
      expectedSql: ["UPDATE recovery_points", "UPDATE recovery_schedules"]
    },
    {
      label: "deployment analysis",
      type: "deploy.analyze",
      payload: { analysisId: "44444444-4444-4444-8444-444444444445" },
      expectedSql: ["UPDATE deployment_analyses"]
    },
    {
      label: "migration execution",
      type: "migration.execute",
      payload: { migrationRunId: "44444444-4444-4444-8444-444444444446" },
      expectedSql: [
        "SELECT recovery_point_id",
        "UPDATE migration_runs",
        "UPDATE recovery_points",
        "UPDATE recovery_artifacts"
      ]
    }
  ])("atomically finalizes linked $label state when a queued job is canceled", async ({
    type,
    payload,
    expectedSql
  }) => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE operation_jobs")) {
        return {
          rows: [jobRow({
            type,
            status: "canceled",
            payload,
            error: "Canceled before start"
          })],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(
      cancelQueuedJob("33333333-3333-4333-8333-333333333333")
    ).resolves.toMatchObject({
      canceled: true,
      job: { type, status: "canceled" }
    });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    for (const expected of expectedSql) {
      expect(statements.some((sql) => sql.includes(expected)), expected).toBe(true);
    }
    for (const [, values] of query.mock.calls.slice(1)) {
      if (Array.isArray(values) && values.length > 1) {
        expect(values).toContain("Canceled before start");
      }
    }
  });

  it("atomically requeues an allowlisted failed job without cloning it", async () => {
    query
      .mockResolvedValueOnce({ rows: [jobRow({ type: "host.check", status: "failed", payload: {}, attempt_count: 1 })] })
      .mockResolvedValueOnce({ rows: [{ id: hostId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ type: "host.check", status: "failed", payload: {}, attempt_count: 1 })] })
      .mockResolvedValueOnce({ rows: [jobRow({
        type: "host.check",
        status: "queued",
        payload: {},
        attempt_count: 1,
        error: null,
        created_by: userId,
        started_at: null,
        completed_at: null
      })] });

    const result = await retryJob("33333333-3333-4333-8333-333333333333", userId);

    expect(result.original?.status).toBe("failed");
    expect(result.retried?.id).toBe(result.original?.id);
    expect(query.mock.calls[0]?.[0]).not.toContain("FOR UPDATE");
    expect(query.mock.calls[1]?.[0]).toContain("FROM docker_hosts");
    expect(query.mock.calls[3]?.[0]).toContain("FOR UPDATE");
    expect(query.mock.calls[4]?.[0]).toContain("UPDATE operation_jobs");
  });

  it("rejects generic retry for destructive and migration jobs", async () => {
    for (const type of ["container.restart", "migration.execute"]) {
      query.mockResolvedValueOnce({ rows: [jobRow({ type, status: "failed", attempt_count: 1 })] });
      const result = await retryJob("33333333-3333-4333-8333-333333333333", userId);
      expect(result.retried).toBeNull();
    }
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not retry running jobs", async () => {
    query.mockResolvedValueOnce({ rows: [jobRow({ status: "running" })] });

    const result = await retryJob("33333333-3333-4333-8333-333333333333", userId);

    expect(result.original?.status).toBe("running");
    expect(result.retried).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not manually retry registry trust while an equivalent job is active", async () => {
    const registryPayload = { registry: "registry.internal:5000" };
    query
      .mockResolvedValueOnce({
        rows: [jobRow({
          type: "host.configureRegistryTrust",
          status: "failed",
          payload: registryPayload,
          attempt_count: 1
        })]
      })
      .mockResolvedValueOnce({ rows: [{ id: hostId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [jobRow({
          type: "host.configureRegistryTrust",
          status: "failed",
          payload: registryPayload,
          attempt_count: 1
        })]
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [jobRow({
          id: "44444444-4444-4444-8444-444444444444",
          type: "host.configureRegistryTrust",
          status: "running",
          payload: registryPayload,
          attempt_count: 1
        })]
      });

    await expect(
      retryJob("33333333-3333-4333-8333-333333333333", userId)
    ).rejects.toMatchObject({
      statusCode: 409,
      activeJobId: "44444444-4444-4444-8444-444444444444"
    });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("pg_advisory_xact_lock")
    )).toBe(true);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("status IN ('queued', 'running')")
    )).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'queued'"))).toBe(false);
  });

  it("does not replay non-idempotent work after an ambiguous worker lease loss", async () => {
    for (const type of ["deploy.execute", "host.configureRegistryTrust"]) {
      query.mockResolvedValueOnce({
        rows: [jobRow({
          type,
          status: "failed",
          payload: type === "deploy.execute"
            ? { analysisId: "44444444-4444-4444-8444-444444444444" }
            : { registry: "registry.internal:5000" },
          attempt_count: 1,
          error: "WORKER_LOST: Worker lease expired during attempt 1"
        })]
      });

      await expect(
        retryJob("33333333-3333-4333-8333-333333333333", userId)
      ).resolves.toMatchObject({
        original: { type, status: "failed" },
        retried: null
      });
    }

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'queued'"))).toBe(false);
  });

  it("locks the host and admission key before the deployment analysis and operation row", async () => {
    const failed = jobRow({
      type: "deploy.analyze",
      status: "failed",
      payload: { analysisId },
      attempt_count: 1
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM deployment_analyses")) {
        return { rows: [{
          id: analysisId,
          host_id: hostId,
          status: "failed",
          expires_at: new Date(now.getTime() + 60_000),
          unexpired: true
        }] };
      }
      if (sql.includes("FROM docker_hosts")) {
        return { rows: [{ id: hostId }] };
      }
      if (sql.includes("FROM recovery_points")) {
        return { rows: [] };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (sql.includes("status IN ('queued', 'running')") || sql.includes("status = 'failed'")) {
        return { rows: [] };
      }
      if (sql.includes("FROM operation_jobs WHERE id = $1 FOR UPDATE")) {
        return { rows: [failed] };
      }
      if (sql.includes("SET status = 'queued'")) {
        return { rows: [jobRow({
          type: "deploy.analyze",
          status: "queued",
          payload: { analysisId },
          attempt_count: 1,
          error: null,
          started_at: null,
          completed_at: null
        })] };
      }
      return { rows: [failed] };
    });

    const result = await retryJob("33333333-3333-4333-8333-333333333333", userId);

    expect(result).toMatchObject({
      original: { type: "deploy.analyze", status: "failed" },
      retried: { type: "deploy.analyze", status: "queued" }
    });
    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls[0]).not.toContain("FOR UPDATE");
    const analysisCall = calls.find((sql) =>
      sql.includes("FROM deployment_analyses") && sql.includes("FOR UPDATE")
    );
    expect(analysisCall).toContain("expires_at > clock_timestamp()");
    expect(analysisCall).toContain("FOR UPDATE");
    const hostIndex = calls.findIndex((sql) =>
      sql.includes("FROM docker_hosts") && sql.includes("FOR")
    );
    const admissionIndex = calls.findIndex((sql) =>
      sql.includes("pg_advisory_xact_lock")
    );
    const analysisIndex = calls.findIndex((sql) =>
      sql.includes("FROM deployment_analyses") && sql.includes("FOR UPDATE")
    );
    const jobIndex = calls.findIndex((sql) =>
      sql.includes("FROM operation_jobs WHERE id = $1 FOR UPDATE")
    );
    expect(hostIndex).toBeGreaterThan(0);
    expect(admissionIndex).toBeGreaterThan(hostIndex);
    expect(analysisIndex).toBeGreaterThan(admissionIndex);
    expect(jobIndex).toBeGreaterThan(analysisIndex);
    expect(calls.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(calls.some((sql) => sql.includes("status IN ('queued', 'running')"))).toBe(true);
    expect(calls.some((sql) => sql.includes("status = 'failed'"))).toBe(true);
    expect(calls.some((sql) => sql.includes("FROM operation_jobs WHERE id = $1 FOR UPDATE"))).toBe(true);
    expect(calls.some((sql) => sql.includes("SET status = 'queued'"))).toBe(true);
  });

  it("refuses deployment retry after expiry has won the analysis-row lock", async () => {
    const failed = jobRow({
      type: "deploy.execute",
      status: "failed",
      payload: { analysisId },
      attempt_count: 1
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM deployment_analyses")) {
        return {
          rows: [{
            id: analysisId,
            host_id: hostId,
            status: "expired",
            compose_yaml: "services: {}",
            expires_at: new Date(now.getTime() - 60_000),
            unexpired: false
          }]
        };
      }
      if (sql.includes("FROM docker_hosts")) {
        return { rows: [{ id: hostId }] };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      return { rows: [failed] };
    });

    await expect(
      retryJob("33333333-3333-4333-8333-333333333333", userId)
    ).resolves.toMatchObject({
      original: { type: "deploy.execute", status: "failed" },
      retried: null
    });

    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("FROM deployment_analyses")
      && String(sql).includes("FOR UPDATE")
    )).toBe(true);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("pg_advisory_xact_lock")
    )).toBe(true);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("SET status = 'queued'")
    )).toBe(false);
  });

  it("refuses deployment retry after a referenced registry credential was deleted", async () => {
    const failed = jobRow({
      type: "deploy.execute",
      status: "failed",
      payload: { analysisId },
      attempt_count: 1,
      created_at: new Date("2026-06-16T10:00:00.000Z")
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM deployment_analyses")) {
        return {
          rows: [{
            id: analysisId,
            host_id: hostId,
            status: "failed",
            compose_yaml: [
              "services:",
              "  app:",
              "    image: registry.internal:5000/team/app:1"
            ].join("\n"),
            expires_at: new Date(now.getTime() + 60_000),
            unexpired: true
          }]
        };
      }
      if (sql.includes("FROM audit_events")) {
        return {
          rows: [{ authority: "registry.internal:5000" }]
        };
      }
      return { rows: [failed] };
    });

    await expect(retryJob(
      "33333333-3333-4333-8333-333333333333",
      userId
    )).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Analyze the deployment again")
    });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("SET status = 'queued'")
    )).toBe(false);
  });

  it("refuses deployment retry when registry deletion commits during credential admission", async () => {
    const boundEnvironment =
      "REGISTRY_HOST='registry.internal:5000'\nIMAGE_TAG='1'";
    const encryptedEnvironment = encryptSecret(boundEnvironment);
    const failed = jobRow({
      type: "deploy.execute",
      status: "failed",
      payload: { analysisId },
      attempt_count: 1,
      created_at: new Date("2026-06-16T10:00:00.000Z")
    });
    let auditReads = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM deployment_analyses")) {
        return {
          rows: [{
            id: analysisId,
            host_id: hostId,
            status: "failed",
            working_dir: "/srv/retry-race",
            project_name: "retry-race",
            compose_yaml: [
              "services:",
              "  app:",
              "    image: ${REGISTRY_HOST}/team/app:${IMAGE_TAG}"
            ].join("\n"),
            env_encrypted: encryptedEnvironment,
            expires_at: new Date(now.getTime() + 60_000),
            unexpired: true
          }]
        };
      }
      if (sql.includes("FROM docker_hosts")) {
        return { rows: [{ id: hostId }] };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (sql.includes("FROM audit_events")) {
        auditReads += 1;
        return {
          rows: auditReads === 1
            ? []
            : [{ authority: "registry.internal:5000" }]
        };
      }
      if (sql.includes("FROM registries ORDER BY id")) {
        return {
          rows: [{
            id: "55555555-5555-4555-8555-555555555555",
            url: "https://registry.internal:5000",
            insecure: false
          }]
        };
      }
      if (sql.includes("FROM registries WHERE id = $1")) {
        return {
          rows: [{ id: "55555555-5555-4555-8555-555555555555" }]
        };
      }
      return { rows: [failed] };
    });

    await expect(retryJob(
      "33333333-3333-4333-8333-333333333333",
      userId
    )).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Analyze the deployment again")
    });

    expect(auditReads).toBe(2);
    const calls = query.mock.calls.map(([sql]) => String(sql));
    const auditIndexes = calls.flatMap((sql, index) =>
      sql.includes("FROM audit_events") ? [index] : []
    );
    const registryLockIndex = calls.findIndex((sql) =>
      sql.includes("FROM registries WHERE id = $1")
      && sql.includes("FOR UPDATE NOWAIT")
    );
    expect(auditIndexes).toHaveLength(2);
    expect(registryLockIndex).toBeGreaterThan(auditIndexes[0]!);
    expect(auditIndexes[1]).toBeGreaterThan(registryLockIndex);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("FROM deployment_analyses")
      && String(sql).includes("FOR UPDATE")
    )).toBe(false);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("SET status = 'queued'")
    )).toBe(false);
  });

  it("treats the same concurrently revived deployment job as an already-completed retry", async () => {
    const failed = jobRow({
      type: "deploy.analyze",
      status: "failed",
      payload: { analysisId },
      attempt_count: 1
    });
    const queued = jobRow({
      type: "deploy.analyze",
      status: "queued",
      payload: { analysisId },
      attempt_count: 1,
      error: null
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM deployment_analyses")) {
        return { rows: [{
          id: analysisId,
          host_id: hostId,
          status: "failed",
          expires_at: new Date(now.getTime() + 60_000),
          unexpired: true
        }] };
      }
      if (sql.includes("FROM docker_hosts")) {
        return { rows: [{ id: hostId }] };
      }
      if (sql.includes("FROM recovery_points")) {
        return { rows: [] };
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        return { rows: [] };
      }
      if (sql.includes("status IN ('queued', 'running')")) {
        return { rows: [queued] };
      }
      if (sql.includes("FROM operation_jobs WHERE id = $1 FOR UPDATE")) {
        return { rows: [queued] };
      }
      return { rows: [failed] };
    });

    await expect(
      retryJob("33333333-3333-4333-8333-333333333333", userId)
    ).resolves.toMatchObject({
      original: { type: "deploy.analyze", status: "queued" },
      retried: null
    });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("SET status = 'queued'")
    )).toBe(false);
  });

  it("builds typed progress steps for long-running jobs", () => {
    expect(buildJobProgress("recovery.restore", "running").slice(0, 2)).toMatchObject([
      { label: "Prepare", status: "running" },
      { label: "Restore", status: "pending" }
    ]);
    expect(buildJobProgress("recovery.restore", "running", "restore").slice(0, 3)).toMatchObject([
      { label: "Prepare", status: "completed" },
      { label: "Restore", status: "running" },
      { label: "Verify", status: "pending" }
    ]);
    expect(buildJobProgress("migration.execute", "failed").at(-1)).toMatchObject({ label: "Verify", status: "failed" });
    expect(buildJobProgress("migration.execute", "failed", "transfer", "missing folder").slice(0, 4)).toMatchObject([
      { label: "Plan", status: "completed" },
      { label: "Capture", status: "completed" },
      { label: "Transfer", status: "failed", detail: "missing folder" },
      { label: "Deploy", status: "pending" }
    ]);
  });

  it("persists normalized progress steps", async () => {
    query.mockResolvedValueOnce({ rows: [jobRow({ progress: [{ id: "run", label: "Run", status: "running" }] })] });

    const result = await updateJobProgress("33333333-3333-4333-8333-333333333333", [{ id: "run", label: "Run", status: "running" }], lease);

    expect(result?.progress).toEqual([{ id: "run", label: "Run", status: "running" }]);
    expect(query.mock.calls[0]?.[0]).toContain("SET progress = $2");
  });

  it("marks a named progress step active", async () => {
    query.mockResolvedValueOnce({ rows: [jobRow({ progress: buildJobProgress("host.sync", "running", "inventory") })] });

    const result = await markJobProgressStep("33333333-3333-4333-8333-333333333333", "host.sync", "inventory", undefined, lease);

    expect(result?.progress).toMatchObject([
      { id: "connect", status: "completed" },
      { id: "inventory", status: "running" },
      { id: "store", status: "pending" }
    ]);
  });
});
