import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const transactionQuery = vi.fn();
const withTransaction = vi.fn();
const redisConnect = vi.fn();
const redisPublish = vi.fn();
const redisDisconnect = vi.fn();
let redisEnabled = false;

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: (...args: unknown[]) => withTransaction(...args)
}));

vi.mock("../src/services/redis.js", () => ({
  createRedis: () => redisEnabled ? {
    connect: redisConnect,
    publish: redisPublish,
    disconnect: redisDisconnect
  } : null
}));
vi.mock("../src/services/recoveryOperationAdmission.js", () => ({
  assertDockerMutationDoesNotConflictWithRecovery: vi.fn(async () => undefined)
}));

const {
  claimNextJob,
  completeJob,
  enqueueJob,
  enqueueJobInTransaction,
  failJob,
  getWorkerStatus,
  markSelfUpdateHandoffPending,
  recoverExpiredJobs,
  retryJob,
  renewJobLease,
  shouldResumeWorkerClaimsAfterReconciliation,
  shouldStopWorkerClaimsAfterHandoff,
  updateJobProgress
} = await import("../src/services/jobs.js");

const now = new Date("2026-07-10T12:00:00.000Z");
const hostId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const workerId = "33333333-3333-4333-8333-333333333333";

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: jobId,
    type: "host.check",
    status: "running",
    host_id: hostId,
    payload: {},
    result: null,
    progress: [],
    error: null,
    created_by: null,
    created_at: now,
    updated_at: now,
    started_at: now,
    completed_at: null,
    lease_owner: workerId,
    lease_expires_at: new Date(now.getTime() + 60_000),
    attempt_count: 1,
    ...overrides
  };
}

function arrangeTransaction(
  responder: (
    sql: string,
    values: unknown[]
  ) => Promise<{ rows: any[]; rowCount?: number }>
) {
  transactionQuery.mockImplementation(async (
    sql: string,
    values: unknown[] = []
  ) => {
    if (sql.includes("FROM docker_hosts")) {
      const ids = Array.isArray(values[0]) ? values[0] as string[] : [hostId];
      return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      return { rows: [], rowCount: 1 };
    }
    return responder(sql, values);
  });
}

beforeEach(() => {
  query.mockReset();
  transactionQuery.mockReset();
  transactionQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  withTransaction.mockReset();
  withTransaction.mockImplementation(async (handler: (client: { query: typeof transactionQuery }) => Promise<unknown>) =>
    handler({ query: transactionQuery })
  );
  redisEnabled = false;
  redisConnect.mockReset();
  redisPublish.mockReset();
  redisDisconnect.mockReset();
});

