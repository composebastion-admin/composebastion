import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());

vi.mock("../src/db/pool.js", () => ({
  query,
  withTransaction: vi.fn()
}));

vi.mock("../src/services/redis.js", () => ({
  createRedis: () => null
}));

const { buildJobProgress, cancelQueuedJob, markJobProgressStep, retryJob, updateJobProgress } = await import("../src/services/jobs.js");

const now = new Date("2026-06-16T12:00:00.000Z");
const hostId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

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

  it("retries failed jobs by cloning the typed action into a new queued job", async () => {
    query
      .mockResolvedValueOnce({ rows: [jobRow({ status: "failed" })] })
      .mockResolvedValueOnce({ rows: [jobRow({
        id: "44444444-4444-4444-8444-444444444444",
        status: "queued",
        payload: { containerId: "demo-container" },
        error: null,
        created_by: userId,
        started_at: null,
        completed_at: null
      })] });

    const result = await retryJob("33333333-3333-4333-8333-333333333333", userId);

    expect(result.original?.status).toBe("failed");
    expect(result.retried?.id).toBe("44444444-4444-4444-8444-444444444444");
    expect(query.mock.calls[1]?.[0]).toContain("INSERT INTO operation_jobs");
    expect(query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      "container.restart",
      hostId,
      { containerId: "demo-container" },
      userId
    ]));
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

    const result = await updateJobProgress("33333333-3333-4333-8333-333333333333", [{ id: "run", label: "Run", status: "running" }]);

    expect(result?.progress).toEqual([{ id: "run", label: "Run", status: "running" }]);
    expect(query.mock.calls[0]?.[0]).toContain("SET progress = $2");
  });

  it("marks a named progress step active", async () => {
    query.mockResolvedValueOnce({ rows: [jobRow({ progress: buildJobProgress("host.sync", "running", "inventory") })] });

    const result = await markJobProgressStep("33333333-3333-4333-8333-333333333333", "host.sync", "inventory");

    expect(result?.progress).toMatchObject([
      { id: "connect", status: "completed" },
      { id: "inventory", status: "running" },
      { id: "store", status: "pending" }
    ]);
  });
});
