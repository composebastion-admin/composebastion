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

const {
  claimNextJob,
  completeJob,
  enqueueJob,
  enqueueJobInTransaction,
  getWorkerStatus,
  recoverExpiredJobs,
  renewJobLease,
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

beforeEach(() => {
  query.mockReset();
  transactionQuery.mockReset();
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
    query.mockResolvedValueOnce({ rows: [jobRow({ status: "queued", started_at: null, lease_owner: null, lease_expires_at: null, attempt_count: 0 })] });

    await enqueueJob({ type: "host.check", hostId, payload: {} }, null, "host-check-once");

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (idempotency_key)");
    expect(query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["host-check-once"]));
  });

  it("supports inserting a domain record and job in one caller-owned transaction", async () => {
    transactionQuery.mockResolvedValueOnce({ rows: [jobRow({ status: "queued" })] });

    const job = await enqueueJobInTransaction(
      { query: transactionQuery } as any,
      { type: "host.check", hostId, payload: {} },
      null,
      "transactional-job"
    );

    expect(job.id).toBe(jobId);
    expect(transactionQuery.mock.calls[0]?.[0]).toContain("ON CONFLICT (idempotency_key)");
    expect(redisPublish).not.toHaveBeenCalled();
  });

  it("does not fail an already committed enqueue when Redis wake-up fails", async () => {
    redisEnabled = true;
    query.mockResolvedValueOnce({ rows: [jobRow({ status: "queued" })] });
    redisConnect.mockResolvedValue(undefined);
    redisPublish.mockRejectedValue(new Error("redis unavailable"));

    await expect(enqueueJob({ type: "host.check", hostId, payload: {} })).resolves.toMatchObject({ id: jobId });
    expect(redisDisconnect).toHaveBeenCalledOnce();
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
      .mockResolvedValueOnce({ rows: [jobRow({ progress: [{ id: "run", label: "Run", status: "running" }] })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: jobId }], rowCount: 1 });
    const lease = { workerId, attemptCount: 1 };

    await expect(renewJobLease(jobId, lease)).resolves.toBe(true);
    await updateJobProgress(jobId, [{ id: "run", label: "Run", status: "running" }], lease);
    await expect(completeJob(jobId, { ok: true }, lease)).resolves.toBe(true);

    for (const call of query.mock.calls) {
      expect(call[0]).toContain("lease_owner");
      expect(call[0]).toContain("attempt_count");
      expect(call[0]).toContain("lease_expires_at > clock_timestamp()");
    }
  });
});

describe("expired lease recovery", () => {
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
      .mockResolvedValueOnce({ rows: [{ active_count: "1", recent_draining_count: "0", last_heartbeat_at: new Date() }] });

    await expect(getWorkerStatus()).resolves.toMatchObject({
      available: true,
      activeWorkers: 1,
      state: "active"
    });
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
      }] });

    await expect(getWorkerStatus()).resolves.toMatchObject({
      available: false,
      queued: 2,
      running: 1,
      state: "stale"
    });
  });
});