describe("durable job enqueue", () => {
  it("uses one atomic idempotent insert", async () => {
    arrangeTransaction(async (sql) => (
      sql.includes("INSERT INTO operation_jobs")
        ? { rows: [jobRow({ status: "queued", started_at: null, lease_owner: null, lease_expires_at: null, attempt_count: 0 })] }
        : { rows: [] }
    ));

    await enqueueJob({ type: "host.check", hostId, payload: {} }, null, "host-check-once");

    const insert = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO operation_jobs")
    );
    expect(insert?.[0]).toContain("ON CONFLICT (idempotency_key)");
    expect(insert?.[1]).toEqual(expect.arrayContaining(["host-check-once"]));
  });

  it("sanitizes a replayed idempotent job and persisted completion diagnostics", async () => {
    const secret = "job-replay-secret";
    arrangeTransaction(async (sql) => {
      if (sql.includes("INSERT INTO operation_jobs")) {
        return { rows: [jobRow({
          status: "completed",
          payload: { endpoint: `postgresql://user:${secret}@db.example.test/app` },
          result: { stdout: `redis://default:${secret}@redis.example.test/0` },
          progress: [{
            id: "run",
            label: "Run",
            status: "completed",
            detail: `sftp://user:${secret}@files.example.test/path`
          }],
          error: `https://user:${secret}@errors.example.test/job`
        })] };
      }
      if (sql.includes("SET status = 'completed'")) {
        return { rows: [{ id: jobId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const replayed = await enqueueJob(
      { type: "host.check", hostId, payload: {} },
      null,
      "replayed-job"
    );
    expect(JSON.stringify(replayed)).not.toContain(secret);

    await expect(completeJob(jobId, {
      diagnostic: `postgresql://user:${secret}@db.example.test/app`
    }, { workerId, attemptCount: 1 })).resolves.toBe(true);
    const completion = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SET status = 'completed'")
    );
    expect(JSON.stringify(completion?.[1]?.[1])).not.toContain(secret);
  });

  it("atomically replaces running evidence so successful completion cannot retain an encrypted deployment intent", async () => {
    arrangeTransaction(async (sql) => (
      sql.includes("SET status = 'completed'")
        ? { rows: [{ id: jobId }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    ));

    await expect(completeJob(
      jobId,
      { stackId: "44444444-4444-4444-8444-444444444444" },
      { workerId, attemptCount: 1 }
    )).resolves.toBe(true);

    const completion = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SET status = 'completed'")
    );
    expect(completion?.[0]).toContain("result = $2");
    expect(completion?.[0]).not.toContain("COALESCE(result");
    expect(JSON.stringify(completion?.[1]?.[1]))
      .not.toContain("composeStackDeploymentIntent");
  });

  it.each([
    "compose.deployPath",
    "compose.writeDeployPath",
    "deploy.execute",
    "git.cloneDeploy"
  ])(
    "promotes an ordinary post-up %s failure into authoritative reconciliation",
    async (type) => {
      const result = {
        composeStackDeploymentIntent: "v1:encrypted-replay-material",
        remoteMutationProof: {
          operationId: "a".repeat(64),
          jobId,
          attemptCount: 1,
          sequence: 4,
          phase: "compose.deployPath.up",
          transport: "ssh",
          timeoutMs: 60_000,
          status: "terminal",
          terminalState: "completed"
        }
      };
      arrangeTransaction(async (sql, values) => {
        if (
          sql.includes("SET status = 'failed'")
          && sql.includes("RETURNING *")
        ) {
          return {
            rows: [jobRow({
              type,
              payload: type === "deploy.execute"
                ? { analysisId: "44444444-4444-4444-8444-444444444444" }
                : {},
              result
            })],
            rowCount: 1
          };
        }
        if (
          sql.includes("UPDATE operation_jobs")
          && sql.includes("SET error = $2")
        ) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM github_")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(failJob(
        jobId,
        new Error("postgres failed after Compose up"),
        { workerId, attemptCount: 1 }
      )).resolves.toBe(true);

      const promoted = transactionQuery.mock.calls.find(([sql, values]) =>
        String(sql).includes("SET error = $2")
        && String((values as unknown[])?.[1] ?? "").startsWith(
          "REMOTE_OUTCOME_UNKNOWN:"
        )
      );
      expect(promoted?.[1]).toEqual([
        jobId,
        expect.stringContaining("postgres failed after Compose up")
      ]);
    }
  );

  it("supports inserting a domain record and job in one caller-owned transaction", async () => {
    arrangeTransaction(async (sql) => (
      sql.includes("INSERT INTO operation_jobs")
        ? { rows: [jobRow({ status: "queued" })] }
        : { rows: [] }
    ));

    const job = await enqueueJobInTransaction(
      { query: transactionQuery } as any,
      { type: "host.check", hostId, payload: {} },
      null,
      "transactional-job"
    );

    expect(job.id).toBe(jobId);
    expect(transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO operation_jobs")
    )?.[0]).toContain("ON CONFLICT (idempotency_key)");
    expect(redisPublish).not.toHaveBeenCalled();
  });

  it("does not fail an already committed enqueue when Redis wake-up fails", async () => {
    redisEnabled = true;
    arrangeTransaction(async (sql) => (
      sql.includes("INSERT INTO operation_jobs")
        ? { rows: [jobRow({ status: "queued" })] }
        : { rows: [] }
    ));
    redisConnect.mockResolvedValue(undefined);
    redisPublish.mockRejectedValue(new Error("redis unavailable"));

    await expect(enqueueJob({ type: "host.check", hostId, payload: {} })).resolves.toMatchObject({ id: jobId });
    expect(redisDisconnect).toHaveBeenCalledOnce();
  });

  it("serializes single-flight deployment jobs before inserting them", async () => {
    arrangeTransaction(async (sql) => {
      if (sql.includes("FROM deployment_analyses")) {
        return {
          rows: [{
            host_id: hostId,
            working_dir: "/srv/app",
            project_name: "app"
          }]
        };
      }
      if (sql.includes("INSERT INTO operation_jobs")) {
        return {
          rows: [jobRow({ type: "deploy.execute", status: "queued" })]
        };
      }
      return { rows: [] };
    });

    await expect(enqueueJob({
      type: "deploy.execute",
      hostId,
      payload: { analysisId: "44444444-4444-4444-8444-444444444444" }
    })).resolves.toMatchObject({ id: jobId, type: "deploy.execute" });

    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("pg_advisory_xact_lock")
    )).toBe(true);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("status IN ('queued', 'running')")
    )).toBe(true);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("status = 'failed'")
    )).toBe(true);
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO operation_jobs")
    )).toBe(true);
  });

  it("returns a clear conflict when a singleton self-update is already active", async () => {
    arrangeTransaction(async (sql) => {
      if (sql.includes("status IN ('queued', 'running')")) {
        return {
        rows: [jobRow({
          type: "system.self_update",
          status: "running",
          payload: {
            workingDir: "/srv/composebastion",
            composeFile: "docker-compose.image.yml",
            versionMode: "latest",
            targetVersion: "latest"
          }
        })]
        };
      }
      return { rows: [] };
    });

    await expect(enqueueJob({
      type: "system.self_update",
      hostId,
      payload: {
        workingDir: "/srv/composebastion",
        composeFile: "docker-compose.image.yml",
        versionMode: "latest",
        targetVersion: "latest"
      }
    })).rejects.toMatchObject({
      statusCode: 409,
      activeJobId: jobId,
      message: expect.stringContaining("already queued or running")
    });
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO operation_jobs")
    )).toBe(false);
  });
});

