import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const startContainersOneByOne = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args: unknown[]) => query(...args),
  withTransaction: async (
    callback: (client: { query: (...args: unknown[]) => unknown }) => Promise<unknown>
  ) => callback({ query: (...args: unknown[]) => query(...args) })
}));

vi.mock("../src/services/recoveryContainerControl.js", () => ({
  startContainersOneByOne: (...args: unknown[]) => startContainersOneByOne(...args)
}));

vi.mock("../src/services/operationLogs.js", () => ({
  safeErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error)
}));

const pointId = "00000000-0000-4000-8000-000000000071";
const hostId = "00000000-0000-4000-8000-000000000072";

describe("recovery source restart reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM recovery_points point")) {
        return {
          rows: [{
            id: pointId,
            host_id: hostId,
            metadata: {
              sourceRestartPending: true,
              sourceRestartContainerIds: ["web", "worker", "web"]
            }
          }]
        };
      }
      return { rows: [] };
    });
    startContainersOneByOne.mockResolvedValue(undefined);
  });

  it("claims an abandoned obligation, restarts every originally-running container, and resolves it", async () => {
    const { reconcileRecoverySourceRestartObligations } = await import(
      "../src/services/recoveryRestartReconciliation.js"
    );

    await expect(reconcileRecoverySourceRestartObligations()).resolves.toEqual({
      checked: 1,
      restarted: 1,
      failed: 0
    });

    expect(startContainersOneByOne).toHaveBeenCalledWith(hostId, ["web", "worker"]);
    const selection = query.mock.calls.find(([sql]) => String(sql).includes("FROM recovery_points point"));
    expect(String(selection?.[0])).toContain("NOT EXISTS");
    expect(String(selection?.[0])).toContain("job.status IN ('queued', 'running')");
    expect(String(selection?.[0])).toContain(
      "IS DISTINCT FROM 'blocked_target_cleanup'"
    );
    expect(String(selection?.[0])).toContain(
      "sourceRestartTargetCleanupBlocked', 'false') <> 'true'"
    );

    const claim = query.mock.calls.find(([sql, values]) =>
      String(sql).includes("SET metadata = metadata || $2::jsonb")
      && Array.isArray(values)
      && typeof values[1] === "string"
      && JSON.parse(values[1]).sourceRestartReconciliationState === "running"
    );
    expect(claim).toBeDefined();

    const completion = query.mock.calls.find(([sql, values]) =>
      String(sql).includes("sourceRestartReconciliationToken' = $2")
      && Array.isArray(values)
      && JSON.parse(String(values[2])).sourceRestartResolution === "worker_loss_restarted"
    );
    expect(JSON.parse(String(completion?.[1]?.[2]))).toMatchObject({
      sourceRestartPending: false,
      sourceLeftStopped: false,
      sourceStoppedIds: [],
      sourceRestartReconciliationState: "completed"
    });
  });

  it("retains only unresolved container ids when a restart attempt fails", async () => {
    startContainersOneByOne.mockRejectedValueOnce(Object.assign(
      new Error("worker did not restart"),
      { restartFailedIds: ["worker"] }
    ));
    const { reconcileRecoverySourceRestartObligations } = await import(
      "../src/services/recoveryRestartReconciliation.js"
    );

    await expect(reconcileRecoverySourceRestartObligations()).resolves.toEqual({
      checked: 1,
      restarted: 0,
      failed: 1
    });

    const failure = query.mock.calls.find(([sql, values]) =>
      String(sql).includes("sourceRestartReconciliationToken' = $2")
      && Array.isArray(values)
      && JSON.parse(String(values[2])).sourceRestartReconciliationState === "failed"
    );
    expect(JSON.parse(String(failure?.[1]?.[2]))).toMatchObject({
      sourceRestartPending: true,
      sourceRestartContainerIds: ["worker"],
      sourceLeftStopped: true,
      sourceStoppedIds: ["worker"],
      restartFailedIds: ["worker"],
      sourceRestartReconciliationError: "worker did not restart"
    });
  });

  it("does not claim a restart obligation blocked by incomplete target cleanup", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM recovery_points point")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const { reconcileRecoverySourceRestartObligations } = await import(
      "../src/services/recoveryRestartReconciliation.js"
    );

    await expect(reconcileRecoverySourceRestartObligations()).resolves.toEqual({
      checked: 0,
      restarted: 0,
      failed: 0
    });

    expect(startContainersOneByOne).not.toHaveBeenCalled();
    const selection = query.mock.calls.find(([sql]) => String(sql).includes("FROM recovery_points point"));
    expect(String(selection?.[0])).toContain(
      "sourceRestartReconciliationState'\n           IS DISTINCT FROM 'blocked_target_cleanup'"
    );
    expect(String(selection?.[0])).toContain(
      "sourceRestartTargetCleanupBlocked', 'false') <> 'true'"
    );
  });
});
