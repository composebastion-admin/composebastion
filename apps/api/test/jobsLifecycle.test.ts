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

const now = new Date("2026-06-16T12:00:00.000Z");
const hostId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
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
  });

  it("returns the current job when cancel cannot update it", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [jobRow({ status: "running" })] });

    const result = await cancelQueuedJob("33333333-3333-4333-8333-333333333333");

    expect(result).toMatchObject({ canceled: false, job: { status: "running" } });
  });

  it("atomically requeues an allowlisted failed job without cloning it", async () => {
    query
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
    expect(query.mock.calls[0]?.[0]).toContain("FOR UPDATE");
    expect(query.mock.calls[1]?.[0]).toContain("UPDATE operation_jobs");
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