describe("retry admission fencing", () => {
  it.each([
    {
      type: "backup.verify",
      payload: { backupId: "44444444-4444-4444-8444-444444444441" },
      table: "backups"
    },
    {
      type: "recovery.verify",
      payload: { recoveryPointId: "44444444-4444-4444-8444-444444444442" },
      table: "recovery_points"
    }
  ] as const)("does not revive $type after deletion has claimed its resource", async ({
    type,
    payload,
    table
  }) => {
    const failedJob = jobRow({
      type,
      status: "failed",
      payload,
      error: "verification failed"
    });
    query.mockResolvedValueOnce({ rows: [failedJob] });
    arrangeTransaction(async (sql) => {
      if (sql.includes("SELECT * FROM operation_jobs")) {
        return { rows: [failedJob] };
      }
      if (sql.includes(`FROM ${table}`)) {
        return { rows: [{
          metadata: {
            deletionClaimToken: "delete-claim",
            deletionClaimedAt: "2026-07-30T10:00:00.000Z"
          }
        }] };
      }
      return { rows: [] };
    });

    await expect(retryJob(jobId)).resolves.toMatchObject({
      original: { id: jobId, type },
      retried: null
    });

    const admission = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes(`FROM ${table}`)
    );
    expect(admission?.[0]).toContain("FOR UPDATE");
    expect(transactionQuery.mock.calls.some(([sql]) =>
      String(sql).includes("SET status = 'queued'")
    )).toBe(false);
  });
});

describe("fenced job leases", () => {
  it("claims and increments an attempt in one statement", async () => {
    query.mockResolvedValueOnce({ rows: [jobRow()] });

    const claimed = await claimNextJob(workerId);

    expect(claimed).toMatchObject({ id: jobId, workerId, attemptCount: 1 });
    expect(query.mock.calls[0]?.[0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(query.mock.calls[0]?.[0]).toContain("attempt_count = jobs.attempt_count + 1");
  });

  it("fences lease renewal, progress, and completion by owner and attempt", async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [jobRow({ progress: [{ id: "run", label: "Run", status: "running" }] })], rowCount: 1 });
    transactionQuery
      .mockResolvedValueOnce({ rows: [{ id: jobId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const lease = { workerId, attemptCount: 1 };

    await expect(renewJobLease(jobId, lease)).resolves.toBe(true);
    await updateJobProgress(jobId, [{ id: "run", label: "Run", status: "running" }], lease);
    await expect(completeJob(jobId, { ok: true }, lease)).resolves.toBe(true);

    for (const call of [...query.mock.calls, transactionQuery.mock.calls[0]!]) {
      expect(call[0]).toContain("lease_owner");
      expect(call[0]).toContain("attempt_count");
      expect(call[0]).toContain("lease_expires_at > clock_timestamp()");
    }
  });

  it("durably releases the lease only after recording a pending self-update handoff", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: jobId }], rowCount: 1 });

    await expect(markSelfUpdateHandoffPending(jobId, {
      handoffStarted: true,
      handoffPending: true,
      pid: "4242",
      targetVersion: "1.0.8",
      workingDir: "/srv/composebastion",
      composeFile: "docker-compose.image.yml",
      scriptPath: `/srv/composebastion/.composebastion-self-update-${jobId}.sh`,
      logPath: `/srv/composebastion/.composebastion-self-update-${jobId}.log`,
      outcomePath: `/srv/composebastion/.composebastion-self-update-${jobId}.outcome`,
      gatePath: `/srv/composebastion/.composebastion-self-update-${jobId}.gate`,
      lockPath: "/tmp/composebastion-self-update.lock",
      handedOffAt: now.toISOString()
    }, { workerId, attemptCount: 1 })).resolves.toBe(true);

    expect(query.mock.calls[0]?.[0]).toContain("result = $2::jsonb");
    expect(query.mock.calls[0]?.[0]).toContain("lease_owner = NULL");
    expect(query.mock.calls[0]?.[0]).toContain("lease_expires_at = NULL");
    expect(JSON.parse(query.mock.calls[0]?.[1]?.[1])).toMatchObject({ handoffPending: true, pid: "4242" });
  });

  it("requires the handing-off worker to stop before claiming another job", () => {
    expect(shouldStopWorkerClaimsAfterHandoff("system.self_update", true)).toBe(true);
    expect(shouldStopWorkerClaimsAfterHandoff("system.self_update", false)).toBe(false);
    expect(shouldStopWorkerClaimsAfterHandoff("host.check", true)).toBe(false);
    expect(shouldResumeWorkerClaimsAfterReconciliation({ completed: 0, failed: 0, pending: 0 })).toBe(true);
    expect(shouldResumeWorkerClaimsAfterReconciliation({ completed: 0, failed: 1, pending: 0 })).toBe(true);
    expect(shouldResumeWorkerClaimsAfterReconciliation({ completed: 1, failed: 0, pending: 1 })).toBe(false);
  });
});

describe("expired lease recovery", () => {
  it("excludes pending self-update handoffs from generic lease recovery", async () => {
    transactionQuery.mockResolvedValueOnce({ rows: [] });

    await expect(recoverExpiredJobs()).resolves.toEqual({ requeued: 0, failed: 0 });

    expect(transactionQuery.mock.calls[0]?.[0]).toContain("result @> '{\"handoffPending\":true}'::jsonb");
  });

  it("requeues only allowlisted idempotent work below the attempt limit", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [jobRow({ type: "host.sync", attempt_count: 2 })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(recoverExpiredJobs()).resolves.toEqual({ requeued: 1, failed: 0 });
    expect(transactionQuery.mock.calls[1]?.[0]).toContain("status = 'queued'");
  });

  it("fails mutating abandoned work and finalizes its linked record", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [jobRow({
        type: "volume.backup",
        payload: { backupId: "44444444-4444-4444-8444-444444444444" }
      })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(recoverExpiredJobs()).resolves.toEqual({ requeued: 0, failed: 1 });
    expect(transactionQuery.mock.calls[1]?.[0]).toContain("status = 'failed'");
    expect(transactionQuery.mock.calls[2]?.[0]).toContain("UPDATE backups SET status = 'failed'");
  });

  it("atomically finalizes deploy.execute analysis state when its worker is lost before dispatch", async () => {
    const deploymentAnalysisId = "44444444-4444-4444-8444-444444444444";
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT *") && sql.includes("lease_expires_at")) {
        return {
          rows: [jobRow({
            type: "deploy.execute",
            payload: { analysisId: deploymentAnalysisId },
            attempt_count: 1
          })]
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(recoverExpiredJobs()).resolves.toEqual({
      requeued: 0,
      failed: 1
    });

    const analysisFinalization = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE deployment_analyses")
    );
    expect(analysisFinalization?.[0]).toContain("SET status = 'failed'");
    expect(analysisFinalization?.[0]).toContain(
      "status IN ('queued', 'analyzing', 'ready', 'deploying')"
    );
    expect(analysisFinalization?.[1]).toEqual([
      deploymentAnalysisId,
      expect.stringContaining("WORKER_LOST")
    ]);
  });

  it("preserves durable migration reconciliation evidence when worker loss finalizes the run", async () => {
    const migrationRunId = "44444444-4444-4444-8444-444444444445";
    const recoveryPointId = "44444444-4444-4444-8444-444444444446";
    transactionQuery
      .mockResolvedValueOnce({
        rows: [jobRow({
          type: "migration.execute",
          payload: { migrationRunId }
        })]
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ recovery_point_id: recoveryPointId }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(recoverExpiredJobs()).resolves.toEqual({ requeued: 0, failed: 1 });

    const migrationUpdate = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE migration_runs")
    );
    expect(migrationUpdate?.[0]).toContain(
      "Automatic migration compensation remains armed. Reconciliation evidence:"
    );
    expect(migrationUpdate?.[0]).toContain("THEN error || E'\\n' || $2");
    expect(migrationUpdate?.[1]).toEqual([
      migrationRunId,
      expect.stringContaining("WORKER_LOST")
    ]);
  });

  it.each([
    ["deploy.analyze", { analysisId: "44444444-4444-4444-8444-444444444444" }],
    ["deploy.execute", { analysisId: "44444444-4444-4444-8444-444444444444" }],
    ["host.configureRegistryTrust", { registry: "registry.internal:5000" }]
  ])("never automatically replays abandoned non-idempotent %s work", async (type, payload) => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT *") && sql.includes("lease_expires_at")) {
        return { rows: [jobRow({ type, payload, attempt_count: 1 })] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(recoverExpiredJobs()).resolves.toEqual({ requeued: 0, failed: 1 });
    expect(transactionQuery.mock.calls.some((call) => String(call[0]).includes("SET status = 'queued'"))).toBe(false);
    expect(transactionQuery.mock.calls.some((call) => String(call[0]).includes("SET status = 'failed'"))).toBe(true);
  });

  it("stops retrying an allowlisted job after its third abandoned attempt", async () => {
    transactionQuery
      .mockResolvedValueOnce({ rows: [jobRow({ type: "recovery.verify", attempt_count: 3 })] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(recoverExpiredJobs()).resolves.toEqual({ requeued: 0, failed: 1 });
    expect(transactionQuery.mock.calls[1]?.[1]?.[1]).toContain("WORKER_LOST");
  });
});

describe("worker availability", () => {
  it("reports a fresh active heartbeat independently of queue history", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ completed_at: null }] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] })
      .mockResolvedValueOnce({ rows: [{ active_count: "1", recent_draining_count: "0", last_heartbeat_at: new Date() }] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] });

    await expect(getWorkerStatus()).resolves.toMatchObject({
      available: true,
      activeWorkers: 1,
      state: "active"
    });
  });

  it("reports a fresh multi-worker pool as non-accepting while a self-update handoff is pending", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ completed_at: null }] })
      .mockResolvedValueOnce({ rows: [{ count: "4" }] })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
      .mockResolvedValueOnce({
        rows: [{
          active_count: "2",
          recent_draining_count: "0",
          last_heartbeat_at: new Date(),
          heartbeat_fresh: true
        }]
      })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] });

    await expect(getWorkerStatus()).resolves.toMatchObject({
      available: false,
      activeWorkers: 2,
      queued: 4,
      running: 1,
      state: "draining"
    });
    expect(query.mock.calls[4]?.[0]).toContain("handoffPending");
  });

  it("reports a stale worker when no recent active heartbeat exists", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: "2" }] })
      .mockResolvedValueOnce({ rows: [{ count: "1" }] })
      .mockResolvedValueOnce({ rows: [{
        active_count: "0",
        recent_draining_count: "0",
        last_heartbeat_at: new Date(Date.now() - 60_000)
      }] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }] });

    await expect(getWorkerStatus()).resolves.toMatchObject({
      available: false,
      queued: 2,
      running: 1,
      state: "stale"
    });
  });
});
